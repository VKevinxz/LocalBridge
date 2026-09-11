import { createHash, randomBytes } from 'node:crypto';

import { BrowserWindow, View, WebContentsView, type Session, type WebContents } from 'electron';

import {
  DevelopmentBrokerError,
  MAX_BROKER_FRAME_BYTES,
  type BrowserApplicationListenerInput,
  type BrowserCondition,
  type ResolvedProcessListener,
  type ResolvedTerminalListener,
} from '@localbridge/development';
import type { AuthorizedWorkspace, BrowserProfile, LocalApplication } from '@localbridge/workspace';
import type { WorkspaceArtifactDirectoryResult, WorkspaceArtifactWriter } from '@localbridge/filesystem';
import { isSensitiveInput } from '@localbridge/desktop-core';
import { ERROR_CODES, LocalBridgeError } from '@localbridge/shared';

import { isAllowedBrowserRequest } from './browser-network-policy.js';
import { resolveViewerPresentation, type ViewerPresentationMode } from './live-viewer-presentation.js';
import {
  capturePageMotion,
  inspectPageMotion,
  type MotionCaptureMode,
  type MotionCaptureValue,
  type MotionTrajectory,
} from './motion-capture-engine.js';

const MAX_SESSIONS = 4;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_INTERACTION_OPERATIONS = 2_048;
const INTERACTION_SETTLE_MS = 100;
const HUMAN_REQUEST_TTL_MS = 5 * 60_000;
const POST_HUMAN_SESSION_TTL_MS = 30 * 60_000;
const HUMAN_CONTROL_TTL_MS = 15 * 60_000;
const MAX_VIEWER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_SCREENSHOT_BASE64_BYTES = MAX_BROKER_FRAME_BYTES - 128 * 1024;
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
  readonly frame: View;
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
  dialogOpen: boolean;
  /** Viewport realmente renderizado. Cambia con `browser.viewport` (ADR-0042). */
  currentViewport: { width: number; height: number; mobile: boolean };
  /** Viewport del agente que se reaplica al terminar el intervalo humano. */
  agentViewportBeforeHuman?: { width: number; height: number; mobile: boolean };
  viewerCapturePromise?: Promise<BrowserViewerFrame>;
  restoreLiveViewerAfterHuman?: boolean;
  previousViewerWorkArea?: LiveViewerWorkArea;
  readonly agentIdleWaiters: Array<() => void>;
  agentShellUrl: string;
  trustedShellUrl: string;
  motionCapture?: { readonly completed: number; readonly total: number; readonly mode: MotionCaptureMode };
  lastMotionCapture?: BrowserMotionCaptureSummary;
  viewerPresentation?: BrowserViewerPresentation;
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
  readonly viewport: { readonly width: number; readonly height: number; readonly mobile: boolean };
  readonly motionCapture?: { readonly completed: number; readonly total: number; readonly mode: MotionCaptureMode };
  readonly lastMotionCapture?: BrowserMotionCaptureSummary;
  readonly viewerPresentation?: BrowserViewerPresentation;
}

export interface BrowserMotionCaptureSummary {
  readonly path: string;
  readonly frameCount: number;
  readonly totalSize: number;
  readonly captureMode: 'stepped' | 'screencast';
  readonly warnings: readonly string[];
}

export interface BrowserViewerPresentation {
  readonly mode: ViewerPresentationMode;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
  readonly contentBounds: LiveViewerWorkArea;
  readonly workArea: LiveViewerWorkArea;
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
  readonly beforeHumanControlRequest?: () => Promise<void>;
  readonly reserveHumanControl?: (sessionId: string) => void | Promise<void>;
  readonly releaseHumanControl?: (sessionId: string) => void;
  readonly restoreLiveViewerAfterHuman?: (sessionId: string, workArea: LiveViewerWorkArea) => Promise<void>;
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
  readonly onMotionDiagnostic?: (event: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly outcome: 'failed';
    readonly causeCode?: string;
    readonly operationId: string;
  }) => void;
  readonly saveScreenshot?: (input: {
    readonly workspaceId: string;
    readonly expectedWorkspace: AuthorizedWorkspace;
    readonly path: string;
    readonly bytes: Uint8Array;
  }) => Promise<{ path: string; sha256: string; size: number; created: true }>;
  readonly saveMotionBundle?: (input: {
    readonly workspaceId: string;
    readonly expectedWorkspace: AuthorizedWorkspace;
    readonly path: string;
    readonly produce: (writer: WorkspaceArtifactWriter) => Promise<MotionCaptureValue>;
  }) => Promise<WorkspaceArtifactDirectoryResult<MotionCaptureValue>>;
}

interface ElementState {
  readonly attached: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly checked: boolean;
  readonly selected: boolean;
  readonly receivesPointer: boolean;
  readonly fileInput: boolean;
  readonly select: boolean;
}

interface InteractionOperationRecord {
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly result: unknown;
}

interface MotionOperationRecord {
  readonly fingerprint: string;
  readonly sessionId: string;
  state: 'pending' | 'complete' | 'uncertain';
  result?: unknown;
  causeCode?: string;
}

interface AppliedInteractionResult {
  readonly sessionId: string;
  readonly applied: true;
  readonly snapshotInvalidated: true;
}

interface BrowserViewportResult {
  readonly sessionId: string;
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
  readonly state: 'running' | 'stopped';
}

function fail(code: string, message: string, causeCode?: string): never {
  throw new DevelopmentBrokerError(code, message, causeCode);
}

function safeCauseCode(error: unknown): string | undefined {
  const candidate = error instanceof DevelopmentBrokerError
    ? error.causeCode ?? error.code
    : error instanceof LocalBridgeError
      ? (typeof error.details?.['causeCode'] === 'string' ? error.details['causeCode'] : error.code)
      : undefined;
  return candidate !== undefined && candidate !== 'MOTION_EFFECT_UNCERTAIN' &&
    (ERROR_CODES as readonly string[]).includes(candidate) ? candidate : undefined;
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

function capturedImageDimensions(
  dataBase64: string,
  mimeType: 'image/png' | 'image/jpeg',
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const bytes = Buffer.from(dataBase64, 'base64');
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return fallback;
}

function interactionFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
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
    viewport: entry.currentViewport,
    ...(entry.motionCapture === undefined ? {} : { motionCapture: entry.motionCapture }),
    ...(entry.lastMotionCapture === undefined ? {} : { lastMotionCapture: entry.lastMotionCapture }),
    ...(entry.viewerPresentation === undefined ? {} : { viewerPresentation: entry.viewerPresentation }),
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

function agentShellHtml(workspaceName: string, origin: string, presentation?: BrowserViewerPresentation): string {
  const metrics = presentation === undefined ? 'Preparando vista…' :
    `Render ${presentation.renderWidth}×${presentation.renderHeight} · Vista ${presentation.viewWidth}×${presentation.viewHeight} · ${new Intl.NumberFormat('es-PE', { style: 'percent', maximumFractionDigits: 1 }).format(presentation.scale)} · ${presentation.mode === 'fit' ? 'Encajar' : `1:1 · pan ${presentation.panX},${presentation.panY}`}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Vista en vivo — LocalBridge</title><style>body{margin:0;font:14px system-ui;background:#10243e;color:#fff}.bar{height:${AUTH_TOOLBAR_HEIGHT}px;box-sizing:border-box;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:20px}.title{font-weight:800;font-size:17px}.meta{color:#c7d7e9;margin-top:4px}.metrics{color:#8ff1df;margin-top:4px;font-weight:700}.badge{padding:9px 12px;border:1px solid #55d6be;border-radius:999px;color:#8ff1df;font-weight:800}.notice{color:#ffd18c;margin-top:4px}</style></head><body><div class="bar"><div><div class="title">Vista en vivo · solo lectura — ${escapeHtml(workspaceName)}</div><div class="meta">${escapeHtml(origin)}</div><div class="metrics">${escapeHtml(metrics)}</div><div class="notice">ChatGPT controla esta sesión. Ajusta la presentación desde Actividad.</div></div><div class="badge">Sin ratón ni teclado</div></div></body></html>`;
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
  private readonly interactionOperations = new Map<string, InteractionOperationRecord>();
  private readonly motionOperations = new Map<string, MotionOperationRecord>();
  private readonly reconciliationTimer: NodeJS.Timeout;
  private humanSessionId: string | undefined;
  private liveViewerSessionId: string | undefined;
  private liveViewerWorkArea: LiveViewerWorkArea | undefined;

  constructor(private readonly options: BrowserControllerOptions) {
    this.reconciliationTimer = setInterval(() => { void this.reconcile(); }, options.reconciliationIntervalMs ?? 2_000);
    this.reconciliationTimer.unref();
  }

  private hideLiveViewerEntry(entry: ManagedBrowserSession, notify = true): void {
    if (this.liveViewerSessionId !== entry.sessionId) return;
    this.liveViewerSessionId = undefined;
    this.liveViewerWorkArea = undefined;
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

  private async positionLiveViewer(
    entry: ManagedBrowserSession,
    workArea: LiveViewerWorkArea,
    mode: ViewerPresentationMode = entry.viewerPresentation?.mode ?? 'fit',
    pan: { readonly x: number; readonly y: number } = { x: entry.viewerPresentation?.panX ?? 0, y: entry.viewerPresentation?.panY ?? 0 },
  ): Promise<void> {
    let presentation;
    try {
      const outer = entry.window.getBounds();
      const content = entry.window.getContentBounds();
      presentation = resolveViewerPresentation(entry.currentViewport, AUTH_TOOLBAR_HEIGHT, workArea, {
        width: Math.max(0, outer.width - content.width),
        height: Math.max(0, outer.height - content.height),
      }, mode, pan);
    } catch {
      fail('INVALID_INPUT', 'El área de pantalla no es válida.');
    }
    entry.window.setBounds(presentation.bounds, false);
    entry.frame.setBounds({
      x: 0,
      y: AUTH_TOOLBAR_HEIGHT,
      width: presentation.visibleContentWidth,
      height: presentation.visibleContentHeight,
    });
    entry.content.setBounds(presentation.contentBounds);
    await entry.content.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: entry.currentViewport.width,
      height: entry.currentViewport.height,
      deviceScaleFactor: 1,
      mobile: entry.currentViewport.mobile,
      scale: presentation.scale,
    });
    entry.viewerPresentation = {
      mode: presentation.mode,
      renderWidth: entry.currentViewport.width,
      renderHeight: entry.currentViewport.height,
      viewWidth: presentation.visibleContentWidth,
      viewHeight: presentation.visibleContentHeight,
      scale: presentation.scale,
      panX: presentation.panX,
      panY: presentation.panY,
      contentBounds: presentation.contentBounds,
      workArea,
    };
    entry.agentShellUrl = `data:text/html;charset=utf-8,${encodeURIComponent(agentShellHtml(entry.workspaceName, entry.profile.origin, entry.viewerPresentation))}`;
    entry.trustedShellUrl = entry.agentShellUrl;
    if (entry.window.webContents.getURL() !== entry.agentShellUrl) await entry.window.loadURL(entry.agentShellUrl);
  }

  async showLiveViewerLocally(sessionId: string, workArea: LiveViewerWorkArea, mode?: ViewerPresentationMode): Promise<void> {
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
    await this.positionLiveViewer(entry, workArea, mode ?? entry.viewerPresentation?.mode ?? 'fit', { x: 0, y: 0 });
    entry.window.showInactive();
    this.liveViewerSessionId = sessionId;
    this.liveViewerWorkArea = workArea;
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
    await this.positionLiveViewer(entry, workArea);
    this.liveViewerWorkArea = workArea;
    entry.window.showInactive();
    this.options.onActivityChange?.();
  }

  async setLiveViewerPresentationLocally(
    sessionId: string,
    mode: ViewerPresentationMode,
    panX = 0,
    panY = 0,
  ): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running' || entry.window.isDestroyed() ||
        this.liveViewerSessionId !== sessionId || this.liveViewerWorkArea === undefined) {
      fail('SESSION_NOT_FOUND', 'La ventana en vivo no está abierta para esta sesión.');
    }
    await this.requireWorkspace(entry.workspaceId);
    this.ensureAgentControl(entry);
    await this.positionLiveViewer(entry, this.liveViewerWorkArea, mode, { x: panX, y: panY });
    entry.window.showInactive();
    this.options.onActivityChange?.();
  }

  cancelMotionLocally(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== 'running') return;
    if (entry.motionCapture !== undefined) entry.generation += 1;
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

  private async resolveElements(entry: ManagedBrowserSession, snapshotId: string, elementRefs: readonly string[]) {
    const snapshot = entry.snapshot;
    if (snapshot === undefined || snapshot.snapshotId !== snapshotId || snapshot.generation !== entry.generation) {
      fail('STALE_SNAPSHOT', 'El snapshot ya no representa el documento actual.');
    }
    const bindings = elementRefs.map((elementRef) => snapshot.elements.get(elementRef));
    if (bindings.some((binding) => binding === undefined)) fail('STALE_SNAPSHOT', 'La referencia no pertenece al snapshot vigente.');
    const existingBindings = bindings as ElementBinding[];
    await entry.content.webContents.debugger.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
    const pushed = await entry.content.webContents.debugger.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: existingBindings.map((binding) => binding.backendNodeId),
    }) as { nodeIds?: number[] };
    const nodeIds = pushed.nodeIds;
    if (nodeIds === undefined || nodeIds.length !== existingBindings.length || nodeIds.some((nodeId) => nodeId === 0)) {
      fail('STALE_SNAPSHOT', 'El elemento ya no existe.');
    }
    return existingBindings.map((binding, index) => ({ nodeId: nodeIds[index] as number, binding }));
  }

  private async resolveElement(entry: ManagedBrowserSession, snapshotId: string, elementRef: string) {
    return (await this.resolveElements(entry, snapshotId, [elementRef]))[0] as { nodeId: number; binding: ElementBinding };
  }

  private async inspectElement(entry: ManagedBrowserSession, nodeId: number): Promise<ElementState> {
    const resolved = await entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId }) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) fail('STALE_SNAPSHOT', 'El elemento ya no es interactuable.');
    try {
      const inspected = await entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const element = this;
          if (!(element instanceof Element) || !element.isConnected) {
            return { attached: false, visible: false, enabled: false, checked: false, selected: false, receivesPointer: false, fileInput: false, select: false };
          }
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
          const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
          const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
          const hit = visible ? document.elementFromPoint(x, y) : null;
          const receivesPointer = hit !== null && (hit === element || element.contains(hit));
          const disabledProperty = 'disabled' in element && Boolean(element.disabled);
          const enabled = !disabledProperty && element.getAttribute('aria-disabled') !== 'true';
          const checked = 'checked' in element ? Boolean(element.checked) : element.getAttribute('aria-checked') === 'true';
          const selected = 'selected' in element ? Boolean(element.selected) : element.getAttribute('aria-selected') === 'true';
          const fileInput = element.matches('input[type="file"]') ||
            (element.matches('label') && ((element.control instanceof HTMLInputElement && element.control.type === 'file') || element.querySelector('input[type="file"]') !== null));
          return { attached: true, visible, enabled, checked, selected, receivesPointer, fileInput, select: element instanceof HTMLSelectElement };
        }`,
        returnByValue: true,
      }) as { result?: { value?: ElementState } };
      return inspected.result?.value ?? {
        attached: false,
        visible: false,
        enabled: false,
        checked: false,
        selected: false,
        receivesPointer: false,
        fileInput: false,
        select: false,
      };
    } finally {
      await entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  private async elementPoint(entry: ManagedBrowserSession, nodeId: number): Promise<{ x: number; y: number }> {
    let model: { model?: { border?: number[] } };
    try {
      model = await entry.content.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId }) as { model?: { border?: number[] } };
    } catch {
      fail('ELEMENT_NOT_INTERACTABLE', 'El elemento no tiene geometría interactuable.');
    }
    const border = model.model?.border;
    if (border === undefined || border.length < 8) fail('ELEMENT_NOT_INTERACTABLE', 'El elemento no tiene geometría interactuable.');
    const x = ((border[0] ?? 0) + (border[2] ?? 0) + (border[4] ?? 0) + (border[6] ?? 0)) / 4;
    const y = ((border[1] ?? 0) + (border[3] ?? 0) + (border[5] ?? 0) + (border[7] ?? 0)) / 4;
    return { x, y };
  }

  private previousInteraction<T = AppliedInteractionResult>(operationKey: string | undefined, fingerprint: string): T | undefined {
    if (operationKey === undefined) return undefined;
    const previous = this.interactionOperations.get(operationKey);
    if (previous === undefined) return undefined;
    if (previous.fingerprint !== fingerprint) {
      fail('IDEMPOTENCY_CONFLICT', 'El operationId ya se usó con otra interacción.');
    }
    return previous.result as T;
  }

  private async conditionSatisfied(entry: ManagedBrowserSession, condition: BrowserCondition): Promise<boolean> {
    if (condition.kind === 'path') {
      const path = safePathFromUrl(entry.content.webContents.getURL());
      return condition.operator === 'equals' ? path === condition.value : path.includes(condition.value);
    }
    if (condition.kind === 'title') {
      const title = entry.content.webContents.getTitle();
      return condition.operator === 'equals' ? title === condition.value : title.includes(condition.value);
    }
    if (condition.kind === 'text') {
      const tree = await entry.content.webContents.debugger.sendCommand('Accessibility.getFullAXTree') as {
        nodes?: Array<Record<string, unknown>>;
      };
      const present = (tree.nodes ?? []).some((node) => {
        const role = stringValue((node['role'] as Record<string, unknown> | undefined)?.['value']);
        if (role === 'password') return false;
        const name = stringValue((node['name'] as Record<string, unknown> | undefined)?.['value']);
        const value = stringValue((node['value'] as Record<string, unknown> | undefined)?.['value']);
        return name.includes(condition.value) || value.includes(condition.value);
      });
      return condition.state === 'present' ? present : !present;
    }
    if (condition.kind === 'element') {
      let actual = false;
      try {
        const { nodeId } = await this.resolveElement(entry, condition.snapshotId, condition.elementRef);
        if (condition.state === 'attached') {
          actual = true;
        } else {
          const state = await this.inspectElement(entry, nodeId);
          actual = state[condition.state];
        }
      } catch (error) {
        if (!(error instanceof DevelopmentBrokerError) || error.code !== 'STALE_SNAPSHOT') throw error;
      }
      return actual === condition.expected;
    }
    if (condition.kind === 'response') {
      return entry.events.some((event) => event.cursor >= condition.afterCursor && event.type === 'network' &&
        event.path === condition.path && (condition.status === undefined || event.message === `HTTP ${condition.status}`));
    }
    if (condition.kind === 'no-console-errors') {
      return !entry.events.some((event) => event.cursor >= condition.afterCursor &&
        (event.type === 'error' || (event.type === 'console' && ['error', 'assert'].includes(event.level))));
    }
    return condition.state === (entry.dialogOpen ? 'open' : 'closed');
  }

  private invalidateSnapshot(entry: ManagedBrowserSession): void {
    entry.generation += 1;
    delete entry.snapshot;
  }

  private rememberInteractionOperation<T extends { readonly sessionId: string }>(
    operationKey: string | undefined,
    fingerprint: string,
    result: T,
  ): void {
    if (operationKey === undefined) return;
    this.interactionOperations.delete(operationKey);
    this.interactionOperations.set(operationKey, { fingerprint, sessionId: result.sessionId, result });
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
        } else if (method === 'Page.javascriptDialogOpening') {
          entry.dialogOpen = true;
        } else if (method === 'Page.javascriptDialogClosed') {
          entry.dialogOpen = false;
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
    await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: entry.currentViewport.width,
      height: entry.currentViewport.height,
      deviceScaleFactor: 1,
      mobile: entry.currentViewport.mobile,
    });
    await webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: entry.currentViewport.mobile,
      ...(entry.currentViewport.mobile ? { maxTouchPoints: 5 } : {}),
    }).catch(() => undefined);
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
    const frame = new View();
    const content = new WebContentsView({ webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      backgroundThrottling: false,
    } });
    window.contentView.addChildView(frame);
    frame.addChildView(content);
    // eslint-disable-next-line prefer-const -- el primer layout ocurre antes de enlazar la sesión administrada
    let currentEntry: ManagedBrowserSession | undefined;
    const resizeContent = (): void => {
      if (currentEntry?.controlState === 'agent_control' && currentEntry.viewerPresentation !== undefined) {
        const presentation = currentEntry.viewerPresentation;
        frame.setBounds({ x: 0, y: AUTH_TOOLBAR_HEIGHT, width: presentation.viewWidth, height: presentation.viewHeight });
        content.setBounds(presentation.contentBounds);
        return;
      }
      const bounds = window.getContentBounds();
      frame.setBounds({ x: 0, y: AUTH_TOOLBAR_HEIGHT, width: bounds.width, height: Math.max(1, bounds.height - AUTH_TOOLBAR_HEIGHT) });
      content.setBounds({ x: 0, y: 0, width: bounds.width, height: Math.max(1, bounds.height - AUTH_TOOLBAR_HEIGHT) });
    };
    resizeContent();
    window.on('resize', resizeContent);
    const entry: ManagedBrowserSession = {
      sessionId,
      workspaceId,
      profileName,
      profile,
      window,
      frame,
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
      dialogOpen: false,
      currentViewport: { width: profile.viewport.width, height: profile.viewport.height, mobile: false },
      agentIdleWaiters: [],
      agentShellUrl,
      trustedShellUrl: agentShellUrl,
    };
    currentEntry = entry;
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
      viewport: { width: 1920, height: 1080 },
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
      viewport: { width: 1920, height: 1080 },
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

  async navigate(workspaceId: string, sessionId: string, relativePath: string, operationId?: string): Promise<BrowserSessionSummary> {
    const entry = await this.requireSession(workspaceId, sessionId);
    if (!relativePath.startsWith('/') || relativePath.startsWith('//') || relativePath.includes('\\')) {
      fail('ORIGIN_BLOCKED', 'La navegación debe usar una ruta relativa al origen aprobado.');
    }
    const destination = new URL(relativePath, entry.profile.origin);
    if (!entry.profile.allowedOrigins.includes(destination.origin)) fail('ORIGIN_BLOCKED', 'El origen no está aprobado.');
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.navigate', destination.toString()]);
    const previous = this.previousInteraction<BrowserSessionSummary>(operationKey, fingerprint);
    if (previous !== undefined) {
      if (entry.content.webContents.getURL() === destination.toString()) return previous;
      fail('IDEMPOTENCY_CONFLICT', 'La sesión navegó después de la operación original.');
    }
    return this.withAgentOperation(entry, async () => {
      try {
        await entry.content.webContents.loadURL(destination.toString());
      } catch {
        fail('FEATURE_UNAVAILABLE', 'La navegación local falló.');
      }
      const result = summary(entry);
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
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
      let truncated = false;
      for (const node of nodes) {
        if (node['ignored'] === true) continue;
        let depth = 0;
        let parentId = stringValue(node['parentId']);
        while (parentId !== '' && depth <= maxDepth) {
          depth += 1;
          parentId = stringValue(byId.get(parentId)?.['parentId']);
        }
        if (depth > maxDepth) {
          truncated = true;
          continue;
        }
        if (output.length >= maxElements) {
          truncated = true;
          continue;
        }
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
      return { snapshotId, title: entry.content.webContents.getTitle().slice(0, 256), path: safePathFromUrl(entry.content.webContents.getURL()), nodes: output, truncated };
    });
  }

  private async captureScreenshotData(entry: ManagedBrowserSession, transportBounded = true): Promise<{
    mimeType: 'image/png' | 'image/jpeg'; dataBase64: string; width: number; height: number; fallbackUsed: boolean;
  }> {
    const capture = async (format: 'png' | 'jpeg', quality?: number): Promise<string> => {
      const invoke = () => entry.content.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format, ...(quality === undefined ? {} : { quality }), fromSurface: true, captureBeyondViewport: false,
      }) as Promise<{ data?: unknown }>;
      let captured: { data?: unknown };
      try {
        captured = await invoke();
      } catch {
        try {
          await entry.content.webContents.debugger.sendCommand('Page.enable');
          captured = await invoke();
        } catch {
          fail('WEB_CAPTURE_FAILED', 'El navegador local no pudo completar la captura tras un reintento seguro.');
        }
      }
      if (typeof captured.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(captured.data)) {
        fail('WEB_CAPTURE_FAILED', 'El navegador local no devolvió una captura válida.');
      }
      const bytes = Buffer.from(captured.data, 'base64');
      const valid = format === 'png'
        ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
      if (!valid) fail('WEB_CAPTURE_FAILED', 'El navegador local devolvió una imagen con firma inválida.');
      return captured.data;
    };
    const png = await capture('png');
    if (!transportBounded || Buffer.byteLength(png, 'utf8') <= MAX_SCREENSHOT_BASE64_BYTES) {
      return { mimeType: 'image/png', dataBase64: png, ...capturedImageDimensions(png, 'image/png', entry.currentViewport), fallbackUsed: false };
    }
    for (const quality of [85, 70]) {
      const jpeg = await capture('jpeg', quality);
      if (Buffer.byteLength(jpeg, 'utf8') <= MAX_SCREENSHOT_BASE64_BYTES) {
        return { mimeType: 'image/jpeg', dataBase64: jpeg, ...capturedImageDimensions(jpeg, 'image/jpeg', entry.currentViewport), fallbackUsed: true };
      }
    }
    fail('WEB_CAPTURE_TOO_LARGE', 'La captura local supera el presupuesto seguro del broker.');
  }

  async screenshot(workspaceId: string, sessionId: string) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, () => this.captureScreenshotData(entry));
  }

  async saveScreenshot(workspaceId: string, sessionId: string, destinationPath: string, operationId: string) {
    const entry = await this.requireSession(workspaceId, sessionId);
    const expectedWorkspace = await this.requireWorkspace(workspaceId);
    if (this.options.saveScreenshot === undefined) fail('FEATURE_UNAVAILABLE', 'El guardado de evidencia visual no está disponible.');
    const operationKey = `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.screenshot.save', destinationPath]);
    const previous = this.previousInteraction<{
      readonly sessionId: string; readonly path: string; readonly sha256: string; readonly size: number; readonly created: true;
      readonly mimeType: 'image/png'; readonly width: number; readonly height: number; readonly fallbackUsed: false; readonly sourcePath: string;
    }>(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    return this.withAgentOperation(entry, async () => {
      if (!destinationPath.toLowerCase().endsWith('.png')) fail('INVALID_INPUT', 'La evidencia de navegador local debe guardarse como PNG.');
      const captured = await this.captureScreenshotData(entry, false);
      const bytes = Buffer.from(captured.dataBase64, 'base64');
      const saved = await this.options.saveScreenshot!({ workspaceId, expectedWorkspace, path: destinationPath, bytes });
      const result = {
        sessionId, ...saved, mimeType: 'image/png' as const,
        width: captured.width, height: captured.height, fallbackUsed: false as const,
        sourcePath: safePathFromUrl(entry.content.webContents.getURL()),
      };
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
    });
  }

  async inspectMotion(workspaceId: string, sessionId: string, maxAnimations: number) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, () => inspectPageMotion(
      entry.content.webContents,
      entry.currentViewport,
      entry.generation,
      maxAnimations,
      'motion',
    ));
  }

  async captureMotion(
    workspaceId: string,
    sessionId: string,
    destinationPath: string,
    trajectory: MotionTrajectory,
    settleBeforeMs: number,
    captureMode: MotionCaptureMode,
    operationId: string,
  ) {
    const entry = await this.requireSession(workspaceId, sessionId);
    const expectedWorkspace = await this.requireWorkspace(workspaceId);
    if (this.options.saveMotionBundle === undefined) fail('FEATURE_UNAVAILABLE', 'La captura temporal no está disponible.');
    if (!destinationPath.toLowerCase().endsWith('.lbmotion')) fail('INVALID_INPUT', 'La traza temporal debe guardarse como un directorio .lbmotion nuevo.');
    const operationKey = `${workspaceId}:${sessionId}:${operationId}`;
    const operationFingerprint = interactionFingerprint([
      'browser.motion.capture', destinationPath, trajectory, settleBeforeMs, captureMode,
    ]);
    const previous = this.motionOperations.get(operationKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== operationFingerprint) fail('IDEMPOTENCY_CONFLICT', 'El operationId ya representa otra captura temporal.');
      if (previous.state !== 'complete') fail('MOTION_EFFECT_UNCERTAIN', 'La captura temporal anterior pudo desplazar la página; no se repetirá automáticamente.', previous.causeCode);
      return previous.result;
    }
    const record: MotionOperationRecord = {
      fingerprint: operationFingerprint,
      sessionId,
      state: 'pending',
    };
    this.motionOperations.set(operationKey, record);
    while (this.motionOperations.size > MAX_INTERACTION_OPERATIONS) {
      this.motionOperations.delete(this.motionOperations.keys().next().value as string);
    }
    let effectStarted = false;
    const generation = entry.generation;
    try {
      entry.motionCapture = { completed: 0, total: trajectory.sampleCount, mode: captureMode };
      this.options.onActivityChange?.();
      const result = await this.withAgentOperation(entry, async () => {
        const saved = await this.options.saveMotionBundle!({
          workspaceId,
          expectedWorkspace,
          path: destinationPath,
          produce: (writer) => capturePageMotion({
            webContents: entry.content.webContents,
            writer,
            viewport: entry.currentViewport,
            trajectory,
            settleBeforeMs,
            captureMode,
            sourceFamily: 'browser',
            source: { path: safePathFromUrl(entry.content.webContents.getURL()) },
            generation,
            assertCurrent: () => {
              if (entry.generation !== generation) fail('MOTION_CAPTURE_INTERRUPTED', 'La página cambió durante la captura temporal.');
              this.ensureAgentControl(entry);
              if (entry.state !== 'running' || entry.content.webContents.isDestroyed()) {
                fail('MOTION_CAPTURE_INTERRUPTED', 'La sesión terminó durante la captura temporal.');
              }
            },
            onEffectStart: () => { effectStarted = true; },
            onProgress: (progress) => {
              entry.motionCapture = { ...progress, mode: captureMode };
              this.options.onActivityChange?.();
            },
          }),
        });
        this.invalidateSnapshot(entry);
        return {
          sessionId,
          path: saved.path,
          created: saved.created,
          totalSize: saved.totalSize,
          fileCount: saved.fileCount,
          manifestPath: `${saved.path}/${saved.value.manifest.path}`,
          contactSheetPath: `${saved.path}/${saved.value.contactSheet.path}`,
          frameCount: saved.value.frameCount,
          width: saved.value.width,
          height: saved.value.height,
          captureMode: saved.value.captureMode,
          temporalFidelity: saved.value.temporalFidelity,
          droppedFrames: saved.value.droppedFrames,
          warnings: saved.value.warnings,
          sourcePath: safePathFromUrl(entry.content.webContents.getURL()),
        };
      });
      entry.lastMotionCapture = {
        path: result.path,
        frameCount: result.frameCount,
        totalSize: result.totalSize,
        captureMode: result.captureMode,
        warnings: result.warnings,
      };
      record.state = 'complete';
      record.result = result;
      return result;
    } catch (error) {
      if (!effectStarted) this.motionOperations.delete(operationKey);
      else {
        record.state = 'uncertain';
        const causeCode = safeCauseCode(error);
        if (causeCode !== undefined) record.causeCode = causeCode;
        this.options.onMotionDiagnostic?.({
          workspaceId: entry.workspaceId,
          sessionId,
          outcome: 'failed',
          operationId,
          ...(causeCode === undefined ? {} : { causeCode }),
        });
        fail('MOTION_EFFECT_UNCERTAIN', 'La captura se interrumpió después de desplazar la página; comprueba el estado antes de reintentar.', causeCode);
      }
      throw error;
    } finally {
      delete entry.motionCapture;
      this.options.onActivityChange?.();
    }
  }

  /**
   * Emula un viewport para probar diseño responsive (ADR-0042).
   *
   * Usa `Emulation.setDeviceMetricsOverride` en lugar de redimensionar la
   * ventana: así el tamaño no queda limitado por la pantalla física, no altera
   * lo que ve el usuario en el visor en vivo y las capturas ya salen al tamaño
   * emulado, porque pasan por el mismo canal CDP.
   *
   * No concede ninguna capacidad nueva: no cambia el origen permitido, no
   * navega y no interactúa con la página. Sí invalida el snapshot vigente,
   * porque tras el reflow las referencias de elementos dejan de ser válidas.
   */
  async setViewport(workspaceId: string, sessionId: string, width: number, height: number, mobile: boolean, operationId?: string) {
    const entry = await this.requireSession(workspaceId, sessionId);
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.viewport', width, height, mobile]);
    const previous = this.previousInteraction<BrowserViewportResult>(operationKey, fingerprint);
    if (previous !== undefined) {
      if (entry.currentViewport.width === width && entry.currentViewport.height === height && entry.currentViewport.mobile === mobile) return previous;
      fail('IDEMPOTENCY_CONFLICT', 'El viewport cambió después de la operación original.');
    }
    return this.withAgentOperation(entry, async () => {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 3840 || height < 320 || height > 2160) {
        fail('INVALID_INPUT', 'Las dimensiones del viewport están fuera del rango permitido.');
      }
      await entry.content.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
      if (mobile) {
        await entry.content.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
          .catch(() => undefined);
      } else {
        await entry.content.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
          .catch(() => undefined);
      }
      entry.currentViewport = { width, height, mobile };
      this.invalidateSnapshot(entry);
      await waitForInteractionToSettle();
      if (this.liveViewerSessionId === sessionId && this.liveViewerWorkArea !== undefined) {
        await this.positionLiveViewer(entry, this.liveViewerWorkArea);
      }
      // La evidencia queda en la auditoría, no en el flujo de eventos de la
      // página: `browser.events` describe consola y red del sitio, no acciones
      // del agente.
      const result = { sessionId, width, height, mobile, state: entry.state };
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
    });
  }

  /** Devuelve la sesión al viewport declarado por su perfil. */
  private async clearViewportEmulation(entry: ManagedBrowserSession): Promise<void> {
    if (entry.currentViewport.width === entry.profile.viewport.width
      && entry.currentViewport.height === entry.profile.viewport.height
      && !entry.currentViewport.mobile) return;
    await entry.content.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    await entry.content.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => undefined);
    entry.currentViewport = { width: entry.profile.viewport.width, height: entry.profile.viewport.height, mobile: false };
    this.invalidateSnapshot(entry);
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

  async assert(workspaceId: string, sessionId: string, condition: BrowserCondition) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, async () => {
      if (!(await this.conditionSatisfied(entry, condition))) fail('ASSERTION_FAILED', 'La condición del navegador no se cumple.');
      return { sessionId, satisfied: true as const, conditionKind: condition.kind };
    });
  }

  async wait(workspaceId: string, sessionId: string, condition: BrowserCondition, timeoutMs: number) {
    const entry = await this.requireSession(workspaceId, sessionId);
    return this.withAgentOperation(entry, async () => {
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      do {
        if (await this.conditionSatisfied(entry, condition)) {
          return { sessionId, satisfied: true as const, conditionKind: condition.kind, waitedMs: Date.now() - startedAt };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      } while (Date.now() < deadline);
      fail('TIMEOUT', 'La condición del navegador no se cumplió dentro del límite.');
    });
  }

  async click(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.click', snapshotId, elementRef]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
    entry.content.webContents.focus();
    await entry.content.webContents.debugger.sendCommand('Page.bringToFront');
    const { nodeId } = await this.resolveElement(entry, snapshotId, elementRef);
    const chooserCount = entry.blockedFileChooserCount;
    const state = await this.inspectElement(entry, nodeId);
    if (state.fileInput) fail('SENSITIVE_INPUT_BLOCKED', 'El selector de archivos requiere control humano exclusivo.');
    if (!state.visible || !state.enabled || !state.receivesPointer) {
      fail('ELEMENT_NOT_INTERACTABLE', 'El elemento no puede recibir un clic real.');
    }
    const resolved = await entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId }) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) fail('STALE_SNAPSHOT', 'El elemento ya no existe.');
    const releaseObject = async (): Promise<void> => {
      await entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    };
    try {
      // Electron no entrega mouseDown/mouseUp de sendInputEvent a un
      // WebContentsView en Windows de forma fiable. Se emite una secuencia fija
      // de puntero y se activa el elemento con gesto de usuario; no se acepta JS,
      // selectores ni coordenadas desde MCP.
      const activation = entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const options = { bubbles: true, cancelable: true, composed: true, view: window };
          this.dispatchEvent(new PointerEvent('pointerover', options));
          this.dispatchEvent(new MouseEvent('mouseover', options));
          this.dispatchEvent(new PointerEvent('pointerenter', { ...options, bubbles: false }));
          this.dispatchEvent(new MouseEvent('mouseenter', { ...options, bubbles: false }));
          this.dispatchEvent(new PointerEvent('pointerdown', options));
          this.dispatchEvent(new MouseEvent('mousedown', options));
          this.dispatchEvent(new PointerEvent('pointerup', options));
          this.dispatchEvent(new MouseEvent('mouseup', options));
          this.click();
        }`,
        userGesture: true,
      });
      const outcome = await Promise.race([
        activation.then(() => 'completed' as const),
        (async () => {
          const deadline = Date.now() + 500;
          while (Date.now() < deadline) {
            if (entry.dialogOpen) return 'dialog' as const;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return 'pending' as const;
        })(),
      ]);
      if (outcome === 'dialog') {
        void activation.finally(releaseObject).catch(() => undefined);
      } else {
        await activation;
        await releaseObject();
      }
    } finally {
      if (!entry.dialogOpen) await releaseObject();
    }
    await waitForInteractionToSettle();
    if (entry.blockedFileChooserCount !== chooserCount) {
      fail('SENSITIVE_INPUT_BLOCKED', 'El selector de archivos requiere control humano exclusivo.');
    }
    this.invalidateSnapshot(entry);
    const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
    this.assertAgentOperation(entry, epoch);
    this.rememberInteractionOperation(operationKey, fingerprint, result);
    return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async fill(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, text: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.fill', snapshotId, elementRef, text]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
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
    // La clasificación vive en desktop-core para poder probarla campo a campo
    // (ADR-0041): compara tokens, no subcadenas.
    const identity = [
      attributeMap.get('name'),
      attributeMap.get('id'),
      attributeMap.get('aria-label'),
      attributeMap.get('placeholder'),
    ].filter((value) => value !== undefined).join(' ');
    if (isSensitiveInput({
      inputType: attributeMap.get('type'),
      autocomplete: attributeMap.get('autocomplete'),
      identity,
    })) {
      fail('SENSITIVE_INPUT_BLOCKED', 'El campo se clasifica como sensible.');
    }

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
    this.rememberInteractionOperation(operationKey, fingerprint, result);
    return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async press(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, key: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.press', snapshotId, elementRef, key]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
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
    this.rememberInteractionOperation(operationKey, fingerprint, result);
    return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async hover(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.hover', snapshotId, elementRef]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
      entry.content.webContents.focus();
      await entry.content.webContents.debugger.sendCommand('Page.bringToFront');
      const { nodeId } = await this.resolveElement(entry, snapshotId, elementRef);
      const state = await this.inspectElement(entry, nodeId);
      if (!state.visible || !state.receivesPointer) fail('ELEMENT_NOT_INTERACTABLE', 'El elemento no puede recibir hover.');
      const resolved = await entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId }) as { object?: { objectId?: string } };
      const objectId = resolved.object?.objectId;
      if (objectId === undefined) fail('STALE_SNAPSHOT', 'El elemento ya no existe.');
      try {
        await entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function () {
            const options = { bubbles: true, cancelable: true, composed: true, view: window };
            this.dispatchEvent(new PointerEvent('pointerover', options));
            this.dispatchEvent(new MouseEvent('mouseover', options));
            this.dispatchEvent(new PointerEvent('pointerenter', { ...options, bubbles: false }));
            this.dispatchEvent(new MouseEvent('mouseenter', { ...options, bubbles: false }));
          }`,
          userGesture: true,
        });
      } finally {
        await entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
      await waitForInteractionToSettle();
      this.invalidateSnapshot(entry);
      const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
      this.assertAgentOperation(entry, epoch);
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async scroll(workspaceId: string, sessionId: string, direction: 'up' | 'down' | 'left' | 'right', amount: number, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.scroll', direction, amount]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
      const horizontal = direction === 'left' || direction === 'right';
      const deltaX = horizontal ? (direction === 'left' ? -amount : amount) : 0;
      const deltaY = horizontal ? 0 : (direction === 'up' ? -amount : amount);
      await entry.content.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `globalThis.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'instant' })`,
        userGesture: true,
      });
      await waitForInteractionToSettle();
      this.invalidateSnapshot(entry);
      const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
      this.assertAgentOperation(entry, epoch);
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async select(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, value: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.select', snapshotId, elementRef, value]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
      const { nodeId } = await this.resolveElement(entry, snapshotId, elementRef);
      const state = await this.inspectElement(entry, nodeId);
      if (!state.select || !state.visible || !state.enabled) fail('ELEMENT_NOT_INTERACTABLE', 'El elemento no es un select habilitado y visible.');
      const resolved = await entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId }) as { object?: { objectId?: string } };
      const objectId = resolved.object?.objectId;
      if (objectId === undefined) fail('STALE_SNAPSHOT', 'El select ya no existe.');
      try {
        const selected = await entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function (nextValue) {
            if (!(this instanceof HTMLSelectElement) || !Array.from(this.options).some((option) => option.value === nextValue)) return false;
            this.value = nextValue;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }`,
          arguments: [{ value }],
          returnByValue: true,
          userGesture: true,
        }) as { result?: { value?: boolean } };
        if (selected.result?.value !== true) fail('INVALID_INPUT', 'El valor no existe en el select.');
      } finally {
        await entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
      await waitForInteractionToSettle();
      this.invalidateSnapshot(entry);
      const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
      this.assertAgentOperation(entry, epoch);
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async drag(workspaceId: string, sessionId: string, snapshotId: string, elementRef: string, targetElementRef: string, operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.drag', snapshotId, elementRef, targetElementRef]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
      const resolvedElements = await this.resolveElements(entry, snapshotId, [elementRef, targetElementRef]);
      const source = resolvedElements[0];
      const target = resolvedElements[1];
      if (source === undefined || target === undefined) fail('STALE_SNAPSHOT', 'El origen o destino ya no existe.');
      const [sourceState, targetState] = await Promise.all([this.inspectElement(entry, source.nodeId), this.inspectElement(entry, target.nodeId)]);
      if (!sourceState.visible || !sourceState.receivesPointer || !targetState.visible || !targetState.receivesPointer) {
        fail('ELEMENT_NOT_INTERACTABLE', 'El origen o destino del arrastre no recibe eventos de puntero.');
      }
      const [resolvedSource, resolvedTarget] = await Promise.all([
        entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: source.nodeId }) as Promise<{ object?: { objectId?: string } }>,
        entry.content.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: target.nodeId }) as Promise<{ object?: { objectId?: string } }>,
      ]);
      const sourceObjectId = resolvedSource.object?.objectId;
      const targetObjectId = resolvedTarget.object?.objectId;
      if (sourceObjectId === undefined || targetObjectId === undefined) fail('STALE_SNAPSHOT', 'El origen o destino ya no existe.');
      try {
        await entry.content.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
          objectId: sourceObjectId,
          functionDeclaration: `function (target) {
            const options = { bubbles: true, cancelable: true, composed: true, view: window };
            this.dispatchEvent(new PointerEvent('pointerdown', options));
            this.dispatchEvent(new MouseEvent('mousedown', options));
            target.dispatchEvent(new PointerEvent('pointermove', options));
            target.dispatchEvent(new MouseEvent('mousemove', options));
            target.dispatchEvent(new PointerEvent('pointerup', options));
            target.dispatchEvent(new MouseEvent('mouseup', options));
          }`,
          arguments: [{ objectId: targetObjectId }],
          userGesture: true,
        });
      } finally {
        await Promise.all([
          entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId: sourceObjectId }).catch(() => undefined),
          entry.content.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId: targetObjectId }).catch(() => undefined),
        ]);
      }
      await waitForInteractionToSettle();
      this.invalidateSnapshot(entry);
      const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
      this.assertAgentOperation(entry, epoch);
      this.rememberInteractionOperation(operationKey, fingerprint, result);
      return result;
    } finally {
      this.endAgentOperation(entry);
    }
  }

  async dialog(workspaceId: string, sessionId: string, action: 'accept' | 'dismiss', operationId?: string) {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${sessionId}:${operationId}`;
    const fingerprint = interactionFingerprint(['browser.dialog', action]);
    const entry = await this.requireInteractionSession(workspaceId, sessionId);
    const previous = this.previousInteraction(operationKey, fingerprint);
    if (previous !== undefined) return previous;
    const epoch = this.beginAgentOperation(entry);
    try {
      if (!entry.dialogOpen) fail('ELEMENT_NOT_INTERACTABLE', 'No hay un diálogo JavaScript abierto.');
      await entry.content.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: action === 'accept' });
      entry.dialogOpen = false;
      this.invalidateSnapshot(entry);
      const result = { sessionId, applied: true as const, snapshotInvalidated: true as const };
      this.assertAgentOperation(entry, epoch);
      this.rememberInteractionOperation(operationKey, fingerprint, result);
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
    await this.options.reserveHumanControl?.(sessionId);
    entry.restoreLiveViewerAfterHuman = this.liveViewerSessionId === sessionId;
    if (entry.restoreLiveViewerAfterHuman) entry.previousViewerWorkArea = this.liveViewerWorkArea ?? entry.window.getBounds();
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
    try {
      await this.options.beforeHumanControlRequest?.();
      this.hideLiveViewerEntry(entry);
      await this.waitForAgentOperations(entry);
    } catch {
      await this.stopEntry(entry);
      fail('TIMEOUT', 'No se pudo preparar la intervención humana de forma segura.');
    }
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
    // El usuario debe ver la ventana real, no un viewport emulado por el agente.
    // Conservamos la selección lógica para reponerla cuando devuelva el control.
    entry.agentViewportBeforeHuman = { ...entry.currentViewport };
    await this.clearViewportEmulation(entry);
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
    if (workArea !== undefined) entry.window.setBounds(workArea, false);
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
    entry.window.setIgnoreMouseEvents(true);
    entry.window.setFocusable(false);
    let confirmed: boolean;
    try {
      confirmed = await (this.options.confirmHumanControlHandoff?.(entry.workspaceName) ?? Promise.resolve(true));
    } catch {
      await this.stopEntry(entry);
      this.options.onActivityChange?.();
      throw new DevelopmentBrokerError('INTERNAL_ERROR', 'No se pudo confirmar la devolución local.');
    }
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
      if (entry.agentViewportBeforeHuman !== undefined) {
        entry.currentViewport = entry.agentViewportBeforeHuman;
        delete entry.agentViewportBeforeHuman;
      }
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
    this.options.releaseHumanControl?.(sessionId);
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
      await (this.options.restoreLiveViewerAfterHuman?.(sessionId, previousArea) ??
        this.showLiveViewerLocally(sessionId, previousArea)).catch(() => undefined);
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
    this.options.releaseHumanControl?.(entry.sessionId);
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
      try { entry.frame.removeChildView(entry.content); } catch { /* ya desvinculada */ }
      try { entry.window.contentView.removeChildView(entry.frame); } catch { /* ya desvinculada */ }
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
        width: entry.currentViewport.width,
        height: entry.currentViewport.height,
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
