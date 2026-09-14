/**
 * Proceso principal de la UI de escritorio (ADR-0015).
 *
 * Toda la lógica de negocio (validación, escritura atómica, supervisión del
 * túnel) vive en `@localbridge/desktop-core`, testeada sin Electron. Este
 * fichero es solo el pegamento: crea la ventana, registra los handlers de IPC,
 * y traduce entre el mundo de Electron (diálogos nativos, `BrowserWindow`) y el
 * de `desktop-core`.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell,
  type Display,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DEFAULT_CONNECTION_PROFILE,
  analysisJobTargetInputSchema,
  taskBatchTargetInputSchema,
  FolderSelectionVault,
  TunnelSupervisor,
  absolutePathSchema,
  activeConnectionProfile,
  applyPortableConfig,
  adoptDevelopmentProjectInputSchema,
  auditQuerySchema,
  authorizedWorkspaceInputSchema,
  bundledServerCommand,
  buildNewWorkspace,
  buildNewApplication,
  buildNewDevelopmentProject,
  buildPublicResearchProfile,
  enablePublicInternetAccess,
  buildSiteAccountProfile,
  rememberExactSiteAccess,
  buildSetupPlan,
  buildPortableConfig,
  clearEncryptedKey,
  advanceOnboarding,
  backOnboarding,
  buildOnboardingSnapshot,
  completeOnboarding,
  connectWithTunnelCredential,
  defaultDesktopSettingsPath,
  defaultWebProfileStorePath,
  defaultOnboardingStatePath,
  defaultTunnelKeyPath,
  desktopSettingsSchema,
  detectProjectCommands,
  diagnoseTunnelProfile,
  diagnosticTextSchema,
  connectionProfileIdSchema,
  connectionProfileNameSchema,
  exportDiagnosticFile,
  exportPortableConfigFile,
  initializeTunnelProfile,
  checkRuntimeReadiness,
  createProjectSetupSession,
  detectProjectTopology,
  developmentProjectIdInputSchema,
  externalDestinationSchema,
  listAuditEvents,
  listPendingApprovals,
  listWorkspaces,
  listApplications,
  listDevelopmentProjects,
  listProjectSetupSessions,
  loadOrCreateDeviceBinding,
  loadProjectCatalog,
  loadProjectTrustStore,
  loadRegistryDocument,
  migrateRegistryFile,
  migrateDevelopmentProjectsToCatalog,
  loadEncryptedKey,
  migrateLegacyEncryptedKey,
  publicStoredTunnelKeyState,
  legacyOnboardingMarkers,
  onboardingAccessInputSchema,
  onboardingCompletionInputSchema,
  onboardingPermissionPreset,
  readOnboardingState,
  readDesktopSettings,
  readWebProfileStore,
  replaceWebProfileStore,
  readPortableConfigFile,
  removeWorkspace,
  removeApplication,
  removeRegistryEntriesIfPresent,
  replaceRegistry,
  replaceDevelopmentProjects,
  replaceProjectTrust,
  resolveBundledRuntimePaths,
  saveAndVerifyEncryptedKey,
  synchronizeActiveConnectionProfile,
  newWorkspaceInputSchema,
  tunnelApiKeyInputSchema,
  tunnelConnectInputSchema,
  tunnelIdSchema,
  portableImportSessionIdSchema,
  portableWorkspaceRefSchema,
  testWorkspaceReadiness,
  upsertWorkspace,
  upsertApplication,
  workspaceIdInputSchema,
  webHumanSessionInputSchema,
  webHumanTakeInputSchema,
  webHumanCycleInputSchema,
  webLiveViewerHideInputSchema,
  webLiveViewerMoveInputSchema,
  webLiveViewerPresentationInputSchema,
  webLiveViewerShowInputSchema,
  webMotionCancelInputSchema,
  webTabsInputSchema,
  webViewerStateInputSchema,
  webViewportInputSchema,
  webProfileCreateInputSchema,
  webProfileEnableInternetInputSchema,
  webProfileRemoveInputSchema,
  webProfileResetInputSchema,
  webProfileUpdateInputSchema,
  requireCurrentWebProfileAuthority,
  withAuthorizedWebProfileEffect,
  applicationIdInputSchema,
  browserSessionIdInputSchema,
  browserMotionCancelInputSchema,
  browserViewportInputSchema,
  liveViewerMoveInputSchema,
  liveViewerPresentationInputSchema,
  liveViewerTargetInputSchema,
  terminalListenerTargetInputSchema,
  terminalSessionTargetInputSchema,
  newApplicationInputSchema,
  localApplicationInputSchema,
  newAssistedProjectInputSchema,
  finalizeSetupPlan,
  interruptProjectSetupSessions,
  removeDevelopmentProject,
  removeDevelopmentProjectIfPresent,
  removeProjectSetupSessions,
  removeProjectCatalogRecord,
  removeProjectScanRecord,
  removeProjectTrustRecord,
  loadProjectScanStore,
  upsertProjectScanRecord,
  DEFAULT_TOPOLOGY_LIMITS,
  replaceProjectCatalog,
  revokeProjectTrust,
  planDevelopmentProjectRemoval,
  resolveSetupToolchains,
  setupReviewInputSchema,
  setupPolicyInputSchema,
  restartOnboardingState,
  updateProjectSetupSession,
  upsertDevelopmentProject,
  upsertProjectCatalogRecord,
  setProjectTrust,
  validateSetupPlan,
  writeOnboardingState,
  writeDesktopSettings,
  type ConnectionProfile,
  type AuditQuery,
  type PortableConfig,
  type SecureKeyStoreDeps,
  type TunnelStatus,
  type TunnelProvisionOptions,
  type ResolvedSetupToolchain,
  type OnboardingEvidence,
  type OnboardingSnapshot,
  type OnboardingState,
} from "@localbridge/desktop-core";
import { buildAuditEvent, recordAuditEvent } from "@localbridge/audit";
import {
  cleanupWorkspaceArtifactStaging,
  createWorkspaceArtifactDirectory,
  createWorkspaceBinaryFile,
  createWorkspaceBinaryFileFromChunks,
  preflightWorkspaceBinaryFileCreate,
} from "@localbridge/filesystem";
import {
  requireAuthorizedWorkspace,
  requireCurrentWorkspaceAuthority,
  withAuthorizedWorkspaceCapabilitiesEffect,
  withAuthorizedWorkspaceEffect,
  withCurrentWorkspaceAuthorityEffect,
} from "@localbridge/permissions";
import { createLogger, defaultAuditDbPath, defaultWorkspaceConfigPath, LocalBridgeError } from "@localbridge/shared";
import { runValidation } from "@localbridge/validation";
import {
  AnalysisJobSupervisor,
  ApplicationSupervisor,
  DevelopmentBrokerError,
  ProcessSupervisor,
  SetupSupervisor,
  TerminalSupervisor,
  TaskBatchSupervisor,
  createDevelopmentRuntimeHandler,
  startDevelopmentBroker,
  type RunningDevelopmentBroker,
  type SetupRunSummary,
} from "@localbridge/development";
import {
  isPathDenied,
  projectCatalogRecordSchema,
  projectScanRecordSchema,
  projectTrustModeSchema,
  resolveSafePath,
  resolveWriteTarget,
  type DevelopmentProject,
  type ProjectCatalogRecord,
  type ProjectScanRecord,
  type ProjectSetupSession,
  type ProcessProfile,
  type SetupPlan,
  type AuthorizedWorkspace,
} from "@localbridge/workspace";
import { assertTrustedIpcSender } from "./ipc-security.js";
import { BrowserController } from "./browser-controller.js";
import { WebController } from "./web-controller.js";
import { LiveViewerCoordinator } from "./live-viewer-coordinator.js";
import { resolveDisplay, sortDisplays, summarizeDisplays } from "./live-viewer-displays.js";
import { HumanControlCoordinator } from "./human-control-coordinator.js";
import { ArtifactAnalysisRuntime } from "./artifact-analysis-runtime.js";

const registryPath = defaultWorkspaceConfigPath();
const auditDbPath = defaultAuditDbPath();
const desktopSecurityLogger = createLogger({ level: "info", base: { service: "localbridge-desktop" } });
const settingsPath = defaultDesktopSettingsPath();
const webProfileStorePath = defaultWebProfileStorePath();
const onboardingStatePath = defaultOnboardingStatePath();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const EXTERNAL_URLS = {
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  runtimeKeys: "https://platform.openai.com/settings/organization/api-keys",
  chatgptConnectors: "https://chatgpt.com/#settings/Connectors",
} as const;

const keyStoreDeps: SecureKeyStoreDeps = {
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  isAvailable: () => safeStorage.isEncryptionAvailable(),
};

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let tunnelSetupInProgress = false;
let explicitQuit = false;
let minimizeToTray = true;
let lastTunnelStatus: TunnelStatus = "disconnected";
let backgroundNoticeShown = false;
let developmentBroker: RunningDevelopmentBroker | undefined;
let processSupervisor: ProcessSupervisor | undefined;
let browserController: BrowserController | undefined;
let webController: WebController | undefined;
let liveViewerCoordinator: LiveViewerCoordinator | undefined;
let applicationSupervisor: ApplicationSupervisor | undefined;
let setupSupervisor: SetupSupervisor | undefined;
let terminalSupervisor: TerminalSupervisor | undefined;
let analysisSupervisor: AnalysisJobSupervisor | undefined;
let analysisUnavailableReason: 'journal-unavailable' | undefined;
let taskBatchSupervisor: TaskBatchSupervisor | undefined;
let taskBatchUnavailableReason: 'journal-unavailable' | undefined;
let deviceBinding = "";
const humanControlCoordinator = new HumanControlCoordinator();
const projectRescanTimers = new Map<string, NodeJS.Timeout>();
let liveViewerDisplayId: string | undefined;
let displayMonitoringInstalled = false;
const portableImportSessions = new Map<
  string,
  { readonly config: PortableConfig; readonly mappings: Map<string, string> }
>();

function reconcileLiveViewerCoordinatorState(): void {
  const current = liveViewerCoordinator?.current();
  if (current === undefined) return;
  const webState = current.kind === "web" ? webController?.getLocalLiveViewerState() : undefined;
  const stillVisible = current.kind === "development"
    ? browserController?.getLocalLiveViewerSessionId() === current.sessionId
    : webState?.visible === true && webState.sessionId === current.sessionId;
  if (!stillVisible) liveViewerCoordinator?.release(current);
}

function reserveHumanControlOrFail(kind: "development" | "web", sessionId: string): void {
  try {
    humanControlCoordinator.reserve({ kind, sessionId });
  } catch {
    throw new DevelopmentBrokerError("HUMAN_CONTROL_BUSY", "Ya existe otra intervención humana activa.");
  }
}

interface OnboardingFolderSummary {
  readonly selectionId: string;
  readonly suggestedName: string;
  readonly topology: "empty" | "single-repo" | "monorepo" | "multi-repo" | "multi-service" | "files";
  readonly repositoryCount: number;
  readonly packageCount: number;
  readonly serviceCount: number;
  readonly validationCount: number;
  readonly warningCodes: readonly string[];
  readonly requiresReview: boolean;
  readonly fingerprint: string;
  readonly existingProjectId?: string;
  readonly existingProjectName?: string;
}

interface OnboardingDraft {
  readonly selectionId?: string;
  readonly existingProjectId?: string;
  readonly trustMode?: "guided" | "full-host";
  readonly guidedPreset?: "review" | "develop" | "complete";
}

const onboardingFolderSelections = new FolderSelectionVault<Omit<OnboardingFolderSummary, "selectionId">>();
const onboardingDrafts = new Map<string, OnboardingDraft>();
const diagnosedOnboardingProfiles = new Set<string>();
let onboardingRuntimeReady = false;

function projectStorePath(): string {
  return join(app.getPath("userData"), "development-projects.json");
}

function projectSetupStorePath(): string {
  return join(app.getPath("userData"), "project-setup-sessions.json");
}

function projectCatalogPath(): string {
  return join(app.getPath("userData"), "project-catalog.json");
}

function projectTrustPath(): string {
  return join(app.getPath("userData"), "project-trust.json");
}

/** Cobertura del último escaneo, fuera del catálogo para no romper downgrade (ADR-0040). */
function projectScanPath(): string {
  return join(app.getPath("userData"), "project-scan.json");
}

function deviceBindingPath(): string {
  return join(app.getPath("userData"), "device-binding.json");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface CatalogRecordBuild {
  readonly record: ProjectCatalogRecord;
  readonly scan: ProjectScanRecord;
}

async function catalogRecordForWorkspace(
  project: DevelopmentProject,
  workspace: AuthorizedWorkspace,
  previous?: ProjectCatalogRecord,
): Promise<CatalogRecordBuild> {
  const topology = await detectProjectTopology(workspace);
  const serviceRoots = [...new Set(topology.commands.filter((command) => command.role === "server").map((command) => command.processProfile.cwd))];
  const scopes = [...new Set([".", ...topology.gitRoots, ...topology.manifests.map((manifest) => manifest.cwd), ...serviceRoots])];
  const nodeInputs = [
    ...topology.gitRoots.map((relativePath) => ({ kind: "repository" as const, relativePath, name: relativePath === "." ? project.name : relativePath.split("/").at(-1)! })),
    ...topology.manifests.map((manifest) => ({ kind: "package" as const, relativePath: manifest.cwd, name: manifest.cwd === "." ? project.name : manifest.cwd.split("/").at(-1)! })),
    ...serviceRoots.map((relativePath) => ({ kind: "service" as const, relativePath, name: relativePath === "." ? "servicio" : relativePath.split("/").at(-1)! })),
  ];
  const deduplicated = new Map<string, (typeof nodeInputs)[number]>();
  for (const node of nodeInputs) deduplicated.set(`${node.kind}:${node.relativePath.toLocaleLowerCase("en-US")}`, node);
  const now = new Date().toISOString();
  const stableTopology = {
    ...topology,
    commands: topology.commands.map((command) => ({
      name: command.name,
      role: command.role,
      source: command.source,
      processProfile: command.processProfile,
    })),
  };
  const inferredTopology = topology.scannedEntries === 0
    ? "empty"
    : topology.topology === "multi-repo"
      ? "multi-repo"
      : topology.topology === "monorepo"
        ? "monorepo"
        : serviceRoots.length > 1
          ? "multi-service"
          : topology.gitRoots.length > 0
            ? "single-repo"
            : "files";
  // `truncated` mide cuánto se alcanzó a inspeccionar, no si el proyecto puede
  // operar (ADR-0040). Se conserva como cobertura; el estado solo lo degradan
  // condiciones que un humano debe resolver.
  const record = projectCatalogRecordSchema.parse({
    id: project.id,
    displayName: project.name,
    description: project.description,
    selectedRoot: workspace.rootPath,
    state: "ready",
    topology: inferredTopology,
    nodes: [...deduplicated.values()].map((node) => ({
      id: `node_${hashText(`${project.id}:${node.kind}:${node.relativePath}`).slice(0, 24)}`,
      kind: node.kind,
      name: node.name,
      relativePath: node.relativePath,
      workspaceId: workspace.id,
      source: "detected",
      state: "ready",
    })),
    derivedScopes: scopes.map((relativePath) => ({
      relativePath,
      source: relativePath === "." ? "root" : "detected",
      status: "active",
    })),
    compatibilityRefs: [
      { kind: "development-project", id: project.id },
      { kind: "workspace", id: workspace.id },
      ...(project.applicationId === undefined ? [] : [{ kind: "application" as const, id: project.applicationId }]),
    ],
    // Command IDs are runtime identifiers. Excluding them avoids rewriting the
    // catalog after every terminal event when the discovered topology is unchanged.
    scanFingerprint: hashText(JSON.stringify({ topology: stableTopology, workspaceId: workspace.id })),
    createdAt: previous?.createdAt ?? project.createdAt,
    updatedAt: now,
  });
  return {
    record,
    scan: projectScanRecordSchema.parse({
      projectId: project.id,
      coverage: topology.truncated ? "partial" : "complete",
      scannedEntries: topology.scannedEntries,
      entryLimit: DEFAULT_TOPOLOGY_LIMITS.maxEntries,
      observedAt: now,
    }),
  };
}

/**
 * Persiste ficha y cobertura como una sola operación y deja evidencia cuando el
 * estado cambia (ADR-0040): un rescan actualiza estructura y nunca degrada una
 * decisión de confianza en silencio.
 */
async function persistCatalogRecord(build: CatalogRecordBuild, previous?: ProjectCatalogRecord): Promise<ProjectCatalogRecord> {
  const stored = await upsertProjectCatalogRecord(projectCatalogPath(), build.record);
  await upsertProjectScanRecord(projectScanPath(), build.scan).catch(() => undefined);
  if (previous !== undefined && previous.state !== stored.state) {
    recordProjectAudit(`project.state.${stored.state}`, stored.id, undefined);
  }
  return stored;
}

function onboardingOwner(event: IpcMainInvokeEvent): string {
  return `webcontents_${event.sender.id}`;
}

function safeProfileName(input: string, used: Set<string>): string {
  const base = input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 52) || "profile";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase("en-US"))) {
    candidate = `${base.slice(0, 58)}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

function inferOnboardingTopology(topology: Awaited<ReturnType<typeof detectProjectTopology>>): OnboardingFolderSummary["topology"] {
  const serviceRoots = new Set(
    topology.commands.filter((command) => command.role === "server").map((command) => command.processProfile.cwd),
  );
  if (topology.scannedEntries === 0) return "empty";
  if (topology.topology === "multi-repo") return "multi-repo";
  if (topology.topology === "monorepo") return "monorepo";
  if (serviceRoots.size > 1) return "multi-service";
  if (topology.gitRoots.length > 0) return "single-repo";
  return "files";
}

function onboardingTopologyFingerprint(topology: Awaited<ReturnType<typeof detectProjectTopology>>): string {
  return hashText(JSON.stringify({
    topology: topology.topology,
    manifests: topology.manifests.map(({ kind, path, sha256 }) => ({ kind, path, sha256 })),
    lockfiles: topology.lockfiles.map(({ path, manager, sha256 }) => ({ path, manager, sha256 })),
    gitRoots: topology.gitRoots,
    commands: topology.commands.map(({ name, role, source, processProfile }) => ({ name, role, source, processProfile })),
    warnings: topology.warnings,
    truncated: topology.truncated,
    scannedEntries: topology.scannedEntries,
  }));
}

async function canonicalProjectPath(rootPath: string): Promise<string> {
  const canonical = await realpath(rootPath);
  const information = await stat(canonical);
  if (!information.isDirectory()) throw new Error("Selecciona una carpeta de proyecto.");
  const parsedRoot = parsePath(canonical).root.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
  if (canonical.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US") === parsedRoot) {
    throw new Error("Selecciona una carpeta de proyecto, no la raíz completa de una unidad.");
  }
  return canonical;
}

async function inspectOnboardingFolder(rootPath: string): Promise<{
  readonly rootPath: string;
  readonly topology: Awaited<ReturnType<typeof detectProjectTopology>>;
  readonly summary: Omit<OnboardingFolderSummary, "selectionId">;
}> {
  const canonical = await canonicalProjectPath(rootPath);
  const temporary = buildNewWorkspace({
    name: "Inspección temporal",
    rootPath: canonical,
    permissions: onboardingPermissionPreset("guided", "review"),
  });
  const topology = await detectProjectTopology(temporary);
  const catalog = await loadProjectCatalog(projectCatalogPath());
  let existing: ProjectCatalogRecord | undefined;
  for (const project of catalog.projects) {
    try {
      if ((await realpath(project.selectedRoot)).toLocaleLowerCase("en-US") === canonical.toLocaleLowerCase("en-US")) {
        existing = project;
        break;
      }
    } catch {
      // Una raíz histórica no disponible no debe bloquear la selección actual.
    }
  }
  const services = topology.commands.filter((command) => command.role === "server");
  const validations = topology.commands.filter((command) => command.role === "validation");
  const summary: Omit<OnboardingFolderSummary, "selectionId"> = {
    suggestedName: basename(canonical).slice(0, 80) || "Mi proyecto",
    topology: inferOnboardingTopology(topology),
    repositoryCount: topology.gitRoots.length,
    packageCount: topology.manifests.length,
    serviceCount: services.length,
    validationCount: validations.length,
    warningCodes: topology.warnings,
    requiresReview: topology.truncated || topology.warnings.length > 0,
    fingerprint: onboardingTopologyFingerprint(topology),
    ...(existing === undefined ? {} : { existingProjectId: existing.id, existingProjectName: existing.displayName }),
  };
  return { rootPath: canonical, topology, summary };
}

async function persistOnboardingState(previous: OnboardingState, next: OnboardingState): Promise<void> {
  const settings = await readDesktopSettings(settingsPath);
  const nextSettings = desktopSettingsSchema.parse({ ...settings, ...legacyOnboardingMarkers(next) });
  await writeOnboardingState(onboardingStatePath, next);
  try {
    await writeDesktopSettings(settingsPath, nextSettings);
  } catch (error) {
    await writeOnboardingState(onboardingStatePath, previous).catch(() => undefined);
    throw error;
  }
}

async function currentOnboardingState(): Promise<OnboardingState> {
  const settings = await readDesktopSettings(settingsPath);
  return (await readOnboardingState(onboardingStatePath, settings)).state;
}

async function onboardingEvidence(ownerId: string, state: OnboardingState): Promise<OnboardingEvidence> {
  const settings = await readDesktopSettings(settingsPath);
  const draft = onboardingDrafts.get(ownerId);
  const catalog = await loadProjectCatalog(projectCatalogPath());
  const trust = await loadProjectTrustStore(projectTrustPath());
  const selectedProjectId = draft?.existingProjectId ?? state.selectedProjectId;
  const projectReady = selectedProjectId !== undefined && catalog.projects.some((project) => project.id === selectedProjectId);
  const trustReady =
    selectedProjectId !== undefined &&
    trust.decisions.some((decision) => decision.projectId === selectedProjectId && decision.status === "active");
  return {
    runtimeReady: state.status === "completed" || onboardingRuntimeReady,
    connectionReady:
      state.status === "completed" || diagnosedOnboardingProfiles.has(settings.activeConnectionProfileId),
    selectionReady: draft?.selectionId !== undefined || draft?.existingProjectId !== undefined || projectReady,
    accessReady: draft?.trustMode !== undefined && draft.guidedPreset !== undefined,
    projectReady,
    trustReady,
  };
}

async function onboardingSnapshot(ownerId: string): Promise<OnboardingSnapshot & {
  readonly draft: OnboardingDraft;
  readonly folder?: OnboardingFolderSummary;
}> {
  const state = await currentOnboardingState();
  const draft = onboardingDrafts.get(ownerId) ?? {};
  let folder: OnboardingFolderSummary | undefined;
  if (draft.selectionId !== undefined) {
    try {
      const selection = onboardingFolderSelections.get(draft.selectionId, ownerId);
      folder = { selectionId: selection.id, ...selection.summary };
    } catch {
      const { selectionId: _expiredSelection, ...remaining } = draft;
      onboardingDrafts.set(ownerId, remaining);
    }
  }
  return {
    ...buildOnboardingSnapshot(state, await onboardingEvidence(ownerId, state)),
    draft: onboardingDrafts.get(ownerId) ?? {},
    ...(folder === undefined ? {} : { folder }),
  };
}

async function confirmFullHost(projectName: string): Promise<void> {
  const confirmation = await dialog.showMessageBox({
    type: "warning",
    title: "Control total del equipo",
    message: `Habilitar control total para ${projectName}`,
    detail:
      "ChatGPT podrá ejecutar comandos con tu cuenta de Windows. La carpeta elegida será el directorio inicial, no un límite de seguridad. LocalBridge no elevará UAC.",
    buttons: ["Cancelar", "Entiendo y habilitar"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1) throw new Error("No se habilitó Control total del equipo.");
}

function detectedProfiles(topology: Awaited<ReturnType<typeof detectProjectTopology>>): Pick<
  Required<AuthorizedWorkspace>,
  "processProfiles" | "validationProfiles"
> {
  const processProfiles: Record<string, ProcessProfile> = {};
  const validationProfiles: Record<string, readonly string[]> = {};
  const usedProcesses = new Set<string>();
  const usedValidations = new Set<string>();
  for (const command of topology.commands) {
    if (command.role === "server") {
      processProfiles[safeProfileName(command.name, usedProcesses)] = command.processProfile;
    } else if (command.role === "validation" && command.processProfile.cwd === ".") {
      validationProfiles[safeProfileName(command.name, usedValidations)] = command.processProfile.command;
    }
  }
  return { processProfiles, validationProfiles };
}

async function finalizeOnboarding(ownerId: string, input: unknown): Promise<OnboardingSnapshot & {
  readonly draft: OnboardingDraft;
  readonly project: ProjectCatalogRecord;
}> {
  const parsed = onboardingCompletionInputSchema.parse(input);
  if (parsed.trustMode === "project-agent") {
    throw new Error("Agente en proyecto no está disponible: el sandbox de Windows aún no superó sus pruebas.");
  }
  const stateBefore = await currentOnboardingState();
  const evidenceBefore = await onboardingEvidence(ownerId, stateBefore);
  if (!evidenceBefore.runtimeReady || !evidenceBefore.connectionReady) {
    throw new Error("Vuelve a validar el runtime y la conexión antes de finalizar.");
  }
  if (deviceBinding === "") deviceBinding = await loadOrCreateDeviceBinding(deviceBindingPath());
  const draft = onboardingDrafts.get(ownerId);
  if (draft?.trustMode !== parsed.trustMode || draft.guidedPreset !== parsed.guidedPreset) {
    throw new Error("La revisión cambió. Confirma de nuevo el nivel de acceso.");
  }

  const previousSettings = await readDesktopSettings(settingsPath);
  const previousRegistry = await loadRegistryDocument(registryPath);
  const previousProjects = await listDevelopmentProjects(projectStorePath(), previousRegistry);
  const previousCatalog = await loadProjectCatalog(projectCatalogPath());
  const previousTrust = await loadProjectTrustStore(projectTrustPath());
  const permissions = onboardingPermissionPreset(parsed.trustMode, parsed.guidedPreset);

  let project: DevelopmentProject;
  let record: ProjectCatalogRecord;
  let selectedWorkspaceIds: readonly string[];
  let consumedSelectionId: string | undefined;
  let workspaceForNewProject: AuthorizedWorkspace | undefined;
  let catalogBuild: CatalogRecordBuild | undefined;

  if (parsed.kind === "existing") {
    if (draft.existingProjectId !== parsed.projectId) throw new Error("El proyecto seleccionado cambió. Vuelve a revisarlo.");
    const existingRecord = previousCatalog.projects.find((candidate) => candidate.id === parsed.projectId);
    const existingProject = previousProjects.find((candidate) => candidate.id === parsed.projectId);
    if (existingRecord === undefined || existingProject === undefined) throw new Error("El proyecto existente ya no está disponible.");
    record = existingRecord;
    project = existingProject;
    selectedWorkspaceIds = record.compatibilityRefs
      .filter((reference) => reference.kind === "workspace")
      .map((reference) => reference.id);
    if (selectedWorkspaceIds.length === 0) throw new Error("El proyecto existente necesita revisión local.");
    consumedSelectionId = draft.selectionId;
  } else {
    if (draft.selectionId !== parsed.folderSelectionId) throw new Error("La carpeta seleccionada cambió. Vuelve a elegirla.");
    const selection = onboardingFolderSelections.get(parsed.folderSelectionId, ownerId);
    const inspected = await inspectOnboardingFolder(selection.rootPath);
    if (inspected.summary.fingerprint !== selection.summary.fingerprint) {
      throw new Error("La estructura de la carpeta cambió. Revísala de nuevo antes de guardar.");
    }
    if (inspected.summary.existingProjectId !== undefined) {
      throw new Error("Esta carpeta ya pertenece a un proyecto. Selecciona la ficha existente para no duplicarla.");
    }
    const existingWorkspace = previousRegistry.workspaces.find(
      (workspace) => workspace.rootPath.toLocaleLowerCase("en-US") === inspected.rootPath.toLocaleLowerCase("en-US"),
    );
    const profiles = detectedProfiles(inspected.topology);
    const workspace =
      existingWorkspace === undefined
        ? buildNewWorkspace({
            name: parsed.name,
            rootPath: inspected.rootPath,
             permissions,
             largeArtifacts: previousSettings.largeArtifactPreference,
             processProfiles: profiles.processProfiles,
            validationProfiles: profiles.validationProfiles,
          })
        : {
            ...existingWorkspace,
            name: parsed.name,
            enabled: true,
            permissions,
            processProfiles: profiles.processProfiles,
            validationProfiles: profiles.validationProfiles,
          };
    project = buildNewDevelopmentProject({
      name: parsed.name,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      workspaceIds: [workspace.id],
      setupStatus: "ready",
    });
    catalogBuild = await catalogRecordForWorkspace(project, workspace);
    record = catalogBuild.record;
    selectedWorkspaceIds = [workspace.id];
    consumedSelectionId = parsed.folderSelectionId;
    workspaceForNewProject = workspace;
  }

  if (parsed.trustMode === "full-host") await confirmFullHost(record.displayName);

  try {
    if (parsed.kind === "existing") {
      for (const workspaceId of selectedWorkspaceIds) {
        const workspace = previousRegistry.workspaces.find((candidate) => candidate.id === workspaceId);
        if (workspace === undefined) throw new Error("Una carpeta del proyecto ya no está disponible.");
        await upsertWorkspace(registryPath, { ...workspace, enabled: true, permissions });
      }
    } else {
      if (workspaceForNewProject === undefined || catalogBuild === undefined) throw new Error("La selección local ya no está disponible.");
      await upsertWorkspace(registryPath, workspaceForNewProject);
      const registry = await loadRegistryDocument(registryPath);
      await upsertDevelopmentProject(projectStorePath(), registry, project);
      await persistCatalogRecord(catalogBuild);
    }
    const decision = await setProjectTrust(projectTrustPath(), {
      projectId: project.id,
      mode: parsed.trustMode,
      deviceBinding,
    });
    const completed = completeOnboarding(
      stateBefore,
      {
        runtimeReady: true,
        connectionReady: true,
        selectionReady: true,
        accessReady: true,
        projectReady: true,
        trustReady: decision.status === "active",
      },
      project.id,
    );
    await persistOnboardingState(stateBefore, completed);
    if (consumedSelectionId !== undefined) onboardingFolderSelections.consume(consumedSelectionId, ownerId);
    onboardingDrafts.delete(ownerId);
    recordProjectAudit("onboarding.complete", project.id, selectedWorkspaceIds[0]);
    sendToRenderer("projects:changed");
    const snapshot = buildOnboardingSnapshot(completed, {
      runtimeReady: true,
      connectionReady: true,
      selectionReady: true,
      accessReady: true,
      projectReady: true,
      trustReady: true,
    });
    return { ...snapshot, draft: {}, project: record };
  } catch (error) {
    await replaceRegistry(registryPath, previousRegistry).catch(() => undefined);
    await replaceDevelopmentProjects(projectStorePath(), previousProjects).catch(() => undefined);
    await replaceProjectCatalog(projectCatalogPath(), previousCatalog.projects).catch(() => undefined);
    await replaceProjectTrust(projectTrustPath(), previousTrust.decisions).catch(() => undefined);
    await writeOnboardingState(onboardingStatePath, stateBefore).catch(() => undefined);
    await writeDesktopSettings(settingsPath, previousSettings).catch(() => undefined);
    throw error;
  }
}

async function ensureV1Catalog(): Promise<void> {
  deviceBinding = await loadOrCreateDeviceBinding(deviceBindingPath());
  const catalog = await loadProjectCatalog(projectCatalogPath());
  const registry = await loadRegistryDocument(registryPath);
  const legacy = await listDevelopmentProjects(projectStorePath(), registry);
  const known = new Set(catalog.projects.map((project) => project.id));
  const missing = migrateDevelopmentProjectsToCatalog(legacy, registry).filter((project) => !known.has(project.id));
  if (missing.length > 0) await replaceProjectCatalog(projectCatalogPath(), [...catalog.projects, ...missing]);
}

/**
 * Reevalúa al arrancar los proyectos que quedaron en `review` (ADR-0040). Una
 * instalación degradada por un escaneo incompleto no puede recuperarse por
 * actividad, porque la actividad es justo lo que está bloqueado. Solo toca
 * fichas de una única carpeta: las de varias raíces siguen exigiendo revisión.
 */
async function healReviewedProjects(): Promise<void> {
  const catalog = await loadProjectCatalog(projectCatalogPath()).catch(() => undefined);
  for (const project of catalog?.projects.filter((candidate) => candidate.state === "review") ?? []) {
    // Secuencial a propósito: cada reconciliación recorre el disco y escribe el
    // catálogo; en paralelo competirían por la misma escritura atómica.
    await rescanV1ProjectFromActivity(project.id).catch(() => undefined);
  }
}

async function rescanV1ProjectFromActivity(projectId: string): Promise<void> {
  const [registry, catalog] = await Promise.all([
    loadRegistryDocument(registryPath),
    loadProjectCatalog(projectCatalogPath()),
  ]);
  const current = catalog.projects.find((candidate) => candidate.id === projectId);
  // `review` sí se reevalúa (ADR-0040): si la causa desapareció, el proyecto debe
  // poder recuperarse solo. `unavailable` y `conflict` describen condiciones que un
  // rescan de estructura no resuelve por sí mismo.
  if (current === undefined || (current.state !== "ready" && current.state !== "review")) return;
  const workspaceRefs = current.compatibilityRefs.filter((reference) => reference.kind === "workspace");
  if (workspaceRefs.length !== 1) return;
  const workspace = registry.workspaces.find((candidate) => candidate.id === workspaceRefs[0]?.id);
  if (workspace === undefined) return;
  const legacy = (await listDevelopmentProjects(projectStorePath(), registry)).find((candidate) => candidate.id === projectId);
  if (legacy === undefined) return;
  const updated = await catalogRecordForWorkspace(legacy, workspace, current);
  if (updated.record.scanFingerprint === current.scanFingerprint && updated.record.state === current.state) return;
  await persistCatalogRecord(updated, current);
  sendToRenderer("projects:changed");
}

function scheduleV1ProjectRescan(projectId: string): void {
  const previous = projectRescanTimers.get(projectId);
  if (previous !== undefined) clearTimeout(previous);
  const timer = setTimeout(() => {
    projectRescanTimers.delete(projectId);
    void rescanV1ProjectFromActivity(projectId).catch(() => undefined);
  }, 750);
  timer.unref();
  projectRescanTimers.set(projectId, timer);
}

const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#10243e"/><path d="M17 19h9v18h21v9H17z" fill="#55d6be"/><circle cx="43" cy="22" r="7" fill="#ffb85c"/></svg>`;

function appIcon() {
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(APP_ICON_SVG).toString("base64")}`)
    .resize({ width: 32, height: 32 });
}

function showMainWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) createWindow();
  mainWindow?.show();
  mainWindow?.restore();
  mainWindow?.focus();
}

function parseBrowserSessionId(value: unknown): string {
  return browserSessionIdInputSchema.parse(value);
}

function sortedDisplays(): Display[] {
  return sortDisplays(screen.getAllDisplays());
}

function recommendedDisplay(): Display {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) return screen.getDisplayMatching(mainWindow.getBounds());
  return screen.getPrimaryDisplay();
}

function resolveLiveViewerDisplay(displayId?: string): Display {
  const displays = sortedDisplays();
  return resolveDisplay(displays, displayId, recommendedDisplay().id, screen.getPrimaryDisplay().id);
}

function liveViewerDisplaySummaries() {
  return summarizeDisplays(sortedDisplays(), screen.getPrimaryDisplay().id);
}

async function rehomeLiveViewerIfNeeded(removedDisplayId?: string): Promise<void> {
  const developmentSessionId = browserController?.getLocalLiveViewerSessionId();
  const webViewer = webController?.getLocalLiveViewerState();
  if (developmentSessionId === undefined && webViewer?.visible !== true) return;
  const available = sortedDisplays();
  const selectedStillExists = liveViewerDisplayId !== undefined &&
    available.some((display) => String(display.id) === liveViewerDisplayId);
  if (removedDisplayId === undefined && selectedStillExists) {
    const target = resolveLiveViewerDisplay(liveViewerDisplayId);
    if (developmentSessionId !== undefined) await browserController?.moveLiveViewerLocally(developmentSessionId, target.workArea);
    else if (webViewer?.sessionId !== undefined) await webController?.moveLiveViewerLocally(webViewer.sessionId, target.workArea);
    return;
  }
  if (removedDisplayId !== undefined && liveViewerDisplayId !== removedDisplayId && selectedStillExists) return;
  const fallback = resolveLiveViewerDisplay();
  if (developmentSessionId !== undefined) await browserController?.moveLiveViewerLocally(developmentSessionId, fallback.workArea);
  else if (webViewer?.sessionId !== undefined) await webController?.moveLiveViewerLocally(webViewer.sessionId, fallback.workArea);
  liveViewerDisplayId = String(fallback.id);
  sendToRenderer('development:changed');
  sendToRenderer('web:changed');
}

function installDisplayMonitoring(): void {
  if (displayMonitoringInstalled) return;
  displayMonitoringInstalled = true;
  screen.on('display-added', () => {
    sendToRenderer('development:changed');
    sendToRenderer('web:changed');
  });
  screen.on('display-removed', (_event, display) => {
    void rehomeLiveViewerIfNeeded(String(display.id)).catch(() => {
      sendToRenderer('development:changed');
      sendToRenderer('web:changed');
    });
  });
  screen.on('display-metrics-changed', (_event, display) => {
    if (String(display.id) !== liveViewerDisplayId) {
      sendToRenderer('development:changed');
      sendToRenderer('web:changed');
      return;
    }
    void rehomeLiveViewerIfNeeded().catch(() => {
      sendToRenderer('development:changed');
      sendToRenderer('web:changed');
    });
  });
}

async function recoverAbandonedArtifactStaging(): Promise<void> {
  const registry = await loadRegistryDocument(registryPath);
  await Promise.all(registry.workspaces
    .filter((workspace) => workspace.enabled && workspace.permissions.write)
    .map((workspace) => cleanupWorkspaceArtifactStaging(workspace, {
      withAuthorizedEffect: (effect) => withAuthorizedWorkspaceEffect(
        registryPath, desktopSecurityLogger, workspace, 'write', effect,
      ),
    }).catch(() => undefined)));
}

function quitApplication(): void {
  explicitQuit = true;
  tunnel.disconnect();
  app.quit();
}

function desktopBundledRuntimePaths() {
  const resourcesRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const paths = resolveBundledRuntimePaths(resourcesRoot, app.getPath("userData"));
  return app.isPackaged
    ? paths
    : { ...paths, serverBundlePath: join(app.getAppPath(), "out", "server", "index.cjs") };
}

async function startDevelopmentRuntime(): Promise<void> {
  await migrateRegistryFile(registryPath);
  await ensureV1Catalog();
  await healReviewedProjects();
  await interruptProjectSetupSessions(projectSetupStorePath());
  const resourcesRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const runtimePaths = desktopBundledRuntimePaths();
  const helperPath = join(resourcesRoot, "vendor", "process-host", "localbridge-process-host.exe");
  processSupervisor = new ProcessSupervisor({
    helperPath,
    nodeBinaryPath: runtimePaths.nodeBinaryPath,
    parentPid: process.pid,
    loadWorkspace: async (workspaceId) =>
      (await listWorkspaces(registryPath)).find((workspace) => workspace.id === workspaceId),
  });
  applicationSupervisor = new ApplicationSupervisor({
    processes: processSupervisor,
    loadRegistry: () => loadRegistryDocument(registryPath),
    onActivityChange: () => {
      reconcileLiveViewerCoordinatorState();
      sendToRenderer('development:changed');
    },
  });
  setupSupervisor = new SetupSupervisor({
    helperPath,
    nodeBinaryPath: runtimePaths.nodeBinaryPath,
    parentPid: process.pid,
    loadWorkspace: async (workspaceId) =>
      (await listWorkspaces(registryPath)).find((workspace) => workspace.id === workspaceId),
    isWorkspaceBusy: (workspaceId) => processSupervisor?.listAll().some((entry) => entry.workspaceId === workspaceId && entry.state === "running") ?? false,
    onChange: () => sendToRenderer("projects:changed"),
  });
  terminalSupervisor = new TerminalSupervisor({
    helperPath,
    parentPid: process.pid,
    deviceBinding,
    loadProject: async (projectId) => (await loadProjectCatalog(projectCatalogPath())).projects.find((project) => project.id === projectId),
    loadTrust: async (projectId) => (await loadProjectTrustStore(projectTrustPath())).decisions.find((decision) => decision.projectId === projectId),
    onProjectActivity: scheduleV1ProjectRescan,
  });
  browserController = new BrowserController({
    loadWorkspace: async (workspaceId) =>
      (await listWorkspaces(registryPath)).find((workspace) => workspace.id === workspaceId),
    loadApplication: async (applicationIdOrName) =>
      (await listApplications(registryPath)).find((application) =>
        application.id === applicationIdOrName || application.name.toLocaleLowerCase() === applicationIdOrName.toLocaleLowerCase()),
    resolveProcessListener: async (workspaceId, processId, listenerRef) => {
      if (processId.startsWith("terminal_")) {
        const project = (await loadProjectCatalog(projectCatalogPath())).projects.find((candidate) =>
          candidate.compatibilityRefs.some((reference) => reference.kind === "workspace" && reference.id === workspaceId));
        if (project === undefined) throw new DevelopmentBrokerError("PROJECT_NOT_FOUND", "El proyecto de la terminal ya no existe.");
        return terminalSupervisor!.resolveListener(project.id, processId, listenerRef, workspaceId);
      }
      return processSupervisor!.resolveListener(workspaceId, processId, listenerRef);
    },
    resolveTerminalListener: (projectId, terminalSessionId, listenerRef, workspaceId) =>
      terminalSupervisor!.resolveListener(projectId, terminalSessionId, listenerRef, workspaceId),
    beforeHumanControlRequest: async () => liveViewerCoordinator?.hide(),
    reserveHumanControl: (sessionId) => reserveHumanControlOrFail("development", sessionId),
    releaseHumanControl: (sessionId) => humanControlCoordinator.release({ kind: "development", sessionId }),
    restoreLiveViewerAfterHuman: async (sessionId, workArea) => {
      if (browserController === undefined || liveViewerCoordinator === undefined) return;
      await liveViewerCoordinator.show(
        { kind: "development", sessionId },
        () => browserController!.showLiveViewerLocally(sessionId, workArea),
      );
    },
    onHumanControlRequest: (_session) => {
      sendToRenderer('development:changed');
      mainWindow?.flashFrame(true);
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'ChatGPT necesita tu intervención',
          body: 'Abre LocalBridge y pulsa Tomar control cuando estés listo.',
          icon: appIcon(),
        });
        notification.on('click', showMainWindow);
        notification.show();
      }
    },
    onActivityChange: () => {
      reconcileLiveViewerCoordinatorState();
      sendToRenderer('development:changed');
    },
    onHumanControlTransition: (event) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        workspaceId: event.workspaceId,
        action: event.action,
        resource: `${event.sessionId}${event.reason === undefined ? '' : `:${event.reason}`}`,
        riskLevel: 'R5',
        decision: event.decision,
        outcome: event.outcome,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        durationMs: 0,
      }));
    },
    onSecurityDiagnostic: (message) => {
      sendToRenderer('tunnel:log', `[browser-security] ${message}`, 'stderr');
      sendToRenderer('development:changed');
    },
    onMotionDiagnostic: (diagnostic) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        workspaceId: diagnostic.workspaceId,
        action: 'browser.motion.diagnostic',
        resource: diagnostic.sessionId,
        riskLevel: 'R2',
        decision: 'allow',
        outcome: 'error',
        errorCode: diagnostic.causeCode ?? 'MOTION_EFFECT_UNCERTAIN',
        operationId: diagnostic.operationId,
        durationMs: 0,
      }));
    },
    saveScreenshot: async (input) => {
      if (input.expectedWorkspace.id !== input.workspaceId) throw new LocalBridgeError("APPROVAL_INVALID");
      return withAuthorizedWorkspaceCapabilitiesEffect(
        registryPath,
        desktopSecurityLogger,
        input.expectedWorkspace,
        ["browserRead", "write"],
        () => createWorkspaceBinaryFile(input.expectedWorkspace, input.path, input.bytes),
      );
    },
    preflightScreenshot: async (input) => {
      if (input.expectedWorkspace.id !== input.workspaceId) throw new LocalBridgeError("APPROVAL_INVALID");
      await withAuthorizedWorkspaceCapabilitiesEffect(
        registryPath,
        desktopSecurityLogger,
        input.expectedWorkspace,
        ["browserRead", "write"],
        async () => { await preflightWorkspaceBinaryFileCreate(input.expectedWorkspace, input.path); },
      );
    },
    saveMotionBundle: async (input) => {
      if (input.expectedWorkspace.id !== input.workspaceId) throw new LocalBridgeError("APPROVAL_INVALID");
      return withAuthorizedWorkspaceCapabilitiesEffect(
        registryPath,
        desktopSecurityLogger,
        input.expectedWorkspace,
        ["browserRead", "write"],
        () => createWorkspaceArtifactDirectory(input.expectedWorkspace, input.path, input.produce, {
          maxFileBytes: 256 * 1024 * 1024,
          maxTotalBytes: 1024 * 1024 * 1024,
          reserveFreeBytes: 512 * 1024 * 1024,
        }),
      );
    },
    confirmHumanControlHandoff: async (workspaceName) => {
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Devolver a ChatGPT', 'Seguir con el control'],
        defaultId: 1,
        cancelId: 1,
        title: 'Devolver control a ChatGPT',
        message: `¿Terminaste tu intervención en ${workspaceName}?`,
        detail: 'LocalBridge ocultará la ventana, descartará las observaciones del intervalo privado y ChatGPT podrá volver a observar e interactuar desde este punto. No se transportan credenciales, rutas ni archivos por el canal de control.',
      });
      return result.response === 0;
    },
  });
  webController = new WebController({
    loadProfile: async (webProfileId) => {
      const snapshot = await readWebProfileStore(webProfileStorePath);
      if (snapshot.state !== "ready") return undefined;
      return snapshot.document.profiles.find((profile) => profile.id === webProfileId);
    },
    listProfiles: async () => {
      const snapshot = await readWebProfileStore(webProfileStorePath);
      return snapshot.state === "ready" ? snapshot.document.profiles : [];
    },
    onActivityChange: () => {
      reconcileLiveViewerCoordinatorState();
      sendToRenderer("web:changed");
    },
    onLiveViewerChange: () => {
      reconcileLiveViewerCoordinatorState();
      sendToRenderer("web:changed");
    },
    beforeHumanControlRequest: async () => liveViewerCoordinator?.hide(),
    reserveHumanControl: (sessionId) => reserveHumanControlOrFail("web", sessionId),
    releaseHumanControl: (sessionId) => humanControlCoordinator.release({ kind: "web", sessionId }),
    confirmHumanControlHandoff: async ({ profileKind, profileName, hostname }) => {
      if (profileKind === "site-account") {
        const result = await dialog.showMessageBox({
          type: "question",
          buttons: ["Devolver a ChatGPT", "Seguir con el control"],
          defaultId: 1,
          cancelId: 1,
          title: "Devolver control a ChatGPT",
          message: `¿Terminaste tu intervención en ${profileName}?`,
          detail: `ChatGPT continuará en ${hostname}. Las credenciales y el intervalo privado permanecen fuera del canal de control.`,
        });
        return result.response === 0 ? "share-once" : "continue-human";
      }
      const result = await dialog.showMessageBox({
        type: "question",
        buttons: ["Continuar una vez", "Continuar y recordar sitio", "Seguir con el control"],
        defaultId: 2,
        cancelId: 2,
        title: "Continuar navegación con ChatGPT",
        message: `¿Permites que ChatGPT continúe en ${hostname}?`,
        detail: "La concesión se limita a este hostname durante 15 minutos. LocalBridge cortará conexiones y recargará la URL actual; un formulario sin guardar puede perderse. No envía contraseñas ni el historial privado al chat y conserva el inicio de sesión del sitio.",
      });
      if (result.response === 0) return "share-once";
      if (result.response === 1) return "share-and-remember";
      return "continue-human";
    },
    rememberSiteAccess: async (hostname) => {
      const snapshot = await readWebProfileStore(webProfileStorePath);
      if (snapshot.state === "corrupt") throw new Error("El registro web está corrupto; no se pudo recordar el sitio.");
      const next = rememberExactSiteAccess(snapshot.document, hostname);
      if (next === snapshot.document) return;
      await replaceWebProfileStore(webProfileStorePath, next, snapshot.sha256);
      sendToRenderer("web:changed");
    },
    onHumanControlRequest: () => {
      sendToRenderer("web:changed");
      mainWindow?.flashFrame(true);
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: "ChatGPT necesita tu intervención web",
          body: "Abre LocalBridge para tomar el control de la sesión aislada.",
          icon: appIcon(),
        });
        notification.on("click", showMainWindow);
        notification.show();
      }
    },
    onHumanControlTransition: (transition) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        action: transition.action,
        resource: `${transition.sessionId}${transition.reason === undefined ? "" : `:${transition.reason}`}`,
        riskLevel: "R5",
        decision: "allow",
        outcome: "success",
        durationMs: 0,
      }));
    },
    onCaptureDiagnostic: (diagnostic) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        action: diagnostic.operationId === undefined ? "web.screenshot.diagnostic" : "web.screenshot.save.diagnostic",
        resource: `${diagnostic.sessionId}:${diagnostic.tabId}:${diagnostic.stage}:${diagnostic.outcome}:${diagnostic.width ?? 0}x${diagnostic.height ?? 0}:${diagnostic.encodedBytes ?? 0}`,
        riskLevel: "R2",
        decision: "allow",
        outcome: diagnostic.outcome === "failed" ? "error" : "success",
        ...(diagnostic.code === undefined ? {} : { errorCode: diagnostic.code }),
        ...(diagnostic.operationId === undefined ? {} : { operationId: diagnostic.operationId }),
        durationMs: 0,
      }));
    },
    onDownloadDiagnostic: (diagnostic) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        action: "web.download.diagnostic",
        resource: `${diagnostic.sessionId}:${diagnostic.tabId}:${diagnostic.stage}:${diagnostic.outcome}:${diagnostic.hostname}:${diagnostic.status ?? 0}:${diagnostic.size ?? 0}`,
        riskLevel: "R2",
        decision: "allow",
        outcome: diagnostic.outcome === "failed" ? "error" : "success",
        ...(diagnostic.code === undefined ? {} : { errorCode: diagnostic.code }),
        operationId: diagnostic.operationId,
        durationMs: 0,
      }));
    },
    onMotionDiagnostic: (diagnostic) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        action: 'web.motion.diagnostic',
        resource: `${diagnostic.sessionId}:${diagnostic.tabId}`,
        riskLevel: 'R2',
        decision: 'allow',
        outcome: 'error',
        errorCode: diagnostic.causeCode ?? 'MOTION_EFFECT_UNCERTAIN',
        operationId: diagnostic.operationId,
        durationMs: 0,
      }));
    },
    onNavigationDiagnostic: (diagnostic) => {
      recordAuditEvent(auditDbPath, buildAuditEvent({
        action: 'web.navigate.diagnostic',
        resource: `${diagnostic.sessionId}:${diagnostic.tabId}:${diagnostic.outcome}`,
        riskLevel: 'R2',
        decision: 'allow',
        outcome: diagnostic.outcome === 'recovered' ? 'success' : 'error',
        errorCode: diagnostic.causeCode,
        ...(diagnostic.operationId === undefined ? {} : { operationId: diagnostic.operationId }),
        durationMs: 0,
      }));
    },
    saveDownload: (input) => withAuthorizedWebProfileEffect(
      webProfileStorePath,
      input.webProfileId,
      input.profileRevision,
      "download",
      async () => {
        const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, input.workspaceId, "write");
        return createWorkspaceBinaryFile(workspace, input.path, input.bytes, {
          maximumBytes: input.maximumBytes,
          reserveFreeBytes: 512 * 1024 * 1024,
          withAuthorizedEffect: (effect) => withAuthorizedWorkspaceEffect(
            registryPath,
            desktopSecurityLogger,
            workspace,
            "write",
            effect,
          ),
        });
      },
    ),
    preflightDownload: (input) => withAuthorizedWebProfileEffect(
      webProfileStorePath,
      input.webProfileId,
      input.profileRevision,
      "download",
      async () => {
        const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, input.workspaceId, "write");
        await preflightWorkspaceBinaryFileCreate(workspace, input.path, { maximumBytes: input.maximumBytes });
      },
    ),
    saveDownloadStream: async (input) => {
      await requireCurrentWebProfileAuthority(
        webProfileStorePath,
        input.webProfileId,
        input.profileRevision,
        "download",
      );
      const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, input.workspaceId, "read");
      await requireCurrentWorkspaceAuthority(
        registryPath,
        desktopSecurityLogger,
        workspace,
        ["read", "write"],
      );
      const checkAuthority = async (): Promise<void> => {
        await requireCurrentWebProfileAuthority(
          webProfileStorePath,
          input.webProfileId,
          input.profileRevision,
          "download",
        );
        await requireCurrentWorkspaceAuthority(
          registryPath,
          desktopSecurityLogger,
          workspace,
          ["read", "write"],
        );
      };
      const workspaceMaximum = workspace.limits.largeArtifacts.mode === 'adaptive'
        ? undefined
        : workspace.limits.largeArtifacts.mode === 'custom'
          ? workspace.limits.largeArtifacts.customSourceBytes
          : 1024 * 1024 * 1024;
      const profileMaximum = input.adaptive ? undefined : input.maximumBytes;
      const effectiveMaximum = profileMaximum === undefined
        ? workspaceMaximum
        : workspaceMaximum === undefined ? profileMaximum : Math.min(profileMaximum, workspaceMaximum);
      return createWorkspaceBinaryFileFromChunks(workspace, input.path, input.produce, {
        ...(effectiveMaximum === undefined ? { adaptive: true } : { maximumBytes: effectiveMaximum }),
        reserveFreeBytes: workspace.limits.largeArtifacts.reserve.minimumFreeBytes,
        reserveFreePercent: workspace.limits.largeArtifacts.reserve.minimumFreePercent,
        checkAuthority,
        withAuthorizedEffect: (effect) => withAuthorizedWebProfileEffect(
          webProfileStorePath,
          input.webProfileId,
          input.profileRevision,
          "download",
          () => withCurrentWorkspaceAuthorityEffect(
            registryPath,
            desktopSecurityLogger,
            workspace,
            ["read", "write"],
            effect,
          ),
        ),
      });
    },
    saveMotionBundle: (input) => withAuthorizedWebProfileEffect(
      webProfileStorePath,
      input.webProfileId,
      input.profileRevision,
      "download",
      async () => {
        const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, input.workspaceId, "write");
        return createWorkspaceArtifactDirectory(workspace, input.path, input.produce, {
          maxFileBytes: 256 * 1024 * 1024,
          maxTotalBytes: 1024 * 1024 * 1024,
          reserveFreeBytes: 512 * 1024 * 1024,
          withAuthorizedEffect: (effect) => withAuthorizedWorkspaceEffect(
            registryPath,
            desktopSecurityLogger,
            workspace,
            "write",
            effect,
          ),
        });
      },
    ),
  });
  liveViewerCoordinator = new LiveViewerCoordinator({
    hideDevelopment: async (sessionId) => browserController?.hideLiveViewerLocally(sessionId),
    hideWeb: async (sessionId) => webController?.hideLiveViewerLocally(sessionId),
    hasHumanControl: () => humanControlCoordinator.current() !== undefined,
    onChange: () => {
      sendToRenderer("development:changed");
      sendToRenderer("web:changed");
    },
  });
  analysisSupervisor = undefined;
  analysisUnavailableReason = undefined;
  taskBatchSupervisor = undefined;
  taskBatchUnavailableReason = undefined;
  try {
    const artifactAnalysisRuntime = new ArtifactAnalysisRuntime({
      workspaceConfigPath: registryPath,
      logger: desktopSecurityLogger,
      cursorSigningKey: Buffer.from(deviceBinding, 'utf8'),
      documentWorkerPath: join(dirname(runtimePaths.serverBundlePath), "document-worker.cjs"),
      webDownload: (sessionId, tabId, resourceRef, workspaceId, path, operationId, signal) => {
        if (webController === undefined) throw new LocalBridgeError("FEATURE_UNAVAILABLE");
        return webController.download(sessionId, tabId, resourceRef, workspaceId, path, operationId, signal);
      },
    });
    analysisSupervisor = new AnalysisJobSupervisor({
      journalPath: join(dirname(auditDbPath), "analysis-jobs.sqlite"),
      execute: artifactAnalysisRuntime.execute,
      concurrencyForWorkspace: async (workspaceId) => {
        const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, workspaceId, "read");
        return workspace.limits.largeArtifacts.maxConcurrentJobs;
      },
      onChange: () => sendToRenderer("development:changed"),
    });
    try {
      taskBatchSupervisor = new TaskBatchSupervisor({
        journalPath: join(dirname(auditDbPath), "task-batches.sqlite"),
        analysis: analysisSupervisor,
        runValidation: async (workspaceId, profile, context) => {
          const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, workspaceId, "validations");
          const command = workspace.validationProfiles[profile];
          if (command === undefined) throw new LocalBridgeError("COMMAND_NOT_ALLOWED");
          const result = await runValidation(workspace, profile, {
            signal: context.signal,
            onStarted: context.started,
            onLockAcquired: context.lockAcquired,
            onLockReleased: context.lockReleased,
          });
          return { ...result, reviewFingerprint: hashText(JSON.stringify(command)) };
        },
        revalidateRead: async (workspaceId) => {
          await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, workspaceId, "read");
        },
        preflightBatch: async (request) => {
          const workspace = await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, request.workspaceId, "read");
          for (const child of request.children) {
            if (child.operationKind === 'validation.run') {
              const validationWorkspace = await requireAuthorizedWorkspace(
                registryPath, desktopSecurityLogger, request.workspaceId, "validations",
              );
              if (validationWorkspace.validationProfiles[String(child.parameters['profile'])] === undefined) {
                throw new LocalBridgeError('COMMAND_NOT_ALLOWED');
              }
              continue;
            }
            const sourcePath = child.sourcePath!;
            if (isPathDenied(sourcePath, workspace.denyPatterns)) throw new LocalBridgeError('PATH_DENIED');
            if (child.operationKind === 'web.download.start') {
              await requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, request.workspaceId, "write");
              const destination = await resolveWriteTarget(workspace.rootPath, sourcePath, { createParentDirs: false });
              if (destination.exists) throw new LocalBridgeError('FILE_ALREADY_EXISTS');
              if (webController === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
              await webController.preflightDownloadReference(
                String(child.parameters['sessionId']),
                String(child.parameters['tabId']),
                String(child.parameters['resourceRef']),
              );
              continue;
            }
            const source = await resolveSafePath(workspace.rootPath, sourcePath);
            if (!source.exists) throw new LocalBridgeError('FILE_NOT_FOUND');
          }
        },
        onChange: () => sendToRenderer("development:changed"),
      });
    } catch (error) {
      taskBatchUnavailableReason = 'journal-unavailable';
      desktopSecurityLogger.error('task batch runtime unavailable', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  } catch (error) {
    // El journal nuevo es una capacidad aislada. Su caída impide admitir jobs
    // sin durabilidad, pero no derriba terminal, Git, navegador ni lecturas
    // síncronas existentes.
    analysisUnavailableReason = 'journal-unavailable';
    desktopSecurityLogger.error('analysis runtime unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  developmentBroker = await startDevelopmentBroker({
    handler: createDevelopmentRuntimeHandler({
      processes: processSupervisor,
      terminals: terminalSupervisor,
      applications: applicationSupervisor,
      projects: {
        list: listProjectsForBroker,
        status: projectStatusForBroker,
        refresh: async (projectId) => {
          await analyzeAssistedProject(projectId);
          return projectStatusForBroker(projectId);
        },
      },
      ...(analysisSupervisor === undefined ? {} : { analysis: analysisSupervisor }),
      ...(taskBatchSupervisor === undefined ? {} : { tasks: taskBatchSupervisor }),
      browser: browserController,
      web: webController,
    }),
  });
}

async function listProjectsForBroker() {
  const registry = await loadRegistryDocument(registryPath);
  const enabled = new Set(registry.workspaces.filter((workspace) => workspace.enabled).map((workspace) => workspace.id));
  const projects = await listDevelopmentProjects(projectStorePath(), registry);
  // El estado del catálogo y la cobertura del escaneo se informan al agente
  // (ADR-0040) para que pueda explicar una estructura parcial o una revisión
  // pendiente en vez de encontrarse una denegación sin causa visible. No se
  // exponen recuentos, rutas ni nombres de carpeta.
  const [catalog, scans, trustStore, setupSessions] = await Promise.all([
    loadProjectCatalog(projectCatalogPath()).catch(() => ({ schemaVersion: 1 as const, projects: [] })),
    loadProjectScanStore(projectScanPath()).catch(() => ({ schemaVersion: 1 as const, scans: [] })),
    loadProjectTrustStore(projectTrustPath()).catch(() => ({ schemaVersion: 1 as const, decisions: [] })),
    listProjectSetupSessions(projectSetupStorePath()).catch(() => []),
  ]);
  return {
    projects: projects.filter((project) => project.workspaceIds.every((workspaceId) => enabled.has(workspaceId))).map((project) => {
      const record = catalog.projects.find((candidate) => candidate.id === project.id);
      const trust = trustStore.decisions.find((decision) => decision.projectId === project.id);
      const terminalAvailable = record?.state === "ready" && trust?.status === "active" &&
        trust.deviceBinding === deviceBinding && trust.mode === "full-host";
      const blockedReason = terminalAvailable
        ? undefined
        : record?.state !== "ready" ? "project-not-ready" as const
          : trust?.status !== "active" ? "trust-inactive" as const
            : trust.deviceBinding !== deviceBinding ? "device-mismatch" as const
              : trust.mode === "guided" ? "guided-mode" as const
                : "sandbox-unavailable" as const;
      const projectWorkspaces = registry.workspaces.filter((workspace) => project.workspaceIds.includes(workspace.id));
      const reviewedProfiles = {
        processes: projectWorkspaces.flatMap((workspace) => Object.keys(workspace.processProfiles ?? {}).toSorted().map((name) => ({
          workspaceId: workspace.id,
          name,
          available: workspace.permissions.processes && workspace.automationReviewRequired !== true,
          ...(!workspace.permissions.processes
            ? { blockedReason: "capability-disabled" as const }
            : workspace.automationReviewRequired === true ? { blockedReason: "automation-review-required" as const } : {}),
        }))),
        validations: projectWorkspaces.flatMap((workspace) => Object.keys(workspace.validationProfiles).toSorted().map((name) => ({
          workspaceId: workspace.id,
          name,
          available: workspace.permissions.validations,
          ...(workspace.permissions.validations ? {} : { blockedReason: "capability-disabled" as const }),
        }))),
        browser: projectWorkspaces.flatMap((workspace) => Object.keys(workspace.browserProfiles ?? {}).toSorted().map((name) => ({
          workspaceId: workspace.id,
          name,
          available: workspace.permissions.browserRead && workspace.automationReviewRequired !== true,
          ...(!workspace.permissions.browserRead
            ? { blockedReason: "capability-disabled" as const }
            : workspace.automationReviewRequired === true ? { blockedReason: "automation-review-required" as const } : {}),
        }))),
      };
      const setupSession = setupSessions.filter((candidate) => candidate.projectId === project.id).at(-1);
      const proposal = setupSession?.plan;
      const setupPhase = setupSession?.phase;
      const proposalState = proposal === undefined || setupPhase === "ready" || setupPhase === "cancelled"
        ? "none" as const
        : setupPhase === "awaiting-local-review" ? "detected-awaiting-review" as const
          : setupPhase === "installing" || setupPhase === "finalizing" ? "applying" as const
            : "detected-inactive" as const;
      return {
        projectId: project.id,
        name: project.name,
        description: project.description,
        workspaceIds: project.workspaceIds,
        ...(project.applicationId === undefined ? {} : { applicationId: project.applicationId }),
        setupStatus: project.setupStatus,
        state: record?.state ?? "unavailable",
        scanCoverage: scans.scans.find((scan) => scan.projectId === project.id)?.coverage ?? "unknown",
        execution: {
          trustMode: trust?.mode ?? "guided",
          terminalAvailable,
          ...(blockedReason === undefined ? {} : { blockedReason }),
        },
        automation: {
          reviewedProfiles,
          detectedProposal: {
            state: proposalState,
            processCount: proposalState === "none" ? 0 : proposal?.proposedProfiles.filter((profile) => profile.role === "server").length ?? 0,
            validationCount: proposalState === "none" ? 0 : proposal?.proposedProfiles.filter((profile) => profile.role === "validation").length ?? 0,
          },
        },
      };
    }),
  };
}

async function projectStatusForBroker(projectId: string) {
  if (!/^project_[a-f0-9]{24}$/.test(projectId)) throw new DevelopmentBrokerError("PROJECT_NOT_FOUND", "El proyecto no existe.");
  const listed = await listProjectsForBroker();
  const project = listed.projects.find((candidate) => candidate.projectId === projectId);
  if (project === undefined) throw new DevelopmentBrokerError("PROJECT_NOT_FOUND", "El proyecto no existe o no está disponible.");
  const session = (await listProjectSetupSessions(projectSetupStorePath())).filter((candidate) => candidate.projectId === projectId).at(-1);
  const plan = session?.plan;
  return {
    project,
    setup: session === undefined ? undefined : {
      phase: session.phase,
      policy: session.policy,
      ...(session.errorCode === undefined ? {} : { errorCode: session.errorCode }),
      ...(plan === undefined ? {} : {
        plan: {
          planSha256: plan.planSha256,
          topology: plan.topology,
          workspaceCount: plan.proposedWorkspaceRoots.length,
          installCount: plan.actions.filter((action) => action.kind === "node-install").length,
          packageManagers: plan.packageManagers,
          directDependencyCount: plan.directDependencyCount,
          directDevDependencyCount: plan.directDevDependencyCount,
          serverCount: plan.proposedProfiles.filter((profile) => profile.role === "server").length,
          validationCount: plan.proposedProfiles.filter((profile) => profile.role === "validation").length,
          serviceCount: plan.proposedApplication?.services.length ?? 0,
          actionKinds: [...new Set(plan.actions.map((action) => action.kind))],
        },
      }),
    },
  };
}

function requiredToolchainKinds(
  topology: Awaited<ReturnType<typeof detectProjectTopology>>,
  initializeGit: boolean,
  policy: ProjectSetupSession["policy"],
) {
  const managers = new Set<"npm" | "pnpm" | "yarn" | "git">();
  if (policy !== "manual") {
    for (const lockfile of topology.lockfiles) {
      if (lockfile.manager === "npm" || lockfile.manager === "pnpm" || lockfile.manager === "yarn") managers.add(lockfile.manager);
    }
    for (const command of topology.commands) {
      const binary = command.processProfile.command[0];
      if (binary === "npm" || binary === "pnpm" || binary === "yarn") managers.add(binary);
    }
    if (topology.manifests.some((manifest) => manifest.kind === "package") && managers.size === 0) managers.add("npm");
  }
  if (initializeGit) managers.add("git");
  return [...managers];
}

async function toolchainsForPlan(plan: SetupPlan): Promise<ResolvedSetupToolchain[]> {
  const kinds = new Set<"npm" | "pnpm" | "yarn" | "git">();
  for (const action of plan.actions) {
    if (action.kind === "node-install") kinds.add(action.manager);
    if (action.kind === "git-init") kinds.add("git");
  }
  return resolveSetupToolchains([...kinds]);
}

async function currentProject(projectId: string): Promise<DevelopmentProject> {
  const registry = await loadRegistryDocument(registryPath);
  const project = (await listDevelopmentProjects(projectStorePath(), registry)).find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error("Proyecto asistido no encontrado.");
  return project;
}

const SETUP_SESSION_ERROR_CODES = new Set([
  "SETUP_MANIFEST_MISSING",
  "SETUP_PLAN_STALE",
  "SETUP_TOOLCHAIN_MISSING",
  "SETUP_ALREADY_RUNNING",
  "SETUP_WORKSPACE_BUSY",
  "SETUP_PRIVATE_CONFIG_UNSUPPORTED",
  "SETUP_CANCELLED",
  "SETUP_FAILED",
  "SETUP_INTERRUPTED",
  "TOPOLOGY_REVIEW_REQUIRED",
  "UNSUPPORTED_ECOSYSTEM",
]);

function setupSessionErrorCode(error: unknown, fallback = "SETUP_FAILED"): string {
  const raw = (typeof error === "string" ? error.split(":")[0] : error instanceof Error ? error.message.split(":")[0] : fallback) ?? fallback;
  if (raw === "SETUP_TOOLCHAIN_CHANGED" || raw === "SETUP_TOPOLOGY_MISMATCH") return "SETUP_PLAN_STALE";
  if (raw === "SETUP_TIMEOUT" || raw === "SETUP_START_FAILED" || raw === "SETUP_COMMAND_FAILED") return "SETUP_FAILED";
  return SETUP_SESSION_ERROR_CODES.has(raw) ? raw : fallback;
}

function recordProjectAudit(
  action: string,
  projectId: string,
  workspaceId: string | undefined,
  outcome: "success" | "error" = "success",
  errorCode?: string,
): void {
  recordAuditEvent(auditDbPath, buildAuditEvent({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    action,
    resource: projectId,
    riskLevel: action.includes("execute") || action.includes("finalize") ? "R3" : action.includes("plan") ? "R2" : "R1",
    decision: "allow",
    outcome,
    ...(errorCode === undefined ? {} : { errorCode }),
    durationMs: 0,
  }));
}

async function analyzeAssistedProject(projectId: string, initializeGit?: boolean): Promise<ProjectSetupSession> {
  const registry = await loadRegistryDocument(registryPath);
  const project = (await listDevelopmentProjects(projectStorePath(), registry)).find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error("Proyecto asistido no encontrado.");
  const provisional = registry.workspaces.find((workspace) => workspace.id === project.workspaceIds[0]);
  if (provisional === undefined || !provisional.enabled) throw new Error("La carpeta provisional ya no está autorizada.");
  const sessions = await listProjectSetupSessions(projectSetupStorePath());
  let session = sessions.filter((candidate) => candidate.projectId === projectId).at(-1);
  if (session === undefined || ["ready", "cancelled"].includes(session.phase)) {
    session = await createProjectSetupSession(projectSetupStorePath(), project.id, provisional.id, "restricted");
  }
  const useGit = initializeGit ?? session.initializeGit;
  const analyzing = {
    ...session,
    initializeGit: useGit,
    phase: "analyzing" as const,
    updatedAt: new Date().toISOString(),
    ...(session.plan === undefined ? {} : { plan: session.plan }),
  };
  session = await updateProjectSetupSession(projectSetupStorePath(), analyzing);
  sendToRenderer("projects:changed");
  try {
    const topology = await detectProjectTopology(provisional);
    recordProjectAudit("project.topology.scan", project.id, provisional.id);
    const resolved = await resolveSetupToolchains(requiredToolchainKinds(topology, useGit, session.policy));
    const plan = buildSetupPlan(project, topology, session.policy, resolved, { initializeGit: useGit });
    recordProjectAudit("project.setup.plan", project.id, provisional.id);
    session = await updateProjectSetupSession(projectSetupStorePath(), {
      ...session,
      phase: "awaiting-local-review",
      plan,
      updatedAt: new Date().toISOString(),
    });
    await upsertDevelopmentProject(projectStorePath(), registry, {
      ...project,
      setupStatus: "review-required",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const code = setupSessionErrorCode(error);
    recordProjectAudit("project.setup.plan", project.id, provisional.id, "error", code);
    const { plan: _previousPlan, errorCode: _previousError, ...base } = session;
    session = await updateProjectSetupSession(projectSetupStorePath(), {
      ...base,
      phase: code === "SETUP_MANIFEST_MISSING" ? "awaiting-local-review" : "failed",
      errorCode: code,
      updatedAt: new Date().toISOString(),
    });
  }
  sendToRenderer("projects:changed");
  return session;
}

async function verifyApplicationLocally(applicationId: string) {
  if (applicationSupervisor === undefined || browserController === undefined) throw new Error("El runtime de aplicaciones no está disponible.");
  const application = (await listApplications(registryPath)).find((candidate) => candidate.id === applicationId);
  if (application === undefined || application.reviewState === "conflict") throw new Error("La aplicación no se puede verificar hasta resolver su configuración.");
  let initial: Awaited<ReturnType<ApplicationSupervisor["startForLocalReview"]>> | undefined;
  let current: Awaited<ReturnType<ApplicationSupervisor["startForLocalReview"]>> | undefined;
  try {
    initial = await applicationSupervisor.startForLocalReview(applicationId);
    current = initial;
    const deadline = Date.now() + 25_000;
    while (current.state === "starting" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      current = await applicationSupervisor.status(initial.runId);
    }
    if (current.state !== "ready") {
      const failed = current.services.find((service) => service.state === "failed");
      const target = failed === undefined ? "uno de los servicios" : `“${failed.service}” (perfil ${failed.processProfile})`;
      throw new Error(`La aplicación quedó guardada, pero no se pudo iniciar ${target}. Comprueba su configuración y vuelve a intentarlo.`);
    }
    const resolved = await applicationSupervisor.resolveReadyRunForLocalReview(applicationId, initial.runId);
    const browser = await browserController.startApplicationForLocalReview(
      resolved.summary.primaryWorkspaceId,
      application,
      resolved.services.map((service) => ({ service: service.service, processId: service.processId, listenerRef: service.listenerRef })),
    );
    await browserController.stopLocalReviewSession(browser.sessionId);
    await applicationSupervisor.stop(initial.runId);
    const reviewed = { ...application, reviewState: "reviewed" as const, updatedAt: new Date().toISOString() };
    await upsertApplication(registryPath, reviewed);
    return { application: reviewed, run: current };
  } catch (error) {
    await browserController.stopApplication(applicationId).catch(() => undefined);
    if (initial !== undefined) await applicationSupervisor.stop(initial.runId).catch(() => undefined);
    throw error;
  }
}

function updateTrayMenu(): void {
  if (tray === undefined) return;
  tray.setToolTip(`LocalBridge MCP — ${lastTunnelStatus === "connected" ? "Conectado" : TUNNEL_STATUS_LABELS_MAIN[lastTunnelStatus]}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir LocalBridge", click: showMainWindow },
      { label: "Ocultar", enabled: mainWindow?.isVisible() === true, click: () => mainWindow?.hide() },
      { type: "separator" },
      { label: "Desconectar túnel", enabled: lastTunnelStatus !== "disconnected", click: () => tunnel.disconnect() },
      { type: "separator" },
      { label: "Salir de LocalBridge", click: quitApplication },
    ]),
  );
}

const TUNNEL_STATUS_LABELS_MAIN: Record<TunnelStatus, string> = {
  disconnected: "Desconectado",
  connecting: "Conectando",
  connected: "Conectado",
  error: "Error de conexión",
};

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "LocalBridge",
        submenu: [
          { label: "Mostrar", accelerator: "CmdOrCtrl+Shift+L", click: showMainWindow },
          { label: "Ocultar", click: () => mainWindow?.hide() },
          { type: "separator" },
          { label: "Salir", accelerator: "Alt+F4", click: quitApplication },
        ],
      },
      { label: "Editar", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "Ver", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    ]),
  );
}

function createTray(): void {
  tray = new Tray(appIcon());
  tray.on("click", showMainWindow);
  updateTrayMenu();
}

async function withTunnelSetupLock<T>(operation: () => Promise<T>): Promise<T> {
  if (tunnelSetupInProgress || tunnel.getStatus() !== "disconnected") {
    throw new Error("El túnel debe estar desconectado para cambiar o diagnosticar su perfil.");
  }
  tunnelSetupInProgress = true;
  try {
    return await operation();
  } finally {
    tunnelSetupInProgress = false;
  }
}

function bundledProvisionOptions(connection: ConnectionProfile): TunnelProvisionOptions {
  const paths = desktopBundledRuntimePaths();
  return {
    binaryPath: paths.tunnelBinaryPath,
    profileDir:
      connection.id === DEFAULT_CONNECTION_PROFILE.id ? paths.profileDir : join(paths.profileDir, connection.id),
    profile: paths.profile,
    tunnelId: tunnelIdSchema.parse(connection.tunnelId),
    serverCommand: bundledServerCommand(paths),
  };
}

async function activeConnectionContext() {
  const settings = await readDesktopSettings(settingsPath);
  const connection = activeConnectionProfile(settings);
  return { settings, connection, keyPath: defaultTunnelKeyPath(connection.id) };
}

async function activeStoredTunnelKey() {
  const context = await activeConnectionContext();
  const migration = await migrateLegacyEncryptedKey({
    profileIds: context.settings.connectionProfiles.map((profile) => profile.id),
    activeProfileId: context.connection.id,
  }, keyStoreDeps);
  const loaded = await loadEncryptedKey(context.keyPath, keyStoreDeps);
  if (loaded.status !== "absent") return { ...context, loaded, migration };
  if (migration.status === "encryption-unavailable") {
    return { ...context, loaded: { status: "encryption-unavailable" } as const, migration };
  }
  if (migration.status === "source-unreadable") {
    return { ...context, loaded: { status: "unreadable" } as const, migration };
  }
  if (migration.status === "failed") {
    return { ...context, loaded: { status: "io-error", code: "KEY_STORE_READ_FAILED" } as const, migration };
  }
  return { ...context, loaded, migration };
}

async function saveAndVerifyTunnelKey(keyPath: string, apiKey: string): Promise<boolean> {
  return saveAndVerifyEncryptedKey(keyPath, apiKey, keyStoreDeps);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const trustedContents = mainWindow === undefined || mainWindow.isDestroyed() ? undefined : mainWindow.webContents;
  assertTrustedIpcSender(event, trustedContents);
}

/**
 * `mainWindow?.webContents.send(...)` no basta: al cerrar la ventana, Electron
 * destruye el `webContents` nativo, pero la variable JS `mainWindow` sigue
 * apuntando a un objeto no nulo (el wrapper) hasta que se limpia a mano en
 * `closed`. `?.` solo protege contra `null`/`undefined`, no contra un objeto
 * nativo ya destruido — llamar a un método ahí lanza `TypeError: Object has
 * been destroyed`, justo el crash que apareció al cerrar con el túnel
 * conectado (`disconnect()` dispara `onStatusChange` de camino a la salida).
 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
}

const tunnel = new TunnelSupervisor({
  onStatusChange: (status: TunnelStatus, detail?: string) => {
    const previous = lastTunnelStatus;
    lastTunnelStatus = status;
    updateTrayMenu();
    sendToRenderer("tunnel:status-change", status, detail);
    if (status === "error" && previous !== "error" && Notification.isSupported()) {
      const notification = new Notification({
        title: "LocalBridge perdió la conexión",
        body: detail ?? "Los reintentos automáticos terminaron. Abre LocalBridge para revisar la conexión.",
        icon: appIcon(),
      });
      notification.on("click", showMainWindow);
      notification.show();
    }
  },
  onLog: (line: string, stream: "stdout" | "stderr") => {
    sendToRenderer("tunnel:log", line, stream);
  },
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 480,
    show: false,
    title: "LocalBridge MCP",
    icon: appIcon(),
    webPreferences: {
      preload: join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);
  mainWindow.on("close", (event) => {
    if (explicitQuit || !minimizeToTray) {
      tunnel.disconnect();
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
    if (!backgroundNoticeShown && Notification.isSupported()) {
      backgroundNoticeShown = true;
      new Notification({
        title: "LocalBridge sigue activo",
        body: "La aplicación continúa en la bandeja. Usa “Salir” para cerrar también el túnel.",
        icon: appIcon(),
      }).show();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  // La UI no navega ni abre contenido externo. Bloquear ambas capacidades evita
  // que una inyección en el renderer convierta esta ventana privilegiada en navegador.
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  // electron-vite inyecta esta variable en dev; en producción se carga el HTML empaquetado.
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl !== undefined) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(moduleDirectory, "../renderer/index.html"));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("onboarding:getSnapshot", async (event) => {
    assertTrustedSender(event);
    return onboardingSnapshot(onboardingOwner(event));
  });

  ipcMain.handle("onboarding:restart", async (event) => {
    assertTrustedSender(event);
    const ownerId = onboardingOwner(event);
    const previous = await currentOnboardingState();
    const settings = await readDesktopSettings(settingsPath);
    const next = restartOnboardingState(settings);
    onboardingDrafts.delete(ownerId);
    onboardingFolderSelections.revokeOwner(ownerId);
    onboardingRuntimeReady = false;
    diagnosedOnboardingProfiles.delete(settings.activeConnectionProfileId);
    await persistOnboardingState(previous, next);
    return onboardingSnapshot(ownerId);
  });

  ipcMain.handle("onboarding:next", async (event) => {
    assertTrustedSender(event);
    const ownerId = onboardingOwner(event);
    const previous = await currentOnboardingState();
    const next = advanceOnboarding(previous, await onboardingEvidence(ownerId, previous));
    await persistOnboardingState(previous, next);
    return onboardingSnapshot(ownerId);
  });

  ipcMain.handle("onboarding:back", async (event) => {
    assertTrustedSender(event);
    const ownerId = onboardingOwner(event);
    const previous = await currentOnboardingState();
    const snapshot = buildOnboardingSnapshot(previous, await onboardingEvidence(ownerId, previous));
    const visible = snapshot.effectiveStep === previous.currentStep
      ? previous
      : { ...previous, currentStep: snapshot.effectiveStep };
    const next = backOnboarding(visible);
    await persistOnboardingState(previous, next);
    return onboardingSnapshot(ownerId);
  });

  ipcMain.handle("onboarding:checkRuntime", async (event) => {
    assertTrustedSender(event);
    const report = await checkRuntimeReadiness(desktopBundledRuntimePaths());
    onboardingRuntimeReady = report.ready;
    return { report, snapshot: await onboardingSnapshot(onboardingOwner(event)) };
  });

  ipcMain.handle("onboarding:diagnoseConnection", async (event, apiKeyInput: unknown) => {
    assertTrustedSender(event);
    const apiKey = tunnelApiKeyInputSchema.parse(apiKeyInput);
    return withTunnelSetupLock(async () => {
      const { settings, connection, keyPath } = await activeConnectionContext();
      const provision = bundledProvisionOptions(connection);
      await initializeTunnelProfile(provision);
      const report = await diagnoseTunnelProfile({ ...provision, apiKey, gitApprovalMode: settings.gitApprovalMode });
      let keyPersistence: "remembered" | "failed" | undefined;
      if (report.ok) {
        keyPersistence = await saveAndVerifyTunnelKey(keyPath, apiKey) ? "remembered" : "failed";
        diagnosedOnboardingProfiles.add(settings.activeConnectionProfileId);
        const previous = await currentOnboardingState();
        const next = { ...previous, selectedConnectionProfileId: settings.activeConnectionProfileId, updatedAt: new Date().toISOString() };
        await persistOnboardingState(previous, next);
      }
      return {
        report: {
          ...report,
          ...(keyPersistence === undefined ? {} : { keyPersistence }),
          ...(keyPersistence === "failed" ? { warningCode: "KEY_STORE_WRITE_FAILED" as const } : {}),
        },
        snapshot: await onboardingSnapshot(onboardingOwner(event)),
      };
    });
  });

  ipcMain.handle("onboarding:pickProjectFolder", async (event) => {
    assertTrustedSender(event);
    const ownerId = onboardingOwner(event);
    const snapshot = await onboardingSnapshot(ownerId);
    if (snapshot.effectiveStep !== "project") throw new Error("Completa los pasos anteriores antes de elegir un proyecto.");
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths[0] === undefined) return undefined;
    const inspected = await inspectOnboardingFolder(result.filePaths[0]);
    onboardingFolderSelections.revokeOwner(ownerId);
    const selection = onboardingFolderSelections.create(ownerId, inspected.rootPath, inspected.summary);
    const folder: OnboardingFolderSummary = { selectionId: selection.id, ...selection.summary };
    onboardingDrafts.set(
      ownerId,
      folder.existingProjectId === undefined
        ? { selectionId: selection.id }
        : { selectionId: selection.id, existingProjectId: folder.existingProjectId },
    );
    event.sender.once("destroyed", () => {
      onboardingFolderSelections.revokeOwner(ownerId);
      onboardingDrafts.delete(ownerId);
    });
    return { folder, snapshot: await onboardingSnapshot(ownerId) };
  });

  ipcMain.handle("onboarding:setAccess", async (event, input: unknown) => {
    assertTrustedSender(event);
    const ownerId = onboardingOwner(event);
    const parsed = onboardingAccessInputSchema.parse(input);
    if (parsed.trustMode === "project-agent") {
      throw new Error("Agente en proyecto no está disponible hasta demostrar un sandbox de Windows que falle cerrado.");
    }
    const current = onboardingDrafts.get(ownerId);
    if (current?.selectionId === undefined && current?.existingProjectId === undefined) {
      throw new Error("Selecciona una carpeta o proyecto antes de configurar el acceso.");
    }
    onboardingDrafts.set(ownerId, {
      ...current,
      trustMode: parsed.trustMode,
      guidedPreset: parsed.guidedPreset,
    });
    return onboardingSnapshot(ownerId);
  });

  ipcMain.handle("onboarding:complete", async (event, input: unknown) => {
    assertTrustedSender(event);
    return finalizeOnboarding(onboardingOwner(event), input);
  });

  ipcMain.handle("projects:v1:list", async (event) => {
    assertTrustedSender(event);
    await ensureV1Catalog();
    const [catalog, trust] = await Promise.all([
      loadProjectCatalog(projectCatalogPath()),
      loadProjectTrustStore(projectTrustPath()),
    ]);
    return { projects: catalog.projects, decisions: trust.decisions, sandboxAvailable: false };
  });

  ipcMain.handle("projects:v1:create", async (event, input: unknown) => {
    assertTrustedSender(event);
    const value = input as Record<string, unknown>;
    const name = typeof value["name"] === "string" ? value["name"].normalize("NFKC").trim() : "";
    const description = typeof value["description"] === "string" ? value["description"].normalize("NFKC").trim() : "";
    const rootPath = absolutePathSchema.parse(value["rootPath"]);
    const trustMode = projectTrustModeSchema.parse(value["trustMode"]);
    if (name.length < 1 || name.length > 80 || description.length > 240) throw new Error("Revisa el nombre y la descripción del proyecto.");
    if (parsePath(rootPath).root.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US") === rootPath.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US")) {
      throw new Error("Selecciona una carpeta de proyecto, no la raíz completa de una unidad.");
    }
    if (trustMode === "project-agent") {
      throw new Error("Agente en proyecto no está disponible: el sandbox de Windows aún no superó sus pruebas. Usa Guiado o Control total.");
    }
    if (trustMode === "full-host") {
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "Control total del equipo",
        message: "ChatGPT podrá ejecutar comandos con tu cuenta de Windows",
        detail: "La carpeta elegida será solo el directorio inicial, no un límite de seguridad. Los comandos podrían leer o modificar otros archivos, usar la red, instalar paquetes o iniciar procesos accesibles para tu cuenta. LocalBridge no elevará UAC.",
        buttons: ["Cancelar", "Entiendo y habilitar"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) throw new Error("No se habilitó Control total del equipo.");
    }
    const [previousRegistry, projectSettings] = await Promise.all([
      loadRegistryDocument(registryPath),
      readDesktopSettings(settingsPath),
    ]);
    const existing = previousRegistry.workspaces.find((workspace) => workspace.rootPath.toLocaleLowerCase("en-US") === rootPath.toLocaleLowerCase("en-US"));
    const fullPermissions = {
      read: true, write: true, overwrite: true, gitRead: true, gitWrite: true, validations: true,
      processes: true, browserRead: true, browserInteract: true, browserHumanControl: true,
    } as const;
    const workspace = existing === undefined ? buildNewWorkspace({
      name,
      rootPath,
      largeArtifacts: projectSettings.largeArtifactPreference,
      permissions: trustMode === "full-host" ? fullPermissions : {
        read: true, write: false, overwrite: false, gitRead: true, gitWrite: false, validations: false,
        processes: false, browserRead: false, browserInteract: false, browserHumanControl: false,
      },
    }) : trustMode === "full-host" ? { ...existing, enabled: true, permissions: fullPermissions } : existing;
    if (existing === undefined || workspace !== existing) await upsertWorkspace(registryPath, workspace);
    const registry = await loadRegistryDocument(registryPath);
    const project = buildNewDevelopmentProject({ name, description, workspaceIds: [workspace.id], setupStatus: "ready" });
    try {
      await upsertDevelopmentProject(projectStorePath(), registry, project);
      const build = await catalogRecordForWorkspace(project, workspace);
      const record = await persistCatalogRecord(build);
      const decision = await setProjectTrust(projectTrustPath(), { projectId: project.id, mode: trustMode, deviceBinding });
      recordProjectAudit("project.create", project.id, workspace.id);
      sendToRenderer("projects:changed");
      return { project: record, decision };
    } catch (error) {
      await removeDevelopmentProject(projectStorePath(), project.id).catch(() => undefined);
      await removeProjectCatalogRecord(projectCatalogPath(), project.id).catch(() => undefined);
      await removeProjectScanRecord(projectScanPath(), project.id).catch(() => undefined);
      await replaceRegistry(registryPath, previousRegistry).catch(() => undefined);
      throw error;
    }
  });

  ipcMain.handle("projects:v1:trust", async (event, input: unknown) => {
    assertTrustedSender(event);
    const value = input as Record<string, unknown>;
    const projectId = developmentProjectIdInputSchema.parse(value["projectId"]);
    const mode = projectTrustModeSchema.parse(value["mode"]);
    if (mode === "project-agent") throw new Error("El sandbox de Agente en proyecto no está disponible; se denegó el cambio.");
    const project = (await loadProjectCatalog(projectCatalogPath())).projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("El proyecto no existe.");
    if (mode !== "guided" && project.state !== "ready") throw new Error("El proyecto necesita una raíz única revisada antes de habilitar terminal.");
    const previousRegistry = await loadRegistryDocument(registryPath);
    if (mode === "full-host") {
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "Control total del equipo",
        message: `Habilitar control total para ${project.displayName}`,
        detail: "ChatGPT podrá ejecutar una terminal con la autoridad de tu cuenta de Windows. La carpeta del proyecto no será una frontera de seguridad.",
        buttons: ["Cancelar", "Entiendo y habilitar"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) throw new Error("No se cambió el nivel de confianza.");
      const workspaceIds = project.compatibilityRefs.filter((reference) => reference.kind === "workspace").map((reference) => reference.id);
      for (const workspace of previousRegistry.workspaces.filter((candidate) => workspaceIds.includes(candidate.id))) {
        await upsertWorkspace(registryPath, {
          ...workspace,
          enabled: true,
          permissions: {
            read: true, write: true, overwrite: true, gitRead: true, gitWrite: true, validations: true,
            processes: true, browserRead: true, browserInteract: true, browserHumanControl: true,
          },
        });
      }
    }
    await terminalSupervisor?.stopProject(projectId);
    let decision;
    try {
      decision = await setProjectTrust(projectTrustPath(), { projectId, mode, deviceBinding });
    } catch (error) {
      await replaceRegistry(registryPath, previousRegistry).catch(() => undefined);
      throw error;
    }
    recordProjectAudit("project.trust.change", projectId, undefined);
    sendToRenderer("projects:changed");
    sendToRenderer("development:changed");
    return decision;
  });

  ipcMain.handle("projects:v1:revoke", async (event, input: unknown) => {
    assertTrustedSender(event);
    const projectId = developmentProjectIdInputSchema.parse(input);
    const catalog = await loadProjectCatalog(projectCatalogPath());
    const project = catalog.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("El proyecto no existe.");
    await terminalSupervisor?.stopProject(projectId);
    const workspaceIds = project.compatibilityRefs.filter((reference) => reference.kind === "workspace").map((reference) => reference.id);
    const applicationIds = project.compatibilityRefs.filter((reference) => reference.kind === "application").map((reference) => reference.id);
    for (const run of applicationSupervisor?.listAll().filter((entry) => applicationIds.includes(entry.applicationId) && ["starting", "ready", "stopping"].includes(entry.state)) ?? []) {
      await applicationSupervisor?.stop(run.runId);
    }
    for (const workspaceId of workspaceIds) {
      for (const processEntry of processSupervisor?.listAll().filter((entry) => entry.workspaceId === workspaceId && entry.state === "running") ?? []) {
        await processSupervisor?.stop(workspaceId, processEntry.processId);
      }
      for (const browserEntry of browserController?.listAll().filter((entry) => entry.workspaceId === workspaceId && entry.state === "running") ?? []) {
        await browserController?.stop(workspaceId, browserEntry.sessionId);
      }
    }
    const decision = await revokeProjectTrust(projectTrustPath(), projectId);
    recordProjectAudit("project.trust.revoke", projectId, workspaceIds[0]);
    sendToRenderer("projects:changed");
    sendToRenderer("development:changed");
    return decision;
  });

  ipcMain.handle("projects:v1:rescan", async (event, input: unknown) => {
    assertTrustedSender(event);
    const projectId = developmentProjectIdInputSchema.parse(input);
    const registry = await loadRegistryDocument(registryPath);
    const legacy = (await listDevelopmentProjects(projectStorePath(), registry)).find((candidate) => candidate.id === projectId);
    const current = (await loadProjectCatalog(projectCatalogPath())).projects.find((candidate) => candidate.id === projectId);
    if (legacy === undefined || current === undefined) throw new Error("El proyecto no existe.");
    const workspaceRefs = current.compatibilityRefs.filter((reference) => reference.kind === "workspace");
    if (workspaceRefs.length !== 1) throw new Error("Este proyecto heredado usa varias raíces. Crea una ficha v1 seleccionando su carpeta padre para analizarlo como una unidad.");
    const workspaceRef = workspaceRefs[0];
    const workspace = registry.workspaces.find((candidate) => candidate.id === workspaceRef?.id);
    if (workspace === undefined) throw new Error("La carpeta vinculada ya no está disponible.");
    const updated = await persistCatalogRecord(await catalogRecordForWorkspace(legacy, workspace, current), current);
    sendToRenderer("projects:changed");
    return updated;
  });

  ipcMain.handle("projects:list", async (event) => {
    assertTrustedSender(event);
    const registry = await loadRegistryDocument(registryPath);
    return {
      projects: await listDevelopmentProjects(projectStorePath(), registry),
      sessions: await listProjectSetupSessions(projectSetupStorePath()),
      runs: setupSupervisor?.listAll() ?? [],
    };
  });

  ipcMain.handle("projects:create", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = newAssistedProjectInputSchema.parse(input);
    if (!parsed.permissions.read || !parsed.permissions.write || !parsed.permissions.overwrite || !parsed.permissions.processes) {
      throw new Error("Un proyecto nuevo necesita lectura, creación, edición y procesos para preparar y probar su stack.");
    }
    if (parsed.initializeGit && !parsed.permissions.gitWrite) {
      throw new Error("Inicializar Git requiere el permiso Git de escritura explícito.");
    }
    const [previous, projectSettings] = await Promise.all([
      loadRegistryDocument(registryPath),
      readDesktopSettings(settingsPath),
    ]);
    const normalizedRoot = parsed.rootPath.toLocaleLowerCase("en-US");
    if (previous.workspaces.some((workspace) => workspace.rootPath.toLocaleLowerCase("en-US") === normalizedRoot)) {
      throw new Error("La carpeta ya está autorizada. Usa “Agrupar configuración existente” para no duplicarla.");
    }
    const workspace = buildNewWorkspace({
      name: parsed.name,
      rootPath: parsed.rootPath,
      largeArtifacts: projectSettings.largeArtifactPreference,
      permissions: parsed.permissions,
      validationProfiles: {},
      processProfiles: {},
      browserProfiles: {},
    });
    await upsertWorkspace(registryPath, workspace);
    const registry = await loadRegistryDocument(registryPath);
    const project = buildNewDevelopmentProject({
      name: parsed.name,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      workspaceIds: [workspace.id],
      setupStatus: "draft",
    });
    try {
      await upsertDevelopmentProject(projectStorePath(), registry, project);
      await createProjectSetupSession(projectSetupStorePath(), project.id, workspace.id, parsed.policy, parsed.initializeGit);
      const session = await analyzeAssistedProject(project.id, parsed.initializeGit);
      recordProjectAudit("project.create", project.id, workspace.id);
      return { project: await currentProject(project.id), session };
    } catch (error) {
      recordProjectAudit("project.create", project.id, workspace.id, "error", setupSessionErrorCode(error));
      await removeDevelopmentProject(projectStorePath(), project.id).catch(() => undefined);
      await replaceRegistry(registryPath, previous).catch(() => undefined);
      throw error;
    }
  });

  ipcMain.handle("projects:adopt", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = adoptDevelopmentProjectInputSchema.parse(input);
    const registry = await loadRegistryDocument(registryPath);
    const project = buildNewDevelopmentProject({
      name: parsed.name,
      workspaceIds: parsed.workspaceIds,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.applicationId === undefined ? {} : { applicationId: parsed.applicationId }),
      setupStatus: parsed.applicationId === undefined
        ? "ready"
        : registry.applications.find((application) => application.id === parsed.applicationId)?.reviewState === "reviewed"
          ? "ready"
          : "review-required",
    });
    const adopted = await upsertDevelopmentProject(projectStorePath(), registry, project);
    recordProjectAudit("project.adopt", project.id, project.workspaceIds[0]);
    return adopted;
  });

  ipcMain.handle("projects:refresh", async (event, input: unknown) => {
    assertTrustedSender(event);
    const projectId = developmentProjectIdInputSchema.parse(input);
    const project = await currentProject(projectId);
    return analyzeAssistedProject(projectId).finally(() => recordProjectAudit("project.refresh", projectId, project.workspaceIds[0]));
  });

  ipcMain.handle("projects:policy", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = setupPolicyInputSchema.parse(input);
    const sessions = await listProjectSetupSessions(projectSetupStorePath());
    const session = sessions.filter((candidate) => candidate.projectId === parsed.projectId).at(-1);
    if (session === undefined) throw new Error("La preparación del proyecto no existe.");
    if (["installing", "finalizing"].includes(session.phase)) throw new Error("No puedes cambiar el modo mientras la preparación está en curso.");
    const { plan: _plan, errorCode: _errorCode, ...base } = session;
    await updateProjectSetupSession(projectSetupStorePath(), {
      ...base,
      policy: parsed.policy,
      phase: "draft",
      updatedAt: new Date().toISOString(),
    });
    return analyzeAssistedProject(parsed.projectId);
  });

  ipcMain.handle("projects:remove", async (event, input: unknown) => {
    assertTrustedSender(event);
    const projectId = developmentProjectIdInputSchema.parse(input);
    const registry = await loadRegistryDocument(registryPath);
    const [developmentProjects, catalog, setupSessions] = await Promise.all([
      listDevelopmentProjects(projectStorePath(), registry),
      loadProjectCatalog(projectCatalogPath()),
      listProjectSetupSessions(projectSetupStorePath()),
    ]);
    let removal = planDevelopmentProjectRemoval({
      projectId,
      registry,
      developmentProjects,
      catalogProjects: catalog.projects,
      setupSessions,
    });
    const sharedDetail = removal.sharedWorkspaceIds.length + removal.sharedApplicationIds.length > 0
      ? ` ${removal.sharedWorkspaceIds.length} carpeta(s) y ${removal.sharedApplicationIds.length} aplicación(es) compartidas con otros desarrollos se conservarán.`
      : "";
    const confirmation = await dialog.showMessageBox({
      type: "warning",
      title: "Eliminar desarrollo de LocalBridge",
      message: `Eliminar ${removal.displayName} y sus accesos`,
      detail: `Se detendrán sus procesos y se eliminarán de LocalBridge la ficha, el historial de preparación, los permisos y ${removal.removableWorkspaceIds.length} carpeta(s) autorizada(s) y ${removal.removableApplicationIds.length} aplicación(es) exclusivas.${sharedDetail} Los archivos y repositorios reales permanecerán en el disco.`,
      buttons: ["Cancelar", "Eliminar de LocalBridge"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) {
      return {
        removed: false,
        workspacesRemoved: 0,
        applicationsRemoved: 0,
        sharedWorkspacesKept: removal.sharedWorkspaceIds.length,
        sharedApplicationsKept: removal.sharedApplicationIds.length,
        filesDeleted: false,
      };
    }

    const refreshedRegistry = await loadRegistryDocument(registryPath);
    const [refreshedDevelopmentProjects, refreshedCatalog, refreshedSetupSessions] = await Promise.all([
      listDevelopmentProjects(projectStorePath(), refreshedRegistry),
      loadProjectCatalog(projectCatalogPath()),
      listProjectSetupSessions(projectSetupStorePath()),
    ]);
    const refreshedRemoval = planDevelopmentProjectRemoval({
      projectId,
      registry: refreshedRegistry,
      developmentProjects: refreshedDevelopmentProjects,
      catalogProjects: refreshedCatalog.projects,
      setupSessions: refreshedSetupSessions,
    });
    const scopeChanged = JSON.stringify({
      workspaces: refreshedRemoval.removableWorkspaceIds,
      applications: refreshedRemoval.removableApplicationIds,
      sharedWorkspaces: refreshedRemoval.sharedWorkspaceIds,
      sharedApplications: refreshedRemoval.sharedApplicationIds,
    }) !== JSON.stringify({
      workspaces: removal.removableWorkspaceIds,
      applications: removal.removableApplicationIds,
      sharedWorkspaces: removal.sharedWorkspaceIds,
      sharedApplications: removal.sharedApplicationIds,
    });
    if (scopeChanged) throw new Error("El desarrollo cambió mientras confirmabas. Revisa el alcance y vuelve a intentarlo.");
    removal = refreshedRemoval;

    await setupSupervisor?.cancel(projectId);
    await terminalSupervisor?.stopProject(projectId);
    const currentApplicationSupervisor = applicationSupervisor;
    await Promise.all((currentApplicationSupervisor?.listAll().filter((entry) =>
      removal.removableApplicationIds.includes(entry.applicationId) && ["starting", "ready", "stopping"].includes(entry.state)) ?? [])
      .map((run) => currentApplicationSupervisor!.stop(run.runId)));
    const currentAnalysisSupervisor = analysisSupervisor;
    const currentTaskBatchSupervisor = taskBatchSupervisor;
    const currentProcessSupervisor = processSupervisor;
    const currentBrowserController = browserController;
    await Promise.all(removal.removableWorkspaceIds.map(async (workspaceId) => {
      await currentTaskBatchSupervisor?.cancelWorkspace(workspaceId);
      await currentAnalysisSupervisor?.cancelWorkspace(workspaceId);
      await Promise.all([
        ...(currentProcessSupervisor?.listAll().filter((entry) =>
          entry.workspaceId === workspaceId && entry.state === "running") ?? [])
          .map((entry) => currentProcessSupervisor!.stop(workspaceId, entry.processId)),
        ...(currentBrowserController?.listAll().filter((entry) =>
          entry.workspaceId === workspaceId && entry.state === "running") ?? [])
          .map((entry) => currentBrowserController!.stop(workspaceId, entry.sessionId)),
      ]);
    }));

    await removeProjectTrustRecord(projectTrustPath(), projectId);
    const removedRegistryEntries = await removeRegistryEntriesIfPresent(registryPath, {
      workspaceIds: removal.removableWorkspaceIds,
      applicationIds: removal.removableApplicationIds,
    });
    await applicationSupervisor?.reconcile();
    await removeProjectSetupSessions(projectSetupStorePath(), projectId);
    await removeDevelopmentProjectIfPresent(projectStorePath(), projectId);
    if (catalog.projects.some((project) => project.id === projectId)) {
      await removeProjectCatalogRecord(projectCatalogPath(), projectId);
    }
    await removeProjectScanRecord(projectScanPath(), projectId).catch(() => undefined);
    recordProjectAudit("project.remove", projectId, removal.workspaceIds[0]);
    sendToRenderer("projects:changed");
    sendToRenderer("development:changed");
    return {
      removed: true,
      workspacesRemoved: removedRegistryEntries.workspaceIds.length,
      applicationsRemoved: removedRegistryEntries.applicationIds.length,
      sharedWorkspacesKept: removal.sharedWorkspaceIds.length,
      sharedApplicationsKept: removal.sharedApplicationIds.length,
      filesDeleted: false,
    };
  });

  ipcMain.handle("projects:cancel", async (event, input: unknown) => {
    assertTrustedSender(event);
    const projectId = developmentProjectIdInputSchema.parse(input);
    await setupSupervisor?.cancel(projectId);
    const sessions = await listProjectSetupSessions(projectSetupStorePath());
    const session = sessions.filter((candidate) => candidate.projectId === projectId).at(-1);
    if (session !== undefined && !["ready", "failed", "interrupted", "cancelled"].includes(session.phase)) {
      const updated = await updateProjectSetupSession(projectSetupStorePath(), {
        ...session,
        phase: "interrupted",
        errorCode: "SETUP_CANCELLED",
        updatedAt: new Date().toISOString(),
      });
      const registry = await loadRegistryDocument(registryPath);
      const project = (await listDevelopmentProjects(projectStorePath(), registry)).find((candidate) => candidate.id === projectId);
      if (project !== undefined) await upsertDevelopmentProject(projectStorePath(), registry, { ...project, setupStatus: "interrupted", updatedAt: new Date().toISOString() });
      recordProjectAudit("project.setup.cancel", projectId, project?.workspaceIds[0]);
      return updated;
    }
    return session;
  });

  ipcMain.handle("projects:approve", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = setupReviewInputSchema.parse(input);
    if (setupSupervisor === undefined) throw new Error("El supervisor de preparación no está disponible.");
    const project = await currentProject(parsed.projectId);
    const sessions = await listProjectSetupSessions(projectSetupStorePath());
    let session = sessions.filter((candidate) => candidate.projectId === project.id).at(-1);
    if (session?.plan === undefined || session.plan.planSha256 !== parsed.planSha256 || session.phase !== "awaiting-local-review") {
      throw new Error("La propuesta cambió o ya no está esperando revisión. Actualiza el análisis.");
    }
    const plan = session.plan;
    const toolchains = await toolchainsForPlan(plan);
    const registryBefore = await loadRegistryDocument(registryPath);
    const preflight = await validateSetupPlan(plan, registryBefore, toolchains);
    if (!preflight.valid) throw new Error("La propuesta quedó desactualizada. Actualiza el análisis antes de aprobar.");
    if (plan.policy === "compatible") {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Permitir scripts de instalación",
        message: "Este proyecto solicita modo compatible",
        detail: "El gestor podrá ejecutar scripts de lifecycle declarados por las dependencias. La aprobación vale solo para esta propuesta y esta ejecución.",
        buttons: ["Cancelar", "Permitir esta vez"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) throw new Error("Preparación cancelada antes de ejecutar scripts.");
    }
    recordProjectAudit("project.setup.execute", project.id, project.workspaceIds[0]);
    session = await updateProjectSetupSession(projectSetupStorePath(), { ...session, phase: "installing", updatedAt: new Date().toISOString() });
    let run: SetupRunSummary;
    try {
      run = await setupSupervisor.start(plan, toolchains);
    } catch (error) {
      const errorCode = setupSessionErrorCode(error);
      session = await updateProjectSetupSession(projectSetupStorePath(), {
        ...session,
        phase: "failed",
        errorCode,
        updatedAt: new Date().toISOString(),
      });
      const currentRegistry = await loadRegistryDocument(registryPath);
      await upsertDevelopmentProject(projectStorePath(), currentRegistry, { ...project, setupStatus: "interrupted", updatedAt: new Date().toISOString() });
      sendToRenderer("projects:changed");
      throw new Error("No se pudo iniciar la preparación. Revisa el diagnóstico local y vuelve a analizar.", { cause: error });
    }
    while (run.state === "running") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      run = setupSupervisor.status(run.runId) ?? run;
    }
    if (run.state !== "succeeded") {
      const phase = run.state === "cancelled" || run.state === "timed_out" ? "interrupted" as const : "failed" as const;
      await updateProjectSetupSession(projectSetupStorePath(), {
        ...session,
        phase,
        errorCode: setupSessionErrorCode(run.errorCode),
        updatedAt: new Date().toISOString(),
      });
      const currentRegistry = await loadRegistryDocument(registryPath);
      await upsertDevelopmentProject(projectStorePath(), currentRegistry, { ...project, setupStatus: "interrupted", updatedAt: new Date().toISOString() });
      throw new Error(run.state === "cancelled" ? "Preparación cancelada." : "La instalación no terminó correctamente. Revisa el detalle local y vuelve a analizar.");
    }
    session = await updateProjectSetupSession(projectSetupStorePath(), { ...session, phase: "finalizing", updatedAt: new Date().toISOString() });
    try {
      const registryForFinalization = await loadRegistryDocument(registryPath);
      const finalCheck = await validateSetupPlan(plan, registryForFinalization, toolchains);
      if (!finalCheck.valid) throw new Error("SETUP_PLAN_STALE");
      const finalized = await finalizeSetupPlan({
        registryPath,
        projectStorePath: projectStorePath(),
        registry: registryForFinalization,
        project,
        plan,
      });
      let finalProject = finalized.project;
      if (finalized.applicationId !== undefined) {
        await verifyApplicationLocally(finalized.applicationId);
        const verifiedRegistry = await loadRegistryDocument(registryPath);
        finalProject = { ...finalProject, setupStatus: "ready", updatedAt: new Date().toISOString() };
        await upsertDevelopmentProject(projectStorePath(), verifiedRegistry, finalProject);
      }
      session = await updateProjectSetupSession(projectSetupStorePath(), { ...session, phase: "ready", updatedAt: new Date().toISOString() });
      sendToRenderer("projects:changed");
      recordProjectAudit("project.setup.finalize", project.id, project.workspaceIds[0]);
      return { project: finalProject, session, run };
    } catch (error) {
      const errorCode = setupSessionErrorCode(error);
      session = await updateProjectSetupSession(projectSetupStorePath(), {
        ...session,
        phase: errorCode === "SETUP_PLAN_STALE" ? "interrupted" : "failed",
        errorCode,
        updatedAt: new Date().toISOString(),
      });
      const currentRegistry = await loadRegistryDocument(registryPath);
      const persisted = (await listDevelopmentProjects(projectStorePath(), currentRegistry)).find((candidate) => candidate.id === project.id);
      if (persisted !== undefined) {
        await upsertDevelopmentProject(projectStorePath(), currentRegistry, {
          ...persisted,
          setupStatus: errorCode === "SETUP_PLAN_STALE" ? "interrupted" : "review-required",
          updatedAt: new Date().toISOString(),
        });
      }
      sendToRenderer("projects:changed");
      recordProjectAudit("project.setup.finalize", project.id, project.workspaceIds[0], "error", errorCode);
      throw new Error(errorCode === "SETUP_PLAN_STALE"
        ? "La propuesta cambió durante la preparación. Analiza de nuevo antes de continuar."
        : "La preparación quedó guardada para revisión local, pero no pudo finalizarse automáticamente.", { cause: error });
    }
  });

  ipcMain.handle("workspaces:list", (event) => {
    assertTrustedSender(event);
    return listWorkspaces(registryPath);
  });

  ipcMain.handle("workspaces:pickFolder", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("workspaces:detectCommands", (event, rootPath: unknown) => {
    assertTrustedSender(event);
    return detectProjectCommands(absolutePathSchema.parse(rootPath));
  });

  ipcMain.handle(
    "workspaces:create",
    async (event, input: unknown) => {
      assertTrustedSender(event);
      const parsed = newWorkspaceInputSchema.parse(input);
      const projectSettings = await readDesktopSettings(settingsPath);
      const workspace = buildNewWorkspace({
        name: parsed.name,
        rootPath: parsed.rootPath,
        permissions: parsed.permissions,
        largeArtifacts: parsed.largeArtifacts ?? projectSettings.largeArtifactPreference,
        ...(parsed.maxFileBytes === undefined ? {} : { maxFileBytes: parsed.maxFileBytes }),
        ...(parsed.validationProfiles === undefined ? {} : { validationProfiles: parsed.validationProfiles }),
        ...(parsed.processProfiles === undefined ? {} : { processProfiles: parsed.processProfiles }),
        ...(parsed.browserProfiles === undefined ? {} : { browserProfiles: parsed.browserProfiles }),
        ...(parsed.automationReviewRequired === undefined
          ? {}
          : { automationReviewRequired: parsed.automationReviewRequired }),
      });
      await upsertWorkspace(registryPath, workspace);
      return workspace;
    },
  );

  ipcMain.handle("workspaces:update", async (event, input: unknown) => {
    assertTrustedSender(event);
    const workspace = authorizedWorkspaceInputSchema.parse(input);
    await upsertWorkspace(registryPath, workspace);
    await applicationSupervisor?.reconcile();
    return workspace;
  });

  ipcMain.handle("workspaces:remove", (event, id: unknown) => {
    assertTrustedSender(event);
    return removeWorkspace(registryPath, workspaceIdInputSchema.parse(id)).then(() => applicationSupervisor?.reconcile());
  });
  ipcMain.handle("workspaces:test", async (event, idInput: unknown) => {
    assertTrustedSender(event);
    const id = workspaceIdInputSchema.parse(idInput);
    const workspace = (await listWorkspaces(registryPath)).find((candidate) => candidate.id === id);
    if (workspace === undefined) throw new Error("Workspace no encontrado.");
    return testWorkspaceReadiness(workspace);
  });
  ipcMain.handle("development:list", async (event) => {
    assertTrustedSender(event);
    const activeLiveViewerSessionId = browserController?.getLocalLiveViewerSessionId();
    const displaySummaries = liveViewerDisplaySummaries();
    const catalog = await loadProjectCatalog(projectCatalogPath());
    const activeTerminals = (terminalSupervisor?.listAll() ?? []).filter((entry) => entry.state === "running");
    const terminals = await Promise.all(activeTerminals.map(async (entry) => {
      const project = catalog.projects.find((candidate) => candidate.id === entry.projectId);
      const listeners = await terminalSupervisor?.status(entry.projectId, entry.sessionId)
        .then(async (status) => Promise.all(status.listeners.map(async (listener) => {
          try {
            const resolved = await terminalSupervisor!.resolveListener(entry.projectId, entry.sessionId, listener.listenerRef);
            return {
              listenerRef: resolved.listenerRef,
              browserOrigin: resolved.browserOrigin,
              addressFamily: resolved.addressFamily,
              bindScope: resolved.bindScope,
              exclusive: resolved.exclusive,
              port: resolved.port,
              observedAt: resolved.observedAt,
            };
          } catch {
            return undefined;
          }
        })))
        .then((items) => items?.filter((item): item is NonNullable<typeof item> => item !== undefined) ?? [])
        .catch(() => []);
      return {
        ...entry,
        projectName: project?.displayName ?? "Proyecto no disponible",
        listeners: listeners ?? [],
      };
    }));
    const projectAvailability = (await listProjectsForBroker()).projects.map((project) => ({
      projectId: project.projectId,
      projectName: project.name,
      terminalAvailable: project.execution.terminalAvailable,
      reviewed: {
        processes: project.automation.reviewedProfiles.processes.filter((profile) => profile.available).length,
        validations: project.automation.reviewedProfiles.validations.filter((profile) => profile.available).length,
        browser: project.automation.reviewedProfiles.browser.filter((profile) => profile.available).length,
      },
      detectedProposal: {
        state: project.automation.detectedProposal.state,
        processes: project.automation.detectedProposal.processCount,
        validations: project.automation.detectedProposal.validationCount,
      },
    }));
    return {
      processes: (processSupervisor?.listAll() ?? []).filter((entry) => entry.state === "running"),
      browsers: (browserController?.listAll() ?? []).filter((entry) => entry.state === "running"),
      applications: (applicationSupervisor?.listAll() ?? []).filter((entry) => entry.state === "starting" || entry.state === "ready" || entry.state === "stopping"),
      terminals,
      jobs: analysisSupervisor?.listAll(50) ?? [],
      taskBatches: taskBatchSupervisor?.listAll(50) ?? [],
      availability: projectAvailability,
      analysisAvailability: analysisSupervisor === undefined
        ? { available: false as const, reason: analysisUnavailableReason ?? 'journal-unavailable' as const }
        : { available: true as const },
      taskBatchAvailability: taskBatchSupervisor === undefined
        ? { available: false as const, reason: taskBatchUnavailableReason ?? 'journal-unavailable' as const }
        : { available: true as const },
      displays: displaySummaries,
      recommendedDisplayId: String(recommendedDisplay().id),
      ...(activeLiveViewerSessionId === undefined ? {} : {
        liveViewerSessionId: activeLiveViewerSessionId,
        liveViewerDisplayId: displaySummaries.some((display) => display.id === liveViewerDisplayId)
          ? liveViewerDisplayId
          : String(screen.getDisplayMatching(browserController?.getLocalLiveViewerWindowBounds() ?? recommendedDisplay().workArea).id),
      }),
    };
  });
  ipcMain.handle("development:openTerminalListener", async (event, input: unknown) => {
    assertTrustedSender(event);
    const target = terminalListenerTargetInputSchema.parse(input);
    const listener = await terminalSupervisor!.resolveListener(target.projectId, target.terminalSessionId, target.listenerRef);
    if (!listener.exclusive) throw new Error("El puerto no es exclusivo del proceso; no se abrió el navegador.");
    const origin = new URL(listener.browserOrigin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") throw new Error("El servicio no usa un origen web permitido.");
    await shell.openExternal(origin.href);
    recordProjectAudit("terminal.local.open", target.projectId, undefined);
  });
  ipcMain.handle("development:cancelAnalysis", (event, input: unknown) => {
    assertTrustedSender(event);
    const target = analysisJobTargetInputSchema.parse(input);
    return analysisSupervisor?.cancel(target.workspaceId, target.jobId);
  });
  ipcMain.handle("development:cancelTaskBatch", (event, input: unknown) => {
    assertTrustedSender(event);
    const target = taskBatchTargetInputSchema.parse(input);
    return taskBatchSupervisor?.cancelMany(
      target.workspaceId,
      target.batchId,
      target.localId === undefined ? undefined : [target.localId],
      `ui_cancel_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    );
  });
  ipcMain.handle("development:copyTerminalListener", async (event, input: unknown) => {
    assertTrustedSender(event);
    const target = terminalListenerTargetInputSchema.parse(input);
    const listener = await terminalSupervisor!.resolveListener(target.projectId, target.terminalSessionId, target.listenerRef);
    if (!listener.exclusive) throw new Error("El puerto no es exclusivo del proceso; no se copió la dirección.");
    clipboard.writeText(listener.browserOrigin);
    recordProjectAudit("terminal.local.copy", target.projectId, undefined);
  });
  ipcMain.handle("development:stopTerminal", async (event, input: unknown) => {
    assertTrustedSender(event);
    const target = terminalSessionTargetInputSchema.parse(input);
    await terminalSupervisor!.stop(target.projectId, target.terminalSessionId);
    recordProjectAudit("terminal.local.stop", target.projectId, undefined);
    sendToRenderer("development:changed");
  });
  ipcMain.handle("development:stopAll", async (event) => {
    assertTrustedSender(event);
    await setupSupervisor?.stopAll();
    await browserController?.stopAll();
    await applicationSupervisor?.stopAll();
    await processSupervisor?.stopAll();
    await terminalSupervisor?.close();
  });

  ipcMain.handle("webProfiles:get", async (event) => {
    assertTrustedSender(event);
    return readWebProfileStore(webProfileStorePath);
  });
  ipcMain.handle("webProfiles:enableInternet", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webProfileEnableInternetInputSchema.parse(input);
    const snapshot = await readWebProfileStore(webProfileStorePath);
    if (snapshot.state === "corrupt") throw new Error("El registro web está corrupto. Restablécelo antes de activar Internet.");
    return replaceWebProfileStore(webProfileStorePath,
      enablePublicInternetAccess(snapshot.document, parsed.download), parsed.expectedSha256);
  });
  ipcMain.handle("webProfiles:create", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webProfileCreateInputSchema.parse(input);
    const snapshot = await readWebProfileStore(webProfileStorePath);
    if (snapshot.state === "corrupt") throw new Error("El registro web está corrupto. Restablécelo localmente antes de crear perfiles.");
    if (snapshot.document.profiles.length >= 20) throw new Error("Se alcanzó el límite de 20 perfiles web.");
    const profile = parsed.kind === "public-research"
      ? buildPublicResearchProfile(new Date(), parsed.name)
      : buildSiteAccountProfile(parsed);
    return replaceWebProfileStore(webProfileStorePath, {
      ...snapshot.document,
      profiles: [...snapshot.document.profiles, profile],
    }, snapshot.sha256);
  });
  ipcMain.handle("webProfiles:update", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webProfileUpdateInputSchema.parse(input);
    const snapshot = await readWebProfileStore(webProfileStorePath);
    if (snapshot.state !== "ready") throw new Error("Vuelve a cargar el registro web antes de editarlo.");
    const previous = snapshot.document.profiles.find((profile) => profile.id === parsed.profile.id);
    if (previous === undefined) throw new Error("El perfil web ya no existe.");
    await webController?.stopProfile(previous.id);
    return replaceWebProfileStore(webProfileStorePath, {
      ...snapshot.document,
      profiles: snapshot.document.profiles.map((profile) => profile.id === parsed.profile.id
        ? { ...parsed.profile, createdAt: previous.createdAt, updatedAt: new Date().toISOString() }
        : profile),
    }, parsed.expectedSha256);
  });
  ipcMain.handle("webProfiles:remove", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webProfileRemoveInputSchema.parse(input);
    const snapshot = await readWebProfileStore(webProfileStorePath);
    if (snapshot.state !== "ready" || !snapshot.document.profiles.some((profile) => profile.id === parsed.webProfileId)) {
      throw new Error("El perfil web ya no existe.");
    }
    await webController?.stopProfile(parsed.webProfileId);
    return replaceWebProfileStore(webProfileStorePath, {
      ...snapshot.document,
      profiles: snapshot.document.profiles.filter((profile) => profile.id !== parsed.webProfileId),
    }, parsed.expectedSha256);
  });
  ipcMain.handle("webProfiles:reset", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webProfileResetInputSchema.parse(input);
    const snapshot = await readWebProfileStore(webProfileStorePath);
    if (snapshot.state !== "corrupt" || snapshot.sha256 !== parsed.expectedSha256) {
      throw new Error("El registro web cambió; vuelve a cargarlo antes de restablecer.");
    }
    await webController?.stopAll();
    return replaceWebProfileStore(webProfileStorePath, { schemaVersion: 1, profiles: [] }, parsed.expectedSha256);
  });
  ipcMain.handle("webActivity:list", async (event) => {
    assertTrustedSender(event);
    return webController?.listAll() ?? [];
  });
  ipcMain.handle("webActivity:viewerState", async (event, input: unknown) => {
    assertTrustedSender(event);
    webViewerStateInputSchema.parse(input);
    const state = webController?.getLocalLiveViewerState() ?? { visible: false as const };
    const displays = liveViewerDisplaySummaries();
    return {
      ...state,
      displays,
      recommendedDisplayId: String(recommendedDisplay().id),
      ...(state.visible ? {
        displayId: displays.some((display) => display.id === liveViewerDisplayId)
          ? liveViewerDisplayId
          : String(screen.getDisplayMatching(webController?.getLocalLiveViewerWindowBounds() ?? recommendedDisplay().workArea).id),
      } : {}),
    };
  });
  ipcMain.handle("webActivity:tabs", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webTabsInputSchema.parse(input);
    return webController?.listTabsLocally(parsed.sessionId) ?? [];
  });
  ipcMain.handle("webActivity:setViewport", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (webController === undefined) throw new Error("El navegador web no está disponible.");
    const parsed = webViewportInputSchema.parse(input);
    await webController.setViewport(parsed.sessionId, parsed.tabId, parsed.width, parsed.height, parsed.mobile);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:showLiveViewer", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (webController === undefined || liveViewerCoordinator === undefined) throw new Error("El visor web no está disponible.");
    const parsed = webLiveViewerShowInputSchema.parse(input);
    const display = resolveLiveViewerDisplay(parsed.displayId);
    const shown = await liveViewerCoordinator.show(
      { kind: "web", sessionId: parsed.sessionId },
      () => webController!.showLiveViewerLocally(
        parsed.sessionId,
        parsed.mode,
        display.workArea,
        parsed.mode === "pinned" ? parsed.tabId : undefined,
        parsed.presentationMode,
      ),
    );
    if (!shown) return;
    liveViewerDisplayId = String(display.id);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:hideLiveViewer", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webLiveViewerHideInputSchema.parse(input);
    if (liveViewerCoordinator !== undefined) await liveViewerCoordinator.hide({ kind: "web", sessionId: parsed.sessionId });
    else await webController?.hideLiveViewerLocally(parsed.sessionId);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:moveLiveViewer", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (webController === undefined) throw new Error("El visor web no está disponible.");
    const parsed = webLiveViewerMoveInputSchema.parse(input);
    const display = resolveLiveViewerDisplay(parsed.displayId);
    if (String(display.id) !== parsed.displayId) throw new Error("La pantalla seleccionada ya no está disponible.");
    await webController.moveLiveViewerLocally(parsed.sessionId, display.workArea);
    liveViewerDisplayId = String(display.id);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:setLiveViewerPresentation", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (webController === undefined) throw new Error("El visor web no está disponible.");
    const parsed = webLiveViewerPresentationInputSchema.parse(input);
    await webController.setLiveViewerPresentationLocally(parsed.sessionId, parsed.mode, parsed.panX, parsed.panY);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:cancelMotion", (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webMotionCancelInputSchema.parse(input);
    webController?.cancelMotionLocally(parsed.sessionId, parsed.tabId);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:takeHumanControl", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webHumanTakeInputSchema.parse(input);
    await webController?.takeHumanControlLocally(parsed.sessionId, parsed.tabId);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:cycleHumanTab", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = webHumanCycleInputSchema.parse(input);
    await webController?.cycleHumanTabLocally(parsed.sessionId, parsed.direction);
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:returnHumanControl", async (event, input: unknown) => {
    assertTrustedSender(event);
    await webController?.completeHumanControlLocally(webHumanSessionInputSchema.parse(input));
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:declineHumanControl", async (event, input: unknown) => {
    assertTrustedSender(event);
    await webController?.declineHumanControlLocally(webHumanSessionInputSchema.parse(input));
    sendToRenderer("web:changed");
  });
  ipcMain.handle("webActivity:stop", async (event, input: unknown) => {
    assertTrustedSender(event);
    await webController?.stopLocally(webHumanSessionInputSchema.parse(input));
    sendToRenderer("web:changed");
  });

  ipcMain.handle("applications:list", (event) => {
    assertTrustedSender(event);
    return listApplications(registryPath);
  });
  ipcMain.handle("applications:create", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = newApplicationInputSchema.parse(input);
    const application = buildNewApplication({
      name: parsed.name,
      primaryServiceAlias: parsed.primaryServiceAlias,
      services: parsed.services,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.viewport === undefined ? {} : { viewport: parsed.viewport }),
      reviewState: "needs-review",
    });
    return upsertApplication(registryPath, application);
  });
  ipcMain.handle("applications:update", async (event, input: unknown) => {
    assertTrustedSender(event);
    const incoming = localApplicationInputSchema.parse(input);
    const previous = (await listApplications(registryPath)).find((application) => application.id === incoming.id);
    if (previous === undefined) throw new Error("Aplicación no encontrada.");
    await browserController?.stopApplication(incoming.id);
    const activeRun = applicationSupervisor?.listAll().find((run) => run.applicationId === incoming.id && (run.state === "starting" || run.state === "ready"));
    if (activeRun !== undefined) await applicationSupervisor?.stop(activeRun.runId);
    return upsertApplication(registryPath, {
      ...incoming,
      reviewState: incoming.reviewState === "conflict" ? "conflict" : "needs-review",
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString(),
    });
  });
  ipcMain.handle("applications:remove", async (event, input: unknown) => {
    assertTrustedSender(event);
    const id = applicationIdInputSchema.parse(input);
    await browserController?.stopApplication(id);
    const activeRun = applicationSupervisor?.listAll().find((run) => run.applicationId === id && (run.state === "starting" || run.state === "ready"));
    if (activeRun !== undefined) await applicationSupervisor?.stop(activeRun.runId);
    await removeApplication(registryPath, id);
  });
  ipcMain.handle("applications:start", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (applicationSupervisor === undefined) throw new Error("El runtime de aplicaciones no está disponible.");
    return applicationSupervisor.start(applicationIdInputSchema.parse(input));
  });
  ipcMain.handle("applications:status", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (applicationSupervisor === undefined || typeof input !== "string" || !/^run_[a-f0-9]{24}$/.test(input)) {
      throw new Error("Ejecución de aplicación inválida.");
    }
    return applicationSupervisor.status(input);
  });
  ipcMain.handle("applications:stop", async (event, applicationInput: unknown, runInput: unknown) => {
    assertTrustedSender(event);
    const applicationId = applicationIdInputSchema.parse(applicationInput);
    if (typeof runInput !== "string" || !/^run_[a-f0-9]{24}$/.test(runInput)) throw new Error("Ejecución de aplicación inválida.");
    await browserController?.stopApplication(applicationId);
    return applicationSupervisor?.stop(runInput);
  });
  ipcMain.handle("applications:verify", async (event, input: unknown) => {
    assertTrustedSender(event);
    return verifyApplicationLocally(applicationIdInputSchema.parse(input));
  });
  ipcMain.handle('development:takeHumanControl', async (event, input: unknown) => {
    assertTrustedSender(event);
    const sessionId = parseBrowserSessionId(input);
    const target = resolveLiveViewerDisplay(liveViewerDisplayId);
    await browserController?.takeHumanControlLocally(sessionId, target.workArea);
    liveViewerDisplayId = String(target.id);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:declineHumanControl', async (event, input: unknown) => {
    assertTrustedSender(event);
    await browserController?.declineHumanControlLocally(parseBrowserSessionId(input));
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:revokeHumanControl', async (event, input: unknown) => {
    assertTrustedSender(event);
    const sessionId = parseBrowserSessionId(input);
    const entry = browserController?.listAll().find((candidate) => candidate.sessionId === sessionId);
    if (entry !== undefined) await browserController?.stop(entry.workspaceId, sessionId);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:captureViewer', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (browserController === undefined) throw new Error('El navegador local no está disponible.');
    return browserController.captureForLocalViewer(parseBrowserSessionId(input));
  });
  ipcMain.handle('development:setViewport', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (browserController === undefined) throw new Error('El navegador local no está disponible.');
    const parsed = browserViewportInputSchema.parse(input);
    await browserController.setViewport(parsed.workspaceId, parsed.sessionId, parsed.width, parsed.height, parsed.mobile);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:showLiveViewer', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (browserController === undefined) throw new Error('El navegador local no está disponible.');
    const parsed = liveViewerTargetInputSchema.parse(input);
    const target = resolveLiveViewerDisplay(parsed.displayId);
    if (liveViewerCoordinator === undefined) throw new Error('El coordinador de vistas no está disponible.');
    const shown = await liveViewerCoordinator.show(
      { kind: 'development', sessionId: parsed.sessionId },
      () => browserController!.showLiveViewerLocally(parsed.sessionId, target.workArea, parsed.presentationMode),
    );
    if (!shown) return;
    liveViewerDisplayId = String(target.id);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:moveLiveViewer', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (browserController === undefined) throw new Error('El navegador local no está disponible.');
    const parsed = liveViewerMoveInputSchema.parse(input);
    const target = resolveLiveViewerDisplay(parsed.displayId);
    if (String(target.id) !== parsed.displayId) throw new Error('La pantalla seleccionada ya no está disponible.');
    await browserController.moveLiveViewerLocally(parsed.sessionId, target.workArea);
    liveViewerDisplayId = String(target.id);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:setLiveViewerPresentation', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (browserController === undefined) throw new Error('El navegador local no está disponible.');
    const parsed = liveViewerPresentationInputSchema.parse(input);
    await browserController.setLiveViewerPresentationLocally(parsed.sessionId, parsed.mode, parsed.panX, parsed.panY);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:cancelMotion', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = browserMotionCancelInputSchema.parse(input);
    browserController?.cancelMotionLocally(parsed.sessionId);
    sendToRenderer('development:changed');
  });
  ipcMain.handle('development:hideLiveViewer', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (browserController === undefined) return;
    const sessionId = parseBrowserSessionId(input);
    if (liveViewerCoordinator !== undefined) await liveViewerCoordinator.hide({ kind: 'development', sessionId });
    else await browserController.hideLiveViewerLocally(sessionId);
    sendToRenderer('development:changed');
  });

  ipcMain.handle("settings:get", (event) => {
    assertTrustedSender(event);
    return readDesktopSettings(settingsPath).then((current) => {
      minimizeToTray = current.minimizeToTray;
      return current;
    });
  });
  ipcMain.handle("runtime:getInfo", (event) => {
    assertTrustedSender(event);
    return desktopBundledRuntimePaths();
  });
  ipcMain.handle("runtime:check", async (event) => {
    assertTrustedSender(event);
    return checkRuntimeReadiness(desktopBundledRuntimePaths());
  });
  ipcMain.handle("external:open", async (event, destinationInput: unknown) => {
    assertTrustedSender(event);
    const destination = externalDestinationSchema.parse(destinationInput);
    await shell.openExternal(EXTERNAL_URLS[destination]);
  });
  ipcMain.handle("settings:save", async (event, input: unknown) => {
    assertTrustedSender(event);
    const current = await readDesktopSettings(settingsPath);
    const parsed = synchronizeActiveConnectionProfile(desktopSettingsSchema.parse(input));
    const sameProfileStructure =
      parsed.activeConnectionProfileId === current.activeConnectionProfileId &&
      parsed.connectionProfiles.length === current.connectionProfiles.length &&
      current.connectionProfiles.every((profile) => {
        const incoming = parsed.connectionProfiles.find((candidate) => candidate.id === profile.id);
        return (
          incoming?.name === profile.name &&
          (profile.id === current.activeConnectionProfileId || incoming.tunnelId === profile.tunnelId)
        );
      });
    if (!sameProfileStructure) {
      throw new Error("Los perfiles solo se crean, seleccionan o eliminan mediante sus acciones dedicadas.");
    }
    minimizeToTray = parsed.minimizeToTray;
    return writeDesktopSettings(settingsPath, parsed);
  });
  ipcMain.handle("profiles:create", async (event, nameInput: unknown) => {
    assertTrustedSender(event);
    return withTunnelSetupLock(async () => {
      const current = await readDesktopSettings(settingsPath);
      const profile: ConnectionProfile = {
        id: `profile_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        name: connectionProfileNameSchema.parse(nameInput),
        tunnelId: "",
      };
      const next = desktopSettingsSchema.parse({
        ...current,
        tunnelId: "",
        activeConnectionProfileId: profile.id,
        connectionProfiles: [...current.connectionProfiles, profile],
      });
      await writeDesktopSettings(settingsPath, next);
      return next;
    });
  });
  ipcMain.handle("profiles:select", async (event, idInput: unknown) => {
    assertTrustedSender(event);
    return withTunnelSetupLock(async () => {
      const id = connectionProfileIdSchema.parse(idInput);
      const current = await readDesktopSettings(settingsPath);
      const selected = current.connectionProfiles.find((profile) => profile.id === id);
      if (selected === undefined) throw new Error("Perfil de conexión no encontrado.");
      const next = desktopSettingsSchema.parse({ ...current, activeConnectionProfileId: id, tunnelId: selected.tunnelId });
      await writeDesktopSettings(settingsPath, next);
      return next;
    });
  });
  ipcMain.handle("profiles:remove", async (event, idInput: unknown) => {
    assertTrustedSender(event);
    return withTunnelSetupLock(async () => {
      const id = connectionProfileIdSchema.parse(idInput);
      const current = await readDesktopSettings(settingsPath);
      if (current.connectionProfiles.length === 1) throw new Error("Debe quedar al menos un perfil de conexión.");
      const remaining = current.connectionProfiles.filter((profile) => profile.id !== id);
      if (remaining.length === current.connectionProfiles.length) throw new Error("Perfil de conexión no encontrado.");
      await clearEncryptedKey(defaultTunnelKeyPath(id));
      const active = id === current.activeConnectionProfileId ? remaining[0] : activeConnectionProfile(current);
      const next = desktopSettingsSchema.parse({
        ...current,
        activeConnectionProfileId: active?.id,
        tunnelId: active?.tunnelId,
        connectionProfiles: remaining,
      });
      await writeDesktopSettings(settingsPath, next);
      return next;
    });
  });
  ipcMain.handle("diagnostics:copy", (event, textInput: unknown) => {
    assertTrustedSender(event);
    clipboard.writeText(diagnosticTextSchema.parse(textInput));
  });
  ipcMain.handle("diagnostics:export", async (event, textInput: unknown) => {
    assertTrustedSender(event);
    const text = diagnosticTextSchema.parse(textInput);
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const result = await dialog.showSaveDialog({
      title: "Exportar diagnóstico de LocalBridge",
      defaultPath: `localbridge-diagnostico-${timestamp}.txt`,
      filters: [{ name: "Texto", extensions: ["txt"] }],
      properties: ["showOverwriteConfirmation"],
    });
    if (result.canceled || result.filePath === "") return false;
    try {
      await exportDiagnosticFile(result.filePath, text);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        dialog.showErrorBox(
          "El archivo ya existe",
          "LocalBridge no sobrescribe diagnósticos existentes. Elige un nombre nuevo e inténtalo otra vez.",
        );
        return false;
      }
      throw error;
    }
    return true;
  });
  ipcMain.handle("portability:export", async (event, versionInput: unknown) => {
    assertTrustedSender(event);
    const version = versionInput === undefined || versionInput === "v5" ? "v5" : versionInput === "v4" ? "v4" : undefined;
    if (version === undefined) throw new Error("Versión de exportación no válida.");
    const registry = await loadRegistryDocument(registryPath);
    const config = buildPortableConfig(
      await readDesktopSettings(settingsPath),
      registry,
      ...(version === "v5" ? [await listDevelopmentProjects(projectStorePath(), registry)] as const : []),
    );
    const result = await dialog.showSaveDialog({
      title: "Exportar configuración portable",
      defaultPath: `localbridge-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || result.filePath === "") return false;
    await exportPortableConfigFile(result.filePath, config);
    return true;
  });
  ipcMain.handle("portability:selectImport", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || result.filePaths[0] === undefined) return undefined;
    const config = await readPortableConfigFile(result.filePaths[0]);
    const sessionId = randomUUID();
    portableImportSessions.clear();
    portableImportSessions.set(sessionId, { config, mappings: new Map() });
    return { sessionId, config };
  });
  ipcMain.handle("portability:mapWorkspace", async (event, sessionInput: unknown, refInput: unknown) => {
    assertTrustedSender(event);
    const sessionId = portableImportSessionIdSchema.parse(sessionInput);
    const ref = portableWorkspaceRefSchema.parse(refInput);
    const session = portableImportSessions.get(sessionId);
    if (session === undefined || !session.config.workspaces.some((workspace) => workspace.ref === ref)) {
      throw new Error("Sesión de importación inválida.");
    }
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths[0] === undefined) return false;
    session.mappings.set(ref, result.filePaths[0]);
    return true;
  });
  ipcMain.handle("portability:applyImport", async (event, sessionInput: unknown) => {
    assertTrustedSender(event);
    const sessionId = portableImportSessionIdSchema.parse(sessionInput);
    const session = portableImportSessions.get(sessionId);
    if (session === undefined) throw new Error("Sesión de importación inválida.");
    const currentSettings = await readDesktopSettings(settingsPath);
    const currentRegistry = await loadRegistryDocument(registryPath);
    const currentProjects = await listDevelopmentProjects(projectStorePath(), currentRegistry);
    const imported = applyPortableConfig(
      session.config,
      Object.fromEntries(session.mappings),
      currentSettings,
      currentRegistry,
      currentProjects,
    );
    await replaceRegistry(registryPath, imported.registry);
    try {
      await replaceDevelopmentProjects(projectStorePath(), [...currentProjects, ...imported.projects]);
      await writeDesktopSettings(settingsPath, imported.settings);
    } catch (error) {
      await replaceRegistry(registryPath, currentRegistry).catch(() => undefined);
      await replaceDevelopmentProjects(projectStorePath(), currentProjects).catch(() => undefined);
      await writeDesktopSettings(settingsPath, currentSettings).catch(() => undefined);
      throw error;
    }
    portableImportSessions.delete(sessionId);
    return imported;
  });
  ipcMain.handle("audit:list", (event, queryInput: unknown) => {
    assertTrustedSender(event);
    const parsed = auditQuerySchema.parse(queryInput);
    const query: AuditQuery = {
      ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
      ...(parsed.action === undefined ? {} : { action: parsed.action }),
      ...(parsed.outcome === undefined ? {} : { outcome: parsed.outcome }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    };
    return listAuditEvents(auditDbPath, query);
  });
  ipcMain.handle("approvals:list", (event) => {
    assertTrustedSender(event);
    return listPendingApprovals(auditDbPath);
  });
  ipcMain.handle("app:hide", (event) => {
    assertTrustedSender(event);
    mainWindow?.hide();
  });
  ipcMain.handle("app:quit", (event) => {
    assertTrustedSender(event);
    quitApplication();
  });

  ipcMain.handle("settings:pickTunnelBinary", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Ejecutable", extensions: ["exe"] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("settings:pickTunnelProfileDir", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("tunnel:connect", async (event, input: unknown) => {
    assertTrustedSender(event);
    const request = tunnelConnectInputSchema.parse(input);
    return withTunnelSetupLock(async () => {
      const { settings, connection, keyPath, loaded } = await activeStoredTunnelKey();
      const provision = bundledProvisionOptions(connection);
      const runtimePaths = desktopBundledRuntimePaths();
      return connectWithTunnelCredential({
        request,
        stored: loaded,
        validate: (apiKey) => { tunnelApiKeyInputSchema.parse(apiKey); },
        start: async (apiKey) => {
          await initializeTunnelProfile(provision);
          tunnel.connect({
            binaryPath: provision.binaryPath,
            profile: provision.profile,
            profileDir: provision.profileDir,
            cwd: dirname(provision.binaryPath),
            apiKey,
            gitApprovalMode: settings.gitApprovalMode,
            documentWorkerPath: join(dirname(runtimePaths.serverBundlePath), "document-worker.cjs"),
            ...(developmentBroker === undefined
              ? {}
              : {
                  developmentBrokerEndpoint: developmentBroker.endpoint,
                  developmentBrokerToken: developmentBroker.token,
                }),
          });
        },
        waitUntilConnected: () => tunnel.waitForConnection(),
        disconnect: () => tunnel.disconnect(),
        persist: (apiKey) => saveAndVerifyTunnelKey(keyPath, apiKey),
      });
    });
  });

  ipcMain.handle("tunnel:initializeProfile", async (event) => {
    assertTrustedSender(event);
    await withTunnelSetupLock(async () => {
      const { connection } = await activeConnectionContext();
      await initializeTunnelProfile(bundledProvisionOptions(connection));
    });
  });

  ipcMain.handle("tunnel:doctor", async (event, apiKeyInput: unknown) => {
    assertTrustedSender(event);
    const apiKey = tunnelApiKeyInputSchema.parse(apiKeyInput);
    return withTunnelSetupLock(async () => {
      const { settings, connection, keyPath } = await activeConnectionContext();
      const provision = bundledProvisionOptions(connection);
      await initializeTunnelProfile(provision);
      const report = await diagnoseTunnelProfile({ ...provision, apiKey, gitApprovalMode: settings.gitApprovalMode });
      if (!report.ok) return report;
      const remembered = await saveAndVerifyTunnelKey(keyPath, apiKey);
      return {
        ...report,
        keyPersistence: remembered ? "remembered" as const : "failed" as const,
        ...(remembered ? {} : { warningCode: "KEY_STORE_WRITE_FAILED" as const }),
      };
    });
  });

  ipcMain.handle("tunnel:disconnect", (event) => {
    assertTrustedSender(event);
    tunnel.disconnect();
  });
  ipcMain.handle("tunnel:status", (event) => {
    assertTrustedSender(event);
    return tunnel.getStatus();
  });
  ipcMain.handle("tunnel:effectiveGitApprovalMode", (event) => {
    assertTrustedSender(event);
    return tunnel.getEffectiveGitApprovalMode();
  });

  // Persistencia opcional y cifrada de la clave — nunca en texto plano, ver secure-key-store.ts.
  ipcMain.handle("tunnel:getKeyState", async (event) => {
    assertTrustedSender(event);
    const { loaded } = await activeStoredTunnelKey();
    return publicStoredTunnelKeyState(loaded);
  });
  ipcMain.handle("tunnel:forgetKey", async (event) => {
    assertTrustedSender(event);
    const { keyPath } = await activeConnectionContext();
    return clearEncryptedKey(keyPath);
  });
}

// Las sesiones web salen por proxy TCP. Impedir UDP WebRTC no mediado evita
// una segunda vía de red fuera de esa política (ADR-0047).
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("disable-quic");
app.enableSandbox();
app.setName("LocalBridge MCP");

if (!app.requestSingleInstanceLock()) {
  // No se inicializó ningún runtime en esta rama. Salir inmediatamente evita que una
  // segunda invocación quede viva esperando el ciclo de vida normal de Electron.
  app.exit(0);
} else {
  app.on("second-instance", showMainWindow);

  void app.whenReady().then(async () => {
    await recoverAbandonedArtifactStaging();
    await startDevelopmentRuntime();
    registerIpcHandlers();
    installApplicationMenu();
    createTray();
    createWindow();
    installDisplayMonitoring();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (explicitQuit || !minimizeToTray) quitApplication();
});

app.on("before-quit", () => {
  explicitQuit = true;
  for (const timer of projectRescanTimers.values()) clearTimeout(timer);
  projectRescanTimers.clear();
  tunnel.disconnect();
  void browserController?.close();
  void webController?.close();
  void applicationSupervisor?.close();
  void setupSupervisor?.stopAll();
  void processSupervisor?.close();
  void terminalSupervisor?.close();
  void analysisSupervisor?.close();
  void taskBatchSupervisor?.close();
  void developmentBroker?.close();
});
