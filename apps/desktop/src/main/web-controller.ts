import { createHash, randomBytes } from "node:crypto";

import { BrowserWindow, View, WebContentsView, type Session, type WebContents } from "electron";

import { isSensitiveInput, webProfileRevision, type WebProfile } from "@localbridge/desktop-core";
import { DevelopmentBrokerError, MAX_BROKER_FRAME_BYTES, type WebTabSummary } from "@localbridge/development";
import { ERROR_CODES, LocalBridgeError } from "@localbridge/shared";
import type { WorkspaceArtifactDirectoryResult, WorkspaceArtifactWriter, WorkspaceBinaryStreamWriter } from "@localbridge/filesystem";

import {
  capturePageMotion,
  inspectPageMotion,
  type MotionCaptureMode,
  type MotionCaptureValue,
  type MotionTrajectory,
} from "./motion-capture-engine.js";
import { fetchObservedWebResource } from "./web-download-fetch.js";
import { startWebEgressProxy, type RunningWebEgressProxy } from "./web-egress-proxy.js";
import { createDownloadedResourceStreamValidator, resolveDownloadedResourceDestination, validateDownloadedResource } from "./web-download-policy.js";
import { assertWebDownloadFits, remainingWebDownloadBytes } from "./web-download-quota.js";
import { didNavigationReachDestination } from "./web-navigation-outcome.js";
import { reloadManagedWebContents, type BrowserReloadMode } from "./browser-reload.js";
import {
  isWebEgressHostAllowed,
  isWebNavigationHostAllowed,
  normalizePublicHttpsUrl,
} from "./web-network-policy.js";
import { dispatchBoundedBrowserKey, inspectActiveBrowserKeyboardTarget, inspectResolvedBrowserElement, sampleResolvedBrowserElement, visualSamplesEqual, waitForResolvedBrowserElementStability } from "./browser-element-inspection.js";
import { resolveViewerPresentation, type ViewerPresentationMode } from "./live-viewer-presentation.js";

const MAX_GLOBAL_WEB_SESSIONS = 4;
const MAX_GLOBAL_WEB_TABS = 24;
const MAX_SNAPSHOT_ELEMENTS = 1_000;
const MAX_OPERATIONS = 4_096;
const INTERACTION_SETTLE_MS = 120;
const HUMAN_CONTROL_TTL_MS = 15 * 60_000;
const WEB_TOOLBAR_HEIGHT = 104;
const DEFAULT_WEB_VIEWPORT = { width: 1920, height: 1080, mobile: false } as const;
const MAX_SCREENSHOT_BASE64_BYTES = MAX_BROKER_FRAME_BYTES - 128 * 1024;
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem", "radio",
  "searchbox", "slider", "spinbutton", "switch", "tab", "textbox",
]);

export type WebControlState = "agent_control" | "waiting_for_human" | "human_control" | "returning_to_agent" | "ready" | "declined" | "expired" | "stopped";
export type WebHumanReason = "sign_in" | "file_selection" | "manual_step";
export type WebCloseReason = "user" | "agent" | "policy" | "expired" | "failed";
export type WebAssetKind = "image" | "video" | "poster" | "font" | "stylesheet" | "document" | "other";

export interface WebViewport {
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}

export interface WebProfileSummary {
  readonly webProfileId: string;
  readonly name: string;
  readonly kind: WebProfile["kind"];
  readonly enabled: boolean;
  readonly reviewRequired: boolean;
  readonly permissions: WebProfile["permissions"];
  readonly limits: Pick<WebProfile["limits"], 'maxSessions' | 'maxTabsPerSession' | 'maxExtractedChars' | 'maxDownloadBytes' | 'maxTotalDownloadBytes'>;
  readonly destinations: readonly string[];
}

export interface WebMotionCaptureSummary {
  readonly path: string;
  readonly frameCount: number;
  readonly totalSize: number;
  readonly captureMode: 'stepped' | 'screencast';
  readonly warnings: readonly string[];
}

export interface WebViewerPresentation {
  readonly mode: ViewerPresentationMode;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
  readonly contentBounds: WebLiveViewerWorkArea;
  readonly workArea: WebLiveViewerWorkArea;
}

export interface WebSessionSummary {
  readonly sessionId: string;
  readonly webProfileId: string;
  readonly profileName: string;
  readonly profileKind: WebProfile["kind"];
  readonly state: "running" | "stopped";
  readonly startedAt: string;
  readonly controlState: WebControlState;
  readonly tabCount: number;
  readonly controlExpiresAt?: string;
  readonly humanReason?: WebHumanReason;
  readonly delegatedSite?: string;
  readonly delegatedExpiresAt?: string;
  readonly closedAt?: string;
  readonly closeReason?: WebCloseReason;
}

export interface WebHumanControlStatus {
  readonly requestId: string;
  readonly state: "waiting_for_human" | "human_control" | "ready" | "declined" | "expired" | "stopped";
  readonly reason: WebHumanReason;
  readonly expiresAt?: string;
  readonly retryAfterMs?: number;
}

export type WebWaitCondition =
  | { readonly kind: "load" }
  | { readonly kind: "url"; readonly value: string; readonly operator: "equals" | "contains" }
  | { readonly kind: "title"; readonly value: string; readonly operator: "equals" | "contains" }
  | { readonly kind: "text"; readonly value: string; readonly state: "present" | "absent" }
  | { readonly kind: "stable"; readonly snapshotId: string; readonly elementRef: string; readonly intervalMs: number; readonly tolerancePx: number };

interface ElementBinding {
  readonly backendNodeId: number;
  readonly role: string;
}

interface SnapshotBinding {
  readonly snapshotId: string;
  readonly generation: number;
  readonly elements: ReadonlyMap<string, ElementBinding>;
}

interface ResourceBinding {
  readonly resourceRef: string;
  readonly generation: number;
  readonly url: string;
  readonly kind: WebAssetKind;
  readonly observedMimeType?: string;
}

interface ManagedWebTab {
  readonly tabId: string;
  readonly window: BrowserWindow;
  readonly frame: View;
  readonly content: WebContentsView;
  readonly openedAt: number;
  state: WebTabSummary["state"];
  generation: number;
  snapshot?: SnapshotBinding | undefined;
  resources: Map<string, ResourceBinding>;
  observedMimeTypes: Map<string, string>;
  writing: boolean;
  closing: boolean;
  agentActionInProgress: boolean;
  lastAgentActionSequence: number;
  currentViewport: WebViewport;
  blockedDownloadSequence: number;
  fileChooserSequence: number;
  blockedDialogSequence: number;
  motionCapture?: { readonly completed: number; readonly total: number; readonly mode: MotionCaptureMode };
  lastMotionCapture?: WebMotionCaptureSummary;
  viewerPresentation?: WebViewerPresentation;
}

export interface WebLiveViewerWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WebLiveViewerState {
  readonly visible: boolean;
  readonly mode?: "follow" | "pinned";
  readonly sessionId?: string;
  readonly tabId?: string;
  readonly pageState?: "loading" | "action" | "idle" | "failed";
  readonly presentation?: WebViewerPresentation;
}

interface WebLiveViewerSelection {
  readonly mode: "follow" | "pinned";
  readonly sessionId: string;
  readonly tabId: string;
  readonly workArea: WebLiveViewerWorkArea;
}

interface ManagedWebSession {
  readonly sessionId: string;
  readonly webProfileId: string;
  readonly profile: WebProfile;
  readonly profileRevision: string;
  readonly partition: string;
  readonly proxy: RunningWebEgressProxy;
  readonly startedAt: number;
  readonly tabs: Map<string, ManagedWebTab>;
  readonly agentDrainWaiters: Set<() => void>;
  browserSession?: Session;
  activeAgentOperations: number;
  state: "running" | "stopped";
  controlState: WebControlState;
  humanRequestId?: string | undefined;
  humanReason?: WebHumanReason | undefined;
  controlExpiresAt?: number | undefined;
  controlTimer?: NodeJS.Timeout | undefined;
  humanTabId?: string | undefined;
  humanInitiatedLocally?: boolean | undefined;
  humanPrepared?: boolean | undefined;
  delegatedSite?: string | undefined;
  delegatedExpiresAt?: number | undefined;
  closedAt?: number | undefined;
  closeReason?: WebCloseReason | undefined;
  stopPromise?: Promise<void> | undefined;
  downloadedBytes: number;
}

interface OperationRecord {
  readonly fingerprint: string;
  readonly sessionId: string;
  state: "pending" | "complete" | "uncertain";
  result?: unknown;
  causeCode?: string;
}

interface CompositeOperationRecord {
  readonly fingerprint: string;
  readonly sessionId: string;
  state: "pending" | "complete" | "uncertain";
  result?: unknown;
  completion?: Promise<unknown>;
}

export interface WebControllerOptions {
  readonly loadProfile: (webProfileId: string) => Promise<WebProfile | undefined>;
  readonly listProfiles: () => Promise<readonly WebProfile[]>;
  readonly reconciliationIntervalMs?: number;
  readonly onActivityChange?: () => void;
  readonly onLiveViewerChange?: (state: WebLiveViewerState) => void;
  readonly onHumanControlRequest?: (session: WebSessionSummary) => void;
  readonly beforeHumanControlRequest?: () => Promise<void>;
  readonly reserveHumanControl?: (sessionId: string) => void | Promise<void>;
  readonly releaseHumanControl?: (sessionId: string) => void;
  readonly confirmHumanControlHandoff?: (input: {
    readonly profileKind: WebProfile["kind"];
    readonly profileName: string;
    readonly hostname: string;
  }) => Promise<"continue-human" | "share-once" | "share-and-remember">;
  readonly rememberSiteAccess?: (hostname: string) => Promise<void>;
  readonly onHumanControlTransition?: (event: {
    readonly action: "web.human.open" | "web.human.handoff" | "web.human.decline" | "web.human.expire";
    readonly sessionId: string;
    readonly reason?: WebHumanReason;
  }) => void;
  readonly onCaptureDiagnostic?: (event: {
    readonly sessionId: string;
    readonly tabId: string;
    readonly stage: "capture" | "metrics" | "transport";
    readonly outcome: "success" | "retry" | "fallback" | "failed";
    readonly width?: number;
    readonly height?: number;
    readonly encodedBytes?: number;
    readonly code?: "WEB_CAPTURE_FAILED" | "WEB_CAPTURE_TOO_LARGE";
    readonly operationId?: string;
  }) => void;
  readonly onDownloadDiagnostic?: (event: {
    readonly sessionId: string;
    readonly tabId: string;
    readonly stage: "network" | "response" | "content" | "save";
    readonly outcome: "success" | "failed";
    readonly hostname: string;
    readonly status?: number;
    readonly size?: number;
    readonly code?: string;
    readonly operationId: string;
  }) => void;
  readonly onMotionDiagnostic?: (event: {
    readonly sessionId: string;
    readonly tabId: string;
    readonly outcome: 'failed';
    readonly causeCode?: string;
    readonly operationId: string;
  }) => void;
  readonly onNavigationDiagnostic?: (event: {
    readonly sessionId: string;
    readonly tabId: string;
    readonly outcome: 'failed' | 'recovered';
    readonly causeCode: string;
    readonly operationId?: string;
  }) => void;
  readonly saveDownload?: (input: {
    readonly webProfileId: string;
    readonly profileRevision: string;
    readonly workspaceId: string;
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly maximumBytes: number;
  }) => Promise<{ path: string; sha256: string; size: number; created: true }>;
  readonly preflightDownload?: (input: {
    readonly webProfileId: string;
    readonly profileRevision: string;
    readonly workspaceId: string;
    readonly path: string;
    readonly maximumBytes: number;
  }) => Promise<void>;
  readonly saveDownloadStream?: (input: {
    readonly webProfileId: string;
    readonly profileRevision: string;
    readonly workspaceId: string;
    readonly path: string;
    readonly mimeType: string;
    readonly maximumBytes?: number;
    readonly adaptive: boolean;
    readonly produce: (writer: WorkspaceBinaryStreamWriter) => Promise<void>;
  }) => Promise<{ path: string; sha256: string; size: number; created: true }>;
  readonly saveMotionBundle?: (input: {
    readonly webProfileId: string;
    readonly profileRevision: string;
    readonly workspaceId: string;
    readonly path: string;
    readonly produce: (writer: WorkspaceArtifactWriter) => Promise<MotionCaptureValue>;
  }) => Promise<WorkspaceArtifactDirectoryResult<MotionCaptureValue>>;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function webShellHtml(
  profileName: string,
  mode: "agent" | "human",
  tabContext: string,
  presentation?: WebViewerPresentation,
): string {
  const title = mode === "agent" ? "Investigación web · Solo observación" : "Intervención web privada";
  const owner = mode === "agent" ? "Control de ChatGPT" : "Control de la persona";
  const notice = mode === "agent"
    ? "La página no acepta ratón ni teclado. Oculta o cambia esta vista desde LocalBridge."
    : "ChatGPT está pausado. Devuelve o cancela el control desde LocalBridge.";
  const presentationLabel = presentation === undefined ? "" :
    `Render ${presentation.renderWidth}×${presentation.renderHeight} · Vista ${presentation.viewWidth}×${presentation.viewHeight} · ${Math.round(presentation.scale * 100)}% · ${presentation.mode === "fit" ? "Encajar" : `1:1 · pan ${presentation.panX},${presentation.panY}`}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title} — LocalBridge</title><style>html,body{margin:0;background:#10243e;color:#fff;font:14px system-ui}.bar{height:${WEB_TOOLBAR_HEIGHT}px;box-sizing:border-box;padding:9px 20px;display:flex;align-items:center;justify-content:space-between;gap:20px}.title{font-size:17px;font-weight:800}.meta,.presentation{margin-top:2px;color:#c7d7e9}.presentation{color:#8ff1df;font-variant-numeric:tabular-nums}.notice{margin-top:2px;color:#ffd18c}.badge{padding:9px 12px;border:1px solid #55d6be;border-radius:999px;color:#8ff1df;font-weight:800;white-space:nowrap}</style></head><body><div class="bar"><div><div class="title">${title}</div><div class="meta">${escapeHtml(profileName)} · ${escapeHtml(tabContext)}</div>${presentationLabel === "" ? "" : `<div class="presentation">${escapeHtml(presentationLabel)}</div>`}<div class="notice">${notice}</div></div><div class="badge">${owner}</div></div></body></html>`;
}

function webShellUrl(profileName: string, mode: "agent" | "human", tabContext: string, presentation?: WebViewerPresentation): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(webShellHtml(profileName, mode, tabContext, presentation))}`;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function downloadedResourceKind(mimeType: string, observedKind: WebAssetKind): WebAssetKind {
  if (mimeType.startsWith("image/")) return observedKind === "poster" ? "poster" : "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "text/css") return "stylesheet";
  if (mimeType.startsWith("font/") || mimeType.includes("font")) return "font";
  if (["application/pdf", "application/json", "application/csv", "text/csv", "text/plain", "text/markdown"].includes(mimeType)) return "document";
  return observedKind;
}

function capturedImageDimensions(dataBase64: string, mimeType: "image/png" | "image/jpeg", fallback: WebViewport): { width: number; height: number } {
  const bytes = Buffer.from(dataBase64, "base64");
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
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
  return { width: fallback.width, height: fallback.height };
}

function fingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function profileRevision(profile: WebProfile): string {
  return webProfileRevision(profile);
}

function publicProfileSummary(profile: WebProfile): WebProfileSummary {
  return {
    webProfileId: profile.id,
    name: profile.name,
    kind: profile.kind,
    enabled: profile.enabled,
    reviewRequired: profile.reviewRequired,
    permissions: profile.permissions,
    limits: {
      maxSessions: profile.limits.maxSessions,
      maxTabsPerSession: profile.limits.maxTabsPerSession,
      maxExtractedChars: profile.limits.maxExtractedChars,
      maxDownloadBytes: profile.limits.maxDownloadBytes,
      maxTotalDownloadBytes: profile.limits.maxTotalDownloadBytes,
    },
    destinations: profile.kind === "public-research" ? ["public-https"] : profile.destinations.map((rule) =>
      `${rule.includeSubdomains ? "*." : ""}${rule.hostname}`),
  };
}

function safeObservedUrl(profile: WebProfile, value: string, delegatedSite?: string): string {
  const parsed = normalizePublicHttpsUrl(value);
  if (parsed === undefined) return "about:blank";
  if (profile.kind === "site-account" || delegatedSite !== undefined) parsed.search = "";
  return parsed.href.slice(0, 4_096);
}

function safeObservedResourceUrl(profile: WebProfile, value: string, delegatedSite?: string): string {
  const safe = safeObservedUrl(profile, value, delegatedSite);
  const parsed = normalizePublicHttpsUrl(safe);
  if (parsed === undefined) return "about:blank";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.slice(0, 4_096);
}

function sessionSummary(entry: ManagedWebSession): WebSessionSummary {
  return {
    sessionId: entry.sessionId,
    webProfileId: entry.webProfileId,
    profileName: entry.profile.name,
    profileKind: entry.profile.kind,
    state: entry.state,
    startedAt: new Date(entry.startedAt).toISOString(),
    controlState: entry.controlState,
    tabCount: [...entry.tabs.values()].filter((tab) => tab.state !== "closed").length,
    ...(entry.controlExpiresAt === undefined ? {} : { controlExpiresAt: new Date(entry.controlExpiresAt).toISOString() }),
    ...(entry.humanReason === undefined ? {} : { humanReason: entry.humanReason }),
    ...(entry.delegatedSite === undefined ? {} : { delegatedSite: entry.delegatedSite }),
    ...(entry.delegatedExpiresAt === undefined ? {} : { delegatedExpiresAt: new Date(entry.delegatedExpiresAt).toISOString() }),
    ...(entry.closedAt === undefined ? {} : { closedAt: new Date(entry.closedAt).toISOString() }),
    ...(entry.closeReason === undefined ? {} : { closeReason: entry.closeReason }),
  };
}

function tabSummary(entry: ManagedWebSession, tab: ManagedWebTab): WebTabSummary {
  const destroyed = tab.window.isDestroyed() || tab.content.webContents.isDestroyed();
  const viewerPresentation = tab.viewerPresentation === undefined ? undefined : {
    mode: tab.viewerPresentation.mode,
    renderWidth: tab.viewerPresentation.renderWidth,
    renderHeight: tab.viewerPresentation.renderHeight,
    viewWidth: tab.viewerPresentation.viewWidth,
    viewHeight: tab.viewerPresentation.viewHeight,
    scale: tab.viewerPresentation.scale,
    panX: tab.viewerPresentation.panX,
    panY: tab.viewerPresentation.panY,
  };
  return {
    tabId: tab.tabId,
    title: destroyed ? "" : tab.content.webContents.getTitle().slice(0, 256),
    url: destroyed ? "about:blank" : safeObservedUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite),
    state: destroyed ? "closed" : tab.state,
    openedAt: new Date(tab.openedAt).toISOString(),
    viewport: tab.currentViewport,
    blockedNativeDownloads: tab.blockedDownloadSequence,
    blockedFileChoosers: tab.fileChooserSequence,
    blockedDialogs: tab.blockedDialogSequence,
    ...(tab.motionCapture === undefined ? {} : { motionCapture: tab.motionCapture }),
    ...(tab.lastMotionCapture === undefined ? {} : { lastMotionCapture: tab.lastMotionCapture }),
    ...(viewerPresentation === undefined ? {} : { viewerPresentation }),
  };
}

function isAllowedPartitionRequest(profile: WebProfile, value: string, resourceType: string, delegatedSite?: string): boolean {
  if (value === "about:blank") return true;
  if (value.startsWith("data:") && resourceType !== "mainFrame") return true;
  if (value.startsWith("blob:")) {
    const nested = normalizePublicHttpsUrl(value.slice("blob:".length));
    return nested !== undefined && (delegatedSite === undefined
      ? isWebEgressHostAllowed(profile, nested.hostname)
      : nested.hostname === delegatedSite);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "wss:") return delegatedSite === undefined
      ? isWebEgressHostAllowed(profile, parsed.hostname)
      : parsed.hostname === delegatedSite;
  } catch {
    return false;
  }
  const parsed = normalizePublicHttpsUrl(value);
  return parsed !== undefined && (delegatedSite === undefined
    ? isWebEgressHostAllowed(profile, parsed.hostname)
    : parsed.hostname === delegatedSite);
}

function denyShellRemoteNavigation(event: Electron.Event, value: string): void {
  if (!value.startsWith("data:text/html")) event.preventDefault();
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, INTERACTION_SETTLE_MS));
}

export class WebController {
  private readonly entries = new Map<string, ManagedWebSession>();
  private readonly operations = new Map<string, OperationRecord>();
  private readonly compositeOperations = new Map<string, CompositeOperationRecord>();
  private readonly reconciliationTimer: NodeJS.Timeout;
  private humanSessionId: string | undefined;
  private liveViewer: WebLiveViewerSelection | undefined;
  private viewerRevision = 0;
  private viewerTail: Promise<void> = Promise.resolve();
  private agentActionSequence = 0;
  private activeDownloadCount = 0;
  private readonly downloadWaiters: Array<{
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
  }> = [];

  constructor(private readonly options: WebControllerOptions) {
    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch(() => this.stopAll().catch(() => undefined));
    }, options.reconciliationIntervalMs ?? 2_000);
    this.reconciliationTimer.unref();
  }

  async profiles(): Promise<readonly WebProfileSummary[]> {
    return (await this.options.listProfiles()).map(publicProfileSummary);
  }

  private async requireProfile(webProfileId: string, capability: keyof WebProfile["permissions"] = "read"): Promise<WebProfile> {
    const profile = await this.options.loadProfile(webProfileId).catch(() => undefined);
    if (profile === undefined) fail("PROFILE_NOT_FOUND", "El perfil web no existe.");
    if (!profile.enabled) fail("CAPABILITY_DISABLED", "El perfil web está deshabilitado.");
    if (profile.reviewRequired) fail("PROFILE_REVIEW_REQUIRED", "El perfil web requiere revisión local.");
    if (!profile.permissions[capability]) fail("CAPABILITY_DISABLED", "El perfil web no permite esta capacidad.");
    return profile;
  }

  private ensureAgentControl(entry: ManagedWebSession): void {
    if (["waiting_for_human", "human_control", "returning_to_agent"].includes(entry.controlState)) {
      fail("HUMAN_CONTROL_ACTIVE", "La sesión web está bajo control humano exclusivo.");
    }
    if (entry.controlState === "declined") fail("HUMAN_CONTROL_DECLINED", "El usuario canceló el control humano.");
    if (entry.controlState === "expired") fail("HUMAN_CONTROL_EXPIRED", "El control humano expiró.");
  }

  private async requireSession(sessionId: string, capability: keyof WebProfile["permissions"] = "read"): Promise<ManagedWebSession> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== "running") fail("WEB_SESSION_NOT_FOUND", "La sesión web no existe.");
    const current = await this.requireProfile(entry.webProfileId, capability);
    if (profileRevision(current) !== entry.profileRevision) {
      await this.stopEntry(entry);
      fail("WEB_SESSION_NOT_FOUND", "El perfil web cambió y la sesión se cerró.");
    }
    if (entry.delegatedExpiresAt !== undefined && Date.now() >= entry.delegatedExpiresAt) {
      await this.stopEntry(entry, "expired", "expired");
      fail("HUMAN_CONTROL_EXPIRED", "El acceso temporal al sitio delegado ya caducó.");
    }
    this.ensureAgentControl(entry);
    return entry;
  }

  private requireTab(entry: ManagedWebSession, tabId: string): ManagedWebTab {
    const tab = entry.tabs.get(tabId);
    if (tab === undefined || tab.state === "closed" || tab.window.isDestroyed() || tab.content.webContents.isDestroyed()) {
      fail("WEB_TAB_NOT_FOUND", "La pestaña web no existe.");
    }
    return tab;
  }

  private invalidate(tab: ManagedWebTab): void {
    tab.generation += 1;
    tab.snapshot = undefined;
    tab.resources.clear();
  }

  private viewerState(): WebLiveViewerState {
    const viewer = this.liveViewer;
    if (viewer === undefined) return { visible: false };
    const entry = this.entries.get(viewer.sessionId);
    const tab = entry?.tabs.get(viewer.tabId);
    if (entry === undefined || entry.state !== "running" || entry.controlState !== "agent_control" ||
        tab === undefined || tab.state === "closed" || tab.window.isDestroyed() || tab.content.webContents.isDestroyed()) {
      return { visible: false };
    }
    return {
      visible: true,
      mode: viewer.mode,
      sessionId: viewer.sessionId,
      tabId: viewer.tabId,
      pageState: tab.state === "failed" ? "failed" : tab.state === "loading" ? "loading" : tab.agentActionInProgress ? "action" : "idle",
      ...(tab.viewerPresentation === undefined ? {} : { presentation: tab.viewerPresentation }),
    };
  }

  getLocalLiveViewerState(): WebLiveViewerState {
    const state = this.viewerState();
    if (!state.visible && this.liveViewer !== undefined) this.liveViewer = undefined;
    return state;
  }

  getLocalLiveViewerWindowBounds(): WebLiveViewerWorkArea | undefined {
    const state = this.getLocalLiveViewerState();
    if (!state.visible || state.sessionId === undefined || state.tabId === undefined) return undefined;
    const tab = this.entries.get(state.sessionId)?.tabs.get(state.tabId);
    return tab === undefined || tab.window.isDestroyed() ? undefined : tab.window.getBounds();
  }

  hasHumanControlActive(): boolean {
    return [...this.entries.values()].some((entry) => entry.state === "running" &&
      ["waiting_for_human", "human_control", "returning_to_agent"].includes(entry.controlState));
  }

  private notifyViewerChange(): void {
    this.options.onLiveViewerChange?.(this.getLocalLiveViewerState());
    this.options.onActivityChange?.();
  }

  private enqueueViewer<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.viewerTail.then(operation, operation);
    this.viewerTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async positionViewer(
    entry: ManagedWebSession,
    tab: ManagedWebTab,
    workArea: WebLiveViewerWorkArea,
    mode: ViewerPresentationMode = tab.viewerPresentation?.mode ?? "fit",
    pan = { x: tab.viewerPresentation?.panX ?? 0, y: tab.viewerPresentation?.panY ?? 0 },
  ): Promise<void> {
    let presentation;
    try {
      const outer = tab.window.getBounds();
      const content = tab.window.getContentBounds();
      presentation = resolveViewerPresentation(tab.currentViewport, WEB_TOOLBAR_HEIGHT, workArea, {
        width: Math.max(0, outer.width - content.width),
        height: Math.max(0, outer.height - content.height),
      }, mode, pan);
    } catch {
      fail("INVALID_INPUT", "El área de pantalla no es válida.");
    }
    tab.window.setBounds(presentation.bounds, false);
    tab.frame.setBounds({
      x: 0,
      y: WEB_TOOLBAR_HEIGHT,
      width: presentation.visibleContentWidth,
      height: presentation.visibleContentHeight,
    });
    tab.content.setBounds(presentation.contentBounds);
    await tab.content.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: tab.currentViewport.width,
      height: tab.currentViewport.height,
      deviceScaleFactor: 1,
      mobile: tab.currentViewport.mobile,
      scale: presentation.scale,
    });
    tab.viewerPresentation = {
      mode: presentation.mode,
      renderWidth: tab.currentViewport.width,
      renderHeight: tab.currentViewport.height,
      viewWidth: presentation.visibleContentWidth,
      viewHeight: presentation.visibleContentHeight,
      scale: presentation.scale,
      panX: presentation.panX,
      panY: presentation.panY,
      contentBounds: presentation.contentBounds,
      workArea,
    };
    await this.refreshViewerShell(entry, tab, "agent");
  }

  private hideViewerWindow(tab: ManagedWebTab): void {
    if (tab.window.isDestroyed()) return;
    tab.window.setIgnoreMouseEvents(true);
    tab.window.setFocusable(false);
    tab.window.setSkipTaskbar(true);
    tab.window.setPosition(-10_000, -10_000, false);
    tab.window.showInactive();
  }

  private hideHumanWindow(tab: ManagedWebTab): void {
    if (tab.window.isDestroyed()) return;
    tab.window.setIgnoreMouseEvents(true);
    tab.window.setFocusable(false);
    tab.window.setSkipTaskbar(true);
    tab.window.hide();
  }

  private viewerTabContext(entry: ManagedWebSession, tab: ManagedWebTab): string {
    const observed = safeObservedUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite);
    const parsed = normalizePublicHttpsUrl(observed);
    if (parsed === undefined) return "Pestaña nueva · sin destino";
    const extension = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
    const resourceLabel = extension === "css" ? "CSS" :
      ["woff", "woff2", "ttf", "otf"].includes(extension ?? "") ? "fuente" :
      ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension ?? "") ? "imagen" :
      ["mp4", "webm"].includes(extension ?? "") ? "vídeo" : undefined;
    return resourceLabel === undefined
      ? `Página web · ${parsed.hostname}`
      : `Recurso auxiliar (${resourceLabel}) · ${parsed.hostname}`;
  }

  private async refreshViewerShell(entry: ManagedWebSession, tab: ManagedWebTab, mode: "agent" | "human"): Promise<void> {
    await tab.window.loadURL(webShellUrl(entry.profile.name, mode, this.viewerTabContext(entry, tab), mode === "agent" ? tab.viewerPresentation : undefined));
  }

  private destroyTabWindow(tab: ManagedWebTab): void {
    tab.closing = true;
    const contents = tab.content.webContents;
    try { tab.frame.removeChildView(tab.content); } catch { /* ya fue retirada */ }
    try { tab.window.contentView.removeChildView(tab.frame); } catch { /* ya fue retirada */ }
    if (contents !== undefined && !contents.isDestroyed()) contents.close();
    if (!tab.window.isDestroyed()) tab.window.destroy();
  }

  private async showViewerWindow(
    entry: ManagedWebSession,
    tab: ManagedWebTab,
    workArea: WebLiveViewerWorkArea,
    presentationMode?: ViewerPresentationMode,
  ): Promise<void> {
    tab.window.setIgnoreMouseEvents(true);
    tab.window.setFocusable(false);
    tab.window.setSkipTaskbar(false);
    tab.window.setTitle("Investigación web · Solo observación — LocalBridge");
    await this.positionViewer(entry, tab, workArea, presentationMode ?? tab.viewerPresentation?.mode ?? "fit", { x: 0, y: 0 });
    tab.window.showInactive();
  }

  private liveTabs(entry: ManagedWebSession): ManagedWebTab[] {
    return [...entry.tabs.values()].filter((tab) => tab.state !== "closed" && !tab.window.isDestroyed() && !tab.content.webContents.isDestroyed());
  }

  private latestAgentTab(entry: ManagedWebSession): ManagedWebTab | undefined {
    return this.liveTabs(entry).toSorted((left, right) =>
      right.lastAgentActionSequence - left.lastAgentActionSequence || left.openedAt - right.openedAt)[0];
  }

  private noteAgentAction(entry: ManagedWebSession, tab: ManagedWebTab): void {
    tab.lastAgentActionSequence = ++this.agentActionSequence;
    const current = this.liveViewer;
    if (current?.sessionId === entry.sessionId && current.mode === "follow" && current.tabId !== tab.tabId) {
      const workArea = current.workArea;
      void this.showLiveViewerLocally(entry.sessionId, "follow", workArea).catch(() => undefined);
    } else {
      this.options.onActivityChange?.();
    }
  }

  private navigationHostAllowed(entry: ManagedWebSession, hostname: string): boolean {
    return entry.delegatedSite === undefined
      ? isWebNavigationHostAllowed(entry.profile, hostname)
      : hostname === entry.delegatedSite;
  }

  private assertNavigation(entry: ManagedWebSession, value: string): URL {
    const destination = normalizePublicHttpsUrl(value);
    if (destination === undefined || !this.navigationHostAllowed(entry, destination.hostname)) {
      fail("WEB_DESTINATION_BLOCKED", "El destino no pertenece al perfil web habilitado.");
    }
    return destination;
  }

  private rememberOperation(key: string | undefined, record: OperationRecord): void {
    if (key === undefined) return;
    this.operations.set(key, record);
    while (this.operations.size > MAX_OPERATIONS) this.operations.delete(this.operations.keys().next().value as string);
  }

  private previousOperation<T>(key: string | undefined, expectedFingerprint: string): T | undefined {
    if (key === undefined) return undefined;
    const previous = this.operations.get(key);
    if (previous === undefined) return undefined;
    if (previous.fingerprint !== expectedFingerprint) fail("IDEMPOTENCY_CONFLICT", "El operationId ya representa otra acción web.");
    if (previous.state !== "complete") fail("WEB_EFFECT_UNCERTAIN", "La acción web anterior no tiene un resultado demostrado.");
    return previous.result as T;
  }

  private operationKey(entry: ManagedWebSession, operationId?: string): string | undefined {
    return operationId === undefined ? undefined : `${entry.sessionId}:${operationId}`;
  }

  private async configureBrowserSession(entry: ManagedWebSession, browserSession: Session): Promise<void> {
    entry.browserSession = browserSession;
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await browserSession.setProxy({
      mode: "fixed_servers",
      proxyRules: entry.proxy.proxyRules,
      proxyBypassRules: "<-loopback>",
    });
    await browserSession.closeAllConnections();
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      void (async () => {
        const current = await this.options.loadProfile(entry.webProfileId).catch(() => undefined);
        if (current === undefined || !current.enabled || current.reviewRequired || !current.permissions.read ||
            profileRevision(current) !== entry.profileRevision ||
            !isAllowedPartitionRequest(current, details.url, details.resourceType, entry.delegatedSite)) {
          callback({ cancel: true });
          if (current === undefined || !current.enabled || current.reviewRequired || profileRevision(current) !== entry.profileRevision) {
            void this.stopEntry(entry);
          }
          return;
        }
        callback({ cancel: false });
      })().catch(() => callback({ cancel: true }));
    });
    browserSession.on("will-download", (event, _item, webContents) => {
      event.preventDefault();
      const tab = [...entry.tabs.values()].find((candidate) => candidate.content.webContents.id === webContents.id);
      if (tab !== undefined) tab.blockedDownloadSequence += 1;
    });
  }

  private async installDebugger(webContents: WebContents, viewport: WebViewport): Promise<void> {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
    await Promise.all([
      webContents.debugger.sendCommand("Accessibility.enable"),
      webContents.debugger.sendCommand("DOM.enable"),
      webContents.debugger.sendCommand("Page.enable"),
      webContents.debugger.sendCommand("Runtime.enable"),
      webContents.debugger.sendCommand("Network.enable", { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024 }),
    ]);
    await webContents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
    await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });
    await webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled: viewport.mobile,
      ...(viewport.mobile ? { maxTouchPoints: 5 } : {}),
    }).catch(() => undefined);
  }

  private configureTabEvents(entry: ManagedWebSession, tab: ManagedWebTab): void {
    const contents = tab.content.webContents;
    const validateMainDestination = (event: Electron.Event, value: string): void => {
      if (value === "about:blank") return;
      const destination = normalizePublicHttpsUrl(value);
      if (destination === undefined || !this.navigationHostAllowed(entry, destination.hostname)) event.preventDefault();
    };
    contents.on("will-navigate", validateMainDestination);
    contents.on("will-redirect", validateMainDestination);
    contents.on("did-start-loading", () => {
      tab.state = "loading";
      this.options.onActivityChange?.();
    });
    contents.on("did-stop-loading", () => {
      if (tab.state !== "closed") tab.state = "ready";
      if (this.liveViewer?.sessionId === entry.sessionId && this.liveViewer.tabId === tab.tabId) {
        void this.refreshViewerShell(entry, tab, "agent").catch(() => undefined);
      }
      this.options.onActivityChange?.();
    });
    contents.on("did-fail-load", (_event, errorCode) => {
      if (errorCode !== -3 && tab.state !== "closed") tab.state = "failed";
    });
    contents.debugger.on("message", (_event, method, params) => {
      if (method === "Page.fileChooserOpened") tab.fileChooserSequence += 1;
      if (method === "Page.javascriptDialogOpening") {
        tab.blockedDialogSequence += 1;
        void contents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
      }
      if (method === "Network.responseReceived" && typeof params === "object" && params !== null) {
        const response = (params as { response?: unknown }).response;
        if (typeof response === "object" && response !== null) {
          const url = (response as { url?: unknown }).url;
          const mimeType = (response as { mimeType?: unknown }).mimeType;
          const parsed = typeof url === "string" ? normalizePublicHttpsUrl(url) : undefined;
          if (parsed !== undefined && typeof mimeType === "string" && mimeType.length <= 128 &&
              isWebEgressHostAllowed(entry.profile, parsed.hostname)) {
            tab.observedMimeTypes.set(parsed.href, mimeType.toLowerCase());
            while (tab.observedMimeTypes.size > 1_000) tab.observedMimeTypes.delete(tab.observedMimeTypes.keys().next().value as string);
          }
        }
      }
    });
    contents.on("did-navigate", () => this.invalidate(tab));
    contents.on("did-navigate-in-page", () => this.invalidate(tab));
    contents.setWindowOpenHandler(({ url }) => {
      try {
        this.assertNavigation(entry, url);
        if (entry.controlState === "human_control") {
          const destination = normalizePublicHttpsUrl(url);
          if (destination !== undefined) {
            void this.createTab(entry, destination, true).catch(() => undefined);
          }
        } else {
          void this.open(entry.sessionId, url).catch(() => undefined);
        }
      } catch {
        // El popup queda denegado; no se amplía autoridad por contenido remoto.
      }
      return { action: "deny" };
    });
    const stopTab = (): void => {
      if (tab.state === "closed") return;
      tab.state = "closed";
      tab.snapshot = undefined;
      tab.resources.clear();
      if (this.liveViewer?.sessionId === entry.sessionId && this.liveViewer.tabId === tab.tabId) {
        const previous = this.liveViewer;
        this.liveViewer = undefined;
        this.viewerRevision += 1;
        this.options.onLiveViewerChange?.({ visible: false });
        if (previous.mode === "follow") {
          const replacement = this.latestAgentTab(entry);
          if (replacement !== undefined) {
            void this.showLiveViewerLocally(entry.sessionId, "follow", previous.workArea).catch(() => undefined);
          }
        }
      }
      this.options.onActivityChange?.();
    };
    contents.on("render-process-gone", stopTab);
    contents.on("destroyed", stopTab);
    tab.window.on("close", (event) => {
      if (tab.closing || entry.state !== "running" || entry.controlState !== "agent_control" ||
          this.liveViewer?.sessionId !== entry.sessionId || this.liveViewer.tabId !== tab.tabId) return;
      event.preventDefault();
      void this.hideLiveViewerLocally(entry.sessionId);
    });
    tab.window.on("closed", stopTab);
    tab.window.on("unresponsive", () => {
      tab.state = "failed";
      this.invalidate(tab);
    });
  }

  private configureShellWindow(window: BrowserWindow): void {
    const shellContents = window.webContents;
    shellContents.on("will-navigate", denyShellRemoteNavigation);
    shellContents.on("will-redirect", denyShellRemoteNavigation);
    shellContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const shellSession = shellContents.session;
    shellSession.setPermissionCheckHandler(() => false);
    shellSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    shellSession.on("will-download", (event) => event.preventDefault());
    shellSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !(details.url === "about:blank" || details.url.startsWith("data:text/html")) });
    });
  }

  private async createTab(entry: ManagedWebSession, destination?: URL, humanMode = false): Promise<ManagedWebTab> {
    const activeTabs = [...this.entries.values()].flatMap((session) => [...session.tabs.values()]).filter((tab) => tab.state !== "closed");
    if (activeTabs.length >= MAX_GLOBAL_WEB_TABS ||
        [...entry.tabs.values()].filter((tab) => tab.state !== "closed").length >= entry.profile.limits.maxTabsPerSession) {
      fail("RATE_LIMITED", "Se alcanzó el límite de pestañas web.");
    }
    const tabId = `webtab_${randomBytes(12).toString("hex")}`;
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900 + WEB_TOOLBAR_HEIGHT,
      title: "Navegador web aislado — LocalBridge",
      autoHideMenuBar: true,
      skipTaskbar: true,
      webPreferences: {
        partition: `localbridge-web-shell-${randomBytes(16).toString("hex")}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    const frame = new View();
    const content = new WebContentsView({
      webPreferences: {
        partition: entry.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    window.contentView.addChildView(frame);
    frame.addChildView(content);
    // eslint-disable-next-line prefer-const -- el primer layout ocurre antes de enlazar la pestaña administrada
    let currentTab: ManagedWebTab | undefined;
    const resizeContent = (): void => {
      if (currentTab?.viewerPresentation !== undefined && entry.controlState === "agent_control") {
        const metrics = currentTab.viewerPresentation;
        frame.setBounds({ x: 0, y: WEB_TOOLBAR_HEIGHT, width: metrics.viewWidth, height: metrics.viewHeight });
        content.setBounds({
          x: -metrics.panX,
          y: -metrics.panY,
          width: Math.max(1, Math.floor(currentTab.currentViewport.width * metrics.scale)),
          height: Math.max(1, Math.floor(currentTab.currentViewport.height * metrics.scale)),
        });
        return;
      }
      const bounds = window.getContentBounds();
      frame.setBounds({ x: 0, y: WEB_TOOLBAR_HEIGHT, width: bounds.width, height: Math.max(1, bounds.height - WEB_TOOLBAR_HEIGHT) });
      content.setBounds({ x: 0, y: 0, width: bounds.width, height: Math.max(1, bounds.height - WEB_TOOLBAR_HEIGHT) });
    };
    resizeContent();
    window.on("resize", resizeContent);
    const tab: ManagedWebTab = {
      tabId,
      window,
      frame,
      content,
      openedAt: Date.now(),
      state: "loading",
      generation: 0,
      resources: new Map(),
      observedMimeTypes: new Map(),
      writing: false,
      closing: false,
      agentActionInProgress: false,
      lastAgentActionSequence: ++this.agentActionSequence,
      currentViewport: { ...DEFAULT_WEB_VIEWPORT },
      blockedDownloadSequence: 0,
      fileChooserSequence: 0,
      blockedDialogSequence: 0,
    };
    currentTab = tab;
    entry.tabs.set(tabId, tab);
    try {
      this.configureShellWindow(window);
      if (entry.browserSession === undefined) await this.configureBrowserSession(entry, content.webContents.session);
      this.configureTabEvents(entry, tab);
      await Promise.all([
        window.loadURL(webShellUrl(entry.profile.name, humanMode ? "human" : "agent", "Pestaña nueva · sin destino")),
        content.webContents.loadURL("about:blank"),
      ]);
      if (destination !== undefined) await content.webContents.loadURL(destination.href);
      tab.state = "ready";
      if (humanMode) {
        await this.showOnlyHumanTab(entry, tab);
        this.options.onActivityChange?.();
      } else {
        await this.installDebugger(content.webContents, tab.currentViewport);
        window.setPosition(-10_000, -10_000, false);
        window.setIgnoreMouseEvents(true);
        window.setFocusable(false);
        window.showInactive();
        this.noteAgentAction(entry, tab);
      }
      return tab;
    } catch {
      this.destroyTabWindow(tab);
      tab.state = "closed";
      fail("WEB_NAVIGATION_FAILED", "No se pudo preparar la pestaña web aislada.");
    }
  }

  async start(webProfileId: string, operationId?: string): Promise<{ session: WebSessionSummary; tab: WebTabSummary }> {
    const profile = await this.requireProfile(webProfileId);
    const key = operationId === undefined ? undefined : `${webProfileId}:${operationId}`;
    const fp = fingerprint(["web.start", webProfileId]);
    const previous = this.previousOperation<{ session: WebSessionSummary; tab: WebTabSummary }>(key, fp);
    if (previous !== undefined) {
      const current = this.entries.get(previous.session.sessionId);
      if (current !== undefined && current.state === "running" && profileRevision(profile) === current.profileRevision) return previous;
      fail("WEB_SESSION_NOT_FOUND", "La sesión idempotente ya terminó.");
    }
    const running = [...this.entries.values()].filter((entry) => entry.state === "running");
    if (running.length >= MAX_GLOBAL_WEB_SESSIONS || running.filter((entry) => entry.webProfileId === webProfileId).length >= profile.limits.maxSessions) {
      fail("RATE_LIMITED", "Se alcanzó el límite de sesiones web.");
    }
    const sessionId = `websession_${randomBytes(12).toString("hex")}`;
    const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
    this.rememberOperation(key, record);
    let proxy: RunningWebEgressProxy;
    try {
      proxy = await startWebEgressProxy({
        profileId: webProfileId,
        expectedProfileRevision: profileRevision(profile),
        loadProfile: this.options.loadProfile,
      });
    } catch (error) {
      if (key !== undefined) this.operations.delete(key);
      throw error;
    }
    const entry: ManagedWebSession = {
      sessionId,
      webProfileId,
      profile,
      profileRevision: profileRevision(profile),
      partition: `localbridge-web-${randomBytes(16).toString("hex")}`,
      proxy,
      startedAt: Date.now(),
      tabs: new Map(),
      agentDrainWaiters: new Set(),
      activeAgentOperations: 0,
      state: "running",
      controlState: "agent_control",
      downloadedBytes: 0,
    };
    this.entries.set(sessionId, entry);
    try {
      const tab = await this.createTab(entry);
      const result = { session: sessionSummary(entry), tab: tabSummary(entry, tab) };
      record.state = "complete";
      record.result = result;
      return result;
    } catch (error) {
      await this.stopEntry(entry, "stopped", "failed");
      if (key !== undefined) this.operations.delete(key);
      throw error;
    }
  }

  async list(): Promise<readonly WebSessionSummary[]> {
    for (const entry of this.entries.values()) {
      if (entry.state !== "running") continue;
      const current = await this.options.loadProfile(entry.webProfileId).catch(() => undefined);
      if (current === undefined || !current.enabled || current.reviewRequired || profileRevision(current) !== entry.profileRevision) {
        await this.stopEntry(entry);
      }
    }
    return [...this.entries.values()].filter((entry) => entry.state === "running").map(sessionSummary);
  }

  listAll(): readonly WebSessionSummary[] {
    return [...this.entries.values()].map(sessionSummary);
  }

  async listTabsLocally(sessionId: string): Promise<readonly WebTabSummary[]> {
    return this.tabs(sessionId);
  }

  async showLiveViewerLocally(
    sessionId: string,
    mode: "follow" | "pinned",
    workArea: WebLiveViewerWorkArea,
    tabId?: string,
    presentationMode?: ViewerPresentationMode,
  ): Promise<void> {
    const revision = ++this.viewerRevision;
    await this.enqueueViewer(async () => {
      if (revision !== this.viewerRevision) return;
      const entry = await this.requireSession(sessionId);
      const tab = mode === "pinned"
        ? this.requireTab(entry, tabId ?? "")
        : this.latestAgentTab(entry);
      if (tab === undefined) fail("WEB_TAB_NOT_FOUND", "La sesión web no tiene pestañas visibles.");

      const previous = this.liveViewer;
      if (previous !== undefined && (previous.sessionId !== sessionId || previous.tabId !== tab.tabId)) {
        const previousEntry = this.entries.get(previous.sessionId);
        const previousTab = previousEntry?.tabs.get(previous.tabId);
        if (previousTab !== undefined) this.hideViewerWindow(previousTab);
      }
      if (revision !== this.viewerRevision) return;

      await this.showViewerWindow(entry, tab, workArea, presentationMode);
      const currentProfile = await this.options.loadProfile(entry.webProfileId).catch(() => undefined);
      if (revision !== this.viewerRevision || entry.state !== "running" || entry.controlState !== "agent_control" ||
          currentProfile === undefined || !currentProfile.enabled || !currentProfile.permissions.read || currentProfile.reviewRequired ||
          profileRevision(currentProfile) !== entry.profileRevision || tab.state === "closed" || tab.window.isDestroyed()) {
        this.hideViewerWindow(tab);
        if (revision === this.viewerRevision) fail("PROFILE_REVIEW_REQUIRED", "La vista web perdió su autorización antes de mostrarse.");
        return;
      }
      this.liveViewer = { mode, sessionId, tabId: tab.tabId, workArea };
      this.notifyViewerChange();
    });
  }

  async hideLiveViewerLocally(sessionId?: string): Promise<void> {
    const revision = ++this.viewerRevision;
    await this.enqueueViewer(async () => {
      const current = this.liveViewer;
      if (current === undefined || (sessionId !== undefined && current.sessionId !== sessionId)) return;
      const entry = this.entries.get(current.sessionId);
      const tab = entry?.tabs.get(current.tabId);
      if (tab !== undefined) this.hideViewerWindow(tab);
      if (revision === this.viewerRevision && this.liveViewer === current) {
        this.liveViewer = undefined;
        this.notifyViewerChange();
      }
    });
  }

  async moveLiveViewerLocally(sessionId: string, workArea: WebLiveViewerWorkArea): Promise<void> {
    const revision = ++this.viewerRevision;
    await this.enqueueViewer(async () => {
      const current = this.liveViewer;
      if (current === undefined || current.sessionId !== sessionId) {
        fail("WEB_SESSION_NOT_FOUND", "La sesión web no tiene una vista en vivo abierta.");
      }
      const entry = await this.requireSession(sessionId);
      const tab = this.requireTab(entry, current.tabId);
      if (revision !== this.viewerRevision) return;
      await this.positionViewer(entry, tab, workArea);
      tab.window.showInactive();
      this.liveViewer = { ...current, workArea };
      this.notifyViewerChange();
    });
  }

  async setLiveViewerPresentationLocally(
    sessionId: string,
    mode: ViewerPresentationMode,
    panX = 0,
    panY = 0,
  ): Promise<void> {
    const revision = ++this.viewerRevision;
    await this.enqueueViewer(async () => {
      const current = this.liveViewer;
      if (current === undefined || current.sessionId !== sessionId) {
        fail("WEB_SESSION_NOT_FOUND", "La sesión web no tiene una vista en vivo abierta.");
      }
      const entry = await this.requireSession(sessionId);
      const tab = this.requireTab(entry, current.tabId);
      if (revision !== this.viewerRevision) return;
      await this.positionViewer(entry, tab, current.workArea, mode, { x: panX, y: panY });
      tab.window.showInactive();
      this.notifyViewerChange();
    });
  }

  cancelMotionLocally(sessionId: string, tabId: string): void {
    const entry = this.entries.get(sessionId);
    const tab = entry?.tabs.get(tabId);
    if (entry?.state !== "running" || tab === undefined || tab.state === "closed") return;
    if (tab.motionCapture !== undefined) tab.generation += 1;
    this.options.onActivityChange?.();
  }

  async stopProfile(webProfileId: string): Promise<void> {
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.webProfileId === webProfileId && entry.state === "running")
      .map((entry) => this.stopEntry(entry)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.state === "running")
      .map((entry) => this.stopEntry(entry)));
  }

  async tabs(sessionId: string): Promise<readonly WebTabSummary[]> {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () =>
      [...entry.tabs.values()].filter((tab) => tab.state !== "closed").map((tab) => tabSummary(entry, tab)));
  }

  async open(sessionId: string, url: string, operationId?: string): Promise<WebTabSummary> {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      const destination = this.assertNavigation(entry, url);
      const key = this.operationKey(entry, operationId);
      const fp = fingerprint(["web.open", destination.href]);
      const previous = this.previousOperation<WebTabSummary>(key, fp);
      if (previous !== undefined) return previous;
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      try {
        const tab = await this.createTab(entry, destination);
        const result = tabSummary(entry, tab);
        record.state = "complete";
        record.result = result;
        return result;
      } catch {
        record.state = "uncertain";
        fail("WEB_EFFECT_UNCERTAIN", "La apertura web pudo completarse antes del fallo.");
      }
    });
  }

  async closeTab(sessionId: string, tabId: string, operationId?: string): Promise<WebTabSummary> {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      const key = this.operationKey(entry, operationId);
      const fp = fingerprint(["web.close", tabId]);
      const previous = this.previousOperation<WebTabSummary>(key, fp);
      if (previous !== undefined) return previous;
      const tab = this.requireTab(entry, tabId);
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      const before = tabSummary(entry, tab);
      const visible = this.liveViewer?.sessionId === entry.sessionId && this.liveViewer.tabId === tab.tabId
        ? this.liveViewer
        : undefined;
      if (visible !== undefined) {
        this.liveViewer = undefined;
        this.viewerRevision += 1;
        this.hideViewerWindow(tab);
      }
      tab.state = "closed";
      tab.snapshot = undefined;
      tab.resources.clear();
      this.destroyTabWindow(tab);
      const result = { ...before, state: "closed" as const };
      record.state = "complete";
      record.result = result;
      if (visible?.mode === "follow") {
        const replacement = this.latestAgentTab(entry);
        if (replacement !== undefined) {
          await this.showLiveViewerLocally(entry.sessionId, "follow", visible.workArea).catch(() => undefined);
        } else {
          this.notifyViewerChange();
        }
      } else if (visible !== undefined) {
        this.notifyViewerChange();
      } else {
        this.options.onActivityChange?.();
      }
      return result;
    });
  }

  async navigate(sessionId: string, tabId: string, url: string, operationId?: string): Promise<WebTabSummary> {
    const entry = await this.requireSession(sessionId);
    let navigationStarted = false;
    let key: string | undefined;
    let record: OperationRecord | undefined;
    try {
      return await this.withAgentOperation(entry, async () => {
        const tab = this.requireTab(entry, tabId);
        const destination = this.assertNavigation(entry, url);
        key = this.operationKey(entry, operationId);
        const fp = fingerprint(["web.navigate", tabId, destination.href]);
        const previous = this.previousOperation<WebTabSummary>(key, fp);
        if (previous !== undefined) return previous;
        return this.withTabWriter(entry, tab, async () => {
          record = { fingerprint: fp, sessionId, state: "pending" };
          this.rememberOperation(key, record);
          navigationStarted = true;
          try {
            await tab.content.webContents.loadURL(destination.href);
          } catch (error) {
            // Chromium puede rechazar loadURL con ERR_ABORTED cuando la carga fue
            // sustituida justo después de alcanzar el mismo destino. Verificamos
            // el estado observable antes de convertirlo en un fallo incierto.
            if (didNavigationReachDestination({
              currentUrl: tab.content.webContents.getURL(),
              destinationUrl: destination.href,
              pageState: tab.state,
            })) {
              this.options.onNavigationDiagnostic?.({
                sessionId,
                tabId,
                outcome: 'recovered',
                causeCode: 'WEB_NAVIGATION_FAILED',
                ...(operationId === undefined ? {} : { operationId }),
              });
            } else {
              throw error;
            }
          }
          const result = tabSummary(entry, tab);
          record.state = "complete";
          record.result = result;
          return result;
        });
      });
    } catch (error) {
      if (error instanceof DevelopmentBrokerError) throw error;
      if (navigationStarted) {
        if (record !== undefined) record.state = "uncertain";
        const causeCode = safeCauseCode(error) ?? 'WEB_NAVIGATION_FAILED';
        this.options.onNavigationDiagnostic?.({ sessionId, tabId, outcome: 'failed', causeCode, ...(operationId === undefined ? {} : { operationId }) });
        fail("WEB_EFFECT_UNCERTAIN", "La navegación web pudo completarse antes del fallo.", causeCode);
      }
      if (key !== undefined) this.operations.delete(key);
      const causeCode = safeCauseCode(error) ?? 'WEB_NAVIGATION_FAILED';
      this.options.onNavigationDiagnostic?.({ sessionId, tabId, outcome: 'failed', causeCode, ...(operationId === undefined ? {} : { operationId }) });
      fail("WEB_NAVIGATION_FAILED", "No se pudo iniciar la navegación web.", causeCode);
    }
  }

  async reload(sessionId: string, tabId: string, mode: BrowserReloadMode, operationId: string): Promise<WebTabSummary> {
    const entry = await this.requireSession(sessionId);
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.reload", tabId, mode]);
    const previous = this.previousOperation<WebTabSummary>(key, fp);
    if (previous !== undefined) return previous;
    let effectStarted = false;
    const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
    try {
      return await this.withAgentOperation(entry, async () => {
        const tab = this.requireTab(entry, tabId);
        const current = this.assertNavigation(entry, tab.content.webContents.getURL());
        if (current.href === "") fail("WEB_DESTINATION_BLOCKED", "La pestaña no tiene un destino recargable.");
        return this.withTabWriter(entry, tab, async () => {
          this.rememberOperation(key, record);
          try {
            effectStarted = true;
            await reloadManagedWebContents(tab.content.webContents, mode);
          } catch {
            record.state = "uncertain";
            fail("WEB_EFFECT_UNCERTAIN", "La recarga web pudo completarse antes del fallo; vuelve a observar la pestaña.");
          }
          this.invalidate(tab);
          const result = tabSummary(entry, tab);
          record.state = "complete";
          record.result = result;
          return result;
        });
      });
    } catch (error) {
      if (!effectStarted && key !== undefined) this.operations.delete(key);
      throw error;
    }
  }

  async back(sessionId: string, tabId: string, operationId?: string): Promise<WebTabSummary> {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      const key = this.operationKey(entry, operationId);
      const fp = fingerprint(["web.back", tabId, tab.generation]);
      const previous = this.previousOperation<WebTabSummary>(key, fp);
      if (previous !== undefined) return previous;
      if (!tab.content.webContents.navigationHistory.canGoBack()) fail("WEB_NAVIGATION_FAILED", "La pestaña no tiene historial anterior.");
      return this.withTabWriter(entry, tab, async () => {
        const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
        this.rememberOperation(key, record);
        try {
          await tab.content.webContents.navigationHistory.goBack();
          const result = tabSummary(entry, tab);
          record.state = "complete";
          record.result = result;
          return result;
        } catch {
          record.state = "uncertain";
          fail("WEB_EFFECT_UNCERTAIN", "Volver atrás pudo completarse antes del fallo.");
        }
      });
    });
  }

  async snapshot(sessionId: string, tabId: string, maxDepth: number, maxElements: number) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const result = await tab.content.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes?: Array<Record<string, unknown>> };
    const nodes = result.nodes ?? [];
    const byId = new Map(nodes.map((node) => [stringValue(node["nodeId"]), node]));
    const elements = new Map<string, ElementBinding>();
    const output: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (const node of nodes) {
      if (node["ignored"] === true) continue;
      let depth = 0;
      let parentId = stringValue(node["parentId"]);
      while (parentId !== "" && depth <= maxDepth) {
        depth += 1;
        parentId = stringValue(byId.get(parentId)?.["parentId"]);
      }
      if (depth > maxDepth || output.length >= Math.min(maxElements, MAX_SNAPSHOT_ELEMENTS)) {
        truncated = true;
        continue;
      }
      const role = stringValue((node["role"] as Record<string, unknown> | undefined)?.["value"]) || "generic";
      const name = stringValue((node["name"] as Record<string, unknown> | undefined)?.["value"]).trim().slice(0, 512);
      const rawValue = stringValue((node["value"] as Record<string, unknown> | undefined)?.["value"]);
      const properties = node["properties"] as Array<{ name?: string; value?: { value?: unknown } }> | undefined;
      const protectedValue = properties?.some((property) => property.name === "protected" && property.value?.value === true) === true;
      const backendNodeId = typeof node["backendDOMNodeId"] === "number" ? node["backendDOMNodeId"] : undefined;
      const elementRef = backendNodeId === undefined || !INTERACTIVE_ROLES.has(role) ? undefined : `webelement_${randomBytes(10).toString("hex")}`;
      if (elementRef !== undefined && backendNodeId !== undefined) elements.set(elementRef, { backendNodeId, role });
      output.push({
        depth,
        role,
        name,
        ...(rawValue === "" ? {} : { value: protectedValue ? "[redacted]" : rawValue.slice(0, 1_024) }),
        ...(elementRef === undefined ? {} : { elementRef }),
      });
    }
    const snapshotId = `websnapshot_${randomBytes(10).toString("hex")}`;
    tab.snapshot = { snapshotId, generation: tab.generation, elements };
    return {
      snapshotId,
      tabId,
      title: tab.content.webContents.getTitle().slice(0, 256),
      url: safeObservedUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite),
      nodes: output,
      truncated,
    };
    });
  }

  private captureDiagnostic(tab: ManagedWebTab, input: Omit<Parameters<NonNullable<WebControllerOptions["onCaptureDiagnostic"]>>[0], "sessionId" | "tabId">): void {
    const entry = [...this.entries.values()].find((candidate) => candidate.tabs.get(tab.tabId) === tab);
    if (entry !== undefined) this.options.onCaptureDiagnostic?.({ sessionId: entry.sessionId, tabId: tab.tabId, ...input });
  }

  private async captureScreenshotData(tab: ManagedWebTab, transportBounded = true, operationId?: string): Promise<{
    mimeType: "image/png" | "image/jpeg";
    dataBase64: string;
    width: number;
    height: number;
    fallbackUsed: boolean;
  }> {
    const diagnostic = (input: Omit<Parameters<NonNullable<WebControllerOptions["onCaptureDiagnostic"]>>[0], "sessionId" | "tabId" | "operationId">): void =>
      this.captureDiagnostic(tab, { ...input, ...(operationId === undefined ? {} : { operationId }) });
    let width = tab.currentViewport.width;
    let height = tab.currentViewport.height;
    try {
      const metrics = await tab.content.webContents.debugger.sendCommand("Page.getLayoutMetrics") as {
        cssVisualViewport?: { clientWidth?: unknown; clientHeight?: unknown };
      };
      if (typeof metrics.cssVisualViewport?.clientWidth === "number") width = Math.max(1, Math.round(metrics.cssVisualViewport.clientWidth));
      if (typeof metrics.cssVisualViewport?.clientHeight === "number") height = Math.max(1, Math.round(metrics.cssVisualViewport.clientHeight));
      diagnostic({ stage: "metrics", outcome: "success", width, height });
    } catch {
      diagnostic({ stage: "metrics", outcome: "fallback", width, height });
    }

    const capture = async (format: "png" | "jpeg", quality?: number): Promise<string> => {
      const invoke = () => tab.content.webContents.debugger.sendCommand("Page.captureScreenshot", {
        format,
        ...(quality === undefined ? {} : { quality }),
        fromSurface: true,
        captureBeyondViewport: false,
      }) as Promise<{ data?: unknown }>;
      let result: { data?: unknown };
      try {
        result = await invoke();
      } catch {
        diagnostic({ stage: "capture", outcome: "retry", width, height });
        try {
          await tab.content.webContents.debugger.sendCommand("Page.enable");
          result = await invoke();
        } catch {
          diagnostic({ stage: "capture", outcome: "failed", width, height, code: "WEB_CAPTURE_FAILED" });
          fail("WEB_CAPTURE_FAILED", "El navegador no pudo completar la captura tras un reintento seguro.");
        }
      }
      if (typeof result.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) {
        diagnostic({ stage: "capture", outcome: "failed", width, height, code: "WEB_CAPTURE_FAILED" });
        fail("WEB_CAPTURE_FAILED", "El navegador no devolvió una captura válida.");
      }
      const bytes = Buffer.from(result.data, "base64");
      const validSignature = format === "png"
        ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
      if (!validSignature) {
        diagnostic({ stage: "capture", outcome: "failed", width, height, code: "WEB_CAPTURE_FAILED" });
        fail("WEB_CAPTURE_FAILED", "El navegador devolvió una imagen con firma inválida.");
      }
      return result.data;
    };

    const png = await capture("png");
    if (!transportBounded || Buffer.byteLength(png, "utf8") <= MAX_SCREENSHOT_BASE64_BYTES) {
      const dimensions = capturedImageDimensions(png, "image/png", tab.currentViewport);
      diagnostic({ stage: "transport", outcome: "success", ...dimensions, encodedBytes: Buffer.byteLength(png, "utf8") });
      return { mimeType: "image/png", dataBase64: png, ...dimensions, fallbackUsed: false };
    }
    diagnostic({ stage: "transport", outcome: "fallback", width, height, encodedBytes: Buffer.byteLength(png, "utf8") });
    for (const quality of [85, 70]) {
      const jpeg = await capture("jpeg", quality);
      if (Buffer.byteLength(jpeg, "utf8") <= MAX_SCREENSHOT_BASE64_BYTES) {
        const dimensions = capturedImageDimensions(jpeg, "image/jpeg", tab.currentViewport);
        diagnostic({ stage: "transport", outcome: "success", ...dimensions, encodedBytes: Buffer.byteLength(jpeg, "utf8") });
        return { mimeType: "image/jpeg", dataBase64: jpeg, ...dimensions, fallbackUsed: true };
      }
    }
    diagnostic({ stage: "transport", outcome: "failed", width, height, encodedBytes: Buffer.byteLength(png, "utf8"), code: "WEB_CAPTURE_TOO_LARGE" });
    fail("WEB_CAPTURE_TOO_LARGE", "La captura supera el presupuesto seguro del broker.");
  }

  async screenshot(sessionId: string, tabId: string, settleMs = 0) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      this.ensureAgentControl(entry);
      return this.captureScreenshotData(this.requireTab(entry, tabId));
    });
  }

  async inspect(
    sessionId: string,
    tabId: string,
    target: 'element' | 'active',
    snapshotId: string | undefined,
    elementRef: string | undefined,
    cssProperties: readonly string[],
    cssVariables: readonly string[],
  ) {
    const entry = await this.requireSession(sessionId, "read");
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      let objectId: string | undefined;
      if (target === 'element') {
        if (snapshotId === undefined || elementRef === undefined) fail("INVALID_INPUT", "La inspección web requiere snapshotId y elementRef.");
        const binding = this.resolveElement(tab, snapshotId, elementRef);
        const nodeId = await this.resolveNode(tab, binding);
        const resolved = await tab.content.webContents.debugger.sendCommand("DOM.resolveNode", { nodeId }) as { object?: { objectId?: string } };
        objectId = resolved.object?.objectId;
      } else {
        const resolved = await tab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
          expression: "document.activeElement",
        }) as { result?: { objectId?: string } };
        objectId = resolved.result?.objectId;
      }
      if (objectId === undefined) fail("ELEMENT_NOT_INTERACTABLE", "No hay un elemento activo que se pueda inspeccionar.");
      try {
        const inspection = await inspectResolvedBrowserElement(tab.content.webContents, objectId, cssProperties, cssVariables);
        return { sessionId, tabId, target, ...inspection };
      } finally {
        await tab.content.webContents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    });
  }

  async saveScreenshot(sessionId: string, tabId: string, workspaceId: string, destinationPath: string, operationId: string, settleMs = 0) {
    const entry = await this.requireSession(sessionId, "download");
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      if (this.options.saveDownload === undefined) fail("FEATURE_UNAVAILABLE", "El guardado de evidencia visual no está disponible.");
      const key = this.operationKey(entry, operationId);
      const fp = fingerprint(["web.screenshot.save", tabId, workspaceId, destinationPath, settleMs]);
      const previous = this.previousOperation(key, fp);
      if (previous !== undefined) return previous;
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      let saveStarted = false;
      try {
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
        this.ensureAgentControl(entry);
        // The bytes stay in the desktop process and only the receipt crosses the
        // broker, so preserve lossless PNG evidence instead of applying the
        // transport-size JPEG fallback used by web.screenshot.
        const capture = await this.captureScreenshotData(tab, false, operationId);
        const bytes = Buffer.from(capture.dataBase64, "base64");
        const mimeType = validateDownloadedResource(destinationPath, capture.mimeType, bytes);
        const current = await this.requireProfile(entry.webProfileId, "download");
        if (profileRevision(current) !== entry.profileRevision) fail("CAPABILITY_DISABLED", "El perfil cambió durante la captura.");
        assertWebDownloadFits(bytes.byteLength, current.limits.transferPolicy.mode === 'adaptive'
          ? { mode: 'adaptive', downloadedBytes: entry.downloadedBytes }
          : {
              mode: 'fixed', maxAssetBytes: current.limits.maxDownloadBytes,
              maxTotalBytes: current.limits.maxTotalDownloadBytes, downloadedBytes: entry.downloadedBytes,
            });
        saveStarted = true;
        const saved = await this.options.saveDownload({
          webProfileId: entry.webProfileId,
          profileRevision: entry.profileRevision,
          workspaceId,
          path: destinationPath,
          bytes,
          mimeType,
          maximumBytes: current.limits.maxDownloadBytes,
        });
        entry.downloadedBytes += bytes.byteLength;
        const result = {
          sessionId, tabId, ...saved, mimeType, width: capture.width, height: capture.height,
          fallbackUsed: capture.fallbackUsed,
          sourceUrl: safeObservedUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite),
        };
        record.state = "complete";
        record.result = result;
        return result;
      } catch (error) {
        if (saveStarted) {
          if (error instanceof LocalBridgeError) {
            if (key !== undefined) this.operations.delete(key);
            throw error;
          }
          record.state = "uncertain";
          fail("WEB_EFFECT_UNCERTAIN", "La captura pudo guardarse antes del fallo.");
        }
        if (key !== undefined) this.operations.delete(key);
        throw error;
      }
    });
  }

  async inspectMotion(sessionId: string, tabId: string, maxAnimations: number) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      return inspectPageMotion(tab.content.webContents, tab.currentViewport, tab.generation, maxAnimations, 'webmotion');
    });
  }

  async captureMotion(
    sessionId: string,
    tabId: string,
    workspaceId: string,
    destinationPath: string,
    trajectory: MotionTrajectory,
    settleBeforeMs: number,
    captureMode: MotionCaptureMode,
    operationId: string,
  ) {
    const entry = await this.requireSession(sessionId, 'download');
    if (this.options.saveMotionBundle === undefined) fail('FEATURE_UNAVAILABLE', 'La captura temporal no está disponible.');
    if (!destinationPath.toLowerCase().endsWith('.lbmotion')) fail('INVALID_INPUT', 'La traza temporal debe guardarse como un directorio .lbmotion nuevo.');
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(['web.motion.capture', tabId, workspaceId, destinationPath, trajectory, settleBeforeMs, captureMode]);
    const previous = key === undefined ? undefined : this.operations.get(key);
    if (previous !== undefined) {
      if (previous.fingerprint !== fp) fail('IDEMPOTENCY_CONFLICT', 'El operationId ya representa otra acción web.');
      if (previous.state !== 'complete') fail('MOTION_EFFECT_UNCERTAIN', 'La captura temporal anterior pudo desplazar la página; no se repetirá automáticamente.', previous.causeCode);
      return previous.result;
    }
    const record: OperationRecord = { fingerprint: fp, sessionId, state: 'pending' };
    this.rememberOperation(key, record);
    let effectStarted = false;
    try {
      const result = await this.withAgentOperation(entry, async () => {
        const tab = this.requireTab(entry, tabId);
        return this.withTabWriter(entry, tab, async () => {
          tab.motionCapture = { completed: 0, total: trajectory.sampleCount, mode: captureMode };
          this.options.onActivityChange?.();
          const generation = tab.generation;
          const current = await this.requireProfile(entry.webProfileId, 'download');
          if (profileRevision(current) !== entry.profileRevision) fail('CAPABILITY_DISABLED', 'El perfil cambió antes de la captura temporal.');
          const observed = safeObservedResourceUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite);
          const parsed = normalizePublicHttpsUrl(observed);
          const saved = await this.options.saveMotionBundle!({
            webProfileId: entry.webProfileId,
            profileRevision: entry.profileRevision,
            workspaceId,
            path: destinationPath,
            produce: (writer) => capturePageMotion({
              webContents: tab.content.webContents,
              writer,
              viewport: tab.currentViewport,
              trajectory,
              settleBeforeMs,
              captureMode,
              sourceFamily: 'web',
              source: parsed === undefined ? { origin: 'about:blank', path: '/' } : { origin: parsed.origin, path: parsed.pathname },
              generation,
              assertCurrent: () => {
                if (tab.generation !== generation) fail('MOTION_CAPTURE_INTERRUPTED', 'La página cambió durante la captura temporal.');
                this.ensureAgentControl(entry);
                if (entry.state !== 'running' || tab.state === 'closed' || tab.content.webContents.isDestroyed()) {
                  fail('MOTION_CAPTURE_INTERRUPTED', 'La pestaña terminó durante la captura temporal.');
                }
              },
              onEffectStart: () => { effectStarted = true; },
              onProgress: (progress) => {
                tab.motionCapture = { ...progress, mode: captureMode };
                this.options.onActivityChange?.();
              },
            }),
          });
          tab.generation += 1;
          delete tab.snapshot;
          return {
            sessionId,
            tabId,
            path: saved.path,
            created: saved.created,
            totalSize: saved.totalSize,
            fileCount: saved.fileCount,
            manifestPath: `${saved.path}/${saved.value.manifest.path}`,
            qualityPath: `${saved.path}/${saved.value.quality.path}`,
            contactSheetPath: `${saved.path}/${saved.value.contactSheet.path}`,
            frameCount: saved.value.frameCount,
            width: saved.value.width,
            height: saved.value.height,
            captureMode: saved.value.captureMode,
            temporalFidelity: saved.value.temporalFidelity,
            droppedFrames: saved.value.droppedFrames,
            warnings: saved.value.warnings,
            sourceUrl: observed,
          };
        });
      });
      const completedTab = entry.tabs.get(tabId);
      if (completedTab !== undefined) {
        const capture = result as {
          path: string; frameCount: number; totalSize: number;
          captureMode: 'stepped' | 'screencast'; warnings: readonly string[];
        };
        completedTab.lastMotionCapture = {
          path: capture.path,
          frameCount: capture.frameCount,
          totalSize: capture.totalSize,
          captureMode: capture.captureMode,
          warnings: capture.warnings,
        };
      }
      record.state = 'complete';
      record.result = result;
      return result;
    } catch (error) {
      if (!effectStarted) {
        if (key !== undefined) this.operations.delete(key);
      } else {
        record.state = 'uncertain';
        const causeCode = safeCauseCode(error);
        if (causeCode !== undefined) record.causeCode = causeCode;
        this.options.onMotionDiagnostic?.({
          sessionId,
          tabId,
          outcome: 'failed',
          operationId,
          ...(causeCode === undefined ? {} : { causeCode }),
        });
        fail('MOTION_EFFECT_UNCERTAIN', 'La captura se interrumpió después de desplazar la página; comprueba el estado antes de reintentar.', causeCode);
      }
      throw error;
    } finally {
      const tab = entry.tabs.get(tabId);
      if (tab !== undefined) delete tab.motionCapture;
      this.options.onActivityChange?.();
    }
  }

  async extract(sessionId: string, tabId: string, maxChars: number) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const limit = Math.min(maxChars, entry.profile.limits.maxExtractedChars);
    const evaluated = await tab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => ({ text: document.body?.innerText ?? '', links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map((link) => ({ text: link.textContent ?? '', href: link.href })) }))()`,
      returnByValue: true,
    }) as { result?: { value?: { text?: unknown; links?: Array<{ text?: unknown; href?: unknown }> } } };
    const value = evaluated.result?.value;
    const fullText = stringValue(value?.text);
    const resources: Array<{ resourceRef: string; text: string; url: string }> = [];
    for (const link of value?.links ?? []) {
      const href = stringValue(link.href);
      const parsed = normalizePublicHttpsUrl(href);
      if (parsed === undefined || !isWebEgressHostAllowed(entry.profile, parsed.hostname)) continue;
      const resourceRef = `webresource_${randomBytes(10).toString("hex")}`;
      tab.resources.set(resourceRef, { resourceRef, generation: tab.generation, url: parsed.href, kind: "document" });
      resources.push({ resourceRef, text: stringValue(link.text).trim().slice(0, 512), url: safeObservedResourceUrl(entry.profile, parsed.href, entry.delegatedSite) });
    }
    return {
      tabId,
      title: tab.content.webContents.getTitle().slice(0, 256),
      url: safeObservedUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite),
      consultedAt: new Date().toISOString(),
      text: fullText.slice(0, limit),
      truncated: fullText.length > limit,
      resources,
    };
    });
  }

  async assets(sessionId: string, tabId: string, maxAssets: number) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      const limit = Math.min(500, Math.max(1, maxAssets));
      const evaluated = await tab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: `(() => {
          const values = []; const seen = new Set(); const cap = ${limit * 3};
          const full = () => values.length >= cap;
          const add = (url, kind, label = '') => {
            if (full() || typeof url !== 'string' || !url || seen.has(url)) return;
            try { const absolute = new URL(url, document.baseURI).href; if (!absolute.startsWith('https://') || seen.has(absolute)) return; seen.add(absolute); values.push({ url: absolute, kind, label }); } catch {}
          };
          for (const image of document.querySelectorAll('img')) { if (full()) break; add(image.currentSrc || image.src, 'image', image.alt || ''); }
          for (const video of document.querySelectorAll('video')) { if (full()) break; add(video.currentSrc || video.src, 'video', video.getAttribute('aria-label') || ''); add(video.poster, 'poster', 'poster'); }
          for (const source of document.querySelectorAll('source[src]')) { if (full()) break; add(source.src, source.closest('video') ? 'video' : 'image', ''); }
          for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) { if (full()) break; add(link.href, 'stylesheet', 'stylesheet'); }
          for (const item of performance.getEntriesByType('resource')) {
            if (full()) break;
            const name = item.name || ''; const type = item.initiatorType || '';
            const lower = name.toLowerCase();
            const kind = type === 'img' ? 'image' : type === 'video' ? 'video' : type === 'css' || /\\.css(?:[?#]|$)/.test(lower) ? 'stylesheet' : /\\.(?:woff2?|ttf|otf)(?:[?#]|$)/.test(lower) ? 'font' : /\\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/.test(lower) ? 'image' : /\\.(?:mp4|webm|mov)(?:[?#]|$)/.test(lower) ? 'video' : 'other';
            if (kind !== 'other') add(name, kind, '');
          }
          return values;
        })()`,
        returnByValue: true,
      }) as { result?: { value?: Array<{ url?: unknown; kind?: unknown; label?: unknown }> } };
      const assets: Array<{ resourceRef: string; kind: WebAssetKind; url: string; suggestedName: string; observedMimeType?: string; label?: string }> = [];
      const seen = new Set<string>();
      const allowedKinds = new Set<WebAssetKind>(["image", "video", "poster", "font", "stylesheet"]);
      for (const candidate of evaluated.result?.value ?? []) {
        if (assets.length >= limit) break;
        const parsed = normalizePublicHttpsUrl(stringValue(candidate.url));
        const kind = stringValue(candidate.kind) as WebAssetKind;
        if (parsed === undefined || seen.has(parsed.href) || !allowedKinds.has(kind) || !isWebEgressHostAllowed(entry.profile, parsed.hostname)) continue;
        seen.add(parsed.href);
        const encodedName = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "asset";
        let decodedName: string;
        try { decodedName = decodeURIComponent(encodedName); } catch { decodedName = encodedName; }
        const rawName = decodedName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160) || "asset";
        const observedMimeType = tab.observedMimeTypes.get(parsed.href);
        let suggestedName = rawName;
        if (observedMimeType !== undefined) {
          try { suggestedName = resolveDownloadedResourceDestination(rawName, observedMimeType); } catch { /* el fetch final dará el código estable */ }
        }
        const resourceRef = `webresource_${randomBytes(10).toString("hex")}`;
        tab.resources.set(resourceRef, { resourceRef, generation: tab.generation, url: parsed.href, kind, ...(observedMimeType === undefined ? {} : { observedMimeType }) });
        const label = stringValue(candidate.label).trim().slice(0, 256);
        assets.push({ resourceRef, kind, url: safeObservedResourceUrl(entry.profile, parsed.href, entry.delegatedSite), suggestedName, ...(observedMimeType === undefined ? {} : { observedMimeType }), ...(label === "" ? {} : { label }) });
      }
      return { tabId, url: safeObservedUrl(entry.profile, tab.content.webContents.getURL(), entry.delegatedSite), observedAt: new Date().toISOString(), assets, truncated: (evaluated.result?.value?.length ?? 0) > assets.length };
    });
  }

  async setViewport(sessionId: string, tabId: string, width: number, height: number, mobile: boolean, operationId?: string) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 3840 || height < 320 || height > 2160) {
        fail("INVALID_INPUT", "Las dimensiones del viewport web están fuera del rango permitido.");
      }
      const key = this.operationKey(entry, operationId);
      const fp = fingerprint(["web.viewport", tabId, width, height, mobile]);
      const previous = this.previousOperation(key, fp);
      if (previous !== undefined) {
        if (tab.currentViewport.width === width && tab.currentViewport.height === height && tab.currentViewport.mobile === mobile) return previous;
        fail("IDEMPOTENCY_CONFLICT", "El viewport web cambió después de la operación original.");
      }
      await tab.content.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await tab.content.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: mobile, ...(mobile ? { maxTouchPoints: 5 } : {}) }).catch(() => undefined);
      tab.currentViewport = { width, height, mobile };
      this.invalidate(tab);
      const visible = this.liveViewer;
      if (visible?.sessionId === sessionId && visible.tabId === tabId) {
        await this.positionViewer(entry, tab, visible.workArea);
      }
      const result = { sessionId, tabId, width, height, mobile, state: tab.state };
      this.rememberOperation(key, { fingerprint: fp, sessionId, state: "complete", result });
      this.options.onActivityChange?.();
      return result;
    });
  }

  async download(
    sessionId: string,
    tabId: string,
    resourceRef: string,
    workspaceId: string,
    destinationPath: string,
    operationId: string,
    externalSignal?: AbortSignal,
  ) {
    const entry = await this.requireSession(sessionId, "download");
    // Esperar un worker de descarga no mantiene artificialmente el control del
    // agente sobre el navegador. Al obtener el slot, withAgentOperation vuelve
    // a comprobar si el usuario tomó control mientras el job estaba en cola.
    const releaseDownloadSlot = await this.acquireDownloadSlot(externalSignal);
    try {
      return await this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const resource = tab.resources.get(resourceRef);
    if (resource === undefined || resource.generation !== tab.generation) {
      fail("WEB_RESOURCE_NOT_FOUND", "La referencia de descarga ya no está vigente.");
    }
    if (this.options.saveDownloadStream === undefined || entry.browserSession === undefined) {
      fail("FEATURE_UNAVAILABLE", "El guardado de descargas no está disponible.");
    }
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.download", sessionId, tabId, resourceRef, workspaceId, destinationPath]);
    const previous = this.previousOperation<unknown>(key, fp);
    if (previous !== undefined) return previous;

    const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
    this.rememberOperation(key, record);
    let saveStarted = false;
    let diagnosticStage: "network" | "response" | "content" | "save" = "network";
    let diagnosticHostname = normalizePublicHttpsUrl(resource.url)?.hostname ?? "invalid";
    let diagnosticStatus: number | undefined;
    let diagnosticSize: number | undefined;
    try {
      const result = await this.withTabWriter(entry, tab, async () => {
        const controller = new AbortController();
        const cancelFromJob = (): void => controller.abort();
        if (externalSignal?.aborted === true) fail('ANALYSIS_CANCELLED', 'El trabajo de descarga fue cancelado.');
        externalSignal?.addEventListener('abort', cancelFromJob, { once: true });
        const timer = setTimeout(() => controller.abort(), 10 * 60_000);
        try {
          const { response, finalUrl } = await fetchObservedWebResource(
            entry.profile,
            resource.url,
            (url, init) => entry.browserSession!.fetch(url, init),
            controller.signal,
          );
          diagnosticStage = "response";
          diagnosticHostname = finalUrl.hostname;
          diagnosticStatus = response.status;
          if (!response.ok) fail("WEB_DOWNLOAD_BLOCKED", "El servidor no entregó un documento descargable.");
          const declaredLength = Number(response.headers.get("content-length") ?? "0");
          const current = await this.requireProfile(entry.webProfileId, "download");
          if (profileRevision(current) !== entry.profileRevision) fail("CAPABILITY_DISABLED", "El perfil cambió durante la descarga.");
          const adaptive = current.limits.transferPolicy.mode === 'adaptive';
          const quota = adaptive
            ? { mode: 'adaptive' as const, downloadedBytes: entry.downloadedBytes }
            : {
                mode: 'fixed' as const, maxAssetBytes: current.limits.maxDownloadBytes,
                maxTotalBytes: current.limits.maxTotalDownloadBytes, downloadedBytes: entry.downloadedBytes,
              };
          const remainingSessionBytes = remainingWebDownloadBytes(quota);
          if (Number.isFinite(declaredLength) && declaredLength > 0) assertWebDownloadFits(declaredLength, quota);
          if (response.body === null) fail("WEB_DOWNLOAD_EMPTY", "La descarga no contiene bytes.");
          const actualDestinationPath = resolveDownloadedResourceDestination(
            destinationPath,
            response.headers.get("content-type") ?? "",
          );
          const validator = createDownloadedResourceStreamValidator(
            actualDestinationPath,
            response.headers.get("content-type") ?? "",
          );
          diagnosticStage = "save";
          saveStarted = true;
          const saved = await this.options.saveDownloadStream!({
            webProfileId: entry.webProfileId,
            profileRevision: entry.profileRevision,
            workspaceId,
            path: actualDestinationPath,
            mimeType: validator.mimeType,
            ...(adaptive ? {} : { maximumBytes: current.limits.maxDownloadBytes }),
            adaptive,
            produce: async (writer) => {
              const reader = response.body!.getReader();
              let total = 0;
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                total += part.value.byteLength;
                if (!adaptive && (total > current.limits.maxDownloadBytes || remainingSessionBytes === undefined || total > remainingSessionBytes)) {
                  await reader.cancel();
                  fail("WEB_DOWNLOAD_QUOTA_EXCEEDED", "La descarga supera la cuota del perfil.");
                }
                validator.write(part.value);
                await writer.write(part.value);
              }
              diagnosticStage = "content";
              diagnosticSize = total;
              validator.finish();
            },
          });
          entry.downloadedBytes += saved.size;
          return { ...saved, mimeType: validator.mimeType, resourceKind: downloadedResourceKind(validator.mimeType, resource.kind), sourceUrl: safeObservedResourceUrl(entry.profile, finalUrl.href, entry.delegatedSite) };
        } finally {
          clearTimeout(timer);
          externalSignal?.removeEventListener('abort', cancelFromJob);
        }
          });
      record.state = "complete";
      record.result = result;
      try {
        this.options.onDownloadDiagnostic?.({
          sessionId, tabId, stage: "save", outcome: "success", hostname: diagnosticHostname,
          operationId,
          ...(diagnosticStatus === undefined ? {} : { status: diagnosticStatus }),
          ...(diagnosticSize === undefined ? {} : { size: diagnosticSize }),
        });
      } catch { /* el diagnóstico no cambia el resultado de la descarga */ }
      return result;
    } catch (error) {
      const effectiveError = externalSignal?.aborted === true
        ? new DevelopmentBrokerError('ANALYSIS_CANCELLED', 'El trabajo de descarga fue cancelado.')
        : error;
      const code = effectiveError instanceof DevelopmentBrokerError || effectiveError instanceof LocalBridgeError ? effectiveError.code : undefined;
      try {
        this.options.onDownloadDiagnostic?.({
          sessionId, tabId, stage: diagnosticStage, outcome: "failed", hostname: diagnosticHostname,
          operationId,
          ...(diagnosticStatus === undefined ? {} : { status: diagnosticStatus }),
          ...(diagnosticSize === undefined ? {} : { size: diagnosticSize }),
          ...(code === undefined ? {} : { code }),
        });
      } catch { /* el diagnóstico no reemplaza el error original */ }
      if (!saveStarted) {
        if (key !== undefined) this.operations.delete(key);
        throw effectiveError;
      }
      if (effectiveError instanceof LocalBridgeError) {
        if (key !== undefined) this.operations.delete(key);
        throw effectiveError;
      }
      if (effectiveError instanceof DevelopmentBrokerError && effectiveError.code !== "WEB_EFFECT_UNCERTAIN") {
        if (key !== undefined) this.operations.delete(key);
        throw effectiveError;
      }
      record.state = "uncertain";
      if (effectiveError instanceof DevelopmentBrokerError && effectiveError.code === "WEB_EFFECT_UNCERTAIN") throw effectiveError;
      fail("WEB_EFFECT_UNCERTAIN", "El archivo pudo guardarse antes del fallo; comprueba el destino antes de reintentar.");
    }
      });
    } finally {
      releaseDownloadSlot();
    }
  }

  /**
   * Admisión sin efectos para task.runMany. Comprueba que la sesión, pestaña y
   * referencia opaca pertenecen todavía al mismo documento autorizado.
   */
  async preflightDownloadReference(sessionId: string, tabId: string, resourceRef: string): Promise<void> {
    const entry = await this.requireSession(sessionId, "download");
    const tab = this.requireTab(entry, tabId);
    const resource = tab.resources.get(resourceRef);
    if (resource === undefined || resource.generation !== tab.generation) {
      fail("WEB_RESOURCE_NOT_FOUND", "La referencia de descarga ya no está vigente.");
    }
    if (this.options.saveDownloadStream === undefined || entry.browserSession === undefined) {
      fail("FEATURE_UNAVAILABLE", "El guardado de descargas no está disponible.");
    }
  }

  private resolveElement(tab: ManagedWebTab, snapshotId: string, elementRef: string): ElementBinding {
    const snapshot = tab.snapshot;
    if (snapshot === undefined || snapshot.snapshotId !== snapshotId || snapshot.generation !== tab.generation) {
      fail("STALE_SNAPSHOT", "El snapshot web ya no representa la página.");
    }
    const binding = snapshot.elements.get(elementRef);
    if (binding === undefined) fail("STALE_SNAPSHOT", "La referencia no pertenece al snapshot web.");
    return binding;
  }

  private async withTabWriter<T>(entry: ManagedWebSession, tab: ManagedWebTab, operation: () => Promise<T>): Promise<T> {
    if (tab.writing) fail("RATE_LIMITED", "La pestaña ya tiene una acción en curso.");
    tab.writing = true;
    tab.agentActionInProgress = true;
    this.noteAgentAction(entry, tab);
    try {
      return await operation();
    } finally {
      tab.writing = false;
      tab.agentActionInProgress = false;
      this.options.onActivityChange?.();
    }
  }

  private async withAgentOperation<T>(entry: ManagedWebSession, operation: () => Promise<T>): Promise<T> {
    this.ensureAgentControl(entry);
    entry.activeAgentOperations += 1;
    try {
      return await operation();
    } finally {
      entry.activeAgentOperations -= 1;
      if (entry.activeAgentOperations === 0) {
        for (const resolve of entry.agentDrainWaiters) resolve();
        entry.agentDrainWaiters.clear();
      }
    }
  }

  private acquireDownloadSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      return Promise.reject(new DevelopmentBrokerError('ANALYSIS_CANCELLED', 'El trabajo de descarga fue cancelado.'));
    }
    if (this.activeDownloadCount === 0) {
      this.activeDownloadCount = 1;
      return Promise.resolve(this.downloadSlotRelease());
    }
    if (this.downloadWaiters.length >= 100) {
      return Promise.reject(new DevelopmentBrokerError('RATE_LIMITED', 'La cola de descargas web está llena; no se inició ningún efecto.'));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: {
        signal?: AbortSignal;
        onAbort?: () => void;
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
      } = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.downloadWaiters.indexOf(waiter);
          if (index >= 0) this.downloadWaiters.splice(index, 1);
          reject(new DevelopmentBrokerError('ANALYSIS_CANCELLED', 'El trabajo de descarga fue cancelado.'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.downloadWaiters.push(waiter);
    });
  }

  private downloadSlotRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.downloadWaiters.shift();
      if (next === undefined) {
        this.activeDownloadCount = 0;
        return;
      }
      if (next.signal !== undefined && next.onAbort !== undefined) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      // El slot permanece ocupado y se transfiere al siguiente waiter.
      next.resolve(this.downloadSlotRelease());
    };
  }

  private waitForAgentOperations(entry: ManagedWebSession): Promise<void> {
    if (entry.activeAgentOperations === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const drained = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        entry.agentDrainWaiters.delete(drained);
        reject(new DevelopmentBrokerError("TIMEOUT", "Las operaciones web activas no terminaron a tiempo."));
      }, 30_000);
      timer.unref();
      entry.agentDrainWaiters.add(drained);
    });
  }

  private async resolveNode(tab: ManagedWebTab, binding: ElementBinding): Promise<number> {
    await tab.content.webContents.debugger.sendCommand("DOM.getDocument", { depth: 0, pierce: true });
    const pushed = await tab.content.webContents.debugger.sendCommand("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [binding.backendNodeId],
    }) as { nodeIds?: number[] };
    const nodeId = pushed.nodeIds?.[0];
    if (nodeId === undefined || nodeId === 0) fail("STALE_SNAPSHOT", "El elemento web ya no existe.");
    return nodeId;
  }

  async click(sessionId: string, tabId: string, snapshotId: string, elementRef: string, operationId?: string) {
    const entry = await this.requireSession(sessionId, "interact");
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.click", tabId, snapshotId, elementRef]);
    const previous = this.previousOperation(key, fp);
    if (previous !== undefined) return previous;
    const binding = this.resolveElement(tab, snapshotId, elementRef);
    return this.withTabWriter(entry, tab, async () => {
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      let effectStarted = false;
      try {
        const nodeId = await this.resolveNode(tab, binding);
        const resolved = await tab.content.webContents.debugger.sendCommand("DOM.resolveNode", { nodeId }) as { object?: { objectId?: string } };
        const objectId = resolved.object?.objectId;
        if (objectId === undefined) fail("STALE_SNAPSHOT", "El elemento web ya no existe.");
        const blockedDownloadBefore = tab.blockedDownloadSequence;
        const fileChooserBefore = tab.fileChooserSequence;
        const blockedDialogBefore = tab.blockedDialogSequence;
        const urlBefore = tab.content.webContents.getURL();
        try {
          const classified = await tab.content.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function () {
              if (!(this instanceof Element) || !this.isConnected) return 'stale';
              const directInput = this instanceof HTMLInputElement ? this : null;
              const label = this instanceof HTMLLabelElement ? this : this.closest('label');
              const labelledInput = label && label.control instanceof HTMLInputElement ? label.control : null;
              const forId = this.getAttribute('for');
              const forInput = forId ? document.getElementById(forId) : null;
              if ((directInput && directInput.type === 'file') || (labelledInput && labelledInput.type === 'file') || (forInput instanceof HTMLInputElement && forInput.type === 'file')) return 'file-selection';
              const link = this instanceof HTMLAnchorElement ? this : this.closest('a');
              if (link instanceof HTMLAnchorElement && link.hasAttribute('download')) return 'native-download';
              const rect = this.getBoundingClientRect(); const style = getComputedStyle(this);
              if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return 'hidden';
              if (this.getAttribute('aria-disabled') === 'true' || ('disabled' in this && this.disabled)) return 'disabled';
              const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
              if (hit !== this && !this.contains(hit)) return 'covered';
              return 'ready';
            }`,
            returnByValue: true,
          }) as { result?: { value?: string } };
          const value = classified.result?.value;
          if (value === "file-selection") {
            fail("HUMAN_ACTION_REQUIRED", "La selección de archivos requiere control humano local.");
          }
          if (value === "native-download") {
            const result = { sessionId, tabId, applied: false as const, snapshotInvalidated: false as const, effect: "native_download_blocked" as const };
            record.state = "complete";
            record.result = result;
            return result;
          }
          if (value !== "ready") {
            fail("ELEMENT_NOT_INTERACTABLE", "El elemento web no puede recibir clic.");
          }
          effectStarted = true;
          await tab.content.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function () { this.click(); return 'clicked'; }",
            returnByValue: true,
            userGesture: true,
          });
        } finally {
          await tab.content.webContents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
        }
        await settle();
        if (tab.fileChooserSequence > fileChooserBefore) {
          effectStarted = false;
          this.invalidate(tab);
          if (key !== undefined) this.operations.delete(key);
          fail("HUMAN_ACTION_REQUIRED", "La página abrió un selector de archivos que requiere control humano local.");
        }
        this.invalidate(tab);
        const effect = tab.blockedDownloadSequence > blockedDownloadBefore
          ? "native_download_blocked" as const
          : tab.blockedDialogSequence > blockedDialogBefore
            ? "dialog_blocked" as const
          : tab.content.webContents.getURL() !== urlBefore || tab.state === "loading"
            ? "navigation_started" as const
            : "effect_pending" as const;
        const result = { sessionId, tabId, applied: true as const, snapshotInvalidated: true as const, effect };
        record.state = "complete";
        record.result = result;
        return result;
      } catch (error) {
        if (effectStarted) {
          record.state = "uncertain";
          fail("WEB_EFFECT_UNCERTAIN", "El clic pudo producir un efecto antes del fallo.");
        }
        if (key !== undefined) this.operations.delete(key);
        throw error;
      }
    });
    });
  }

  async fill(sessionId: string, tabId: string, snapshotId: string, elementRef: string, text: string, operationId?: string) {
    const entry = await this.requireSession(sessionId, "interact");
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.fill", tabId, snapshotId, elementRef, text]);
    const previous = this.previousOperation(key, fp);
    if (previous !== undefined) return previous;
    const binding = this.resolveElement(tab, snapshotId, elementRef);
    if (!["textbox", "searchbox", "combobox", "spinbutton"].includes(binding.role)) {
      fail("SENSITIVE_INPUT_BLOCKED", "La referencia no es un campo de texto permitido.");
    }
    return this.withTabWriter(entry, tab, async () => {
      const nodeId = await this.resolveNode(tab, binding);
      const described = await tab.content.webContents.debugger.sendCommand("DOM.describeNode", { nodeId }) as { node?: { attributes?: string[] } };
      const attributes = described.node?.attributes ?? [];
      const attributeMap = new Map<string, string>();
      for (let index = 0; index + 1 < attributes.length; index += 2) attributeMap.set((attributes[index] ?? "").toLowerCase(), attributes[index + 1] ?? "");
      const identity = [attributeMap.get("name"), attributeMap.get("id"), attributeMap.get("aria-label"), attributeMap.get("placeholder")]
        .filter((value) => value !== undefined).join(" ");
      if (isSensitiveInput({ inputType: attributeMap.get("type"), autocomplete: attributeMap.get("autocomplete"), identity })) {
        fail("SENSITIVE_INPUT_BLOCKED", "El campo web se clasifica como sensible.");
      }
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      let effectStarted = false;
      try {
        await tab.content.webContents.debugger.sendCommand("DOM.focus", { nodeId });
        effectStarted = true;
        await tab.content.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 });
        await tab.content.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
        await tab.content.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace" });
        await tab.content.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
        await tab.content.webContents.debugger.sendCommand("Input.insertText", { text });
        await settle();
        this.invalidate(tab);
        const result = { sessionId, tabId, applied: true as const, snapshotInvalidated: true as const };
        record.state = "complete";
        record.result = result;
        return result;
      } catch (error) {
        if (!effectStarted) {
          if (key !== undefined) this.operations.delete(key);
          throw error;
        }
        record.state = "uncertain";
        fail("WEB_EFFECT_UNCERTAIN", "El campo pudo cambiar antes del fallo; vuelve a observar antes de continuar.");
      }
    });
    });
  }

  async press(sessionId: string, tabId: string, snapshotId: string, elementRef: string, keyValue: string, operationId?: string) {
    const entry = await this.requireSession(sessionId, "interact");
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.press", tabId, snapshotId, elementRef, keyValue]);
    const previous = this.previousOperation(key, fp);
    if (previous !== undefined) return previous;
    const binding = this.resolveElement(tab, snapshotId, elementRef);
    return this.withTabWriter(entry, tab, async () => {
      const nodeId = await this.resolveNode(tab, binding);
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      let effectStarted = false;
      try {
        await tab.content.webContents.debugger.sendCommand("DOM.focus", { nodeId });
        effectStarted = true;
        await dispatchBoundedBrowserKey(tab.content.webContents, keyValue);
        await settle();
        this.invalidate(tab);
        const result = { sessionId, tabId, applied: true as const, snapshotInvalidated: true as const };
        record.state = "complete";
        record.result = result;
        return result;
      } catch (error) {
        if (!effectStarted) {
          if (key !== undefined) this.operations.delete(key);
          throw error;
        }
        record.state = "uncertain";
        fail("WEB_EFFECT_UNCERTAIN", "La tecla pudo producir un efecto antes del fallo; vuelve a observar antes de continuar.");
      }
    });
    });
  }

  async keyboardSequence(sessionId: string, tabId: string, snapshotId: string, elementRef: string, keys: readonly string[], operationId: string) {
    const entry = await this.requireSession(sessionId, "interact");
    const operationKey = `${sessionId}:${operationId}`;
    const fp = fingerprint(["web.keyboard.sequence", tabId, snapshotId, elementRef, ...keys]);
    const existing = this.compositeOperations.get(operationKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fp) fail("IDEMPOTENCY_CONFLICT", "El operationId ya representa otra operación compuesta.");
      if (existing.state === "complete") return existing.result;
      if (existing.state === "uncertain") fail("WEB_EFFECT_UNCERTAIN", "La secuencia web anterior quedó en estado incierto.");
      fail("RATE_LIMITED", "La misma secuencia web sigue en curso.");
    }
    return this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      const binding = this.resolveElement(tab, snapshotId, elementRef);
      return this.withTabWriter(entry, tab, async () => {
        await tab.content.webContents.debugger.sendCommand("Page.bringToFront");
        const nodeId = await this.resolveNode(tab, binding);
        try { await tab.content.webContents.debugger.sendCommand("DOM.focus", { nodeId }); }
        catch { fail("ELEMENT_NOT_INTERACTABLE", "El elemento web no puede recibir el foco del teclado."); }
        const focused = await inspectActiveBrowserKeyboardTarget(tab.content.webContents);
        if (isSensitiveInput({ inputType: focused.inputType, autocomplete: focused.autocomplete, identity: focused.identity })) {
          fail("SENSITIVE_INPUT_BLOCKED", "La secuencia web no puede comenzar en un campo sensible.");
        }
        const record: CompositeOperationRecord = { fingerprint: fp, sessionId, state: "pending" };
        this.compositeOperations.set(operationKey, record);
        while (this.compositeOperations.size > MAX_OPERATIONS) this.compositeOperations.delete(this.compositeOperations.keys().next().value as string);
        let keysSent = 0;
        const initialGeneration = tab.generation;
        const finish = (actionState: "complete" | "partial" | "uncertain", stoppedReason?: "sensitive_focus" | "document_changed" | "target_unavailable" | "dispatch_failed") => {
          if (keysSent > 0) this.invalidate(tab);
          const result = {
            sessionId, tabId, requestedKeys: keys.length, keysSent, actionState,
            snapshotInvalidated: keysSent > 0,
            ...(stoppedReason === undefined ? {} : { stoppedReason }),
          };
          record.state = "complete"; record.result = result;
          return result;
        };
        for (let index = 0; index < keys.length; index += 1) {
          this.ensureAgentControl(entry);
          if (index > 0) {
            if (tab.generation !== initialGeneration) return finish("partial", "document_changed");
            const active = await inspectActiveBrowserKeyboardTarget(tab.content.webContents);
            if (!active.connected || !active.visible || !active.enabled) return finish("partial", "target_unavailable");
            if (isSensitiveInput({ inputType: active.inputType, autocomplete: active.autocomplete, identity: active.identity })) {
              return finish("partial", "sensitive_focus");
            }
          }
          const currentKey = keys[index] as string;
          try {
            await dispatchBoundedBrowserKey(tab.content.webContents, currentKey);
            keysSent += 1;
          } catch {
            return finish("uncertain", "dispatch_failed");
          }
          if (index + 1 < keys.length) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await settle();
        return finish("complete");
      });
    });
  }

  async actionCapture(
    sessionId: string,
    tabId: string,
    snapshotId: string,
    elementRef: string,
    action: { readonly kind: "click" } | { readonly kind: "key"; readonly key: string },
    wait: { readonly kind: "delay"; readonly settleMs: number } | { readonly kind: "stable"; readonly intervalMs: number; readonly tolerancePx: number; readonly timeoutMs: number; readonly allowUnstable: boolean },
    output: { readonly kind: "inline" } | { readonly kind: "save"; readonly workspaceId: string; readonly path: string },
    operationId: string,
  ) {
    const entry = await this.requireSession(sessionId, "interact");
    const operationKey = `${sessionId}:${operationId}`;
    const fp = fingerprint(["web.action.capture", tabId, snapshotId, elementRef, JSON.stringify(action), JSON.stringify(wait), JSON.stringify(output)]);
    const existing = this.compositeOperations.get(operationKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fp) fail("IDEMPOTENCY_CONFLICT", "El operationId ya representa otra operación compuesta.");
      if (existing.state === "complete") return existing.result;
      if (existing.completion !== undefined) return existing.completion;
      fail("WEB_EFFECT_UNCERTAIN", "La acción web compuesta anterior no tiene un recibo recuperable.");
    }
    if (output.kind === "save") {
      const current = await this.requireProfile(entry.webProfileId, "download");
      if (profileRevision(current) !== entry.profileRevision) fail("CAPABILITY_DISABLED", "El perfil cambió antes de preparar la evidencia.");
      if (!output.path.toLowerCase().endsWith(".png")) fail("INVALID_INPUT", "La evidencia debe guardarse como PNG.");
      if (this.options.preflightDownload === undefined || this.options.saveDownload === undefined) fail("FEATURE_UNAVAILABLE", "El guardado de evidencia web no está disponible.");
      await this.options.preflightDownload({ webProfileId: entry.webProfileId, profileRevision: entry.profileRevision,
        workspaceId: output.workspaceId, path: output.path, maximumBytes: current.limits.maxDownloadBytes });
    }
    const raced = this.compositeOperations.get(operationKey);
    if (raced !== undefined) {
      if (raced.fingerprint !== fp) fail("IDEMPOTENCY_CONFLICT", "El operationId ya representa otra operación compuesta.");
      if (raced.state === "complete") return raced.result;
      if (raced.completion !== undefined) return raced.completion;
      fail("RATE_LIMITED", "La misma acción web compuesta se está preparando.");
    }
    const record: CompositeOperationRecord = { fingerprint: fp, sessionId, state: "pending" };
    this.compositeOperations.set(operationKey, record);
    while (this.compositeOperations.size > MAX_OPERATIONS) this.compositeOperations.delete(this.compositeOperations.keys().next().value as string);
    let effectStarted = false;
    let actionCompleted = false;
    const run = this.withAgentOperation(entry, async () => {
      const tab = this.requireTab(entry, tabId);
      return this.withTabWriter(entry, tab, async () => {
      await tab.content.webContents.debugger.sendCommand("Page.bringToFront");
      let objectId: string | undefined;
      try {
        const binding = this.resolveElement(tab, snapshotId, elementRef);
        const nodeId = await this.resolveNode(tab, binding);
        const resolved = await tab.content.webContents.debugger.sendCommand("DOM.resolveNode", { nodeId }) as { object?: { objectId?: string } };
        objectId = resolved.object?.objectId;
        if (objectId === undefined) fail("STALE_SNAPSHOT", "El elemento web ya no existe.");
        let effect: "effect_pending" | "navigation_started" | "native_download_blocked" | "dialog_blocked" | undefined;
        if (action.kind === "key") {
          try { await tab.content.webContents.debugger.sendCommand("DOM.focus", { nodeId }); }
          catch { fail("ELEMENT_NOT_INTERACTABLE", "El elemento web no puede recibir el foco del teclado."); }
          const focused = await inspectActiveBrowserKeyboardTarget(tab.content.webContents);
          if (isSensitiveInput({ inputType: focused.inputType, autocomplete: focused.autocomplete, identity: focused.identity })) {
            fail("SENSITIVE_INPUT_BLOCKED", "La acción no puede enviar teclas a un campo sensible.");
          }
          effectStarted = true;
          await dispatchBoundedBrowserKey(tab.content.webContents, action.key);
        } else {
          const classified = await tab.content.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function () { if (!(this instanceof Element) || !this.isConnected) return 'stale'; const input=this instanceof HTMLInputElement?this:null; const label=this instanceof HTMLLabelElement?this:this.closest('label'); const labelled=label&&label.control instanceof HTMLInputElement?label.control:null; const link=this instanceof HTMLAnchorElement?this:this.closest('a'); if ((input&&input.type==='file')||(labelled&&labelled.type==='file')) return 'file'; if (link instanceof HTMLAnchorElement&&link.hasAttribute('download')) return 'download'; const rect=this.getBoundingClientRect(),style=getComputedStyle(this); if(rect.width<=0||rect.height<=0||style.display==='none'||style.visibility==='hidden'||this.getAttribute('aria-disabled')==='true'||('disabled' in this&&this.disabled)) return 'blocked'; return 'ready'; }`,
            returnByValue: true,
          }) as { result?: { value?: string } };
          if (classified.result?.value === "file") fail("HUMAN_ACTION_REQUIRED", "La selección de archivos requiere control humano local.");
          if (classified.result?.value === "download") {
            effect = "native_download_blocked";
          } else {
            if (classified.result?.value !== "ready") fail("ELEMENT_NOT_INTERACTABLE", "El elemento web no puede recibir clic.");
            const blockedDownloadBefore = tab.blockedDownloadSequence;
            const blockedDialogBefore = tab.blockedDialogSequence;
            const fileChooserBefore = tab.fileChooserSequence;
            const urlBefore = tab.content.webContents.getURL();
            effectStarted = true;
            await tab.content.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
              objectId, functionDeclaration: "function () { this.click(); }", userGesture: true,
            });
            if (tab.fileChooserSequence > fileChooserBefore) fail("HUMAN_ACTION_REQUIRED", "La página abrió un selector de archivos que requiere control humano local.");
            effect = tab.blockedDownloadSequence > blockedDownloadBefore ? "native_download_blocked"
              : tab.blockedDialogSequence > blockedDialogBefore ? "dialog_blocked"
                : tab.content.webContents.getURL() !== urlBefore || tab.state === "loading" ? "navigation_started" : "effect_pending";
          }
        }
        actionCompleted = true;
        let stable = true;
        let waitedMs = 0;
        if (wait.kind === "delay") {
          const startedAt = Date.now(); const deadline = startedAt + wait.settleMs;
          while (Date.now() < deadline) { this.ensureAgentControl(entry); await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())))); }
          waitedMs = Date.now() - startedAt;
        } else {
          const stability = await waitForResolvedBrowserElementStability(tab.content.webContents, objectId, {
            intervalMs: wait.intervalMs, tolerancePx: wait.tolerancePx, timeoutMs: wait.timeoutMs,
            validate: () => this.ensureAgentControl(entry),
          }).catch(() => ({ stable: false, waitedMs: wait.timeoutMs }));
          stable = stability.stable; waitedMs = stability.waitedMs;
          if (!stable && !wait.allowUnstable) {
            this.invalidate(tab);
            const result = { sessionId, tabId, actionState: "complete" as const, captureState: "unstable" as const,
              waitedMs, snapshotInvalidated: true, ...(effect === undefined ? {} : { effect }) };
            record.state = "complete"; record.result = result;
            return result;
          }
        }
        this.ensureAgentControl(entry);
        try {
          const captured = await this.captureScreenshotData(tab, output.kind === "inline", operationId);
          this.ensureAgentControl(entry);
          this.invalidate(tab);
          if (output.kind === "inline") {
            const result = { sessionId, tabId, actionState: "complete" as const, captureState: stable ? "complete" as const : "unstable" as const,
              waitedMs, snapshotInvalidated: true, ...(effect === undefined ? {} : { effect }), mimeType: captured.mimeType,
              dataBase64: captured.dataBase64, width: captured.width, height: captured.height, fallbackUsed: captured.fallbackUsed };
            record.state = "complete"; record.result = result;
            return result;
          }
          const bytes = Buffer.from(captured.dataBase64, "base64");
          const mimeType = validateDownloadedResource(output.path, captured.mimeType, bytes);
          const current = await this.requireProfile(entry.webProfileId, "download");
          if (profileRevision(current) !== entry.profileRevision) fail("CAPABILITY_DISABLED", "El perfil cambió durante la captura.");
          const saved = await this.options.saveDownload!({ webProfileId: entry.webProfileId, profileRevision: entry.profileRevision,
            workspaceId: output.workspaceId, path: output.path, bytes, mimeType, maximumBytes: current.limits.maxDownloadBytes });
          const result = { sessionId, tabId, actionState: "complete" as const, captureState: stable ? "complete" as const : "unstable" as const,
            waitedMs, snapshotInvalidated: true, ...(effect === undefined ? {} : { effect }), mimeType: "image/png" as const,
            width: captured.width, height: captured.height, fallbackUsed: false as const, receipt: saved };
          record.state = "complete"; record.result = result;
          return result;
        } catch (error) {
          this.invalidate(tab);
          const result = { sessionId, tabId, actionState: "complete" as const, captureState: "failed" as const,
            waitedMs, snapshotInvalidated: true, ...(effect === undefined ? {} : { effect }),
            failureCode: error instanceof LocalBridgeError || error instanceof DevelopmentBrokerError ? error.code : "INTERNAL_ERROR" };
          record.state = "complete"; record.result = result;
          return result;
        }
      } catch (error) {
        if (!effectStarted) { this.compositeOperations.delete(operationKey); throw error; }
        this.invalidate(tab);
        const result = { sessionId, tabId, actionState: actionCompleted ? "complete" as const : "uncertain" as const,
          captureState: "skipped" as const, waitedMs: 0, snapshotInvalidated: true,
          failureCode: error instanceof LocalBridgeError || error instanceof DevelopmentBrokerError ? error.code : "INTERNAL_ERROR" };
        record.state = "complete"; record.result = result;
        return result;
      } finally {
        if (objectId !== undefined) await tab.content.webContents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
      });
    });
    record.completion = run;
    return run;
  }

  async scroll(sessionId: string, tabId: string, direction: "up" | "down" | "left" | "right", amount: number, operationId?: string) {
    const entry = await this.requireSession(sessionId, "interact");
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.scroll", tabId, direction, amount]);
    const previous = this.previousOperation(key, fp);
    if (previous !== undefined) return previous;
    return this.withTabWriter(entry, tab, async () => {
      const horizontal = direction === "left" || direction === "right";
      const deltaX = horizontal ? direction === "left" ? -amount : amount : 0;
      const deltaY = horizontal ? 0 : direction === "up" ? -amount : amount;
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      try {
        await tab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
          expression: `globalThis.scrollBy({left:${deltaX},top:${deltaY},behavior:'instant'})`, userGesture: true,
        });
        await settle();
        this.invalidate(tab);
        const result = { sessionId, tabId, applied: true as const, snapshotInvalidated: true as const };
        record.state = "complete";
        record.result = result;
        return result;
      } catch {
        record.state = "uncertain";
        fail("WEB_EFFECT_UNCERTAIN", "El desplazamiento pudo completarse antes del fallo; vuelve a observar antes de continuar.");
      }
    });
    });
  }

  async select(sessionId: string, tabId: string, snapshotId: string, elementRef: string, value: string, operationId?: string) {
    const entry = await this.requireSession(sessionId, "interact");
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.select", tabId, snapshotId, elementRef, value]);
    const previous = this.previousOperation(key, fp);
    if (previous !== undefined) return previous;
    const binding = this.resolveElement(tab, snapshotId, elementRef);
    return this.withTabWriter(entry, tab, async () => {
      const nodeId = await this.resolveNode(tab, binding);
      const resolved = await tab.content.webContents.debugger.sendCommand("DOM.resolveNode", { nodeId }) as { object?: { objectId?: string } };
      const objectId = resolved.object?.objectId;
      if (objectId === undefined) fail("STALE_SNAPSHOT", "El select ya no existe.");
      const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
      this.rememberOperation(key, record);
      let effectStarted = false;
      try {
        effectStarted = true;
        const selected = await tab.content.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function (nextValue) { if (!(this instanceof HTMLSelectElement) || this.disabled || !Array.from(this.options).some((option) => option.value === nextValue)) return false; this.value = nextValue; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return true; }`,
          arguments: [{ value }], returnByValue: true, userGesture: true,
        }) as { result?: { value?: boolean } };
        if (selected.result?.value !== true) {
          effectStarted = false;
          if (key !== undefined) this.operations.delete(key);
          fail("ELEMENT_NOT_INTERACTABLE", "El valor no existe o el select está deshabilitado.");
        }
        await settle();
        this.invalidate(tab);
        const result = { sessionId, tabId, applied: true as const, snapshotInvalidated: true as const };
        record.state = "complete";
        record.result = result;
        return result;
      } catch (error) {
        if (!effectStarted) throw error;
        record.state = "uncertain";
        fail("WEB_EFFECT_UNCERTAIN", "La selección pudo cambiar antes del fallo; vuelve a observar antes de continuar.");
      } finally {
        await tab.content.webContents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    });
    });
  }

  private async conditionSatisfied(tab: ManagedWebTab, condition: WebWaitCondition): Promise<boolean> {
    if (condition.kind === "load") return !tab.content.webContents.isLoading() && tab.state === "ready";
    if (condition.kind === "url") {
      const current = tab.content.webContents.getURL();
      return condition.operator === "equals" ? current === condition.value : current.includes(condition.value);
    }
    if (condition.kind === "title") {
      const current = tab.content.webContents.getTitle();
      return condition.operator === "equals" ? current === condition.value : current.includes(condition.value);
    }
    if (condition.kind === "stable") return false;
    const evaluated = await tab.content.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(document.body?.innerText ?? '').includes(${JSON.stringify(condition.value)})`, returnByValue: true,
    }) as { result?: { value?: boolean } };
    const present = evaluated.result?.value === true;
    return condition.state === "present" ? present : !present;
  }

  async wait(sessionId: string, tabId: string, condition: WebWaitCondition, timeoutMs: number) {
    const entry = await this.requireSession(sessionId);
    return this.withAgentOperation(entry, async () => {
    const tab = this.requireTab(entry, tabId);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    if (condition.kind === "stable") {
      let previous: Awaited<ReturnType<typeof sampleResolvedBrowserElement>> | undefined;
      let stableSince = startedAt;
      do {
        this.ensureAgentControl(entry);
        const binding = this.resolveElement(tab, condition.snapshotId, condition.elementRef);
        const nodeId = await this.resolveNode(tab, binding);
        const resolved = await tab.content.webContents.debugger.sendCommand("DOM.resolveNode", { nodeId }) as { object?: { objectId?: string } };
        const objectId = resolved.object?.objectId;
        if (objectId === undefined) fail("STALE_SNAPSHOT", "El elemento web ya no existe.");
        let current: Awaited<ReturnType<typeof sampleResolvedBrowserElement>>;
        try { current = await sampleResolvedBrowserElement(tab.content.webContents, objectId); }
        finally { await tab.content.webContents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined); }
        const now = Date.now();
        if (previous === undefined || !visualSamplesEqual(previous, current, condition.tolerancePx)) stableSince = now;
        else if (now - stableSince >= condition.intervalMs) {
          return { sessionId, tabId, satisfied: true as const, conditionKind: condition.kind, waitedMs: now - startedAt };
        }
        previous = current;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(50, Math.max(1, deadline - Date.now()))));
      } while (Date.now() < deadline);
      fail("TIMEOUT", "El elemento web no mantuvo geometría, color y transición estables durante el intervalo solicitado.");
    }
    do {
      if (await this.conditionSatisfied(tab, condition)) {
        return { sessionId, tabId, satisfied: true as const, conditionKind: condition.kind, waitedMs: Date.now() - startedAt };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    fail("TIMEOUT", "La condición web no se cumplió antes del límite.");
    });
  }

  private async beginHumanControl(
    sessionId: string,
    reason: WebHumanReason,
    operationId: string,
    initiatedLocally: boolean,
  ): Promise<WebHumanControlStatus> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== "running") fail("WEB_SESSION_NOT_FOUND", "La sesión web no existe.");
    const profile = await this.requireProfile(entry.webProfileId,
      initiatedLocally && entry.profile.kind === "public-research" ? "read" : "humanControl");
    if (profileRevision(profile) !== entry.profileRevision) {
      await this.stopEntry(entry);
      fail("WEB_SESSION_NOT_FOUND", "El perfil web cambió y la sesión se cerró.");
    }
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.human.request", reason]);
    const previous = this.previousOperation<WebHumanControlStatus>(key, fp);
    if (previous !== undefined) return previous;
    this.ensureAgentControl(entry);
    if (this.humanSessionId !== undefined && this.humanSessionId !== sessionId) fail("HUMAN_CONTROL_BUSY", "Otra sesión tiene control humano.");
    await this.options.reserveHumanControl?.(sessionId);
    const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
    this.rememberOperation(key, record);
    entry.controlState = "waiting_for_human";
    entry.humanReason = reason;
    entry.humanRequestId = `webhuman_${randomBytes(12).toString("hex")}`;
    entry.humanInitiatedLocally = initiatedLocally;
    entry.humanPrepared = false;
    entry.controlExpiresAt = Date.now() + HUMAN_CONTROL_TTL_MS;
    this.humanSessionId = sessionId;
    entry.controlTimer = setTimeout(() => { void this.expireHumanControl(entry); }, HUMAN_CONTROL_TTL_MS);
    entry.controlTimer.unref();
    try {
      await this.options.beforeHumanControlRequest?.();
      await this.hideLiveViewerLocally(entry.sessionId);
      await this.waitForAgentOperations(entry);
      for (const tab of entry.tabs.values()) {
        this.invalidate(tab);
        if (!tab.content.webContents.isDestroyed() && tab.content.webContents.debugger.isAttached()) {
          await tab.content.webContents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
          await tab.content.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
          await tab.content.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
          tab.content.webContents.debugger.detach();
        }
      }
      entry.humanPrepared = true;
    } catch {
      await this.stopEntry(entry, "stopped", "failed");
      fail("TIMEOUT", "No se pudo entregar la sesión web de forma segura.");
    }
    const result = this.humanStatus(entry);
    record.state = "complete";
    record.result = result;
    if (!initiatedLocally) this.options.onHumanControlRequest?.(sessionSummary(entry));
    this.options.onActivityChange?.();
    return result;
  }

  async requestHumanControl(sessionId: string, reason: WebHumanReason, operationId: string): Promise<WebHumanControlStatus> {
    return this.beginHumanControl(sessionId, reason, operationId, false);
  }

  private humanStatus(entry: ManagedWebSession): WebHumanControlStatus {
    if (entry.humanRequestId === undefined || entry.humanReason === undefined) fail("HUMAN_CONTROL_REQUEST_NOT_FOUND", "No existe una solicitud web humana.");
    const state = entry.controlState === "agent_control" ? "ready" :
      entry.controlState === "returning_to_agent" ? "human_control" : entry.controlState;
    return {
      requestId: entry.humanRequestId,
      reason: entry.humanReason,
      state: state as WebHumanControlStatus["state"],
      ...(entry.controlExpiresAt === undefined || ["ready", "declined", "expired", "stopped"].includes(state) ? {} : { expiresAt: new Date(entry.controlExpiresAt).toISOString() }),
      ...(["waiting_for_human", "human_control", "returning_to_agent"].includes(entry.controlState) ? { retryAfterMs: 1_000 } : {}),
    };
  }

  async humanControlStatus(sessionId: string): Promise<WebHumanControlStatus> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) fail("WEB_SESSION_NOT_FOUND", "La sesión web no existe.");
    return this.humanStatus(entry);
  }

  private selectedHumanTab(entry: ManagedWebSession, tabId?: string): ManagedWebTab {
    const tab = tabId === undefined
      ? (this.liveViewer?.sessionId === entry.sessionId
          ? entry.tabs.get(this.liveViewer.tabId)
          : undefined) ?? this.latestAgentTab(entry)
      : this.requireTab(entry, tabId);
    if (tab === undefined || tab.state === "closed") fail("WEB_TAB_NOT_FOUND", "La sesión web no tiene una pestaña disponible.");
    return tab;
  }

  private async showOnlyHumanTab(entry: ManagedWebSession, selected: ManagedWebTab): Promise<void> {
    for (const tab of entry.tabs.values()) {
      if (tab.state === "closed" || tab.window.isDestroyed() || tab.content.webContents.isDestroyed()) continue;
      if (tab.tabId !== selected.tabId) {
        this.hideHumanWindow(tab);
        continue;
      }
      await this.refreshViewerShell(entry, tab, "human");
      tab.window.setIgnoreMouseEvents(false);
      tab.window.setFocusable(true);
      tab.window.setSkipTaskbar(false);
      tab.window.maximize();
      tab.window.show();
      tab.window.focus();
    }
    entry.humanTabId = selected.tabId;
  }

  async takeHumanControlLocally(sessionId: string, tabId?: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== "running") fail("WEB_SESSION_NOT_FOUND", "La sesión web no existe.");
    if (entry.controlState === "agent_control") {
      await this.beginHumanControl(sessionId, "manual_step", `local_${randomBytes(12).toString("hex")}`, true);
    } else if (entry.controlState !== "waiting_for_human") {
      fail("HUMAN_CONTROL_BUSY", "La sesión web ya está en una transición de control humano.");
    }
    if (entry.humanPrepared !== true) fail("HUMAN_CONTROL_BUSY", "La sesión todavía está preparando la intervención humana.");
    const profile = await this.requireProfile(entry.webProfileId,
      entry.humanInitiatedLocally === true && entry.profile.kind === "public-research" ? "read" : "humanControl");
    if (profileRevision(profile) !== entry.profileRevision) {
      await this.stopEntry(entry);
      fail("WEB_SESSION_NOT_FOUND", "El perfil web cambió y la sesión se cerró.");
    }
    const selected = this.selectedHumanTab(entry, tabId);
    entry.controlState = "human_control";
    try {
      await this.showOnlyHumanTab(entry, selected);
    } catch {
      await this.stopEntry(entry, "stopped", "failed");
      fail("WEB_SESSION_NOT_FOUND", "No se pudo abrir el control humano de forma segura.");
    }
    this.options.onHumanControlTransition?.({ action: "web.human.open", sessionId, ...(entry.humanReason === undefined ? {} : { reason: entry.humanReason }) });
    this.options.onActivityChange?.();
  }

  async cycleHumanTabLocally(sessionId: string, direction: "previous" | "next"): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== "running" || entry.controlState !== "human_control") {
      fail("HUMAN_CONTROL_REQUEST_NOT_FOUND", "La sesión no está bajo control humano.");
    }
    const tabs = this.liveTabs(entry).toSorted((left, right) => left.openedAt - right.openedAt);
    if (tabs.length < 2) return;
    const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.tabId === entry.humanTabId));
    const offset = direction === "next" ? 1 : -1;
    const selected = tabs[(currentIndex + offset + tabs.length) % tabs.length];
    if (selected !== undefined) await this.showOnlyHumanTab(entry, selected);
    this.options.onActivityChange?.();
  }

  async completeHumanControlLocally(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== "running" || entry.controlState !== "human_control") {
      fail("HUMAN_CONTROL_REQUEST_NOT_FOUND", "La sesión no está bajo control humano.");
    }
    const profile = await this.requireProfile(entry.webProfileId,
      entry.humanInitiatedLocally === true && entry.profile.kind === "public-research" ? "read" : "humanControl");
    if (profileRevision(profile) !== entry.profileRevision) {
      await this.stopEntry(entry);
      fail("WEB_SESSION_NOT_FOUND", "El perfil web cambió y la sesión se cerró.");
    }
    const selected = this.selectedHumanTab(entry, entry.humanTabId);
    const currentUrl = normalizePublicHttpsUrl(selected.content.webContents.getURL());
    if (entry.profile.kind === "public-research" && currentUrl === undefined) {
      fail("WEB_DESTINATION_BLOCKED", "La pestaña actual no tiene un sitio HTTPS delegable.");
    }
    const currentHostname = currentUrl?.hostname ?? entry.profile.destinations[0]?.hostname;
    if (currentHostname === undefined) fail("WEB_DESTINATION_BLOCKED", "La sesión no tiene un sitio autorizado.");
    entry.controlState = "returning_to_agent";
    for (const tab of entry.tabs.values()) {
      if (tab.state !== "closed") this.hideHumanWindow(tab);
    }
    this.options.onActivityChange?.();
    let decision: "continue-human" | "share-once" | "share-and-remember";
    try {
      decision = await (this.options.confirmHumanControlHandoff?.({
        profileKind: entry.profile.kind,
        profileName: entry.profile.name,
        hostname: currentHostname,
      }) ?? Promise.resolve("share-once"));
    } catch {
      entry.controlState = "human_control";
      await this.showOnlyHumanTab(entry, selected).catch(() => this.stopEntry(entry, "stopped", "failed"));
      throw new DevelopmentBrokerError("INTERNAL_ERROR", "No se pudo confirmar la devolución local.");
    }
    if (entry.state !== "running" || entry.controlState !== "returning_to_agent") return;
    if (decision === "continue-human") {
      entry.controlState = "human_control";
      await this.showOnlyHumanTab(entry, selected);
      this.options.onActivityChange?.();
      return;
    }
    if (decision === "share-and-remember") {
      try {
        await this.options.rememberSiteAccess?.(currentHostname);
      } catch {
        entry.controlState = "human_control";
        await this.showOnlyHumanTab(entry, selected).catch(() => this.stopEntry(entry, "stopped", "failed"));
        fail("INTERNAL_ERROR", "No se pudo guardar el acceso al sitio; la sesión continúa bajo tu control.");
      }
    }
    if (entry.controlTimer !== undefined) clearTimeout(entry.controlTimer);
    entry.controlTimer = undefined;
    entry.controlExpiresAt = undefined;
    try {
      if (entry.profile.kind === "public-research") {
        for (const tab of entry.tabs.values()) {
          if (tab.tabId === selected.tabId || tab.state === "closed") continue;
          tab.state = "closed";
          this.destroyTabWindow(tab);
        }
        entry.delegatedSite = currentHostname;
        entry.delegatedExpiresAt ??= Date.now() + HUMAN_CONTROL_TTL_MS;
        entry.proxy.restrictToHosts([currentHostname]);
        await entry.browserSession?.closeAllConnections();
        await entry.browserSession?.clearCache();
        await entry.browserSession?.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
        await selected.content.webContents.loadURL(currentUrl!.href);
        const reloaded = normalizePublicHttpsUrl(selected.content.webContents.getURL());
        if (reloaded?.hostname !== currentHostname) throw new Error("delegated page did not reload under exact host authority");
      }
      for (const tab of entry.tabs.values()) {
        if (tab.state === "closed" || tab.window.isDestroyed() || tab.content.webContents.isDestroyed()) continue;
        tab.window.setIgnoreMouseEvents(true);
        tab.window.setFocusable(false);
        tab.window.setSkipTaskbar(true);
        tab.window.setPosition(-10_000, -10_000, false);
        tab.window.showInactive();
        await this.refreshViewerShell(entry, tab, "agent");
        this.invalidate(tab);
        await this.installDebugger(tab.content.webContents, tab.currentViewport);
      }
      const current = await this.options.loadProfile(entry.webProfileId).catch(() => undefined);
      if (entry.state !== "running" || current === undefined || !current.enabled || current.reviewRequired ||
          !current.permissions.read ||
          entry.profile.kind === "site-account" && !current.permissions.humanControl ||
          profileRevision(current) !== entry.profileRevision ||
          entry.delegatedSite !== undefined && currentHostname !== entry.delegatedSite) {
        throw new Error("web profile authority changed during handoff");
      }
    } catch {
      await this.stopEntry(entry, "stopped", "failed");
      fail("WEB_SESSION_NOT_FOUND", "No se pudo devolver la sesión al agente de forma segura.");
    }
    entry.controlState = "agent_control";
    this.humanSessionId = undefined;
    entry.humanPrepared = false;
    entry.humanTabId = undefined;
    this.options.releaseHumanControl?.(sessionId);
    if (entry.delegatedExpiresAt !== undefined) {
      entry.controlTimer = setTimeout(() => { void this.stopEntry(entry, "expired", "expired"); },
        Math.max(1, entry.delegatedExpiresAt - Date.now()));
      entry.controlTimer.unref();
    }
    this.options.onHumanControlTransition?.({ action: "web.human.handoff", sessionId, ...(entry.humanReason === undefined ? {} : { reason: entry.humanReason }) });
    this.options.onActivityChange?.();
  }

  async declineHumanControlLocally(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    entry.controlState = "declined";
    this.humanSessionId = undefined;
    this.options.onHumanControlTransition?.({ action: "web.human.decline", sessionId, ...(entry.humanReason === undefined ? {} : { reason: entry.humanReason }) });
    await this.stopEntry(entry, "declined", "user");
  }

  private async expireHumanControl(entry: ManagedWebSession): Promise<void> {
    if (!["waiting_for_human", "human_control", "returning_to_agent"].includes(entry.controlState)) return;
    entry.controlState = "expired";
    this.humanSessionId = undefined;
    this.options.onHumanControlTransition?.({ action: "web.human.expire", sessionId: entry.sessionId, ...(entry.humanReason === undefined ? {} : { reason: entry.humanReason }) });
    await this.stopEntry(entry, "expired", "expired");
  }

  private async stopEntry(
    entry: ManagedWebSession,
    finalControlState: WebControlState = "stopped",
    closeReason: WebCloseReason = "policy",
  ): Promise<void> {
    if (entry.stopPromise !== undefined) return entry.stopPromise;
    entry.stopPromise = (async () => {
      if (this.liveViewer?.sessionId === entry.sessionId) {
        this.viewerRevision += 1;
        this.liveViewer = undefined;
        this.options.onLiveViewerChange?.({ visible: false });
      }
      entry.state = "stopped";
      entry.controlState = finalControlState;
      entry.closedAt = Date.now();
      entry.closeReason = closeReason;
      if (entry.controlTimer !== undefined) clearTimeout(entry.controlTimer);
      if (this.humanSessionId === entry.sessionId) this.humanSessionId = undefined;
      for (const [key, value] of this.compositeOperations) if (value.sessionId === entry.sessionId) this.compositeOperations.delete(key);
      this.options.releaseHumanControl?.(entry.sessionId);
      for (const tab of entry.tabs.values()) {
        tab.state = "closed";
        tab.snapshot = undefined;
        tab.resources.clear();
        this.destroyTabWindow(tab);
      }
      if (entry.browserSession !== undefined) {
        await Promise.allSettled([
          entry.browserSession.clearCache(),
          entry.browserSession.clearStorageData(),
          entry.browserSession.clearHostResolverCache(),
          entry.browserSession.closeAllConnections(),
        ]);
      }
      await entry.proxy.close().catch(() => undefined);
      this.options.onActivityChange?.();
    })();
    return entry.stopPromise;
  }

  async stop(sessionId: string, operationId?: string): Promise<WebSessionSummary> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) fail("WEB_SESSION_NOT_FOUND", "La sesión web no existe.");
    const key = this.operationKey(entry, operationId);
    const fp = fingerprint(["web.stop", sessionId]);
    const previous = this.previousOperation<WebSessionSummary>(key, fp);
    if (previous !== undefined) return previous;
    const record: OperationRecord = { fingerprint: fp, sessionId, state: "pending" };
    this.rememberOperation(key, record);
    await this.stopEntry(entry, "stopped", "agent");
    const result = sessionSummary(entry);
    record.state = "complete";
    record.result = result;
    return result;
  }

  async stopLocally(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    await this.stopEntry(entry, "stopped", "user");
  }

  private async reconcile(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state !== "running") continue;
      const current = await this.options.loadProfile(entry.webProfileId).catch(() => undefined);
      if (current === undefined || !current.enabled || current.reviewRequired || !current.permissions.read ||
          profileRevision(current) !== entry.profileRevision) await this.stopEntry(entry);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.reconciliationTimer);
    for (const waiter of this.downloadWaiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'El navegador web se está cerrando.'));
    }
    await this.stopAll();
  }
}
