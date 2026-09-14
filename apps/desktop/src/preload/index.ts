/**
 * Puente de contexto (ADR-0015): la única superficie que el renderer puede
 * tocar. Nunca expone `ipcRenderer` en crudo ni Node/`fs` directamente — cada
 * método es una operación concreta y acotada, igual que las tools MCP nunca
 * exponen un shell genérico al modelo.
 */

import { contextBridge, ipcRenderer } from "electron";

import type {
  AuthorizedWorkspace,
  DevelopmentProject,
  LocalApplication,
  ProjectSetupSession,
  ProjectCatalogRecord,
  ProjectTrustMode,
  ProjectTrustRecord,
  SetupPolicy,
  WorkspacePermissions,
} from "@localbridge/workspace";
import type {
  BundledRuntimePaths,
  DesktopSettings,
  DetectedCommand,
  AuditEvent,
  AuditQuery,
  PendingApproval,
  NewWorkspaceInput,
  ExternalDestination,
  RuntimeReadinessReport,
  PortableConfig,
  PortableImportResult,
  WorkspaceReadinessReport,
  TunnelDoctorResult,
  TunnelStatus,
  OnboardingSnapshot,
  WebProfile,
  WebProfileStoreSnapshot,
  StoredTunnelKeyState,
  TunnelConnectInput,
} from "@localbridge/desktop-core";

export type {
  BundledRuntimePaths,
  DesktopSettings,
  DetectedCommand,
  ExternalDestination,
  RuntimeReadinessReport,
  PortableConfig,
  PortableImportResult,
  WorkspaceReadinessReport,
  AuditEvent,
  AuditQuery,
  PendingApproval,
  TunnelDoctorResult,
  TunnelStatus,
  WebProfile,
  WebProfileStoreSnapshot,
  StoredTunnelKeyState,
  TunnelConnectInput,
};

export interface TunnelPersistenceResult {
  readonly keyPersistence?: "remembered" | "failed";
  readonly warningCode?: "KEY_STORE_WRITE_FAILED";
}

export type TunnelDiagnosisResult = TunnelDoctorResult & TunnelPersistenceResult;

export interface TunnelConnectResult {
  readonly connected: true;
  readonly remembered: boolean;
  readonly warningCode?: "KEY_STORE_WRITE_FAILED";
}

export interface DesktopApi {
  getOnboardingSnapshot(): Promise<OnboardingViewSnapshot>;
  restartOnboarding(): Promise<OnboardingViewSnapshot>;
  nextOnboarding(): Promise<OnboardingViewSnapshot>;
  backOnboarding(): Promise<OnboardingViewSnapshot>;
  checkOnboardingRuntime(): Promise<{ report: RuntimeReadinessReport; snapshot: OnboardingViewSnapshot }>;
  diagnoseOnboardingConnection(apiKey: string): Promise<{ report: TunnelDiagnosisResult; snapshot: OnboardingViewSnapshot }>;
  pickOnboardingProjectFolder(): Promise<{ folder: OnboardingFolderSummary; snapshot: OnboardingViewSnapshot } | undefined>;
  setOnboardingAccess(input: OnboardingAccessDraft): Promise<OnboardingViewSnapshot>;
  completeOnboarding(input: OnboardingCompletionDraft): Promise<OnboardingViewSnapshot & { project: ProjectCatalogRecord }>;
  listV1Projects(): Promise<V1ProjectsState>;
  createV1Project(input: NewV1ProjectDraft): Promise<{ project: ProjectCatalogRecord; decision: ProjectTrustRecord }>;
  setV1ProjectTrust(projectId: string, mode: ProjectTrustMode): Promise<ProjectTrustRecord>;
  revokeV1ProjectTrust(projectId: string): Promise<ProjectTrustRecord>;
  rescanV1Project(projectId: string): Promise<ProjectCatalogRecord>;
  listAssistedProjects(): Promise<AssistedProjectsState>;
  createAssistedProject(input: NewAssistedProjectDraft): Promise<{ project: DevelopmentProject; session: ProjectSetupSession }>;
  adoptDevelopmentProject(input: AdoptDevelopmentProjectDraft): Promise<DevelopmentProject>;
  refreshAssistedProject(projectId: string): Promise<ProjectSetupSession>;
  setAssistedProjectPolicy(projectId: string, policy: SetupPolicy): Promise<ProjectSetupSession>;
  approveAssistedProject(projectId: string, planSha256: string): Promise<{ project: DevelopmentProject; session: ProjectSetupSession; run: SetupRunSummary }>;
  cancelAssistedProject(projectId: string): Promise<ProjectSetupSession | undefined>;
  removeDevelopmentProject(projectId: string): Promise<DevelopmentProjectRemovalResult>;
  onAssistedProjectsChange(callback: () => void): () => void;
  listWorkspaces(): Promise<AuthorizedWorkspace[]>;
  pickFolder(): Promise<string | undefined>;
  createWorkspace(input: NewWorkspaceInput): Promise<AuthorizedWorkspace>;
  updateWorkspace(workspace: AuthorizedWorkspace): Promise<AuthorizedWorkspace>;
  removeWorkspace(id: string): Promise<void>;
  testWorkspace(id: string): Promise<WorkspaceReadinessReport>;
  listApplications(): Promise<LocalApplication[]>;
  createApplication(input: NewApplicationDraft): Promise<LocalApplication>;
  updateApplication(application: LocalApplication): Promise<LocalApplication>;
  removeApplication(id: string): Promise<void>;
  verifyApplication(id: string): Promise<{ application: LocalApplication; run: ApplicationRunSummary }>;
  startApplication(id: string): Promise<ApplicationRunSummary>;
  applicationStatus(runId: string): Promise<ApplicationRunSummary>;
  stopApplication(applicationId: string, runId: string): Promise<ApplicationRunSummary | undefined>;
  /** Solo lee manifiestos conocidos (package.json/composer.json/Makefile) — nunca ejecuta nada. */
  detectProjectCommands(rootPath: string): Promise<DetectedCommand[]>;
  listDevelopmentActivity(): Promise<DevelopmentActivity>;
  cancelAnalysisJob(workspaceId: string, jobId: string): Promise<void>;
  cancelTaskBatch(workspaceId: string, batchId: string, localId?: string): Promise<void>;
  stopAllDevelopmentActivity(): Promise<void>;
  openTerminalListener(projectId: string, terminalSessionId: string, listenerRef: string): Promise<void>;
  copyTerminalListener(projectId: string, terminalSessionId: string, listenerRef: string): Promise<void>;
  stopTerminal(projectId: string, terminalSessionId: string): Promise<void>;
  takeBrowserHumanControl(sessionId: string): Promise<void>;
  declineBrowserHumanControl(sessionId: string): Promise<void>;
  revokeBrowserHumanControl(sessionId: string): Promise<void>;
  captureBrowserViewer(sessionId: string): Promise<BrowserViewerFrame>;
  showBrowserLiveViewer(sessionId: string, displayId?: string, presentationMode?: ViewerPresentationMode): Promise<void>;
  moveBrowserLiveViewer(sessionId: string, displayId: string): Promise<void>;
  hideBrowserLiveViewer(sessionId: string): Promise<void>;
  setBrowserLiveViewerPresentation(sessionId: string, mode: ViewerPresentationMode, panX?: number, panY?: number): Promise<void>;
  cancelBrowserMotion(sessionId: string): Promise<void>;
  setBrowserViewport(workspaceId: string, sessionId: string, width: number, height: number, mobile: boolean): Promise<void>;
  onDevelopmentActivityChange(callback: () => void): () => void;
  getWebProfiles(): Promise<WebProfileStoreSnapshot>;
  enableWebBrowsing(expectedSha256: string | null, download?: boolean): Promise<WebProfileStoreSnapshot>;
  createWebProfile(input: WebProfileCreateDraft): Promise<WebProfileStoreSnapshot>;
  updateWebProfile(expectedSha256: string | null, profile: WebProfile): Promise<WebProfileStoreSnapshot>;
  removeWebProfile(expectedSha256: string | null, webProfileId: string): Promise<WebProfileStoreSnapshot>;
  resetWebProfiles(expectedSha256: string): Promise<WebProfileStoreSnapshot>;
  listWebActivity(): Promise<readonly WebActivitySummary[]>;
  getWebLiveViewerState(): Promise<WebLiveViewerState>;
  listWebTabs(sessionId: string): Promise<readonly WebTabActivitySummary[]>;
  setWebViewport(sessionId: string, tabId: string, width: number, height: number, mobile: boolean): Promise<void>;
  showWebLiveViewer(sessionId: string, mode: 'follow' | 'pinned', displayId?: string, tabId?: string, presentationMode?: ViewerPresentationMode): Promise<void>;
  moveWebLiveViewer(sessionId: string, displayId: string): Promise<void>;
  hideWebLiveViewer(sessionId: string): Promise<void>;
  setWebLiveViewerPresentation(sessionId: string, mode: ViewerPresentationMode, panX?: number, panY?: number): Promise<void>;
  cancelWebMotion(sessionId: string, tabId: string): Promise<void>;
  takeWebHumanControl(sessionId: string, tabId?: string): Promise<void>;
  cycleWebHumanTab(sessionId: string, direction: 'previous' | 'next'): Promise<void>;
  returnWebHumanControl(sessionId: string): Promise<void>;
  declineWebHumanControl(sessionId: string): Promise<void>;
  stopWebSession(sessionId: string): Promise<void>;
  onWebActivityChange(callback: () => void): () => void;

  getSettings(): Promise<DesktopSettings>;
  getRuntimeInfo(): Promise<BundledRuntimePaths>;
  checkRuntime(): Promise<RuntimeReadinessReport>;
  openExternal(destination: ExternalDestination): Promise<void>;
  copyDiagnostic(text: string): Promise<void>;
  exportDiagnostic(text: string): Promise<boolean>;
  hideApp(): Promise<void>;
  quitApp(): Promise<void>;
  createConnectionProfile(name: string): Promise<DesktopSettings>;
  selectConnectionProfile(id: string): Promise<DesktopSettings>;
  removeConnectionProfile(id: string): Promise<DesktopSettings>;
  exportPortableConfig(version?: "v5" | "v4"): Promise<boolean>;
  selectPortableImport(): Promise<{ sessionId: string; config: PortableConfig } | undefined>;
  mapPortableWorkspace(sessionId: string, ref: string): Promise<boolean>;
  applyPortableImport(sessionId: string): Promise<PortableImportResult>;
  listAuditEvents(query: AuditQuery): Promise<AuditEvent[]>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  saveSettings(settings: DesktopSettings): Promise<void>;
  pickTunnelBinary(): Promise<string | undefined>;
  pickTunnelProfileDir(): Promise<string | undefined>;

  connectTunnel(input: TunnelConnectInput): Promise<TunnelConnectResult>;
  initializeTunnelProfile(): Promise<void>;
  diagnoseTunnel(apiKey: string): Promise<TunnelDiagnosisResult>;
  disconnectTunnel(): Promise<void>;
  getTunnelStatus(): Promise<TunnelStatus>;
  getEffectiveGitApprovalMode(): Promise<DesktopSettings["gitApprovalMode"] | undefined>;
  onTunnelStatusChange(callback: (status: TunnelStatus, detail: string | undefined) => void): () => void;
  onTunnelLog(callback: (line: string, stream: "stdout" | "stderr") => void): () => void;

  /** Cifrada con el almacén del sistema operativo — ver secure-key-store.ts. */
  getTunnelKeyState(): Promise<StoredTunnelKeyState>;
  forgetTunnelKey(): Promise<void>;
}

export interface DevelopmentProjectRemovalResult {
  readonly removed: boolean;
  readonly workspacesRemoved: number;
  readonly applicationsRemoved: number;
  readonly sharedWorkspacesKept: number;
  readonly sharedApplicationsKept: number;
  readonly filesDeleted: false;
}

export interface OnboardingFolderSummary {
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

export interface OnboardingAccessDraft {
  readonly trustMode: "guided" | "full-host";
  readonly guidedPreset: "review" | "develop" | "complete";
}

export interface OnboardingViewSnapshot extends OnboardingSnapshot {
  readonly draft: {
    readonly selectionId?: string;
    readonly existingProjectId?: string;
    readonly trustMode?: "guided" | "full-host";
    readonly guidedPreset?: "review" | "develop" | "complete";
  };
  readonly folder?: OnboardingFolderSummary;
}

export type OnboardingCompletionDraft =
  | ({ readonly kind: "selection"; readonly folderSelectionId: string; readonly name: string; readonly description?: string } & OnboardingAccessDraft)
  | ({ readonly kind: "existing"; readonly projectId: string } & OnboardingAccessDraft);

export interface SetupRunSummary {
  readonly runId: string;
  readonly projectId: string;
  readonly planSha256: string;
  readonly state: "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly completedActions: number;
  readonly totalExecutableActions: number;
  readonly errorCode?: string;
  readonly logs: readonly string[];
}

export interface V1ProjectsState {
  readonly projects: readonly ProjectCatalogRecord[];
  readonly decisions: readonly ProjectTrustRecord[];
  readonly sandboxAvailable: boolean;
}

export interface NewV1ProjectDraft {
  readonly name: string;
  readonly description?: string;
  readonly rootPath: string;
  readonly trustMode: ProjectTrustMode;
}

export interface AssistedProjectsState {
  readonly projects: readonly DevelopmentProject[];
  readonly sessions: readonly ProjectSetupSession[];
  readonly runs: readonly SetupRunSummary[];
}

export interface NewAssistedProjectDraft {
  readonly name: string;
  readonly description?: string;
  readonly rootPath: string;
  readonly permissions: WorkspacePermissions;
  readonly policy: SetupPolicy;
  readonly initializeGit: boolean;
}

export interface AdoptDevelopmentProjectDraft {
  readonly name: string;
  readonly description?: string;
  readonly workspaceIds: readonly string[];
  readonly applicationId?: string;
}

export interface DevelopmentActivity {
  readonly availability?: ReadonlyArray<{
    readonly projectId: string;
    readonly projectName: string;
    readonly terminalAvailable: boolean;
    readonly reviewed: {
      readonly processes: number;
      readonly validations: number;
      readonly browser: number;
    };
    readonly detectedProposal: {
      readonly state: 'none' | 'detected-awaiting-review' | 'applying' | 'detected-inactive';
      readonly processes: number;
      readonly validations: number;
    };
  }>;
  readonly analysisAvailability?:
    | { readonly available: true }
    | { readonly available: false; readonly reason: 'journal-unavailable' };
  readonly taskBatchAvailability?:
    | { readonly available: true }
    | { readonly available: false; readonly reason: 'journal-unavailable' };
  readonly taskBatches?: ReadonlyArray<{
    readonly batchId: string;
    readonly workspaceId: string;
    readonly operationId: string;
    readonly state: 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'completed' | 'partial' | 'failed' | 'interrupted';
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly deliveryMs: number;
    readonly children: ReadonlyArray<{
      readonly localId: string;
      readonly operationKind: 'artifact.inspect' | 'artifact.hash' | 'artifact.text.read' | 'binary.inspect' | 'document.process' | 'web.download.start' | 'validation.run';
      readonly sourcePath?: string;
      readonly state: 'admitted' | 'waiting_dependency' | 'waiting_resource' | 'running' | 'cancel_requested' | 'cancelled' | 'completed' | 'failed' | 'skipped_dependency' | 'interrupted';
      readonly stage: string;
      readonly effectState: 'not_started' | 'applied' | 'not_applied' | 'uncertain';
      readonly coverage: 'unknown' | 'supported' | 'partial' | 'unsupported' | 'source_changed';
      readonly timing: { readonly admissionMs: number; readonly dependencyWaitMs: number; readonly capacityWaitMs: number; readonly lockWaitMs: number; readonly lockHoldMs: number; readonly executionMs: number; readonly persistenceMs: number; readonly clientWaitMs: 0 };
      readonly analysisJobId?: string;
      readonly errorCode?: string;
      readonly resultAvailable: boolean;
      readonly resultExpired: boolean;
    }>;
  }>;
  readonly jobs?: ReadonlyArray<{
    readonly jobId: string;
    readonly operationId: string;
    readonly operationKind: 'artifact.inspect' | 'artifact.hash' | 'artifact.text.read' | 'binary.inspect' | 'document.process' | 'web.download.start';
    readonly workspaceId: string;
    readonly sourcePath?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly state: 'queued' | 'running' | 'waiting_resource' | 'cancel_requested' | 'cancelled' | 'completed' | 'failed' | 'source_changed' | 'interrupted';
    readonly stage: string;
    readonly progress: { readonly completed: number; readonly total?: number; readonly unit: 'bytes' | 'pages' | 'items' };
    readonly coverage: { readonly status: 'supported' | 'partial' | 'unsupported' | 'source_changed'; readonly bytesRead: number; readonly uniqueBytesRead: number; readonly sourceBytes?: number; readonly omissions?: readonly string[] };
    readonly effectState: 'not_started' | 'applied' | 'not_applied' | 'uncertain';
    readonly resumeCapability: 'continue' | 'restart' | 'result_only' | 'none';
    readonly errorCode?: string;
  }>;
  readonly terminals?: ReadonlyArray<{
    readonly sessionId: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly state: 'running' | 'exited' | 'stopped' | 'revoked' | 'timed_out';
    readonly trustMode: 'project-agent' | 'full-host';
    readonly startedAt: string;
    readonly deadline: string;
    readonly nextCursor: number;
    readonly exitCode?: number;
    readonly listeners: ReadonlyArray<{
      readonly listenerRef: string;
      readonly browserOrigin: string;
      readonly addressFamily: 'ipv4' | 'ipv6';
      readonly bindScope: 'loopback' | 'wildcard';
      readonly exclusive: boolean;
      readonly port: number;
      readonly observedAt: string;
    }>;
  }>;
  readonly processes: ReadonlyArray<{
    workspaceId: string;
    processId: string;
    profile: string;
    state: 'running' | 'exited' | 'stopped' | 'timed_out';
    startedAt: string;
    deadline: string;
    exitCode?: number;
    listeners: ReadonlyArray<{
      listenerRef: string;
      origin: string;
      addressFamily: 'ipv4' | 'ipv6';
      bindScope: 'loopback' | 'wildcard';
      exclusive: boolean;
      port: number;
      observedAt: string;
    }>;
  }>;
  readonly browsers: ReadonlyArray<{
    workspaceId: string;
    sessionId: string;
    profile: string;
    state: 'running' | 'stopped';
    title: string;
    path: string;
    startedAt: string;
    controlState: 'agent_control' | 'waiting_for_human' | 'human_control' | 'returning_to_agent' | 'declined' | 'expired' | 'stopped';
    controlExpiresAt?: string;
    postHumanExpiresAt?: string;
    humanReason?: 'sign_in' | 'file_selection' | 'manual_step';
    viewport?: { readonly width: number; readonly height: number; readonly mobile: boolean };
    motionCapture?: { readonly completed: number; readonly total: number; readonly mode: 'auto' | 'stepped' | 'screencast' };
    lastMotionCapture?: MotionCaptureReceipt;
    viewerPresentation?: ViewerPresentationSummary;
  }>;
  readonly applications: ReadonlyArray<ApplicationRunSummary>;
  readonly displays?: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly label: string;
    readonly isPrimary: boolean;
  }>;
  readonly recommendedDisplayId?: string;
  readonly liveViewerSessionId?: string;
  readonly liveViewerDisplayId?: string;
}

export type ViewerPresentationMode = 'fit' | 'actual';

export interface ViewerPresentationSummary {
  readonly mode: ViewerPresentationMode;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
}

export interface MotionCaptureReceipt {
  readonly path: string;
  readonly frameCount: number;
  readonly totalSize: number;
  readonly captureMode: 'stepped' | 'screencast';
  readonly warnings: readonly string[];
}

export type WebProfileCreateDraft =
  | { readonly kind: 'public-research'; readonly name?: string }
  | { readonly kind: 'site-account'; readonly name: string; readonly destinations: readonly string[]; readonly supportHosts?: readonly string[] };

export interface WebActivitySummary {
  readonly sessionId: string;
  readonly webProfileId: string;
  readonly profileName: string;
  readonly profileKind: 'public-research' | 'site-account';
  readonly state: 'running' | 'stopped';
  readonly startedAt: string;
  readonly controlState: 'agent_control' | 'waiting_for_human' | 'human_control' | 'returning_to_agent' | 'ready' | 'declined' | 'expired' | 'stopped';
  readonly tabCount: number;
  readonly controlExpiresAt?: string;
  readonly humanReason?: 'sign_in' | 'file_selection' | 'manual_step';
  readonly delegatedSite?: string;
  readonly delegatedExpiresAt?: string;
  readonly closedAt?: string;
  readonly closeReason?: 'user' | 'agent' | 'policy' | 'expired' | 'failed';
}

export interface WebTabActivitySummary {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly state: 'ready' | 'loading' | 'failed' | 'closed';
  readonly openedAt: string;
  readonly viewport?: { readonly width: number; readonly height: number; readonly mobile: boolean };
  readonly blockedNativeDownloads?: number;
  readonly blockedFileChoosers?: number;
  readonly blockedDialogs?: number;
  readonly motionCapture?: { readonly completed: number; readonly total: number; readonly mode: 'auto' | 'stepped' | 'screencast' };
  readonly lastMotionCapture?: MotionCaptureReceipt;
  readonly viewerPresentation?: ViewerPresentationSummary;
}

export interface WebLiveViewerState {
  readonly visible: boolean;
  readonly mode?: 'follow' | 'pinned';
  readonly sessionId?: string;
  readonly tabId?: string;
  readonly pageState?: 'loading' | 'action' | 'idle' | 'failed';
  readonly presentation?: ViewerPresentationSummary;
  readonly displays: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly label: string;
    readonly isPrimary: boolean;
  }>;
  readonly recommendedDisplayId: string;
  readonly displayId?: string;
}

export type BrowserViewerFrame =
  | { readonly state: 'ready'; readonly sessionId: string; readonly dataUrl: string; readonly width: number; readonly height: number; readonly path: string; readonly capturedAt: string }
  | { readonly state: 'private'; readonly sessionId: string; readonly path: string }
  | { readonly state: 'stopped'; readonly sessionId: string; readonly path: '/' };

export interface ApplicationRunSummary {
  readonly runId: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly primaryWorkspaceId: string;
  readonly state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'failed_cleanup';
  readonly startedAt: string;
  readonly services: ReadonlyArray<{
    readonly service: string;
    readonly workspaceId: string;
    readonly processProfile: string;
    readonly state: 'pending' | 'starting' | 'ready' | 'stopped' | 'failed';
    readonly port?: number;
    readonly bindScope?: 'loopback' | 'wildcard';
  }>;
  readonly errorCode?: string;
}

export interface NewApplicationDraft {
  readonly name: string;
  readonly description?: string;
  readonly primaryServiceAlias: string;
  readonly services: ReadonlyArray<{
    readonly alias: string;
    readonly workspaceId: string;
    readonly processProfile: string;
    readonly hostMode: 'manual-localhost' | 'listener-literal';
    readonly allowManagedWildcard: boolean;
  }>;
  readonly viewport?: { readonly width: number; readonly height: number };
}

const api: DesktopApi = {
  getOnboardingSnapshot: () => ipcRenderer.invoke("onboarding:getSnapshot"),
  restartOnboarding: () => ipcRenderer.invoke("onboarding:restart"),
  nextOnboarding: () => ipcRenderer.invoke("onboarding:next"),
  backOnboarding: () => ipcRenderer.invoke("onboarding:back"),
  checkOnboardingRuntime: () => ipcRenderer.invoke("onboarding:checkRuntime"),
  diagnoseOnboardingConnection: (apiKey) => ipcRenderer.invoke("onboarding:diagnoseConnection", apiKey),
  pickOnboardingProjectFolder: () => ipcRenderer.invoke("onboarding:pickProjectFolder"),
  setOnboardingAccess: (input) => ipcRenderer.invoke("onboarding:setAccess", input),
  completeOnboarding: (input) => ipcRenderer.invoke("onboarding:complete", input),
  listV1Projects: () => ipcRenderer.invoke("projects:v1:list"),
  createV1Project: (input) => ipcRenderer.invoke("projects:v1:create", input),
  setV1ProjectTrust: (projectId, mode) => ipcRenderer.invoke("projects:v1:trust", { projectId, mode }),
  revokeV1ProjectTrust: (projectId) => ipcRenderer.invoke("projects:v1:revoke", projectId),
  rescanV1Project: (projectId) => ipcRenderer.invoke("projects:v1:rescan", projectId),
  listAssistedProjects: () => ipcRenderer.invoke("projects:list"),
  createAssistedProject: (input) => ipcRenderer.invoke("projects:create", input),
  adoptDevelopmentProject: (input) => ipcRenderer.invoke("projects:adopt", input),
  refreshAssistedProject: (projectId) => ipcRenderer.invoke("projects:refresh", projectId),
  setAssistedProjectPolicy: (projectId, policy) => ipcRenderer.invoke("projects:policy", { projectId, policy }),
  approveAssistedProject: (projectId, planSha256) => ipcRenderer.invoke("projects:approve", { projectId, planSha256 }),
  cancelAssistedProject: (projectId) => ipcRenderer.invoke("projects:cancel", projectId),
  removeDevelopmentProject: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
  onAssistedProjectsChange: (callback) => {
    const listener = (): void => callback();
    ipcRenderer.on("projects:changed", listener);
    return () => ipcRenderer.removeListener("projects:changed", listener);
  },
  listWorkspaces: () => ipcRenderer.invoke("workspaces:list"),
  pickFolder: () => ipcRenderer.invoke("workspaces:pickFolder"),
  createWorkspace: (input) => ipcRenderer.invoke("workspaces:create", input),
  updateWorkspace: (workspace) => ipcRenderer.invoke("workspaces:update", workspace),
  removeWorkspace: (id) => ipcRenderer.invoke("workspaces:remove", id),
  testWorkspace: (id) => ipcRenderer.invoke("workspaces:test", id),
  listApplications: () => ipcRenderer.invoke("applications:list"),
  createApplication: (input) => ipcRenderer.invoke("applications:create", input),
  updateApplication: (application) => ipcRenderer.invoke("applications:update", application),
  removeApplication: (id) => ipcRenderer.invoke("applications:remove", id),
  verifyApplication: (id) => ipcRenderer.invoke("applications:verify", id),
  startApplication: (id) => ipcRenderer.invoke("applications:start", id),
  applicationStatus: (runId) => ipcRenderer.invoke("applications:status", runId),
  stopApplication: (applicationId, runId) => ipcRenderer.invoke("applications:stop", applicationId, runId),
  detectProjectCommands: (rootPath) => ipcRenderer.invoke("workspaces:detectCommands", rootPath),
  listDevelopmentActivity: () => ipcRenderer.invoke("development:list"),
  cancelAnalysisJob: (workspaceId, jobId) => ipcRenderer.invoke("development:cancelAnalysis", { workspaceId, jobId }),
  cancelTaskBatch: (workspaceId, batchId, localId) => ipcRenderer.invoke("development:cancelTaskBatch", {
    workspaceId, batchId, ...(localId === undefined ? {} : { localId }),
  }),
  stopAllDevelopmentActivity: () => ipcRenderer.invoke("development:stopAll"),
  openTerminalListener: (projectId, terminalSessionId, listenerRef) => ipcRenderer.invoke('development:openTerminalListener', {
    projectId, terminalSessionId, listenerRef,
  }),
  copyTerminalListener: (projectId, terminalSessionId, listenerRef) => ipcRenderer.invoke('development:copyTerminalListener', {
    projectId, terminalSessionId, listenerRef,
  }),
  stopTerminal: (projectId, terminalSessionId) => ipcRenderer.invoke('development:stopTerminal', {
    projectId, terminalSessionId,
  }),
  takeBrowserHumanControl: (sessionId) => ipcRenderer.invoke('development:takeHumanControl', sessionId),
  declineBrowserHumanControl: (sessionId) => ipcRenderer.invoke('development:declineHumanControl', sessionId),
  revokeBrowserHumanControl: (sessionId) => ipcRenderer.invoke('development:revokeHumanControl', sessionId),
  captureBrowserViewer: (sessionId) => ipcRenderer.invoke('development:captureViewer', sessionId),
  showBrowserLiveViewer: (sessionId, displayId, presentationMode) => ipcRenderer.invoke('development:showLiveViewer', {
    sessionId,
    ...(displayId === undefined ? {} : { displayId }),
    ...(presentationMode === undefined ? {} : { presentationMode }),
  }),
  moveBrowserLiveViewer: (sessionId, displayId) => ipcRenderer.invoke('development:moveLiveViewer', { sessionId, displayId }),
  hideBrowserLiveViewer: (sessionId) => ipcRenderer.invoke('development:hideLiveViewer', sessionId),
  setBrowserLiveViewerPresentation: (sessionId, mode, panX = 0, panY = 0) => ipcRenderer.invoke('development:setLiveViewerPresentation', { sessionId, mode, panX, panY }),
  cancelBrowserMotion: (sessionId) => ipcRenderer.invoke('development:cancelMotion', { sessionId }),
  setBrowserViewport: (workspaceId, sessionId, width, height, mobile) => ipcRenderer.invoke('development:setViewport', { workspaceId, sessionId, width, height, mobile }),
  onDevelopmentActivityChange: (callback) => {
    const listener = (): void => callback();
    ipcRenderer.on('development:changed', listener);
    return () => ipcRenderer.removeListener('development:changed', listener);
  },
  getWebProfiles: () => ipcRenderer.invoke('webProfiles:get'),
  enableWebBrowsing: (expectedSha256, download = false) => ipcRenderer.invoke('webProfiles:enableInternet', { expectedSha256, download }),
  createWebProfile: (input) => ipcRenderer.invoke('webProfiles:create', input),
  updateWebProfile: (expectedSha256, profile) => ipcRenderer.invoke('webProfiles:update', { expectedSha256, profile }),
  removeWebProfile: (expectedSha256, webProfileId) => ipcRenderer.invoke('webProfiles:remove', { expectedSha256, webProfileId }),
  resetWebProfiles: (expectedSha256) => ipcRenderer.invoke('webProfiles:reset', { expectedSha256 }),
  listWebActivity: () => ipcRenderer.invoke('webActivity:list'),
  getWebLiveViewerState: () => ipcRenderer.invoke('webActivity:viewerState', {}),
  listWebTabs: (sessionId) => ipcRenderer.invoke('webActivity:tabs', { sessionId }),
  setWebViewport: (sessionId, tabId, width, height, mobile) => ipcRenderer.invoke('webActivity:setViewport', { sessionId, tabId, width, height, mobile }),
  showWebLiveViewer: (sessionId, mode, displayId, tabId, presentationMode) => ipcRenderer.invoke('webActivity:showLiveViewer', {
    sessionId,
    mode,
    ...(displayId === undefined ? {} : { displayId }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(presentationMode === undefined ? {} : { presentationMode }),
  }),
  moveWebLiveViewer: (sessionId, displayId) => ipcRenderer.invoke('webActivity:moveLiveViewer', { sessionId, displayId }),
  hideWebLiveViewer: (sessionId) => ipcRenderer.invoke('webActivity:hideLiveViewer', { sessionId }),
  setWebLiveViewerPresentation: (sessionId, mode, panX = 0, panY = 0) => ipcRenderer.invoke('webActivity:setLiveViewerPresentation', { sessionId, mode, panX, panY }),
  cancelWebMotion: (sessionId, tabId) => ipcRenderer.invoke('webActivity:cancelMotion', { sessionId, tabId }),
  takeWebHumanControl: (sessionId, tabId) => ipcRenderer.invoke('webActivity:takeHumanControl', {
    sessionId,
    ...(tabId === undefined ? {} : { tabId }),
  }),
  cycleWebHumanTab: (sessionId, direction) => ipcRenderer.invoke('webActivity:cycleHumanTab', { sessionId, direction }),
  returnWebHumanControl: (sessionId) => ipcRenderer.invoke('webActivity:returnHumanControl', sessionId),
  declineWebHumanControl: (sessionId) => ipcRenderer.invoke('webActivity:declineHumanControl', sessionId),
  stopWebSession: (sessionId) => ipcRenderer.invoke('webActivity:stop', sessionId),
  onWebActivityChange: (callback) => {
    const listener = (): void => callback();
    ipcRenderer.on('web:changed', listener);
    return () => ipcRenderer.removeListener('web:changed', listener);
  },

  getSettings: () => ipcRenderer.invoke("settings:get"),
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:getInfo"),
  checkRuntime: () => ipcRenderer.invoke("runtime:check"),
  openExternal: (destination) => ipcRenderer.invoke("external:open", destination),
  copyDiagnostic: (text) => ipcRenderer.invoke("diagnostics:copy", text),
  exportDiagnostic: (text) => ipcRenderer.invoke("diagnostics:export", text),
  hideApp: () => ipcRenderer.invoke("app:hide"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  createConnectionProfile: (name) => ipcRenderer.invoke("profiles:create", name),
  selectConnectionProfile: (id) => ipcRenderer.invoke("profiles:select", id),
  removeConnectionProfile: (id) => ipcRenderer.invoke("profiles:remove", id),
  exportPortableConfig: (version = "v5") => ipcRenderer.invoke("portability:export", version),
  selectPortableImport: () => ipcRenderer.invoke("portability:selectImport"),
  mapPortableWorkspace: (sessionId, ref) => ipcRenderer.invoke("portability:mapWorkspace", sessionId, ref),
  applyPortableImport: (sessionId) => ipcRenderer.invoke("portability:applyImport", sessionId),
  listAuditEvents: (query) => ipcRenderer.invoke("audit:list", query),
  listPendingApprovals: () => ipcRenderer.invoke("approvals:list"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  pickTunnelBinary: () => ipcRenderer.invoke("settings:pickTunnelBinary"),
  pickTunnelProfileDir: () => ipcRenderer.invoke("settings:pickTunnelProfileDir"),

  connectTunnel: (input) => ipcRenderer.invoke("tunnel:connect", input),
  initializeTunnelProfile: () => ipcRenderer.invoke("tunnel:initializeProfile"),
  diagnoseTunnel: (apiKey) => ipcRenderer.invoke("tunnel:doctor", apiKey),
  disconnectTunnel: () => ipcRenderer.invoke("tunnel:disconnect"),
  getTunnelStatus: () => ipcRenderer.invoke("tunnel:status"),
  getEffectiveGitApprovalMode: () => ipcRenderer.invoke("tunnel:effectiveGitApprovalMode"),
  onTunnelStatusChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: TunnelStatus, detail: string | undefined): void =>
      callback(status, detail);
    ipcRenderer.on("tunnel:status-change", listener);
    return () => ipcRenderer.removeListener("tunnel:status-change", listener);
  },
  onTunnelLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string, stream: "stdout" | "stderr"): void =>
      callback(line, stream);
    ipcRenderer.on("tunnel:log", listener);
    return () => ipcRenderer.removeListener("tunnel:log", listener);
  },

  getTunnelKeyState: () => ipcRenderer.invoke("tunnel:getKeyState"),
  forgetTunnelKey: () => ipcRenderer.invoke("tunnel:forgetKey"),
};

contextBridge.exposeInMainWorld("desktop", api);
