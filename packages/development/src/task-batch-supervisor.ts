import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { DevelopmentBrokerError } from './broker.js';
import type {
  AnalysisJobRequest,
  AnalysisJobSupervisor,
  AnalysisOperationKind,
} from './analysis-job-supervisor.js';

export const TASK_BATCH_LIMITS = Object.freeze({
  maxChildrenPerBatch: 24,
  maxNonTerminalBatches: 32,
  maxNonTerminalChildren: 256,
  maxStatusChildren: 20,
  maxConcurrentWaiters: 32,
  maxWaitMs: 20_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxRetainedBatches: 512,
  maxValidationResultBytes: 2 * 1024 * 1024,
  maxTotalValidationResultBytes: 16 * 1024 * 1024,
} as const);
type TaskBatchLimits = { readonly [Key in keyof typeof TASK_BATCH_LIMITS]: number };

export type TaskOperationKind = AnalysisOperationKind | 'validation.run';
export type TaskFailurePolicy = 'continue' | 'cancel_remaining';
export type TaskChildState =
  | 'admitted'
  | 'waiting_dependency'
  | 'waiting_resource'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'skipped_dependency'
  | 'interrupted';
export type TaskBatchState =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'interrupted';

export interface TaskChildRequest {
  readonly localId: string;
  readonly operationKind: TaskOperationKind;
  readonly sourcePath?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly dependsOn?: readonly string[];
}

export interface TaskBatchRequest {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly children: readonly TaskChildRequest[];
  readonly failurePolicy: TaskFailurePolicy;
}

export interface TaskTiming {
  /** Tiempo hasta que el recibo durable quedó admitido. */
  readonly admissionMs: number;
  /** Espera por dependencias declaradas. */
  readonly dependencyWaitMs: number;
  /** Espera observada en la cola del supervisor delegado. */
  readonly capacityWaitMs: number;
  /** Espera del lock interior del adaptador; cero cuando no expone esa señal. */
  readonly lockWaitMs: number;
  /** Tiempo de ocupación del lock interior; cero cuando no expone esa señal. */
  readonly lockHoldMs: number;
  /** Tiempo desde inicio real hasta estado terminal. */
  readonly executionMs: number;
  /** Tiempo acumulado dedicado a guardar metadata durable. */
  readonly persistenceMs: number;
  /** El tiempo entre llamadas del cliente se mide en task.waitMany, no aquí. */
  readonly clientWaitMs: 0;
}

export interface TaskResourceReceipt {
  readonly resourceId: string;
  readonly kind: 'workspace-source' | 'workspace-destination' | 'validation-profile';
  readonly ownership: 'reused' | 'created';
}

export interface TaskChildSnapshot {
  readonly localId: string;
  readonly operationKind: TaskOperationKind;
  readonly sourcePath?: string;
  readonly dependsOn: readonly string[];
  readonly state: TaskChildState;
  readonly stage: string;
  readonly effectState: 'not_started' | 'applied' | 'not_applied' | 'uncertain';
  readonly coverage: 'unknown' | 'supported' | 'partial' | 'unsupported' | 'source_changed';
  readonly resource: TaskResourceReceipt;
  readonly timing: TaskTiming;
  readonly analysisJobId?: string;
  readonly errorCode?: string;
  readonly resultAvailable: boolean;
  readonly resultExpired: boolean;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface TaskBatchSnapshot {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly state: TaskBatchState;
  readonly revision: number;
  readonly failurePolicy: TaskFailurePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retentionUntil: string;
  /** Tiempo interno para ensamblar esta vista; no incluye latencia entre llamadas del cliente. */
  readonly deliveryMs: number;
  readonly counts: Readonly<Record<TaskChildState, number>>;
  readonly children: readonly TaskChildSnapshot[];
}

export interface TaskValidationResult {
  readonly profile: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: false;
  readonly reviewFingerprint?: string;
}

export interface TaskValidationContext {
  readonly signal: AbortSignal;
  lockAcquired(): void;
  lockReleased(): void;
  /** El adaptador informa cuándo deja la cola/lock y empieza el proceso. */
  started(): void;
}

export interface TaskBatchSupervisorOptions {
  readonly journalPath: string;
  readonly analysis: AnalysisJobSupervisor;
  readonly runValidation: (
    workspaceId: string,
    profile: string,
    context: TaskValidationContext,
  ) => Promise<TaskValidationResult>;
  readonly revalidateRead: (workspaceId: string) => Promise<void>;
  /** Verifica autoridad, rutas y referencias opacas de todos los hijos antes de admitir el lote. */
  readonly preflightBatch?: (request: TaskBatchRequest) => Promise<void>;
  readonly now?: () => Date;
  readonly onChange?: () => void;
  readonly limits?: Partial<TaskBatchLimits>;
}

interface MutableTiming {
  admissionMs: number;
  dependencyWaitMs: number;
  capacityWaitMs: number;
  lockWaitMs: number;
  lockHoldMs: number;
  executionMs: number;
  persistenceMs: number;
  clientWaitMs: 0;
}

interface MutableChild {
  localId: string;
  operationKind: TaskOperationKind;
  sourcePath?: string;
  dependsOn: string[];
  parameterFingerprint: string;
  state: TaskChildState;
  stage: string;
  effectState: TaskChildSnapshot['effectState'];
  coverage: TaskChildSnapshot['coverage'];
  resource: TaskResourceReceipt;
  timing: MutableTiming;
  admittedAtMs: number;
  dependencyReadyAtMs?: number;
  startedAtMs?: number;
  lockAcquiredAtMs?: number;
  analysisJobId?: string;
  errorCode?: string;
  resultAvailable: boolean;
  resultExpired: boolean;
  summary: Readonly<Record<string, unknown>>;
}

interface MutableBatch {
  schemaVersion: 1;
  batchId: string;
  workspaceId: string;
  operationId: string;
  fingerprint: string;
  state: TaskBatchState;
  revision: number;
  failurePolicy: TaskFailurePolicy;
  createdAt: string;
  updatedAt: string;
  retentionUntil: string;
  cancelIntents: Record<string, string>;
  children: MutableChild[];
}

interface ActiveSpec {
  readonly request: TaskBatchRequest;
  readonly byLocalId: ReadonlyMap<string, TaskChildRequest>;
}

interface ValidationResultEntry {
  readonly result: TaskValidationResult;
  readonly bytes: number;
}

interface Waiter {
  readonly batchId: string;
  readonly afterRevision: number;
  readonly condition: 'changed' | 'all_finished';
  readonly resolve: () => void;
}

const BATCH_TERMINAL = new Set<TaskBatchState>(['cancelled', 'completed', 'partial', 'failed', 'interrupted']);
const CHILD_TERMINAL = new Set<TaskChildState>(['cancelled', 'completed', 'failed', 'skipped_dependency', 'interrupted']);
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,128}$/;
const JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_batches (
  batch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  record_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  UNIQUE(workspace_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_task_batches_workspace_updated ON task_batches(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_batches_state ON task_batches(state);
`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').normalize('NFC').toLocaleLowerCase('en-US');
}

function resourceFor(workspaceId: string, child: TaskChildRequest): TaskResourceReceipt {
  const kind = child.operationKind === 'validation.run'
    ? 'validation-profile'
    : child.operationKind === 'web.download.start'
      ? 'workspace-destination'
      : 'workspace-source';
  const logical = child.operationKind === 'validation.run'
    ? String(child.parameters['profile'] ?? '')
    : normalizedRelativePath(child.sourcePath ?? '');
  return {
    resourceId: `taskresource_${digest({ workspaceId, kind, logical }).slice(0, 24)}`,
    kind,
    ownership: child.operationKind === 'web.download.start' ? 'created' : 'reused',
  };
}

function emptyCounts(): Record<TaskChildState, number> {
  return {
    admitted: 0,
    waiting_dependency: 0,
    waiting_resource: 0,
    running: 0,
    cancel_requested: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    skipped_dependency: 0,
    interrupted: 0,
  };
}

function snapshot(batch: MutableBatch): TaskBatchSnapshot {
  const deliveryStarted = performance.now();
  const counts = emptyCounts();
  for (const child of batch.children) counts[child.state] += 1;
  const value: Omit<TaskBatchSnapshot, 'deliveryMs'> = {
    schemaVersion: 1,
    batchId: batch.batchId,
    workspaceId: batch.workspaceId,
    operationId: batch.operationId,
    fingerprint: batch.fingerprint,
    state: batch.state,
    revision: batch.revision,
    failurePolicy: batch.failurePolicy,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    retentionUntil: batch.retentionUntil,
    counts,
    children: batch.children.map((child) => ({
      localId: child.localId,
      operationKind: child.operationKind,
      ...(child.sourcePath === undefined ? {} : { sourcePath: child.sourcePath }),
      dependsOn: [...child.dependsOn],
      state: child.state,
      stage: child.stage,
      effectState: child.effectState,
      coverage: child.coverage,
      resource: child.resource,
      timing: { ...child.timing },
      ...(child.analysisJobId === undefined ? {} : { analysisJobId: child.analysisJobId }),
      ...(child.errorCode === undefined ? {} : { errorCode: child.errorCode }),
      resultAvailable: child.resultAvailable,
      resultExpired: child.resultExpired,
      summary: child.summary,
    })),
  };
  return { ...value, deliveryMs: Math.max(0, performance.now() - deliveryStarted) };
}

function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'TASK_FAILED';
}

function openJournal(journalPath: string): DatabaseSync {
  mkdirSync(path.dirname(journalPath), { recursive: true });
  const database = new DatabaseSync(journalPath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  database.exec(JOURNAL_SCHEMA);
  return database;
}

function validateRequest(request: TaskBatchRequest, maxChildren: number): void {
  if (!WORKSPACE_ID.test(request.workspaceId) || !OPERATION_ID.test(request.operationId) ||
      (request.failurePolicy !== 'continue' && request.failurePolicy !== 'cancel_remaining') ||
      request.children.length < 1 || request.children.length > maxChildren) {
    throw new DevelopmentBrokerError('INVALID_INPUT', 'El lote no cumple el contrato cerrado.');
  }
  const ids = new Set<string>();
  const destinations = new Set<string>();
  for (const child of request.children) {
    if (!LOCAL_ID.test(child.localId) || ids.has(child.localId) || child.parameters === null ||
        typeof child.parameters !== 'object' || Array.isArray(child.parameters)) {
      throw new DevelopmentBrokerError('INVALID_INPUT', 'Los IDs y parámetros de los hijos no son válidos.');
    }
    ids.add(child.localId);
    if (child.operationKind === 'validation.run') {
      if (child.sourcePath !== undefined || typeof child.parameters['profile'] !== 'string') {
        throw new DevelopmentBrokerError('INVALID_INPUT', 'El perfil de validación no es válido.');
      }
    } else if (typeof child.sourcePath !== 'string' || child.sourcePath.length < 1) {
      throw new DevelopmentBrokerError('INVALID_INPUT', 'La operación de análisis requiere una ruta relativa.');
    }
    if (child.operationKind === 'web.download.start') {
      const destination = normalizedRelativePath(child.sourcePath!);
      if (destinations.has(destination)) {
        throw new DevelopmentBrokerError('INVALID_INPUT', 'Dos hijos no pueden reservar el mismo destino.');
      }
      destinations.add(destination);
    }
  }
  for (const child of request.children) {
    const dependencies = child.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length || dependencies.includes(child.localId) ||
        dependencies.some((dependency) => !ids.has(dependency))) {
      throw new DevelopmentBrokerError('INVALID_INPUT', 'Las dependencias del lote no son válidas.');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(request.children.map((child) => [child.localId, child]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new DevelopmentBrokerError('INVALID_INPUT', 'El lote contiene un ciclo.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function batchState(children: readonly MutableChild[]): TaskBatchState {
  if (children.every((child) => child.state === 'completed')) return 'completed';
  if (children.every((child) => child.state === 'cancelled')) return 'cancelled';
  if (children.every((child) => CHILD_TERMINAL.has(child.state))) {
    const completed = children.some((child) => child.state === 'completed');
    const interrupted = children.some((child) => child.state === 'interrupted');
    if (interrupted && !completed) return 'interrupted';
    if (completed) return 'partial';
    return 'failed';
  }
  if (children.some((child) => child.state === 'cancel_requested')) return 'cancel_requested';
  if (children.some((child) => child.state === 'running' || child.state === 'waiting_resource')) return 'running';
  return 'queued';
}

export class TaskBatchSupervisor {
  private readonly batches = new Map<string, MutableBatch>();
  private readonly activeSpecs = new Map<string, ActiveSpec>();
  private readonly validationControllers = new Map<string, AbortController>();
  private readonly admissions = new Map<string, {
    readonly fingerprint: string;
    readonly promise: Promise<TaskBatchSnapshot>;
  }>();
  private readonly validationResults = new Map<string, ValidationResultEntry>();
  private validationResultBytes = 0;
  private readonly waiters = new Set<Waiter>();
  private readonly limits: TaskBatchLimits;
  private readonly now: () => Date;
  private scheduled = false;
  private closed = false;
  private readonly unsubscribeAnalysis: () => void;

  constructor(private readonly options: TaskBatchSupervisorOptions) {
    this.limits = Object.freeze({ ...TASK_BATCH_LIMITS, ...options.limits });
    this.now = options.now ?? (() => new Date());
    this.reconcileJournal();
    this.unsubscribeAnalysis = options.analysis.subscribe(() => this.schedule());
  }

  private reconcileJournal(): void {
    const database = openJournal(this.options.journalPath);
    try {
      const now = this.now().toISOString();
      database.prepare('DELETE FROM task_batches WHERE retention_until <= ?').run(now);
      const rows = database.prepare('SELECT record_json FROM task_batches ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const batch = JSON.parse(String(row['record_json'])) as MutableBatch;
        batch.cancelIntents ??= {};
        let changed = false;
        for (const child of batch.children) {
          if (child.timing.lockWaitMs === undefined) {
            child.timing.lockWaitMs = 0;
            changed = true;
          }
          if (child.timing.lockHoldMs === undefined) {
            child.timing.lockHoldMs = 0;
            changed = true;
          }
          if (!CHILD_TERMINAL.has(child.state)) {
            child.state = 'interrupted';
            child.stage = 'interrupted_after_restart';
            child.errorCode = 'TASK_INTERRUPTED';
            child.resultAvailable = false;
            child.resultExpired = true;
            if (child.effectState === 'not_started') child.effectState = 'not_applied';
            changed = true;
          } else if (child.operationKind === 'validation.run' && child.resultAvailable) {
            child.resultAvailable = false;
            child.resultExpired = true;
            changed = true;
          }
        }
        if (changed) {
          batch.state = batchState(batch.children);
          batch.revision += 1;
          batch.updatedAt = now;
          this.persist(database, batch);
        }
        this.batches.set(batch.batchId, batch);
      }
      this.pruneRetained(database);
    } finally {
      database.close();
    }
  }

  private pruneRetained(existingDatabase?: DatabaseSync): void {
    const overflow = this.batches.size - this.limits.maxRetainedBatches;
    if (overflow <= 0) return;
    const removable = [...this.batches.values()]
      .filter((batch) => BATCH_TERMINAL.has(batch.state))
      .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, overflow);
    if (removable.length === 0) return;
    const database = existingDatabase ?? openJournal(this.options.journalPath);
    try {
      const remove = database.prepare('DELETE FROM task_batches WHERE batch_id = ?');
      for (const batch of removable) {
        remove.run(batch.batchId);
        this.batches.delete(batch.batchId);
        this.activeSpecs.delete(batch.batchId);
        for (const child of batch.children) {
          const key = `${batch.batchId}:${child.localId}`;
          const result = this.validationResults.get(key);
          if (result === undefined) continue;
          this.validationResults.delete(key);
          this.validationResultBytes = Math.max(0, this.validationResultBytes - result.bytes);
        }
      }
    } finally {
      if (existingDatabase === undefined) database.close();
    }
  }

  private persist(database: DatabaseSync, batch: MutableBatch): void {
    database.prepare(`INSERT INTO task_batches
      (batch_id, workspace_id, operation_id, fingerprint, record_json, state, created_at, updated_at, retention_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET record_json=excluded.record_json, state=excluded.state,
        updated_at=excluded.updated_at, retention_until=excluded.retention_until`).run(
      batch.batchId,
      batch.workspaceId,
      batch.operationId,
      batch.fingerprint,
      JSON.stringify(batch),
      batch.state,
      batch.createdAt,
      batch.updatedAt,
      batch.retentionUntil,
    );
  }

  private save(batch: MutableBatch, notify = true): void {
    const started = performance.now();
    const database = openJournal(this.options.journalPath);
    try {
      this.persist(database, batch);
    } finally {
      database.close();
    }
    const elapsed = Math.max(0, performance.now() - started);
    for (const child of batch.children) child.timing.persistenceMs += elapsed / batch.children.length;
    if (!notify) return;
    this.options.onChange?.();
    for (const waiter of this.waiters) {
      if (waiter.batchId !== batch.batchId || batch.revision <= waiter.afterRevision) continue;
      if (waiter.condition === 'all_finished' && !BATCH_TERMINAL.has(batch.state)) continue;
      waiter.resolve();
    }
  }

  async runMany(request: TaskBatchRequest): Promise<TaskBatchSnapshot> {
    if (this.closed) throw new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'El coordinador de lotes se está cerrando.');
    validateRequest(request, this.limits.maxChildrenPerBatch);
    const requestFingerprint = digest(request);
    const existing = [...this.batches.values()].find((batch) =>
      batch.workspaceId === request.workspaceId && batch.operationId === request.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new DevelopmentBrokerError('IDEMPOTENCY_CONFLICT', 'El operationId del lote ya se usó con otra intención.');
      }
      return snapshot(existing);
    }
    const admissionKey = `${request.workspaceId}:${request.operationId}`;
    const pending = this.admissions.get(admissionKey);
    if (pending !== undefined) {
      if (pending.fingerprint !== requestFingerprint) {
        throw new DevelopmentBrokerError('IDEMPOTENCY_CONFLICT', 'El operationId del lote ya se está admitiendo con otra intención.');
      }
      return pending.promise;
    }
    const admission = this.admit(request, requestFingerprint);
    this.admissions.set(admissionKey, { fingerprint: requestFingerprint, promise: admission });
    try {
      return await admission;
    } finally {
      const current = this.admissions.get(admissionKey);
      if (current?.promise === admission) this.admissions.delete(admissionKey);
    }
  }

  private async admit(request: TaskBatchRequest, requestFingerprint: string): Promise<TaskBatchSnapshot> {
    await this.options.preflightBatch?.(request);
    if (this.closed) throw new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'El coordinador de lotes se está cerrando.');
    const existing = [...this.batches.values()].find((batch) =>
      batch.workspaceId === request.workspaceId && batch.operationId === request.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new DevelopmentBrokerError('IDEMPOTENCY_CONFLICT', 'El operationId del lote ya se usó con otra intención.');
      }
      return snapshot(existing);
    }
    const activeBatches = [...this.batches.values()].filter((batch) => !BATCH_TERMINAL.has(batch.state)).length;
    const activeChildren = [...this.batches.values()].flatMap((batch) => batch.children)
      .filter((child) => !CHILD_TERMINAL.has(child.state)).length;
    if (activeBatches >= this.limits.maxNonTerminalBatches ||
        activeChildren + request.children.length > this.limits.maxNonTerminalChildren) {
      throw new DevelopmentBrokerError('ANALYSIS_QUEUE_FULL', 'No hay presupuesto para admitir el lote; no se inició ningún efecto.');
    }
    const admittedAt = performance.now();
    const now = this.now();
    const batch: MutableBatch = {
      schemaVersion: 1,
      batchId: `batch_${randomBytes(12).toString('hex')}`,
      workspaceId: request.workspaceId,
      operationId: request.operationId,
      fingerprint: requestFingerprint,
      state: 'queued',
      revision: 1,
      failurePolicy: request.failurePolicy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      retentionUntil: new Date(now.getTime() + this.limits.retentionMs).toISOString(),
      cancelIntents: {},
      children: request.children.map((child) => ({
        localId: child.localId,
        operationKind: child.operationKind,
        ...(child.sourcePath === undefined ? {} : { sourcePath: child.sourcePath }),
        dependsOn: [...(child.dependsOn ?? [])],
        parameterFingerprint: digest(child.parameters),
        state: child.dependsOn?.length ? 'waiting_dependency' : 'admitted',
        stage: child.dependsOn?.length ? 'waiting_for_dependencies' : 'admitted',
        effectState: 'not_started',
        coverage: 'unknown',
        resource: resourceFor(request.workspaceId, child),
        timing: {
          admissionMs: 0,
          dependencyWaitMs: 0,
          capacityWaitMs: 0,
          lockWaitMs: 0,
          lockHoldMs: 0,
          executionMs: 0,
          persistenceMs: 0,
          clientWaitMs: 0,
        },
        admittedAtMs: performance.now(),
        resultAvailable: false,
        resultExpired: false,
        summary: {},
      })),
    };
    // El recibo padre/hijos se hace durable antes de exponerlo o despachar.
    this.save(batch, false);
    const admissionMs = Math.max(0, performance.now() - admittedAt);
    for (const child of batch.children) child.timing.admissionMs = admissionMs;
    this.batches.set(batch.batchId, batch);
    this.activeSpecs.set(batch.batchId, {
      request,
      byLocalId: new Map(request.children.map((child) => [child.localId, child])),
    });
    this.pruneRetained();
    this.options.onChange?.();
    this.schedule();
    return snapshot(batch);
  }

  list(workspaceId: string, cursor: number, limit: number): { readonly batches: readonly TaskBatchSnapshot[]; readonly nextCursor?: number } {
    const visible = [...this.batches.values()]
      .filter((batch) => batch.workspaceId === workspaceId)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
    const selected = visible.slice(cursor, cursor + limit).map(snapshot);
    const next = cursor + selected.length;
    return { batches: selected, ...(next < visible.length ? { nextCursor: next } : {}) };
  }

  listAll(limit = 50): readonly TaskBatchSnapshot[] {
    return [...this.batches.values()]
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(snapshot);
  }

  statusMany(workspaceId: string, batchId: string, localIds: readonly string[] | undefined, cursor: number, limit: number): {
    readonly batch: TaskBatchSnapshot;
    readonly children: ReadonlyArray<TaskChildSnapshot & { readonly result?: TaskValidationResult }>;
    readonly nextCursor?: number;
  } {
    const batch = this.requireBatch(workspaceId, batchId);
    if (localIds !== undefined && localIds.some((localId) => !batch.children.some((child) => child.localId === localId))) {
      throw new DevelopmentBrokerError('INVALID_INPUT', 'El filtro contiene un hijo ajeno al lote.');
    }
    const wanted = localIds === undefined ? batch.children : batch.children.filter((child) => localIds.includes(child.localId));
    const selected = wanted.slice(cursor, cursor + Math.min(limit, this.limits.maxStatusChildren));
    const children = selected.map((child) => {
      const result = this.validationResults.get(`${batchId}:${child.localId}`)?.result;
      const childView = snapshot({ ...batch, children: [child] }).children[0]!;
      return { ...childView, ...(result === undefined ? {} : { result }) };
    });
    const next = cursor + children.length;
    return {
      batch: snapshot(batch),
      children,
      ...(next < wanted.length ? { nextCursor: next } : {}),
    };
  }

  async waitMany(
    workspaceId: string,
    batchId: string,
    afterRevision: number,
    condition: 'changed' | 'all_finished',
    waitMs: number,
  ): Promise<{ readonly batch: TaskBatchSnapshot; readonly deadlineReached: boolean; readonly clientWaitMs: number }> {
    const before = this.requireBatch(workspaceId, batchId);
    const already = before.revision > afterRevision && (condition === 'changed' || BATCH_TERMINAL.has(before.state));
    const started = performance.now();
    if (!already && waitMs > 0) {
      if (this.waiters.size >= this.limits.maxConcurrentWaiters) {
        throw new DevelopmentBrokerError('RATE_LIMITED', 'Hay demasiadas esperas de lotes activas.');
      }
      await new Promise<void>((resolve) => {
        const timer: { value?: ReturnType<typeof setTimeout> } = {};
        const waiter: Waiter = {
          batchId,
          afterRevision,
          condition,
          resolve: () => {
            if (timer.value !== undefined) clearTimeout(timer.value);
            this.waiters.delete(waiter);
            resolve();
          },
        };
        this.waiters.add(waiter);
        timer.value = setTimeout(waiter.resolve, Math.min(waitMs, this.limits.maxWaitMs));
      });
    }
    const batch = this.requireBatch(workspaceId, batchId);
    const clientWaitMs = Math.max(0, performance.now() - started);
    const satisfied = batch.revision > afterRevision && (condition === 'changed' || BATCH_TERMINAL.has(batch.state));
    return { batch: snapshot(batch), deadlineReached: !satisfied, clientWaitMs };
  }

  cancelMany(
    workspaceId: string,
    batchId: string,
    localIds: readonly string[] | undefined,
    operationId: string,
  ): TaskBatchSnapshot {
    const batch = this.requireBatch(workspaceId, batchId);
    if (localIds !== undefined && localIds.some((localId) => !batch.children.some((child) => child.localId === localId))) {
      throw new DevelopmentBrokerError('INVALID_INPUT', 'La cancelación contiene un hijo ajeno al lote.');
    }
    if (!OPERATION_ID.test(operationId)) throw new DevelopmentBrokerError('INVALID_INPUT', 'La intención de cancelación no es válida.');
    const intention = digest({ batchId, localIds: localIds === undefined ? null : [...localIds].toSorted() });
    const previous = batch.cancelIntents[operationId];
    if (previous !== undefined && previous !== intention) {
      throw new DevelopmentBrokerError('IDEMPOTENCY_CONFLICT', 'La intención de cancelación ya se usó con otros hijos.');
    }
    if (previous === intention) return snapshot(batch);
    batch.cancelIntents[operationId] = intention;
    const targets = localIds === undefined ? batch.children : batch.children.filter((child) => localIds.includes(child.localId));
    for (const child of targets) this.cancelChild(batch, child);
    this.touch(batch);
    this.schedule();
    return snapshot(batch);
  }

  async cancelWorkspace(workspaceId: string): Promise<void> {
    const batchIds: string[] = [];
    for (const batch of this.batches.values()) {
      if (batch.workspaceId === workspaceId && !BATCH_TERMINAL.has(batch.state)) {
        batchIds.push(batch.batchId);
        this.cancelMany(workspaceId, batch.batchId, undefined, `revoke_${batch.batchId.slice(-24)}`);
      }
    }
    const deadline = Date.now() + 5_000;
    while (batchIds.some((batchId) => {
      const batch = this.batches.get(batchId);
      return batch !== undefined && !BATCH_TERMINAL.has(batch.state);
    })) {
      if (Date.now() >= deadline) {
        throw new DevelopmentBrokerError(
          'ANALYSIS_CANCEL_TIMEOUT',
          'No se pudo detener todo el lote del workspace antes de retirar su acceso.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private requireBatch(workspaceId: string, batchId: string): MutableBatch {
    const batch = this.batches.get(batchId);
    if (batch === undefined || batch.workspaceId !== workspaceId) {
      throw new DevelopmentBrokerError('ANALYSIS_JOB_NOT_FOUND', 'El lote no existe en este workspace.');
    }
    return batch;
  }

  private cancelChild(batch: MutableBatch, child: MutableChild): void {
    if (CHILD_TERMINAL.has(child.state)) return;
    if (child.analysisJobId !== undefined) {
      const job = this.options.analysis.cancel(batch.workspaceId, child.analysisJobId);
      child.state = job.state === 'cancelled' ? 'cancelled' : 'cancel_requested';
      child.stage = job.stage;
      return;
    }
    const controller = this.validationControllers.get(`${batch.batchId}:${child.localId}`);
    if (controller !== undefined) {
      child.state = 'cancel_requested';
      child.stage = 'cancelling';
      controller.abort();
    } else {
      child.state = 'cancelled';
      child.stage = 'cancelled_before_start';
      child.effectState = 'not_applied';
    }
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => void this.drain().finally(() => {
      this.scheduled = false;
      if ([...this.batches.values()].some((batch) => !BATCH_TERMINAL.has(batch.state))) {
        const timer = setTimeout(() => this.schedule(), 25);
        timer.unref?.();
      }
    }));
  }

  private async drain(): Promise<void> {
    for (const batch of [...this.batches.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (BATCH_TERMINAL.has(batch.state)) continue;
      const spec = this.activeSpecs.get(batch.batchId);
      if (spec === undefined) continue;
      let changed = false;
      for (const child of batch.children) {
        if (child.analysisJobId !== undefined && !CHILD_TERMINAL.has(child.state)) {
          changed = this.syncAnalysisChild(batch, child) || changed;
        }
      }
      for (const child of batch.children) {
        if (child.state !== 'admitted' && child.state !== 'waiting_dependency') continue;
        const dependencies = child.dependsOn.map((id) => batch.children.find((candidate) => candidate.localId === id)!);
        if (dependencies.some((dependency) => CHILD_TERMINAL.has(dependency.state) && dependency.state !== 'completed')) {
          child.state = 'skipped_dependency';
          child.stage = 'dependency_failed';
          child.effectState = 'not_applied';
          child.errorCode = 'TASK_DEPENDENCY_FAILED';
          child.timing.dependencyWaitMs = Math.max(0, performance.now() - child.admittedAtMs);
          changed = true;
          continue;
        }
        if (!dependencies.every((dependency) => dependency.state === 'completed')) {
          child.state = 'waiting_dependency';
          child.stage = 'waiting_for_dependencies';
          continue;
        }
        child.dependencyReadyAtMs = performance.now();
        child.timing.dependencyWaitMs = Math.max(0, child.dependencyReadyAtMs - child.admittedAtMs);
        const childSpec = spec.byLocalId.get(child.localId)!;
        if (child.operationKind === 'validation.run') this.startValidation(batch, child, String(childSpec.parameters['profile']));
        else this.startAnalysis(batch, child, childSpec);
        changed = true;
      }
      if (batch.failurePolicy === 'cancel_remaining' && batch.children.some((child) =>
        child.state === 'failed' || child.state === 'interrupted')) {
        for (const child of batch.children) this.cancelChild(batch, child);
        changed = true;
      }
      const derived = batchState(batch.children);
      if (derived !== batch.state) {
        batch.state = derived;
        changed = true;
      }
      if (changed) this.touch(batch);
    }
  }

  private startAnalysis(batch: MutableBatch, child: MutableChild, spec: TaskChildRequest): void {
    const request: AnalysisJobRequest = {
      operationKind: child.operationKind as AnalysisOperationKind,
      workspaceId: batch.workspaceId,
      operationId: `tb_${batch.batchId.slice(-12)}_${digest(child.localId).slice(0, 12)}`,
      ...(child.sourcePath === undefined ? {} : { sourcePath: child.sourcePath }),
      parameters: spec.parameters,
    };
    const job = this.options.analysis.start(request);
    child.analysisJobId = job.jobId;
    child.state = job.state === 'running' ? 'running' : 'waiting_resource';
    child.stage = job.state === 'running' ? job.stage : 'waiting_for_analysis_capacity';
    if (job.state === 'running') child.startedAtMs = performance.now();
    child.effectState = job.effectState;
  }

  private syncAnalysisChild(batch: MutableBatch, child: MutableChild): boolean {
    const job = this.options.analysis.status(batch.workspaceId, child.analysisJobId!, 0, 1).job;
    const before = `${child.state}:${child.stage}:${child.effectState}:${child.errorCode ?? ''}`;
    child.stage = job.stage;
    child.effectState = job.effectState;
    child.coverage = job.coverage.status;
    child.summary = job.summary;
    if (job.errorCode === undefined) delete child.errorCode;
    else child.errorCode = job.errorCode;
    if (job.state === 'queued' || job.state === 'waiting_resource') {
      child.state = 'waiting_resource';
      child.stage = 'waiting_for_analysis_capacity';
      child.timing.capacityWaitMs = Math.max(0, performance.now() - (child.dependencyReadyAtMs ?? child.admittedAtMs));
    } else if (job.state === 'running') {
      child.state = 'running';
      if (child.startedAtMs === undefined) {
        child.startedAtMs = performance.now();
        child.timing.capacityWaitMs = Math.max(0, child.startedAtMs - (child.dependencyReadyAtMs ?? child.admittedAtMs));
      }
    } else if (job.state === 'cancel_requested') {
      child.state = 'cancel_requested';
      child.stage = job.stage;
    } else {
      child.state = job.state === 'completed' ? 'completed'
        : job.state === 'cancelled' ? 'cancelled'
          : job.state === 'interrupted' ? 'interrupted' : 'failed';
      child.resultAvailable = job.state === 'completed';
      child.resultExpired = job.state === 'completed' && job.resumeCapability === 'restart';
      if (child.startedAtMs !== undefined) child.timing.executionMs = Math.max(0, performance.now() - child.startedAtMs);
    }
    return before !== `${child.state}:${child.stage}:${child.effectState}:${child.errorCode ?? ''}`;
  }

  private startValidation(batch: MutableBatch, child: MutableChild, profile: string): void {
    const key = `${batch.batchId}:${child.localId}`;
    const controller = new AbortController();
    this.validationControllers.set(key, controller);
    child.state = 'waiting_resource';
    child.stage = 'waiting_for_validation_resource';
    const readyAt = child.dependencyReadyAtMs ?? performance.now();
    void this.options.runValidation(batch.workspaceId, profile, {
      signal: controller.signal,
      lockAcquired: () => {
        child.lockAcquiredAtMs = performance.now();
        child.timing.lockWaitMs = Math.max(0, child.lockAcquiredAtMs - readyAt);
        child.stage = 'validation_lock_acquired';
        this.touch(batch);
      },
      lockReleased: () => {
        if (child.lockAcquiredAtMs !== undefined) {
          child.timing.lockHoldMs = Math.max(0, performance.now() - child.lockAcquiredAtMs);
        }
      },
      started: () => {
        if (controller.signal.aborted) return;
        child.startedAtMs = performance.now();
        child.timing.capacityWaitMs = 0;
        child.state = 'running';
        child.stage = 'validation_running';
        this.touch(batch);
      },
    }).then(async (result) => {
      if (controller.signal.aborted) {
        child.state = 'cancelled';
        child.stage = 'cancelled';
        child.effectState = 'not_applied';
        return;
      }
      // La autoridad se revalida antes de entregar el resultado retenido.
      await this.options.revalidateRead(batch.workspaceId);
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (bytes > this.limits.maxValidationResultBytes) {
        throw new DevelopmentBrokerError('ANALYSIS_FAILED', 'El resultado de validación excede el presupuesto retenido.');
      }
      this.rememberValidationResult(key, result, bytes);
      child.state = result.exitCode === 0 ? 'completed' : 'failed';
      child.stage = 'validation_completed';
      child.effectState = 'not_applied';
      child.coverage = result.truncated ? 'partial' : 'supported';
      child.resultAvailable = true;
      child.summary = {
        profile: result.profile,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        ...(result.reviewFingerprint === undefined ? {} : { reviewFingerprint: result.reviewFingerprint }),
      };
      if (result.exitCode !== 0) child.errorCode = 'VALIDATION_FAILED';
    }).catch((error) => {
      child.state = controller.signal.aborted ? 'cancelled' : 'failed';
      child.stage = child.state;
      child.effectState = 'not_applied';
      child.errorCode = controller.signal.aborted ? 'ANALYSIS_CANCELLED' : safeErrorCode(error);
    }).finally(() => {
      if (child.startedAtMs !== undefined) child.timing.executionMs = Math.max(0, performance.now() - child.startedAtMs);
      this.validationControllers.delete(key);
      this.touch(batch);
      this.schedule();
    });
  }

  private rememberValidationResult(key: string, result: TaskValidationResult, bytes: number): void {
    const previous = this.validationResults.get(key);
    if (previous !== undefined) this.validationResultBytes -= previous.bytes;
    this.validationResults.delete(key);
    this.validationResults.set(key, { result, bytes });
    this.validationResultBytes += bytes;
    while (this.validationResultBytes > this.limits.maxTotalValidationResultBytes) {
      const oldest = this.validationResults.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const removed = this.validationResults.get(oldest)!;
      this.validationResults.delete(oldest);
      this.validationResultBytes -= removed.bytes;
      const [batchId, localId] = oldest.split(':');
      const child = this.batches.get(batchId ?? '')?.children.find((candidate) => candidate.localId === localId);
      if (child !== undefined) {
        child.resultAvailable = false;
        child.resultExpired = true;
      }
    }
  }

  private touch(batch: MutableBatch): void {
    batch.state = batchState(batch.children);
    batch.revision += 1;
    batch.updatedAt = this.now().toISOString();
    this.save(batch);
    if (BATCH_TERMINAL.has(batch.state)) this.activeSpecs.delete(batch.batchId);
    this.pruneRetained();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeAnalysis();
    for (const controller of this.validationControllers.values()) controller.abort();
    for (const waiter of this.waiters) waiter.resolve();
  }
}
