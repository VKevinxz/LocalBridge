import { randomBytes } from 'node:crypto';

import { BrowserWindow, WebContentsView, type Session, type WebContents } from 'electron';

import {
  DevelopmentBrokerError,
  type BrowserApplicationListenerInput,
  type ResolvedProcessListener,
  type ResolvedTerminalListener,
} from '@localbridge/development';
import type { AuthorizedWorkspace, BrowserProfile, LocalApplication } from '@localbridge/workspace';

import { isAllowedBrowserRequest } from './browser-network-policy.js';

const MAX_SESSIONS = 4;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_INTERACTION_OPERATIONS = 2_048;
const INTERACTION_SETTLE_MS = 100;
const HUMAN_REQUEST_TTL_MS = 5 * 60_000;
const POST_HUMAN_SESSION_TTL_MS = 30 * 60_000;
const HUMAN_CONTROL_TTL_MS = 15 * 60_000;
const MAX_VIEWER_FRAME_BYTES = 16 * 1024 * 1024;
const TERMINAL_SESSION_TTL_MS = 5 * 60_000;
const AUTH_TOOLBAR_HEIGHT = 112;
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

interface BrowserEventEntry {
  readonly cursor: number;
  readonly type: 'console' | 'network' | 'error';
  readonly level: string;
  readonly message: string;
  readonly path?: string;
}

interface ElementBinding {
  readonly backendNodeId: number;
  readonly role: string;
}

interface SnapshotBinding {
  readonly snapshotId: string;
  readonly generation: number;
  readonly elements: ReadonlyMap<string, ElementBinding>;
}

interface ListenerAuthority {
  readonly service: string;
  readonly workspaceId: string;
  readonly processId: string;
  readonly listenerRef: string;
  readonly origin: string;
  readonly projectId?: string;
  readonly expected: ResolvedProcessListener | ResolvedTerminalListener;
}

interface ManagedBrowserSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly profileName: string;
  readonly profile: BrowserProfile;
  readonly window: BrowserWindow;
  readonly content: WebContentsView;
  readonly browserSession: Session;
  readonly workspaceName: string;
  readonly startedAt: number;
  readonly events: BrowserEventEntry[];
  readonly listenerBindings?: readonly ListenerAuthority[];
  readonly application?: {
    readonly id: string;
    readonly name: string;
    readonly profile: LocalApplication;
    readonly localReview?: boolean;
  };
  state: 'running' | 'stopped';
  generation: number;
  snapshot?: SnapshotBinding;
  eventBytes: number;
  nextEventCursor: number;
  controlState: BrowserControlState;
  humanRequestId?: string;
  humanReason?: BrowserHumanReason;
  humanResultState?: 'ready' | 'declined' | 'expired' | 'stopped';
  controlExpiresAt?: number;
  postHumanExpiresAt?: number;
  controlTimer?: NodeJS.Timeout;
  terminalTimer?: NodeJS.Timeout;
  stopPromise?: Promise<void>;
  debuggerListenerInstalled: boolean;
  controlEpoch: number;
  activeAgentOperations: number;
  blockedFileChooserCount: number;
  viewerCapturePromise?: Promise<BrowserViewerFrame>;
  restoreLiveViewerAfterHuman?: boolean;
  previousViewerWorkArea?: LiveViewerWorkArea;
  readonly agentIdleWaiters: Array<() => void>;
  readonly agentShellUrl: string;
  trustedShellUrl: string;
}

export type BrowserHumanReason = 'sign_in' | 'file_selection' | 'manual_step';

export interface LiveViewerWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BrowserControlState =
  | 'agent_control'
  | 'waiting_for_human'
  | 'human_control'
  | 'returning_to_agent'
  | 'declined'
  | 'expired'
  | 'stopped';

export interface BrowserSessionSummary {
  readonly sessionId: string;
  readonly profile: string;
  readonly state: 'running' | 'stopped';
  readonly title: string;
  readonly path: string;
  readonly startedAt: string;
  readonly controlState: BrowserControlState;
  readonly controlExpiresAt?: string;
  readonly postHumanExpiresAt?: string;
  readonly humanReason?: BrowserHumanReason;
}

export interface BrowserHumanControlStatus {
  readonly requestId: string;
  readonly reason: BrowserHumanReason;
  readonly state: 'waiting_for_human' | 'human_control' | 'ready' | 'declined' | 'expired' | 'stopped';
  readonly expiresAt?: string;
  readonly retryAfterMs?: number;
}

export type BrowserViewerFrame =
  | { readonly state: 'ready'; readonly sessionId: string; readonly dataUrl: string; readonly width: number; readonly height: number; readonly path: string; readonly capturedAt: string }
  | { readonly state: 'private'; readonly sessionId: string; readonly path: string }
  | { readonly state: 'stopped'; readonly sessionId: string; readonly path: '/' };

export interface BrowserControllerOptions {
  readonly loadWorkspace: (workspaceId: string) => Promise<AuthorizedWorkspace | undefined>;
  readonly loadApplication: (applicationIdOrName: string) => Promise<LocalApplication | undefined>;
  readonly resolveProcessListener?: (
    workspaceId: string,
    processId: string,
    listenerRef: string,
  ) => Promise<ResolvedProcessListener>;
  readonly resolveTerminalListener?: (
    projectId: string,
    terminalSessionId: string,
    listenerRef: string,
    workspaceId: string,
  ) => Promise<ResolvedTerminalListener>;
  readonly reconciliationIntervalMs?: number;
  readonly onHumanControlRequest?: (session: BrowserSessionSummary & { workspaceId: string }) => void;
  readonly onActivityChange?: () => void;
  readonly confirmHumanControlHandoff?: (workspaceName: string) => Promise<boolean>;
  readonly onHumanControlTransition?: (event: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly reason?: BrowserHumanReason;
    readonly action: 'browser.human.request' | 'browser.human.open' | 'browser.human.handoff' | 'browser.human.decline' | 'browser.human.expire' | 'browser.human.revoke';
    readonly decision: 'allow' | 'deny';
    readonly outcome: 'success' | 'error';
    readonly errorCode?: string;
  }) => void;
  readonly onSecurityDiagnostic?: (message: string) => void;
}

function fail(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

function isResolvedTerminalListener(
  listener: ResolvedProcessListener | ResolvedTerminalListener,
): listener is ResolvedTerminalListener {
  return 'browserOrigin' in listener && typeof listener.browserOrigin === 'string' &&
    'projectId' in listener && typeof listener.projectId === 'string';
}

function safePathFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.slice(0, 2048);
  } catch {
    return '/';
  }
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function summary(entry: ManagedBrowserSession): BrowserSessionSummary {
  return {
    sessionId: entry.sessionId,
    profile: entry.profileName,
    state: entry.state,
    title: entry.window.isDestroyed() || entry.content.webContents.isDestroyed() ? '' : entry.content.webContents.getTitle().slice(0, 256),
    path: entry.window.isDestroyed() || entry.content.webContents.isDestroyed() ? '/' : safePathFromUrl(entry.content.webContents.getURL()),
    startedAt: new Date(entry.startedAt).toISOString(),
    controlState: entry.controlState,
    ...(entry.controlExpiresAt === undefined ? {} : { controlExpiresAt: new Date(entry.controlExpiresAt).toISOString() }),
    ...(entry.postHumanExpiresAt === undefined ? {} : { postHumanExpiresAt: new Date(entry.postHumanExpiresAt).toISOString() }),
    ...(entry.humanReason === undefined ? {} : { humanReason: entry.humanReason }),
  };
}

function humanControlStatus(entry: ManagedBrowserSession): BrowserHumanControlStatus {
  if (entry.humanRequestId === undefined || entry.humanReason === undefined) {
    fail('HUMAN_CONTROL_REQUEST_NOT_FOUND', 'La sesión no tiene una solicitud de control humano.');
  }
  const activeState = entry.controlState === 'returning_to_agent' ? 'human_control' : entry.controlState;
  const state = entry.humanResultState ?? activeState;
  if (state === 'agent_control') fail('HUMAN_CONTROL_REQUEST_NOT_FOUND', 'La sesión no tiene una solicitud de control humano activa.');
  return {
    requestId: entry.humanRequestId,
    reason: entry.humanReason,
    state: state as BrowserHumanControlStatus['state'],
    ...(entry.controlExpiresAt === undefined || entry.humanResultState !== undefined ? {} : { expiresAt: new Date(entry.controlExpiresAt).toISOString() }),
    ...(['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState) && entry.humanResultState === undefined ? { retryAfterMs: 1_000 } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function controlShellHtml(
  workspaceName: string,
  origin: string,
  reason: BrowserHumanReason,
  expiresAt?: number,
): string {
  const title = 'Tú controlas · ChatGPT está pausado';
  const reasonLabel = reason === 'sign_in' ? 'inicio de sesión' : reason === 'file_selection' ? 'selección de archivo' : 'paso manual';
  const notice = `Completa el ${reasonLabel} necesario. ChatGPT no puede observar ni interactuar mientras tienes el control.`;
  const safeExpiry = Number.isFinite(expiresAt) ? Math.max(0, Math.floor(expiresAt ?? 0)) : 0;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>${title} — LocalBridge</title><style>body{margin:0;font:14px system-ui;background:#10243e;color:#fff}.bar{height:${AUTH_TOOLBAR_HEIGHT}px;box-sizing:border-box;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:20px}.title{font-weight:700;font-size:16px}.meta{color:#c7d7e9;margin-top:5px}.notice{color:#ffd18c;margin-top:5px}.actions{display:flex;gap:10px;white-space:nowrap}a{padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:700}a.cancel{color:#fff;border:1px solid #789}a.handoff{color:#08233a;background:#55d6be}a[aria-disabled=true]{pointer-events:none;opacity:.55}</style></head><body><div class="bar"><div><div class="title">${title} — ${escapeHtml(workspaceName)}</div><div class="meta">${escapeHtml(origin)} · <span id="remaining">Tiempo limitado</span></div><div class="notice" id="status" aria-live="polite">${notice}</div></div><div class="actions"><a class="cancel" href="localbridge-control-action://cancel">Cancelar y destruir</a><a class="handoff" href="localbridge-control-action://handoff">Terminé — devolver a ChatGPT</a></div></div><script>(()=>{const expiry=${safeExpiry};const remaining=document.querySelector('#remaining');const update=()=>{if(!expiry){remaining.textContent='Tiempo limitado';return}const seconds=Math.max(0,Math.ceil((expiry-Date.now())/1000));const minutes=Math.floor(seconds/60);remaining.textContent='Vence en '+minutes+':'+String(seconds%60).padStart(2,'0')};update();setInterval(update,1000);for(const action of document.querySelectorAll('a'))action.addEventListener('click',()=>{for(const link of document.querySelectorAll('a'))link.setAttribute('aria-disabled','true');document.querySelector('#status').textContent='Procesando de forma segura…'})})()</script></body></html>`;
}

function agentShellHtml(workspaceName: string, origin: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Vista en vivo — LocalBridge</title><style>body{margin:0;font:14px system-ui;background:#10243e;color:#fff}.bar{height:${AUTH_TOOLBAR_HEIGHT}px;box-sizing:border-box;padding:17px 20px;display:flex;align-items:center;justify-content:space-between;gap:20px}.title{font-weight:800;font-size:17px}.meta{color:#c7d7e9;margin-top:6px}.badge{padding:9px 12px;border:1px solid #55d6be;border-radius:999px;color:#8ff1df;font-weight:800}.notice{color:#ffd18c;margin-top:6px}</style></head><body><div class="bar"><div><div class="title">Vista en vivo · solo lectura — ${escapeHtml(workspaceName)}</div><div class="meta">${escapeHtml(origin)}</div><div class="notice">ChatGPT controla esta sesión. Oculta la ventana desde Actividad en LocalBridge.</div></div><div class="badge">Sin ratón ni teclado</div></div></body></html>`;
}

function sameProfile(left: BrowserProfile, right: BrowserProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameApplication(left: LocalApplication, right: LocalApplication): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameListenerBindings(
  left: ManagedBrowserSession['listenerBindings'],
  right: ManagedBrowserSession['listenerBindings'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left.map(({ service, workspaceId, processId, listenerRef, origin }) => ({
    service, workspaceId, processId, listenerRef, origin,
  }))) === JSON.stringify(right.map(({ service, workspaceId, processId, listenerRef, origin }) => ({
    service, workspaceId, processId, listenerRef, origin,
  })));
}

async function waitForInteractionToSettle(): Promise<void> {
  // CDP confirma que el evento fue entregado, no que los handlers y el render
  // derivados ya terminaron. Esperar un turno corto evita devolver un snapshot
  // anterior a la acción sin ejecutar JavaScript dentro de la página.
  await new Promise((resolve) => setTimeout(resolve, INTERACTION_SETTLE_MS));
}

export class BrowserController {
  private readonly entries = new Map<string, ManagedBrowserSession>();
  private readonly operations = new Map<string, string>();
  private readonly humanControlOperations = new Map<string, string>();
  private readonly interactionOperations = new Map<string, { sessionId: string; applied: true; snapshotInvalidated: true }>();
  private readonly reconciliationTimer: NodeJS.Timeout;
  private humanSessionId: string | undefined;
  private liveViewerSessionId: string | undefined;

  constructor(private readonly options: BrowserControllerOptions) {
    this.reconciliationTimer = setInterval(() => { void this.reconcile(); }, options.reconciliationIntervalMs ?? 2_000);
    this.reconciliationTimer.unref();
  }

  private hideLiveViewerEntry(entry: ManagedBrowserSession, notify = true): void {
    if (this.liveViewerSessionId !== entry.sessionId) return;
    this.liveViewerSessionId = undefined;
    if (!entry.window.isDestroyed()) {
      entry.window.setIgnoreMouseEvents(true);
      entry.window.setFocusable(false);
      entry.window.setSkipTaskbar(true);
      entry.window.setTitle('Navegador aislado — LocalBridge');
      entry.window.setPosition(-10_000, -10_000, false);
      entry.window.showInactive();
    }
    if (notify) this.options.onActivityChange?.();
  }

  private async restoreAgentShell(entry: ManagedBrowserSession): Promise<void> {
    entry.trustedShellUrl = entry.agentShellUrl;
    if (entry.window.webContents.getURL() !== entry.agentShellUrl) await entry.window.loadURL(entry.agentShellUrl);
  }

  getLocalLiveViewerSessionId(): string | undefined {
    const sessionId = this.liveViewerSessionId;
    if (sessionId === undefined) return undefined;
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running' || entry.window.isDestroyed() || entry.controlState !== 'agent_control') {
      this.liveViewerSessionId = undefined;
      return undefined;
    }
    return sessionId;
  }

  getLocalLiveViewerWindowBounds(): LiveViewerWorkArea | undefined {
    const sessionId = this.getLocalLiveViewerSessionId();
    if (sessionId === undefined) return undefined;
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.window.isDestroyed()) return undefined;
    return entry.window.getBounds();
  }

  private positionLiveViewer(entry: ManagedBrowserSession, workArea: LiveViewerWorkArea): void {
    const values = [workArea.x, workArea.y, workArea.width, workArea.height];
    if (!values.every(Number.isSafeInteger) || workArea.width < 1 || workArea.height < 1) {
      fail('INVALID_INPUT', 'El área de pantalla no es válida.');
    }
    const { width: windowWidth, height: windowHeight } = entry.window.getBounds();
    const x = workArea.x + Math.max(0, Math.floor((workArea.width - windowWidth) / 2));
    const y = workArea.y + Math.max(0, Math.floor((workArea.height - windowHeight) / 2));
    entry.window.setPosition(x, y, false);
  }

  async showLiveViewerLocally(sessionId: string, workArea: LiveViewerWorkArea): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview === true || entry.state !== 'running' || entry.window.isDestroyed()) {
      fail('SESSION_NOT_FOUND', 'La sesión de navegador no existe.');
    }
    await this.requireWorkspace(entry.workspaceId);
    this.ensureAgentControl(entry);
    if (this.liveViewerSessionId !== undefined && this.liveViewerSessionId !== sessionId) {
      const previous = this.entries.get(this.liveViewerSessionId);
      if (previous !== undefined) this.hideLiveViewerEntry(previous, false);
      else this.liveViewerSessionId = undefined;
    }
    await this.restoreAgentShell(entry);
    entry.window.setIgnoreMouseEvents(true);
    entry.window.setFocusable(false);
    entry.window.setSkipTaskbar(false);
    entry.window.setTitle('Vista en vivo — LocalBridge');
    this.positionLiveViewer(entry, workArea);
    entry.window.showInactive();
    this.liveViewerSessionId = sessionId;
    this.options.onActivityChange?.();
  }

  async hideLiveViewerLocally(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview === true || entry.state !== 'running') {
      if (this.liveViewerSessionId === sessionId) this.liveViewerSessionId = undefined;
      return;
    }
    this.hideLiveViewerEntry(entry);
  }

  async moveLiveViewerLocally(sessionId: string, workArea: LiveViewerWorkArea): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running' || entry.window.isDestroyed() || this.liveViewerSessionId !== sessionId) {
      fail('SESSION_NOT_FOUND', 'La ventana en vivo no está abierta para esta sesión.');
    }
    await this.requireWorkspace(entry.workspaceId);
    this.ensureAgentControl(entry);
    entry.window.setIgnoreMouseEvents(true);
    entry.window.setFocusable(false);
    this.positionLiveViewer(entry, workArea);
    entry.window.showInactive();
    this.options.onActivityChange?.();
  }

  private async requireWorkspace(workspaceId: string, interaction = false): Promise<AuthorizedWorkspace> {
    const workspace = await this.options.loadWorkspace(workspaceId);
    if (workspace === undefined) fail('WORKSPACE_NOT_FOUND', 'El workspace no existe o no está autorizado.');
    if (!workspace.enabled) fail('WORKSPACE_DISABLED', 'El workspace está deshabilitado.');
    if (workspace.permissions.browserRead !== true) fail('CAPABILITY_DISABLED', 'El permiso de navegador está deshabilitado.');
    if (interaction && workspace.permissions.browserInteract !== true) fail('CAPABILITY_DISABLED', 'La interacción web está deshabilitada.');
    if (workspace.automationReviewRequired === true) fail('PROFILE_REVIEW_REQUIRED', 'El perfil requiere revisión local.');
    return workspace;
  }

  private async requireHumanControlWorkspace(workspaceId: string): Promise<AuthorizedWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (workspace.permissions.browserHumanControl !== true) {
      fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano está deshabilitado.');
    }
    return workspace;
  }

  private async requireApplicationWorkspace(workspaceId: string, humanControl = false): Promise<AuthorizedWorkspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (workspace.permissions.processes !== true) fail('CAPABILITY_DISABLED', 'El permiso de procesos está deshabilitado.');
    if (humanControl && workspace.permissions.browserHumanControl !== true) {
      fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano está deshabilitado en un servicio de la aplicación.');
    }
    return workspace;
  }

  private async verifyLocalhostResolution(browserSession: Session): Promise<boolean> {
    try {
      const result = await browserSession.resolveHost('localhost', {
        source: 'localOnly',
        cacheUsage: 'disallowed',
        secureDnsPolicy: 'disable',
      });
      return result.endpoints.length > 0 && result.endpoints.every((endpoint) =>
        endpoint.address === '127.0.0.1' || endpoint.address === '::1');
    } catch {
      return false;
    }
  }

  private async verifyListenerBinding(
    browserSession: Session,
    binding: ListenerAuthority,
  ): Promise<boolean> {
    const workspace = await this.options.loadWorkspace(binding.workspaceId).catch(() => undefined);
    if (workspace === undefined || !workspace.enabled || workspace.permissions.processes !== true ||
        workspace.permissions.browserRead !== true || workspace.automationReviewRequired === true) return false;
    const current = binding.projectId === undefined
      ? await this.options.resolveProcessListener?.(
          binding.workspaceId,
          binding.processId,
          binding.listenerRef,
        ).catch(() => undefined)
      : await this.options.resolveTerminalListener?.(
          binding.projectId,
          binding.processId,
          binding.listenerRef,
          binding.workspaceId,
        ).catch(() => undefined);
    if (current === undefined || current.profile !== binding.expected.profile || current.port !== binding.expected.port ||
        current.addressFamily !== binding.expected.addressFamily || current.bindScope !== binding.expected.bindScope ||
        !current.exclusive) return false;
    if (binding.projectId !== undefined) {
      if (!isResolvedTerminalListener(current) || current.projectId !== binding.projectId || current.browserOrigin !== binding.origin ||
          current.trustMode !== 'full-host' && current.bindScope === 'wildcard') return false;
    }
    if (new URL(binding.origin).hostname === 'localhost' && !(await this.verifyLocalhostResolution(browserSession))) return false;
    return true;
  }

  private invalidateNetworkAuthority(entry: ManagedBrowserSession): void {
    void (async () => {
      await Promise.allSettled([
        entry.browserSession.clearHostResolverCache(),
        entry.browserSession.closeAllConnections(),
      ]);
      await this.stopEntry(entry);
    })();
  }

  private ensureAgentControl(entry: ManagedBrowserSession): void {
    if (['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)) {
      fail('HUMAN_CONTROL_ACTIVE', 'La sesión está reservada para control local exclusivo del usuario.');
    }
    if (entry.controlState === 'expired') fail('HUMAN_CONTROL_EXPIRED', 'La sesión de control humano caducó.');
    if (entry.controlState === 'declined') fail('HUMAN_CONTROL_DECLINED', 'El control humano fue denegado.');
    if (entry.postHumanExpiresAt !== undefined && Date.now() >= entry.postHumanExpiresAt) {
      fail('HUMAN_CONTROL_EXPIRED', 'La autoridad posterior al control humano caducó.');
    }
  }

  private beginAgentOperation(entry: ManagedBrowserSession): number {
    this.ensureAgentControl(entry);
    const epoch = entry.controlEpoch;
    entry.activeAgentOperations += 1;
    return epoch;
  }

  private assertAgentOperation(entry: ManagedBrowserSession, epoch: number): void {
    if (entry.state !== 'running' || entry.window.isDestroyed() || entry.content.webContents.isDestroyed()) {
      fail('SESSION_NOT_FOUND', 'La sesión de navegador ya no está disponible.');
    }
    if (entry.controlEpoch !== epoch) fail('HUMAN_CONTROL_ACTIVE', 'El control de la sesión cambió durante la operación.');
    this.ensureAgentControl(entry);
  }

  private endAgentOperation(entry: ManagedBrowserSession): void {
    entry.activeAgentOperations = Math.max(0, entry.activeAgentOperations - 1);
    if (entry.activeAgentOperations !== 0) return;
    const waiters = entry.agentIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private async withAgentOperation<T>(entry: ManagedBrowserSession, operation: () => Promise<T>): Promise<T> {
    const epoch = this.beginAgentOperation(entry);
    try {
      const result = await operation();
      this.assertAgentOperation(entry, epoch);
      return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  private async waitForAgentOperations(entry: ManagedBrowserSession): Promise<void> {
    if (entry.activeAgentOperations === 0) return;
    await new Promise<void>((resolve) => entry.agentIdleWaiters.push(resolve));
  }

  private isCurrentHandoff(entry: ManagedBrowserSession, epoch: number): boolean {
    if (entry.state !== 'running' || entry.window.isDestroyed() || entry.content.webContents.isDestroyed() ||
        entry.controlState !== 'returning_to_agent' || entry.controlEpoch !== epoch ||
        entry.controlExpiresAt === undefined || Date.now() >= entry.controlExpiresAt) return false;
    try {
      return new URL(entry.content.webContents.getURL()).origin === entry.profile.origin;
    } catch {
      return false;
    }
  }

  private emitHumanControlTransition(
    entry: ManagedBrowserSession,
    action: Parameters<NonNullable<BrowserControllerOptions['onHumanControlTransition']>>[0]['action'],
    decision: 'allow' | 'deny' = 'allow',
    outcome: 'success' | 'error' = 'success',
    errorCode?: string,
  ): void {
    try {
      this.options.onHumanControlTransition?.({
        workspaceId: entry.workspaceId,
        sessionId: entry.sessionId,
        ...(entry.humanReason === undefined ? {} : { reason: entry.humanReason }),
        action,
        decision,
        outcome,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    } catch {
      this.options.onSecurityDiagnostic?.('No se pudo persistir una transición de control humano.');
    }
  }

  private async requireSession(workspaceId: string, sessionId: string): Promise<ManagedBrowserSession> {
    const workspace = await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview === true || entry.workspaceId !== workspaceId || entry.state !== 'running' || entry.window.isDestroyed()) {
      fail('SESSION_NOT_FOUND', 'La sesión de navegador no existe.');
    }
    if (entry.postHumanExpiresAt !== undefined && workspace.permissions.browserHumanControl !== true) {
      await this.stopEntry(entry);
      fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano fue revocado.');
    }
    this.ensureAgentControl(entry);
    return entry;
  }

  private async requireInteractionSession(workspaceId: string, sessionId: string): Promise<ManagedBrowserSession> {
    const workspace = await this.requireWorkspace(workspaceId, true);
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview === true || entry.workspaceId !== workspaceId || entry.state !== 'running' || entry.window.isDestroyed()) {
      fail('SESSION_NOT_FOUND', 'La sesión de navegador no existe.');
    }
    if (entry.postHumanExpiresAt !== undefined && workspace.permissions.browserHumanControl !== true) {
      await this.stopEntry(entry);
      fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano fue revocado.');
    }
    this.ensureAgentControl(entry);
    return entry;
  }

  private async resolveElement(entry: ManagedBrowserSession, snapshotId: string, elementRef: string) {
    const snapshot = entry.snapshot;
    if (snapshot === undefined || snapshot.snapshotId !== snapshotId || snapshot.generation !== entry.generation) {
      fail('STALE_SNAPSHOT', 'El snapshot ya no representa el documento actual.');
    }
    const binding = snapshot.elements.get(elementRef);
    if (binding === undefined) fail('STALE_SNAPSHOT', 'La referencia no pertenece al snapshot vigente.');
    await entry.content.webContents.debugger.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
    const pushed = await entry.content.webContents.debugger.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [binding.backendNodeId],
    }) as { nodeIds?: number[] };
    const nodeId = pushed.nodeIds?.[0];
    if (nodeId === undefined || nodeId === 0) fail('STALE_SNAPSHOT', 'El elemento ya no existe.');
    return { nodeId, binding };
  }

  private invalidateSnapshot(entry: ManagedBrowserSession): void {
    entry.generation += 1;
    delete entry.snapshot;
  }

  private rememberInteractionOperation(
    operationKey: string | undefined,
    result: { sessionId: string; applied: true; snapshotInvalidated: true },
  ): void {
    if (operationKey === undefined) return;
    this.interactionOperations.delete(operationKey);
    this.interactionOperations.set(operationKey, result);
    while (this.interactionOperations.size > MAX_INTERACTION_OPERATIONS) {
      const oldest = this.interactionOperations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interactionOperations.delete(oldest);
    }
  }

  private addEvent(entry: ManagedBrowserSession, event: Omit<BrowserEventEntry, 'cursor'>): void {
    if (entry.controlState !== 'agent_control') return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const cursor = entry.nextEventCursor;
    entry.nextEventCursor += bytes;
    entry.events.push({ cursor, ...event });
    entry.eventBytes += bytes;
    while (entry.eventBytes > MAX_EVENT_BYTES && entry.events.length > 1) {
      const removed = entry.events.shift();
      if (removed !== undefined) entry.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }

  private async installDebugger(entry: ManagedBrowserSession, webContents: WebContents): Promise<void> {
    if (!entry.debuggerListenerInstalled) {
      entry.debuggerListenerInstalled = true;
      webContents.debugger.on('message', (_event, method, parameters: unknown) => {
        if (entry.controlState !== 'agent_control') return;
        const data = parameters as Record<string, unknown>;
        if (method === 'DOM.documentUpdated' || method === 'Page.frameNavigated') {
          entry.generation += 1;
          delete entry.snapshot;
        } else if (method === 'Runtime.consoleAPICalled') {
          const args = Array.isArray(data['args']) ? data['args'] as Array<Record<string, unknown>> : [];
          const message = args.map((arg) => stringValue(arg['value'] ?? arg['description'])).join(' ').slice(0, 4096);
          this.addEvent(entry, { type: 'console', level: stringValue(data['type']) || 'log', message });
        } else if (method === 'Network.responseReceived') {
          const response = data['response'] as Record<string, unknown> | undefined;
          this.addEvent(entry, { type: 'network', level: 'response', message: `HTTP ${stringValue(response?.['status'])}`, path: safePathFromUrl(stringValue(response?.['url'])) });
        } else if (method === 'Network.loadingFailed') {
          this.addEvent(entry, { type: 'error', level: 'network', message: stringValue(data['errorText']).slice(0, 1024) });
        } else if (method === 'Page.fileChooserOpened') {
          entry.blockedFileChooserCount += 1;
          this.invalidateSnapshot(entry);
          this.options.onSecurityDiagnostic?.('Se bloqueó un selector de archivos iniciado durante el control del agente.');
        }
      });
    }
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    await Promise.all([
      webContents.debugger.sendCommand('Accessibility.enable'),
      webContents.debugger.sendCommand('DOM.enable'),
      webContents.debugger.sendCommand('Network.enable'),
      webContents.debugger.sendCommand('Page.enable'),
      webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }),
      webContents.debugger.sendCommand('Runtime.enable'),
    ]);
  }

  private async startSession(
    workspaceId: string,
    profileName: string,
    profile: BrowserProfile,
    operationId?: string,
    listenerBindings?: ManagedBrowserSession['listenerBindings'],
    application?: ManagedBrowserSession['application'],
  ): Promise<BrowserSessionSummary> {
    const workspace = await this.requireWorkspace(workspaceId);
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${operationId}`;
    const previousId = operationKey === undefined ? undefined : this.operations.get(operationKey);
    const previous = previousId === undefined ? undefined : this.entries.get(previousId);
    if (previous !== undefined && previous.state === 'running' && !previous.window.isDestroyed()) {
      if (previous.profileName !== profileName || !sameProfile(previous.profile, profile) ||
          !sameListenerBindings(previous.listenerBindings, listenerBindings) ||
          (previous.application === undefined) !== (application === undefined) ||
          (previous.application !== undefined && application !== undefined &&
            (previous.application.id !== application.id || previous.application.localReview !== application.localReview ||
              !sameApplication(previous.application.profile, application.profile)))) {
        fail('INVALID_INPUT', 'El operationId ya pertenece a otra sesión o composición.');
      }
      this.ensureAgentControl(previous);
      if (previous.postHumanExpiresAt !== undefined && workspace.permissions.browserHumanControl !== true) {
        await this.stopEntry(previous);
        fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano fue revocado.');
      }
      return summary(previous);
    }

    if ([...this.entries.values()].filter((entry) => entry.state === 'running').length >= MAX_SESSIONS) {
      fail('RATE_LIMITED', 'Se alcanzó el límite de sesiones web activas.');
    }

    const sessionId = `session_${randomBytes(12).toString('hex')}`;
    const partition = `localbridge-browser-${randomBytes(16).toString('hex')}`;
    const agentShellUrl = `data:text/html;charset=utf-8,${encodeURIComponent(agentShellHtml(workspace.name, profile.origin))}`;
    const window = new BrowserWindow({
      show: false,
      width: profile.viewport.width,
      height: profile.viewport.height + AUTH_TOOLBAR_HEIGHT,
      title: 'Navegador aislado — LocalBridge',
      autoHideMenuBar: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
      },
    });
    const content = new WebContentsView({ webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      backgroundThrottling: false,
    } });
    window.contentView.addChildView(content);
    const resizeContent = (): void => {
      const bounds = window.getContentBounds();
      content.setBounds({ x: 0, y: AUTH_TOOLBAR_HEIGHT, width: bounds.width, height: Math.max(1, bounds.height - AUTH_TOOLBAR_HEIGHT) });
    };
    resizeContent();
    window.on('resize', resizeContent);
    const entry: ManagedBrowserSession = {
      sessionId,
      workspaceId,
      profileName,
      profile,
      window,
      content,
      browserSession: content.webContents.session,
      workspaceName: workspace.name,
      startedAt: Date.now(),
      events: [],
      ...(listenerBindings === undefined ? {} : { listenerBindings }),
      ...(application === undefined ? {} : { application }),
      state: 'running',
      generation: 0,
      eventBytes: 0,
      nextEventCursor: 0,
      controlState: 'agent_control',
      debuggerListenerInstalled: false,
      controlEpoch: 0,
      activeAgentOperations: 0,
      blockedFileChooserCount: 0,
      agentIdleWaiters: [],
      agentShellUrl,
      trustedShellUrl: agentShellUrl,
    };
    this.entries.set(sessionId, entry);
    if (operationKey !== undefined) this.operations.set(operationKey, sessionId);

    const allowedOrigins = new Set(profile.allowedOrigins);
    const browserSession = content.webContents.session;
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    try {
      await content.webContents.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3ELocalBridge%3C%2Ftitle%3E');
      await this.installDebugger(entry, content.webContents);
    } catch {
      await this.stopEntry(entry);
      fail('FEATURE_UNAVAILABLE', 'No se pudo preparar el navegador aislado.');
    }
    if (listenerBindings !== undefined) {
      for (const binding of listenerBindings) {
        if (!(await this.verifyListenerBinding(browserSession, binding))) {
          await this.stopEntry(entry);
          if (new URL(binding.origin).hostname === 'localhost') {
            fail('LOCALHOST_RESOLUTION_BLOCKED', 'localhost no resolvió exclusivamente a loopback.');
          }
          fail('LISTENER_NOT_FOUND', 'El listener perdió su autoridad antes de abrir el navegador.');
        }
      }
    }
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      void (async () => {
        try {
          const originAllowed = isAllowedBrowserRequest(details.url, details.resourceType, allowedOrigins);
          if (!originAllowed) {
            callback({ cancel: true });
            return;
          }
          if (details.resourceType === 'mainFrame' && ['human_control', 'returning_to_agent'].includes(entry.controlState) &&
              new URL(details.url).origin !== profile.origin) {
            callback({ cancel: true });
            return;
          }
          if (listenerBindings !== undefined) {
            const requestUrl = new URL(details.url);
            if (requestUrl.protocol === 'ws:') requestUrl.protocol = 'http:';
            const binding = listenerBindings.find((candidate) => candidate.origin === requestUrl.origin);
            if (binding === undefined || !(await this.verifyListenerBinding(browserSession, binding))) {
              callback({ cancel: true });
              this.invalidateNetworkAuthority(entry);
              return;
            }
          }
          callback({ cancel: false });
        } catch {
          callback({ cancel: true });
        }
      })();
    });
    browserSession.on('will-download', (event) => event.preventDefault());
    content.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    content.webContents.on('will-navigate', (event, url) => {
      try {
        const destinationOrigin = new URL(url).origin;
        const humanOriginAllowed = !['human_control', 'returning_to_agent'].includes(entry.controlState) ||
          destinationOrigin === profile.origin;
        if (!allowedOrigins.has(destinationOrigin) || !humanOriginAllowed) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    const stopAfterRendererFailure = (): void => {
      if (entry.state === 'running') void this.stopEntry(entry);
    };
    content.webContents.on('render-process-gone', stopAfterRendererFailure);
    content.webContents.on('destroyed', stopAfterRendererFailure);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url === 'localbridge-control-action://handoff') {
        event.preventDefault();
        void this.completeHumanControlLocally(sessionId);
      } else if (url === 'localbridge-control-action://cancel') {
        event.preventDefault();
        void this.declineHumanControlLocally(sessionId);
      } else if (url !== entry.trustedShellUrl) {
        event.preventDefault();
      }
    });
    window.webContents.on('render-process-gone', stopAfterRendererFailure);
    window.webContents.on('destroyed', stopAfterRendererFailure);
    window.on('unresponsive', stopAfterRendererFailure);
    window.on('close', (event) => {
      if (entry.state === 'running' && ['human_control', 'returning_to_agent'].includes(entry.controlState)) {
        event.preventDefault();
        void this.declineHumanControlLocally(sessionId);
      }
    });
    try {
      await window.loadURL(entry.trustedShellUrl);
      // El debugger se instala sobre un documento interno vacío antes de la
      // primera navegación al proyecto.
      // Así captura los scripts iniciales sin ejecutar dos veces efectos del proyecto
      // (peticiones, login, inicializadores o conexiones HMR).
      await content.webContents.loadURL(profile.origin);
      // Chromium no entrega eventos de entrada fiables a un WebContentsView cuyo
      // anfitrión nunca fue presentado. Se mantiene compuesto, totalmente
      // transparente, fuera de pantalla y fuera de la barra de tareas.
      window.setPosition(-10_000, -10_000, false);
      window.setOpacity(1);
      window.setIgnoreMouseEvents(true);
      window.setFocusable(false);
      window.showInactive();
    } catch {
      await this.stopEntry(entry);
      fail('FEATURE_UNAVAILABLE', 'No se pudo abrir el origen web aprobado.');
    }
    return summary(entry);
  }

  async start(workspaceId: string, profileName: string, operationId?: string): Promise<BrowserSessionSummary> {
    const workspace = await this.requireWorkspace(workspaceId);
    const profile = workspace.browserProfiles?.[profileName];
    if (profile === undefined) fail('PROFILE_STALE', 'El perfil web no existe.');
    return this.startSession(workspaceId, profileName, profile, operationId);
  }

  async startFromProcess(
    workspaceId: string,
    listener: ResolvedProcessListener,
    operationId?: string,
  ): Promise<BrowserSessionSummary> {
    await this.requireWorkspace(workspaceId);
    const url = new URL(listener.origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.port === '' ||
        listener.bindScope !== 'loopback' || !listener.exclusive) {
      fail('ORIGIN_BLOCKED', 'El listener verificado no es un origen HTTP loopback válido.');
    }
    const profile: BrowserProfile = {
      origin: listener.origin,
      allowedOrigins: [listener.origin],
      viewport: { width: 1280, height: 800 },
      linkedProcessProfile: listener.profile,
    };
    return this.startSession(
      workspaceId,
      `detected:${listener.profile}`,
      profile,
      operationId,
      [{
        service: listener.profile,
        workspaceId,
        processId: listener.processId,
        listenerRef: listener.listenerRef,
        origin: listener.origin,
        expected: listener,
      }],
    );
  }

  async startProjectFromTerminals(
    workspaceId: string,
    projectId: string,
    listeners: readonly ResolvedTerminalListener[],
    operationId?: string,
  ): Promise<BrowserSessionSummary> {
    await this.requireApplicationWorkspace(workspaceId);
    if (listeners.length < 1 || listeners.length > 8) {
      fail('PROJECT_BROWSER_PRIMARY_UNAVAILABLE', 'El proyecto no proporcionó un listener principal válido.');
    }
    const keys = listeners.map((listener) => `${listener.processId}:${listener.listenerRef}`);
    if (new Set(keys).size !== keys.length) {
      fail('PROJECT_BROWSER_LISTENER_MISMATCH', 'Los listeners seleccionados deben ser únicos.');
    }

    const bindings: ListenerAuthority[] = [];
    for (const [index, listener] of listeners.entries()) {
      if (listener.projectId !== projectId || !listener.exclusive) {
        fail(index === 0 ? 'PROJECT_BROWSER_PRIMARY_UNAVAILABLE' : 'PROJECT_BROWSER_LISTENER_MISMATCH', 'El listener no pertenece de forma exclusiva al proyecto.');
      }
      const browserUrl = new URL(listener.browserOrigin);
      if (browserUrl.protocol !== 'http:' || browserUrl.port === '' ||
          !['localhost', '127.0.0.1', '[::1]'].includes(browserUrl.hostname) ||
          Number(browserUrl.port) !== listener.port) {
        fail('LOCALHOST_ATTESTATION_FAILED', 'El origen canónico no coincide con el listener demostrado.');
      }
      if (listener.bindScope === 'wildcard' && (listener.trustMode !== 'full-host' || browserUrl.hostname !== 'localhost')) {
        fail('MANAGED_WILDCARD_NOT_APPROVED', 'El wildcard administrado exige Control total y localhost.');
      }
      if (listener.bindScope === 'loopback') {
        const technical = new URL(listener.technicalOrigin);
        if (technical.protocol !== 'http:' || technical.port === '' ||
            !['127.0.0.1', '[::1]'].includes(technical.hostname) || Number(technical.port) !== listener.port) {
          fail('PROJECT_BROWSER_LISTENER_MISMATCH', 'La evidencia técnica del listener no es loopback.');
        }
      }
      bindings.push({
        service: index === 0 ? 'primary' : `related-${index}`,
        workspaceId,
        processId: listener.processId,
        listenerRef: listener.listenerRef,
        origin: listener.browserOrigin,
        projectId,
        expected: listener,
      });
    }

    const origins = bindings.map((binding) => binding.origin);
    if (new Set(origins).size !== origins.length) {
      fail('PROJECT_BROWSER_ORIGIN_CONFLICT', 'Dos listeners seleccionados producen el mismo origen.');
    }
    const primary = bindings[0]!;
    const profile: BrowserProfile = {
      origin: primary.origin,
      allowedOrigins: origins,
      viewport: { width: 1280, height: 800 },
      linkedProcessProfile: 'terminal',
    };
    return this.startSession(
      workspaceId,
      `project:${listeners.length}-services`,
      profile,
      operationId,
      bindings,
    );
  }

  async startApplication(
    workspaceId: string,
    applicationName: string,
    listenerInputs: readonly BrowserApplicationListenerInput[],
    operationId?: string,
  ): Promise<BrowserSessionSummary> {
    const application = await this.options.loadApplication(applicationName);
    if (application === undefined || application.reviewState !== 'reviewed') {
      fail('APPLICATION_PROFILE_NOT_FOUND', 'La aplicación local no existe o necesita revisión.');
    }
    return this.startApplicationDefinition(workspaceId, application, listenerInputs, operationId);
  }

  /** Solo para el asistente local: la definición ya fue validada por IPC y nunca viene de MCP. */
  async startApplicationDefinition(
    workspaceId: string,
    application: LocalApplication,
    listenerInputs: readonly BrowserApplicationListenerInput[],
    operationId?: string,
  ): Promise<BrowserSessionSummary> {
    if (application.reviewState !== 'reviewed') fail('APPLICATION_REVIEW_REQUIRED', 'La aplicación necesita revisión local.');
    return this.startApplicationDefinitionInternal(workspaceId, application, listenerInputs, operationId, false);
  }

  /** Solo para IPC local: esta sesión de prueba nunca queda disponible para las tools MCP. */
  async startApplicationForLocalReview(
    workspaceId: string,
    application: LocalApplication,
    listenerInputs: readonly BrowserApplicationListenerInput[],
  ): Promise<BrowserSessionSummary> {
    if (application.reviewState === 'conflict') fail('APPLICATION_REVIEW_REQUIRED', 'La aplicación tiene un conflicto sin resolver.');
    return this.startApplicationDefinitionInternal(workspaceId, application, listenerInputs, undefined, true);
  }

  private async startApplicationDefinitionInternal(
    workspaceId: string,
    application: LocalApplication,
    listenerInputs: readonly BrowserApplicationListenerInput[],
    operationId: string | undefined,
    localReview: boolean,
  ): Promise<BrowserSessionSummary> {
    const expectedAliases = application.services.map((service) => service.alias).toSorted();
    const suppliedAliases = listenerInputs.map((input) => input.service).toSorted();
    if (new Set(suppliedAliases).size !== suppliedAliases.length ||
        JSON.stringify(expectedAliases) !== JSON.stringify(suppliedAliases)) {
      fail('APPLICATION_SERVICE_MISMATCH', 'Los listeners no coinciden exactamente con los servicios configurados.');
    }

    const bindings: ListenerAuthority[] = [];
    for (const serviceName of expectedAliases) {
      const definition = application.services.find((service) => service.alias === serviceName)!;
      const input = listenerInputs.find((candidate) => candidate.service === serviceName)!;
      const serviceWorkspace = await this.requireApplicationWorkspace(definition.workspaceId);
      if (serviceWorkspace.processProfiles?.[definition.processProfile] === undefined) {
        fail('PROFILE_STALE', 'El perfil de proceso de un servicio cambió.');
      }
      const listener = await this.options.resolveProcessListener?.(
        definition.workspaceId,
        input.processId,
        input.listenerRef,
      );
      if (listener === undefined || listener.profile !== definition.processProfile || !listener.exclusive) {
        fail('APPLICATION_SERVICE_MISMATCH', 'El listener no coincide con el servicio configurado o es ambiguo.');
      }
      if (listener.bindScope === 'wildcard' &&
          (definition.hostMode !== 'manual-localhost' || !definition.allowManagedWildcard)) {
        fail('MANAGED_WILDCARD_NOT_APPROVED', 'El listener wildcard requiere aprobación local en la aplicación.');
      }
      if (listener.bindScope === 'wildcard' && definition.hostMode === 'listener-literal') {
        fail('ORIGIN_BLOCKED', 'Un listener wildcard no tiene un origen IP literal adoptable.');
      }
      const origin = definition.hostMode === 'manual-localhost'
        ? `http://localhost:${listener.port}`
        : listener.origin;
      bindings.push({
        service: serviceName,
        workspaceId: definition.workspaceId,
        processId: input.processId,
        listenerRef: input.listenerRef,
        origin,
        expected: listener,
      });
    }
    const origins = bindings.map((binding) => binding.origin);
    if (new Set(origins).size !== origins.length) fail('APPLICATION_ORIGIN_CONFLICT', 'Dos servicios resuelven al mismo origen.');
    const primaryDefinition = application.services.find((service) => service.id === application.primaryServiceId);
    if (primaryDefinition === undefined || primaryDefinition.workspaceId !== workspaceId) {
      fail('APPLICATION_SERVICE_MISMATCH', 'El workspace indicado no es el servicio principal de la aplicación.');
    }
    const primary = bindings.find((binding) => binding.service === primaryDefinition.alias);
    if (primary === undefined) fail('PROFILE_STALE', 'El servicio principal no está disponible.');

    const dynamicProfile: BrowserProfile = {
      origin: primary.origin,
      allowedOrigins: origins,
      viewport: application.viewport,
      linkedProcessProfile: primary.expected.profile,
    };
    return this.startSession(
      workspaceId,
      `application:${application.id}`,
      dynamicProfile,
      operationId,
      bindings,
      { id: application.id, name: application.name, profile: application, ...(localReview ? { localReview: true } : {}) },
    );
  }

  async list(workspaceId: string): Promise<readonly BrowserSessionSummary[]> {
    const workspace = await this.requireWorkspace(workspaceId);
    const entries = [...this.entries.values()].filter((entry) => entry.workspaceId === workspaceId && entry.application?.localReview !== true);
    for (const entry of entries) {
      if (entry.state !== 'running') continue;
      if (entry.postHumanExpiresAt !== undefined && workspace.permissions.browserHumanControl !== true) {
        await this.stopEntry(entry);
        fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano fue revocado.');
      }
      if (['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)) {
        if (workspace.permissions.browserHumanControl !== true) {
          await this.stopEntry(entry);
          fail('HUMAN_CONTROL_NOT_ALLOWED', 'El permiso de control humano fue revocado.');
        }
      }
      this.ensureAgentControl(entry);
    }
    return entries.map(summary);
  }

  /** Vista local de Electron; omite origen completo, cookies y almacenamiento. */
  listAll(): ReadonlyArray<BrowserSessionSummary & { workspaceId: string }> {
    return [...this.entries.values()].map((entry) => ({ workspaceId: entry.workspaceId, ...summary(entry) }));
  }

  async navigate(workspaceId: string, sessionId: string, relativePath: string): Promise<BrowserSessionSummary> {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, async () => {
      if (!relativePath.startsWith('/') || relativePath.startsWith('//') || relativePath.includes('\\')) {
        fail('ORIGIN_BLOCKED', 'La navegación debe usar una ruta relativa al origen aprobado.');
      }
      const destination = new URL(relativePath, entry.profile.origin);
      if (!entry.profile.allowedOrigins.includes(destination.origin)) fail('ORIGIN_BLOCKED', 'El origen no está aprobado.');
      try {
        await entry.content.webContents.loadURL(destination.toString());
      } catch {
        fail('FEATURE_UNAVAILABLE', 'La navegación local falló.');
      }
      return summary(entry);
    });
  }

  async snapshot(workspaceId: string, sessionId: string, maxDepth: number, maxElements: number) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, async () => {
      const result = await entry.content.webContents.debugger.sendCommand('Accessibility.getFullAXTree') as {
      nodes?: Array<Record<string, unknown>>;
      };
      const nodes = result.nodes ?? [];
      const byId = new Map(nodes.map((node) => [stringValue(node['nodeId']), node]));
      const elements = new Map<string, ElementBinding>();
      const output: Array<Record<string, unknown>> = [];
      for (const node of nodes) {
        if (output.length >= maxElements || node['ignored'] === true) continue;
        let depth = 0;
        let parentId = stringValue(node['parentId']);
        while (parentId !== '' && depth <= maxDepth) {
          depth += 1;
          parentId = stringValue(byId.get(parentId)?.['parentId']);
        }
        if (depth > maxDepth) continue;
        const role = stringValue((node['role'] as Record<string, unknown> | undefined)?.['value']) || 'generic';
        const name = stringValue((node['name'] as Record<string, unknown> | undefined)?.['value']).trim().slice(0, 512);
        const rawValue = stringValue((node['value'] as Record<string, unknown> | undefined)?.['value']);
        const backendNodeId = typeof node['backendDOMNodeId'] === 'number' ? node['backendDOMNodeId'] : undefined;
        const elementRef = backendNodeId === undefined || !INTERACTIVE_ROLES.has(role)
          ? undefined
          : `element_${randomBytes(10).toString('hex')}`;
        if (elementRef !== undefined && backendNodeId !== undefined) elements.set(elementRef, { backendNodeId, role });
        output.push({
          depth,
          role,
          name,
          ...(rawValue === '' ? {} : { value: role === 'password' ? '[redacted]' : rawValue.slice(0, 1024) }),
          ...(elementRef === undefined ? {} : { elementRef }),
        });
      }
      const snapshotId = `snapshot_${randomBytes(10).toString('hex')}`;
      entry.snapshot = { snapshotId, generation: entry.generation, elements };
      return { snapshotId, title: entry.content.webContents.getTitle().slice(0, 256), path: safePathFromUrl(entry.content.webContents.getURL()), nodes: output };
    });
  }

  async screenshot(workspaceId: string, sessionId: string) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, async () => {
      const captured = await entry.content.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }) as { data?: string };
      if (captured.data === undefined) fail('FEATURE_UNAVAILABLE', 'No se pudo capturar la vista local.');
      return { mimeType: 'image/png' as const, dataBase64: captured.data, width: entry.profile.viewport.width, height: entry.profile.viewport.height };
    });
  }

  async events(workspaceId: string, sessionId: string, cursor: number, maxBytes: number) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, async () => {
      const firstCursor = entry.events[0]?.cursor ?? entry.nextEventCursor;
      let bytes = 0;
      const events: BrowserEventEntry[] = [];
      for (const event of entry.events) {
        const eventBytes = Buffer.byteLength(JSON.stringify(event));
        if (event.cursor + eventBytes <= cursor) continue;
        if (bytes + eventBytes > maxBytes && events.length > 0) break;
        events.push(event);
        bytes += eventBytes;
      }
      const last = events.at(-1);
      return {
        events,
        nextCursor: last === undefined ? Math.max(cursor, entry.nextEventCursor) : last.cursor + Buffer.byteLength(JSON.stringify(last)),
        truncatedBeforeCursor: cursor < firstCursor,
      };
    });
  }

  async click(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = operationKey === undefined ? undefined : this.interactionOperations.get(operationKey);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
    entry.content.webContents.focus();
    await entry.content.webContents.debugger.sendCommand('Page.bringToFront');
    const { nodeId } = await this.resolveElement(entry, snapshotId, elementRef);
    const chooserCount = entry.blockedFileChooserCount;
    const resolved = await entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId }) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) fail('STALE_SNAPSHOT', 'El elemento ya no es interactuable.');
    try {
      const classification = await entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const element = this;
          if (!(element instanceof Element)) return false;
          if (element.matches('input[type="file"]')) return true;
          if (element.matches('label')) {
            const control = element.control;
            if (control instanceof HTMLInputElement && control.type === 'file') return true;
            return element.querySelector('input[type="file"]') !== null;
          }
          return false;
        }`,
        returnByValue: true,
      }) as { result?: { value?: boolean } };
      if (classification.result?.value === true) {
        fail('SENSITIVE_INPUT_BLOCKED', 'El selector de archivos requiere control humano exclusivo.');
      }
      // Función interna fija: el modelo nunca aporta JavaScript ni selectores.
      await entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { this.click(); }',
        awaitPromise: true,
        userGesture: true,
      });
    } finally {
      await entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
    await waitForInteractionToSettle();
    if (entry.blockedFileChooserCount !== chooserCount) {
      fail('SENSITIVE_INPUT_BLOCKED', 'El selector de archivos requiere control humano exclusivo.');
    }
    this.invalidateSnapshot(entry);
    const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
    this.assertAgentOperation(entry, epoch);
    this.rememberInteractionOperation(operationKey, result);
    return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async fill(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, text: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = operationKey === undefined ? undefined : this.interactionOperations.get(operationKey);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
    entry.content.webContents.focus();
    const { nodeId, binding } = await this.resolveElement(entry, snapshotId, elementRef);
    if (!['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(binding.role)) {
      fail('SENSITIVE_INPUT_BLOCKED', 'El elemento no es un campo de texto permitido.');
    }
    const described = await entry.content.webContents.debugger.sendCommand('DOM.describeNode', { nodeId }) as {
      node?: { nodeName?: string; attributes?: string[] };
    };
    const attributes = described.node?.attributes ?? [];
    const attributeMap = new Map<string, string>();
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      attributeMap.set((attributes[index] ?? '').toLowerCase(), attributes[index + 1] ?? '');
    }
    const inputType = (attributeMap.get('type') ?? 'text').toLowerCase();
    const autocomplete = (attributeMap.get('autocomplete') ?? '').toLowerCase();
    const identity = `${attributeMap.get('name') ?? ''} ${attributeMap.get('id') ?? ''} ${attributeMap.get('aria-label') ?? ''}`.toLowerCase();
    const sensitive = ['password', 'file', 'hidden'].includes(inputType) ||
      /password|one-time-code|cc-|webauthn/.test(autocomplete) ||
      /pass(word|wd)?|secret|token|api.?key|credit|card|cvc|cvv|otp/.test(identity);
    if (sensitive) fail('SENSITIVE_INPUT_BLOCKED', 'El campo se clasifica como sensible.');

    await entry.content.webContents.debugger.sendCommand('DOM.focus', { nodeId });
    await entry.content.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await entry.content.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await entry.content.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace' });
    await entry.content.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await entry.content.webContents.debugger.sendCommand('Input.insertText', { text });
    await waitForInteractionToSettle();
    this.invalidateSnapshot(entry);
    const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
    this.assertAgentOperation(entry, epoch);
    this.rememberInteractionOperation(operationKey, result);
    return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async press(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, key: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = operationKey === undefined ? undefined : this.interactionOperations.get(operationKey);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
    entry.content.webContents.focus();
    const { nodeId } = await this.resolveElement(entry, snapshotId, elementRef);
    await entry.content.webContents.debugger.sendCommand('DOM.focus', { nodeId });
    await entry.content.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key });
    await entry.content.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
    await waitForInteractionToSettle();
    this.invalidateSnapshot(entry);
    const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
    this.assertAgentOperation(entry, epoch);
    this.rememberInteractionOperation(operationKey, result);
    return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async requestHumanControl(
    workspaceId: string,
    sessionId: string,
    reason: BrowserHumanReason,
    operationId: string,
  ): Promise<BrowserHumanControlStatus> {
    await this.requireHumanControlWorkspace(workspaceId);
    const operationKey = `${workspaceId}:${sessionId}:${operationId}`;
    const previousRequestId = this.humanControlOperations.get(operationKey);
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.workspaceId !== workspaceId || entry.state !== 'running' || entry.window.isDestroyed()) {
      fail('SESSION_NOT_FOUND', 'La sesión no existe.');
    }
    if (entry.application !== undefined) {
      for (const service of entry.application.profile.services) {
        await this.requireApplicationWorkspace(service.workspaceId, true);
      }
    }
    if (previousRequestId !== undefined && previousRequestId === entry.humanRequestId) return humanControlStatus(entry);
    if (entry.controlState !== 'agent_control') {
      if (entry.humanRequestId !== undefined) return humanControlStatus(entry);
      fail('HUMAN_CONTROL_BUSY', 'La sesión ya está reservada para otra intervención humana.');
    }
    if (entry.postHumanExpiresAt !== undefined && Date.now() >= entry.postHumanExpiresAt) {
      await this.stopEntry(entry, 'expired');
      fail('HUMAN_CONTROL_EXPIRED', 'La autoridad posterior a una intervención humana ya caducó.');
    }
    let currentOrigin: string;
    try {
      currentOrigin = new URL(entry.content.webContents.getURL()).origin;
    } catch {
      fail('ORIGIN_BLOCKED', 'La página actual no tiene un origen válido para control humano.');
    }
    if (currentOrigin !== entry.profile.origin) {
      fail('ORIGIN_BLOCKED', 'El control humano solo puede abrirse en el origen principal aprobado.');
    }
    entry.restoreLiveViewerAfterHuman = this.liveViewerSessionId === sessionId;
    if (entry.restoreLiveViewerAfterHuman) entry.previousViewerWorkArea = entry.window.getBounds();
    this.hideLiveViewerEntry(entry);
    entry.humanRequestId = `humanreq_${randomBytes(12).toString('hex')}`;
    entry.humanReason = reason;
    delete entry.humanResultState;
    entry.controlState = 'waiting_for_human';
    entry.controlEpoch += 1;
    entry.controlExpiresAt = Math.min(Date.now() + HUMAN_REQUEST_TTL_MS, entry.postHumanExpiresAt ?? Number.POSITIVE_INFINITY);
    this.invalidateSnapshot(entry);
    entry.events.length = 0;
    entry.eventBytes = 0;
    if (entry.controlTimer !== undefined) clearTimeout(entry.controlTimer);
    entry.controlTimer = setTimeout(() => { void this.stopEntry(entry, 'expired'); }, Math.max(1, entry.controlExpiresAt - Date.now()));
    entry.controlTimer.unref();
    this.humanControlOperations.set(operationKey, entry.humanRequestId);
    await this.waitForAgentOperations(entry);
    if (entry.state !== 'running' || entry.controlState !== 'waiting_for_human' || entry.controlExpiresAt === undefined || Date.now() >= entry.controlExpiresAt) {
      if (entry.state === 'running') await this.stopEntry(entry, 'expired');
      fail('HUMAN_CONTROL_EXPIRED', 'La solicitud de control humano ya no está disponible.');
    }
    this.emitHumanControlTransition(entry, 'browser.human.request');
    this.options.onHumanControlRequest?.({ workspaceId, ...summary(entry) });
    return humanControlStatus(entry);
  }

  async humanControlStatus(workspaceId: string, sessionId: string): Promise<BrowserHumanControlStatus> {
    const workspace = await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.workspaceId !== workspaceId) fail('SESSION_NOT_FOUND', 'La sesión no existe.');
    if (workspace.permissions.browserHumanControl !== true) {
      if (entry.state === 'running' && entry.humanRequestId !== undefined) await this.stopEntry(entry);
      fail('HUMAN_CONTROL_NOT_ALLOWED', 'El control humano fue revocado.');
    }
    return humanControlStatus(entry);
  }

  async requestHumanControlLocally(sessionId: string, reason: BrowserHumanReason = 'manual_step', workArea?: LiveViewerWorkArea): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running') fail('SESSION_NOT_FOUND', 'La sesión no existe.');
    await this.requestHumanControl(entry.workspaceId, sessionId, reason, `local_${randomBytes(12).toString('hex')}`);
    await this.openHumanControlLocally(sessionId, workArea);
  }

  async takeHumanControlLocally(sessionId: string, workArea?: LiveViewerWorkArea): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running') fail('SESSION_NOT_FOUND', 'La sesión no existe.');
    if (entry.controlState === 'waiting_for_human') {
      await this.openHumanControlLocally(sessionId, workArea);
      return;
    }
    if (entry.controlState === 'agent_control') {
      await this.requestHumanControlLocally(sessionId, 'manual_step', workArea);
      return;
    }
    fail('HUMAN_CONTROL_BUSY', 'La sesión ya está en una transición de control humano.');
  }

  async openHumanControlLocally(sessionId: string, workArea?: LiveViewerWorkArea): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running' || entry.controlState !== 'waiting_for_human' || entry.humanRequestId === undefined) {
      fail('HUMAN_CONTROL_REQUEST_NOT_FOUND', 'La solicitud ya no está disponible.');
    }
    try {
      await this.requireHumanControlWorkspace(entry.workspaceId);
      if (entry.application !== undefined) {
        for (const service of entry.application.profile.services) await this.requireApplicationWorkspace(service.workspaceId, true);
      }
    } catch (error) {
      await this.stopEntry(entry);
      throw error;
    }
    if (entry.state !== 'running' || entry.window.isDestroyed() || entry.content.webContents.isDestroyed() ||
        entry.controlState !== 'waiting_for_human' || entry.humanRequestId === undefined) {
      fail('HUMAN_CONTROL_REQUEST_NOT_FOUND', 'La solicitud dejó de estar disponible.');
    }
    if (entry.controlExpiresAt === undefined || Date.now() >= entry.controlExpiresAt) {
      await this.stopEntry(entry, 'expired');
      fail('HUMAN_CONTROL_EXPIRED', 'La solicitud caducó.');
    }
    if (this.humanSessionId !== undefined && this.humanSessionId !== sessionId) {
      const current = this.entries.get(this.humanSessionId);
      if (current !== undefined && current.state === 'running' && ['human_control', 'returning_to_agent'].includes(current.controlState)) {
        this.emitHumanControlTransition(entry, 'browser.human.open', 'deny', 'error', 'HUMAN_CONTROL_BUSY');
        fail('HUMAN_CONTROL_BUSY', 'Ya existe una sesión de control humano activa.');
      }
      this.humanSessionId = undefined;
    }
    let currentOrigin: string;
    try {
      currentOrigin = new URL(entry.content.webContents.getURL()).origin;
    } catch {
      this.emitHumanControlTransition(entry, 'browser.human.open', 'deny', 'error', 'ORIGIN_BLOCKED');
      await this.stopEntry(entry);
      fail('ORIGIN_BLOCKED', 'La página actual no tiene un origen válido.');
    }
    if (currentOrigin !== entry.profile.origin) {
      this.emitHumanControlTransition(entry, 'browser.human.open', 'deny', 'error', 'ORIGIN_BLOCKED');
      await this.stopEntry(entry);
      fail('ORIGIN_BLOCKED', 'La página cambió de origen antes del control humano.');
    }
    this.humanSessionId = sessionId;
    entry.controlState = 'human_control';
    if (entry.controlTimer !== undefined) clearTimeout(entry.controlTimer);
    entry.controlExpiresAt = Math.min(Date.now() + HUMAN_CONTROL_TTL_MS, entry.postHumanExpiresAt ?? Number.POSITIVE_INFINITY);
    entry.controlTimer = setTimeout(() => { void this.stopEntry(entry, 'expired'); }, Math.max(1, entry.controlExpiresAt - Date.now()));
    entry.controlTimer.unref();
    this.invalidateSnapshot(entry);
    entry.events.length = 0;
    entry.eventBytes = 0;
    if (entry.content.webContents.debugger.isAttached()) entry.content.webContents.debugger.detach();
    entry.trustedShellUrl = `data:text/html;charset=utf-8,${encodeURIComponent(controlShellHtml(entry.workspaceName, entry.profile.origin, entry.humanReason ?? 'manual_step', entry.controlExpiresAt))}`;
    await entry.window.loadURL(entry.trustedShellUrl);
    entry.window.setSkipTaskbar(false);
    entry.window.setIgnoreMouseEvents(false);
    entry.window.setFocusable(true);
    entry.window.setOpacity(1);
    if (workArea !== undefined) this.positionLiveViewer(entry, workArea);
    else entry.window.center();
    entry.window.show();
    entry.window.focus();
    this.emitHumanControlTransition(entry, 'browser.human.open');
    this.options.onActivityChange?.();
  }

  async completeHumanControlLocally(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running' || entry.controlState !== 'human_control') return;
    entry.controlState = 'returning_to_agent';
    const handoffEpoch = entry.controlEpoch;
    const confirmed = await (this.options.confirmHumanControlHandoff?.(entry.workspaceName) ?? Promise.resolve(true));
    if (!this.isCurrentHandoff(entry, handoffEpoch)) {
      if (entry.state === 'running') await this.stopEntry(entry, 'expired');
      return;
    }
    try {
      await this.requireHumanControlWorkspace(entry.workspaceId);
      if (entry.application !== undefined) {
        for (const service of entry.application.profile.services) await this.requireApplicationWorkspace(service.workspaceId, true);
      }
    } catch {
      await this.stopEntry(entry);
      return;
    }
    if (!this.isCurrentHandoff(entry, handoffEpoch)) {
      if (entry.state === 'running') await this.stopEntry(entry, 'expired');
      return;
    }
    if (!confirmed) {
      entry.controlState = 'human_control';
      try {
        // El shell deshabilita sus acciones antes de abrir la confirmación para
        // impedir dobles clics. Recargar solo este documento local restaura los
        // controles sin navegar ni recargar el WebContentsView del proyecto.
        await entry.window.loadURL(entry.trustedShellUrl);
      } catch {
        await this.stopEntry(entry);
        this.options.onActivityChange?.();
        return;
      }
      if (entry.state !== 'running' || entry.controlState !== 'human_control' || entry.controlEpoch !== handoffEpoch) {
        if (entry.state === 'running') await this.stopEntry(entry, 'expired');
        return;
      }
      entry.window.setSkipTaskbar(false);
      entry.window.setIgnoreMouseEvents(false);
      entry.window.setFocusable(true);
      entry.window.setOpacity(1);
      entry.window.show();
      entry.window.focus();
      this.emitHumanControlTransition(entry, 'browser.human.handoff', 'deny');
      this.options.onActivityChange?.();
      return;
    }
    if (entry.controlTimer !== undefined) clearTimeout(entry.controlTimer);
    entry.window.setSkipTaskbar(true);
    entry.window.setOpacity(1);
    entry.window.setIgnoreMouseEvents(true);
    entry.window.setFocusable(false);
    entry.window.setPosition(-10_000, -10_000, false);
    entry.events.length = 0;
    entry.eventBytes = 0;
    this.invalidateSnapshot(entry);
    try {
      await this.restoreAgentShell(entry);
      entry.window.showInactive();
      await this.installDebugger(entry, entry.content.webContents);
    } catch {
      await this.stopEntry(entry);
      this.options.onActivityChange?.();
      return;
    }
    if (!this.isCurrentHandoff(entry, handoffEpoch)) {
      if (entry.state === 'running') await this.stopEntry(entry, 'expired');
      return;
    }
    entry.controlState = 'agent_control';
    this.humanSessionId = undefined;
    entry.postHumanExpiresAt ??= Date.now() + POST_HUMAN_SESSION_TTL_MS;
    delete entry.controlExpiresAt;
    entry.controlTimer = setTimeout(() => { void this.stopEntry(entry, 'expired'); }, Math.max(1, entry.postHumanExpiresAt - Date.now()));
    entry.controlTimer.unref();
    entry.humanResultState = 'ready';
    this.emitHumanControlTransition(entry, 'browser.human.handoff');
    if (entry.restoreLiveViewerAfterHuman && entry.previousViewerWorkArea !== undefined) {
      const previousArea = entry.previousViewerWorkArea;
      delete entry.restoreLiveViewerAfterHuman;
      delete entry.previousViewerWorkArea;
      await this.showLiveViewerLocally(sessionId, previousArea).catch(() => undefined);
    }
    this.options.onActivityChange?.();
  }

  async declineHumanControlLocally(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running') return;
    await this.stopEntry(entry, 'declined');
    this.options.onActivityChange?.();
  }

  private async stopEntry(entry: ManagedBrowserSession, controlState: BrowserControlState = 'stopped'): Promise<void> {
    if (entry.stopPromise !== undefined) {
      await entry.stopPromise;
      return;
    }
    if (entry.state === 'stopped') return;
    this.hideLiveViewerEntry(entry, false);
    entry.state = 'stopped';
    entry.controlState = controlState;
    entry.controlEpoch += 1;
    if (this.humanSessionId === entry.sessionId) this.humanSessionId = undefined;
    if (entry.controlTimer !== undefined) clearTimeout(entry.controlTimer);
    entry.stopPromise = Promise.resolve().then(() => this.finishStoppingEntry(entry, controlState));
    await entry.stopPromise;
  }

  private async finishStoppingEntry(entry: ManagedBrowserSession, controlState: BrowserControlState): Promise<void> {
    this.invalidateSnapshot(entry);
    entry.events.length = 0;
    entry.eventBytes = 0;
    const projectWebContents = entry.content.webContents as WebContents | undefined;
    if (projectWebContents !== undefined && !projectWebContents.isDestroyed() && projectWebContents.debugger.isAttached()) {
      projectWebContents.debugger.detach();
    }
    if (!entry.window.isDestroyed()) {
      try { entry.window.contentView.removeChildView(entry.content); } catch { /* ya desvinculada */ }
    }
    if (projectWebContents !== undefined && !projectWebContents.isDestroyed()) projectWebContents.close({ waitForBeforeUnload: false });
    if (!entry.window.isDestroyed()) entry.window.destroy();
    entry.browserSession.flushStorageData();
    const cleanup = await Promise.allSettled([
      entry.browserSession.clearStorageData(),
      entry.browserSession.clearCache(),
      entry.browserSession.clearAuthCache(),
      entry.browserSession.closeAllConnections(),
    ]);
    let cleanupFailed = cleanup.some((result) => result.status === 'rejected');
    try {
      const cookies = await entry.browserSession.cookies.get({});
      if (cookies.length > 0) {
        cleanupFailed = true;
        await entry.browserSession.clearStorageData({ storages: ['cookies'] });
      }
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) this.options.onSecurityDiagnostic?.('La limpieza de una sesión web efímera no pudo verificarse completamente.');
    this.purgeSessionOperations(entry.sessionId);
    if (entry.terminalTimer !== undefined) clearTimeout(entry.terminalTimer);
    entry.terminalTimer = setTimeout(() => this.entries.delete(entry.sessionId), TERMINAL_SESSION_TTL_MS);
    entry.terminalTimer.unref();
    if (entry.humanRequestId !== undefined) {
      entry.humanResultState = controlState === 'expired' ? 'expired' : controlState === 'declined' ? 'declined' : 'stopped';
      if (controlState === 'expired') this.emitHumanControlTransition(entry, 'browser.human.expire', 'allow', 'error', 'HUMAN_CONTROL_EXPIRED');
      else if (controlState === 'declined') this.emitHumanControlTransition(entry, 'browser.human.decline', 'deny');
      else this.emitHumanControlTransition(entry, 'browser.human.revoke');
    }
  }

  private purgeSessionOperations(sessionId: string): void {
    for (const [key, value] of this.operations) if (value === sessionId) this.operations.delete(key);
    for (const key of this.humanControlOperations.keys()) if (key.includes(`:${sessionId}:`)) this.humanControlOperations.delete(key);
    for (const [key, value] of this.interactionOperations) if (value.sessionId === sessionId) this.interactionOperations.delete(key);
  }

  async stop(workspaceId: string, sessionId: string): Promise<BrowserSessionSummary> {
    await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview === true || entry.workspaceId !== workspaceId) fail('SESSION_NOT_FOUND', 'La sesión no existe.');
    await this.stopEntry(entry);
    return summary(entry);
  }

  async captureForLocalViewer(sessionId: string): Promise<BrowserViewerFrame> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview === true || entry.state !== 'running' ||
        entry.window.isDestroyed() || entry.content.webContents.isDestroyed()) {
      return { state: 'stopped', sessionId, path: '/' };
    }
    await this.requireWorkspace(entry.workspaceId);
    if (['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)) {
      return { state: 'private', sessionId, path: safePathFromUrl(entry.content.webContents.getURL()) };
    }
    if (entry.viewerCapturePromise !== undefined) return entry.viewerCapturePromise;
    const capture = this.withAgentOperation(entry, async () => {
      const captured = await entry.content.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }) as { data?: string };
      if (captured.data === undefined || Buffer.byteLength(captured.data, 'base64') > MAX_VIEWER_FRAME_BYTES) {
        fail('FEATURE_UNAVAILABLE', 'No se pudo capturar el visor local dentro del límite seguro.');
      }
      return {
        state: 'ready' as const,
        sessionId,
        dataUrl: `data:image/png;base64,${captured.data}`,
        width: entry.profile.viewport.width,
        height: entry.profile.viewport.height,
        path: safePathFromUrl(entry.content.webContents.getURL()),
        capturedAt: new Date().toISOString(),
      };
    });
    entry.viewerCapturePromise = capture;
    try {
      return await capture;
    } finally {
      if (entry.viewerCapturePromise === capture) delete entry.viewerCapturePromise;
    }
  }

  /** Cleanup por identidad interna; solo acepta sesiones creadas por la revisión local. */
  async stopLocalReviewSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.application?.localReview !== true) fail('SESSION_NOT_FOUND', 'La sesión local no existe.');
    await this.stopEntry(entry);
  }

  async reconcile(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.state === 'running');
    await Promise.all(running.map(async (entry) => {
      const workspace = await this.options.loadWorkspace(entry.workspaceId).catch(() => undefined);
      if (workspace === undefined || !workspace.enabled || workspace.permissions.browserRead !== true ||
          workspace.automationReviewRequired === true) {
        await this.stopEntry(entry);
        return;
      }
      if (entry.postHumanExpiresAt !== undefined && workspace.permissions.browserHumanControl !== true) {
        await this.stopEntry(entry);
        return;
      }
      if (['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)) {
        if (workspace.permissions.browserHumanControl !== true) {
          await this.stopEntry(entry);
          return;
        }
      }
      if (entry.listenerBindings !== undefined) {
        if (entry.application !== undefined) {
          const currentApplication = await this.options.loadApplication(entry.application.id).catch(() => undefined);
          const reviewStateAllowed = entry.application.localReview === true
            ? currentApplication?.reviewState === 'needs-review' || currentApplication?.reviewState === 'reviewed'
            : currentApplication?.reviewState === 'reviewed';
          if (currentApplication === undefined || !reviewStateAllowed ||
              !sameApplication(entry.application.profile, currentApplication)) {
            await this.stopEntry(entry);
            return;
          }
        }
        for (const binding of entry.listenerBindings) {
          if (!(await this.verifyListenerBinding(entry.browserSession, binding))) {
            await this.stopEntry(entry);
            return;
          }
          const humanPermissionRequired = entry.postHumanExpiresAt !== undefined ||
            !['agent_control', 'stopped'].includes(entry.controlState);
          if (humanPermissionRequired) {
            const serviceWorkspace = await this.options.loadWorkspace(binding.workspaceId).catch(() => undefined);
            if (serviceWorkspace?.permissions.browserHumanControl !== true) {
              await this.stopEntry(entry);
              return;
            }
          }
        }
        return;
      }
      const currentProfile = workspace.browserProfiles?.[entry.profileName];
      if (currentProfile === undefined || !sameProfile(entry.profile, currentProfile)) await this.stopEntry(entry);
    }));
  }

  async close(): Promise<void> {
    clearInterval(this.reconciliationTimer);
    await this.stopAll();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry)));
  }

  /** Cleanup cerrado por identidad local; nunca acepta una URL, PID ni ruta. */
  async stopApplication(applicationId: string): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.application?.id === applicationId)
        .map((entry) => this.stopEntry(entry)),
    );
  }
}
