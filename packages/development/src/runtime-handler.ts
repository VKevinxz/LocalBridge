import { DevelopmentBrokerError, type BrokerHandler } from './broker.js';
import type { ApplicationSupervisor } from './application-supervisor.js';
import type { ProcessSupervisor, ResolvedProcessListener } from './process-supervisor.js';
import type { TerminalSupervisor } from './terminal-supervisor.js';
import type { ResolvedTerminalListener } from './terminal-supervisor.js';

export interface BrowserApplicationListenerInput {
  readonly service: string;
  readonly processId: string;
  readonly listenerRef: string;
}

export interface DevelopmentRuntimeHandlerOptions {
  readonly processes: ProcessSupervisor;
  readonly terminals?: TerminalSupervisor;
  readonly applications?: ApplicationSupervisor;
  readonly projects?: {
    list(): Promise<unknown>;
    status(projectId: string): Promise<unknown>;
    refresh(projectId: string): Promise<unknown>;
  };
  readonly browser?: {
    start(workspaceId: string, profile: string, operationId?: string): Promise<unknown>;
    startFromProcess(workspaceId: string, listener: ResolvedProcessListener, operationId?: string): Promise<unknown>;
    startProjectFromTerminals(workspaceId: string, projectId: string, listeners: readonly ResolvedTerminalListener[], operationId?: string): Promise<unknown>;
    startApplication(workspaceId: string, application: string, listeners: readonly BrowserApplicationListenerInput[], operationId?: string): Promise<unknown>;
    list(workspaceId: string): Promise<unknown>;
    navigate(workspaceId: string, sessionId: string, path: string): Promise<unknown>;
    snapshot(workspaceId: string, sessionId: string, maxDepth: number, maxElements: number): Promise<unknown>;
    screenshot(workspaceId: string, sessionId: string): Promise<unknown>;
    events(workspaceId: string, sessionId: string, cursor: number, maxBytes: number): Promise<unknown>;
    click(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, operationId?: string): Promise<unknown>;
    fill(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, text: string, operationId?: string): Promise<unknown>;
    press(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, key: string, operationId?: string): Promise<unknown>;
    requestHumanControl(workspaceId: string, sessionId: string, reason: 'sign_in' | 'file_selection' | 'manual_step', operationId: string): Promise<unknown>;
    humanControlStatus(workspaceId: string, sessionId: string): Promise<unknown>;
    stop(workspaceId: string, sessionId: string): Promise<unknown>;
    stopApplication?(applicationId: string): Promise<void>;
  };
}

export function createDevelopmentRuntimeHandler(options: DevelopmentRuntimeHandlerOptions): BrokerHandler {
  return async ({ method, params }) => {
    const input = params as Record<string, unknown>;
    const workspaceId = String(input['workspaceId'] ?? '');
    switch (method) {
      case 'broker.ping':
        return { ready: true, protocol: 9 };
      case 'project.list':
        if (options.projects === undefined) break;
        return options.projects.list();
      case 'project.setup.status':
        if (options.projects === undefined) break;
        return options.projects.status(String(input['projectId']));
      case 'project.setup.refresh':
        if (options.projects === undefined) break;
        return options.projects.refresh(String(input['projectId']));
      case 'terminal.start':
        if (options.terminals === undefined) break;
        return options.terminals.start(String(input['projectId']), input['operationId'] as string | undefined);
      case 'terminal.write':
        if (options.terminals === undefined) break;
        return options.terminals.write(String(input['projectId']), String(input['sessionId']), String(input['text']), input['operationId'] as string | undefined);
      case 'terminal.read':
        if (options.terminals === undefined) break;
        return options.terminals.read(String(input['projectId']), String(input['sessionId']), Number(input['cursor']), Number(input['maxBytes']));
      case 'terminal.status':
        if (options.terminals === undefined) break;
        return options.terminals.status(String(input['projectId']), String(input['sessionId']));
      case 'terminal.stop':
        if (options.terminals === undefined) break;
        return options.terminals.stop(String(input['projectId']), String(input['sessionId']));
      case 'application.start':
        if (options.applications === undefined) break;
        return options.applications.start(String(input['applicationId']), input['operationId'] as string | undefined);
      case 'application.status':
        if (options.applications === undefined) break;
        return options.applications.status(String(input['runId']));
      case 'application.stop':
        if (options.applications === undefined) break;
        await options.browser?.stopApplication?.((await options.applications.status(String(input['runId']))).applicationId);
        return options.applications.stop(String(input['runId']));
      case 'process.start':
        return options.processes.start(workspaceId, String(input['profile']), input['operationId'] as string | undefined);
      case 'process.list':
        return options.processes.list(workspaceId);
      case 'process.listeners':
        return options.processes.listeners(workspaceId, String(input['processId']));
      case 'process.logs':
        return options.processes.logs(workspaceId, String(input['processId']), Number(input['cursor']), Number(input['maxBytes']));
      case 'process.stop':
        return options.processes.stop(workspaceId, String(input['processId']));
      case 'browser.start':
        if (options.browser === undefined) break;
        if (typeof input['projectId'] === 'string' && typeof input['terminalSessionId'] === 'string') {
          if (options.terminals === undefined) break;
          const related = (input['relatedListeners'] as Array<{ terminalSessionId: string; listenerRef: string }> | undefined) ?? [];
          const listeners = await options.terminals.resolveListeners(
            String(input['projectId']),
            [
              { terminalSessionId: String(input['terminalSessionId']), listenerRef: String(input['listenerRef']) },
              ...related,
            ],
            workspaceId,
          );
          return options.browser.startProjectFromTerminals(
            workspaceId,
            String(input['projectId']),
            listeners,
            input['operationId'] as string | undefined,
          );
        }
        if (input['runId'] !== undefined && input['applicationId'] !== undefined) {
          if (options.applications === undefined) break;
          const resolved = await options.applications.resolveReadyRun(String(input['applicationId']), String(input['runId']));
          return options.browser.startApplication(
            workspaceId,
            resolved.application.id,
            resolved.services.map((service) => ({
              service: service.service,
              processId: service.processId,
              listenerRef: service.listenerRef,
            })),
            input['operationId'] as string | undefined,
          );
        }
        if (typeof input['profile'] === 'string') {
          return options.browser.start(workspaceId, input['profile'], input['operationId'] as string | undefined);
        }
        if (typeof input['application'] === 'string') {
          return options.browser.startApplication(
            workspaceId,
            input['application'],
            input['listeners'] as BrowserApplicationListenerInput[],
            input['operationId'] as string | undefined,
          );
        }
        return options.browser.startFromProcess(
          workspaceId,
          await options.processes.resolveListener(workspaceId, String(input['processId']), String(input['listenerRef'])),
          input['operationId'] as string | undefined,
        );
      case 'browser.list':
        if (options.browser === undefined) break;
        return options.browser.list(workspaceId);
      case 'browser.navigate':
        if (options.browser === undefined) break;
        return options.browser.navigate(workspaceId, String(input['sessionId']), String(input['path']));
      case 'browser.snapshot':
        if (options.browser === undefined) break;
        return options.browser.snapshot(workspaceId, String(input['sessionId']), Number(input['maxDepth']), Number(input['maxElements']));
      case 'browser.screenshot':
        if (options.browser === undefined) break;
        return options.browser.screenshot(workspaceId, String(input['sessionId']));
      case 'browser.events':
        if (options.browser === undefined) break;
        return options.browser.events(workspaceId, String(input['sessionId']), Number(input['cursor']), Number(input['maxBytes']));
      case 'browser.click':
        if (options.browser === undefined) break;
        return options.browser.click(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), input['operationId'] as string | undefined);
      case 'browser.fill':
        if (options.browser === undefined) break;
        return options.browser.fill(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), String(input['text']), input['operationId'] as string | undefined);
      case 'browser.press':
        if (options.browser === undefined) break;
        return options.browser.press(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), String(input['key']), input['operationId'] as string | undefined);
      case 'browser.human.request':
        if (options.browser === undefined) break;
        return options.browser.requestHumanControl(
          workspaceId,
          String(input['sessionId']),
          input['reason'] as 'sign_in' | 'file_selection' | 'manual_step',
          String(input['operationId']),
        );
      case 'browser.human.status':
        if (options.browser === undefined) break;
        return options.browser.humanControlStatus(workspaceId, String(input['sessionId']));
      case 'browser.stop':
        if (options.browser === undefined) break;
        return options.browser.stop(workspaceId, String(input['sessionId']));
      default:
        break;
    }
    throw new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'La capacidad todavía no está disponible.');
  };
}
