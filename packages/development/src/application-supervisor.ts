import { randomBytes } from 'node:crypto';

import type { AuthorizedWorkspace, LocalApplication, WorkspaceRegistry } from '@localbridge/workspace';

import { DevelopmentBrokerError } from './broker.js';
import type { ProcessListenerSummary, ProcessSupervisor, ResolvedProcessListener } from './process-supervisor.js';

const READINESS_TIMEOUT_MS = 20_000;
const READINESS_POLL_MS = 150;
const TERMINAL_RETENTION_MS = 5 * 60_000;

export type ApplicationRunState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'failed_cleanup';

export interface ApplicationServiceRunSummary {
  readonly service: string;
  readonly workspaceId: string;
  readonly processProfile: string;
  readonly state: 'pending' | 'starting' | 'ready' | 'stopped' | 'failed';
  readonly port?: number | undefined;
  readonly bindScope?: 'loopback' | 'wildcard' | undefined;
}

export interface ApplicationRunSummary {
  readonly runId: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly primaryWorkspaceId: string;
  readonly state: ApplicationRunState;
  readonly startedAt: string;
  readonly services: readonly ApplicationServiceRunSummary[];
  readonly errorCode?: string | undefined;
}

export interface ResolvedApplicationRunService {
  readonly service: string;
  readonly workspaceId: string;
  readonly processId: string;
  readonly listenerRef: string;
  readonly listener: ResolvedProcessListener;
}

export interface ResolvedApplicationRun {
  readonly application: LocalApplication;
  readonly summary: ApplicationRunSummary;
  readonly services: readonly ResolvedApplicationRunService[];
}

interface MutableServiceRun {
  readonly definition: LocalApplication['services'][number];
  state: ApplicationServiceRunSummary['state'];
  processId?: string;
  listener?: ResolvedProcessListener;
}

interface MutableApplicationRun {
  readonly runId: string;
  readonly application: LocalApplication;
  readonly primaryWorkspaceId: string;
  readonly startedAtMs: number;
  readonly services: MutableServiceRun[];
  state: ApplicationRunState;
  errorCode?: string;
  stopRequested: boolean;
  launchPromise?: Promise<void>;
  terminalTimer?: NodeJS.Timeout;
}

export interface ApplicationSupervisorOptions {
  readonly processes: ProcessSupervisor;
  readonly loadRegistry: () => Promise<WorkspaceRegistry>;
  readonly now?: () => number;
  readonly readinessTimeoutMs?: number;
  readonly onActivityChange?: () => void;
}

function fail(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

function primaryWorkspace(application: LocalApplication): string {
  const primary = application.services.find((service) => service.id === application.primaryServiceId);
  if (primary === undefined) fail('APPLICATION_REVIEW_REQUIRED', 'La aplicación no tiene un servicio principal válido.');
  return primary.workspaceId;
}

function summary(run: MutableApplicationRun): ApplicationRunSummary {
  return {
    runId: run.runId,
    applicationId: run.application.id,
    applicationName: run.application.name,
    primaryWorkspaceId: run.primaryWorkspaceId,
    state: run.state,
    startedAt: new Date(run.startedAtMs).toISOString(),
    services: run.services.map((service) => ({
      service: service.definition.alias,
      workspaceId: service.definition.workspaceId,
      processProfile: service.definition.processProfile,
      state: service.state,
      ...(service.listener === undefined ? {} : {
        port: service.listener.port,
        bindScope: service.listener.bindScope,
      }),
    })),
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
  };
}

function selectListener(
  definition: LocalApplication['services'][number],
  listeners: readonly ProcessListenerSummary[],
): ProcessListenerSummary | undefined {
  const allowed = listeners.filter((listener) => {
    if (!listener.exclusive) return false;
    if (definition.hostMode === 'listener-literal') return listener.bindScope === 'loopback';
    if (listener.bindScope === 'wildcard') return definition.allowManagedWildcard;
    return true;
  });
  const ports = new Set(allowed.map((listener) => listener.port));
  if (ports.size !== 1) return undefined;
  return allowed.toSorted((left, right) => {
    if (left.bindScope !== right.bindScope) return left.bindScope === 'loopback' ? -1 : 1;
    return left.addressFamily.localeCompare(right.addressFamily);
  })[0];
}

export class ApplicationSupervisor {
  private readonly runs = new Map<string, MutableApplicationRun>();
  private readonly operations = new Map<string, string>();
  private readonly now: () => number;
  private readonly readinessTimeoutMs: number;

  constructor(private readonly options: ApplicationSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  }

  private async requireApplication(applicationId: string, allowNeedsReview = false): Promise<{ application: LocalApplication; byWorkspace: Map<string, AuthorizedWorkspace> }> {
    const registry = await this.options.loadRegistry();
    const application = registry.applications.find((candidate) => candidate.id === applicationId);
    if (application === undefined) fail('APPLICATION_PROFILE_NOT_FOUND', 'La aplicación no existe.');
    if (application.reviewState !== 'reviewed' && !(allowNeedsReview && application.reviewState === 'needs-review')) {
      fail('APPLICATION_REVIEW_REQUIRED', 'La aplicación necesita revisión local.');
    }
    const byWorkspace = new Map(registry.workspaces.map((workspace) => [workspace.id, workspace]));
    for (const service of application.services) {
      const workspace = byWorkspace.get(service.workspaceId);
      if (workspace === undefined || !workspace.enabled) fail('WORKSPACE_NOT_FOUND', 'Un proyecto de la aplicación no está disponible.');
      if (workspace.permissions.processes !== true || workspace.permissions.browserRead !== true) {
        fail('CAPABILITY_DISABLED', 'Un proyecto no permite procesos o navegador.');
      }
      if (workspace.automationReviewRequired === true || workspace.processProfiles?.[service.processProfile] === undefined) {
        fail('PROFILE_REVIEW_REQUIRED', 'Un perfil de servicio necesita revisión.');
      }
    }
    return { application, byWorkspace };
  }

  async start(applicationId: string, operationId?: string): Promise<ApplicationRunSummary> {
    return this.startInternal(applicationId, operationId, false);
  }

  /** Frontera exclusivamente local para el asistente de configuración. */
  async startForLocalReview(applicationId: string): Promise<ApplicationRunSummary> {
    return this.startInternal(applicationId, undefined, true);
  }

  private async startInternal(applicationId: string, operationId: string | undefined, allowNeedsReview: boolean): Promise<ApplicationRunSummary> {
    const operationKey = operationId === undefined ? undefined : `${applicationId}:${operationId}`;
    const previousRunId = operationKey === undefined ? undefined : this.operations.get(operationKey);
    const previous = previousRunId === undefined ? undefined : this.runs.get(previousRunId);
    if (previous !== undefined) return summary(previous);

    const { application } = await this.requireApplication(applicationId, allowNeedsReview);
    const existing = [...this.runs.values()].find((run) => run.application.id === applicationId && ['starting', 'ready', 'stopping'].includes(run.state));
    if (existing !== undefined) return summary(existing);
    const run: MutableApplicationRun = {
      runId: `run_${randomBytes(12).toString('hex')}`,
      application,
      primaryWorkspaceId: primaryWorkspace(application),
      startedAtMs: this.now(),
      services: application.services
        .toSorted((left, right) => left.startupOrder - right.startupOrder)
        .map((definition) => ({ definition, state: 'pending' })),
      state: 'starting',
      stopRequested: false,
    };
    this.runs.set(run.runId, run);
    if (operationKey !== undefined) this.operations.set(operationKey, run.runId);
    run.launchPromise = this.launch(run);
    this.options.onActivityChange?.();
    return summary(run);
  }

  private async waitForListener(run: MutableApplicationRun, service: MutableServiceRun): Promise<ResolvedProcessListener> {
    const deadline = this.now() + this.readinessTimeoutMs;
    while (this.now() < deadline && !run.stopRequested) {
      const processId = service.processId!;
      const current = await this.options.processes.listeners(service.definition.workspaceId, processId);
      if (current.process.state !== 'running') fail('APPLICATION_START_FAILED', 'El servicio terminó antes de estar listo.');
      const listener = selectListener(service.definition, current.listeners);
      if (listener !== undefined) {
        try {
          return await this.options.processes.resolveListener(service.definition.workspaceId, processId, listener.listenerRef);
        } catch (error) {
          // El monitor nativo publica snapshots atómicos. Entre listar y resolver puede
          // observarse un snapshot transitorio vacío y cambiar el listenerRef. Nunca
          // sustituimos la autoridad por otro listener: volvemos a demostrarla desde cero.
          if (!(error instanceof DevelopmentBrokerError) || error.code !== 'LISTENER_NOT_FOUND') throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
    }
    fail('APPLICATION_START_FAILED', 'El servicio no publicó un listener verificable a tiempo.');
  }

  private async launch(run: MutableApplicationRun): Promise<void> {
    let activeService: MutableServiceRun | undefined;
    try {
      for (const service of run.services) {
        if (run.stopRequested) break;
        activeService = service;
        service.state = 'starting';
        this.options.onActivityChange?.();
        const process = await this.options.processes.start(
          service.definition.workspaceId,
          service.definition.processProfile,
          `application:${run.runId}:${service.definition.id}`,
        );
        service.processId = process.processId;
        service.listener = await this.waitForListener(run, service);
        service.state = 'ready';
        activeService = undefined;
        this.options.onActivityChange?.();
      }
      if (run.stopRequested) {
        await this.cleanup(run, 'stopped');
        return;
      }
      run.state = 'ready';
      this.options.onActivityChange?.();
    } catch (error) {
      run.errorCode = error instanceof DevelopmentBrokerError ? error.code : 'APPLICATION_START_FAILED';
      if (activeService !== undefined) activeService.state = 'failed';
      await this.cleanup(run, 'failed');
    }
  }

  private async cleanup(run: MutableApplicationRun, terminalState: 'stopped' | 'failed'): Promise<void> {
    run.state = 'stopping';
    const outcomes = await Promise.allSettled(run.services.toReversed().map(async (service) => {
      if (service.processId !== undefined) await this.options.processes.stopManaged(service.processId);
      service.state = terminalState === 'failed' && service.state === 'failed' ? 'failed' : 'stopped';
    }));
    run.state = outcomes.some((outcome) => outcome.status === 'rejected') ? 'failed_cleanup' : terminalState;
    if (run.state === 'failed_cleanup') run.errorCode = 'APPLICATION_CLEANUP_FAILED';
    run.terminalTimer = setTimeout(() => this.runs.delete(run.runId), TERMINAL_RETENTION_MS);
    run.terminalTimer.unref();
    this.options.onActivityChange?.();
  }

  async status(runId: string): Promise<ApplicationRunSummary> {
    const run = this.runs.get(runId);
    if (run === undefined) fail('APPLICATION_RUN_NOT_FOUND', 'La ejecución no existe.');
    return summary(run);
  }

  async stop(runId: string): Promise<ApplicationRunSummary> {
    const run = this.runs.get(runId);
    if (run === undefined) fail('APPLICATION_RUN_NOT_FOUND', 'La ejecución no existe.');
    if (['stopped', 'failed', 'failed_cleanup'].includes(run.state)) return summary(run);
    run.stopRequested = true;
    await run.launchPromise;
    if (!['stopped', 'failed', 'failed_cleanup'].includes(run.state)) await this.cleanup(run, 'stopped');
    return summary(run);
  }

  async resolveReadyRun(applicationId: string, runId: string): Promise<ResolvedApplicationRun> {
    return this.resolveReadyRunInternal(applicationId, runId, false);
  }

  /** Frontera exclusivamente local para probar una definición antes de aprobarla. */
  async resolveReadyRunForLocalReview(applicationId: string, runId: string): Promise<ResolvedApplicationRun> {
    return this.resolveReadyRunInternal(applicationId, runId, true);
  }

  private async resolveReadyRunInternal(applicationId: string, runId: string, allowNeedsReview: boolean): Promise<ResolvedApplicationRun> {
    const run = this.runs.get(runId);
    if (run === undefined || run.application.id !== applicationId || run.state !== 'ready') {
      fail('APPLICATION_RUN_NOT_FOUND', 'La ejecución no está lista o pertenece a otra aplicación.');
    }
    const { application } = await this.requireApplication(applicationId, allowNeedsReview);
    if (JSON.stringify(application) !== JSON.stringify(run.application)) {
      await this.stop(runId);
      fail('APPLICATION_REVIEW_REQUIRED', 'La aplicación cambió durante la ejecución.');
    }
    return {
      application,
      summary: summary(run),
      services: run.services.map((service) => ({
        service: service.definition.alias,
        workspaceId: service.definition.workspaceId,
        processId: service.processId!,
        listenerRef: service.listener!.listenerRef,
        listener: service.listener!,
      })),
    };
  }

  listAll(): readonly ApplicationRunSummary[] {
    return [...this.runs.values()].map(summary);
  }

  async reconcile(): Promise<void> {
    const active = [...this.runs.values()].filter((run) => ['starting', 'ready'].includes(run.state));
    await Promise.all(active.map(async (run) => {
      try {
        const { application } = await this.requireApplication(run.application.id);
        if (JSON.stringify(application) !== JSON.stringify(run.application)) await this.stop(run.runId);
      } catch {
        await this.stop(run.runId);
      }
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.values()].filter((run) => ['starting', 'ready', 'stopping'].includes(run.state)).map((run) => this.stop(run.runId)));
  }

  async close(): Promise<void> {
    await this.stopAll();
    for (const run of this.runs.values()) if (run.terminalTimer !== undefined) clearTimeout(run.terminalTimer);
  }
}
