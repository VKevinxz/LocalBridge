import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { DevelopmentBrokerError } from './broker.js';

export type AnalysisOperationKind =
  | 'artifact.inspect'
  | 'artifact.hash'
  | 'artifact.text.read'
  | 'binary.inspect'
  | 'document.process'
  | 'web.download.start';

export type AnalysisJobState =
  | 'queued'
  | 'running'
  | 'waiting_resource'
  | 'cancel_requested'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'source_changed'
  | 'interrupted';

export interface AnalysisJobRequest {
  readonly operationKind: AnalysisOperationKind;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sourcePath?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AnalysisCoverage {
  readonly status: 'supported' | 'partial' | 'unsupported' | 'source_changed';
  readonly bytesRead: number;
  readonly uniqueBytesRead: number;
  readonly rangesRead?: number;
  readonly sourceBytes?: number;
  readonly pagesExamined?: readonly number[];
  readonly pagesDelivered?: readonly number[];
  readonly omissions?: readonly string[];
}

export interface AnalysisResultItem {
  readonly kind: 'json' | 'text' | 'image';
  readonly value?: unknown;
  readonly text?: string;
  readonly mimeType?: 'image/png' | 'image/jpeg';
  readonly dataBase64?: string;
}

export interface AnalysisJobExecutionResult {
  readonly summary: Readonly<Record<string, unknown>>;
  readonly coverage: AnalysisCoverage;
  readonly items: readonly AnalysisResultItem[];
  readonly effectState?: 'not_started' | 'applied' | 'not_applied' | 'uncertain';
}

export interface AnalysisJobProgress {
  readonly stage: string;
  readonly completed: number;
  readonly total?: number;
  readonly unit: 'bytes' | 'pages' | 'items';
  readonly coverage?: Partial<AnalysisCoverage>;
}

export interface AnalysisJobExecutionContext {
  readonly signal: AbortSignal;
  progress(value: AnalysisJobProgress): void;
  /**
   * Persiste la frontera previa a un efecto externo. Si Desktop termina después
   * de esta llamada y antes del recibo, el journal lo reconcilia como incierto
   * y nunca repite el efecto automáticamente.
   */
  effectStarted(summary?: Readonly<Record<string, unknown>>): void;
  /** Persiste el recibo mínimo inmediatamente después de aplicar el efecto. */
  effectApplied(summary: Readonly<Record<string, unknown>>): void;
  /** Declara que un fallo conocido ocurrió antes de publicar el efecto. */
  effectNotApplied(summary?: Readonly<Record<string, unknown>>): void;
}

export type AnalysisJobExecutor = (
  request: AnalysisJobRequest,
  context: AnalysisJobExecutionContext,
) => Promise<AnalysisJobExecutionResult>;

export interface AnalysisJobSupervisorOptions {
  readonly journalPath: string;
  readonly execute: AnalysisJobExecutor;
  readonly concurrencyForWorkspace: (workspaceId: string) => Promise<1 | 2>;
  readonly retentionMs?: number;
  readonly maxQueuedJobs?: number;
  readonly maxGlobalRunningJobs?: number;
  readonly now?: () => Date;
  readonly onChange?: () => void;
}

interface MutableJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly fingerprint: string;
  readonly request: AnalysisJobRequest;
  readonly createdAt: string;
  readonly retentionUntil: string;
  updatedAt: string;
  state: AnalysisJobState;
  stage: string;
  progress: AnalysisJobProgress;
  attempt: number;
  effectState: 'not_started' | 'applied' | 'not_applied' | 'uncertain';
  resumeCapability: 'continue' | 'restart' | 'result_only' | 'none';
  coverage: AnalysisCoverage;
  summary: Readonly<Record<string, unknown>>;
  errorCode?: string;
}

export interface AnalysisJobSnapshot {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly operationId: string;
  readonly operationKind: AnalysisOperationKind;
  readonly workspaceId: string;
  readonly sourcePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retentionUntil: string;
  readonly state: AnalysisJobState;
  readonly stage: string;
  readonly progress: AnalysisJobProgress;
  readonly attempt: number;
  readonly effectState: MutableJob['effectState'];
  readonly resumeCapability: MutableJob['resumeCapability'];
  readonly coverage: AnalysisCoverage;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
}

const TERMINAL_STATES = new Set<AnalysisJobState>(['cancelled', 'completed', 'failed', 'source_changed', 'interrupted']);
const MAX_IN_MEMORY_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IN_MEMORY_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_STATUS_RESULT_BYTES = 3 * 1024 * 1024;
const JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  request_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  UNIQUE(workspace_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_workspace_updated ON analysis_jobs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_state ON analysis_jobs(state);
CREATE TABLE IF NOT EXISTS analysis_job_results (
  job_id TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(request: AnalysisJobRequest): string {
  return createHash('sha256').update(canonical(request)).digest('hex');
}

function safeErrorCode(error: unknown): string {
  const candidate = error as { code?: unknown };
  return typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate.code)
    ? candidate.code
    : 'ANALYSIS_FAILED';
}

function snapshot(job: MutableJob): AnalysisJobSnapshot {
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    operationId: job.request.operationId,
    operationKind: job.request.operationKind,
    workspaceId: job.request.workspaceId,
    ...(job.request.sourcePath === undefined ? {} : { sourcePath: job.request.sourcePath }),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    retentionUntil: job.retentionUntil,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    attempt: job.attempt,
    effectState: job.effectState,
    resumeCapability: job.resumeCapability,
    coverage: job.coverage,
    summary: job.summary,
    ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
  };
}

function openJournal(journalPath: string): DatabaseSync {
  mkdirSync(path.dirname(journalPath), { recursive: true });
  const db = new DatabaseSync(journalPath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(JOURNAL_SCHEMA);
  return db;
}

function rowJob(row: Record<string, unknown>): MutableJob {
  return JSON.parse(String(row['record_json'])) as MutableJob;
}

export class AnalysisJobSupervisor {
  private readonly jobs = new Map<string, MutableJob>();
  private readonly results = new Map<string, readonly AnalysisResultItem[]>();
  private readonly resultSizes = new Map<string, number>();
  private resultBytes = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly runningByWorkspace = new Map<string, number>();
  private scheduling = false;
  private rescheduleRequested = false;
  private closed = false;
  private readonly retentionMs: number;
  private readonly maxQueuedJobs: number;
  private readonly maxGlobalRunningJobs: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: AnalysisJobSupervisorOptions) {
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxQueuedJobs = options.maxQueuedJobs ?? 100;
    this.maxGlobalRunningJobs = options.maxGlobalRunningJobs ?? 4;
    if (!Number.isInteger(this.maxGlobalRunningJobs) || this.maxGlobalRunningJobs < 1 || this.maxGlobalRunningJobs > 16) {
      throw new DevelopmentBrokerError('INVALID_INPUT', 'La concurrencia global de análisis no es válida.');
    }
    this.now = options.now ?? (() => new Date());
    this.reconcileJournal();
  }

  private reconcileJournal(): void {
    const db = openJournal(this.options.journalPath);
    try {
      const now = this.now().toISOString();
      db.prepare('DELETE FROM analysis_jobs WHERE retention_until <= ?').run(now);
      // Versiones de desarrollo previas llegaron a guardar texto/imágenes en
      // esta tabla. La v1.7 conserva contenido solo en memoria acotada: el
      // journal durable almacena recibos, estado y cobertura.
      db.prepare('DELETE FROM analysis_job_results').run();
      const rows = db.prepare('SELECT record_json FROM analysis_jobs ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const job = rowJob(row);
        if (!TERMINAL_STATES.has(job.state)) {
          job.state = 'interrupted';
          job.stage = 'reconciled_after_restart';
          job.updatedAt = now;
          job.errorCode = 'ANALYSIS_INTERRUPTED';
          if (job.effectState === 'uncertain' || job.effectState === 'applied') {
            // No se reejecuta un efecto externo que pudo haberse publicado. El
            // recibo mínimo de `applied` permanece visible en summary.
            job.resumeCapability = job.effectState === 'applied' ? 'result_only' : 'none';
          } else {
            job.resumeCapability = 'restart';
          }
          this.persist(db, job);
        }
        this.jobs.set(job.jobId, job);
        if (job.state === 'completed' && ['artifact.text.read', 'binary.inspect', 'document.process'].includes(job.request.operationKind)) {
          job.resumeCapability = 'restart';
          this.persist(db, job);
        }
      }
    } finally {
      db.close();
    }
  }

  private persist(db: DatabaseSync, job: MutableJob): void {
    db.prepare(`INSERT INTO analysis_jobs
      (job_id, workspace_id, operation_id, fingerprint, request_json, record_json, state, created_at, updated_at, retention_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET record_json=excluded.record_json, state=excluded.state,
        updated_at=excluded.updated_at, retention_until=excluded.retention_until`).run(
      job.jobId,
      job.request.workspaceId,
      job.request.operationId,
      job.fingerprint,
      JSON.stringify(job.request),
      JSON.stringify(job),
      job.state,
      job.createdAt,
      job.updatedAt,
      job.retentionUntil,
    );
  }

  private save(job: MutableJob): void {
    const db = openJournal(this.options.journalPath);
    try {
      this.persist(db, job);
    } finally {
      db.close();
    }
    this.options.onChange?.();
    for (const listener of this.listeners) listener();
  }

  private saveCompleted(job: MutableJob): void {
    const db = openJournal(this.options.journalPath);
    try {
      db.exec('BEGIN IMMEDIATE');
      this.persist(db, job);
      db.prepare('DELETE FROM analysis_job_results WHERE job_id = ?').run(job.jobId);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    } finally {
      db.close();
    }
    this.options.onChange?.();
    for (const listener of this.listeners) listener();
  }

  /** Suscripción local de Desktop; no consume resultados ni cambia cursores. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private rememberResult(job: MutableJob, items: readonly AnalysisResultItem[]): void {
    const size = Buffer.byteLength(JSON.stringify(items), 'utf8');
    if (size > MAX_IN_MEMORY_RESULT_BYTES) {
      throw new DevelopmentBrokerError('ANALYSIS_FAILED', 'El resultado excede el presupuesto de memoria del trabajo.');
    }
    const previousSize = this.resultSizes.get(job.jobId) ?? 0;
    this.resultBytes -= previousSize;
    this.results.delete(job.jobId);
    this.resultSizes.delete(job.jobId);
    this.results.set(job.jobId, items);
    this.resultSizes.set(job.jobId, size);
    this.resultBytes += size;
    while (this.resultBytes > MAX_TOTAL_IN_MEMORY_RESULT_BYTES) {
      const oldestJobId = this.results.keys().next().value as string | undefined;
      if (oldestJobId === undefined) break;
      this.results.delete(oldestJobId);
      this.resultBytes -= this.resultSizes.get(oldestJobId) ?? 0;
      this.resultSizes.delete(oldestJobId);
      const evicted = this.jobs.get(oldestJobId);
      if (evicted !== undefined && ['artifact.text.read', 'binary.inspect', 'document.process'].includes(evicted.request.operationKind)) {
        evicted.resumeCapability = 'restart';
        evicted.updatedAt = this.now().toISOString();
        this.save(evicted);
      }
    }
  }

  start(request: AnalysisJobRequest): AnalysisJobSnapshot {
    if (this.closed) throw new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'El supervisor de análisis se está cerrando.');
    const digest = fingerprint(request);
    const existing = [...this.jobs.values()].find((job) =>
      job.request.workspaceId === request.workspaceId && job.request.operationId === request.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== digest) throw new DevelopmentBrokerError('IDEMPOTENCY_CONFLICT', 'El operationId ya se usó con otra intención.');
      return snapshot(existing);
    }
    const queued = [...this.jobs.values()].filter((job) => job.state === 'queued').length;
    if (queued >= this.maxQueuedJobs) {
      throw new DevelopmentBrokerError('ANALYSIS_QUEUE_FULL', 'La cola de análisis está llena; no se inició ningún efecto.');
    }
    const now = this.now();
    const job: MutableJob = {
      schemaVersion: 1,
      jobId: `job_${randomBytes(12).toString('hex')}`,
      fingerprint: digest,
      request,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      retentionUntil: new Date(now.getTime() + this.retentionMs).toISOString(),
      state: 'queued',
      stage: 'admitted',
      progress: { stage: 'admitted', completed: 0, unit: 'items' },
      attempt: 1,
      effectState: 'not_started',
      resumeCapability: 'restart',
      coverage: { status: 'partial', bytesRead: 0, uniqueBytesRead: 0 },
      summary: {},
    };
    this.save(job);
    this.jobs.set(job.jobId, job);
    this.schedule();
    return snapshot(job);
  }

  list(workspaceId: string, cursor: number, limit: number): { readonly jobs: readonly AnalysisJobSnapshot[]; readonly nextCursor?: number } {
    const visible = [...this.jobs.values()]
      .filter((job) => job.request.workspaceId === workspaceId)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
    const jobs = visible.slice(cursor, cursor + limit).map(snapshot);
    const next = cursor + jobs.length;
    return { jobs, ...(next < visible.length ? { nextCursor: next } : {}) };
  }

  /** Vista local de Desktop. Nunca se expone por MCP sin filtrar por workspace. */
  listAll(limit = 50): readonly AnalysisJobSnapshot[] {
    return [...this.jobs.values()]
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(snapshot);
  }

  status(workspaceId: string, jobId: string, cursor: number, maxItems: number): {
    readonly job: AnalysisJobSnapshot;
    readonly items: readonly AnalysisResultItem[];
    readonly resultsAvailable: boolean;
    readonly nextCursor?: number;
  } {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.request.workspaceId !== workspaceId) {
      throw new DevelopmentBrokerError('ANALYSIS_JOB_NOT_FOUND', 'El trabajo de análisis no existe en este workspace.');
    }
    const stored = this.results.get(jobId);
    const items: AnalysisResultItem[] = [];
    let encodedBytes = 0;
    if (stored !== undefined) {
      for (const item of stored.slice(cursor, cursor + maxItems)) {
        const nextBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
        if (items.length > 0 && encodedBytes + nextBytes > MAX_STATUS_RESULT_BYTES) break;
        if (nextBytes > MAX_STATUS_RESULT_BYTES) {
          throw new DevelopmentBrokerError('ANALYSIS_FAILED', 'Un resultado individual excede el presupuesto de transporte.');
        }
        items.push(item);
        encodedBytes += nextBytes;
      }
    }
    const next = cursor + items.length;
    return {
      job: snapshot(job),
      items,
      resultsAvailable: stored !== undefined,
      ...(stored !== undefined && next < stored.length ? { nextCursor: next } : {}),
    };
  }

  cancel(workspaceId: string, jobId: string): AnalysisJobSnapshot {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.request.workspaceId !== workspaceId) {
      throw new DevelopmentBrokerError('ANALYSIS_JOB_NOT_FOUND', 'El trabajo de análisis no existe en este workspace.');
    }
    if (TERMINAL_STATES.has(job.state)) return snapshot(job);
    job.updatedAt = this.now().toISOString();
    if (job.state === 'queued' || job.state === 'waiting_resource') {
      job.state = 'cancelled';
      job.stage = 'cancelled';
      job.resumeCapability = 'none';
    } else {
      job.state = 'cancel_requested';
      job.stage = 'cancelling';
      this.controllers.get(jobId)?.abort();
    }
    this.save(job);
    this.schedule();
    return snapshot(job);
  }

  /** Cancela y espera la limpieza de todo trabajo del workspace antes de retirar autoridad. */
  async cancelWorkspace(workspaceId: string): Promise<readonly AnalysisJobSnapshot[]> {
    const jobIds = [...this.jobs.entries()]
      .filter(([_jobId, job]) => job.request.workspaceId === workspaceId && !TERMINAL_STATES.has(job.state))
      .map(([jobId]) => jobId);
    for (const jobId of jobIds) this.cancel(workspaceId, jobId);
    const deadline = Date.now() + 5_000;
    const allStopped = (): boolean => jobIds.every((jobId) => TERMINAL_STATES.has(this.jobs.get(jobId)?.state ?? 'interrupted'));
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (allStopped()) resolve();
        else if (Date.now() >= deadline) reject(new DevelopmentBrokerError(
          'ANALYSIS_CANCEL_TIMEOUT',
          'No se pudo detener todo el análisis del workspace antes de retirar su acceso.',
        ));
        else setTimeout(check, 10);
      };
      check();
    });
    return jobIds.flatMap((jobId) => {
      const job = this.jobs.get(jobId);
      return job === undefined ? [] : [snapshot(job)];
    });
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    queueMicrotask(() => void this.drain().finally(() => {
      this.scheduling = false;
      if (this.rescheduleRequested) {
        this.rescheduleRequested = false;
        this.schedule();
      }
    }));
  }

  private async drain(): Promise<void> {
    let admitted = true;
    while (admitted && !this.closed) {
      admitted = false;
      const queued = [...this.jobs.values()].filter((job) => job.state === 'queued').toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const job of queued) {
        const totalActive = [...this.runningByWorkspace.values()].reduce((total, count) => total + count, 0);
        if (totalActive >= this.maxGlobalRunningJobs) return;
        const active = this.runningByWorkspace.get(job.request.workspaceId) ?? 0;
        let limit: 1 | 2;
        try {
          limit = await this.options.concurrencyForWorkspace(job.request.workspaceId);
        } catch {
          job.state = 'failed';
          job.stage = 'authority_check_failed';
          job.errorCode = 'CAPABILITY_DISABLED';
          job.updatedAt = this.now().toISOString();
          this.save(job);
          continue;
        }
        if (active >= limit) continue;
        admitted = true;
        this.runningByWorkspace.set(job.request.workspaceId, active + 1);
        void this.run(job).catch(() => undefined).finally(() => {
          const current = this.runningByWorkspace.get(job.request.workspaceId) ?? 1;
          if (current <= 1) this.runningByWorkspace.delete(job.request.workspaceId);
          else this.runningByWorkspace.set(job.request.workspaceId, current - 1);
          this.schedule();
        });
      }
    }
  }

  private async run(job: MutableJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    job.state = 'running';
    job.stage = 'starting';
    job.updatedAt = this.now().toISOString();
    this.save(job);
    let lastProgressWrite = 0;
    try {
      const result = await this.options.execute(job.request, {
        signal: controller.signal,
        progress: (progress) => {
          if (controller.signal.aborted) return;
          job.progress = progress;
          job.stage = progress.stage;
          job.updatedAt = this.now().toISOString();
          if (progress.coverage !== undefined) job.coverage = { ...job.coverage, ...progress.coverage };
          const timestamp = Date.now();
          if (timestamp - lastProgressWrite >= 250) {
            lastProgressWrite = timestamp;
            this.save(job);
          }
        },
        effectStarted: (summary) => {
          if (controller.signal.aborted) throw new DevelopmentBrokerError('ANALYSIS_CANCELLED', 'El trabajo fue cancelado antes del efecto.');
          job.effectState = 'uncertain';
          job.resumeCapability = 'none';
          job.stage = 'effect_started';
          if (summary !== undefined) job.summary = summary;
          job.updatedAt = this.now().toISOString();
          // Debe persistir antes de ejecutar el efecto; si falla, el executor
          // no recibe autorización para continuar.
          this.save(job);
        },
        effectApplied: (summary) => {
          job.effectState = 'applied';
          job.resumeCapability = 'result_only';
          job.stage = 'effect_applied';
          job.summary = summary;
          job.updatedAt = this.now().toISOString();
          this.save(job);
        },
        effectNotApplied: (summary) => {
          job.effectState = 'not_applied';
          job.resumeCapability = 'restart';
          job.stage = 'effect_not_applied';
          if (summary !== undefined) job.summary = summary;
          job.updatedAt = this.now().toISOString();
          this.save(job);
        },
      });
      if (controller.signal.aborted && result.effectState !== 'applied') {
        job.state = 'cancelled';
        job.stage = 'cancelled';
        job.resumeCapability = 'none';
      } else {
        job.state = 'completed';
        job.stage = 'completed';
        job.summary = result.summary;
        job.coverage = result.coverage;
        job.effectState = result.effectState ?? 'not_applied';
        job.resumeCapability = 'result_only';
        this.saveCompleted(job);
        this.rememberResult(job, result.items);
      }
    } catch (error) {
      const discardedSize = this.resultSizes.get(job.jobId) ?? 0;
      this.resultBytes -= discardedSize;
      this.resultSizes.delete(job.jobId);
      this.results.delete(job.jobId);
      const code = safeErrorCode(error);
      job.state = controller.signal.aborted || code === 'ANALYSIS_CANCELLED'
        ? 'cancelled'
        : code === 'HASH_MISMATCH' || code === 'SOURCE_CHANGED'
          ? 'source_changed'
          : 'failed';
      job.stage = job.state;
      job.errorCode = code;
      job.resumeCapability = job.effectState === 'applied'
        ? 'result_only'
        : job.effectState === 'uncertain' || job.state === 'cancelled'
          ? 'none'
          : 'restart';
      if (job.state === 'source_changed') job.coverage = { ...job.coverage, status: 'source_changed' };
    } finally {
      job.updatedAt = this.now().toISOString();
      this.save(job);
      this.controllers.delete(job.jobId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    const now = this.now().toISOString();
    for (const job of this.jobs.values()) {
      if (TERMINAL_STATES.has(job.state)) continue;
      job.state = 'interrupted';
      job.stage = 'desktop_closed';
      job.errorCode = 'ANALYSIS_INTERRUPTED';
      job.resumeCapability = job.effectState === 'applied'
        ? 'result_only'
        : job.effectState === 'uncertain'
          ? 'none'
          : 'restart';
      job.updatedAt = now;
      this.save(job);
    }
    this.results.clear();
    this.resultSizes.clear();
    this.resultBytes = 0;
  }
}
