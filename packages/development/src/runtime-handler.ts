import { DevelopmentBrokerError, type BrokerHandler } from './broker.js';
import type { ApplicationSupervisor } from './application-supervisor.js';
import type { ProcessSupervisor, ResolvedProcessListener } from './process-supervisor.js';
import type { TerminalSupervisor } from './terminal-supervisor.js';
import type { ResolvedTerminalListener } from './terminal-supervisor.js';
import { DEVELOPMENT_BROKER_PROTOCOL } from './protocol.js';
import type { AnalysisJobRequest, AnalysisJobSnapshot } from './analysis-job-supervisor.js';

export type BrowserCondition =
  | { readonly kind: 'path'; readonly value: string; readonly operator: 'equals' | 'contains' }
  | { readonly kind: 'title'; readonly value: string; readonly operator: 'equals' | 'contains' }
  | { readonly kind: 'text'; readonly value: string; readonly state: 'present' | 'absent' }
  | { readonly kind: 'element'; readonly snapshotId: string; readonly elementRef: string; readonly state: 'attached' | 'visible' | 'enabled' | 'checked' | 'selected'; readonly expected: boolean }
  | { readonly kind: 'response'; readonly path: string; readonly status?: number; readonly afterCursor: number }
  | { readonly kind: 'no-console-errors'; readonly afterCursor: number }
  | { readonly kind: 'dialog'; readonly state: 'open' | 'closed' };

export type WebWaitCondition =
  | { readonly kind: 'load' }
  | { readonly kind: 'url'; readonly value: string; readonly operator: 'equals' | 'contains' }
  | { readonly kind: 'title'; readonly value: string; readonly operator: 'equals' | 'contains' }
  | { readonly kind: 'text'; readonly value: string; readonly state: 'present' | 'absent' };

export interface BrowserApplicationListenerInput {
  readonly service: string;
  readonly processId: string;
  readonly listenerRef: string;
}

export interface MotionTrajectoryInput {
  readonly axis: 'y';
  readonly startY: number;
  readonly distancePx: number;
  readonly durationMs: number;
  readonly sampleCount: number;
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
  readonly analysis?: {
    start(request: AnalysisJobRequest): AnalysisJobSnapshot;
    list(workspaceId: string, cursor: number, limit: number): unknown;
    status(workspaceId: string, jobId: string, cursor: number, maxItems: number): unknown;
    cancel(workspaceId: string, jobId: string): AnalysisJobSnapshot;
  };
  readonly browser?: {
    start(workspaceId: string, profile: string, operationId?: string): Promise<unknown>;
    startFromProcess(workspaceId: string, listener: ResolvedProcessListener, operationId?: string): Promise<unknown>;
    startProjectFromTerminals(workspaceId: string, projectId: string, listeners: readonly ResolvedTerminalListener[], operationId?: string): Promise<unknown>;
    startApplication(workspaceId: string, application: string, listeners: readonly BrowserApplicationListenerInput[], operationId?: string): Promise<unknown>;
    list(workspaceId: string): Promise<unknown>;
    navigate(workspaceId: string, sessionId: string, path: string, operationId?: string): Promise<unknown>;
    snapshot(workspaceId: string, sessionId: string, maxDepth: number, maxElements: number): Promise<unknown>;
    screenshot(workspaceId: string, sessionId: string): Promise<unknown>;
    saveScreenshot(workspaceId: string, sessionId: string, path: string, operationId: string): Promise<unknown>;
    inspectMotion(workspaceId: string, sessionId: string, maxAnimations: number): Promise<unknown>;
    captureMotion(workspaceId: string, sessionId: string, path: string, trajectory: MotionTrajectoryInput, settleBeforeMs: number, captureMode: 'auto' | 'stepped' | 'screencast', operationId: string): Promise<unknown>;
    setViewport(workspaceId: string, sessionId: string, width: number, height: number, mobile: boolean, operationId?: string): Promise<unknown>;
    events(workspaceId: string, sessionId: string, cursor: number, maxBytes: number): Promise<unknown>;
    assert(workspaceId: string, sessionId: string, condition: BrowserCondition): Promise<unknown>;
    wait(workspaceId: string, sessionId: string, condition: BrowserCondition, timeoutMs: number): Promise<unknown>;
    click(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, operationId?: string): Promise<unknown>;
    fill(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, text: string, operationId?: string): Promise<unknown>;
    hover(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, operationId?: string): Promise<unknown>;
    press(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, key: string, operationId?: string): Promise<unknown>;
    scroll(workspaceId: string, sessionId: string, direction: 'up' | 'down' | 'left' | 'right', amount: number, operationId?: string): Promise<unknown>;
    select(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, value: string, operationId?: string): Promise<unknown>;
    drag(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, targetElementRef: string, operationId?: string): Promise<unknown>;
    dialog(workspaceId: string, sessionId: string, action: 'accept' | 'dismiss', operationId?: string): Promise<unknown>;
    requestHumanControl(workspaceId: string, sessionId: string, reason: 'sign_in' | 'file_selection' | 'manual_step', operationId: string): Promise<unknown>;
    humanControlStatus(workspaceId: string, sessionId: string): Promise<unknown>;
    stop(workspaceId: string, sessionId: string): Promise<unknown>;
    stopApplication?(applicationId: string): Promise<void>;
  };
  readonly web?: {
    profiles(): Promise<unknown>;
    start(webProfileId: string, operationId?: string): Promise<unknown>;
    list(): Promise<unknown>;
    stop(sessionId: string, operationId?: string): Promise<unknown>;
    tabs(sessionId: string): Promise<unknown>;
    open(sessionId: string, url: string, operationId?: string): Promise<unknown>;
    closeTab(sessionId: string, tabId: string, operationId?: string): Promise<unknown>;
    navigate(sessionId: string, tabId: string, url: string, operationId?: string): Promise<unknown>;
    back(sessionId: string, tabId: string, operationId?: string): Promise<unknown>;
    snapshot(sessionId: string, tabId: string, maxDepth: number, maxElements: number): Promise<unknown>;
    screenshot(sessionId: string, tabId: string): Promise<unknown>;
    saveScreenshot(sessionId: string, tabId: string, workspaceId: string, path: string, operationId: string): Promise<unknown>;
    inspectMotion(sessionId: string, tabId: string, maxAnimations: number): Promise<unknown>;
    captureMotion(sessionId: string, tabId: string, workspaceId: string, path: string, trajectory: MotionTrajectoryInput, settleBeforeMs: number, captureMode: 'auto' | 'stepped' | 'screencast', operationId: string): Promise<unknown>;
    extract(sessionId: string, tabId: string, maxChars: number): Promise<unknown>;
    assets(sessionId: string, tabId: string, maxAssets: number): Promise<unknown>;
    setViewport(sessionId: string, tabId: string, width: number, height: number, mobile: boolean, operationId?: string): Promise<unknown>;
    download(sessionId: string, tabId: string, resourceRef: string, workspaceId: string, path: string, operationId: string): Promise<unknown>;
    click(sessionId: string, tabId: string, snapshotId: string, elementRef: string, operationId?: string): Promise<unknown>;
    fill(sessionId: string, tabId: string, snapshotId: string, elementRef: string, text: string, operationId?: string): Promise<unknown>;
    select(sessionId: string, tabId: string, snapshotId: string, elementRef: string, value: string, operationId?: string): Promise<unknown>;
    scroll(sessionId: string, tabId: string, direction: 'up' | 'down' | 'left' | 'right', amount: number, operationId?: string): Promise<unknown>;
    press(sessionId: string, tabId: string, snapshotId: string, elementRef: string, key: string, operationId?: string): Promise<unknown>;
    wait(sessionId: string, tabId: string, condition: WebWaitCondition, timeoutMs: number): Promise<unknown>;
    requestHumanControl(sessionId: string, reason: 'sign_in' | 'file_selection' | 'manual_step', operationId: string): Promise<unknown>;
    humanControlStatus(sessionId: string): Promise<unknown>;
  };
}

export function createDevelopmentRuntimeHandler(options: DevelopmentRuntimeHandlerOptions): BrokerHandler {
  return async ({ method, params }) => {
    const input = params as Record<string, unknown>;
    const workspaceId = String(input['workspaceId'] ?? '');
    switch (method) {
      case 'broker.ping':
        return { ready: true, protocol: DEVELOPMENT_BROKER_PROTOCOL };
      case 'project.list':
        if (options.projects === undefined) break;
        return options.projects.list();
      case 'project.setup.status':
        if (options.projects === undefined) break;
        return options.projects.status(String(input['projectId']));
      case 'project.setup.refresh':
        if (options.projects === undefined) break;
        return options.projects.refresh(String(input['projectId']));
      case 'analysis.start':
        if (options.analysis === undefined) break;
        return options.analysis.start(params as AnalysisJobRequest);
      case 'analysis.list':
        if (options.analysis === undefined) break;
        return options.analysis.list(workspaceId, Number(input['cursor']), Number(input['limit']));
      case 'analysis.status':
        if (options.analysis === undefined) break;
        return options.analysis.status(workspaceId, String(input['jobId']), Number(input['cursor']), Number(input['maxItems']));
      case 'analysis.cancel':
        if (options.analysis === undefined) break;
        return options.analysis.cancel(workspaceId, String(input['jobId']));
      case 'terminal.start':
        if (options.terminals === undefined) break;
        return options.terminals.start(String(input['projectId']), input['operationId'] as string | undefined);
      case 'terminal.list':
        if (options.terminals === undefined) break;
        return options.terminals.list(String(input['projectId']));
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
        return options.browser.navigate(workspaceId, String(input['sessionId']), String(input['path']), input['operationId'] as string | undefined);
      case 'browser.snapshot':
        if (options.browser === undefined) break;
        return options.browser.snapshot(workspaceId, String(input['sessionId']), Number(input['maxDepth']), Number(input['maxElements']));
      case 'browser.screenshot':
        if (options.browser === undefined) break;
        return options.browser.screenshot(workspaceId, String(input['sessionId']));
      case 'browser.screenshot.save':
        if (options.browser === undefined) break;
        return options.browser.saveScreenshot(workspaceId, String(input['sessionId']), String(input['path']), String(input['operationId']));
      case 'browser.motion.inspect':
        if (options.browser === undefined) break;
        return options.browser.inspectMotion(workspaceId, String(input['sessionId']), Number(input['maxAnimations']));
      case 'browser.motion.capture':
        if (options.browser === undefined) break;
        return options.browser.captureMotion(
          workspaceId,
          String(input['sessionId']),
          String(input['path']),
          input['trajectory'] as MotionTrajectoryInput,
          Number(input['settleBeforeMs']),
          input['captureMode'] as 'auto' | 'stepped' | 'screencast',
          String(input['operationId']),
        );
      case 'browser.viewport':
        if (options.browser === undefined) break;
        return options.browser.setViewport(
          workspaceId,
          String(input['sessionId']),
          Number(input['width']),
          Number(input['height']),
          input['mobile'] === true,
          input['operationId'] as string | undefined,
        );
      case 'browser.events':
        if (options.browser === undefined) break;
        return options.browser.events(workspaceId, String(input['sessionId']), Number(input['cursor']), Number(input['maxBytes']));
      case 'browser.assert':
        if (options.browser === undefined) break;
        return options.browser.assert(workspaceId, String(input['sessionId']), input['condition'] as BrowserCondition);
      case 'browser.wait':
        if (options.browser === undefined) break;
        return options.browser.wait(workspaceId, String(input['sessionId']), input['condition'] as BrowserCondition, Number(input['timeoutMs']));
      case 'browser.click':
        if (options.browser === undefined) break;
        return options.browser.click(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), input['operationId'] as string | undefined);
      case 'browser.fill':
        if (options.browser === undefined) break;
        return options.browser.fill(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), String(input['text']), input['operationId'] as string | undefined);
      case 'browser.hover':
        if (options.browser === undefined) break;
        return options.browser.hover(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), input['operationId'] as string | undefined);
      case 'browser.press':
        if (options.browser === undefined) break;
        return options.browser.press(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), String(input['key']), input['operationId'] as string | undefined);
      case 'browser.scroll':
        if (options.browser === undefined) break;
        return options.browser.scroll(workspaceId, String(input['sessionId']), input['direction'] as 'up' | 'down' | 'left' | 'right', Number(input['amount']), input['operationId'] as string | undefined);
      case 'browser.select':
        if (options.browser === undefined) break;
        return options.browser.select(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), String(input['value']), input['operationId'] as string | undefined);
      case 'browser.drag':
        if (options.browser === undefined) break;
        return options.browser.drag(workspaceId, String(input['sessionId']), String(input['snapshotId']), String(input['elementRef']), String(input['targetElementRef']), input['operationId'] as string | undefined);
      case 'browser.dialog':
        if (options.browser === undefined) break;
        return options.browser.dialog(workspaceId, String(input['sessionId']), input['action'] as 'accept' | 'dismiss', input['operationId'] as string | undefined);
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
      case 'web.profiles':
        if (options.web === undefined) break;
        return options.web.profiles();
      case 'web.start':
        if (options.web === undefined) break;
        return options.web.start(String(input['webProfileId']), input['operationId'] as string | undefined);
      case 'web.list':
        if (options.web === undefined) break;
        return options.web.list();
      case 'web.stop':
        if (options.web === undefined) break;
        return options.web.stop(String(input['sessionId']), input['operationId'] as string | undefined);
      case 'web.tabs':
        if (options.web === undefined) break;
        return options.web.tabs(String(input['sessionId']));
      case 'web.open':
        if (options.web === undefined) break;
        return options.web.open(String(input['sessionId']), String(input['url']), input['operationId'] as string | undefined);
      case 'web.close':
        if (options.web === undefined) break;
        return options.web.closeTab(String(input['sessionId']), String(input['tabId']), input['operationId'] as string | undefined);
      case 'web.navigate':
        if (options.web === undefined) break;
        return options.web.navigate(String(input['sessionId']), String(input['tabId']), String(input['url']), input['operationId'] as string | undefined);
      case 'web.back':
        if (options.web === undefined) break;
        return options.web.back(String(input['sessionId']), String(input['tabId']), input['operationId'] as string | undefined);
      case 'web.snapshot':
        if (options.web === undefined) break;
        return options.web.snapshot(String(input['sessionId']), String(input['tabId']), Number(input['maxDepth']), Number(input['maxElements']));
      case 'web.screenshot':
        if (options.web === undefined) break;
        return options.web.screenshot(String(input['sessionId']), String(input['tabId']));
      case 'web.screenshot.save':
        if (options.web === undefined) break;
        return options.web.saveScreenshot(String(input['sessionId']), String(input['tabId']), String(input['workspaceId']), String(input['path']), String(input['operationId']));
      case 'web.motion.inspect':
        if (options.web === undefined) break;
        return options.web.inspectMotion(String(input['sessionId']), String(input['tabId']), Number(input['maxAnimations']));
      case 'web.motion.capture':
        if (options.web === undefined) break;
        return options.web.captureMotion(
          String(input['sessionId']),
          String(input['tabId']),
          String(input['workspaceId']),
          String(input['path']),
          input['trajectory'] as MotionTrajectoryInput,
          Number(input['settleBeforeMs']),
          input['captureMode'] as 'auto' | 'stepped' | 'screencast',
          String(input['operationId']),
        );
      case 'web.extract':
        if (options.web === undefined) break;
        return options.web.extract(String(input['sessionId']), String(input['tabId']), Number(input['maxChars']));
      case 'web.assets':
        if (options.web === undefined) break;
        return options.web.assets(String(input['sessionId']), String(input['tabId']), Number(input['maxAssets']));
      case 'web.viewport':
        if (options.web === undefined) break;
        return options.web.setViewport(String(input['sessionId']), String(input['tabId']), Number(input['width']), Number(input['height']), Boolean(input['mobile']), input['operationId'] as string | undefined);
      case 'web.download':
        if (options.web === undefined) break;
        return options.web.download(String(input['sessionId']), String(input['tabId']), String(input['resourceRef']), String(input['workspaceId']), String(input['path']), String(input['operationId']));
      case 'web.click':
        if (options.web === undefined) break;
        return options.web.click(String(input['sessionId']), String(input['tabId']), String(input['snapshotId']), String(input['elementRef']), input['operationId'] as string | undefined);
      case 'web.fill':
        if (options.web === undefined) break;
        return options.web.fill(String(input['sessionId']), String(input['tabId']), String(input['snapshotId']), String(input['elementRef']), String(input['text']), input['operationId'] as string | undefined);
      case 'web.select':
        if (options.web === undefined) break;
        return options.web.select(String(input['sessionId']), String(input['tabId']), String(input['snapshotId']), String(input['elementRef']), String(input['value']), input['operationId'] as string | undefined);
      case 'web.scroll':
        if (options.web === undefined) break;
        return options.web.scroll(String(input['sessionId']), String(input['tabId']), input['direction'] as 'up' | 'down' | 'left' | 'right', Number(input['amount']), input['operationId'] as string | undefined);
      case 'web.press':
        if (options.web === undefined) break;
        return options.web.press(String(input['sessionId']), String(input['tabId']), String(input['snapshotId']), String(input['elementRef']), String(input['key']), input['operationId'] as string | undefined);
      case 'web.wait':
        if (options.web === undefined) break;
        return options.web.wait(String(input['sessionId']), String(input['tabId']), input['condition'] as WebWaitCondition, Number(input['timeoutMs']));
      case 'web.human.request':
        if (options.web === undefined) break;
        return options.web.requestHumanControl(String(input['sessionId']), input['reason'] as 'sign_in' | 'file_selection' | 'manual_step', String(input['operationId']));
      case 'web.human.status':
        if (options.web === undefined) break;
        return options.web.humanControlStatus(String(input['sessionId']));
      default:
        break;
    }
    throw new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'La capacidad todavía no está disponible.');
  };
}
