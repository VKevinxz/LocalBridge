import type {
  AuditEvent,
  BundledRuntimePaths,
  DesktopSettings,
  DevelopmentActivity,
  DetectedCommand,
  ApplicationRunSummary,
  AssistedProjectsState,
  NewApplicationDraft,
  PendingApproval,
  PortableConfig,
  RuntimeReadinessReport,
  OnboardingCompletionDraft,
  OnboardingViewSnapshot,
  StoredTunnelKeyState,
  TunnelStatus,
  WorkspaceReadinessReport,
  V1ProjectsState,
  WebActivitySummary,
  WebLiveViewerState,
  WebTabActivitySummary,
  WebProfile,
  WebProfileStoreSnapshot,
} from '../../preload/index.js';
import { onboardingHtml as renderOnboardingHtml } from './onboarding.js';
import type {
  AuthorizedWorkspace,
  BrowserProfile,
  LocalApplication,
  LargeArtifactPolicy,
  ProcessProfile,
  WorkspacePermissions,
  SetupPolicy,
  ProjectTrustMode,
} from '@localbridge/workspace';
const PERMISSION_KEYS: Array<keyof WorkspacePermissions> = [
  'read',
  'write',
  'overwrite',
  'gitRead',
  'validations',
  'gitWrite',
  'processes',
  'browserRead',
  'browserInteract',
  'browserHumanControl',
];
const PERMISSION_LABELS: Record<keyof WorkspacePermissions, string> = {
  read: 'Leer archivos',
  write: 'Crear archivos',
  overwrite: 'Editar, mover y eliminar',
  gitRead: 'Consultar Git',
  validations: 'Ejecutar validaciones aprobadas',
  gitWrite: 'Preparar, confirmar y publicar en Git',
  processes: 'Controlar servidores aprobados',
  browserRead: 'Observar la web local',
  browserInteract: 'Interactuar con la web local',
  browserHumanControl: 'Permitir control humano exclusivo',
};
const PERMISSION_DESCRIPTIONS: Record<keyof WorkspacePermissions, string> = {
  read: 'Explorar y leer contenido no bloqueado.',
  write: 'Crear archivos nuevos; no reemplaza los existentes.',
  overwrite: 'Cambiar, mover o borrar con verificación previa de hash.',
  gitRead: 'Consultar estado, historial y diferencias de Git.',
  validations: 'Ejecutar únicamente perfiles que tú selecciones.',
  gitWrite: 'Preparar, confirmar y publicar; commit y push piden aprobación.',
  processes: 'Iniciar, consultar logs y detener solo perfiles aprobados.',
  browserRead: 'Abrir, navegar y capturar solo orígenes loopback aprobados.',
  browserInteract: 'Hacer clic, completar campos no sensibles y pulsar teclas permitidas.',
  browserHumanControl: 'Pausar completamente a ChatGPT mientras tomas el navegador para cualquier paso local.',
};
const DEFAULT_PERMISSIONS: WorkspacePermissions = {
  read: true,
  write: false,
  overwrite: false,
  gitRead: false,
  validations: false,
  gitWrite: false,
  processes: false,
  browserRead: false,
  browserInteract: false,
  browserHumanControl: false,
};
const TUNNEL_STATUS_LABELS: Record<TunnelStatus, string> = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  connected: 'Conectado',
  error: 'Error',
};
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

function isInterventionControlState(state: string): boolean {
  return ['waiting_for_human', 'human_control', 'returning_to_agent'].includes(state);
}

function interventionControlPriority(state: string): number {
  return isInterventionControlState(state) ? 0 : 1;
}

interface WorkspaceFormDraft {
  name: string;
  rootPath: string;
  enabled: boolean;
  permissions: WorkspacePermissions;
  maxFileBytes: number;
  largeArtifacts: LargeArtifactPolicy;
  validationProfilesText: string;
  processProfilesText: string;
  browserProfilesText: string;
}

interface UiFeedback {
  readonly kind: 'success' | 'warning' | 'error';
  readonly message: string;
}

type AppSection = 'home' | 'web' | 'assisted' | 'projects' | 'applications' | 'activity' | 'connection' | 'settings';
type ActivityFilter = 'all' | 'browsers' | 'resources';
type BrowserActivityGroup = 'all' | 'attention' | 'regular';
type ActivitySectionId = 'runtime' | 'technicalLog' | 'documents' | 'audit';
type ActivityDisclosureState = Record<ActivitySectionId, boolean>;
type WorkspaceFormTab = 'general' | 'access' | 'services' | 'advanced';

type AccessObjective = 'review' | 'edit' | 'web' | 'complete';
interface ApplicationWizardDraft {
  step: 1 | 2 | 3 | 4 | 5;
  name: string;
  description: string;
  selected: string[];
  aliases: Record<string, string>;
  primary: string;
  wildcard: Record<string, boolean>;
  objective: AccessObjective;
  editingId?: string;
}

type AssistedAccessPreset = 'code' | 'web' | 'complete';
interface AssistedProjectWizardDraft {
  step: 1 | 2 | 3 | 4;
  name: string;
  description: string;
  rootPath: string;
  access: AssistedAccessPreset;
  policy: SetupPolicy;
  initializeGit: boolean;
}

interface V1ProjectDraft {
  name: string;
  description: string;
  rootPath: string;
  trustMode: ProjectTrustMode;
}

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('#app no encontrado');

let workspaces: AuthorizedWorkspace[] = [];
let applications: LocalApplication[] = [];
let applicationsError: string | undefined;
let applicationWizard: ApplicationWizardDraft | undefined;
let applicationWizardBusy: 'save' | 'verify' | undefined;
let assistedProjects: AssistedProjectsState = { projects: [], sessions: [], runs: [] };
let v1Projects: V1ProjectsState = { projects: [], decisions: [], sandboxAvailable: false };
let v1ProjectDraft: V1ProjectDraft | undefined;
let v1BusyProjectId: string | undefined;
let assistedProjectsError: string | undefined;
let assistedWizard: AssistedProjectWizardDraft | undefined;
let assistedBusyProjectId: string | undefined;
let showAdoptProject = false;
let workspacesError: string | undefined;
let editingWorkspace: AuthorizedWorkspace | undefined;
let editingWorkspaceOriginId: string | undefined;
let showCreateForm = false;
let workspaceFormDraft: WorkspaceFormDraft | undefined;
let activeWorkspaceFormTab: WorkspaceFormTab = 'general';
let detectedCommands: DetectedCommand[] = [];
let selectedDetected = new Set<string>();

let tunnelStatus: TunnelStatus = 'disconnected';
let tunnelDetail: string | undefined;
let tunnelLogs: string[] = [];
let logFilter = '';
let settings: DesktopSettings = {
  onboardingStep: 0,
  onboardingCompleted: false,
  minimizeToTray: true,
  largeArtifactPreference: {
    mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1,
  },
  gitApprovalMode: 'host',
  activeConnectionProfileId: 'profile_default0',
  connectionProfiles: [{ id: 'profile_default0', name: 'Personal', tunnelId: '' }],
  tunnelId: '',
  tunnelBinaryPath: '',
  tunnelProfile: 'local-stdio',
  tunnelProfileDir: '',
  serverCwd: '',
};
let settingsDraft: DesktopSettings = { ...settings };
let effectiveGitApprovalMode: DesktopSettings['gitApprovalMode'] | undefined;
let runtimeInfo: BundledRuntimePaths | undefined;
let apiKeyDraft = '';
let keySaved = false;
let tunnelKeyState: StoredTunnelKeyState = { status: 'absent' };
let rememberTunnelKey = true;
let feedback: UiFeedback | undefined;
let diagnosticOutput = '';
let runtimeReport: RuntimeReadinessReport | undefined;
let onboardingTunnelReady = false;
let onboardingSnapshotState: OnboardingViewSnapshot | undefined;
let onboardingBusy: 'runtime' | 'connection' | 'folder' | 'access' | 'complete' | 'navigation' | undefined;
let onboardingRuntimeAutoStarted = false;
let onboardingProjectName = '';
let onboardingProjectDescription = '';
let activeSection: AppSection = 'home';
let sidebarOpen = false;
let isInitializing = true;
let lastProblem: string | undefined;
let workspaceReports: Record<string, WorkspaceReadinessReport> = {};
let auditEvents: AuditEvent[] = [];
let documentAuditEvents: AuditEvent[] = [];
let auditVisibleCount = 20;
let pendingApprovals: PendingApproval[] = [];
let pendingApprovalExpiryTimer: number | undefined;
let auditLoading = false;
let developmentActivity: DevelopmentActivity = { processes: [], browsers: [], applications: [], terminals: [], jobs: [] };
let webProfiles: WebProfileStoreSnapshot = { state: 'missing', document: { schemaVersion: 1, profiles: [] }, sha256: null };
let webActivity: readonly WebActivitySummary[] = [];
let webLiveViewer: WebLiveViewerState = { visible: false, displays: [], recommendedDisplayId: '' };
let webTabs: Record<string, readonly WebTabActivitySummary[]> = {};
let webProfilesError: string | undefined;
let webRefreshGeneration = 0;
let activityFilter: ActivityFilter = 'all';
const ACTIVITY_DISCLOSURE_STORAGE_KEY = 'localbridge.activityDisclosure.v1';
const ACTIVITY_DISCLOSURE_DEFAULTS: ActivityDisclosureState = {
  runtime: false,
  technicalLog: false,
  documents: false,
  audit: false,
};
const activityDisclosureStored = readActivityDisclosureState();
let activityDisclosureState: ActivityDisclosureState = activityDisclosureStored ?? { ...ACTIVITY_DISCLOSURE_DEFAULTS };
let activityDisclosureCustomized = activityDisclosureStored !== undefined;
const activityExpandedItems = new Map<string, boolean>();
let browserViewerSessionId: string | undefined;
let browserViewerTimer: number | undefined;
let browserViewerCaptureInFlight = false;
const LIVE_VIEWER_DISPLAY_STORAGE_KEY = 'localbridge.liveViewerDisplayId';
const LIVE_VIEWER_PRESENTATION_STORAGE_KEY = 'localbridge.liveViewerPresentationMode';
let auditFilters: { workspaceId?: string; action?: string; outcome?: 'success' | 'error' } = {};
let portableImport: { sessionId: string; config: PortableConfig; mapped: Set<string> } | undefined;

function readActivityDisclosureState(): ActivityDisclosureState | undefined {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_DISCLOSURE_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (Object.keys(candidate).length !== 4 ||
      typeof candidate['runtime'] !== 'boolean' ||
      typeof candidate['technicalLog'] !== 'boolean' ||
      typeof candidate['documents'] !== 'boolean' ||
      typeof candidate['audit'] !== 'boolean') return undefined;
    return {
      runtime: candidate['runtime'],
      technicalLog: candidate['technicalLog'],
      documents: candidate['documents'],
      audit: candidate['audit'],
    };
  } catch {
    return undefined;
  }
}

function saveActivityDisclosureState(): void {
  activityDisclosureCustomized = true;
  try {
    window.localStorage.setItem(ACTIVITY_DISCLOSURE_STORAGE_KEY, JSON.stringify(activityDisclosureState));
  } catch {
    // La preferencia visual es opcional; la actividad sigue disponible sin persistencia.
  }
}

function activityItemExpanded(key: string, defaultValue: boolean): boolean {
  return activityExpandedItems.get(key) ?? defaultValue;
}

function activityDomId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function rememberedLiveViewerDisplayId(): string | undefined {
  try {
    const stored = window.localStorage.getItem(LIVE_VIEWER_DISPLAY_STORAGE_KEY) ?? undefined;
    return (developmentActivity.displays ?? []).some((display) => display.id === stored) ||
      webLiveViewer.displays.some((display) => display.id === stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function rememberLiveViewerDisplayId(displayId: string): void {
  const developmentDisplayExists = (developmentActivity.displays ?? []).some((display) => display.id === displayId);
  const webDisplayExists = webLiveViewer.displays.some((display) => display.id === displayId);
  if (!developmentDisplayExists && !webDisplayExists) return;
  try { window.localStorage.setItem(LIVE_VIEWER_DISPLAY_STORAGE_KEY, displayId); } catch { /* preferencia no crítica */ }
}

function rememberedViewerPresentationMode(): 'fit' | 'actual' {
  try { return window.localStorage.getItem(LIVE_VIEWER_PRESENTATION_STORAGE_KEY) === 'actual' ? 'actual' : 'fit'; }
  catch { return 'fit'; }
}

function rememberViewerPresentationMode(mode: 'fit' | 'actual'): void {
  try { window.localStorage.setItem(LIVE_VIEWER_PRESENTATION_STORAGE_KEY, mode); } catch { /* preferencia no crítica */ }
}

function viewerPresentationHtml(
  kind: 'browser' | 'web',
  sessionId: string,
  presentation: { mode: 'fit' | 'actual'; renderWidth: number; renderHeight: number; viewWidth: number; viewHeight: number; scale: number; panX: number; panY: number } | undefined,
): string {
  if (presentation === undefined) return '';
  const attributes = `data-viewer-presentation="${kind}" data-session-id="${escapeHtml(sessionId)}"`;
  const metrics = `Render ${presentation.renderWidth}×${presentation.renderHeight} · visible ${presentation.viewWidth}×${presentation.viewHeight} · ${Math.round(presentation.scale * 100)}%`;
  const pan = presentation.mode !== 'actual' ? '' : `<span class="viewer-pan" aria-label="Desplazar vista 1 a 1">
    <button type="button" ${attributes} data-mode="actual" data-pan-x="${Math.max(0, presentation.panX - 240)}" data-pan-y="${presentation.panY}" aria-label="Mover vista a la izquierda">←</button>
    <button type="button" ${attributes} data-mode="actual" data-pan-x="${presentation.panX}" data-pan-y="${Math.max(0, presentation.panY - 135)}" aria-label="Mover vista arriba">↑</button>
    <button type="button" ${attributes} data-mode="actual" data-pan-x="${presentation.panX}" data-pan-y="${presentation.panY + 135}" aria-label="Mover vista abajo">↓</button>
    <button type="button" ${attributes} data-mode="actual" data-pan-x="${presentation.panX + 240}" data-pan-y="${presentation.panY}" aria-label="Mover vista a la derecha">→</button></span>`;
  return `<div class="viewer-presentation"><span class="dependency-note">${metrics}</span><div class="actions"><button type="button" ${attributes} data-mode="fit" data-pan-x="0" data-pan-y="0" ${presentation.mode === 'fit' ? 'disabled aria-pressed="true"' : ''}>Encajar</button><button type="button" ${attributes} data-mode="actual" data-pan-x="${presentation.panX}" data-pan-y="${presentation.panY}" ${presentation.mode === 'actual' ? 'disabled aria-pressed="true"' : ''}>1:1</button>${pan}</div></div>`;
}

function motionReceiptHtml(receipt: { path: string; frameCount: number; totalSize: number; captureMode: 'stepped' | 'screencast'; warnings: readonly string[] } | undefined): string {
  if (receipt === undefined) return '';
  const size = receipt.totalSize >= 1024 * 1024 ? `${(receipt.totalSize / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(receipt.totalSize / 1024)} KiB`;
  return `<p class="motion-receipt"><strong>Última traza:</strong> ${escapeHtml(receipt.path)} · ${receipt.frameCount} frames · ${size} · ${receipt.captureMode === 'screencast' ? 'tiempo real' : 'paso a paso'}${receipt.warnings.length === 0 ? '' : ` · ${receipt.warnings.length} aviso(s)`}</p>`;
}

function selectedLiveViewerDisplayId(sessionId: string): string | undefined {
  if (developmentActivity.liveViewerSessionId === sessionId && developmentActivity.liveViewerDisplayId !== undefined) {
    return developmentActivity.liveViewerDisplayId;
  }
  return rememberedLiveViewerDisplayId() ?? developmentActivity.recommendedDisplayId ?? developmentActivity.displays?.[0]?.id;
}

function liveViewerDisplayPickerHtml(sessionId: string): string {
  const displays = developmentActivity.displays ?? [];
  if (displays.length === 0) return '';
  const selectedId = selectedLiveViewerDisplayId(sessionId);
  return `<label class="live-viewer-display-picker"><span>Pantalla</span><select data-live-display="${sessionId}" aria-label="Pantalla para la ventana en vivo">${displays
    .map((display) => `<option value="${escapeHtml(display.id)}" ${display.id === selectedId ? 'selected' : ''}>Pantalla ${display.ordinal}${display.isPrimary ? ' (principal)' : ''}${display.label === `Monitor ${display.ordinal}` ? '' : ` — ${escapeHtml(display.label)}`}</option>`)
    .join('')}</select></label>`;
}

function selectedWebLiveViewerDisplayId(sessionId: string): string | undefined {
  if (webLiveViewer.visible && webLiveViewer.sessionId === sessionId && webLiveViewer.displayId !== undefined) {
    return webLiveViewer.displayId;
  }
  return rememberedLiveViewerDisplayId() ?? webLiveViewer.recommendedDisplayId ?? webLiveViewer.displays[0]?.id;
}

function webLiveViewerDisplayPickerHtml(sessionId: string): string {
  if (webLiveViewer.displays.length === 0) return '';
  const selectedId = selectedWebLiveViewerDisplayId(sessionId);
  return `<label class="live-viewer-display-picker"><span>Pantalla</span><select data-web-live-display="${sessionId}" aria-label="Pantalla para la investigación en vivo">${webLiveViewer.displays
    .map((display) => `<option value="${escapeHtml(display.id)}" ${display.id === selectedId ? 'selected' : ''}>Pantalla ${display.ordinal}${display.isPrimary ? ' (principal)' : ''}${display.label === `Monitor ${display.ordinal}` ? '' : ` — ${escapeHtml(display.label)}`}</option>`)
    .join('')}</select></label>`;
}

function permissionsSummary(permissions: WorkspacePermissions): string {
  return PERMISSION_KEYS.filter((key) => permissions[key]).map((key) => PERMISSION_LABELS[key]).join(', ') || '(ninguno)';
}

function enabledPermissionCount(permissions: WorkspacePermissions): number {
  return PERMISSION_KEYS.filter((key) => permissions[key]).length;
}

function permissionRisk(permissions: WorkspacePermissions): 'low' | 'medium' | 'high' {
  if (permissions.gitWrite || permissions.validations || permissions.processes || permissions.browserInteract || permissions.browserHumanControl) return 'high';
  if (permissions.write || permissions.overwrite) return 'medium';
  return 'low';
}

function activeProfile() {
  return settingsDraft.connectionProfiles.find((profile) => profile.id === settingsDraft.activeConnectionProfileId);
}

function permissionPreset(permissions: WorkspacePermissions): 'readOnly' | 'edit' | 'development' | 'custom' {
  const enabled = PERMISSION_KEYS.filter((key) => permissions[key]);
  if (enabled.length === 1 && permissions.read) return 'readOnly';
  if (permissions.read && permissions.write && permissions.overwrite && permissions.gitRead &&
      !permissions.validations && !permissions.gitWrite && !permissions.processes &&
      !permissions.browserRead && !permissions.browserInteract && !permissions.browserHumanControl) return 'edit';
  if (permissions.read && permissions.write && permissions.overwrite && permissions.gitRead &&
      permissions.validations && permissions.gitWrite && !permissions.processes &&
      !permissions.browserRead && !permissions.browserInteract && !permissions.browserHumanControl) return 'development';
  return 'custom';
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z][A-Za-z0-9]*Error:\s*)?/i, '');
}

async function withBusyButton<T>(button: HTMLButtonElement, busyLabel: string, task: () => Promise<T>): Promise<T> {
  if (button.disabled) throw new Error('La acción ya está en curso.');
  const label = button.textContent ?? '';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
  }
}

function runtimeKeyStatus(): string {
  if (apiKeyDraft !== '') {
    return keySaved ? 'clave nueva sin validar; se conserva la anterior' : 'clave lista para validar';
  }
  if (tunnelKeyState.status === 'available') return 'guardada y cifrada por Windows';
  if (tunnelKeyState.status === 'encryption-unavailable') return 'cifrado de Windows no disponible; uso temporal';
  if (tunnelKeyState.status === 'unreadable') return 'clave guardada ilegible; escribe una nueva';
  if (tunnelKeyState.status === 'io-error') return 'no se pudo leer el almacén de claves';
  return 'no guardada';
}

function updateRuntimeKeyStatusUi(): void {
  document.querySelectorAll<HTMLElement>('.field-status').forEach((status) => {
    status.textContent = runtimeKeyStatus();
  });
}

function safeTunnelErrorMessage(error: unknown, action: 'guardar el ID' | 'preparar el perfil' | 'diagnóstico' | 'conexión'): string {
  const normalized = errorMessage(error).toLowerCase();
  if (/tunnel_key_required/.test(normalized)) {
    return 'Escribe la clave secreta de runtime para conectar este perfil.';
  }
  if (/key_store_encryption_unavailable/.test(normalized)) {
    return 'El cifrado de Windows no está disponible. Escribe la clave para usarla solo durante esta sesión.';
  }
  if (/key_store_unreadable/.test(normalized)) {
    return 'La clave guardada ya no se puede descifrar con esta cuenta de Windows. Escribe una nueva para reemplazarla después de conectar.';
  }
  if (/key_store_read_failed/.test(normalized)) {
    return 'No se pudo leer el almacén local de claves. Puedes escribir la clave para esta sesión y revisar el acceso al perfil.';
  }
  if (/401|403|unauthor|forbidden|api.?key|credential|clave.+rechaz/.test(normalized)) {
    return 'La clave de runtime fue rechazada. Verifica la clave o genera una nueva; no se guardó el valor rechazado.';
  }
  if (/tunnel[\s_-]?id|identificador de túnel/.test(normalized)) {
    return 'El ID del túnel no es válido. Copia desde Tunnels el valor que empieza por tunnel_.';
  }
  if (/timeout|timed out|tiempo de espera/.test(normalized)) {
    return `No se pudo completar el ${action}: el servicio tardó demasiado en responder. Comprueba la conexión e inténtalo de nuevo.`;
  }
  if (/econn|enotfound|network|socket|conexión|connect/.test(normalized)) {
    return `No se pudo completar el ${action}: no fue posible contactar al servicio. Comprueba Internet e inténtalo de nuevo.`;
  }
  if (normalized.includes('debe estar desconectado')) {
    return 'Desconecta el túnel antes de cambiar o diagnosticar su configuración.';
  }
  return `No se pudo completar el ${action}. Revisa los datos e inténtalo de nuevo.`;
}

function diagnosticFailureMessage(output: string): string {
  return /401|403|unauthor|forbidden|api.?key|credential|clave.+rechaz/i.test(output)
    ? 'La clave de runtime fue rechazada. Verifica la clave o genera una nueva; no se guardó el valor rechazado.'
    : 'El diagnóstico encontró un problema. Revisa el detalle técnico y corrige la configuración antes de continuar.';
}

function draftFromWorkspace(workspace?: AuthorizedWorkspace): WorkspaceFormDraft {
  return {
    name: workspace?.name ?? '',
    rootPath: workspace?.rootPath ?? '',
    enabled: workspace?.enabled ?? true,
    permissions: { ...(workspace?.permissions ?? DEFAULT_PERMISSIONS) },
    maxFileBytes: workspace?.limits.maxFileBytes ?? 1_048_576,
    largeArtifacts: workspace?.limits.largeArtifacts ?? settingsDraft.largeArtifactPreference,
    validationProfilesText: JSON.stringify(workspace?.validationProfiles ?? {}, null, 2),
    processProfilesText: JSON.stringify(workspace?.processProfiles ?? {}, null, 2),
    browserProfilesText: JSON.stringify(workspace?.browserProfiles ?? {}, null, 2),
  };
}

async function refreshWorkspaces(renderAfter = true): Promise<void> {
  try {
    workspaces = await window.desktop.listWorkspaces();
    workspacesError = undefined;
  } catch (error) {
    workspacesError = error instanceof Error ? error.message : String(error);
  }
  if (renderAfter) render();
}

async function refreshApplications(renderAfter = true): Promise<void> {
  try {
    applications = await window.desktop.listApplications();
    applicationsError = undefined;
  } catch (error) {
    applicationsError = errorMessage(error);
  }
  if (renderAfter) render();
}

async function refreshAssistedProjects(renderAfter = true): Promise<void> {
  try {
    assistedProjects = await window.desktop.listAssistedProjects();
    assistedProjectsError = undefined;
  } catch (error) {
    assistedProjectsError = errorMessage(error);
  }
  if (renderAfter) render();
}

async function refreshV1Projects(renderAfter = true): Promise<void> {
  try {
    v1Projects = await window.desktop.listV1Projects();
  } catch (error) {
    assistedProjectsError = errorMessage(error);
  }
  if (renderAfter) render();
}

function assistedPermissions(preset: AssistedAccessPreset): WorkspacePermissions {
  return {
    read: true,
    write: true,
    overwrite: true,
    gitRead: true,
    validations: true,
    gitWrite: preset === 'complete',
    processes: true,
    browserRead: preset !== 'code',
    browserInteract: preset !== 'code',
    browserHumanControl: preset !== 'code',
  };
}

function assistedProjectPermissions(draft: AssistedProjectWizardDraft): WorkspacePermissions {
  const permissions = assistedPermissions(draft.access);
  return draft.initializeGit ? { ...permissions, gitWrite: true } : permissions;
}

function assistedWizardHtml(): string {
  const draft = assistedWizard;
  if (draft === undefined) return '';
  const steps = ['Carpeta', 'Acceso', 'Preparación', 'Revisar'];
  const stepper = `<div class="wizard-steps">${steps.map((label, index) => `<span class="${draft.step >= index + 1 ? 'active' : ''}"><b>${index + 1}</b>${label}</span>`).join('')}</div>`;
  let body = '';
  if (draft.step === 1) {
    body = `<p>Elige una sola carpeta raíz. Si después aparecen frontend, API o varios repositorios dentro, LocalBridge propondrá la organización sin ampliar este límite.</p>
      <label>Nombre del proyecto<input id="assisted-name" maxlength="80" value="${escapeHtml(draft.name)}" required /></label>
      <label>Descripción opcional<input id="assisted-description" maxlength="240" value="${escapeHtml(draft.description)}" /></label>
      <label>Carpeta raíz<div class="path-row"><input id="assisted-root" readonly value="${escapeHtml(draft.rootPath)}" /><button type="button" id="assisted-pick-folder">Elegir…</button></div></label>`;
  } else if (draft.step === 2) {
    body = `<p>El proyecto no obtiene permisos implícitos. Elige el objetivo y revisa las capacidades que se concederán a la carpeta.</p>
      <div class="objective-grid">
        <label class="objective-option"><input type="radio" name="assisted-access" value="code" ${draft.access === 'code' ? 'checked' : ''}/><span><strong>Desarrollar código</strong><small>Archivos, validaciones, Git de lectura y servidores. Sin navegador ni publicación.</small></span></label>
        <label class="objective-option"><input type="radio" name="assisted-access" value="web" ${draft.access === 'web' ? 'checked' : ''}/><span><strong>Desarrollar y probar web</strong><small>Añade navegador e intervención humana. Git push continúa desactivado.</small></span></label>
        <label class="objective-option"><input type="radio" name="assisted-access" value="complete" ${draft.access === 'complete' ? 'checked' : ''}/><span><strong>Flujo completo</strong><small>Incluye Git de escritura; commit y push conservan su aprobación protegida.</small></span></label>
      </div><p class="dependency-note">Capacidades: ${escapeHtml(permissionsSummary(assistedPermissions(draft.access)))}</p>`;
  } else if (draft.step === 3) {
    body = `<p>LocalBridge detectará manifests y lockfiles. La propuesta se congela con huellas y no se ejecuta hasta el último paso.</p>
      <div class="objective-grid">
        <label class="objective-option"><input type="radio" name="assisted-policy" value="restricted" ${draft.policy === 'restricted' ? 'checked' : ''}/><span><strong>Restringido — recomendado</strong><small>Instala dependencias sin scripts de lifecycle.</small></span></label>
        <label class="objective-option"><input type="radio" name="assisted-policy" value="compatible" ${draft.policy === 'compatible' ? 'checked' : ''}/><span><strong>Compatible</strong><small>Permite scripts solo después de una confirmación local específica.</small></span></label>
        <label class="objective-option"><input type="radio" name="assisted-policy" value="manual" ${draft.policy === 'manual' ? 'checked' : ''}/><span><strong>Instalación manual</strong><small>LocalBridge configura perfiles, pero no instala dependencias.</small></span></label>
      </div>
      <label class="permission-option"><input type="checkbox" id="assisted-git-init" ${draft.initializeGit ? 'checked' : ''}/><span><strong>Inicializar Git si corresponde</strong><small>Acción fija: no configura remoto, rama ni credenciales.</small></span></label>`;
  } else {
    const permissions = assistedProjectPermissions(draft);
    body = `<div class="review-summary"><h4>${escapeHtml(draft.name)}</h4><p>${escapeHtml(draft.rootPath)}</p><dl><div><dt>Acceso</dt><dd>${enabledPermissionCount(permissions)} capacidades explícitas</dd></div><div><dt>Instalación</dt><dd>${draft.policy === 'restricted' ? 'Sin scripts de lifecycle' : draft.policy === 'compatible' ? 'Scripts con confirmación local única' : 'Manual'}</dd></div><div><dt>Git</dt><dd>${draft.initializeGit ? 'Inicialización fija incluida' : 'No inicializar'}</dd></div></dl></div>
      <p class="risk-note risk-high">Crear autoriza la carpeta y analiza el proyecto. Si está vacía, quedará lista para que ChatGPT cree el stack; nada se instalará hasta que revises y apruebes la propuesta detectada.</p>`;
  }
  return `<div class="surface-card assisted-wizard"><div class="card-heading"><div><p class="eyebrow">Nuevo proyecto · paso ${draft.step} de 4</p><h3>Creación asistida</h3></div><button type="button" id="assisted-cancel">Cancelar</button></div>${stepper}<div class="wizard-body">${body}</div><div class="actions sticky-form-actions">${draft.step > 1 ? '<button type="button" id="assisted-back">Atrás</button>' : ''}<button type="button" id="assisted-next" class="primary">${draft.step === 4 ? 'Crear y analizar' : 'Continuar'}</button></div><p id="assisted-error" class="error-text" role="alert"></p></div>`;
}

function setupPlanSummaryHtml(session: AssistedProjectsState['sessions'][number] | undefined): string {
  const plan = session?.plan;
  if (plan === undefined) {
    return session?.errorCode === 'SETUP_MANIFEST_MISSING'
      ? '<p class="dependency-note">La carpeta aún no tiene un manifest reconocido. Ya está autorizada: pide a ChatGPT crear el stack y luego pulsa Analizar de nuevo.</p>'
      : '';
  }
  const installs = plan.actions.filter((action) => action.kind === 'node-install');
  const servers = plan.proposedProfiles.filter((profile) => profile.role === 'server');
  const validations = plan.proposedProfiles.filter((profile) => profile.role === 'validation');
  return `<div class="setup-summary"><p><strong>Topología:</strong> ${plan.topology === 'multi-repo' ? `${plan.proposedWorkspaceRoots.length} repositorios (${plan.proposedWorkspaceRoots.map(escapeHtml).join(', ')})` : plan.topology === 'monorepo' ? 'Monorepo' : 'Proyecto único'}</p><p><strong>Dependencias:</strong> ${plan.directDependencyCount} directas + ${plan.directDevDependencyCount} de desarrollo · ${plan.packageManagers.length === 0 ? 'sin gestor automático' : plan.packageManagers.map(escapeHtml).join(', ')} · ${installs.length === 0 ? 'sin instalación automática' : `${installs.length} instalación(es), modo ${escapeHtml(plan.policy)}`}</p><p><strong>Perfiles:</strong> ${servers.length} servidor(es) [${servers.map((profile) => escapeHtml(profile.name)).join(', ') || 'ninguno'}], ${validations.length} validación(es) [${validations.map((profile) => escapeHtml(profile.name)).join(', ') || 'ninguna'}]</p><p><strong>Aplicación:</strong> ${plan.proposedApplication === undefined ? 'no necesaria' : `${plan.proposedApplication.services.length} servicio(s), vista ${escapeHtml(plan.proposedApplication.services.find((service) => service.profileProposalId === plan.proposedApplication?.primaryProfileProposalId)?.alias ?? 'principal')}`}</p></div>`;
}

function setupErrorLabel(code: string): string {
  const labels: Record<string, string> = {
    SETUP_PLAN_STALE: 'El proyecto cambió después del análisis. Analízalo de nuevo.',
    SETUP_TOOLCHAIN_MISSING: 'Falta Git o el gestor de paquetes en una ubicación compatible.',
    SETUP_ALREADY_RUNNING: 'Ya hay demasiadas preparaciones activas. Espera o cancela una.',
    SETUP_WORKSPACE_BUSY: 'La carpeta tiene un servidor activo. Deténlo antes de preparar.',
    SETUP_PRIVATE_CONFIG_UNSUPPORTED: 'Se detectó configuración privada del gestor. Usa instalación manual.',
    SETUP_CANCELLED: 'La preparación fue cancelada. Analiza de nuevo para continuar.',
    SETUP_FAILED: 'La preparación falló. Revisa Actividad y vuelve a analizar.',
    SETUP_INTERRUPTED: 'La preparación fue interrumpida de forma segura.',
    TOPOLOGY_REVIEW_REQUIRED: 'La estructura necesita revisión local antes de continuar.',
    UNSUPPORTED_ECOSYSTEM: 'Este stack todavía requiere configuración manual.',
  };
  return labels[code] ?? code;
}

function assistedProjectCardHtml(project: AssistedProjectsState['projects'][number]): string {
  const session = assistedProjects.sessions.filter((candidate) => candidate.projectId === project.id).at(-1);
  const run = assistedProjects.runs.filter((candidate) => candidate.projectId === project.id).at(-1);
  const busy = assistedBusyProjectId === project.id || run?.state === 'running';
  const phase = session?.phase ?? project.setupStatus;
  const label = project.setupStatus === 'ready' ? 'Listo' : phase === 'awaiting-local-review' ? 'Revisión local' : phase === 'installing' || phase === 'finalizing' ? 'Preparando…' : phase === 'failed' ? 'Falló' : phase === 'interrupted' ? 'Interrumpido' : 'Borrador';
  return `<article class="workspace-card assisted-project-card"><div class="card-heading"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.description || `${project.workspaceIds.length} carpeta(s) autorizada(s)`)}</p></div><span class="state-pill ${project.setupStatus === 'ready' ? 'state-ok' : ''}">${label}</span></div>${setupPlanSummaryHtml(session)}${run?.state === 'running' ? `<p role="status" aria-live="polite">Preparando ${run.completedActions}/${run.totalExecutableActions} acciones…</p>` : ''}${session !== undefined && project.setupStatus !== 'ready' ? `<label>Modo de instalación<select data-assisted-policy="${project.id}" ${busy ? 'disabled' : ''}><option value="restricted" ${session.policy === 'restricted' ? 'selected' : ''}>Restringido</option><option value="compatible" ${session.policy === 'compatible' ? 'selected' : ''}>Compatible con scripts</option><option value="manual" ${session.policy === 'manual' ? 'selected' : ''}>Manual</option></select></label>` : ''}<div class="actions"><button type="button" data-assisted-refresh="${project.id}" ${busy ? 'disabled' : ''}>Analizar de nuevo</button>${session?.phase === 'awaiting-local-review' && session.plan !== undefined ? `<button type="button" class="primary" data-assisted-approve="${project.id}" data-plan-sha="${session.plan.planSha256}" ${busy ? 'disabled aria-busy="true"' : ''}>Revisar y preparar</button>` : ''}${busy ? `<button type="button" class="danger" data-assisted-cancel-run="${project.id}">Cancelar</button>` : ''}<button type="button" class="danger" data-assisted-remove="${project.id}" ${busy ? 'disabled' : ''}>Eliminar desarrollo y accesos</button></div>${session?.errorCode !== undefined && session.errorCode !== 'SETUP_MANIFEST_MISSING' ? `<p class="error-text">${escapeHtml(setupErrorLabel(session.errorCode))}</p>` : ''}</article>`;
}

function adoptProjectHtml(): string {
  if (!showAdoptProject) return '';
  return `<form id="adopt-project-form" class="surface-card"><div class="card-heading"><div><h3>Agrupar configuración existente</h3><p>Solo crea una referencia de organización; no cambia permisos, perfiles ni aplicaciones.</p></div><button type="button" id="cancel-adopt-project">Cancelar</button></div><label>Nombre<input name="name" maxlength="80" required /></label><fieldset><legend>Carpetas autorizadas</legend>${workspaces.map((workspace) => `<label class="checkbox-row"><input type="checkbox" name="workspaceId" value="${workspace.id}"/>${escapeHtml(workspace.name)}</label>`).join('')}</fieldset><label>Aplicación opcional<select name="applicationId"><option value="">Sin aplicación</option>${applications.map((application) => `<option value="${application.id}">${escapeHtml(application.name)}</option>`).join('')}</select></label><button type="submit" class="primary">Crear agrupación</button><p id="adopt-error" class="error-text"></p></form>`;
}

/**
 * Motivo real del estado de una ficha v1 (ADR-0040). Un escaneo incompleto ya no
 * degrada el estado, así que `review` solo aparece por ambigüedad de raíces.
 */
function v1ProjectStateNote(state: string): string {
  if (state === 'review') {
    return '<p class="risk-note">Este proyecto tiene varias raíces sin resolver. Vuelve a abrirlo desde la carpeta que las contiene para analizarlo como una unidad.</p>';
  }
  if (state === 'unavailable') {
    return '<p class="risk-note">La carpeta vinculada ya no está disponible. Revísala antes de volver a usar el proyecto.</p>';
  }
  if (state === 'conflict') {
    return '<p class="risk-note risk-high">Hay definiciones incompatibles para este proyecto. Repáralas antes de habilitar terminal.</p>';
  }
  return '';
}

function assistedProjectsSectionHtml(): string {
  const error = assistedProjectsError === undefined ? '' : `<p class="feedback feedback-error">${escapeHtml(assistedProjectsError)}</p>`;
  const draft = v1ProjectDraft;
  const newProject = draft === undefined ? '' : `<form id="v1-project-form" class="surface-card" aria-busy="false"><div class="card-heading"><div><p class="eyebrow">Proyecto v1</p><h3>Abrir una carpeta para ChatGPT</h3></div><button type="button" id="v1-project-cancel">Cancelar</button></div><p>Elige una carpeta vacía, un repositorio, un monorepo o un contenedor con varios servicios. El análisis no ejecuta ni instala nada.</p><label>Nombre<input id="v1-project-name" maxlength="80" required value="${escapeHtml(draft.name)}" /></label><label>Descripción opcional<input id="v1-project-description" maxlength="240" value="${escapeHtml(draft.description)}" /></label><label>Carpeta<div class="path-row"><input id="v1-project-root" readonly required value="${escapeHtml(draft.rootPath)}"/><button type="button" id="v1-project-pick">Elegir…</button></div></label><fieldset><legend>Nivel de confianza</legend><label class="objective-option"><input type="radio" name="v1-trust" value="guided" ${draft.trustMode === 'guided' ? 'checked' : ''}/><span><strong>Guiado</strong><small>Usa las herramientas cerradas y permisos clásicos. Sin terminal general.</small></span></label><label class="objective-option"><input type="radio" name="v1-trust" value="project-agent" disabled/><span><strong>Agente en proyecto — no disponible</strong><small>Se habilitará solo cuando el sandbox de Windows pueda demostrarse; nunca degrada a control total.</small></span></label><label class="objective-option risk-high"><input type="radio" name="v1-trust" value="full-host" ${draft.trustMode === 'full-host' ? 'checked' : ''}/><span><strong>Control total del equipo — avanzado</strong><small>Terminal real con tu cuenta de Windows. La carpeta es el inicio, no un límite de seguridad.</small></span></label></fieldset><div class="actions sticky-form-actions"><button class="primary" type="submit" id="v1-project-save">Crear proyecto</button></div><p id="v1-project-error" class="error-text" role="alert"></p></form>`;
  const cards = v1Projects.projects.map((project) => {
    const decision = v1Projects.decisions.find((candidate) => candidate.projectId === project.id);
    const assistedProject = assistedProjects.projects.find((candidate) => candidate.id === project.id);
    const setupSession = assistedProjects.sessions.filter((candidate) => candidate.projectId === project.id).at(-1);
    const mode = decision?.status === 'active' ? decision.mode : 'guided';
    const busy = v1BusyProjectId === project.id;
    const label = mode === 'full-host' ? 'Control total' : mode === 'project-agent' ? 'Agente en proyecto' : 'Guiado';
    const review = v1ProjectStateNote(project.state);
    const pendingSetup = assistedProject?.setupStatus === 'review-required' && setupSession?.phase === 'awaiting-local-review'
      ? `<div class="setup-summary">${setupPlanSummaryHtml(setupSession)}<p class="dependency-note">${mode === 'full-host' ? 'La propuesta guiada cambió. Tu terminal sigue disponible; revísala solo si quieres que LocalBridge aplique estos perfiles o instalaciones.' : 'Esta propuesta solo afecta la preparación guiada. Revísala para aplicar perfiles o instalaciones.'}</p>${setupSession.plan === undefined ? '' : `<button type="button" data-assisted-approve="${project.id}" data-plan-sha="${setupSession.plan.planSha256}" ${busy ? 'disabled' : ''}>Revisar preparación guiada</button>`}</div>`
      : '';
    return `<article class="workspace-card"><div class="card-heading"><div><h3>${escapeHtml(project.displayName)}</h3><p>${escapeHtml(project.description || project.selectedRoot)}</p></div><span class="state-pill ${mode === 'full-host' ? 'state-danger' : ''}">${label}</span></div><p><strong>Estructura:</strong> ${escapeHtml(project.topology)} · ${project.nodes.length} nodo(s)</p>${review}${pendingSetup}${mode === 'full-host' ? '<p class="risk-note risk-high">La terminal puede operar fuera de esta carpeta con la autoridad de tu cuenta.</p>' : '<p class="dependency-note">La terminal general está desactivada. Los permisos existentes siguen iguales.</p>'}<div class="actions"><button type="button" data-v1-rescan="${project.id}" ${busy ? 'disabled aria-busy="true"' : ''}>Revisar estructura</button>${mode === 'full-host' ? `<button type="button" data-v1-guided="${project.id}" ${busy ? 'disabled' : ''}>Volver a Guiado</button><button type="button" class="danger" data-v1-revoke="${project.id}" ${busy ? 'disabled' : ''}>Revocar</button>` : `<button type="button" class="primary" data-v1-full="${project.id}" ${busy || project.state !== 'ready' ? 'disabled' : ''}>Habilitar control total</button>`}<button type="button" class="danger" data-assisted-remove="${project.id}" ${busy ? 'disabled' : ''}>Eliminar desarrollo y accesos</button></div></article>`;
  }).join('');
  const v1ProjectIds = new Set(v1Projects.projects.map((project) => project.id));
  const legacyProjects = assistedProjects.projects.filter((project) => !v1ProjectIds.has(project.id));
  const legacyBody = legacyProjects.length === 0 && assistedWizard === undefined && !showAdoptProject
    ? '<div class="empty-state compact-empty"><strong>Aún no hay proyectos asistidos clásicos</strong><p>Tus carpetas y aplicaciones actuales siguen funcionando igual.</p><button type="button" id="show-assisted-wizard-empty">Crear con el asistente clásico</button></div>'
    : `<div class="workspace-grid">${legacyProjects.map(assistedProjectCardHtml).join('')}</div>`;
  const legacy = `<details class="surface-card"><summary>Configuración guiada y compatibilidad v0.9</summary><p>Workspaces, aplicaciones, perfiles y el asistente anterior permanecen disponibles sin cambios.</p><div class="actions"><button type="button" id="show-adopt-project">Agrupar existente</button><button type="button" id="show-assisted-wizard">Abrir asistente clásico</button></div>${assistedWizardHtml()}${adoptProjectHtml()}${legacyBody}</details>`;
  return `<div class="section-heading"><div><p class="eyebrow">Proyectos</p><h2>Trabaja desde una carpeta</h2><p>Selecciona una raíz una sola vez. Frontend, backend, repositorios y servicios que se creen dentro pertenecen al mismo proyecto.</p></div><button type="button" id="show-v1-project" class="primary">Abrir carpeta</button></div>${error}${newProject}${v1Projects.projects.length === 0 && draft === undefined ? '<div class="empty-state"><strong>Aún no hay proyectos</strong><p>Abre una carpeta vacía o existente y elige su nivel de confianza.</p><button type="button" id="show-v1-project-empty">Abrir carpeta</button></div>' : `<div class="workspace-grid">${cards}</div>`}${legacy}`;
}

function workspaceFormHtml(existing?: AuthorizedWorkspace): string {
  const draft = workspaceFormDraft ?? draftFromWorkspace(existing);
  const perms = draft.permissions;
  const artifactPolicy = draft.largeArtifacts;
  const gib = 1024 * 1024 * 1024;

  return `
    <form id="workspace-form" aria-labelledby="workspace-form-title">
      <div class="workspace-form-heading">
        <div>
          <p class="eyebrow">${existing !== undefined ? 'Edición enfocada' : 'Nuevo proyecto'}</p>
          <h3 id="workspace-form-title">${existing !== undefined ? `Editar: ${escapeHtml(existing.name)}` : 'Autorizar una carpeta'}</h3>
        </div>
        ${existing !== undefined ? '<span class="state-pill">Solo este proyecto</span>' : ''}
      </div>
      <div class="form-tabs" role="tablist" aria-label="Secciones del proyecto">
        ${([['general', 'General'], ['access', 'Acceso'], ['services', 'Servicios'], ['advanced', 'Avanzado']] as const).map(([tab, label]) => `<button type="button" role="tab" data-workspace-tab="${tab}" aria-selected="${activeWorkspaceFormTab === tab}" class="${activeWorkspaceFormTab === tab ? 'active' : ''}">${label}</button>`).join('')}
      </div>
      <section class="form-tab-panel" role="tabpanel" ${activeWorkspaceFormTab === 'general' ? '' : 'hidden'}>
        <label>
          Nombre
          <input type="text" name="name" required value="${escapeHtml(draft.name)}" />
        </label>
        <label>
          Carpeta
          <div class="path-row">
            <input type="text" name="rootPath" required readonly value="${escapeHtml(draft.rootPath)}" />
            <button type="button" id="pick-folder">Elegir…</button>
          </div>
        </label>
        ${existing !== undefined ? `<label class="checkbox-row"><input type="checkbox" name="enabled" ${draft.enabled ? 'checked' : ''}/> Habilitado</label>` : '<input type="hidden" name="enabled" value="on" />'}
      </section>
      <section class="form-tab-panel" role="tabpanel" ${activeWorkspaceFormTab === 'access' ? '' : 'hidden'}>
        <label>
          Nivel de acceso
          <select id="permission-preset">
            <option value="readOnly" ${permissionPreset(perms) === 'readOnly' ? 'selected' : ''}>Solo lectura — recomendado</option>
            <option value="edit" ${permissionPreset(perms) === 'edit' ? 'selected' : ''}>Editar proyecto</option>
            <option value="development" ${permissionPreset(perms) === 'development' ? 'selected' : ''}>Desarrollo completo</option>
            <option value="custom" ${permissionPreset(perms) === 'custom' ? 'selected' : ''}>Personalizado</option>
          </select>
        </label>
        <div class="permissions-grid">
          ${PERMISSION_KEYS.map(
            (key) =>
              `<label class="permission-option"><input type="checkbox" name="perm-${key}" ${perms[key] ? 'checked' : ''}/><span><strong>${PERMISSION_LABELS[key]}</strong><small>${PERMISSION_DESCRIPTIONS[key]}</small></span></label>`,
          ).join('')}
        </div>
        <p class="dependency-note"><strong>Permisos independientes:</strong> Crear archivos no permite editar los existentes; consultar Git no permite publicar. Cada capacidad adicional debe quedar marcada expresamente.</p>
        ${existing?.automationReviewRequired === true ? '<p class="risk-note risk-high"><strong>Pendiente de revisión local:</strong> estos perfiles se importaron desactivados. Revísalos y guarda para confirmar su configuración en esta PC.</p>' : ''}
        <p id="permission-warning" class="risk-note risk-${permissionRisk(perms)}">${permissionPreset(perms) === 'development' ? 'Acceso amplio: permite cambios de archivos y Git. Las acciones críticas de Git siguen pidiendo aprobación.' : 'Cada capacidad puede revocarse después.'}</p>
      </section>
      <section class="form-tab-panel" role="tabpanel" ${activeWorkspaceFormTab === 'services' ? '' : 'hidden'}>
        <h4>Servicios y validaciones</h4>
        <p>LocalBridge solo puede ejecutar comandos ya declarados por el proyecto y elegidos aquí.</p>
        <div class="actions">
          <button type="button" id="detect-commands">Detectar comandos</button>
          <button type="button" id="authorize-all-detected" ${detectedCommands.length === 0 ? 'disabled' : ''}>Seleccionar todos</button>
          <button type="button" id="authorize-process-detected" ${detectedCommands.length === 0 ? 'disabled' : ''}>Usar selección como servidores</button>
        </div>
        ${
          detectedCommands.length > 0
            ? '<p class="risk-note risk-high">Revisa cada opción: los manifiestos también pueden declarar tareas destructivas.</p>'
            : ''
        }
        <div id="detected-commands"></div>
        <p class="dependency-note">La detección solo propone perfiles cerrados. Revísalos antes de guardarlos.</p>
      </section>
      <section class="form-tab-panel" role="tabpanel" ${activeWorkspaceFormTab === 'advanced' ? '' : 'hidden'}>
        <p>Edición técnica opcional. El flujo normal no requiere modificar JSON.</p>
        <label>
          Tamaño máximo para archivos de texto
          <select name="maxFileBytes">
            ${[1, 4, 8, 16, 25].map((mib) => {
              const bytes = mib * 1024 * 1024;
              const recommendation = mib === 8 ? ' — recomendado para capturas 1920×1080' : '';
              return `<option value="${bytes}" ${draft.maxFileBytes === bytes ? 'selected' : ''}>${mib} MiB${recommendation}</option>`;
            }).join('')}
            ${[1, 4, 8, 16, 25].some((mib) => draft.maxFileBytes === mib * 1024 * 1024) ? '' : `<option value="${draft.maxFileBytes}" selected>Actual: ${(draft.maxFileBytes / (1024 * 1024)).toFixed(2)} MiB</option>`}
          </select>
          <small>Aplica a lectura y edición de código. Las descargas web y trazas visuales usan streaming administrado de hasta 1 GiB sin cambiar este permiso.</small>
        </label>
        <label>
          Análisis de artefactos grandes
          <select name="largeArtifactMode" id="large-artifact-mode">
            <option value="standard" ${artifactPolicy.mode === 'standard' ? 'selected' : ''}>Estándar</option>
            <option value="adaptive" ${artifactPolicy.mode === 'adaptive' ? 'selected' : ''}>Adaptativo — sin límite fijo</option>
            <option value="custom" ${artifactPolicy.mode === 'custom' ? 'selected' : ''}>Límite personalizado</option>
          </select>
          <small>Se aplica a trabajos administrados por streaming. Adaptativo conserva una reserva de disco y nunca carga el archivo completo en memoria.</small>
        </label>
        <label>
          Máximo por fuente personalizada (GiB)
          <input name="largeArtifactCustomGiB" type="number" min="0.001" step="0.001" value="${artifactPolicy.mode === 'custom' ? artifactPolicy.customSourceBytes / gib : 1}" ${artifactPolicy.mode === 'custom' ? '' : 'disabled'} />
        </label>
        <label>
          Reserva mínima de disco (GiB)
          <input name="largeArtifactReserveGiB" type="number" min="0.0625" step="0.0625" value="${artifactPolicy.reserve.minimumFreeBytes / gib}" />
        </label>
        <label>
          Reserva mínima de disco (%)
          <input name="largeArtifactReservePercent" type="number" min="1" max="50" step="1" value="${artifactPolicy.reserve.minimumFreePercent}" />
        </label>
        <label>
          Trabajos pesados simultáneos
          <select name="largeArtifactConcurrentJobs"><option value="1" ${artifactPolicy.maxConcurrentJobs === 1 ? 'selected' : ''}>1</option><option value="2" ${artifactPolicy.maxConcurrentJobs === 2 ? 'selected' : ''}>2</option></select>
        </label>
        <label>
          Perfiles de validación (JSON avanzado)
          <textarea name="validationProfiles" rows="3">${escapeHtml(draft.validationProfilesText)}</textarea>
        </label>
        <label>
          Perfiles de servidor aprobados (JSON avanzado)
          <textarea name="processProfiles" rows="5">${escapeHtml(draft.processProfilesText)}</textarea>
        </label>
        <label>
          Perfiles web loopback aprobados (JSON avanzado)
          <textarea name="browserProfiles" rows="5">${escapeHtml(draft.browserProfilesText)}</textarea>
        </label>
      </section>
      <div class="actions sticky-form-actions">
        <button type="submit" class="primary">${existing !== undefined ? 'Guardar cambios' : 'Autorizar workspace'}</button>
        <button type="button" id="cancel-form">Cancelar</button>
      </div>
      <p id="form-error" class="error-text" role="alert"></p>
    </form>
  `;
}

function workspaceReportHtml(workspaceId: string): string {
  const report = workspaceReports[workspaceId];
  if (report === undefined) return '';
  return `<ul class="readiness-list">${report.checks
    .map((check) => `<li class="readiness-${check.severity}">${check.ok ? '✓' : check.severity === 'warning' ? '!' : '×'} <strong>${escapeHtml(check.label)}:</strong> ${escapeHtml(check.detail)}</li>`)
    .join('')}</ul>`;
}

function workspaceCardHtml(workspace: AuthorizedWorkspace, selected = false): string {
  const memberships = applications.filter((application) => application.services.some((service) => service.workspaceId === workspace.id));
  return `
    <article class="workspace-card ${workspace.enabled ? '' : 'workspace-disabled'} ${selected ? 'workspace-selected' : ''}" ${selected ? 'aria-current="true"' : ''}>
      <div class="card-heading">
        <div><h3>${escapeHtml(workspace.name)}</h3><p class="path-text">${escapeHtml(workspace.rootPath)}</p></div>
        <span class="state-pill ${workspace.enabled ? 'state-ok' : 'state-muted'}">${workspace.enabled ? 'Autorizado' : 'Pausado'}</span>
      </div>
      <p><strong>${enabledPermissionCount(workspace.permissions)} capacidades:</strong> ${escapeHtml(permissionsSummary(workspace.permissions))}</p>
      <p><strong>Límite de texto:</strong> ${(workspace.limits.maxFileBytes / (1024 * 1024)).toFixed(workspace.limits.maxFileBytes % (1024 * 1024) === 0 ? 0 : 2)} MiB · artefactos ${workspace.limits.largeArtifacts.mode === 'adaptive' ? 'adaptativos sin límite fijo' : workspace.limits.largeArtifacts.mode === 'custom' ? `hasta ${(workspace.limits.largeArtifacts.customSourceBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB` : 'en modo estándar'}</p>
      ${memberships.length > 0 ? `<p><strong>${memberships.length} aplicación(es):</strong> ${escapeHtml(memberships.map((application) => application.name).join(', '))}</p>` : '<p class="dependency-note">Todavía no participa en una aplicación.</p>'}
      <p class="risk-note risk-${permissionRisk(workspace.permissions)}">${permissionRisk(workspace.permissions) === 'high' ? 'Incluye capacidades de mayor impacto.' : permissionRisk(workspace.permissions) === 'medium' ? 'Puede modificar archivos.' : 'Acceso conservador de lectura.'}</p>
      <div class="actions card-actions">
        <button type="button" data-action="test" data-id="${escapeHtml(workspace.id)}">Probar configuración</button>
        <button type="button" data-action="edit" data-id="${escapeHtml(workspace.id)}" aria-pressed="${selected}" ${selected ? 'disabled' : ''}>${selected ? 'Editando' : 'Editar'}</button>
        <button type="button" class="danger" data-action="delete" data-id="${escapeHtml(workspace.id)}">Eliminar</button>
      </div>
      ${workspaceReportHtml(workspace.id)}
    </article>`;
}

function workspacesSectionHtml(): string {
  const cards = workspaces.map((workspace) => workspaceCardHtml(workspace)).join('');
  const heading = `<div class="section-heading"><div><p class="eyebrow">Proyectos</p><h2>Carpetas autorizadas</h2><p>Solo estas carpetas pueden estar disponibles para un cliente MCP.</p></div>${showCreateForm || editingWorkspace !== undefined ? '' : '<button type="button" id="show-create-form" class="primary">Autorizar carpeta</button>'}</div>`;
  const error = workspacesError !== undefined ? `<div class="empty-state error-state" role="alert"><strong>No se pudieron cargar los proyectos</strong><p>${escapeHtml(workspacesError)}</p></div>` : '';

  if (editingWorkspace !== undefined) {
    return `
      ${heading}
      ${error}
      <div class="workspace-edit-layout">
        <div class="focused-workspace">${workspaceCardHtml(editingWorkspace, true)}</div>
        <div class="form-card">${workspaceFormHtml(editingWorkspace)}</div>
      </div>
    `;
  }

  return `
    ${heading}
    ${error}
    ${cards === '' && workspacesError === undefined ? '<div class="empty-state"><strong>Aún no hay proyectos autorizados</strong><p>Agrega una carpeta y empieza con Solo lectura.</p></div>' : `<div class="workspace-grid">${cards}</div>`}
    ${showCreateForm ? `<div class="form-card">${workspaceFormHtml()}</div>` : ''}
  `;
}

function serviceCandidates(): Array<{ key: string; workspace: AuthorizedWorkspace; profile: string }> {
  return workspaces.flatMap((workspace) => Object.keys(workspace.processProfiles ?? {}).map((profile) => ({
    key: `${workspace.id}|${profile}`,
    workspace,
    profile,
  })));
}

function suggestedAlias(workspace: AuthorizedWorkspace, profile: string): string {
  const source = `${workspace.name} ${profile}`.toLocaleLowerCase();
  if (/front|web|vite|react|vue/.test(source)) return 'frontend';
  if (/back|api|server|express|laravel/.test(source)) return 'api';
  if (/worker|queue|job/.test(source)) return 'worker';
  return profile.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'service';
}

function blankApplicationWizard(): ApplicationWizardDraft {
  return { step: 1, name: '', description: '', selected: [], aliases: {}, primary: '', wildcard: {}, objective: 'web' };
}

function wizardFromApplication(application: LocalApplication): ApplicationWizardDraft {
  const selected = application.services.toSorted((a, b) => a.startupOrder - b.startupOrder).map((service) => `${service.workspaceId}|${service.processProfile}`);
  const primary = application.services.find((service) => service.id === application.primaryServiceId);
  return {
    step: 1,
    name: application.name,
    description: application.description,
    selected,
    aliases: Object.fromEntries(application.services.map((service) => [`${service.workspaceId}|${service.processProfile}`, service.alias])),
    primary: primary === undefined ? selected[0] ?? '' : `${primary.workspaceId}|${primary.processProfile}`,
    wildcard: Object.fromEntries(application.services.map((service) => [`${service.workspaceId}|${service.processProfile}`, service.allowManagedWildcard])),
    objective: 'web',
    editingId: application.id,
  };
}

function objectivePermissions(objective: AccessObjective): WorkspacePermissions {
  const base = { ...DEFAULT_PERMISSIONS };
  if (objective === 'review') return { ...base, gitRead: true };
  if (objective === 'edit') return { ...base, write: true, overwrite: true, gitRead: true, validations: true };
  if (objective === 'web') return { ...base, processes: true, browserRead: true, browserInteract: true, browserHumanControl: true };
  return { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: true, processes: true, browserRead: true, browserInteract: true, browserHumanControl: true };
}

function applicationStateLabel(application: LocalApplication): string {
  if (application.reviewState === 'reviewed') return 'Lista';
  if (application.reviewState === 'conflict') return 'Conflicto de migración';
  return 'Necesita revisión';
}

function activeRunFor(applicationId: string): ApplicationRunSummary | undefined {
  return developmentActivity.applications.find((run) => run.applicationId === applicationId);
}

function applicationCardHtml(application: LocalApplication): string {
  const run = activeRunFor(application.id);
  const primary = application.services.find((service) => service.id === application.primaryServiceId);
  const state = run?.state === 'ready' ? 'En ejecución' : run?.state === 'starting' ? 'Iniciando…' : applicationStateLabel(application);
  const stateClass = run?.state === 'ready' || application.reviewState === 'reviewed' ? 'state-ok' : application.reviewState === 'conflict' ? 'state-denied' : 'state-muted';
  return `<article class="workspace-card application-card">
    <div class="card-heading"><div><h3>${escapeHtml(application.name)}</h3><p>${escapeHtml(application.description || 'Aplicación local')}</p></div><span class="state-pill ${stateClass}">${state}</span></div>
    <p><strong>Abre en el navegador:</strong> ${escapeHtml(primary?.alias ?? 'Sin definir')}</p>
    <ol class="service-summary">${application.services.toSorted((a, b) => a.startupOrder - b.startupOrder).map((service) => {
      const workspace = workspaces.find((candidate) => candidate.id === service.workspaceId);
      const live = run?.services.find((candidate) => candidate.service === service.alias);
      return `<li><strong>${escapeHtml(service.alias)}</strong><span>${escapeHtml(workspace?.name ?? 'Proyecto no disponible')} · ${escapeHtml(service.processProfile)}${live?.port === undefined ? '' : ` · puerto ${live.port}`}</span></li>`;
    }).join('')}</ol>
    ${application.reviewState === 'conflict' ? '<p class="risk-note risk-high">Hay definiciones antiguas distintas con el mismo nombre. Edítala para elegir una composición segura.</p>' : ''}
    <div class="actions card-actions">
      ${run === undefined ? `<button type="button" class="primary" data-app-start="${application.id}" ${application.reviewState !== 'reviewed' ? 'disabled' : ''}>Iniciar</button>` : `<button type="button" class="danger" data-app-stop="${application.id}" data-run-id="${run.runId}">Detener</button>`}
      ${application.reviewState !== 'reviewed' ? `<button type="button" data-app-verify="${application.id}" ${application.reviewState === 'conflict' ? 'disabled' : ''}>Probar y aprobar</button>` : ''}
      <button type="button" data-app-edit="${application.id}">${application.reviewState === 'conflict' ? 'Reparar configuración' : 'Editar'}</button>
      <button type="button" class="danger" data-app-delete="${application.id}">Eliminar</button>
    </div>
  </article>`;
}

function wizardPermissionsTable(draft: ApplicationWizardDraft): string {
  const desired = objectivePermissions(draft.objective);
  const ids = [...new Set(draft.selected.map((key) => key.split('|')[0]).filter((id): id is string => id !== undefined))];
  const columns: Array<[keyof WorkspacePermissions, string]> = [['read', 'Leer'], ['write', 'Editar'], ['validations', 'Validar'], ['processes', 'Procesos'], ['browserRead', 'Web'], ['browserInteract', 'Interactuar'], ['browserHumanControl', 'Control humano'], ['gitWrite', 'Git']];
  return `<div class="permission-table" role="region" aria-label="Permisos que tendrá la aplicación" tabindex="0"><div class="permission-table-row permission-table-head" role="row"><span>Proyecto</span>${columns.map(([, label]) => `<span>${label}</span>`).join('')}</div>${ids.map((id) => {
    const workspace = workspaces.find((candidate) => candidate.id === id);
    return `<div class="permission-table-row" role="row"><strong>${escapeHtml(workspace?.name ?? id)}</strong>${columns.map(([key]) => {
      const alreadyAllowed = workspace?.permissions[key] === true;
      const willBeAllowed = alreadyAllowed || desired[key];
      const detail = alreadyAllowed ? 'ya permitido en el proyecto' : desired[key] ? 'se añadirá al guardar' : 'no incluido';
      return `<span title="${PERMISSION_LABELS[key]}: ${detail}">${willBeAllowed ? 'Sí' : '—'}</span>`;
    }).join('')}</div>`;
  }).join('')}</div>`;
}

function applicationWizardHtml(draft: ApplicationWizardDraft): string {
  const candidates = serviceCandidates();
  const steps = ['Identidad', 'Servicios', 'Organizar', 'Acceso', 'Verificar'];
  const busy = applicationWizardBusy !== undefined;
  const disabled = busy ? ' disabled' : '';
  const progress = applicationWizardBusy === 'verify'
    ? '<p class="wizard-progress" role="status" aria-live="polite"><span class="loading-mark" aria-hidden="true"></span><span><strong>Guardando y verificando…</strong> Puede tardar unos segundos mientras se inician los servicios.</span></p>'
    : applicationWizardBusy === 'save'
      ? '<p class="wizard-progress" role="status" aria-live="polite"><span class="loading-mark" aria-hidden="true"></span><span><strong>Guardando…</strong> Espera mientras se aplica la configuración.</span></p>'
      : '';
  let content = '';
  if (draft.step === 1) {
    content = `<label>Nombre de la aplicación<input id="app-name" maxlength="80" required value="${escapeHtml(draft.name)}" placeholder="CIP local" /></label><label>Descripción opcional<textarea id="app-description" rows="3" maxlength="240" placeholder="Frontend y API para desarrollo local">${escapeHtml(draft.description)}</textarea></label>`;
  } else if (draft.step === 2) {
    content = candidates.length === 0
      ? '<div class="empty-state compact-empty"><strong>No hay servicios aprobados</strong><p>Ve a Proyectos, detecta los scripts y guarda al menos un perfil de servidor.</p><button type="button" data-section-target="projects">Ir a Proyectos</button></div>'
      : `<fieldset><legend>Selecciona entre 1 y 8 servicios</legend><div class="candidate-list">${candidates.map((candidate) => `<label class="permission-option"><input type="checkbox" data-app-service="${escapeHtml(candidate.key)}" ${draft.selected.includes(candidate.key) ? 'checked' : ''}/><span><strong>${escapeHtml(candidate.workspace.name)} · ${escapeHtml(candidate.profile)}</strong><small>${escapeHtml(candidate.workspace.rootPath)}</small></span></label>`).join('')}</div></fieldset>`;
  } else if (draft.step === 3) {
    content = `<div class="wizard-help" role="note"><strong>Organiza cómo se iniciará la aplicación</strong><p><b>Abrir en el navegador</b> suele ser el frontend: LocalBridge abrirá únicamente ese servicio para revisar la interfaz. Usa <b>Subir</b> y <b>Bajar</b> para iniciar primero las dependencias, por ejemplo API antes que frontend.</p><p>No necesitas copiar URLs ni puertos de la terminal. LocalBridge comprueba en Windows qué puerto pertenece realmente a cada proceso.</p></div><div class="service-organizer">${draft.selected.map((key, index) => {
      const candidate = candidates.find((item) => item.key === key);
      return `<div class="service-editor"><label class="radio-row"><input type="radio" name="app-primary" data-app-primary="${escapeHtml(key)}" aria-describedby="app-primary-help-${index}" ${draft.primary === key ? 'checked' : ''}/><span><strong>Abrir en el navegador</strong><small id="app-primary-help-${index}">Selecciona uno; normalmente será el frontend.</small></span></label><label>Alias<input data-app-alias="${escapeHtml(key)}" value="${escapeHtml(draft.aliases[key] ?? '')}" maxlength="64" /><small>Nombre corto que verá ChatGPT, por ejemplo frontend o api.</small></label><p>${escapeHtml(candidate?.workspace.name ?? key)} · ${escapeHtml(candidate?.profile ?? '')}</p><div class="actions"><button type="button" data-app-move="up" data-app-key="${escapeHtml(key)}" ${index === 0 ? 'disabled' : ''}>Subir</button><button type="button" data-app-move="down" data-app-key="${escapeHtml(key)}" ${index === draft.selected.length - 1 ? 'disabled' : ''}>Bajar</button></div><label class="checkbox-row network-listener-option"><input type="checkbox" data-app-wildcard="${escapeHtml(key)}" aria-describedby="app-network-help-${index}" ${draft.wildcard[key] ? 'checked' : ''}/><span><strong>Permitir escucha en la red local</strong><small id="app-network-help-${index}">Déjalo apagado para localhost o 127.0.0.1. Actívalo solo si la verificación informa 0.0.0.0 o :: y reconoces esa configuración.</small></span></label></div>`;
    }).join('')}</div>`;
  } else if (draft.step === 4) {
    const options: Array<[AccessObjective, string, string]> = [
      ['review', 'Revisar código', 'Lectura y consulta Git.'],
      ['edit', 'Editar y validar', 'Archivos y validaciones aprobadas.'],
      ['web', 'Ejecutar y revisar la web', 'Servidores, navegador, interacción y control humano exclusivo cuando sea necesario.'],
      ['complete', 'Desarrollo completo con Git', 'Incluye todas las capacidades; commit y push conservan aprobación.'],
    ];
    content = `<div class="wizard-help" role="note"><strong>Elige cuánto podrá hacer ChatGPT</strong><p>Selecciona un solo nivel: cada opción incluye las capacidades de las anteriores. Al guardar se añadirán únicamente los permisos necesarios en todos los proyectos elegidos; los permisos que ya tenían no se reducen.</p><p>Crear commits y publicar con Git conservan su aprobación independiente.</p></div><fieldset><legend>Nivel de acceso</legend><div class="objective-list">${options.map(([value, label, help]) => `<label class="permission-option"><input type="radio" name="app-objective" value="${value}" ${draft.objective === value ? 'checked' : ''}/><span><strong>${label}</strong><small>${help}</small></span></label>`).join('')}</div></fieldset>${wizardPermissionsTable(draft)}<p class="dependency-note">La tabla muestra el acceso resultante. Los cambios se aplicarán solo cuando confirmes el último paso y después podrás revocarlos desde Proyectos.</p>`;
  } else {
    content = `<div class="review-summary"><h4>${escapeHtml(draft.name)}</h4><p>${escapeHtml(draft.description || 'Sin descripción')}</p><p><strong>${draft.selected.length} servicio(s)</strong> · abrir en navegador: ${escapeHtml(draft.aliases[draft.primary] ?? 'pendiente')}</p>${wizardPermissionsTable(draft)}<p class="risk-note risk-${Object.values(draft.wildcard).some(Boolean) ? 'high' : 'low'}">${Object.values(draft.wildcard).some(Boolean) ? 'Uno o más servicios tienen permiso para escuchar en 0.0.0.0 o :: y podrían quedar visibles en la red local. Confirma solo si reconoces esa configuración.' : 'Todos los servicios deben publicar listeners propios y verificables en localhost antes de abrir el navegador.'}</p></div>`;
  }
  return `<div class="form-card application-wizard" aria-busy="${busy}"><div class="workspace-form-heading"><div><p class="eyebrow">Asistente · Paso ${draft.step} de 5</p><h3>${draft.editingId === undefined ? 'Crear aplicación' : `Editar ${escapeHtml(draft.name)}`}</h3></div><button type="button" id="cancel-app-wizard"${disabled}>Cancelar</button></div><ol class="wizard-steps">${steps.map((label, index) => `<li class="${draft.step === index + 1 ? 'current' : draft.step > index + 1 ? 'complete' : ''}"><span>${index + 1}</span>${label}</li>`).join('')}</ol><div class="wizard-content">${content}${progress}<p id="application-form-error" class="error-text" role="alert"></p></div><div class="actions sticky-form-actions">${draft.step > 1 ? `<button type="button" id="app-wizard-back"${disabled}>Atrás</button>` : ''}${draft.step < 5 ? `<button type="button" class="primary" id="app-wizard-next"${disabled}>Continuar</button>` : `<button type="button" class="primary" id="app-wizard-save"${disabled}>${applicationWizardBusy === 'verify' ? 'Guardando y verificando…' : 'Guardar y verificar'}</button><button type="button" id="app-wizard-save-later"${disabled}>${applicationWizardBusy === 'save' ? 'Guardando…' : 'Guardar para revisar después'}</button>`}</div></div>`;
}

function applicationsSectionHtml(): string {
  const error = applicationsError === undefined ? '' : `<div class="empty-state error-state" role="alert"><strong>No se pudieron cargar las aplicaciones</strong><p>${escapeHtml(applicationsError)}</p></div>`;
  if (applicationWizard !== undefined) return `<div class="section-heading"><div><p class="eyebrow">Aplicaciones</p><h2>Configuración guiada</h2><p>Asocia servicios ya aprobados sin editar JSON ni copiar IDs.</p></div></div>${error}${applicationWizardHtml(applicationWizard)}`;
  return `<div class="section-heading"><div><p class="eyebrow">Aplicaciones</p><h2>Entornos locales</h2><p>Inicia frontend, API y otros servicios como una sola unidad.</p></div><button type="button" id="show-app-wizard" class="primary">Crear aplicación</button></div>${error}${applications.length === 0 && applicationsError === undefined ? '<div class="empty-state"><strong>Aún no hay aplicaciones</strong><p>Crea una para poder decir “levanta el proyecto y prueba el login”.</p><button type="button" id="show-app-wizard-empty">Crear mi primera aplicación</button></div>' : `<div class="workspace-grid">${applications.map(applicationCardHtml).join('')}</div>`}`;
}

function approvalLabel(mode: DesktopSettings['gitApprovalMode']): string {
  return mode === 'host' ? 'Cuadro nativo de ChatGPT' : 'MRTR estricto';
}

function connectionSectionHtml(): string {
  const nativeApproval = settingsDraft.gitApprovalMode === 'host';
  const reconnectPending = effectiveGitApprovalMode !== undefined && effectiveGitApprovalMode !== settings.gitApprovalMode;
  const effectiveLabel = effectiveGitApprovalMode === undefined ? 'Se aplicará en la próxima conexión' : approvalLabel(effectiveGitApprovalMode);
  return `
    <div class="section-heading"><div><p class="eyebrow">Conexión</p><h2>ChatGPT y Secure MCP Tunnel</h2><p>Conecta o diagnostica sin usar una terminal.</p></div><span id="tunnel-status" data-tunnel-status class="status-badge status-${tunnelStatus}" role="status">${TUNNEL_STATUS_LABELS[tunnelStatus]}</span></div>
    <div class="connection-grid">
      <div class="surface-card">
        <label>Perfil de conexión<select id="connection-profile">${settingsDraft.connectionProfiles
          .map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === settingsDraft.activeConnectionProfileId ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`)
          .join('')}</select></label>
        <p class="dependency-note">Cada perfil mantiene una clave cifrada y un directorio de túnel separados.</p>
        <form id="settings-form" data-settings-form>
          <label>Confirmación de commit y push
            <select name="gitApprovalMode" aria-describedby="git-approval-help">
              <option value="host" ${nativeApproval ? 'selected' : ''}>Cuadro nativo de ChatGPT</option>
              <option value="mrtr" ${nativeApproval ? '' : 'selected'}>MRTR estricto (cliente compatible)</option>
            </select>
            <small id="git-approval-help" class="field-help">El modo de ChatGPT evita una segunda aprobación incompatible. Se aplica al volver a conectar.</small>
          </label>
          <p class="dependency-note"><strong>Guardado:</strong> ${approvalLabel(settings.gitApprovalMode)} · <strong>Efectivo:</strong> ${effectiveLabel}${reconnectPending ? ' · Reconexión pendiente' : ''}</p>
          ${nativeApproval ? '<p class="risk-note risk-high"><strong>Delegación explícita:</strong> ChatGPT debe mostrar su cuadro antes de llamar a commit o push. LocalBridge no puede comprobar qué botón pulsaste, pero conserva todos los límites del proyecto y las verificaciones exactas de Git.</p>' : '<p class="dependency-note">MRTR exige una confirmación firmada por LocalBridge y es el modo más estricto.</p>'}
          <label>ID público del túnel<input type="text" name="tunnelId" required placeholder="tunnel_…" value="${escapeHtml(settingsDraft.tunnelId)}" aria-describedby="tunnel-id-help tunnel-id-error" autocomplete="off" spellcheck="false" /><small id="tunnel-id-help" class="field-help">Cópialo desde Tunnels. Empieza por tunnel_; no es una clave secreta.</small></label>
          <p id="tunnel-id-error" class="error-text field-error" role="alert"></p>
          <input type="hidden" name="tunnelBinaryPath" value="${escapeHtml(settingsDraft.tunnelBinaryPath)}" />
          <input type="hidden" name="tunnelProfile" value="${escapeHtml(settingsDraft.tunnelProfile)}" />
          <input type="hidden" name="tunnelProfileDir" value="${escapeHtml(settingsDraft.tunnelProfileDir)}" />
          <input type="hidden" name="serverCwd" value="${escapeHtml(settingsDraft.serverCwd)}" />
          <button type="submit">Guardar ID</button>
        </form>
        <label class="api-key-label">Clave secreta de runtime de ${escapeHtml(activeProfile()?.name ?? 'este perfil')}<span class="field-status">${escapeHtml(runtimeKeyStatus())}</span><input type="password" id="api-key" value="${escapeHtml(apiKeyDraft)}" aria-describedby="runtime-key-help runtime-key-error" autocomplete="off" /><small id="runtime-key-help" class="field-help">Puedes dejarla vacía cuando ya existe una clave guardada. No la compartas.</small></label>
        <p id="runtime-key-error" class="error-text field-error" role="alert"></p>
        <label class="permission-option compact-option"><input type="checkbox" id="remember-tunnel-key" ${rememberTunnelKey ? 'checked' : ''}/><span><strong>Recordar en este equipo</strong><small>Después de conectar correctamente, Windows la cifra para este perfil. Desactívalo para usar una clave nueva solo durante esta sesión.</small></span></label>
        <div class="actions">
          <button type="button" id="forget-key" ${tunnelKeyState.status === 'absent' ? 'disabled' : ''}>Olvidar clave</button>
          <button type="button" id="prepare-profile">Preparar perfil</button>
          <button type="button" id="diagnose-tunnel">Diagnosticar</button>
        </div>
        <span id="tunnel-detail" data-tunnel-detail>${tunnelDetail !== undefined ? `<p class="risk-note risk-high">${escapeHtml(tunnelDetail)}</p>` : ''}</span>
        <div class="actions">
          <button type="button" id="connect-tunnel" class="primary" ${tunnelStatus === 'connecting' || tunnelStatus === 'connected' ? 'disabled' : ''}>Conectar</button>
          <button type="button" id="disconnect-tunnel" ${tunnelStatus === 'disconnected' ? 'disabled' : ''}>Desconectar</button>
        </div>
      </div>
      <aside class="surface-card compact-card">
        <h3>Componentes incluidos</h3>
        <p class="runtime-summary">${runtimeInfo === undefined ? 'Comprobando…' : '✓ Runtime autocontenido disponible'}</p>
        <p>Node, el servidor MCP y Secure MCP Tunnel viajan dentro de la aplicación.</p>
        <button type="button" id="run-runtime-check">Probar componentes</button>
        ${runtimeReportHtml()}
      </aside>
    </div>
    ${diagnosticOutput === '' ? '' : `<details class="advanced-panel"><summary>Resultado técnico del diagnóstico</summary><pre id="diagnostic-output" class="log-panel">${escapeHtml(diagnosticOutput)}</pre></details>`}
  `;
}

function runtimeReportHtml(): string {
  if (runtimeReport === undefined) return '<p class="subtitle">Aún no se ejecutó la comprobación.</p>';
  const items: Array<[string, { ok: boolean; detail: string }]> = [
    ['Node privado', runtimeReport.node],
    ['Secure MCP Tunnel', runtimeReport.tunnel],
    ['Salida HTTPS', runtimeReport.connectivity],
    ['Servidor MCP', runtimeReport.server],
  ];
  return `<ul class="check-list">${items
    .map(([label, item]) => `<li class="check-${item.ok ? 'ok' : 'error'}">${item.ok ? '✓' : '×'} ${label}: ${escapeHtml(item.detail)}</li>`)
    .join('')}</ul>`;
}

async function refreshWebState(shouldRender = true): Promise<void> {
  const generation = ++webRefreshGeneration;
  const [profilesResult, activityResult, viewerResult] = await Promise.allSettled([
    window.desktop.getWebProfiles(),
    window.desktop.listWebActivity(),
    window.desktop.getWebLiveViewerState(),
  ]);
  if (generation !== webRefreshGeneration) return;
  let nextTabs: Record<string, readonly WebTabActivitySummary[]> = {};
  if (activityResult.status === 'fulfilled') {
    const visibleSessions = activityResult.value.filter((session) => session.state === 'running' && session.controlState === 'agent_control');
    const tabResults = await Promise.allSettled(visibleSessions.map(async (session) => ({
      sessionId: session.sessionId,
      tabs: await window.desktop.listWebTabs(session.sessionId),
    })));
    if (generation !== webRefreshGeneration) return;
    nextTabs = Object.fromEntries(tabResults.flatMap((result) => result.status === 'fulfilled'
      ? [[result.value.sessionId, result.value.tabs] as const]
      : []));
  }
  if (profilesResult.status === 'fulfilled') {
    webProfiles = profilesResult.value;
    webProfilesError = undefined;
  } else {
    webProfilesError = errorMessage(profilesResult.reason);
  }
  if (activityResult.status === 'fulfilled') {
    webActivity = activityResult.value;
    webTabs = nextTabs;
  } else {
    webTabs = {};
  }
  if (viewerResult.status === 'fulfilled') webLiveViewer = viewerResult.value;
  updateAutomaticActivityDisclosure();
  if (shouldRender) render();
}

function safeWebLocation(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return 'Página web';
  }
}

function viewportPresetsHtml(attributes: string, current: { width: number; height: number; mobile: boolean }): string {
  const presets = [
    { width: 1920, height: 1080, mobile: false, label: '1920×1080' },
    { width: 1440, height: 900, mobile: false, label: '1440×900' },
    { width: 1024, height: 768, mobile: false, label: '1024×768' },
    { width: 390, height: 844, mobile: true, label: '390×844' },
  ];
  return `<div class="actions viewport-presets" aria-label="Viewport renderizado"><span class="dependency-note">Render: ${current.width}×${current.height}${current.mobile ? ' móvil' : ''}</span>${presets.map((preset) => {
    const active = preset.width === current.width && preset.height === current.height && preset.mobile === current.mobile;
    return `<button type="button" ${attributes} data-viewport-width="${preset.width}" data-viewport-height="${preset.height}" data-viewport-mobile="${preset.mobile}" ${active ? 'disabled aria-pressed="true"' : ''}>${preset.label}</button>`;
  }).join('')}</div>`;
}

function webLiveViewerControlsHtml(session: WebActivitySummary): string {
  if (session.controlState !== 'agent_control') return '';
  const tabs = webTabs[session.sessionId] ?? [];
  const isVisible = webLiveViewer.visible && webLiveViewer.sessionId === session.sessionId;
  const status = isVisible
    ? `${webLiveViewer.mode === 'follow' ? 'Siguiendo actividad' : 'Pestaña fijada'} · ${webLiveViewer.pageState === 'action' ? 'ChatGPT actuando' : webLiveViewer.pageState === 'loading' ? 'Cargando' : webLiveViewer.pageState === 'failed' ? 'Carga fallida' : 'En espera'}`
    : 'Visor oculto';
  const connection = tunnelStatus === 'connected' ? 'Cliente conectado' : `Conexión ${TUNNEL_STATUS_LABELS[tunnelStatus].toLocaleLowerCase()}`;
  const tabList = tabs.length === 0
    ? '<p class="dependency-note">Aún no hay pestañas observables.</p>'
    : `<div class="web-tab-list">${tabs.map((tab) => {
      const pinned = isVisible && webLiveViewer.mode === 'pinned' && webLiveViewer.tabId === tab.tabId;
      const motion = tab.motionCapture === undefined ? '' : `<div class="motion-progress" role="status"><span>Capturando movimiento ${tab.motionCapture.completed}/${tab.motionCapture.total}</span><progress max="${tab.motionCapture.total}" value="${tab.motionCapture.completed}"></progress><button type="button" data-web-cancel-motion="${escapeHtml(session.sessionId)}" data-web-tab-id="${escapeHtml(tab.tabId)}">Cancelar captura</button></div>`;
      return `<div class="web-tab-row"><div><strong>${escapeHtml(tab.title || 'Sin título')}</strong><small>${escapeHtml(safeWebLocation(tab.url))} · ${tab.state === 'loading' ? 'cargando' : tab.state === 'failed' ? 'falló' : 'lista'}</small>${motion}${motionReceiptHtml(tab.lastMotionCapture)}${viewportPresetsHtml(`data-web-viewport="${escapeHtml(session.sessionId)}" data-web-tab-id="${escapeHtml(tab.tabId)}"`, tab.viewport ?? { width: 1920, height: 1080, mobile: false })}</div><button type="button" data-web-view-pinned="${escapeHtml(session.sessionId)}" data-web-tab-id="${escapeHtml(tab.tabId)}" ${pinned ? 'disabled aria-pressed="true"' : ''}>${pinned ? 'Fijada' : 'Fijar'}</button></div>`;
    }).join('')}</div>`;
  return `<div class="web-live-viewer-controls"><p class="dependency-note"><strong>Vista en vivo:</strong> ${status} · ${connection}. Solo lectura; los clics y el teclado no llegan a la página.</p>${isVisible ? viewerPresentationHtml('web', session.sessionId, webLiveViewer.presentation) : ''}<div class="actions">${webLiveViewerDisplayPickerHtml(session.sessionId)}<button type="button" class="primary" data-web-view-follow="${escapeHtml(session.sessionId)}" ${isVisible && webLiveViewer.mode === 'follow' ? 'disabled aria-pressed="true"' : ''}>${isVisible && webLiveViewer.mode === 'follow' ? 'Siguiendo' : 'Ver y seguir'}</button>${isVisible ? `<button type="button" data-web-hide-viewer="${escapeHtml(session.sessionId)}">Ocultar visor</button>` : ''}</div>${tabList}</div>`;
}

function webActivityHtml(group: BrowserActivityGroup = 'all', showEmpty = true): string {
  const running = webActivity.filter((session) => session.state === 'running' &&
    (group === 'all' || isInterventionControlState(session.controlState) === (group === 'attention'))).toSorted((left, right) =>
    interventionControlPriority(left.controlState) - interventionControlPriority(right.controlState) || left.startedAt.localeCompare(right.startedAt));
  const closeLabels: Record<NonNullable<WebActivitySummary['closeReason']>, string> = {
    user: 'cerrada por ti', agent: 'cerrada por el cliente', policy: 'cerrada por cambio de autoridad', expired: 'caducada', failed: 'cerrada por fallo',
  };
  const recentlyClosed = webActivity.filter((session) => session.state === 'stopped' && session.closedAt !== undefined)
    .toSorted((left, right) => (right.closedAt ?? '').localeCompare(left.closedAt ?? '')).slice(0, 3);
  const closedHtml = recentlyClosed.length === 0 ? '' : `<details class="advanced-panel"><summary>Sesiones de Internet cerradas recientemente</summary><div class="audit-list">${recentlyClosed.map((session) => `<article class="audit-row"><span class="source-pill">INTERNET</span><div><strong>${escapeHtml(session.profileName)}</strong><p>${escapeHtml(session.closeReason === undefined ? 'cerrada' : closeLabels[session.closeReason])} · ${new Date(session.closedAt ?? '').toLocaleString()}</p></div></article>`).join('')}</div></details>`;
  if (running.length === 0) return `${showEmpty ? '<div class="empty-state compact-empty"><strong>Sin sesiones web activas</strong><p>ChatGPT podrá iniciar una cuando exista un perfil habilitado.</p></div>' : ''}${group === 'attention' ? '' : closedHtml}`;
  return `<div class="audit-list">${running.map((session) => {
    const privateControl = ['waiting_for_human', 'human_control', 'returning_to_agent'].includes(session.controlState);
    const profile = webProfiles.document.profiles.find((candidate) => candidate.id === session.webProfileId);
    const canTakeDirectly = session.profileKind === 'public-research' || profile?.permissions.humanControl === true;
    const selectedTabId = webLiveViewer.sessionId === session.sessionId && webLiveViewer.tabId !== undefined
      ? webLiveViewer.tabId
      : webTabs[session.sessionId]?.[0]?.tabId;
    const takeButton = session.controlState === 'agent_control' && canTakeDirectly
      ? `<button type="button" class="primary" data-web-take="${session.sessionId}"${selectedTabId === undefined ? '' : ` data-web-tab-id="${escapeHtml(selectedTabId)}"`}>Tomar control</button>`
      : '';
    const waitingActions = session.controlState === 'waiting_for_human'
      ? `<button type="button" class="primary" data-web-take="${session.sessionId}">Tomar control</button><button type="button" data-web-decline="${session.sessionId}">Cancelar</button>`
      : '';
    const humanActions = session.controlState === 'human_control'
      ? `${session.tabCount > 1 ? `<button type="button" data-web-cycle="previous" data-web-session-id="${session.sessionId}" aria-label="Pestaña web anterior">←</button><button type="button" data-web-cycle="next" data-web-session-id="${session.sessionId}" aria-label="Pestaña web siguiente">→</button>` : ''}<button type="button" class="primary" data-web-return="${session.sessionId}">Devolver a ChatGPT</button><button type="button" data-web-decline="${session.sessionId}">Cancelar sesión</button>`
      : '';
    const delegated = session.delegatedSite === undefined ? '' : `<p class="dependency-note">Acceso temporal: ${escapeHtml(session.delegatedSite)} · hasta ${new Date(session.delegatedExpiresAt ?? '').toLocaleTimeString()}</p>`;
    return `<article class="audit-row web-activity-row"><span class="source-pill">INTERNET</span><div class="web-activity-body"><strong>${escapeHtml(session.profileName)}</strong><p>${session.tabCount} pestaña(s) · ${new Date(session.startedAt).toLocaleString()} · ${privateControl ? 'ChatGPT pausado' : 'Control de ChatGPT'}</p>${privateControl ? '<p class="risk-note risk-high">Ventana privada: ChatGPT no puede observar ni actuar.</p>' : webLiveViewerControlsHtml(session)}${delegated}${session.controlState === 'agent_control' && !canTakeDirectly ? '<p class="dependency-note">Activa el control privado para este acceso en Configuración.</p>' : ''}</div><div class="actions">${takeButton}${waitingActions}${humanActions}${session.controlState === 'returning_to_agent' ? '<button type="button" disabled>Devolviendo…</button>' : ''}<button type="button" class="danger" data-web-stop="${session.sessionId}" title="Cierra esta sesión aislada y sus pestañas">Cerrar sesión y borrar estado</button></div></article>`;
  }).join('')}</div>${group === 'attention' ? '' : closedHtml}`;
}

function webProfileCardHtml(profile: WebProfile): string {
  const scope = profile.kind === 'public-research'
    ? 'Cualquier sitio HTTPS público; bloquea redes locales, cuentas y campos sensibles.'
    : `Destinos: ${profile.destinations.map((rule) => `${rule.includeSubdomains ? '*.' : ''}${rule.hostname}`).join(', ')}`;
  const activeSessions = webActivity.filter((session) => session.webProfileId === profile.id && session.state === 'running').length;
  const perAssetOptions = [25, 50, 100, 250, 500, 1024].map((mib) => {
    const bytes = mib * 1024 * 1024;
    return `<option value="${bytes}" ${profile.limits.maxDownloadBytes === bytes ? 'selected' : ''}>${mib} MiB${mib === 1024 ? ' · recomendado' : ''}</option>`;
  }).join('');
  const totalOptions = [1, 2, 5, 10].map((gib) => {
    const bytes = gib * 1024 * 1024 * 1024;
    return `<option value="${bytes}" ${profile.limits.maxTotalDownloadBytes === bytes ? 'selected' : ''}>${gib} GiB${gib === 10 ? ' · recomendado' : ''}</option>`;
  }).join('');
  // A legacy snapshot can briefly be visible while the main process migrates
  // the registry. Preserve its fixed-limit behavior instead of failing render.
  const adaptiveTransfer = profile.limits.transferPolicy?.mode === 'adaptive';
  return `<article class="workspace-card"><div class="card-heading"><div><h3>${escapeHtml(profile.name)}</h3><p>${escapeHtml(scope)}</p></div><span class="state-pill ${profile.enabled ? 'state-ok' : 'state-muted'}">${profile.enabled ? 'Habilitado' : 'Deshabilitado'}</span></div>
    <p><strong>Almacenamiento:</strong> efímero · <strong>Sesiones:</strong> ${activeSessions}/${profile.limits.maxSessions} · <strong>Pestañas:</strong> hasta ${profile.limits.maxTabsPerSession}</p>
    <label>Transferencias grandes<select data-web-transfer-policy data-web-profile="${profile.id}"><option value="fixed" ${adaptiveTransfer ? '' : 'selected'}>Límites fijos</option><option value="adaptive" ${adaptiveTransfer ? 'selected' : ''}>Sin límite fijo · streaming</option></select><small>El modo adaptativo conserva la reserva de disco del proyecto y no cambia dominios ni permisos.</small></label>
    <div class="permission-grid compact-permissions"><label>Máximo por asset<select data-web-limit="maxDownloadBytes" data-web-profile="${profile.id}" ${adaptiveTransfer ? 'disabled' : ''}>${perAssetOptions}</select><small>Se aplica en modo fijo; no usa el límite de archivos de código.</small></label><label>Máximo acumulado por sesión<select data-web-limit="maxTotalDownloadBytes" data-web-profile="${profile.id}" ${adaptiveTransfer ? 'disabled' : ''}>${totalOptions}</select><small>Se aplica en modo fijo.</small></label></div>
    ${profile.kind === 'site-account' && profile.supportHosts.length > 0 ? `<p><strong>Hosts auxiliares:</strong> ${escapeHtml(profile.supportHosts.map((rule) => rule.hostname).join(', '))}</p>` : ''}
    <div class="permission-grid compact-permissions">
      <label class="permission-option"><input type="checkbox" data-web-permission="interact" data-web-profile="${profile.id}" ${profile.permissions.interact ? 'checked' : ''}/><span><strong>Interactuar</strong><small>Clics y campos comunes no sensibles.</small></span></label>
      <label class="permission-option"><input type="checkbox" data-web-permission="download" data-web-profile="${profile.id}" ${profile.permissions.download ? 'checked' : ''}/><span><strong>Descargar</strong><small>Documentos y medios observados hacia carpetas con escritura.</small></span></label>
      ${profile.kind === 'site-account' ? `<label class="permission-option"><input type="checkbox" data-web-permission="humanControl" data-web-profile="${profile.id}" ${profile.permissions.humanControl ? 'checked' : ''}/><span><strong>Inicio de sesión privado</strong><small>Pausa toda observación de ChatGPT.</small></span></label>` : ''}
    </div>
    <div class="actions"><button type="button" class="${profile.enabled ? '' : 'primary'}" data-web-toggle="${profile.id}">${profile.enabled ? 'Deshabilitar y cerrar sesiones' : 'Habilitar acceso'}</button><button type="button" data-web-save="${profile.id}">Guardar configuración</button><button type="button" class="danger" data-web-remove="${profile.id}">Eliminar</button></div>
  </article>`;
}

function webSectionHtml(): string {
  const stateNotice = webProfiles.state === 'corrupt'
    ? `<div class="empty-state error-state" role="alert"><strong>El registro web está corrupto y el acceso está bloqueado</strong><p>Ningún sitio está disponible. Restablecer elimina solo estos perfiles; no toca carpetas ni proyectos.</p>${webProfiles.sha256 === null ? '' : '<button type="button" id="reset-web-profiles" class="danger">Restablecer perfiles web</button>'}</div>`
    : '';
  const cards = webProfiles.document.profiles.map(webProfileCardHtml).join('');
  const publicEnabled = webProfiles.document.profiles.some((profile) => profile.kind === 'public-research' && profile.enabled);
  const publicProfile = webProfiles.document.profiles.find((profile) => profile.kind === 'public-research');
  return `<div class="section-heading"><div><p class="eyebrow">Configuración</p><h2>Acceso a Internet</h2><p>Habilita la navegación aislada una vez. Las sesiones y la toma de control aparecen en Actividad. No usa tu Chrome personal ni controla aplicaciones de Windows.</p></div></div>
    ${webProfilesError === undefined ? '' : `<div class="empty-state error-state"><strong>No se pudo cargar el acceso web</strong><p>${escapeHtml(webProfilesError)}</p></div>`}
    ${stateNotice}
    ${webProfiles.state !== 'corrupt' ? `<div class="surface-card quick-web-setup"><div><h3>${publicEnabled ? 'Navegación por Internet habilitada' : 'Habilitar navegación por Internet'}</h3><p>Permite investigar e interactuar con sitios HTTPS públicos en una sesión aislada. Puedes tomar el control desde Actividad.</p>${publicEnabled ? '' : `<label class="compact-check"><input type="checkbox" id="enable-web-download" ${publicProfile?.permissions.download === true ? 'checked' : ''}/> Permitir descargas de documentos y medios hacia carpetas con escritura</label>`}</div>${publicEnabled ? '<span class="state-pill state-ok">Lista</span>' : `<button type="button" id="enable-web-browsing" class="primary" ${publicProfile === undefined && webProfiles.document.profiles.length >= 20 ? 'disabled' : ''}>Habilitar</button>`}</div>` : ''}
    <div class="surface-card trust-summary"><h3>Frontera de red</h3><p>Solo HTTPS por un proxy local que valida DNS y la IP real. Loopback, LAN, link-local, metadata, IPs literales, HTTP y puertos alternativos se bloquean.</p><p><strong>Windows:</strong> LocalBridge no requiere conexiones entrantes desde redes privadas o públicas. Si el Firewall de Windows solicita ese acceso, puedes denegarlo; el proxy escucha únicamente en 127.0.0.1.</p><p>El texto y las capturas que ChatGPT solicita viajan al cliente MCP conectado. Cookies y credenciales permanecen en la sesión efímera.</p></div>
    <details class="advanced-panel" ${cards === '' ? 'open' : ''}><summary>Accesos guardados y opciones avanzadas</summary>
      ${cards === '' && webProfiles.state !== 'corrupt' ? '<div class="empty-state compact-empty"><strong>Sin accesos guardados</strong><p>La configuración rápida creará el acceso público cuando lo habilites.</p></div>' : `<div class="workspace-grid">${cards}</div>`}
      <div class="actions"><button type="button" id="add-public-web-profile" ${webProfiles.state === 'corrupt' || webProfiles.document.profiles.length >= 20 ? 'disabled' : ''}>Añadir acceso público manual</button></div>
      <form id="create-account-web-profile" class="surface-card"><div class="card-heading"><div><h3>Sitio con cuenta</h3><p>Limita navegación a dominios elegidos. El inicio de sesión se hace con control humano privado.</p></div></div><label>Nombre<input name="name" maxlength="80" required placeholder="Portal de trabajo" /></label><label>Dominios navegables<textarea name="destinations" rows="3" required placeholder="example.com&#10;login.example.com"></textarea><small>Un dominio por línea, sin https:// ni rutas. Incluye subdominios.</small></label><label>Hosts auxiliares opcionales<textarea name="supportHosts" rows="2" placeholder="static.examplecdn.com"></textarea><small>Pueden cargar recursos, pero ChatGPT no puede navegar directamente a ellos.</small></label><button type="submit" ${webProfiles.state === 'corrupt' || webProfiles.document.profiles.length >= 20 ? 'disabled' : ''}>Crear borrador deshabilitado</button><p id="web-profile-form-error" class="error-text"></p></form>
    </details>`;
}

function dashboardHtml(): string {
  const enabled = workspaces.filter((workspace) => workspace.enabled).length;
  const problem = tunnelStatus === 'error' ? tunnelDetail : lastProblem;
  return `
    <div class="welcome-row"><div><p class="eyebrow">Inicio</p><h2>${tunnelStatus === 'connected' ? 'LocalBridge está listo' : 'Control de acceso local'}</h2><p>Revisa de un vistazo qué está conectado y qué carpetas están autorizadas.</p></div><div class="brand-mark" aria-hidden="true"><span></span></div></div>
    <div class="metric-grid">
      <button type="button" class="metric-card" data-section-target="connection"><span>Conexión</span><strong data-tunnel-status class="status-text-${tunnelStatus}">${TUNNEL_STATUS_LABELS[tunnelStatus]}</strong><small>${tunnelStatus === 'connected' ? 'ChatGPT puede llamar las tools autorizadas.' : 'Abre Conexión para revisar o conectar.'}</small></button>
      <button type="button" class="metric-card" data-section-target="projects"><span>Proyectos activos</span><strong>${enabled}</strong><small>${workspaces.length === 0 ? 'Ninguna carpeta disponible.' : `${workspaces.length} configurado(s) en total.`}</small></button>
      <button type="button" class="metric-card" data-section-target="applications"><span>Aplicaciones</span><strong>${applications.length}</strong><small>${applications.filter((application) => application.reviewState === 'reviewed').length} lista(s) para iniciar.</small></button>
      <button type="button" class="metric-card" data-section-target="web"><span>Acceso web</span><strong>${webProfiles.document.profiles.filter((profile) => profile.enabled).length}</strong><small>${webProfiles.state === 'corrupt' ? 'Bloqueado por configuración corrupta.' : `${webActivity.filter((session) => session.state === 'running').length} sesión(es) activa(s).`}</small></button>
      <button type="button" class="metric-card" data-section-target="activity"><span>Actividad en curso</span><strong>${developmentActivity.processes.length + developmentActivity.browsers.length + developmentActivity.applications.length + (developmentActivity.terminals?.length ?? 0) + activeAnalysisJobCount() + webActivity.filter((session) => session.state === 'running').length}</strong><small>Sesiones, navegadores, trabajos y recursos activos.</small></button>
    </div>
    <div data-pending-approvals>${pendingApprovalsHtml()}</div>
    <section class="attention-card ${problem === undefined ? 'attention-ok' : 'attention-error'}">
      <div><p class="eyebrow">Atención</p><h3>${problem === undefined ? 'Sin problemas pendientes' : 'Hay algo que revisar'}</h3><p>${problem === undefined ? 'La configuración no reporta errores accionables.' : escapeHtml(problem)}</p></div>
      ${problem === undefined ? '' : '<button type="button" data-section-target="connection">Revisar conexión</button>'}
    </section>
    ${workspaces.length === 0 ? '<div class="empty-state"><strong>Autoriza tu primer proyecto</strong><p>Hasta entonces, ningún cliente puede acceder a carpetas locales.</p><button type="button" data-section-target="projects">Ir a Proyectos</button></div>' : ''}
  `;
}

function filteredLogs(): string[] {
  const query = logFilter.trim().toLocaleLowerCase();
  return query === '' ? tunnelLogs : tunnelLogs.filter((line) => line.toLocaleLowerCase().includes(query));
}

function activityLogHtml(): string {
  const visible = filteredLogs();
  return visible.length === 0
    ? `<div class="empty-state compact-empty"><strong>${tunnelLogs.length === 0 ? 'Sin actividad todavía' : 'Ningún evento coincide'}</strong><p>${tunnelLogs.length === 0 ? 'Los eventos del túnel aparecerán aquí.' : 'Prueba con otro término de búsqueda.'}</p></div>`
    : `<pre id="tunnel-log" class="log-panel" tabindex="0">${visible.map((line) => escapeHtml(line)).join('\n')}</pre>`;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  'workspace.list': 'Listó proyectos',
  'workspace.tree': 'Exploró archivos',
  'workspace.search': 'Buscó contenido',
  'file.read': 'Leyó un archivo',
  'file.create': 'Creó un archivo',
  'file.write_guarded': 'Editó un archivo',
  'file.move': 'Movió un archivo',
  'file.delete': 'Eliminó un archivo',
  'git.status': 'Consultó Git',
  'git.diff': 'Consultó cambios Git',
  'git.commit': 'Creó un commit',
  'git.push': 'Publicó commits',
  'validation.run': 'Ejecutó una validación',
  'terminal.start': 'Inició una terminal',
  'terminal.list': 'Consultó terminales activas',
  'terminal.write': 'Envió entrada a una terminal; resultado pendiente de verificar',
  'terminal.read': 'Leyó la salida de una terminal',
  'terminal.status': 'Verificó el estado de una terminal',
  'terminal.stop': 'Detuvo una terminal',
  'process.start': 'Inició un servidor aprobado',
  'process.list': 'Consultó procesos activos',
  'process.listeners': 'Detectó puertos verificados',
  'process.logs': 'Consultó logs de un proceso',
  'process.stop': 'Detuvo un proceso',
  'browser.start': 'Abrió una sesión web aislada',
  'browser.list': 'Consultó sesiones web',
  'browser.navigate': 'Navegó en la web local',
  'browser.snapshot': 'Leyó la interfaz web',
  'browser.screenshot': 'Capturó la web local',
  'browser.screenshot.save': 'Guardó una captura de la web local',
  'browser.motion.inspect': 'Inspeccionó movimiento en la web local',
  'browser.motion.capture': 'Guardó una traza de movimiento local',
  'browser.motion.diagnostic': 'Diagnosticó una captura temporal local',
  'browser.viewport': 'Cambió el viewport de la web local',
  'browser.events': 'Consultó eventos web',
  'browser.click': 'Hizo clic en la web local',
  'browser.fill': 'Completó un campo no sensible',
  'browser.press': 'Pulsó una tecla permitida',
  'browser.human.request': 'Solicitó control humano',
  'browser.human.status': 'Consultó el estado del control humano',
  'browser.human.open': 'Entregó el navegador al usuario',
  'browser.human.handoff': 'Devolvió el navegador a ChatGPT',
  'browser.human.decline': 'Canceló y destruyó el control humano',
  'browser.human.expire': 'Caducó el control humano',
  'browser.human.revoke': 'Revocó el control humano',
  'browser.stop': 'Cerró una sesión web',
  'document.read': 'Extrajo texto y clasificó páginas de un PDF',
  'document.render': 'Renderizó páginas de un PDF para ChatGPT',
  'image.read': 'Entregó una imagen local a ChatGPT',
  'web.profiles': 'Consultó perfiles de Internet',
  'web.start': 'Abrió un navegador de Internet',
  'web.list': 'Consultó navegadores de Internet',
  'web.stop': 'Cerró un navegador de Internet',
  'web.tabs': 'Consultó pestañas de Internet',
  'web.open': 'Abrió una pestaña de Internet',
  'web.close': 'Cerró una pestaña de Internet',
  'web.navigate': 'Navegó por Internet',
  'web.navigate.diagnostic': 'Diagnosticó una navegación de Internet',
  'web.back': 'Volvió en una pestaña de Internet',
  'web.snapshot': 'Leyó controles de una página externa',
  'web.screenshot': 'Capturó una página externa',
  'web.screenshot.save': 'Guardó una captura externa',
  'web.motion.inspect': 'Inspeccionó movimiento en una página externa',
  'web.motion.capture': 'Guardó una traza de movimiento externa',
  'web.motion.diagnostic': 'Diagnosticó una captura temporal externa',
  'web.extract': 'Extrajo texto y fuentes web',
  'web.assets': 'Enumeró medios y recursos web',
  'web.viewport': 'Cambió el viewport de Internet',
  'web.download': 'Guardó y verificó un recurso web',
  'web.screenshot.diagnostic': 'Diagnosticó una captura web sin registrar contenido',
  'web.screenshot.save.diagnostic': 'Diagnosticó el guardado de una captura web',
  'web.click': 'Hizo clic en una página externa',
  'web.fill': 'Completó un campo web común',
  'web.select': 'Eligió una opción web',
  'web.scroll': 'Desplazó una página externa',
  'web.press': 'Pulsó una tecla web permitida',
  'web.wait': 'Esperó una condición web',
  'web.human.request': 'Solicitó control web privado',
  'web.human.status': 'Consultó control web privado',
  'web.human.open': 'Entregó una web al usuario',
  'web.human.handoff': 'Devolvió una web a ChatGPT',
  'web.human.decline': 'Canceló control web privado',
  'web.human.expire': 'Caducó control web privado',
  'visual.compare': 'Comparó dos capturas visuales',
  'visual.motion.compare': 'Comparó dos trazas de movimiento',
  'project.create': 'Creó un proyecto asistido',
  'project.adopt': 'Agrupó configuración existente',
  'project.refresh': 'Actualizó el análisis del proyecto',
  'project.remove': 'Eliminó un desarrollo y sus accesos',
  'project.topology.scan': 'Detectó la topología del proyecto',
  'project.state.ready': 'El proyecto quedó listo para operar',
  'project.state.review': 'El proyecto pasó a revisión local',
  'project.state.unavailable': 'El proyecto quedó no disponible',
  'project.state.conflict': 'El proyecto quedó en conflicto',
  'project.setup.plan': 'Preparó una propuesta local',
  'project.setup.execute': 'Ejecutó una preparación aprobada',
  'project.setup.cancel': 'Canceló una preparación',
  'project.setup.finalize': 'Finalizó perfiles y aplicación',
  'terminal.local.open': 'Abrió un servicio en su navegador',
  'terminal.local.copy': 'Copió una dirección verificada',
  'terminal.local.stop': 'Detuvo una terminal local',
};

const TERMINAL_STATE_LABELS: Record<NonNullable<DevelopmentActivity['terminals']>[number]['state'], string> = {
  running: 'En ejecución',
  exited: 'Finalizada',
  stopped: 'Detenida',
  revoked: 'Revocada',
  timed_out: 'Tiempo agotado',
};

const ANALYSIS_STATE_LABELS: Record<NonNullable<DevelopmentActivity['jobs']>[number]['state'], string> = {
  queued: 'En cola', running: 'Analizando', waiting_resource: 'Esperando recursos', cancel_requested: 'Cancelando',
  cancelled: 'Cancelado', completed: 'Completado', failed: 'Falló', source_changed: 'Fuente cambiada', interrupted: 'Interrumpido',
};

const TASK_BATCH_STATE_LABELS: Record<NonNullable<DevelopmentActivity['taskBatches']>[number]['state'], string> = {
  queued: 'En cola', running: 'Trabajando', cancel_requested: 'Cancelando', cancelled: 'Cancelado',
  completed: 'Completado', partial: 'Resultado parcial', failed: 'Falló', interrupted: 'Interrumpido',
};

const TASK_CHILD_STATE_LABELS: Record<NonNullable<DevelopmentActivity['taskBatches']>[number]['children'][number]['state'], string> = {
  admitted: 'Admitido', waiting_dependency: 'Esperando otro paso', waiting_resource: 'Esperando recursos',
  running: 'Trabajando', cancel_requested: 'Cancelando', cancelled: 'Cancelado', completed: 'Completado',
  failed: 'Falló', skipped_dependency: 'Omitido por dependencia', interrupted: 'Interrumpido',
};

function taskWaitReason(child: NonNullable<DevelopmentActivity['taskBatches']>[number]['children'][number]): string {
  if (child.state === 'waiting_dependency') return 'Espera que terminen los pasos de los que depende.';
  if (child.state === 'waiting_resource') return child.operationKind === 'validation.run'
    ? 'Espera que termine otra validación incompatible del proyecto.'
    : 'Espera una plaza de análisis disponible.';
  if (child.state === 'skipped_dependency') return 'No se ejecutó porque falló o se canceló un paso previo.';
  if (child.resultExpired) return 'El contenido retenido caducó; el recibo permanece disponible.';
  return '';
}

function formatAnalysisProgress(job: NonNullable<DevelopmentActivity['jobs']>[number]): string {
  if (job.progress.unit === 'bytes') {
    const completed = formatBytes(job.progress.completed);
    return job.progress.total === undefined ? completed : `${completed} de ${formatBytes(job.progress.total)}`;
  }
  return job.progress.total === undefined
    ? `${job.progress.completed} ${job.progress.unit}`
    : `${job.progress.completed} de ${job.progress.total} ${job.progress.unit}`;
}

function activeAnalysisJobCount(): number {
  const batched = new Set((developmentActivity.taskBatches ?? []).flatMap((batch) =>
    batch.children.flatMap((child) => child.analysisJobId ?? [])));
  const standalone = (developmentActivity.jobs ?? []).filter((job) => !batched.has(job.jobId) &&
    ['queued', 'running', 'waiting_resource', 'cancel_requested'].includes(job.state)).length;
  const coordinated = (developmentActivity.taskBatches ?? []).flatMap((batch) => batch.children)
    .filter((child) => ['admitted', 'waiting_dependency', 'waiting_resource', 'running', 'cancel_requested'].includes(child.state)).length;
  return standalone + coordinated;
}

function taskBatchRowsHtml(): string[] {
  return (developmentActivity.taskBatches ?? []).map((batch) => {
    const workspace = workspaces.find((candidate) => candidate.id === batch.workspaceId);
    const activeBatch = ['queued', 'running', 'cancel_requested'].includes(batch.state);
    const batchClass = batch.state === 'completed' ? 'state-ok'
      : ['failed', 'interrupted'].includes(batch.state) ? 'state-denied'
        : batch.state === 'partial' ? 'state-warning' : '';
    const disclosureKey = `batch:${batch.batchId}`;
    const panelId = activityDomId('activity-batch', batch.batchId);
    const expanded = activityItemExpanded(disclosureKey, activeBatch);
    const children = batch.children.map((child) => {
      const active = ['admitted', 'waiting_dependency', 'waiting_resource', 'running', 'cancel_requested'].includes(child.state);
      const stateClass = child.state === 'completed' ? 'state-ok'
        : ['failed', 'interrupted', 'skipped_dependency'].includes(child.state) ? 'state-denied' : '';
      const reason = taskWaitReason(child);
      const timing = `admisión ${Math.round(child.timing.admissionMs)} ms · dependencias ${Math.round(child.timing.dependencyWaitMs)} ms · cola ${Math.round(child.timing.capacityWaitMs)} ms · lock ${Math.round(child.timing.lockWaitMs)}/${Math.round(child.timing.lockHoldMs)} ms · ejecución ${Math.round(child.timing.executionMs)} ms · persistencia ${Math.round(child.timing.persistenceMs)} ms`;
      return `<li class="task-child-row"><div><strong>${escapeHtml(child.localId)} · ${escapeHtml(child.operationKind)}</strong><span>${escapeHtml(child.sourcePath ?? 'perfil revisado')} · ${escapeHtml(reason || child.stage)}</span><details><summary>Detalles técnicos y cobertura</summary><code>${escapeHtml(timing)} · cobertura ${escapeHtml(child.coverage)} · efecto ${escapeHtml(child.effectState)}${child.errorCode === undefined ? '' : ` · ${escapeHtml(child.errorCode)}`}</code></details></div><div class="actions"><span class="state-pill ${stateClass}">${TASK_CHILD_STATE_LABELS[child.state]}</span>${active ? `<button type="button" class="danger" data-task-cancel="${escapeHtml(batch.batchId)}" data-task-child="${escapeHtml(child.localId)}" data-workspace-id="${escapeHtml(batch.workspaceId)}">Cancelar paso</button>` : ''}</div></li>`;
    }).join('');
    return `<li class="runtime-item task-batch-row"><div class="runtime-heading"><div><span class="source-pill">LOTE</span><strong>${escapeHtml(workspace?.name ?? batch.workspaceId)}</strong><span>${batch.children.length} paso(s) · actualización ${new Date(batch.updatedAt).toLocaleTimeString()}</span></div><div class="actions"><span class="state-pill ${batchClass}">${TASK_BATCH_STATE_LABELS[batch.state]}</span>${activeBatch ? `<button type="button" class="danger" data-task-cancel="${escapeHtml(batch.batchId)}" data-workspace-id="${escapeHtml(batch.workspaceId)}">Cancelar lote</button>` : ''}<button type="button" class="disclosure-toggle compact-disclosure-toggle" data-activity-item-toggle="${escapeHtml(disclosureKey)}" aria-expanded="${expanded}" aria-controls="${panelId}">${expanded ? 'Ocultar pasos' : 'Mostrar pasos'}</button></div></div><div id="${panelId}" ${expanded ? '' : 'hidden'}><ul class="task-child-list">${children}</ul></div></li>`;
  });
}

function developmentActivityHtml(kind: 'all' | 'browsers' | 'resources' = 'all', group: BrowserActivityGroup = 'all'): string {
  const browserEntries = developmentActivity.browsers.filter((entry) => entry.state === 'running' &&
    (group === 'all' || isInterventionControlState(entry.controlState) === (group === 'attention')));
  const browserCount = browserEntries.length;
  const resourceCount = developmentActivity.processes.length + developmentActivity.applications.length + (developmentActivity.terminals?.length ?? 0) + activeAnalysisJobCount();
  const activeCount = kind === 'browsers' ? browserCount : kind === 'resources' ? resourceCount : browserCount + resourceCount;
  const analysisUnavailable = kind !== 'browsers' && developmentActivity.analysisAvailability?.available === false;
  const analysisNotice = analysisUnavailable
    ? '<div class="attention-card attention-error"><div><strong>Análisis de artefactos no disponible</strong><p>El almacén durable necesita reparación. Terminal, Git, navegador y lecturas pequeñas siguen disponibles.</p></div></div>'
    : '';
  const taskBatchNotice = kind !== 'browsers' && developmentActivity.taskBatchAvailability?.available === false
    ? '<div class="attention-card attention-error"><div><strong>Lotes coordinados no disponibles</strong><p>El almacén de lotes necesita reparación. Las herramientas individuales, terminal, Git y navegador siguen disponibles.</p></div></div>'
    : '';
  const availabilityEntries = kind === 'browsers' ? [] : developmentActivity.availability ?? [];
  const availabilityNotice = availabilityEntries.length === 0 ? '' : `<details class="availability-summary"><summary>Disponibilidad autorizada de proyectos</summary><ul class="readiness-list">${availabilityEntries.map((entry) => {
    const proposal = entry.detectedProposal.state === 'none'
      ? 'sin propuesta detectada pendiente'
      : entry.detectedProposal.state === 'detected-awaiting-review'
        ? `propuesta detectada pendiente: ${entry.detectedProposal.processes} servidor(es), ${entry.detectedProposal.validations} validación(es)`
        : entry.detectedProposal.state === 'applying'
          ? 'preparación guiada en curso'
          : 'propuesta detectada inactiva; vuelve a analizar para usarla';
    return `<li><strong>${escapeHtml(entry.projectName)}</strong><span>${entry.terminalAvailable ? 'Terminal autorizada disponible independientemente de los perfiles' : 'Terminal general no disponible'} · perfiles revisados disponibles: ${entry.reviewed.processes} servidor(es), ${entry.reviewed.validations} validación(es), ${entry.reviewed.browser} navegador(es) · ${escapeHtml(proposal)}</span></li>`;
  }).join('')}</ul><p class="dependency-note">Una propuesta detectada no es un perfil revisado y no se ejecuta hasta su revisión local.</p></details>`;
  if (activeCount === 0 && group === 'all' && !analysisUnavailable) {
    return `${taskBatchNotice}${availabilityNotice}<div class="empty-state compact-empty"><strong>${kind === 'browsers' ? 'Sin navegadores locales activos' : kind === 'resources' ? 'Sin recursos de desarrollo activos' : 'Sin entornos activos'}</strong><p>Los recursos iniciados por ChatGPT aparecerán aquí.</p></div>`;
  }
  if (activeCount === 0) return `${analysisNotice}${taskBatchNotice}${availabilityNotice}`;
  const terminalGroups = new Map<string, Array<NonNullable<DevelopmentActivity['terminals']>[number]>>();
  for (const terminal of developmentActivity.terminals ?? []) {
    const terminalGroup = terminalGroups.get(terminal.projectId) ?? [];
    terminalGroup.push(terminal);
    terminalGroups.set(terminal.projectId, terminalGroup);
  }
  const batchedAnalysisJobIds = new Set((developmentActivity.taskBatches ?? []).flatMap((batch) =>
    batch.children.flatMap((child) => child.analysisJobId ?? [])));
  const rows = [
    ...(kind === 'browsers' ? [] : taskBatchRowsHtml()),
    ...(kind === 'browsers' ? [] : (developmentActivity.jobs ?? []).filter((job) => !batchedAnalysisJobIds.has(job.jobId)).map((job) => {
      const workspace = workspaces.find((candidate) => candidate.id === job.workspaceId);
      const active = ['queued', 'running', 'waiting_resource', 'cancel_requested'].includes(job.state);
      const stateClass = job.state === 'completed' ? 'state-ok' : job.state === 'failed' || job.state === 'source_changed' || job.state === 'interrupted' ? 'state-denied' : '';
      const progress = formatAnalysisProgress(job);
      const coverage = job.coverage.sourceBytes === undefined ? '' : ` · ${formatBytes(job.coverage.uniqueBytesRead)} únicos de ${formatBytes(job.coverage.sourceBytes)}`;
      const effect = job.effectState === 'uncertain'
        ? ' · El efecto pudo aplicarse; revísalo antes de repetir'
        : job.effectState === 'applied' ? ' · Efecto aplicado' : '';
      const recovery = job.state === 'interrupted' && job.resumeCapability === 'restart'
        ? ' · Puede iniciarse otra vez con una nueva intención'
        : '';
      return `<li class="runtime-item analysis-job-row"><div class="runtime-heading"><div><span class="source-pill">TRABAJO</span><strong>${escapeHtml(job.operationKind)}</strong><span>${escapeHtml(workspace?.name ?? job.workspaceId)} · ${escapeHtml(job.sourcePath ?? 'recurso web')} · ${escapeHtml(job.stage)}</span><small>${escapeHtml(progress)}${escapeHtml(coverage)}${job.errorCode === undefined ? '' : ` · ${escapeHtml(job.errorCode)}`}${escapeHtml(effect)}${escapeHtml(recovery)}</small></div><div class="actions"><span class="state-pill ${stateClass}">${ANALYSIS_STATE_LABELS[job.state]}</span>${active ? `<button type="button" class="danger" data-analysis-cancel="${escapeHtml(job.jobId)}" data-workspace-id="${escapeHtml(job.workspaceId)}">Cancelar</button>` : ''}</div></div></li>`;
    })),
    ...(kind === 'browsers' ? [] : [...terminalGroups.values()].map((entries) => {
      const project = entries[0];
      if (project === undefined) return '';
      const disclosureKey = `project:${project.projectId}`;
      const panelId = activityDomId('activity-project', project.projectId);
      const expanded = activityItemExpanded(disclosureKey, true);
      const terminals = entries.map((entry, index) => {
        const listenerRows = entry.listeners.length === 0
          ? '<p class="runtime-empty">Iniciada; esperando un puerto verificado.</p>'
          : `<ul class="runtime-listeners">${entry.listeners.map((listener) => {
            const safe = listener.exclusive;
            const network = listener.bindScope === 'wildcard' ? '<span class="state-pill state-warning">Escucha en todas las redes</span><small class="risk-note risk-high">Usa 127.0.0.1 o ::1 si solo necesitas abrirlo en este equipo.</small>' : '';
            const conflict = safe ? '' : '<span class="state-pill state-denied">Puerto no exclusivo</span>';
            return `<li class="runtime-listener"><div><strong>Servicio HTTP · puerto ${listener.port}</strong><code>${escapeHtml(listener.browserOrigin)}</code><div class="runtime-badges"><span class="state-pill state-ok">Verificado</span>${network}${conflict}</div></div><div class="actions runtime-actions"><button type="button" data-terminal-open="${escapeHtml(entry.sessionId)}" data-project-id="${escapeHtml(entry.projectId)}" data-listener-ref="${escapeHtml(listener.listenerRef)}" ${safe ? '' : 'disabled'}>Abrir en mi navegador</button><button type="button" data-terminal-copy="${escapeHtml(entry.sessionId)}" data-project-id="${escapeHtml(entry.projectId)}" data-listener-ref="${escapeHtml(listener.listenerRef)}" ${safe ? '' : 'disabled'}>Copiar dirección</button></div></li>`;
          }).join('')}</ul>`;
        return `<section class="runtime-terminal"><div class="runtime-heading"><div><strong>Terminal ${index + 1}</strong><span>${entry.trustMode === 'full-host' ? 'Control total' : 'Agente en proyecto'} · desde ${new Date(entry.startedAt).toLocaleTimeString()}</span></div><span class="state-pill state-ok">${TERMINAL_STATE_LABELS[entry.state]}</span></div>${listenerRows}<div class="runtime-footer"><details><summary>Detalles técnicos</summary><code>${escapeHtml(entry.projectId)} · ${escapeHtml(entry.sessionId)}</code></details><button type="button" class="danger" data-terminal-stop="${escapeHtml(entry.sessionId)}" data-project-id="${escapeHtml(entry.projectId)}">Detener terminal</button></div></section>`;
      }).join('');
      return `<li class="runtime-item runtime-project"><div class="runtime-heading runtime-project-heading"><div><strong>${escapeHtml(project.projectName)}</strong><span>${entries.length} terminal(es) activa(s)</span></div><div class="actions"><span class="state-pill state-ok">En ejecución</span><button type="button" class="disclosure-toggle compact-disclosure-toggle" data-activity-item-toggle="${escapeHtml(disclosureKey)}" aria-expanded="${expanded}" aria-controls="${panelId}">${expanded ? 'Ocultar terminales' : 'Mostrar terminales'}</button></div></div><div id="${panelId}" class="runtime-project-panel" ${expanded ? '' : 'hidden'}><div class="runtime-terminal-list">${terminals}</div><p class="dependency-note">“Abrir en mi navegador” crea una ventana local fuera del control de ChatGPT. El puerto se vuelve a verificar antes de abrirla.</p></div></li>`;
    })),
    ...(kind === 'browsers' ? [] : developmentActivity.applications.map((entry) => `<li><strong>Aplicación · ${escapeHtml(entry.applicationName)}</strong><span>${entry.services.filter((service) => service.state === 'ready').length}/${entry.services.length} servicios listos · ${escapeHtml(entry.state)}</span></li>`)),
    ...(kind === 'browsers' ? [] : developmentActivity.processes.map((entry) => {
      const workspace = workspaces.find((candidate) => candidate.id === entry.workspaceId);
      const listeners = entry.listeners.length === 0
        ? 'sin puerto loopback detectado'
        : entry.listeners.map((listener) => `${escapeHtml(listener.origin)}${listener.bindScope === 'wildcard' ? ' · wildcard administrado' : ''}${listener.exclusive ? '' : ' · conflicto detectado'}`).join(', ');
      return `<li><strong>Servidor · ${escapeHtml(entry.profile)}</strong><span>${escapeHtml(workspace?.name ?? entry.workspaceId)} · ${listeners} · desde ${new Date(entry.startedAt).toLocaleTimeString()}</span></li>`;
    })),
    ...(kind === 'resources' ? [] : browserEntries.toSorted((left, right) =>
      interventionControlPriority(left.controlState) - interventionControlPriority(right.controlState) || left.startedAt.localeCompare(right.startedAt)).map((entry) => {
      const workspace = workspaces.find((candidate) => candidate.id === entry.workspaceId);
      const agentOwns = entry.controlState === 'agent_control';
      const waitingForHuman = entry.controlState === 'waiting_for_human';
      const liveViewerOpen = developmentActivity.liveViewerSessionId === entry.sessionId;
      const actions = `<div class="actions">
        ${agentOwns ? liveViewerDisplayPickerHtml(entry.sessionId) : ''}
        ${agentOwns && !liveViewerOpen ? `<button type="button" data-view-browser="${entry.sessionId}">Visor ligero</button><button type="button" data-show-live-browser="${entry.sessionId}">Abrir ventana en vivo</button>` : ''}
        ${agentOwns && liveViewerOpen ? `<button type="button" data-hide-live-browser="${entry.sessionId}">Ocultar ventana en vivo</button>` : ''}
        ${(agentOwns || waitingForHuman) && workspace?.permissions.browserHumanControl === true ? `<button type="button" class="primary" data-human-take="${entry.sessionId}">Tomar control</button>` : ''}
        ${waitingForHuman ? `<button type="button" class="danger" data-human-decline="${entry.sessionId}">Cancelar</button>` : ''}
        ${agentOwns && entry.postHumanExpiresAt !== undefined ? `<button type="button" class="danger" data-human-revoke="${entry.sessionId}">Revocar y destruir</button>` : ''}
      </div>`;
      const reason = entry.humanReason === 'sign_in' ? 'inicio de sesión' : entry.humanReason === 'file_selection' ? 'selección de archivo' : 'paso local';
      const state = waitingForHuman
        ? `ChatGPT necesita tu intervención: ${reason}`
        : entry.controlState === 'human_control' || entry.controlState === 'returning_to_agent'
          ? 'Tú tienes el control; ChatGPT está completamente excluido'
          : entry.postHumanExpiresAt !== undefined ? 'ChatGPT retomó el control tras tu intervención' : 'ChatGPT controla';
      const liveViewerState = liveViewerOpen ? ' · ventana en vivo abierta' : '';
      const viewportControls = agentOwns ? viewportPresetsHtml(`data-browser-viewport="${escapeHtml(entry.sessionId)}" data-workspace-id="${escapeHtml(entry.workspaceId)}"`, entry.viewport ?? { width: 1920, height: 1080, mobile: false }) : '';
      const motion = entry.motionCapture === undefined ? '' : `<div class="motion-progress" role="status"><span>Capturando movimiento ${entry.motionCapture.completed}/${entry.motionCapture.total}</span><progress max="${entry.motionCapture.total}" value="${entry.motionCapture.completed}"></progress><button type="button" data-browser-cancel-motion="${escapeHtml(entry.sessionId)}">Cancelar captura</button></div>`;
      const presentation = liveViewerOpen ? viewerPresentationHtml('browser', entry.sessionId, entry.viewerPresentation) : '';
      return `<li class="browser-activity-row"><div><span class="source-pill">LOCAL</span><strong>Navegador · ${escapeHtml(entry.profile)}</strong></div><span>${escapeHtml(workspace?.name ?? entry.workspaceId)} · ${escapeHtml(entry.path)} · ${state}${liveViewerState}</span>${motion}${motionReceiptHtml(entry.lastMotionCapture)}${presentation}${viewportControls}${actions}</li>`;
    })),
  ];
  return `${analysisNotice}${taskBatchNotice}${availabilityNotice}<ul class="readiness-list">${rows.join('')}</ul>`;
}

function bindDevelopmentHumanControlActions(): void {
  bindActivityItemDisclosureActions();
  document.querySelectorAll<HTMLButtonElement>('[data-task-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      const workspaceId = button.dataset['workspaceId'] ?? '';
      const batchId = button.dataset['taskCancel'] ?? '';
      const localId = button.dataset['taskChild'];
      void withBusyButton(button, 'Cancelando…', () => window.desktop.cancelTaskBatch(workspaceId, batchId, localId))
        .then(() => refreshDevelopmentActivity())
        .catch((error) => showFeedback('error', `No se pudo cancelar: ${errorMessage(error)}`));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-analysis-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      const workspaceId = button.dataset['workspaceId'] ?? '';
      const jobId = button.dataset['analysisCancel'] ?? '';
      void withBusyButton(button, 'Cancelando…', () => window.desktop.cancelAnalysisJob(workspaceId, jobId))
        .then(() => refreshDevelopmentActivity())
        .catch((error) => showFeedback('error', `No se pudo cancelar el trabajo: ${errorMessage(error)}`));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-browser-viewport]').forEach((button) => button.addEventListener('click', () => {
    const workspaceId = button.dataset['workspaceId'];
    const sessionId = button.dataset['browserViewport'];
    const width = Number(button.dataset['viewportWidth']);
    const height = Number(button.dataset['viewportHeight']);
    const mobile = button.dataset['viewportMobile'] === 'true';
    if (workspaceId === undefined || sessionId === undefined || !Number.isInteger(width) || !Number.isInteger(height)) return;
    void withBusyButton(button, 'Aplicando…', () => window.desktop.setBrowserViewport(workspaceId, sessionId, width, height, mobile))
      .then(() => refreshDevelopmentActivity())
      .catch((error) => showFeedback('error', `No se pudo cambiar el viewport local: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-terminal-open]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      void withBusyButton(button, 'Abriendo…', () => window.desktop.openTerminalListener(
        button.dataset['projectId'] ?? '',
        button.dataset['terminalOpen'] ?? '',
        button.dataset['listenerRef'] ?? '',
      )).then(() => showFeedback('success', 'El servicio se abrió en tu navegador. Esa ventana queda fuera del control de ChatGPT.'))
        .catch((error) => showFeedback('error', `No se pudo abrir el servicio: ${errorMessage(error)}`));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-terminal-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      void withBusyButton(button, 'Copiando…', () => window.desktop.copyTerminalListener(
        button.dataset['projectId'] ?? '',
        button.dataset['terminalCopy'] ?? '',
        button.dataset['listenerRef'] ?? '',
      )).then(() => showFeedback('success', 'Dirección verificada copiada.'))
        .catch((error) => showFeedback('error', `No se pudo copiar la dirección: ${errorMessage(error)}`));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-terminal-stop]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      void withBusyButton(button, 'Deteniendo…', () => window.desktop.stopTerminal(button.dataset['projectId'] ?? '', button.dataset['terminalStop'] ?? ''))
        .then(async () => {
          await refreshDevelopmentActivity();
          showFeedback('success', 'La terminal se detuvo correctamente.');
        })
        .catch((error) => showFeedback('error', `No se pudo detener la terminal: ${errorMessage(error)}`));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-human-take]').forEach((button) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Entregando control…';
      stopBrowserViewer();
      void window.desktop.takeBrowserHumanControl(button.dataset['humanTake'] ?? '')
        .then(() => refreshDevelopmentActivity())
        .catch((error) => {
          button.disabled = false;
          button.textContent = 'Tomar control';
          showFeedback('error', `No se pudo entregar el control: ${errorMessage(error)}`);
        });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-human-decline]').forEach((button) => {
    button.addEventListener('click', () => void window.desktop.declineBrowserHumanControl(button.dataset['humanDecline'] ?? '')
      .then(() => refreshDevelopmentActivity())
      .catch((error) => showFeedback('error', `No se pudo cancelar la solicitud: ${errorMessage(error)}`)));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-human-revoke]').forEach((button) => {
    button.addEventListener('click', () => void window.desktop.revokeBrowserHumanControl(button.dataset['humanRevoke'] ?? '')
      .then(() => refreshDevelopmentActivity())
      .catch((error) => showFeedback('error', `No se pudo revocar la sesión: ${errorMessage(error)}`)));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-view-browser]').forEach((button) => {
    button.addEventListener('click', () => { void openBrowserViewer(button.dataset['viewBrowser'] ?? ''); });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-show-live-browser]').forEach((button) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Abriendo…';
      const sessionId = button.dataset['showLiveBrowser'] ?? '';
      const displayId = document.querySelector<HTMLSelectElement>(`[data-live-display="${sessionId}"]`)?.value ?? selectedLiveViewerDisplayId(sessionId);
      if (displayId !== undefined) rememberLiveViewerDisplayId(displayId);
      stopBrowserViewer();
      void window.desktop.showBrowserLiveViewer(sessionId, displayId, rememberedViewerPresentationMode())
        .then(async () => {
          await refreshDevelopmentActivity();
          if (activeSection === 'activity') render();
        })
        .catch((error) => {
          button.disabled = false;
          button.textContent = 'Abrir ventana en vivo';
          showFeedback('error', `No se pudo abrir la ventana en vivo: ${errorMessage(error)}`);
        });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-hide-live-browser]').forEach((button) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Ocultando…';
      void window.desktop.hideBrowserLiveViewer(button.dataset['hideLiveBrowser'] ?? '')
        .then(async () => {
          await refreshDevelopmentActivity();
          if (activeSection === 'activity') render();
        })
        .catch((error) => {
          button.disabled = false;
          button.textContent = 'Ocultar ventana en vivo';
          showFeedback('error', `No se pudo ocultar la ventana en vivo: ${errorMessage(error)}`);
        });
    });
  });
  document.querySelectorAll<HTMLSelectElement>('[data-live-display]').forEach((select) => {
    select.addEventListener('change', () => {
      const sessionId = select.dataset['liveDisplay'] ?? '';
      const displayId = select.value;
      rememberLiveViewerDisplayId(displayId);
      if (developmentActivity.liveViewerSessionId !== sessionId) return;
      select.disabled = true;
      void window.desktop.moveBrowserLiveViewer(sessionId, displayId)
        .then(() => refreshDevelopmentActivity())
        .catch((error) => {
          select.disabled = false;
          showFeedback('error', `No se pudo mover la ventana en vivo: ${errorMessage(error)}`);
        });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-viewer-presentation="browser"]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = button.dataset['sessionId'];
      const mode = button.dataset['mode'];
      const panX = Number(button.dataset['panX']);
      const panY = Number(button.dataset['panY']);
      if (sessionId === undefined || (mode !== 'fit' && mode !== 'actual') || !Number.isInteger(panX) || !Number.isInteger(panY)) return;
      rememberViewerPresentationMode(mode);
      void withBusyButton(button, 'Aplicando…', () => window.desktop.setBrowserLiveViewerPresentation(sessionId, mode, panX, panY))
        .then(() => refreshDevelopmentActivity())
        .catch((error) => showFeedback('error', `No se pudo ajustar el visor: ${errorMessage(error)}`));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-browser-cancel-motion]').forEach((button) => {
    button.addEventListener('click', () => void withBusyButton(button, 'Cancelando…', () => window.desktop.cancelBrowserMotion(button.dataset['browserCancelMotion'] ?? ''))
      .then(() => refreshDevelopmentActivity())
      .catch((error) => showFeedback('error', `No se pudo cancelar la captura: ${errorMessage(error)}`)));
  });
}

function browserViewerHtml(): string {
  if (browserViewerSessionId === undefined) return '';
  return `<div class="browser-viewer-backdrop" role="dialog" aria-modal="true" aria-labelledby="browser-viewer-title">
    <section class="browser-viewer">
      <div class="card-heading"><div><p class="eyebrow">Solo lectura</p><h3 id="browser-viewer-title">Visor ligero</h3><p id="browser-viewer-path">Preparando vista segura…</p></div><div class="actions"><button type="button" data-show-live-browser="${browserViewerSessionId}">Abrir ventana en vivo</button><button type="button" id="close-browser-viewer">Ocultar</button></div></div>
      <div class="browser-viewer-stage" id="browser-viewer-stage" aria-live="polite">
        <p id="browser-viewer-message">Capturando la sesión aislada…</p>
        <img id="browser-viewer-image" alt="Vista actual del navegador controlado por ChatGPT" hidden />
      </div>
      <p class="dependency-note">Este visor no acepta clics, teclado, arrastre ni archivos. La imagen se reemplaza en memoria y no se guarda.</p>
    </section>
  </div>`;
}

function stopBrowserViewer(): void {
  if (browserViewerTimer !== undefined) window.clearInterval(browserViewerTimer);
  browserViewerTimer = undefined;
  browserViewerCaptureInFlight = false;
  const image = document.querySelector<HTMLImageElement>('#browser-viewer-image');
  if (image !== null) image.src = '';
  browserViewerSessionId = undefined;
}

async function refreshBrowserViewer(): Promise<void> {
  const sessionId = browserViewerSessionId;
  if (sessionId === undefined || browserViewerCaptureInFlight) return;
  browserViewerCaptureInFlight = true;
  try {
    const frame = await window.desktop.captureBrowserViewer(sessionId);
    if (browserViewerSessionId !== sessionId) return;
    const image = document.querySelector<HTMLImageElement>('#browser-viewer-image');
    const message = document.querySelector<HTMLParagraphElement>('#browser-viewer-message');
    const path = document.querySelector<HTMLParagraphElement>('#browser-viewer-path');
    if (path !== null) path.textContent = frame.path;
    if (frame.state === 'ready') {
      if (image !== null) {
        image.src = frame.dataUrl;
        image.hidden = false;
      }
      if (message !== null) message.textContent = 'ChatGPT controla esta sesión. El visor no puede interactuar.';
    } else {
      if (image !== null) {
        image.src = '';
        image.hidden = true;
      }
      if (message !== null) message.textContent = frame.state === 'private'
        ? 'Vista protegida: el usuario tiene el control y ChatGPT está pausado.'
        : 'La sesión terminó. Puedes cerrar este visor.';
    }
  } catch (error) {
    const message = document.querySelector<HTMLParagraphElement>('#browser-viewer-message');
    if (message !== null) message.textContent = `No se pudo actualizar el visor: ${errorMessage(error)}`;
  } finally {
    browserViewerCaptureInFlight = false;
  }
}

async function openBrowserViewer(sessionId: string): Promise<void> {
  if (!/^session_[a-f0-9]{24}$/.test(sessionId)) return;
  if (developmentActivity.liveViewerSessionId === sessionId) {
    try {
      await window.desktop.hideBrowserLiveViewer(sessionId);
      await refreshDevelopmentActivity();
    } catch (error) {
      showFeedback('error', `No se pudo cambiar al visor ligero: ${errorMessage(error)}`);
      return;
    }
  }
  stopBrowserViewer();
  browserViewerSessionId = sessionId;
  render();
  document.querySelector<HTMLButtonElement>('#close-browser-viewer')?.focus();
  void refreshBrowserViewer();
  browserViewerTimer = window.setInterval(() => { void refreshBrowserViewer(); }, 1_000);
}

function pendingApprovalsHtml(): string {
  if (pendingApprovals.length === 0) return '';
  const items = pendingApprovals
    .map((approval) => {
      const workspace = workspaces.find((candidate) => candidate.id === approval.workspaceId);
      const action = approval.action === 'git.commit' ? 'Crear commit' : 'Publicar cambios';
      return `<li><strong>${action}</strong><span>${escapeHtml(workspace?.name ?? approval.workspaceId)} · vence ${new Date(approval.expiresAt).toLocaleTimeString()}</span></li>`;
    })
    .join('');
  return `<section class="approval-waiting" role="status" aria-live="polite"><div class="approval-waiting-icon" aria-hidden="true">…</div><div><p class="eyebrow">Git protegido</p><h3>Esperando confirmación del cliente MCP</h3><p>La conexión efectiva usa MRTR. Confirma en la interfaz del cliente que originó la llamada; si no ofrece ese paso, selecciona el modo nativo compatible y vuelve a conectar.</p><ul>${items}</ul></div></section>`;
}

function auditEventsHtml(): string {
  if (auditLoading) return '<div class="empty-state compact-empty" aria-busy="true"><strong>Cargando auditoría…</strong></div>';
  if (auditEvents.length === 0) return '<div class="empty-state compact-empty"><strong>Sin eventos para estos filtros</strong><p>La auditoría aparecerá cuando un cliente use las tools.</p></div>';
  const diagnosticFilter = auditFilters.action?.endsWith('.diagnostic') === true;
  const diagnostics = new Map<string, AuditEvent[]>();
  if (!diagnosticFilter) {
    for (const event of auditEvents) {
      if (!event.action.endsWith('.diagnostic') || event.operationId === undefined) continue;
      const key = `${event.operationId}:${event.action.slice(0, -'.diagnostic'.length)}`;
      diagnostics.set(key, [...(diagnostics.get(key) ?? []), event]);
    }
  }
  const operations = auditEvents.filter((event) => {
    if (diagnosticFilter || !event.action.endsWith('.diagnostic')) return true;
    if (event.outcome === 'success') return false;
    if (event.operationId === undefined) return true;
    return !auditEvents.some((candidate) => candidate.operationId === event.operationId &&
      candidate.action === event.action.slice(0, -'.diagnostic'.length));
  });
  const recoveryFor = (event: AuditEvent): boolean => event.outcome === 'success' && event.operationId !== undefined &&
    (diagnostics.get(`${event.operationId}:${event.action}`) ?? []).some((diagnostic) =>
      diagnostic.outcome === 'success' && diagnostic.resource?.endsWith(':recovered') === true);
  const failedOperations = operations.filter((event) => event.outcome === 'error').length;
  const recoveredOperations = operations.filter(recoveryFor).length;
  const diagnosticCount = auditEvents.filter((event) => event.action.endsWith('.diagnostic')).length;
  const visible = operations.slice(0, auditVisibleCount);
  const remaining = Math.max(operations.length - visible.length, 0);
  const summary = `<div class="audit-summary" aria-label="Resumen de auditoría"><span><strong>${operations.length}</strong> operaciones</span><span><strong>${failedOperations}</strong> fallos reales</span><span><strong>${recoveredOperations}</strong> recuperadas</span><span><strong>${diagnosticCount}</strong> detalles</span></div>`;
  return `${summary}<div class="audit-list">${visible
    .map((event) => {
      const workspace = workspaces.find((candidate) => candidate.id === event.workspaceId);
      const related = event.operationId === undefined ? [] : diagnostics.get(`${event.operationId}:${event.action}`) ?? [];
      const recovered = recoveryFor(event);
      const detail = related.length === 0 ? '' : `<details class="audit-diagnostics"><summary>${related.length} detalle(s) técnico(s)</summary>${related.map((diagnostic) => `<p>${escapeHtml(AUDIT_ACTION_LABELS[diagnostic.action] ?? diagnostic.action)}${diagnostic.errorCode === undefined ? '' : ` · ${escapeHtml(diagnostic.errorCode)}`}${diagnostic.resource === undefined ? '' : ` · ${escapeHtml(diagnostic.resource)}`}</p>`).join('')}</details>`;
      const status = event.decision === 'deny' ? 'Denegado' : recovered ? 'Recuperado' : event.outcome === 'success' ? 'Permitido' : 'Falló';
      return `<article class="audit-row"><span class="audit-icon audit-${event.outcome}">${event.outcome === 'success' ? '✓' : '×'}</span><div><strong>${escapeHtml(AUDIT_ACTION_LABELS[event.action] ?? event.action)}</strong><p>${escapeHtml(workspace?.name ?? event.workspaceId ?? 'Sistema')} · ${new Date(event.timestamp).toLocaleString()}${event.resource === undefined ? '' : ` · ${escapeHtml(event.resource)}`}${event.errorCode === undefined ? '' : ` · ${escapeHtml(event.errorCode)}`}</p>${detail}</div><span class="state-pill ${event.decision === 'deny' ? 'state-denied' : ''}">${status}</span></article>`;
    })
    .join('')}</div>${remaining === 0 ? '' : `<button type="button" id="audit-show-more">Ver ${Math.min(20, remaining)} eventos más</button>`}`;
}

function documentCoverageHtml(): string {
  const relevant = documentAuditEvents.filter((event) =>
    event.action === 'web.download' || event.action === 'document.read' || event.action === 'document.render' || event.action === 'image.read');
  if (relevant.length === 0) {
    return '<div class="empty-state compact-empty"><strong>Sin documentos procesados todavía</strong><p>Cuando ChatGPT lea PDF o imágenes, aquí verás la cobertura real sin mostrar su contenido.</p></div>';
  }
  const files = new Map<string, {
    workspaceId?: string;
    path: string;
    downloaded: boolean;
    text: boolean;
    image: boolean;
    pages: Set<number>;
    textPages: Set<number>;
    totalPages?: number;
    sha256Prefix?: string;
    mode?: 'text' | 'mixed' | 'visual';
    warnings: Set<string>;
    failures: number;
  }>();
  for (const event of relevant) {
    if (event.resource === undefined) continue;
    const rawPath = event.action === 'web.download'
      ? event.resource.split(':').slice(2, -2).join(':')
      : event.resource;
    const metadataSeparator = rawPath.lastIndexOf('#');
    const metadataCandidate = metadataSeparator < 0 ? '' : rawPath.slice(metadataSeparator + 1);
    const hasCoverageMetadata = /^(?:textPages|pages|image)=/.test(metadataCandidate);
    const path = hasCoverageMetadata ? rawPath.slice(0, metadataSeparator) : rawPath;
    const metadataText = hasCoverageMetadata ? metadataCandidate : '';
    const metadata = new Map(metadataText.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      return separator < 1 ? [] : [[part.slice(0, separator), part.slice(separator + 1)] as const];
    }));
    const key = `${event.workspaceId ?? ''}:${path}`;
    const current = files.get(key) ?? {
      ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
      path, downloaded: false, text: false, image: false, pages: new Set<number>(), textPages: new Set<number>(),
      warnings: new Set<string>(), failures: 0,
    };
    if (event.outcome === 'error') current.failures += 1;
    else if (event.action === 'web.download') current.downloaded = true;
    else if (event.action === 'document.read') {
      current.text = true;
      for (const page of metadata.get('textPages')?.split(',') ?? []) {
        const parsed = Number(page);
        if (Number.isInteger(parsed) && parsed > 0) current.textPages.add(parsed);
      }
      const mode = metadata.get('mode');
      if (mode === 'text' || mode === 'mixed' || mode === 'visual') current.mode = mode;
    } else if (event.action === 'image.read') current.image = true;
    else {
      for (const page of metadata.get('pages')?.split(',') ?? []) {
        const parsed = Number(page);
        if (Number.isInteger(parsed) && parsed > 0) current.pages.add(parsed);
      }
    }
    const totalPages = Number(metadata.get('total'));
    if (Number.isInteger(totalPages) && totalPages > 0) current.totalPages = totalPages;
    const sha256Prefix = metadata.get('sha');
    if (sha256Prefix !== undefined && /^[a-f0-9]{12}$/.test(sha256Prefix)) current.sha256Prefix = sha256Prefix;
    for (const warning of metadata.get('warnings')?.split(',') ?? []) {
      if (warning !== '' && warning !== 'none') current.warnings.add(warning);
    }
    files.set(key, current);
  }
  const entries = [...files.values()];
  const textFiles = entries.filter((entry) => entry.text).length;
  const downloadedFiles = entries.filter((entry) => entry.downloaded).length;
  const visualFiles = entries.filter((entry) => entry.image || entry.pages.size > 0).length;
  const renderedPages = entries.reduce((total, entry) => total + entry.pages.size, 0);
  const failures = entries.reduce((total, entry) => total + entry.failures, 0);
  const summary = `<div class="document-summary" aria-label="Cobertura documental"><span><strong>${entries.length}</strong> archivo(s)</span><span><strong>${downloadedFiles}</strong> descargado(s)</span><span><strong>${textFiles}</strong> con texto</span><span><strong>${visualFiles}</strong> visual(es)</span><span><strong>${renderedPages}</strong> página(s) preparadas</span><span><strong>${failures}</strong> fallo(s)</span></div>`;
  const rows = entries.slice(0, 30).map((entry) => {
    const workspace = workspaces.find((candidate) => candidate.id === entry.workspaceId);
    const stages = [
      entry.downloaded ? 'descargado' : '',
      entry.text ? `${entry.textPages.size || ''}${entry.textPages.size > 0 ? ' página(s) con ' : ''}texto extraído` : '',
      entry.pages.size > 0 ? `${entry.pages.size}${entry.totalPages === undefined ? '' : `/${entry.totalPages}`} página(s) renderizada(s)` : '',
      entry.image ? 'imagen preparada para ChatGPT' : '',
      entry.mode === undefined ? '' : `modo ${entry.mode}`,
      entry.sha256Prefix === undefined ? '' : `SHA-256 ${entry.sha256Prefix}…`,
      entry.warnings.size === 0 ? '' : `${entry.warnings.size} aviso(s)`,
    ].filter(Boolean).join(' · ');
    return `<article class="document-coverage-row"><span class="audit-icon ${entry.failures > 0 ? 'audit-error' : 'audit-success'}">${entry.failures > 0 ? '×' : '✓'}</span><div><strong>${escapeHtml(entry.path)}</strong><p>${escapeHtml(workspace?.name ?? entry.workspaceId ?? 'Proyecto')} · ${escapeHtml(stages || 'sin etapa completada')}${entry.failures === 0 ? '' : ` · ${entry.failures} fallo(s)`}</p></div><span class="state-pill ${entry.failures > 0 ? 'state-denied' : ''}">${entry.failures > 0 ? 'Revisar' : 'Preparado'}</span></article>`;
  }).join('');
  return `${summary}<div class="audit-list document-coverage-list">${rows}</div>`;
}

function bindAuditListActions(): void {
  const button = document.querySelector<HTMLButtonElement>('#audit-show-more');
  if (button === null || button.dataset['bound'] === 'true') return;
  button.dataset['bound'] = 'true';
  button.addEventListener('click', () => {
    auditVisibleCount += 20;
    const container = document.querySelector<HTMLDivElement>('#audit-events');
    if (container !== null) container.innerHTML = auditEventsHtml();
    bindAuditListActions();
  });
}

function activityCounts(): { browsers: number; resources: number; active: number; attention: number } {
  const browsers = developmentActivity.browsers.filter((entry) => entry.state === 'running').length +
    webActivity.filter((entry) => entry.state === 'running').length;
  const resources = developmentActivity.processes.length + developmentActivity.applications.length +
    (developmentActivity.terminals?.length ?? 0) + activeAnalysisJobCount();
  const attention = developmentActivity.browsers.filter((entry) => entry.state === 'running' &&
    ['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)).length +
    webActivity.filter((entry) => entry.state === 'running' &&
      ['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)).length;
  return { browsers, resources, active: browsers + resources, attention };
}

function activityAttentionHtml(): string {
  const { attention } = activityCounts();
  if (attention === 0) return '';
  return `<div class="attention-card attention-error activity-intervention" role="status"><div><strong>${attention} navegador(es) requieren tu intervención</strong><p>ChatGPT está pausado en esas sesiones. Este aviso permanece visible aunque contraigas la actividad.</p></div><button type="button" data-activity-filter="browsers">Ver intervención</button></div>`;
}

function activityRuntimeHtml(): string {
  const { browsers: browserCount } = activityCounts();
  const browserContent = browserCount === 0
    ? `<div class="empty-state compact-empty"><strong>Sin navegadores activos</strong><p>Los navegadores iniciados por ChatGPT aparecerán aquí.</p></div>${webActivityHtml('regular', false)}`
    : `${developmentActivityHtml('browsers', 'attention')}${webActivityHtml('attention', false)}${developmentActivityHtml('browsers', 'regular')}${webActivityHtml('regular', false)}`;
  if (activityFilter === 'browsers') return browserContent;
  if (activityFilter === 'resources') return developmentActivityHtml('resources');
  return `<div class="activity-group"><h3>Navegadores</h3>${browserContent}</div><div class="activity-group"><h3>Recursos de desarrollo</h3>${developmentActivityHtml('resources')}</div>`;
}

function activityDisclosureToggleHtml(section: ActivitySectionId, panelId: string): string {
  const expanded = activityDisclosureState[section];
  return `<button type="button" id="activity-toggle-${section}" class="disclosure-toggle" data-activity-section-toggle="${section}" aria-expanded="${expanded}" aria-controls="${panelId}"><span aria-hidden="true" class="disclosure-chevron">${expanded ? '▾' : '▸'}</span>${expanded ? 'Ocultar' : 'Mostrar'}</button>`;
}

function pruneActivityExpandedItems(): void {
  const valid = new Set<string>([
    ...(developmentActivity.taskBatches ?? []).map((batch) => `batch:${batch.batchId}`),
    ...new Set((developmentActivity.terminals ?? []).map((terminal) => `project:${terminal.projectId}`)),
  ]);
  for (const key of activityExpandedItems.keys()) {
    if (!valid.has(key)) activityExpandedItems.delete(key);
  }
}

function updateAutomaticActivityDisclosure(): void {
  if (!activityDisclosureCustomized) activityDisclosureState.runtime = activityCounts().active > 0;
}

function bindActivityDisclosureActions(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-activity-section-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset['activitySectionToggle'];
      if (section !== 'runtime' && section !== 'technicalLog' && section !== 'documents' && section !== 'audit') return;
      activityDisclosureState = { ...activityDisclosureState, [section]: !activityDisclosureState[section] };
      saveActivityDisclosureState();
      render();
      document.querySelector<HTMLButtonElement>(`#activity-toggle-${section}`)?.focus();
    });
  });
  document.querySelector<HTMLButtonElement>('#activity-collapse-all')?.addEventListener('click', () => {
    activityDisclosureState = { runtime: false, technicalLog: false, documents: false, audit: false };
    for (const key of activityExpandedItems.keys()) activityExpandedItems.set(key, false);
    saveActivityDisclosureState();
    render();
    document.querySelector<HTMLButtonElement>('#activity-collapse-all')?.focus();
  });
  document.querySelector<HTMLButtonElement>('#activity-show-active')?.addEventListener('click', () => {
    const activeBatchIds = new Set((developmentActivity.taskBatches ?? [])
      .filter((batch) => ['queued', 'running', 'cancel_requested'].includes(batch.state))
      .map((batch) => `batch:${batch.batchId}`));
    for (const key of activityExpandedItems.keys()) activityExpandedItems.set(key, key.startsWith('project:') || activeBatchIds.has(key));
    activityDisclosureState = { runtime: activityCounts().active > 0, technicalLog: false, documents: false, audit: false };
    saveActivityDisclosureState();
    render();
    document.querySelector<HTMLButtonElement>('#activity-show-active')?.focus();
  });
}

function bindActivityItemDisclosureActions(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-activity-item-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset['activityItemToggle'];
      const panelId = button.getAttribute('aria-controls');
      if (key === undefined || panelId === null) return;
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      activityExpandedItems.set(key, expanded);
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = key.startsWith('project:')
        ? expanded ? 'Ocultar terminales' : 'Mostrar terminales'
        : expanded ? 'Ocultar pasos' : 'Mostrar pasos';
      const panel = document.getElementById(panelId);
      if (panel !== null) panel.hidden = !expanded;
    });
  });
}

function activitySectionHtml(): string {
  const counts = activityCounts();
  const stoppableCount = developmentActivity.processes.length + developmentActivity.applications.length +
    (developmentActivity.terminals?.length ?? 0) + developmentActivity.browsers.length;
  return `
    <div class="section-heading activity-page-heading"><div><p class="eyebrow">Actividad</p><h2>Actividad en curso</h2><p>Observa y controla navegadores locales o de Internet sin cambiar de sección.</p></div><div class="actions"><span class="state-pill">${counts.active} activo(s)</span><button type="button" id="activity-collapse-all">Contraer todo</button><button type="button" id="activity-show-active">Mostrar activos</button></div></div>
    <div data-pending-approvals>${pendingApprovalsHtml()}</div>
    ${activityAttentionHtml()}
    <div class="surface-card activity-disclosure-card">
      <div class="card-heading activity-disclosure-heading"><div><h3>Sesiones y recursos</h3><p>La etiqueta LOCAL o INTERNET identifica el aislamiento de cada navegador.</p></div><div class="actions"><span class="state-pill">${counts.active} activo(s)</span><button type="button" id="refresh-development">Actualizar</button><button type="button" id="stop-all-development" class="danger" ${stoppableCount === 0 ? 'disabled' : ''} title="Cierra terminales, procesos, aplicaciones y navegadores locales; las sesiones de Internet se cierran individualmente">Detener entorno de desarrollo</button>${activityDisclosureToggleHtml('runtime', 'activity-runtime-panel')}</div></div>
      <div id="activity-runtime-panel" ${activityDisclosureState.runtime ? '' : 'hidden'}>
        <div class="activity-filters" role="group" aria-label="Filtrar actividad"><button type="button" id="activity-filter-all" data-activity-filter="all" ${activityFilter === 'all' ? 'aria-pressed="true" class="primary"' : 'aria-pressed="false"'}>Todo</button><button type="button" id="activity-filter-browsers" data-activity-filter="browsers" ${activityFilter === 'browsers' ? 'aria-pressed="true" class="primary"' : 'aria-pressed="false"'}>Navegadores</button><button type="button" id="activity-filter-resources" data-activity-filter="resources" ${activityFilter === 'resources' ? 'aria-pressed="true" class="primary"' : 'aria-pressed="false"'}>Recursos</button></div>
        <div id="development-activity">${activityRuntimeHtml()}</div>
      </div>
    </div>
    <div class="surface-card activity-disclosure-card">
      <div class="card-heading activity-disclosure-heading"><div><h3>Log técnico</h3><p>Filtra o exporta el diagnóstico local con secretos redactados.</p></div><div class="actions"><span class="state-pill">${tunnelLogs.length} línea(s)</span>${activityDisclosureToggleHtml('technicalLog', 'activity-technical-log-panel')}</div></div>
      <div id="activity-technical-log-panel" class="activity-disclosure-panel" ${activityDisclosureState.technicalLog ? '' : 'hidden'}>
        <label>Buscar en la actividad<input type="search" id="log-search" value="${escapeHtml(logFilter)}" placeholder="error, conexión, perfil…" /></label>
        <div class="actions"><button type="button" id="copy-diagnostic">Copiar diagnóstico</button><button type="button" id="export-diagnostic">Exportar .txt</button><button type="button" id="clear-logs" ${tunnelLogs.length === 0 ? 'disabled' : ''}>Limpiar vista</button></div>
        <div id="activity-log-container" class="activity-log-panel">${activityLogHtml()}</div>
      </div>
    </div>
    <div class="surface-card audit-card activity-disclosure-card">
      <div class="card-heading activity-disclosure-heading"><div><h3>Cobertura documental</h3><p>Archivos y páginas preparados para ChatGPT. LocalBridge muestra la entrega técnica y no interpreta el contenido.</p></div><div class="actions"><span class="state-pill">${documentAuditEvents.length} evento(s)</span>${activityDisclosureToggleHtml('documents', 'activity-documents-panel')}</div></div>
      <div id="activity-documents-panel" class="activity-disclosure-panel" ${activityDisclosureState.documents ? '' : 'hidden'}><div id="document-coverage">${documentCoverageHtml()}</div></div>
    </div>
    <div class="surface-card audit-card activity-disclosure-card">
      <div class="card-heading activity-disclosure-heading"><div><h3>Auditoría local</h3><p>Operaciones permitidas, denegadas o fallidas, sin contenido de archivos.</p></div><div class="actions"><span class="state-pill">${auditEvents.length} evento(s)</span><button type="button" id="refresh-audit">Actualizar</button>${activityDisclosureToggleHtml('audit', 'activity-audit-panel')}</div></div>
      <div id="activity-audit-panel" class="activity-disclosure-panel" ${activityDisclosureState.audit ? '' : 'hidden'}>
        <div class="audit-filters">
          <label>Proyecto<select id="audit-workspace"><option value="">Todos</option>${workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}" ${auditFilters.workspaceId === workspace.id ? 'selected' : ''}>${escapeHtml(workspace.name)}</option>`).join('')}</select></label>
          <label>Acción<select id="audit-action"><option value="">Todas</option>${Object.entries(AUDIT_ACTION_LABELS).map(([action, label]) => `<option value="${escapeHtml(action)}" ${auditFilters.action === action ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
          <label>Resultado<select id="audit-outcome"><option value="">Todos</option><option value="success" ${auditFilters.outcome === 'success' ? 'selected' : ''}>Correcto</option><option value="error" ${auditFilters.outcome === 'error' ? 'selected' : ''}>Error o denegado</option></select></label>
        </div>
        <div id="audit-events">${auditEventsHtml()}</div>
      </div>
    </div>
    ${browserViewerHtml()}
  `;
}

function settingsSectionHtml(): string {
  const importHtml = portableImport === undefined
    ? ''
    : `<div class="import-panel"><p><strong>${portableImport.config.connections.length} perfil(es)</strong> sin claves, <strong>${portableImport.config.workspaces.length} carpeta(s)</strong> por remapear, <strong>${portableImport.config.version === 3 || portableImport.config.version === 4 || portableImport.config.version === 5 ? portableImport.config.applications.length : 'aplicaciones heredadas'}</strong>${portableImport.config.version === 5 ? ` y <strong>${portableImport.config.projects.length} proyecto(s) asistido(s)</strong>` : ''}.</p>${portableImport.config.workspaces
        .map((workspace) => `<div class="mapping-row"><span>${escapeHtml(workspace.name)}</span><button type="button" data-map-workspace="${escapeHtml(workspace.ref)}">${portableImport?.mapped.has(workspace.ref) === true ? '✓ Carpeta elegida' : 'Elegir carpeta local'}</button></div>`)
        .join('')}<button type="button" id="apply-portable-import" class="primary" ${portableImport.mapped.size === portableImport.config.workspaces.length ? '' : 'disabled'}>Importar configuración</button></div>`;
  return `
    <div class="section-heading"><div><p class="eyebrow">Ajustes</p><h2>Comportamiento de la aplicación</h2><p>Las rutas internas están separadas del uso diario.</p></div></div>
    <div class="surface-card">
      <div class="card-heading"><div><h3>Perfiles de conexión</h3><p>Usa cuentas o túneles distintos sin compartir claves ni directorios.</p></div><span class="state-pill">${settingsDraft.connectionProfiles.length}/20</span></div>
      <div class="profile-list">${settingsDraft.connectionProfiles
        .map((profile) => `<div class="profile-row"><div><strong>${escapeHtml(profile.name)}</strong><small>${profile.tunnelId === '' ? 'Tunnel ID pendiente' : escapeHtml(profile.tunnelId)}</small></div><div class="actions">${profile.id === settingsDraft.activeConnectionProfileId ? '<span class="state-pill state-ok">Activo</span>' : `<button type="button" data-select-profile="${escapeHtml(profile.id)}">Usar</button>`}<button type="button" class="danger" data-remove-profile="${escapeHtml(profile.id)}" ${settingsDraft.connectionProfiles.length === 1 ? 'disabled' : ''}>Eliminar</button></div></div>`)
        .join('')}</div>
      <form id="create-profile-form" class="inline-form"><label>Nombre del nuevo perfil<input type="text" name="profileName" maxlength="80" required placeholder="Trabajo, Personal…" /></label><button type="submit">Añadir perfil</button></form>
    </div>
    <div class="surface-card">
      <h3>Mover configuración a otra PC</h3>
      <p>La exportación incluye permisos, validaciones y tunnel IDs. Nunca incluye claves, rutas locales, auditoría ni blobs DPAPI.</p>
      <div class="actions"><button type="button" id="export-portable">Exportar v0.9</button><button type="button" id="export-portable-v4">Compatible con v0.8</button><button type="button" id="select-portable-import">Importar y remapear</button></div>
      ${importHtml}
    </div>
    <div class="surface-card trust-summary">
      <h3>Qué datos salen del equipo</h3>
      <p><strong>Permanece local:</strong> claves cifradas, rutas absolutas, auditoría y contenido que no solicite una tool.</p>
      <p><strong>Por el túnel:</strong> únicamente resultados de tools autorizadas para el proyecto y la operación solicitados.</p>
      <div class="actions"><button type="button" data-external="tunnels">Administrar o revocar túneles</button><button type="button" id="forget-key-trust" ${tunnelKeyState.status === 'absent' ? 'disabled' : ''}>Olvidar clave de este perfil</button></div>
    </div>
    <form id="behavior-settings-form" class="surface-card">
      <label class="permission-option"><input type="checkbox" name="minimizeToTray" ${settingsDraft.minimizeToTray ? 'checked' : ''}/><span><strong>Mantener en la bandeja</strong><small>Minimizar o cerrar la ventana mantiene el túnel activo. “Salir” cierra todo explícitamente.</small></span></label>
      <label>Artefactos grandes en proyectos nuevos<select name="largeArtifactPreference"><option value="standard" ${settingsDraft.largeArtifactPreference.mode === 'standard' ? 'selected' : ''}>Estándar</option><option value="adaptive" ${settingsDraft.largeArtifactPreference.mode === 'adaptive' ? 'selected' : ''}>Adaptativo — sin límite fijo</option></select><small>Esta preferencia se copia al crear proyectos futuros. Los proyectos existentes no cambian.</small></label>
      <button type="submit">Guardar comportamiento</button>
    </form>
    <div class="surface-card"><h3>Configuración inicial</h3><p>Repite el asistente sin borrar proyectos, claves ni perfiles.</p><button type="button" id="restart-onboarding">Repetir configuración inicial</button></div>
    <details class="advanced-panel surface-card">
      <summary>Configuración avanzada y migración de v0.1</summary>
      <p>El runtime incluido ignora normalmente estas rutas. Se conservan para compatibilidad.</p>
      <form id="advanced-settings-form" data-settings-form>
        <input type="hidden" name="tunnelId" value="${escapeHtml(settingsDraft.tunnelId)}" />
        <label>Binario heredado<div class="path-row"><input type="text" name="tunnelBinaryPath" readonly value="${escapeHtml(settingsDraft.tunnelBinaryPath)}" /><button type="button" id="pick-binary">Elegir…</button></div></label>
        <label>Perfil<input type="text" name="tunnelProfile" value="${escapeHtml(settingsDraft.tunnelProfile)}" /></label>
        <label>Carpeta del perfil<div class="path-row"><input type="text" name="tunnelProfileDir" readonly value="${escapeHtml(settingsDraft.tunnelProfileDir)}" /><button type="button" id="pick-profile-dir">Elegir…</button></div></label>
        <label>Carpeta del servidor heredado<div class="path-row"><input type="text" name="serverCwd" readonly value="${escapeHtml(settingsDraft.serverCwd)}" /><button type="button" id="pick-server-cwd">Elegir…</button></div></label>
        <button type="submit">Guardar configuración avanzada</button>
      </form>
    </details>
  `;
}

function onboardingStepHtml(): string {
  const step = settingsDraft.onboardingStep;
  if (step === 0) {
    return `
      <h2>Bienvenido</h2>
      <p>LocalBridge permite que ChatGPT use únicamente las carpetas y capacidades que autorices.</p>
      <div class="trust-box">
        <strong>Límite de confianza</strong>
        <p>Nada del equipo queda disponible por defecto. Tú eliges cada carpeta, puedes revocar acceso y las claves se guardan cifradas por Windows.</p>
      </div>
      <button type="button" class="primary" data-onboarding-next="1">Entendido, continuar</button>
    `;
  }
  if (step === 1) {
    return `
      <h2>Comprobación del sistema</h2>
      <p>Verificaremos los componentes incluidos, la conexión HTTPS y una llamada MCP local real.</p>
      ${runtimeReportHtml()}
      <div class="actions">
        <button type="button" id="run-runtime-check">Comprobar ahora</button>
        <button type="button" class="primary" data-onboarding-next="2" ${runtimeReport?.ready === true ? '' : 'disabled'}>Continuar</button>
      </div>
    `;
  }
  if (step === 2) {
    return `
      <h2>Conectar con ChatGPT</h2>
      <p>Obtén un tunnel ID y una clave de runtime. La clave no se escribe en el perfil: se cifra con el almacén de Windows.</p>
      <div class="actions">
        <button type="button" data-external="tunnels">Abrir Tunnels</button>
        <button type="button" data-external="runtimeKeys">Abrir claves de runtime</button>
      </div>
      <form id="settings-form">
        <label>Confirmación de commit y push
          <select name="gitApprovalMode" aria-describedby="git-approval-help">
            <option value="host" ${settingsDraft.gitApprovalMode === 'host' ? 'selected' : ''}>Cuadro nativo de ChatGPT</option>
            <option value="mrtr" ${settingsDraft.gitApprovalMode === 'mrtr' ? 'selected' : ''}>MRTR estricto (cliente compatible)</option>
          </select>
          <small id="git-approval-help" class="field-help">Para ChatGPT, el modo nativo evita una segunda aprobación incompatible. MRTR ofrece la confirmación criptográfica más estricta.</small>
        </label>
        ${settingsDraft.gitApprovalMode === 'host' ? '<p class="risk-note risk-high">LocalBridge confía en el cuadro previo de ChatGPT; no puede comprobar qué botón pulsaste.</p>' : ''}
        <label>ID público del túnel<input type="text" name="tunnelId" required placeholder="tunnel_…" value="${escapeHtml(settingsDraft.tunnelId)}" aria-describedby="tunnel-id-help tunnel-id-error" autocomplete="off" spellcheck="false" /><small id="tunnel-id-help" class="field-help">Cópialo desde Tunnels. Empieza por tunnel_; no es una clave secreta.</small></label>
        <p id="tunnel-id-error" class="error-text field-error" role="alert"></p>
        <input type="hidden" name="tunnelBinaryPath" value="${escapeHtml(settingsDraft.tunnelBinaryPath)}" />
        <input type="hidden" name="tunnelProfile" value="${escapeHtml(settingsDraft.tunnelProfile)}" />
        <input type="hidden" name="tunnelProfileDir" value="${escapeHtml(settingsDraft.tunnelProfileDir)}" />
        <input type="hidden" name="serverCwd" value="${escapeHtml(settingsDraft.serverCwd)}" />
      </form>
      <label>Clave secreta de runtime<span class="field-status">${escapeHtml(runtimeKeyStatus())}</span><input type="password" id="api-key" value="${escapeHtml(apiKeyDraft)}" aria-describedby="runtime-key-help runtime-key-error" autocomplete="off" /><small id="runtime-key-help" class="field-help">Solo se guarda cifrada si el diagnóstico termina correctamente. No la compartas.</small></label>
      <p id="runtime-key-error" class="error-text field-error" role="alert"></p>
      <div class="actions">
        <button type="button" id="diagnose-tunnel">Guardar y diagnosticar</button>
        <button type="button" class="primary" data-onboarding-next="3" ${onboardingTunnelReady ? '' : 'disabled'}>Continuar</button>
      </div>
      ${diagnosticOutput === '' ? '' : `<pre id="diagnostic-output" class="log-panel">${escapeHtml(diagnosticOutput)}</pre>`}
    `;
  }
  if (step === 3) {
    return `
      <h2>Autorizar el primer proyecto</h2>
      <p>Empieza con Solo lectura. Puedes ampliar permisos después y seleccionar únicamente validaciones declaradas por el proyecto.</p>
      ${
        workspaces.length === 0
          ? workspaceFormHtml()
          : `<p class="feedback feedback-success">✓ ${workspaces.length} proyecto(s) autorizado(s): ${workspaces.map((workspace) => escapeHtml(workspace.name)).join(', ')}</p>`
      }
      <div class="actions">
        <button type="button" data-onboarding-back="2">Atrás</button>
        <button type="button" class="primary" data-onboarding-next="4" ${workspaces.length > 0 ? '' : 'disabled'}>Continuar</button>
      </div>
    `;
  }
  return `
    <h2>Prueba final</h2>
    <p>Confirma otra vez que el servidor responde y luego registra el conector en ChatGPT mientras LocalBridge esté conectado.</p>
    ${runtimeReportHtml()}
    <div class="actions">
      <button type="button" id="run-runtime-check">Probar system.health</button>
      <button type="button" data-external="chatgptConnectors">Abrir conectores de ChatGPT</button>
    </div>
    <ol>
      <li>Pulsa “Finalizar” y luego “Conectar” en la pantalla principal.</li>
      <li>Abre Conectores de ChatGPT y crea o verifica el conector asociado al tunnel ID.</li>
      <li>Mantén LocalBridge abierto mientras quieras usar el conector.</li>
    </ol>
    <div class="actions">
      <button type="button" data-onboarding-back="3">Atrás</button>
      <button type="button" id="complete-onboarding" class="primary" ${runtimeReport?.ready === true ? '' : 'disabled'}>Todo listo</button>
    </div>
  `;
}

/** Render legacy conservado solo para pruebas de downgrade de la UI v1.0.3. */
export function legacyOnboardingHtml(): string {
  return `
    <main class="onboarding-shell">
      <p class="eyebrow">Configuración inicial · Paso ${settingsDraft.onboardingStep + 1} de 5</p>
      <h1>LocalBridge MCP</h1>
      ${
        feedback === undefined
          ? ''
          : `<p id="global-feedback" class="feedback feedback-${feedback.kind}" role="${feedback.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(feedback.message)}</p>`
      }
      ${onboardingStepHtml()}
    </main>
  `;
}

function render(): void {
  if (app === null) return;
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  const previousScrollTop = document.scrollingElement?.scrollTop ?? 0;
  if (isInitializing) {
    app.innerHTML = '<main class="loading-shell" aria-busy="true"><div class="loading-mark"></div><h1>LocalBridge MCP</h1><p>Preparando tu espacio seguro…</p></main>';
    return;
  }
  if (onboardingSnapshotState !== undefined && onboardingSnapshotState.state.status !== 'completed') {
    const feedbackHtml = feedback === undefined
      ? ''
      : `<p id="global-feedback" class="feedback feedback-${feedback.kind}" role="${feedback.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(feedback.message)}</p>`;
    app.innerHTML = renderOnboardingHtml({
      snapshot: onboardingSnapshotState,
      settings: settingsDraft,
      ...(runtimeReport === undefined ? {} : { runtimeReport }),
      apiKeyDraft,
      keySaved,
      diagnosticOutput,
      projectName: onboardingProjectName,
      projectDescription: onboardingProjectDescription,
      ...(onboardingBusy === undefined ? {} : { busy: onboardingBusy }),
      feedbackHtml,
    });
    attachHandlers();
    if (
      onboardingSnapshotState.effectiveStep === 'runtime'
      && runtimeReport === undefined
      && onboardingBusy === undefined
      && !onboardingRuntimeAutoStarted
    ) {
      onboardingRuntimeAutoStarted = true;
      queueMicrotask(() => void runOnboardingRuntimeCheck());
    }
    return;
  }
  app.innerHTML = `
    <a class="skip-link" href="#main-content">Saltar al contenido</a>
    <div class="app-shell">
      <aside class="sidebar${sidebarOpen ? ' sidebar-open' : ''}" id="sidebar-navigation">
        <div class="brand"><div class="brand-icon" aria-hidden="true"><span></span></div><div><strong>LocalBridge</strong><small>MCP Desktop</small></div></div>
        <nav aria-label="Secciones principales">
          <span class="nav-group-label">Uso diario</span>
          ${([['home', 'Inicio'], ['assisted', 'Desarrollo'], ['activity', 'Actividad']] as Array<[AppSection, string]>).map(([section, label]) => `<button type="button" id="nav-${section}" data-section="${section}" ${activeSection === section ? 'aria-current="page"' : ''}>${label}</button>`).join('')}
          <span class="nav-group-label">Configuración</span>
          ${([['projects', 'Carpetas'], ['applications', 'Aplicaciones'], ['web', 'Acceso a Internet'], ['connection', 'Conexión'], ['settings', 'Ajustes']] as Array<[AppSection, string]>).map(([section, label]) => `<button type="button" id="nav-${section}" data-section="${section}" ${activeSection === section ? 'aria-current="page"' : ''}>${label}</button>`).join('')}
        </nav>
        <div class="sidebar-footer"><span class="status-dot status-dot-${tunnelStatus}"></span><span>${TUNNEL_STATUS_LABELS[tunnelStatus]}</span></div>
      </aside>
      <button type="button" class="sidebar-backdrop${sidebarOpen ? ' sidebar-backdrop-visible' : ''}" id="close-navigation" aria-label="Cerrar navegación"></button>
      <div class="app-surface">
        <header class="topbar"><div class="topbar-title"><button type="button" id="nav-toggle" aria-controls="sidebar-navigation" aria-expanded="${sidebarOpen}">Menú</button><span>LocalBridge MCP</span></div><div class="actions"><button type="button" id="hide-app" aria-label="Minimizar LocalBridge a la bandeja">Minimizar</button><button type="button" id="quit-app" class="quiet-danger">Salir</button></div></header>
        ${
          feedback === undefined
            ? ''
            : `<p id="global-feedback" class="feedback feedback-${feedback.kind}" role="${feedback.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(feedback.message)}</p>`
        }
        <main id="main-content" tabindex="-1">
          <section data-view="home" ${activeSection === 'home' ? '' : 'hidden'}>${dashboardHtml()}</section>
          <section data-view="web" ${activeSection === 'web' ? '' : 'hidden'}>${webSectionHtml()}</section>
          <section data-view="assisted" ${activeSection === 'assisted' ? '' : 'hidden'}>${assistedProjectsSectionHtml()}</section>
          <section data-view="projects" ${activeSection === 'projects' ? '' : 'hidden'}>${workspacesSectionHtml()}</section>
          <section data-view="applications" ${activeSection === 'applications' ? '' : 'hidden'}>${applicationsSectionHtml()}</section>
          <section data-view="connection" ${activeSection === 'connection' ? '' : 'hidden'}>${connectionSectionHtml()}</section>
          <section data-view="activity" ${activeSection === 'activity' ? '' : 'hidden'}>${activitySectionHtml()}</section>
          <section data-view="settings" ${activeSection === 'settings' ? '' : 'hidden'}>${settingsSectionHtml()}</section>
        </main>
      </div>
    </div>
  `;
  attachHandlers();
  if (focusedId !== '') document.getElementById(focusedId)?.focus();
  if (document.scrollingElement !== null) document.scrollingElement.scrollTop = previousScrollTop;
}

function readPermissionsFromForm(form: HTMLFormElement): WorkspacePermissions {
  const data = new FormData(form);
  return {
    read: data.get('perm-read') !== null,
    write: data.get('perm-write') !== null,
    overwrite: data.get('perm-overwrite') !== null,
    gitRead: data.get('perm-gitRead') !== null,
    validations: data.get('perm-validations') !== null,
    gitWrite: data.get('perm-gitWrite') !== null,
    processes: data.get('perm-processes') !== null,
    browserRead: data.get('perm-browserRead') !== null,
    browserInteract: data.get('perm-browserInteract') !== null,
    browserHumanControl: data.get('perm-browserHumanControl') !== null,
  };
}

function readLargeArtifactPolicy(data: FormData, current: LargeArtifactPolicy): LargeArtifactPolicy {
  const gib = 1024 * 1024 * 1024;
  const modeValue = String(data.get('largeArtifactMode') ?? current.mode);
  const mode = modeValue === 'adaptive' || modeValue === 'custom' ? modeValue : 'standard';
  const minimumFreeBytes = Math.round(Number(data.get('largeArtifactReserveGiB') ?? current.reserve.minimumFreeBytes / gib) * gib);
  const minimumFreePercent = Number(data.get('largeArtifactReservePercent') ?? current.reserve.minimumFreePercent);
  const concurrentValue = Number(data.get('largeArtifactConcurrentJobs') ?? current.maxConcurrentJobs);
  const maxConcurrentJobs = concurrentValue === 2 ? 2 as const : 1 as const;
  const common = { reserve: { minimumFreeBytes, minimumFreePercent }, maxConcurrentJobs };
  if (mode !== 'custom') return { mode, ...common };
  const fallback = current.mode === 'custom' ? current.customSourceBytes / gib : 1;
  return { mode, customSourceBytes: Math.round(Number(data.get('largeArtifactCustomGiB') ?? fallback) * gib), ...common };
}

function syncWorkspaceDraftFromForm(form: HTMLFormElement): void {
  const data = new FormData(form);
  workspaceFormDraft = {
    name: String(data.get('name') ?? ''),
    rootPath: String(data.get('rootPath') ?? ''),
    enabled: editingWorkspace === undefined || data.get('enabled') !== null,
    permissions: readPermissionsFromForm(form),
    maxFileBytes: Number(data.get('maxFileBytes') ?? workspaceFormDraft?.maxFileBytes ?? 1_048_576),
    largeArtifacts: readLargeArtifactPolicy(data, workspaceFormDraft?.largeArtifacts ?? settingsDraft.largeArtifactPreference),
    validationProfilesText: String(data.get('validationProfiles') ?? '{}'),
    processProfilesText: String(data.get('processProfiles') ?? '{}'),
    browserProfilesText: String(data.get('browserProfiles') ?? '{}'),
  };
}

function syncSettingsDraftFromForm(form: HTMLFormElement): void {
  const data = new FormData(form);
  const value = (name: string, current: string): string => (data.has(name) ? String(data.get(name) ?? '') : current);
  const tunnelId = value('tunnelId', settingsDraft.tunnelId);
  const approvalModeValue = value('gitApprovalMode', settingsDraft.gitApprovalMode);
  const gitApprovalMode = approvalModeValue === 'host' ? 'host' : 'mrtr';
  settingsDraft = {
    onboardingStep: settingsDraft.onboardingStep,
    onboardingCompleted: settingsDraft.onboardingCompleted,
    minimizeToTray: settingsDraft.minimizeToTray,
    largeArtifactPreference: settingsDraft.largeArtifactPreference,
    gitApprovalMode,
    activeConnectionProfileId: settingsDraft.activeConnectionProfileId,
    connectionProfiles: settingsDraft.connectionProfiles.map((profile) =>
      profile.id === settingsDraft.activeConnectionProfileId ? { ...profile, tunnelId } : profile,
    ),
    tunnelId,
    tunnelBinaryPath: value('tunnelBinaryPath', settingsDraft.tunnelBinaryPath),
    tunnelProfile: value('tunnelProfile', settingsDraft.tunnelProfile),
    tunnelProfileDir: value('tunnelProfileDir', settingsDraft.tunnelProfileDir),
    serverCwd: value('serverCwd', settingsDraft.serverCwd),
  };
}

function clearFieldError(input: HTMLInputElement, errorId: string): void {
  input.removeAttribute('aria-invalid');
  const error = document.querySelector<HTMLElement>(`#${errorId}`);
  if (error !== null) error.textContent = '';
}

function validateTunnelId(form: HTMLFormElement): boolean {
  const input = form.querySelector<HTMLInputElement>('input[name="tunnelId"]');
  if (input === null) return false;
  input.value = input.value.trim();
  syncSettingsDraftFromForm(form);
  if (TUNNEL_ID_PATTERN.test(input.value)) {
    clearFieldError(input, 'tunnel-id-error');
    return true;
  }
  input.setAttribute('aria-invalid', 'true');
  const error = document.querySelector<HTMLElement>('#tunnel-id-error');
  if (error !== null) {
    error.textContent = input.value === ''
      ? 'Escribe el ID público del túnel antes de continuar.'
      : 'El ID del túnel no es válido. Copia desde Tunnels el valor que empieza por tunnel_.';
  }
  input.focus();
  return false;
}

function validateRuntimeKey(allowStored = false): boolean {
  const input = document.querySelector<HTMLInputElement>('#api-key');
  if (input === null) return false;
  if (apiKeyDraft !== '' || (allowStored && tunnelKeyState.status === 'available')) {
    clearFieldError(input, 'runtime-key-error');
    return true;
  }
  input.setAttribute('aria-invalid', 'true');
  const error = document.querySelector<HTMLElement>('#runtime-key-error');
  if (error !== null) error.textContent = 'Escribe la clave secreta de runtime antes de continuar.';
  input.focus();
  return false;
}

function showFeedback(kind: UiFeedback['kind'], message: string): void {
  feedback = { kind, message };
  if (kind === 'error') lastProblem = message;
  render();
}

function focusWorkspaceEditButton(workspaceId: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-action="edit"]')].find(
    (candidate) => candidate.dataset['id'] === workspaceId,
  );
  button?.focus();
}

/** Actualiza solo el estado vivo del túnel para no interrumpir formularios en edición. */
function updateTunnelRuntimeUi(): void {
  const badges = document.querySelectorAll<HTMLElement>('[data-tunnel-status]');
  const detail = document.querySelector<HTMLSpanElement>('[data-tunnel-detail]');
  const logContainer = document.querySelector<HTMLDivElement>('#activity-log-container');
  const connect = document.querySelector<HTMLButtonElement>('#connect-tunnel');
  const disconnect = document.querySelector<HTMLButtonElement>('#disconnect-tunnel');

  for (const badge of badges) {
    badge.className = badge.classList.contains('status-badge')
      ? `status-badge status-${tunnelStatus}`
      : `status-text-${tunnelStatus}`;
    badge.textContent = TUNNEL_STATUS_LABELS[tunnelStatus] ?? tunnelStatus;
  }
  if (detail !== null) {
    detail.replaceChildren();
    if (tunnelDetail !== undefined) {
      const message = document.createElement('p');
      message.className = 'risk-note risk-high';
      message.textContent = tunnelDetail;
      detail.append(message);
    }
  }
  if (logContainer !== null) logContainer.innerHTML = activityLogHtml();
  if (connect !== null) connect.disabled = tunnelStatus === 'connecting' || tunnelStatus === 'connected';
  if (disconnect !== null) disconnect.disabled = tunnelStatus === 'disconnected';
  const sidebarDot = document.querySelector<HTMLElement>('.status-dot');
  if (sidebarDot !== null) sidebarDot.className = `status-dot status-dot-${tunnelStatus}`;
  if (tunnelStatus === 'error' && tunnelDetail !== undefined) lastProblem = tunnelDetail;
}

function diagnosticText(): string {
  const redactedLogs = tunnelLogs.map((line) =>
    line
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[CLAVE REDACTADA]')
      .replace(/CONTROL_PLANE_API_KEY\s*[=:]\s*\S+/gi, 'CONTROL_PLANE_API_KEY=[REDACTADA]'),
  );
  return [
    'LocalBridge MCP — diagnóstico de sesión',
    `Fecha: ${new Date().toISOString()}`,
    `Estado del túnel: ${TUNNEL_STATUS_LABELS[tunnelStatus]}`,
    `Proyectos: ${workspaces.length} (${workspaces.filter((workspace) => workspace.enabled).length} activos)`,
    tunnelDetail === undefined ? '' : `Detalle: ${tunnelDetail}`,
    '',
    ...redactedLogs,
  ].join('\n');
}

/**
 * Aplica la selección de checkboxes al textarea de perfiles: un comando
 * detectado marcado se escribe (o sobrescribe) con el comando real; uno
 * desmarcado se quita si está presente. Cualquier entrada del JSON que no
 * corresponda a un comando detectado (escrita a mano) se deja intacta.
 */
function applyDetectedSelectionToTextarea(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="validationProfiles"]');
  if (textarea === null) return;

  let current: Record<string, string[]>;
  try {
    current = JSON.parse(textarea.value) as Record<string, string[]>;
  } catch {
    current = {};
  }

  for (const candidate of detectedCommands) {
    if (selectedDetected.has(candidate.name)) {
      current[candidate.name] = [...candidate.command];
    } else {
      delete current[candidate.name];
    }
  }

  textarea.value = JSON.stringify(current, null, 2);
  if (workspaceFormDraft !== undefined) {
    workspaceFormDraft.validationProfilesText = textarea.value;
  }
}

function applyDetectedSelectionToProcessProfiles(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="processProfiles"]');
  if (textarea === null) return;

  let current: Record<string, ProcessProfile>;
  try {
    current = JSON.parse(textarea.value) as Record<string, ProcessProfile>;
  } catch {
    current = {};
  }

  for (const candidate of detectedCommands) {
    if (selectedDetected.has(candidate.name)) current[candidate.name] = candidate.processProfile;
  }
  textarea.value = JSON.stringify(current, null, 2);
  if (workspaceFormDraft !== undefined) workspaceFormDraft.processProfilesText = textarea.value;
}

function enableValidationsPermissionForSelection(): void {
  if (selectedDetected.size === 0) return;
  const checkbox = document.querySelector<HTMLInputElement>('input[name="perm-validations"]');
  if (checkbox !== null) checkbox.checked = true;
  const form = document.querySelector<HTMLFormElement>('#workspace-form');
  if (form !== null) syncWorkspaceDraftFromForm(form);
}

/** Actualización acotada al contenedor de la lista — nunca llama a `render()`, para no perder lo que el humano esté escribiendo en el resto del formulario. */
function renderDetectedCommandsList(): void {
  const container = document.querySelector<HTMLDivElement>('#detected-commands');
  if (container === null) return;

  if (detectedCommands.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = detectedCommands
    .map(
      (candidate) => `
        <label class="checkbox-row">
          <input type="checkbox" data-detected="${escapeHtml(candidate.name)}" ${selectedDetected.has(candidate.name) ? 'checked' : ''}/>
          <code>${escapeHtml(candidate.name)}</code>
          <small>${escapeHtml(candidate.command.join(' '))} — ${escapeHtml(candidate.source)}</small>
        </label>`,
    )
    .join('');

  container.querySelectorAll<HTMLInputElement>('input[data-detected]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const name = checkbox.dataset['detected'];
      if (name === undefined) return;
      if (checkbox.checked) selectedDetected.add(name);
      else selectedDetected.delete(name);
      applyDetectedSelectionToTextarea();
      enableValidationsPermissionForSelection();
    });
  });
}

function resetDetectedCommands(): void {
  detectedCommands = [];
  selectedDetected = new Set();
}

function adoptOnboardingSnapshot(snapshot: OnboardingViewSnapshot): void {
  onboardingSnapshotState = snapshot;
  const legacyStep = snapshot.state.currentStep === 'welcome'
    ? 0
    : snapshot.state.currentStep === 'runtime'
      ? 1
      : snapshot.state.currentStep === 'connection'
        ? 2
        : snapshot.state.currentStep === 'review'
          ? 4
          : 3;
  settingsDraft = {
    ...settingsDraft,
    onboardingStep: legacyStep,
    onboardingCompleted: snapshot.state.status === 'completed',
  };
  settings = { ...settingsDraft };
  if (snapshot.folder !== undefined && onboardingProjectName === '') {
    onboardingProjectName = snapshot.folder.existingProjectName ?? snapshot.folder.suggestedName;
  }
}

async function adoptSettings(next: DesktopSettings): Promise<void> {
  settings = next;
  settingsDraft = { ...next };
  apiKeyDraft = '';
  tunnelKeyState = await window.desktop.getTunnelKeyState();
  keySaved = tunnelKeyState.status === 'available';
  diagnosticOutput = '';
  onboardingTunnelReady = false;
  render();
}

async function runOnboardingRuntimeCheck(): Promise<void> {
  if (onboardingSnapshotState?.state.status === 'completed' || onboardingBusy !== undefined) return;
  onboardingBusy = 'runtime';
  render();
  try {
    const result = await window.desktop.checkOnboardingRuntime();
    runtimeReport = result.report;
    adoptOnboardingSnapshot(result.snapshot);
    feedback = {
      kind: runtimeReport.ready ? 'success' : 'error',
      message: runtimeReport.ready ? 'Todos los componentes están listos.' : 'Hay componentes que requieren atención.',
    };
  } catch (error) {
    feedback = { kind: 'error', message: `No se pudo comprobar el sistema: ${errorMessage(error)}` };
  } finally {
    onboardingBusy = undefined;
    render();
  }
}

async function refreshAudit(): Promise<void> {
  auditLoading = true;
  const container = document.querySelector<HTMLDivElement>('#audit-events');
  if (container !== null) container.innerHTML = auditEventsHtml();
  try {
    [auditEvents, documentAuditEvents] = await Promise.all([
      window.desktop.listAuditEvents({ ...auditFilters, limit: 100 }),
      window.desktop.listAuditEvents({ limit: 500 }).then((events) => events.filter((event) =>
        event.action === 'web.download' || event.action === 'document.read' || event.action === 'document.render' || event.action === 'image.read')),
    ]);
  } catch (error) {
    lastProblem = `No se pudo leer la auditoría: ${errorMessage(error)}`;
    auditEvents = [];
    documentAuditEvents = [];
  } finally {
    auditLoading = false;
    const current = document.querySelector<HTMLDivElement>('#audit-events');
    if (current !== null) current.innerHTML = auditEventsHtml();
    const documentCoverage = document.querySelector<HTMLDivElement>('#document-coverage');
    if (documentCoverage !== null) documentCoverage.innerHTML = documentCoverageHtml();
    bindAuditListActions();
  }
}

async function refreshDevelopmentActivity(shouldRender = true): Promise<void> {
  try {
    developmentActivity = await window.desktop.listDevelopmentActivity();
    if (developmentActivity.liveViewerDisplayId !== undefined) rememberLiveViewerDisplayId(developmentActivity.liveViewerDisplayId);
  } catch (error) {
    lastProblem = `No se pudo leer la actividad de desarrollo: ${errorMessage(error)}`;
    developmentActivity = { processes: [], browsers: [], applications: [], terminals: [], jobs: [] };
  }
  pruneActivityExpandedItems();
  updateAutomaticActivityDisclosure();
  if (browserViewerSessionId !== undefined && !developmentActivity.browsers.some((entry) =>
    entry.sessionId === browserViewerSessionId && entry.state === 'running')) {
    stopBrowserViewer();
    if (activeSection === 'activity') {
      render();
      return;
    }
  }
  if (activeSection === 'activity' && shouldRender) {
    render();
    return;
  }
  const container = document.querySelector<HTMLDivElement>('#development-activity');
  if (container !== null) container.innerHTML = activityRuntimeHtml();
  bindDevelopmentHumanControlActions();
  bindAuditListActions();
  const stopButton = document.querySelector<HTMLButtonElement>('#stop-all-development');
  if (stopButton !== null) stopButton.disabled = developmentActivity.processes.length + developmentActivity.browsers.length + developmentActivity.applications.length + (developmentActivity.terminals?.length ?? 0) === 0;
}

function updatePendingApprovalUi(): void {
  document.querySelectorAll<HTMLElement>('[data-pending-approvals]').forEach((container) => {
    container.innerHTML = pendingApprovalsHtml();
  });
}

function schedulePendingApprovalExpiry(): void {
  if (pendingApprovalExpiryTimer !== undefined) window.clearTimeout(pendingApprovalExpiryTimer);
  const nextExpiry = pendingApprovals
    .map((approval) => new Date(approval.expiresAt).getTime())
    .filter((value) => Number.isFinite(value))
    .toSorted((a, b) => a - b)[0];
  if (nextExpiry === undefined) {
    pendingApprovalExpiryTimer = undefined;
    return;
  }
  const delay = Math.min(Math.max(nextExpiry - Date.now() + 50, 0), 2_147_000_000);
  pendingApprovalExpiryTimer = window.setTimeout(() => void refreshPendingApprovals(), delay);
}

async function refreshPendingApprovals(): Promise<void> {
  try {
    pendingApprovals = await window.desktop.listPendingApprovals();
  } catch (error) {
    lastProblem = `No se pudo leer el estado de aprobaciones: ${errorMessage(error)}`;
    pendingApprovals = [];
  }
  updatePendingApprovalUi();
  schedulePendingApprovalExpiry();
}

function applicationWizardError(message: string): void {
  const error = document.querySelector<HTMLElement>('#application-form-error');
  if (error !== null) error.textContent = message;
}

function syncApplicationWizardFromDom(): void {
  const draft = applicationWizard;
  if (draft === undefined) return;
  if (draft.step === 1) {
    draft.name = document.querySelector<HTMLInputElement>('#app-name')?.value.trim() ?? draft.name;
    draft.description = document.querySelector<HTMLTextAreaElement>('#app-description')?.value.trim() ?? draft.description;
  } else if (draft.step === 2) {
    draft.selected = [...document.querySelectorAll<HTMLInputElement>('[data-app-service]:checked')].map((input) => input.dataset['appService'] ?? '').filter(Boolean);
    const candidates = serviceCandidates();
    for (const key of draft.selected) {
      const candidate = candidates.find((item) => item.key === key);
      draft.aliases[key] ??= candidate === undefined ? 'service' : suggestedAlias(candidate.workspace, candidate.profile);
    }
    if (!draft.selected.includes(draft.primary)) draft.primary = draft.selected[0] ?? '';
  } else if (draft.step === 3) {
    document.querySelectorAll<HTMLInputElement>('[data-app-alias]').forEach((input) => {
      const key = input.dataset['appAlias'];
      if (key !== undefined) draft.aliases[key] = input.value.trim();
    });
    draft.primary = document.querySelector<HTMLInputElement>('[data-app-primary]:checked')?.dataset['appPrimary'] ?? draft.primary;
    document.querySelectorAll<HTMLInputElement>('[data-app-wildcard]').forEach((input) => {
      const key = input.dataset['appWildcard'];
      if (key !== undefined) draft.wildcard[key] = input.checked;
    });
  } else if (draft.step === 4) {
    draft.objective = (document.querySelector<HTMLInputElement>('input[name="app-objective"]:checked')?.value as AccessObjective | undefined) ?? draft.objective;
  }
}

function validateApplicationWizardStep(draft: ApplicationWizardDraft): string | undefined {
  if (draft.step === 1) {
    if (draft.name.length < 1 || draft.name.length > 80) return 'Escribe un nombre de hasta 80 caracteres.';
    const duplicate = applications.find((application) => application.id !== draft.editingId && application.name.normalize('NFKC').toLocaleLowerCase() === draft.name.normalize('NFKC').toLocaleLowerCase());
    if (duplicate !== undefined) return `Ya existe una aplicación llamada ${duplicate.name}.`;
  }
  if (draft.step === 2 && (draft.selected.length < 1 || draft.selected.length > 8)) return 'Selecciona entre 1 y 8 servicios.';
  if (draft.step === 3) {
    const aliases = draft.selected.map((key) => draft.aliases[key] ?? '');
    if (aliases.some((alias) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias))) return 'Cada alias debe comenzar con letra o número y usar solo letras, números, punto, guion o guion bajo.';
    if (new Set(aliases.map((alias) => alias.normalize('NFKC').toLocaleLowerCase())).size !== aliases.length) return 'Cada servicio necesita un alias distinto.';
    if (!draft.selected.includes(draft.primary)) return 'Elige cuál servicio abrirá LocalBridge en el navegador.';
  }
  return undefined;
}

async function applyApplicationObjective(draft: ApplicationWizardDraft): Promise<void> {
  const desired = objectivePermissions(draft.objective);
  const ids = [...new Set(draft.selected.map((key) => key.split('|')[0]).filter((id): id is string => id !== undefined))];
  for (const id of ids) {
    const workspace = workspaces.find((candidate) => candidate.id === id);
    if (workspace === undefined) throw new Error('Uno de los proyectos seleccionados ya no está disponible.');
    const permissions = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, Boolean(workspace.permissions[key] || desired[key])])) as unknown as WorkspacePermissions;
    await window.desktop.updateWorkspace({ ...workspace, permissions, automationReviewRequired: false });
  }
  workspaces = await window.desktop.listWorkspaces();
}

async function saveApplicationWizard(verify: boolean): Promise<void> {
  const draft = applicationWizard;
  if (draft === undefined) return;
  syncApplicationWizardFromDom();
  const validation = validateApplicationWizardStep(draft);
  if (validation !== undefined) {
    applicationWizardError(validation);
    return;
  }
  if (verify && draft.objective !== 'web' && draft.objective !== 'complete') {
    applicationWizardError('Para iniciar la prueba elige un objetivo que permita ejecutar y revisar la web. También puedes guardar para revisar después.');
    return;
  }
  const affectedWorkspaceIds = [...new Set(draft.selected.map((key) => key.split('|')[0]).filter((id): id is string => id !== undefined))];
  const permissionSnapshots = affectedWorkspaceIds.map((id) => workspaces.find((workspace) => workspace.id === id)).filter((workspace): workspace is AuthorizedWorkspace => workspace !== undefined);
  const services: NewApplicationDraft['services'] = draft.selected.map((key) => {
    const [workspaceId, processProfile] = key.split('|');
    if (workspaceId === undefined || processProfile === undefined) throw new Error('Servicio inválido.');
    return {
      alias: draft.aliases[key] ?? '',
      workspaceId,
      processProfile,
      hostMode: 'manual-localhost',
      allowManagedWildcard: draft.wildcard[key] === true,
    };
  });
  let saved: LocalApplication;
  try {
    await applyApplicationObjective(draft);
    if (draft.editingId === undefined) {
      saved = await window.desktop.createApplication({
        name: draft.name,
        description: draft.description,
        primaryServiceAlias: draft.aliases[draft.primary] ?? '',
        services,
        viewport: { width: 1920, height: 1080 },
      });
    } else {
      const previous = applications.find((application) => application.id === draft.editingId);
      if (previous === undefined) throw new Error('La aplicación ya no existe.');
      const nextServices = services.map((service, startupOrder) => {
        const prior = previous.services.find((candidate) => candidate.workspaceId === service.workspaceId && candidate.processProfile === service.processProfile);
        return { ...service, id: prior?.id ?? `service_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, startupOrder };
      });
      const primary = nextServices.find((service) => service.alias === draft.aliases[draft.primary]);
      if (primary === undefined) throw new Error('El servicio principal no es válido.');
      const { conflictCandidates: _recoveredConflict, ...repairedApplication } = previous;
      saved = await window.desktop.updateApplication({ ...repairedApplication, name: draft.name, description: draft.description, services: nextServices, primaryServiceId: primary.id, reviewState: 'needs-review', updatedAt: new Date().toISOString() });
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const workspace of permissionSnapshots) {
      try {
        await window.desktop.updateWorkspace(workspace);
      } catch {
        rollbackFailures.push(workspace.name);
      }
    }
    workspaces = await window.desktop.listWorkspaces();
    if (rollbackFailures.length > 0) throw new Error(`No se pudo guardar la aplicación ni restaurar el acceso de: ${rollbackFailures.join(', ')}. Revísalo en Proyectos.`, { cause: error });
    throw error;
  }
  if (verify) {
    draft.editingId = saved.id;
    try {
      const result = await window.desktop.verifyApplication(saved.id);
      saved = result.application;
    } catch (error) {
      await Promise.all([refreshApplications(false), refreshDevelopmentActivity()]);
      render();
      throw error;
    }
  }
  applicationWizard = undefined;
  await Promise.all([refreshApplications(false), refreshDevelopmentActivity()]);
  showFeedback('success', verify ? `${saved.name} inició, abrió el navegador y quedó lista.` : `${saved.name} se guardó pendiente de revisión.`);
}

async function submitApplicationWizard(verify: boolean): Promise<void> {
  const draft = applicationWizard;
  if (draft === undefined || applicationWizardBusy !== undefined) return;
  syncApplicationWizardFromDom();
  const validation = validateApplicationWizardStep(draft);
  if (validation !== undefined) {
    applicationWizardError(validation);
    return;
  }
  if (verify && draft.objective !== 'web' && draft.objective !== 'complete') {
    applicationWizardError('Para iniciar la prueba elige un objetivo que permita ejecutar y revisar la web. También puedes guardar para revisar después.');
    return;
  }
  applicationWizardBusy = verify ? 'verify' : 'save';
  render();
  try {
    await saveApplicationWizard(verify);
  } catch (error) {
    applicationWizardBusy = undefined;
    render();
    applicationWizardError(errorMessage(error));
    return;
  }
  applicationWizardBusy = undefined;
}

function bindApplicationActions(): void {
  const openWizard = (): void => {
    applicationWizardBusy = undefined;
    applicationWizard = blankApplicationWizard();
    render();
    document.querySelector<HTMLInputElement>('#app-name')?.focus();
  };
  document.querySelector('#show-app-wizard')?.addEventListener('click', openWizard);
  document.querySelector('#show-app-wizard-empty')?.addEventListener('click', openWizard);
  document.querySelector('#cancel-app-wizard')?.addEventListener('click', () => {
    if (applicationWizardBusy !== undefined) return;
    applicationWizard = undefined;
    render();
    document.querySelector<HTMLButtonElement>('#show-app-wizard')?.focus();
  });
  document.querySelector('#app-wizard-next')?.addEventListener('click', () => {
    if (applicationWizard === undefined || applicationWizardBusy !== undefined) return;
    syncApplicationWizardFromDom();
    const validation = validateApplicationWizardStep(applicationWizard);
    if (validation !== undefined) return applicationWizardError(validation);
    applicationWizard.step = Math.min(5, applicationWizard.step + 1) as ApplicationWizardDraft['step'];
    render();
    document.querySelector<HTMLElement>('.wizard-content input, .wizard-content textarea, .wizard-content button')?.focus();
  });
  document.querySelector('#app-wizard-back')?.addEventListener('click', () => {
    if (applicationWizard === undefined || applicationWizardBusy !== undefined) return;
    syncApplicationWizardFromDom();
    applicationWizard.step = Math.max(1, applicationWizard.step - 1) as ApplicationWizardDraft['step'];
    render();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-app-move]').forEach((button) => button.addEventListener('click', () => {
    if (applicationWizard === undefined || applicationWizardBusy !== undefined) return;
    syncApplicationWizardFromDom();
    const key = button.dataset['appKey'];
    if (key === undefined) return;
    const index = applicationWizard.selected.indexOf(key);
    const target = button.dataset['appMove'] === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= applicationWizard.selected.length) return;
    [applicationWizard.selected[index], applicationWizard.selected[target]] = [applicationWizard.selected[target]!, applicationWizard.selected[index]!];
    render();
  }));
  document.querySelector('#app-wizard-save')?.addEventListener('click', () => void submitApplicationWizard(true));
  document.querySelector('#app-wizard-save-later')?.addEventListener('click', () => void submitApplicationWizard(false));
  document.querySelectorAll<HTMLButtonElement>('[data-app-edit]').forEach((button) => button.addEventListener('click', () => {
    const application = applications.find((candidate) => candidate.id === button.dataset['appEdit']);
    if (application === undefined) return;
    applicationWizardBusy = undefined;
    applicationWizard = wizardFromApplication(application);
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-app-verify]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['appVerify'];
    if (id === undefined) return;
    void withBusyButton(button, 'Probando…', () => window.desktop.verifyApplication(id)).then(async () => {
      await refreshApplications(false);
      showFeedback('success', 'La aplicación inició todos sus servicios, abrió el navegador y quedó aprobada.');
    }).catch((error) => showFeedback('error', `La prueba no se completó y la aplicación sigue sin aprobar: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-app-start]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['appStart'];
    if (id === undefined) return;
    void withBusyButton(button, 'Iniciando…', () => window.desktop.startApplication(id)).then(async () => {
      await refreshDevelopmentActivity();
      showFeedback('success', 'Inicio solicitado. El estado se actualizará mientras los servicios publican sus puertos.');
    }).catch((error) => showFeedback('error', `No se pudo iniciar la aplicación: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-app-stop]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['appStop'];
    const runId = button.dataset['runId'];
    if (id === undefined || runId === undefined) return;
    void withBusyButton(button, 'Deteniendo…', () => window.desktop.stopApplication(id, runId)).then(async () => {
      await refreshDevelopmentActivity();
      showFeedback('success', 'La aplicación y sus procesos administrados se detuvieron.');
    }).catch((error) => showFeedback('error', `No se pudo detener la aplicación: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-app-delete]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['appDelete'];
    const application = applications.find((candidate) => candidate.id === id);
    if (id === undefined || application === undefined || !window.confirm(`¿Eliminar ${application.name}? Los proyectos y archivos no se borrarán.`)) return;
    void withBusyButton(button, 'Eliminando…', () => window.desktop.removeApplication(id)).then(async () => {
      await refreshApplications(false);
      showFeedback('success', 'Aplicación eliminada sin borrar proyectos ni archivos.');
    }).catch((error) => showFeedback('error', `No se pudo eliminar la aplicación: ${errorMessage(error)}`));
  }));
}

function attachHandlers(): void {
  renderDetectedCommandsList();
  bindApplicationActions();

  const openV1Project = (): void => {
    v1ProjectDraft = { name: '', description: '', rootPath: '', trustMode: 'guided' };
    render();
  };
  document.querySelector('#show-v1-project')?.addEventListener('click', openV1Project);
  document.querySelector('#show-v1-project-empty')?.addEventListener('click', openV1Project);
  document.querySelector('#v1-project-cancel')?.addEventListener('click', () => { v1ProjectDraft = undefined; render(); });
  document.querySelector('#v1-project-pick')?.addEventListener('click', () => {
    void window.desktop.pickFolder().then((picked) => {
      if (picked === undefined || v1ProjectDraft === undefined) return;
      v1ProjectDraft = { ...v1ProjectDraft, rootPath: picked };
      const root = document.querySelector<HTMLInputElement>('#v1-project-root');
      if (root !== null) root.value = picked;
      if (v1ProjectDraft.name === '') {
        const inferred = picked.replace(/[\\/]$/, '').split(/[\\/]/).at(-1) ?? '';
        v1ProjectDraft = { ...v1ProjectDraft, name: inferred };
        const name = document.querySelector<HTMLInputElement>('#v1-project-name');
        if (name !== null) name.value = inferred;
      }
    }).catch((error) => {
      const target = document.querySelector<HTMLElement>('#v1-project-error');
      if (target !== null) target.textContent = errorMessage(error);
    });
  });
  document.querySelectorAll<HTMLInputElement>('input[name="v1-trust"]').forEach((input) => input.addEventListener('change', () => {
    if (v1ProjectDraft !== undefined && input.checked) v1ProjectDraft = { ...v1ProjectDraft, trustMode: input.value as ProjectTrustMode };
  }));
  document.querySelector('#v1-project-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (v1ProjectDraft === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('#v1-project-save');
    const target = form.querySelector<HTMLElement>('#v1-project-error');
    const name = form.querySelector<HTMLInputElement>('#v1-project-name')?.value.trim() ?? '';
    const description = form.querySelector<HTMLInputElement>('#v1-project-description')?.value.trim() ?? '';
    const rootPath = form.querySelector<HTMLInputElement>('#v1-project-root')?.value ?? '';
    if (name === '' || rootPath === '') { if (target !== null) target.textContent = 'Escribe un nombre y elige una carpeta.'; return; }
    const draft = { ...v1ProjectDraft, name, description, rootPath };
    if (button !== null) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Analizando…'; }
    void window.desktop.createV1Project(draft).then(async () => {
      v1ProjectDraft = undefined;
      feedback = { kind: 'success', message: 'Proyecto listo. ChatGPT ya puede usar el nivel de confianza que elegiste.' };
      await Promise.all([refreshV1Projects(false), refreshAssistedProjects(false), refreshWorkspaces(false)]);
      render();
    }).catch((error) => {
      if (target !== null) target.textContent = errorMessage(error);
      if (button !== null) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = 'Crear proyecto'; }
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-v1-rescan]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['v1Rescan'];
    if (projectId === undefined) return;
    v1BusyProjectId = projectId; render();
    void window.desktop.rescanV1Project(projectId).then(async () => { v1BusyProjectId = undefined; await refreshV1Projects(false); render(); })
      .catch((error) => { v1BusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-v1-full]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['v1Full']; if (projectId === undefined) return;
    v1BusyProjectId = projectId; render();
    void window.desktop.setV1ProjectTrust(projectId, 'full-host').then(async () => { v1BusyProjectId = undefined; await refreshV1Projects(false); render(); })
      .catch((error) => { v1BusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-v1-guided]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['v1Guided']; if (projectId === undefined) return;
    v1BusyProjectId = projectId; render();
    void window.desktop.setV1ProjectTrust(projectId, 'guided').then(async () => { v1BusyProjectId = undefined; await refreshV1Projects(false); render(); })
      .catch((error) => { v1BusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-v1-revoke]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['v1Revoke']; if (projectId === undefined) return;
    if (!window.confirm('¿Revocar acceso y detener toda la actividad de este proyecto? No se borrarán archivos.')) return;
    v1BusyProjectId = projectId; render();
    void window.desktop.revokeV1ProjectTrust(projectId).then(async () => { v1BusyProjectId = undefined; await Promise.all([refreshV1Projects(false), refreshDevelopmentActivity()]); render(); })
      .catch((error) => { v1BusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));

  const openAssistedWizard = (): void => {
    assistedWizard = { step: 1, name: '', description: '', rootPath: '', access: 'web', policy: 'restricted', initializeGit: false };
    showAdoptProject = false;
    render();
  };
  document.querySelector('#show-assisted-wizard')?.addEventListener('click', openAssistedWizard);
  document.querySelector('#show-assisted-wizard-empty')?.addEventListener('click', openAssistedWizard);
  document.querySelector('#assisted-cancel')?.addEventListener('click', () => { assistedWizard = undefined; render(); });
  document.querySelector('#assisted-back')?.addEventListener('click', () => {
    if (assistedWizard === undefined || assistedWizard.step === 1) return;
    assistedWizard = { ...assistedWizard, step: (assistedWizard.step - 1) as 1 | 2 | 3 };
    render();
  });
  document.querySelector('#assisted-pick-folder')?.addEventListener('click', () => {
    void window.desktop.pickFolder().then((picked) => {
      if (picked === undefined || assistedWizard === undefined) return;
      assistedWizard = { ...assistedWizard, rootPath: picked };
      const input = document.querySelector<HTMLInputElement>('#assisted-root');
      if (input !== null) input.value = picked;
    }).catch((error) => {
      const target = document.querySelector<HTMLElement>('#assisted-error');
      if (target !== null) target.textContent = errorMessage(error);
    });
  });
  document.querySelectorAll<HTMLInputElement>('input[name="assisted-access"]').forEach((input) => input.addEventListener('change', () => {
    if (assistedWizard === undefined || !input.checked) return;
    assistedWizard = { ...assistedWizard, access: input.value as AssistedAccessPreset };
    render();
  }));
  document.querySelectorAll<HTMLInputElement>('input[name="assisted-policy"]').forEach((input) => input.addEventListener('change', () => {
    if (assistedWizard === undefined || !input.checked) return;
    assistedWizard = { ...assistedWizard, policy: input.value as SetupPolicy };
    render();
  }));
  document.querySelector<HTMLInputElement>('#assisted-git-init')?.addEventListener('change', (event) => {
    if (assistedWizard !== undefined) assistedWizard = { ...assistedWizard, initializeGit: (event.currentTarget as HTMLInputElement).checked };
  });
  document.querySelector('#assisted-next')?.addEventListener('click', () => {
    void (async () => {
      if (assistedWizard === undefined) return;
      const error = document.querySelector<HTMLElement>('#assisted-error');
      if (assistedWizard.step === 1) {
        const name = document.querySelector<HTMLInputElement>('#assisted-name')?.value.trim() ?? '';
        const description = document.querySelector<HTMLInputElement>('#assisted-description')?.value.trim() ?? '';
        const rootPath = document.querySelector<HTMLInputElement>('#assisted-root')?.value ?? assistedWizard.rootPath;
        if (name === '' || rootPath === '') {
          if (error !== null) error.textContent = 'Escribe un nombre y elige una carpeta.';
          return;
        }
        assistedWizard = { ...assistedWizard, name, description, rootPath, step: 2 };
        render();
        return;
      }
      if (assistedWizard.step < 4) {
        assistedWizard = { ...assistedWizard, step: (assistedWizard.step + 1) as 2 | 3 | 4 };
        render();
        return;
      }
      const draft = assistedWizard;
      const button = document.querySelector<HTMLButtonElement>('#assisted-next');
      if (button !== null) { button.disabled = true; button.textContent = 'Analizando…'; }
      try {
        await window.desktop.createAssistedProject({
          name: draft.name,
          ...(draft.description === '' ? {} : { description: draft.description }),
          rootPath: draft.rootPath,
          permissions: assistedProjectPermissions(draft),
          policy: draft.policy,
          initializeGit: draft.initializeGit,
        });
        assistedWizard = undefined;
        feedback = { kind: 'success', message: 'Proyecto autorizado y analizado. Revisa la propuesta antes de preparar dependencias.' };
        await Promise.all([refreshWorkspaces(false), refreshApplications(false), refreshAssistedProjects(false)]);
        render();
      } catch (caught) {
        if (error !== null) error.textContent = errorMessage(caught);
        if (button !== null) { button.disabled = false; button.textContent = 'Crear y analizar'; }
      }
    })();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-assisted-refresh]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['assistedRefresh'];
    if (projectId === undefined) return;
    assistedBusyProjectId = projectId;
    render();
    void window.desktop.refreshAssistedProject(projectId).then(async () => {
      assistedBusyProjectId = undefined;
      await refreshAssistedProjects(false);
      render();
    }).catch((error) => { assistedBusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));
  document.querySelectorAll<HTMLSelectElement>('[data-assisted-policy]').forEach((select) => select.addEventListener('change', () => {
    const projectId = select.dataset['assistedPolicy'];
    const policy = select.value;
    if (projectId === undefined || (policy !== 'restricted' && policy !== 'compatible' && policy !== 'manual')) return;
    assistedBusyProjectId = projectId;
    render();
    void window.desktop.setAssistedProjectPolicy(projectId, policy).then(async () => {
      assistedBusyProjectId = undefined;
      await refreshAssistedProjects(false);
      render();
    }).catch((error) => { assistedBusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-assisted-approve]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['assistedApprove'];
    const planSha = button.dataset['planSha'];
    if (projectId === undefined || planSha === undefined) return;
    assistedBusyProjectId = projectId;
    render();
    void window.desktop.approveAssistedProject(projectId, planSha).then(async () => {
      assistedBusyProjectId = undefined;
      feedback = { kind: 'success', message: 'Preparación completada y configuración local verificada.' };
      await Promise.all([refreshWorkspaces(false), refreshApplications(false), refreshAssistedProjects(false)]);
      render();
    }).catch(async (error) => {
      assistedBusyProjectId = undefined;
      await refreshAssistedProjects(false);
      showFeedback('error', errorMessage(error));
    });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-assisted-cancel-run]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['assistedCancelRun'];
    if (projectId === undefined) return;
    void window.desktop.cancelAssistedProject(projectId).then(() => refreshAssistedProjects()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-assisted-remove]').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset['assistedRemove'];
    if (projectId === undefined) return;
    assistedBusyProjectId = projectId;
    render();
    void window.desktop.removeDevelopmentProject(projectId).then(async (result) => {
      assistedBusyProjectId = undefined;
      if (!result.removed) { render(); return; }
      const shared = result.sharedWorkspacesKept + result.sharedApplicationsKept;
      feedback = {
        kind: 'success',
        message: `Desarrollo eliminado de LocalBridge: ${result.workspacesRemoved} carpeta(s) autorizada(s) y ${result.applicationsRemoved} aplicación(es) retiradas.${shared > 0 ? ` ${shared} configuración(es) compartida(s) se conservaron.` : ''} Los archivos reales permanecen en el disco.`,
      };
      await Promise.all([
        refreshAssistedProjects(false), refreshV1Projects(false), refreshWorkspaces(false), refreshApplications(false),
      ]);
      render();
    }).catch((error) => { assistedBusyProjectId = undefined; showFeedback('error', errorMessage(error)); });
  }));

  document.querySelector('#show-adopt-project')?.addEventListener('click', () => { showAdoptProject = true; assistedWizard = undefined; render(); });
  document.querySelector('#cancel-adopt-project')?.addEventListener('click', () => { showAdoptProject = false; render(); });
  document.querySelector('#adopt-project-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const workspaceIds = data.getAll('workspaceId').map(String);
    const applicationId = String(data.get('applicationId') ?? '');
    const target = form.querySelector<HTMLElement>('#adopt-error');
    if (workspaceIds.length === 0) { if (target !== null) target.textContent = 'Selecciona al menos una carpeta.'; return; }
    void window.desktop.adoptDevelopmentProject({ name: String(data.get('name') ?? ''), workspaceIds, ...(applicationId === '' ? {} : { applicationId }) }).then(async () => {
      showAdoptProject = false;
      feedback = { kind: 'success', message: 'Configuración existente agrupada sin modificarla.' };
      await refreshAssistedProjects(false);
      render();
    }).catch((error) => { if (target !== null) target.textContent = errorMessage(error); });
  });

  document.querySelector('#add-public-web-profile')?.addEventListener('click', () => {
    void window.desktop.createWebProfile({ kind: 'public-research', name: 'Investigación pública' }).then((snapshot) => {
      webProfiles = snapshot;
      feedback = { kind: 'success', message: 'Perfil creado y deshabilitado. Revisa su alcance y pulsa Habilitar acceso.' };
      render();
    }).catch((error) => showFeedback('error', `No se pudo crear el perfil web: ${errorMessage(error)}`));
  });
  document.querySelector<HTMLButtonElement>('#enable-web-browsing')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const download = document.querySelector<HTMLInputElement>('#enable-web-download')?.checked === true;
    void withBusyButton(button, 'Habilitando…', () => window.desktop.enableWebBrowsing(webProfiles.sha256, download)).then((snapshot) => {
      webProfiles = snapshot;
      feedback = { kind: 'success', message: 'Navegación por Internet habilitada. ChatGPT ya puede iniciar sesiones aisladas.' };
      render();
    }).catch((error) => showFeedback('error', `No se pudo habilitar Internet: ${errorMessage(error)}`));
  });
  document.querySelector<HTMLFormElement>('#create-account-web-profile')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const lines = (name: string): string[] => String(data.get(name) ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const errorTarget = form.querySelector<HTMLElement>('#web-profile-form-error');
    void window.desktop.createWebProfile({
      kind: 'site-account',
      name: String(data.get('name') ?? ''),
      destinations: lines('destinations'),
      supportHosts: lines('supportHosts'),
    }).then((snapshot) => {
      webProfiles = snapshot;
      feedback = { kind: 'success', message: 'Perfil con cuenta creado y deshabilitado. Habilítalo cuando termines de revisar los dominios.' };
      render();
    }).catch((error) => {
      if (errorTarget !== null) errorTarget.textContent = errorMessage(error);
    });
  });
  document.querySelector('#reset-web-profiles')?.addEventListener('click', () => {
    if (webProfiles.sha256 === null) return;
    void window.desktop.resetWebProfiles(webProfiles.sha256).then((snapshot) => {
      webProfiles = snapshot;
      webActivity = [];
      feedback = { kind: 'success', message: 'Perfiles web restablecidos. Internet volvió a quedar deshabilitado.' };
      render();
    }).catch((error) => showFeedback('error', `No se pudo restablecer el registro web: ${errorMessage(error)}`));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-web-toggle]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webToggle'];
    const profile = webProfiles.document.profiles.find((candidate) => candidate.id === id);
    if (profile === undefined) return;
    void window.desktop.updateWebProfile(webProfiles.sha256, { ...profile, enabled: !profile.enabled }).then(async (snapshot) => {
      webProfiles = snapshot;
      await refreshWebState(false);
      feedback = { kind: 'success', message: profile.enabled ? 'Perfil deshabilitado y sesiones cerradas.' : 'Acceso web habilitado para este perfil.' };
      render();
    }).catch((error) => showFeedback('error', `No se pudo cambiar el perfil web: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLSelectElement>('[data-web-transfer-policy]').forEach((select) => select.addEventListener('change', () => {
    const id = select.dataset['webProfile'];
    if (id === undefined) return;
    const adaptive = select.value === 'adaptive';
    document.querySelectorAll<HTMLSelectElement>(`select[data-web-profile="${id}"][data-web-limit]`)
      .forEach((limit) => { limit.disabled = adaptive; });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-save]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webSave'];
    const profile = webProfiles.document.profiles.find((candidate) => candidate.id === id);
    if (profile === undefined) return;
    const checked = (permission: string): boolean => document.querySelector<HTMLInputElement>(`input[data-web-profile="${id}"][data-web-permission="${permission}"]`)?.checked === true;
    const permissions = {
      read: true,
      interact: checked('interact'),
      download: checked('download'),
      humanControl: profile.kind === 'site-account' && checked('humanControl'),
    };
    const limit = (name: string, fallback: number): number => Number(
      document.querySelector<HTMLSelectElement>(`select[data-web-profile="${id}"][data-web-limit="${name}"]`)?.value ?? fallback,
    );
    const limits = {
      ...profile.limits,
      maxDownloadBytes: limit('maxDownloadBytes', profile.limits.maxDownloadBytes),
      maxTotalDownloadBytes: limit('maxTotalDownloadBytes', profile.limits.maxTotalDownloadBytes),
      transferPolicy: {
        mode: document.querySelector<HTMLSelectElement>(`select[data-web-profile="${id}"][data-web-transfer-policy]`)?.value === 'adaptive'
          ? 'adaptive' as const
          : 'fixed' as const,
      },
    };
    void window.desktop.updateWebProfile(webProfiles.sha256, { ...profile, permissions, limits }).then(async (snapshot) => {
      webProfiles = snapshot;
      await refreshWebState(false);
      feedback = { kind: 'success', message: 'Configuración web guardada. Las sesiones continúan si no cambió su autoridad.' };
      render();
    }).catch((error) => showFeedback('error', `No se pudieron guardar los permisos web: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-remove]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webRemove'];
    if (id === undefined) return;
    void window.desktop.removeWebProfile(webProfiles.sha256, id).then(async (snapshot) => {
      webProfiles = snapshot;
      await refreshWebState(false);
      feedback = { kind: 'success', message: 'Perfil web eliminado y sus sesiones cerradas.' };
      render();
    }).catch((error) => showFeedback('error', `No se pudo eliminar el perfil web: ${errorMessage(error)}`));
  }));
  document.querySelector('#refresh-web-activity')?.addEventListener('click', () => { void refreshWebState(); });
  document.querySelectorAll<HTMLButtonElement>('[data-web-viewport]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['webViewport'];
    const tabId = button.dataset['webTabId'];
    const width = Number(button.dataset['viewportWidth']);
    const height = Number(button.dataset['viewportHeight']);
    const mobile = button.dataset['viewportMobile'] === 'true';
    if (sessionId === undefined || tabId === undefined || !Number.isInteger(width) || !Number.isInteger(height)) return;
    void withBusyButton(button, 'Aplicando…', () => window.desktop.setWebViewport(sessionId, tabId, width, height, mobile))
      .then(() => refreshWebState())
      .catch((error) => showFeedback('error', `No se pudo cambiar el viewport web: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-take]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webTake'];
    const tabId = button.dataset['webTabId'];
    if (id === undefined || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Entregando control…';
    void window.desktop.takeWebHumanControl(id, tabId).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-cycle]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['webSessionId'];
    const direction = button.dataset['webCycle'];
    if (sessionId === undefined || (direction !== 'previous' && direction !== 'next')) return;
    void window.desktop.cycleWebHumanTab(sessionId, direction).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-return]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webReturn'];
    if (id !== undefined) void window.desktop.returnWebHumanControl(id).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-decline]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webDecline'];
    if (id !== undefined) void window.desktop.declineWebHumanControl(id).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-stop]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset['webStop'];
    if (id !== undefined) void window.desktop.stopWebSession(id).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-view-follow]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['webViewFollow'];
    if (sessionId === undefined) return;
    const displayId = selectedWebLiveViewerDisplayId(sessionId);
    void window.desktop.showWebLiveViewer(sessionId, 'follow', displayId, undefined, rememberedViewerPresentationMode()).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-view-pinned]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['webViewPinned'];
    const tabId = button.dataset['webTabId'];
    if (sessionId === undefined || tabId === undefined) return;
    const displayId = selectedWebLiveViewerDisplayId(sessionId);
    void window.desktop.showWebLiveViewer(sessionId, 'pinned', displayId, tabId, rememberedViewerPresentationMode()).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-hide-viewer]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['webHideViewer'];
    if (sessionId !== undefined) void window.desktop.hideWebLiveViewer(sessionId).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
  }));
  document.querySelectorAll<HTMLSelectElement>('[data-web-live-display]').forEach((select) => select.addEventListener('change', () => {
    const sessionId = select.dataset['webLiveDisplay'];
    if (sessionId === undefined || select.value === '') return;
    rememberLiveViewerDisplayId(select.value);
    if (webLiveViewer.visible && webLiveViewer.sessionId === sessionId) {
      void window.desktop.moveWebLiveViewer(sessionId, select.value).then(() => refreshWebState()).catch((error) => showFeedback('error', errorMessage(error)));
    }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-viewer-presentation="web"]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['sessionId'];
    const mode = button.dataset['mode'];
    const panX = Number(button.dataset['panX']);
    const panY = Number(button.dataset['panY']);
    if (sessionId === undefined || (mode !== 'fit' && mode !== 'actual') || !Number.isInteger(panX) || !Number.isInteger(panY)) return;
    rememberViewerPresentationMode(mode);
    void withBusyButton(button, 'Aplicando…', () => window.desktop.setWebLiveViewerPresentation(sessionId, mode, panX, panY))
      .then(() => refreshWebState())
      .catch((error) => showFeedback('error', `No se pudo ajustar el visor web: ${errorMessage(error)}`));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-web-cancel-motion]').forEach((button) => button.addEventListener('click', () => {
    const sessionId = button.dataset['webCancelMotion'];
    const tabId = button.dataset['webTabId'];
    if (sessionId === undefined || tabId === undefined) return;
    void withBusyButton(button, 'Cancelando…', () => window.desktop.cancelWebMotion(sessionId, tabId))
      .then(() => refreshWebState())
      .catch((error) => showFeedback('error', `No se pudo cancelar la captura: ${errorMessage(error)}`));
  }));

  document.querySelectorAll<HTMLButtonElement>('[data-section], [data-section-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset['section'] ?? button.dataset['sectionTarget'];
      if (section !== 'home' && section !== 'web' && section !== 'assisted' && section !== 'projects' && section !== 'applications' && section !== 'connection' && section !== 'activity' && section !== 'settings') return;
      if (section !== 'activity') stopBrowserViewer();
      activeSection = section;
      sidebarOpen = false;
      feedback = undefined;
      render();
      document.querySelector<HTMLElement>('#main-content')?.focus({ preventScroll: true });
      if (section === 'activity') void Promise.all([refreshDevelopmentActivity(false), refreshWebState(false)]).then(async () => {
        render();
        await refreshAudit();
      });
      if (section === 'web') void refreshWebState();
    });
  });

  document.querySelector('#nav-toggle')?.addEventListener('click', () => {
    sidebarOpen = !sidebarOpen;
    render();
    (sidebarOpen
      ? document.querySelector<HTMLButtonElement>('.sidebar nav button[aria-current="page"]')
      : document.querySelector<HTMLButtonElement>('#nav-toggle'))?.focus();
  });
  document.querySelector('#close-navigation')?.addEventListener('click', () => {
    sidebarOpen = false;
    render();
    document.querySelector<HTMLButtonElement>('#nav-toggle')?.focus();
  });
  document.querySelector('.app-shell')?.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape' || !sidebarOpen) return;
    sidebarOpen = false;
    render();
    document.querySelector<HTMLButtonElement>('#nav-toggle')?.focus();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-workspace-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset['workspaceTab'];
      if (tab !== 'general' && tab !== 'access' && tab !== 'services' && tab !== 'advanced') return;
      const form = document.querySelector<HTMLFormElement>('#workspace-form');
      if (form !== null) syncWorkspaceDraftFromForm(form);
      activeWorkspaceFormTab = tab;
      render();
      document.querySelector<HTMLButtonElement>(`[data-workspace-tab="${tab}"]`)?.focus();
    });
  });

  document.querySelector('#hide-app')?.addEventListener('click', () => {
    stopBrowserViewer();
    void window.desktop.hideApp().catch((error) => showFeedback('error', `No se pudo minimizar: ${errorMessage(error)}`));
  });
  document.querySelector('#quit-app')?.addEventListener('click', () => {
    stopBrowserViewer();
    void window.desktop.quitApp().catch((error) => showFeedback('error', `No se pudo cerrar: ${errorMessage(error)}`));
  });
  document.querySelector<HTMLButtonElement>('#refresh-development')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    void withBusyButton(button, 'Actualizando…', async () => {
      await Promise.all([refreshDevelopmentActivity(false), refreshWebState(false)]);
      render();
    })
      .catch((error) => showFeedback('error', `No se pudo actualizar la actividad: ${errorMessage(error)}`));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-activity-filter]').forEach((button) => button.addEventListener('click', () => {
    const filter = button.dataset['activityFilter'];
    if (filter !== 'all' && filter !== 'browsers' && filter !== 'resources') return;
    activityFilter = filter;
    if (button.closest('.activity-intervention') !== null) {
      activityDisclosureState = { ...activityDisclosureState, runtime: true };
      saveActivityDisclosureState();
    }
    render();
  }));
  bindActivityDisclosureActions();
  document.querySelector<HTMLButtonElement>('#stop-all-development')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    stopBrowserViewer();
    void withBusyButton(button, 'Deteniendo…', () => window.desktop.stopAllDevelopmentActivity())
      .then(async () => {
        await refreshDevelopmentActivity();
        showFeedback('success', 'Todos los entornos de desarrollo se detuvieron.');
      })
      .catch((error) => showFeedback('error', `No se pudieron detener los entornos: ${errorMessage(error)}`));
  });
  bindDevelopmentHumanControlActions();
  document.querySelector('#close-browser-viewer')?.addEventListener('click', () => {
    const sessionId = browserViewerSessionId;
    stopBrowserViewer();
    render();
    if (sessionId !== undefined) document.querySelector<HTMLButtonElement>(`[data-view-browser="${sessionId}"]`)?.focus();
  });
  document.querySelector('.browser-viewer-backdrop')?.addEventListener('keydown', (event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape') {
      keyboard.preventDefault();
      (document.querySelector<HTMLButtonElement>('#close-browser-viewer'))?.click();
      return;
    }
    if (keyboard.key !== 'Tab') return;
    const focusable = [...document.querySelectorAll<HTMLElement>('.browser-viewer button:not(:disabled), .browser-viewer select:not(:disabled), .browser-viewer [tabindex="0"]')];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (keyboard.shiftKey && document.activeElement === first) {
      keyboard.preventDefault();
      last.focus();
    } else if (!keyboard.shiftKey && document.activeElement === last) {
      keyboard.preventDefault();
      first.focus();
    }
  });

  const workspaceForm = document.querySelector<HTMLFormElement>('#workspace-form');
  workspaceForm?.addEventListener('input', () => syncWorkspaceDraftFromForm(workspaceForm));
  workspaceForm?.addEventListener('change', () => syncWorkspaceDraftFromForm(workspaceForm));
  workspaceForm?.querySelector<HTMLSelectElement>('#large-artifact-mode')?.addEventListener('change', () => {
    syncWorkspaceDraftFromForm(workspaceForm);
    render();
    document.querySelector<HTMLSelectElement>('#large-artifact-mode')?.focus();
  });
  workspaceForm?.querySelector<HTMLInputElement>('input[name="perm-browserHumanControl"]')?.addEventListener('change', (event) => {
    if (!(event.currentTarget as HTMLInputElement).checked) return;
    const read = workspaceForm.querySelector<HTMLInputElement>('input[name="perm-browserRead"]');
    if (read !== null) read.checked = true;
    syncWorkspaceDraftFromForm(workspaceForm);
  });

  const settingsForm = document.querySelector<HTMLFormElement>('#settings-form');
  settingsForm?.addEventListener('input', () => syncSettingsDraftFromForm(settingsForm));
  settingsForm?.addEventListener('change', () => syncSettingsDraftFromForm(settingsForm));
  settingsForm?.querySelector<HTMLInputElement>('input[name="tunnelId"]')?.addEventListener('input', (event) => {
    clearFieldError(event.currentTarget as HTMLInputElement, 'tunnel-id-error');
  });
  const advancedSettingsForm = document.querySelector<HTMLFormElement>('#advanced-settings-form');
  advancedSettingsForm?.addEventListener('input', () => syncSettingsDraftFromForm(advancedSettingsForm));
  advancedSettingsForm?.addEventListener('change', () => syncSettingsDraftFromForm(advancedSettingsForm));

  document.querySelector<HTMLSelectElement>('#permission-preset')?.addEventListener('change', (event) => {
    const preset = (event.target as HTMLSelectElement).value;
    const values: WorkspacePermissions | undefined =
      preset === 'readOnly'
        ? { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: false, browserRead: false, browserInteract: false, browserHumanControl: false }
        : preset === 'edit'
          ? { read: true, write: true, overwrite: true, gitRead: true, validations: false, gitWrite: false, processes: false, browserRead: false, browserInteract: false, browserHumanControl: false }
          : preset === 'development'
            ? { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: true, processes: false, browserRead: false, browserInteract: false, browserHumanControl: false }
            : undefined;
    if (values === undefined || workspaceForm === null) return;
    for (const key of PERMISSION_KEYS) {
      const checkbox = workspaceForm.querySelector<HTMLInputElement>(`input[name="perm-${key}"]`);
      if (checkbox !== null) checkbox.checked = values[key] === true;
    }
    const warning = document.querySelector<HTMLParagraphElement>('#permission-warning');
    if (warning !== null) {
      warning.className = `risk-note risk-${permissionRisk(values)}`;
      warning.textContent =
        preset === 'development'
          ? 'Desarrollo completo permite cambios de archivos y Git. Las acciones críticas de Git siguen pidiendo aprobación.'
          : 'Puedes revisar cada permiso antes de guardar.';
    }
    syncWorkspaceDraftFromForm(workspaceForm);
  });

  document.querySelectorAll<HTMLButtonElement>('[data-onboarding-next]').forEach((button) => {
    button.addEventListener('click', () => {
      void (async () => {
        onboardingBusy = 'navigation';
        render();
        try {
          adoptOnboardingSnapshot(await window.desktop.nextOnboarding());
          feedback = undefined;
        } catch (error) {
          feedback = { kind: 'error', message: `No se pudo continuar: ${errorMessage(error)}` };
        } finally {
          onboardingBusy = undefined;
          render();
        }
      })();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-onboarding-back]').forEach((button) => {
    button.addEventListener('click', () => {
      void (async () => {
        onboardingBusy = 'navigation';
        render();
        try {
          adoptOnboardingSnapshot(await window.desktop.backOnboarding());
          feedback = undefined;
        } catch (error) {
          feedback = { kind: 'error', message: `No se pudo volver: ${errorMessage(error)}` };
        } finally {
          onboardingBusy = undefined;
          render();
        }
      })();
    });
  });
  document.querySelector('#complete-onboarding')?.addEventListener('click', () => {
    void (async () => {
      const snapshot = onboardingSnapshotState;
      if (snapshot === undefined || snapshot.folder === undefined || snapshot.draft.trustMode === undefined || snapshot.draft.guidedPreset === undefined) return;
      const input: OnboardingCompletionDraft = snapshot.draft.existingProjectId === undefined
        ? {
            kind: 'selection',
            folderSelectionId: snapshot.folder.selectionId,
            name: onboardingProjectName.trim(),
            ...(onboardingProjectDescription.trim() === '' ? {} : { description: onboardingProjectDescription.trim() }),
            trustMode: snapshot.draft.trustMode,
            guidedPreset: snapshot.draft.guidedPreset,
          }
        : {
            kind: 'existing',
            projectId: snapshot.draft.existingProjectId,
            trustMode: snapshot.draft.trustMode,
            guidedPreset: snapshot.draft.guidedPreset,
          };
      if (input.kind === 'selection' && (input.name.length < 1 || input.name.length > 80)) {
        showFeedback('error', 'Escribe un nombre de proyecto de hasta 80 caracteres.');
        return;
      }
      onboardingBusy = 'complete';
      render();
      try {
        adoptOnboardingSnapshot(await window.desktop.completeOnboarding(input));
        feedback = { kind: 'success', message: 'LocalBridge quedó configurado y el proyecto está listo.' };
        await Promise.all([refreshV1Projects(false), refreshWorkspaces(false)]);
      } catch (error) {
        feedback = { kind: 'error', message: `No se pudo finalizar: ${errorMessage(error)}` };
      } finally {
        onboardingBusy = undefined;
        render();
      }
    })();
  });
  document.querySelector('#restart-onboarding')?.addEventListener('click', () => {
    void (async () => {
      try {
        runtimeReport = undefined;
        onboardingRuntimeAutoStarted = false;
        onboardingTunnelReady = false;
        onboardingProjectName = '';
        onboardingProjectDescription = '';
        adoptOnboardingSnapshot(await window.desktop.restartOnboarding());
        feedback = undefined;
        render();
      } catch (error) {
        showFeedback('error', `No se pudo reiniciar el asistente: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector('#onboarding-pick-folder')?.addEventListener('click', () => {
    void (async () => {
      onboardingBusy = 'folder';
      render();
      try {
        const result = await window.desktop.pickOnboardingProjectFolder();
        if (result !== undefined) {
          onboardingProjectName = result.folder.existingProjectName ?? result.folder.suggestedName;
          onboardingProjectDescription = '';
          adoptOnboardingSnapshot(result.snapshot);
          feedback = result.folder.existingProjectId === undefined
            ? { kind: 'success', message: 'Estructura detectada en modo lectura. Todavía no se concedió acceso.' }
            : { kind: 'success', message: 'La carpeta ya estaba registrada; se usará el proyecto existente.' };
        }
      } catch (error) {
        feedback = { kind: 'error', message: `No se pudo analizar la carpeta: ${errorMessage(error)}` };
      } finally {
        onboardingBusy = undefined;
        render();
      }
    })();
  });

  document.querySelector<HTMLInputElement>('#onboarding-project-name')?.addEventListener('input', (event) => {
    onboardingProjectName = (event.currentTarget as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#onboarding-project-description')?.addEventListener('input', (event) => {
    onboardingProjectDescription = (event.currentTarget as HTMLTextAreaElement).value;
  });

  document.querySelector('#onboarding-confirm-access')?.addEventListener('click', () => {
    void (async () => {
      const trust = document.querySelector<HTMLInputElement>('input[name="onboarding-trust"]:checked')?.value;
      const preset = document.querySelector<HTMLInputElement>('input[name="onboarding-preset"]:checked')?.value;
      if ((trust !== 'guided' && trust !== 'full-host') || (preset !== 'review' && preset !== 'develop' && preset !== 'complete')) return;
      onboardingBusy = 'access';
      render();
      try {
        adoptOnboardingSnapshot(await window.desktop.setOnboardingAccess({ trustMode: trust, guidedPreset: preset }));
        feedback = { kind: 'success', message: 'Nivel de acceso preparado. Se aplicará solo al finalizar.' };
      } catch (error) {
        feedback = { kind: 'error', message: `No se pudo preparar el acceso: ${errorMessage(error)}` };
      } finally {
        onboardingBusy = undefined;
        render();
      }
    })();
  });

  document.querySelector('#run-runtime-check')?.addEventListener('click', (event) => {
    void (async () => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      button.textContent = 'Comprobando…';
      if (onboardingSnapshotState?.state.status !== 'completed') {
        await runOnboardingRuntimeCheck();
        return;
      }
      try {
        runtimeReport = await window.desktop.checkRuntime();
        showFeedback(runtimeReport.ready ? 'success' : 'error', runtimeReport.ready ? 'Todos los componentes están listos.' : 'Hay componentes que requieren atención.');
      } catch (error) {
        showFeedback('error', `No se pudo comprobar el sistema: ${errorMessage(error)}`);
      } finally {
        onboardingBusy = undefined;
        render();
      }
    })();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-external]').forEach((button) => {
    button.addEventListener('click', () => {
      const destination = button.dataset['external'];
      if (destination !== 'tunnels' && destination !== 'runtimeKeys' && destination !== 'chatgptConnectors') return;
      void window.desktop.openExternal(destination).catch((error) =>
        showFeedback('error', `No se pudo abrir el enlace: ${errorMessage(error)}`),
      );
    });
  });

  document.querySelector<HTMLSelectElement>('#connection-profile')?.addEventListener('change', (event) => {
    void window.desktop
      .selectConnectionProfile((event.target as HTMLSelectElement).value)
      .then(adoptSettings)
      .catch((error) => showFeedback('error', `No se pudo cambiar de perfil: ${errorMessage(error)}`));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-select-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['selectProfile'];
      if (id === undefined) return;
      void window.desktop.selectConnectionProfile(id).then(adoptSettings).catch((error) => showFeedback('error', `No se pudo cambiar de perfil: ${errorMessage(error)}`));
    });
  });
  document.querySelector('#create-profile-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget as HTMLFormElement).get('profileName') ?? '');
    void window.desktop.createConnectionProfile(name).then(adoptSettings).catch((error) => showFeedback('error', `No se pudo crear el perfil: ${errorMessage(error)}`));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-remove-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['removeProfile'];
      if (id === undefined) return;
      const profile = settingsDraft.connectionProfiles.find((candidate) => candidate.id === id);
      if (profile === undefined) return;
      // eslint-disable-next-line no-alert -- confirmación local antes de eliminar la clave cifrada asociada
      if (!window.confirm(`¿Eliminar el perfil “${profile.name}”? Su clave cifrada local también se eliminará.`)) return;
      void window.desktop.removeConnectionProfile(id).then(adoptSettings).catch((error) => showFeedback('error', `No se pudo eliminar el perfil: ${errorMessage(error)}`));
    });
  });

  document.querySelector('#export-portable')?.addEventListener('click', () => {
    void window.desktop.exportPortableConfig('v5').then((saved) => {
      if (saved) showFeedback('success', 'Configuración exportada sin claves ni rutas locales.');
    }).catch((error) => showFeedback('error', `No se pudo exportar: ${errorMessage(error)}`));
  });
  document.querySelector('#export-portable-v4')?.addEventListener('click', () => {
    void window.desktop.exportPortableConfig('v4').then((saved) => {
      if (saved) showFeedback('success', 'Configuración compatible con v0.8 exportada sin proyectos asistidos, claves ni rutas locales.');
    }).catch((error) => showFeedback('error', `No se pudo exportar: ${errorMessage(error)}`));
  });
  document.querySelector('#select-portable-import')?.addEventListener('click', () => {
    void window.desktop.selectPortableImport().then((selection) => {
      if (selection === undefined) return;
      portableImport = { ...selection, mapped: new Set() };
      render();
    }).catch((error) => showFeedback('error', `No se pudo leer la configuración: ${errorMessage(error)}`));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-map-workspace]').forEach((button) => {
    button.addEventListener('click', () => {
      const ref = button.dataset['mapWorkspace'];
      if (portableImport === undefined || ref === undefined) return;
      void window.desktop.mapPortableWorkspace(portableImport.sessionId, ref).then((mapped) => {
        if (!mapped || portableImport === undefined) return;
        portableImport.mapped.add(ref);
        render();
      }).catch((error) => showFeedback('error', `No se pudo remapear la carpeta: ${errorMessage(error)}`));
    });
  });
  document.querySelector('#apply-portable-import')?.addEventListener('click', () => {
    if (portableImport === undefined) return;
    void window.desktop.applyPortableImport(portableImport.sessionId).then(async (result) => {
      portableImport = undefined;
      settings = result.settings;
      settingsDraft = { ...result.settings };
      workspaces = [...result.workspaces];
      applications = [...result.applications];
      feedback = { kind: 'success', message: `Configuración importada. ${result.importedProfileIds.length} perfil(es) requieren una clave nueva en este equipo.` };
      render();
      await refreshAssistedProjects();
    }).catch((error) => showFeedback('error', `No se pudo importar: ${errorMessage(error)}`));
  });

  document.querySelector<HTMLButtonElement>('#refresh-audit')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    auditVisibleCount = 20;
    void withBusyButton(button, 'Actualizando…', async () => {
      await Promise.all([refreshAudit(), refreshPendingApprovals()]);
    }).catch((error) => showFeedback('error', `No se pudo actualizar la auditoría: ${errorMessage(error)}`));
  });
  document.querySelector<HTMLSelectElement>('#audit-workspace')?.addEventListener('change', (event) => {
    auditVisibleCount = 20;
    const workspaceId = (event.target as HTMLSelectElement).value;
    const { workspaceId: _previousWorkspace, ...otherFilters } = auditFilters;
    auditFilters = workspaceId === '' ? otherFilters : { ...otherFilters, workspaceId };
    void refreshAudit();
  });
  document.querySelector<HTMLSelectElement>('#audit-outcome')?.addEventListener('change', (event) => {
    auditVisibleCount = 20;
    const outcome = (event.target as HTMLSelectElement).value;
    const { outcome: _previousOutcome, ...otherFilters } = auditFilters;
    auditFilters = outcome === 'success' || outcome === 'error' ? { ...otherFilters, outcome } : otherFilters;
    void refreshAudit();
  });
  document.querySelector<HTMLSelectElement>('#audit-action')?.addEventListener('change', (event) => {
    auditVisibleCount = 20;
    const action = (event.target as HTMLSelectElement).value;
    const { action: _previousAction, ...otherFilters } = auditFilters;
    auditFilters = action === '' ? otherFilters : { ...otherFilters, action };
    void refreshAudit();
  });

  document.querySelector<HTMLInputElement>('#log-search')?.addEventListener('input', (event) => {
    logFilter = (event.target as HTMLInputElement).value;
    if (logFilter !== '' && !activityDisclosureState.technicalLog) {
      activityDisclosureState = { ...activityDisclosureState, technicalLog: true };
      saveActivityDisclosureState();
    }
    const container = document.querySelector<HTMLDivElement>('#activity-log-container');
    if (container !== null) container.innerHTML = activityLogHtml();
  });
  document.querySelector('#copy-diagnostic')?.addEventListener('click', () => {
    void window.desktop
      .copyDiagnostic(diagnosticText())
      .then(() => showFeedback('success', 'Diagnóstico copiado con claves sensibles redactadas.'))
      .catch((error) => showFeedback('error', `No se pudo copiar el diagnóstico: ${errorMessage(error)}`));
  });
  document.querySelector('#export-diagnostic')?.addEventListener('click', () => {
    void window.desktop
      .exportDiagnostic(diagnosticText())
      .then((saved) => {
        if (saved) showFeedback('success', 'Diagnóstico exportado sin sobrescribir archivos existentes.');
      })
      .catch((error) => showFeedback('error', `No se pudo exportar el diagnóstico: ${errorMessage(error)}`));
  });
  document.querySelector('#clear-logs')?.addEventListener('click', () => {
    tunnelLogs = [];
    logFilter = '';
    render();
  });

  document.querySelector('#show-create-form')?.addEventListener('click', () => {
    showCreateForm = true;
    editingWorkspace = undefined;
    editingWorkspaceOriginId = undefined;
    workspaceFormDraft = draftFromWorkspace();
    activeWorkspaceFormTab = 'general';
    resetDetectedCommands();
    render();
    document.querySelector<HTMLInputElement>('#workspace-form input[name="name"]')?.focus();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="edit"]').forEach((button) => {
    button.addEventListener('click', () => {
      editingWorkspace = workspaces.find((w) => w.id === button.dataset['id']);
      if (editingWorkspace === undefined) return;
      editingWorkspaceOriginId = editingWorkspace.id;
      workspaceFormDraft = draftFromWorkspace(editingWorkspace);
      activeWorkspaceFormTab = 'general';
      showCreateForm = false;
      resetDetectedCommands();
      render();
      document.querySelector<HTMLInputElement>('#workspace-form input[name="name"]')?.focus();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="test"]').forEach((button) => {
    button.addEventListener('click', () => {
      void (async () => {
        const id = button.dataset['id'];
        if (id === undefined) return;
        button.disabled = true;
        button.textContent = 'Probando…';
        try {
          workspaceReports = { ...workspaceReports, [id]: await window.desktop.testWorkspace(id) };
          feedback = { kind: workspaceReports[id]?.ready === true ? 'success' : 'error', message: workspaceReports[id]?.ready === true ? 'La configuración local está lista.' : 'El proyecto requiere atención.' };
          if (workspaceReports[id]?.ready !== true) lastProblem = `El proyecto ${workspaces.find((workspace) => workspace.id === id)?.name ?? id} requiere atención.`;
          render();
        } catch (error) {
          showFeedback('error', `No se pudo probar el proyecto: ${errorMessage(error)}`);
        }
      })();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => {
      void (async () => {
        const id = button.dataset['id'];
        if (id === undefined) return;
        // eslint-disable-next-line no-alert -- app de escritorio de un solo usuario, confirmación nativa es suficiente
        if (!window.confirm(`¿Eliminar el workspace ${id}? Esto no borra la carpeta, solo la desautoriza.`)) return;
        try {
          await window.desktop.removeWorkspace(id);
          if (editingWorkspace?.id === id) {
            editingWorkspace = undefined;
            editingWorkspaceOriginId = undefined;
            workspaceFormDraft = undefined;
            resetDetectedCommands();
          }
          feedback = { kind: 'success', message: 'Workspace desautorizado.' };
          await refreshWorkspaces();
        } catch (error) {
          showFeedback('error', `No se pudo eliminar el workspace: ${errorMessage(error)}`);
        }
      })();
    });
  });

  document.querySelector('#cancel-form')?.addEventListener('click', () => {
    const originId = editingWorkspaceOriginId;
    showCreateForm = false;
    editingWorkspace = undefined;
    editingWorkspaceOriginId = undefined;
    workspaceFormDraft = undefined;
    activeWorkspaceFormTab = 'general';
    resetDetectedCommands();
    render();
    if (originId !== undefined) focusWorkspaceEditButton(originId);
    else document.querySelector<HTMLButtonElement>('#show-create-form')?.focus();
  });

  document.querySelector('#pick-folder')?.addEventListener('click', () => {
    void (async () => {
      try {
        const picked = await window.desktop.pickFolder();
        if (picked === undefined) return;
        const input = document.querySelector<HTMLInputElement>('input[name="rootPath"]');
        if (input !== null) input.value = picked;
        if (workspaceFormDraft !== undefined) workspaceFormDraft.rootPath = picked;
      } catch (error) {
        const errorEl = document.querySelector<HTMLParagraphElement>('#form-error');
        if (errorEl !== null) errorEl.textContent = `No se pudo elegir la carpeta: ${errorMessage(error)}`;
      }
    })();
  });

  document.querySelector('#detect-commands')?.addEventListener('click', () => {
    void (async () => {
      const rootPath = document.querySelector<HTMLInputElement>('input[name="rootPath"]')?.value ?? '';
      const errorEl = document.querySelector<HTMLParagraphElement>('#form-error');
      if (rootPath === '') {
        if (errorEl !== null) errorEl.textContent = 'Elige una carpeta antes de detectar comandos.';
        return;
      }
      try {
        detectedCommands = await window.desktop.detectProjectCommands(rootPath);
        selectedDetected = new Set();
        renderDetectedCommandsList();
        const authorizeAllButton = document.querySelector<HTMLButtonElement>('#authorize-all-detected');
        if (authorizeAllButton !== null) authorizeAllButton.disabled = detectedCommands.length === 0;
        const authorizeProcessButton = document.querySelector<HTMLButtonElement>('#authorize-process-detected');
        if (authorizeProcessButton !== null) authorizeProcessButton.disabled = detectedCommands.length === 0;
        if (errorEl !== null) {
          errorEl.textContent = detectedCommands.length === 0 ? 'No se detectaron comandos declarados.' : '';
        }
      } catch (error) {
        if (errorEl !== null) errorEl.textContent = `No se pudieron detectar comandos: ${errorMessage(error)}`;
      }
    })();
  });

  document.querySelector('#authorize-all-detected')?.addEventListener('click', () => {
    selectedDetected = new Set(detectedCommands.map((candidate) => candidate.name));
    renderDetectedCommandsList();
    applyDetectedSelectionToTextarea();
    enableValidationsPermissionForSelection();
  });

  document.querySelector('#authorize-process-detected')?.addEventListener('click', () => {
    if (selectedDetected.size === 0) selectedDetected = new Set(detectedCommands.map((candidate) => candidate.name));
    renderDetectedCommandsList();
    applyDetectedSelectionToProcessProfiles();
    const checkbox = document.querySelector<HTMLInputElement>('input[name="perm-processes"]');
    if (checkbox !== null) checkbox.checked = true;
    const form = document.querySelector<HTMLFormElement>('#workspace-form');
    if (form !== null) syncWorkspaceDraftFromForm(form);
  });

  document.querySelector('#workspace-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const errorEl = document.querySelector<HTMLParagraphElement>('#form-error');

      let validationProfiles: Record<string, string[]>;
      let processProfiles: Record<string, ProcessProfile>;
      let browserProfiles: Record<string, BrowserProfile>;
      try {
        validationProfiles = JSON.parse(String(data.get('validationProfiles') ?? '{}')) as Record<string, string[]>;
        processProfiles = JSON.parse(String(data.get('processProfiles') ?? '{}')) as Record<string, ProcessProfile>;
        browserProfiles = JSON.parse(String(data.get('browserProfiles') ?? '{}')) as Record<string, BrowserProfile>;
      } catch {
        if (errorEl !== null) errorEl.textContent = 'Alguno de los perfiles avanzados contiene JSON inválido.';
        return;
      }

      try {
        const originId = editingWorkspaceOriginId;
        if (editingWorkspace !== undefined) {
          await window.desktop.updateWorkspace({
            ...editingWorkspace,
            name: String(data.get('name')),
            rootPath: String(data.get('rootPath')),
            enabled: data.get('enabled') !== null,
            permissions: readPermissionsFromForm(form),
            limits: {
              ...editingWorkspace.limits,
              maxFileBytes: Number(data.get('maxFileBytes')),
              largeArtifacts: readLargeArtifactPolicy(data, editingWorkspace.limits.largeArtifacts),
            },
            validationProfiles,
            processProfiles,
            browserProfiles,
            automationReviewRequired: false,
          });
        } else {
          await window.desktop.createWorkspace({
            name: String(data.get('name')),
            rootPath: String(data.get('rootPath')),
            maxFileBytes: Number(data.get('maxFileBytes')),
            largeArtifacts: readLargeArtifactPolicy(data, workspaceFormDraft?.largeArtifacts ?? settingsDraft.largeArtifactPreference),
            permissions: readPermissionsFromForm(form),
            validationProfiles,
            processProfiles,
            browserProfiles,
            automationReviewRequired: false,
          });
        }
        showCreateForm = false;
        editingWorkspace = undefined;
        editingWorkspaceOriginId = undefined;
        workspaceFormDraft = undefined;
        resetDetectedCommands();
        feedback = { kind: 'success', message: 'Workspace guardado correctamente.' };
        await refreshWorkspaces();
        if (originId !== undefined) focusWorkspaceEditButton(originId);
      } catch (error) {
        if (errorEl !== null) errorEl.textContent = errorMessage(error);
      }
    })();
  });

  document.querySelector('#pick-binary')?.addEventListener('click', () => {
    void (async () => {
      try {
        const picked = await window.desktop.pickTunnelBinary();
        if (picked === undefined) return;
        settingsDraft = { ...settingsDraft, tunnelBinaryPath: picked };
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        showFeedback('success', 'Configuración guardada.');
      } catch (error) {
        showFeedback('error', `No se pudo guardar la configuración: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector('#pick-profile-dir')?.addEventListener('click', () => {
    void (async () => {
      try {
        const picked = await window.desktop.pickTunnelProfileDir();
        if (picked === undefined) return;
        settingsDraft = { ...settingsDraft, tunnelProfileDir: picked };
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        showFeedback('success', 'Configuración guardada.');
      } catch (error) {
        showFeedback('error', `No se pudo guardar la configuración: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector('#pick-server-cwd')?.addEventListener('click', () => {
    void (async () => {
      try {
        const picked = await window.desktop.pickFolder();
        if (picked === undefined) return;
        settingsDraft = { ...settingsDraft, serverCwd: picked };
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        showFeedback('success', 'Configuración guardada.');
      } catch (error) {
        showFeedback('error', `No se pudo guardar la configuración: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      try {
        if (!validateTunnelId(event.currentTarget as HTMLFormElement)) return;
        const modeChanged = settings.gitApprovalMode !== settingsDraft.gitApprovalMode;
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        const reconnectRequired = effectiveGitApprovalMode !== undefined && effectiveGitApprovalMode !== settings.gitApprovalMode;
        showFeedback('success', reconnectRequired
          ? 'Configuración guardada. Desconecta y conecta de nuevo para aplicar el modo de aprobación.'
          : modeChanged ? 'Configuración guardada. El modo se aplicará en la próxima conexión.' : 'Configuración guardada.');
      } catch (error) {
        showFeedback('error', safeTunnelErrorMessage(error, 'guardar el ID'));
      }
    })();
  });

  document.querySelector('#advanced-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      try {
        syncSettingsDraftFromForm(event.currentTarget as HTMLFormElement);
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        showFeedback('success', 'Configuración avanzada guardada.');
      } catch (error) {
        showFeedback('error', `No se pudo guardar la configuración avanzada: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector('#behavior-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      try {
        const form = event.currentTarget as HTMLFormElement;
        settingsDraft = {
          ...settingsDraft,
          minimizeToTray: form.querySelector<HTMLInputElement>('input[name="minimizeToTray"]')?.checked === true,
          largeArtifactPreference: form.querySelector<HTMLSelectElement>('select[name="largeArtifactPreference"]')?.value === 'adaptive'
            ? { mode: 'adaptive', reserve: settingsDraft.largeArtifactPreference.reserve, maxConcurrentJobs: settingsDraft.largeArtifactPreference.maxConcurrentJobs }
            : { mode: 'standard', reserve: settingsDraft.largeArtifactPreference.reserve, maxConcurrentJobs: settingsDraft.largeArtifactPreference.maxConcurrentJobs },
        };
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        showFeedback('success', 'Comportamiento de ventana guardado.');
      } catch (error) {
        showFeedback('error', `No se pudo guardar el comportamiento: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector<HTMLInputElement>('#api-key')?.addEventListener('input', (event) => {
    apiKeyDraft = (event.target as HTMLInputElement).value;
    clearFieldError(event.currentTarget as HTMLInputElement, 'runtime-key-error');
    updateRuntimeKeyStatusUi();
  });

  document.querySelector<HTMLInputElement>('#remember-tunnel-key')?.addEventListener('change', (event) => {
    rememberTunnelKey = (event.target as HTMLInputElement).checked;
  });

  document.querySelector('#prepare-profile')?.addEventListener('click', () => {
    void (async () => {
      try {
        if (settingsForm === null || !validateTunnelId(settingsForm)) return;
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        await window.desktop.initializeTunnelProfile();
        showFeedback('success', 'Perfil autocontenido preparado correctamente.');
      } catch (error) {
        showFeedback('error', safeTunnelErrorMessage(error, 'preparar el perfil'));
      }
    })();
  });

  document.querySelector('#diagnose-tunnel')?.addEventListener('click', () => {
    void (async () => {
      const onboardingActive = onboardingSnapshotState?.state.status !== 'completed';
      try {
        if (settingsForm === null || !validateTunnelId(settingsForm) || !validateRuntimeKey()) return;
        if (onboardingActive) {
          onboardingBusy = 'connection';
          render();
        }
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        const onboardingResult = onboardingActive
          ? await window.desktop.diagnoseOnboardingConnection(apiKeyDraft)
          : undefined;
        const result = onboardingResult?.report ?? await window.desktop.diagnoseTunnel(apiKeyDraft);
        diagnosticOutput = result.output;
        onboardingTunnelReady = result.ok;
        if (!result.ok) {
          showFeedback('error', diagnosticFailureMessage(result.output));
          return;
        }
        if (result.keyPersistence === 'remembered') {
          tunnelKeyState = { status: 'available' };
          keySaved = true;
          apiKeyDraft = '';
        }
        if (onboardingResult !== undefined) {
          adoptOnboardingSnapshot(onboardingResult.snapshot);
        }
        if (result.keyPersistence === 'failed') {
          showFeedback('warning', 'Diagnóstico correcto; la clave no pudo guardarse y se pedirá al reiniciar.');
        } else {
          showFeedback('success', 'Diagnóstico completado sin fallos. La clave quedó guardada y cifrada.');
        }
      } catch (error) {
        diagnosticOutput = '';
        onboardingTunnelReady = false;
        showFeedback('error', safeTunnelErrorMessage(error, 'diagnóstico'));
      } finally {
        if (onboardingActive) {
          onboardingBusy = undefined;
          render();
        }
      }
    })();
  });

  document.querySelector('#connect-tunnel')?.addEventListener('click', () => {
    void (async () => {
      try {
        if (settingsForm === null || !validateTunnelId(settingsForm) || !validateRuntimeKey(true)) return;
        await window.desktop.saveSettings(settingsDraft);
        settings = { ...settingsDraft };
        const hadStoredKey = tunnelKeyState.status === 'available';
        const suppliedNewKey = apiKeyDraft !== '';
        const result = await window.desktop.connectTunnel({
          ...(apiKeyDraft === '' ? {} : { apiKey: apiKeyDraft }),
          remember: rememberTunnelKey,
        });
        effectiveGitApprovalMode = settingsDraft.gitApprovalMode;
        apiKeyDraft = '';
        if (result.remembered) {
          tunnelKeyState = { status: 'available' };
          keySaved = true;
        } else if (!hadStoredKey) {
          tunnelKeyState = { status: 'absent' };
          keySaved = false;
        }
        showFeedback(result.warningCode === 'KEY_STORE_WRITE_FAILED' ? 'warning' : 'success',
          result.warningCode === 'KEY_STORE_WRITE_FAILED'
            ? hadStoredKey
              ? 'Conectado; la clave nueva no pudo guardarse y la clave anterior se conserva.'
              : 'Conectado; la clave no pudo guardarse y se pedirá al reiniciar.'
            : result.remembered
              ? 'Conectado. La clave está guardada y cifrada para este perfil.'
              : suppliedNewKey && hadStoredKey
                ? 'Conectado con una clave temporal; la clave guardada anterior se conserva.'
                : 'Conectado con una clave temporal para esta sesión.');
      } catch (error) {
        showFeedback('error', safeTunnelErrorMessage(error, 'conexión'));
      }
    })();
  });

  document.querySelector('#disconnect-tunnel')?.addEventListener('click', () => {
    void (async () => {
      try {
        await window.desktop.disconnectTunnel();
        showFeedback('success', 'Túnel desconectado.');
      } catch (error) {
        showFeedback('error', `No se pudo desconectar: ${errorMessage(error)}`);
      }
    })();
  });

  document.querySelector('#forget-key')?.addEventListener('click', () => {
    void (async () => {
      try {
        await window.desktop.forgetTunnelKey();
        keySaved = false;
        tunnelKeyState = { status: 'absent' };
        apiKeyDraft = '';
        showFeedback('success', 'Clave guardada eliminada.');
      } catch (error) {
        showFeedback('error', `No se pudo olvidar la clave: ${errorMessage(error)}`);
      }
    })();
  });
  document.querySelector('#forget-key-trust')?.addEventListener('click', () => {
    void (async () => {
      try {
        await window.desktop.forgetTunnelKey();
        keySaved = false;
        tunnelKeyState = { status: 'absent' };
        apiKeyDraft = '';
        showFeedback('success', 'Clave de este perfil eliminada del equipo.');
      } catch (error) {
        showFeedback('error', `No se pudo olvidar la clave: ${errorMessage(error)}`);
      }
    })();
  });
}

window.desktop.onTunnelStatusChange((status, detail) => {
  tunnelStatus = status;
  if (status === 'disconnected' || status === 'error') effectiveGitApprovalMode = undefined;
  tunnelDetail = detail;
  if (status === 'error' && detail !== undefined) lastProblem = detail;
  updateTunnelRuntimeUi();
});

window.desktop.onTunnelLog((line, stream) => {
  tunnelLogs = [...tunnelLogs.slice(-199), `[${stream}] ${line}`];
  updateTunnelRuntimeUi();
  if (line.includes('"message":"approval waiting"') || line.includes('"message":"approval resolved"')) {
    void refreshPendingApprovals();
  }
});

window.desktop.onDevelopmentActivityChange(() => { void refreshDevelopmentActivity(); });
window.desktop.onAssistedProjectsChange(() => { void Promise.all([refreshAssistedProjects(false), refreshV1Projects(false)]).then(() => render()); });
window.desktop.onWebActivityChange(() => { void refreshWebState(); });

render();

void (async () => {
  try {
    const [initialStatus, initialEffectiveGitApprovalMode, initialRuntime, initialSettings, initialOnboarding, initialWorkspaceResult, initialApplicationResult, initialAssistedResult, initialV1Result, initialApprovalResult, initialDevelopmentResult, initialWebProfilesResult, initialWebActivityResult, savedKey] = await Promise.all([
      window.desktop.getTunnelStatus(),
      window.desktop.getEffectiveGitApprovalMode(),
      window.desktop.getRuntimeInfo(),
      window.desktop.getSettings(),
      window.desktop.getOnboardingSnapshot(),
      window.desktop
        .listWorkspaces()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .listApplications()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .listAssistedProjects()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .listV1Projects()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .listPendingApprovals()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .listDevelopmentActivity()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .getWebProfiles()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop
        .listWebActivity()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error })),
      window.desktop.getTunnelKeyState(),
    ]);
    tunnelStatus = initialStatus;
    effectiveGitApprovalMode = initialEffectiveGitApprovalMode;
    runtimeInfo = initialRuntime;
    settings = initialSettings;
    settingsDraft = { ...initialSettings };
    adoptOnboardingSnapshot(initialOnboarding);
    if ('value' in initialWorkspaceResult) {
      workspaces = initialWorkspaceResult.value;
      workspacesError = undefined;
    } else {
      workspaces = [];
      workspacesError = errorMessage(initialWorkspaceResult.error);
      lastProblem = `No se pudieron cargar los proyectos: ${workspacesError}`;
    }
    if ('value' in initialApplicationResult) {
      applications = initialApplicationResult.value;
      applicationsError = undefined;
    } else {
      applications = [];
      applicationsError = errorMessage(initialApplicationResult.error);
      lastProblem = `No se pudieron cargar las aplicaciones: ${applicationsError}`;
    }
    if ('value' in initialAssistedResult) {
      assistedProjects = initialAssistedResult.value;
      assistedProjectsError = undefined;
    } else {
      assistedProjectsError = errorMessage(initialAssistedResult.error);
    }
    if ('value' in initialV1Result) v1Projects = initialV1Result.value;
    else assistedProjectsError = errorMessage(initialV1Result.error);
    if ('value' in initialApprovalResult) {
      pendingApprovals = initialApprovalResult.value;
    } else {
      pendingApprovals = [];
      lastProblem = `No se pudo leer el estado de aprobaciones: ${errorMessage(initialApprovalResult.error)}`;
    }
    if ('value' in initialDevelopmentResult) developmentActivity = initialDevelopmentResult.value;
    if ('value' in initialWebProfilesResult) webProfiles = initialWebProfilesResult.value;
    else webProfilesError = errorMessage(initialWebProfilesResult.error);
    if ('value' in initialWebActivityResult) webActivity = initialWebActivityResult.value;
    pruneActivityExpandedItems();
    updateAutomaticActivityDisclosure();
    tunnelKeyState = savedKey;
    keySaved = savedKey.status === 'available';
    apiKeyDraft = '';
    isInitializing = false;
    render();
    schedulePendingApprovalExpiry();
  } catch (error) {
    isInitializing = false;
    showFeedback('error', `No se pudo inicializar la aplicación: ${errorMessage(error)}`);
  }
})();
