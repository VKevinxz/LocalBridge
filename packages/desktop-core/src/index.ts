export { detectProjectCommands, type DetectedCommand } from "./project-command-detector.js";
export {
  identityTokens,
  isSensitiveInput,
  type SensitiveInputCandidate,
} from "./sensitive-input.js";
export {
  DEFAULT_TOPOLOGY_LIMITS,
  detectProjectTopology,
  type ProjectTopology,
  type TopologyCommand,
  type TopologyDetectorLimits,
  type TopologyLockfile,
  type TopologyManifest,
} from "./project-topology-detector.js";
export {
  buildSetupPlan,
  validateSetupPlan,
  type SetupToolchainEvidence,
} from "./setup-plan.js";
export {
  resolveSetupToolchain,
  resolveSetupToolchains,
  revalidateSetupToolchain,
  type ResolvedSetupToolchain,
  type SetupToolchainKind,
} from "./setup-toolchain.js";
export {
  verifyProcessProfile,
  type ProcessProfileVerification,
  type ProcessProfileVerificationCode,
} from "./process-profile-verifier.js";

export {
  MANAGED_TUNNEL_PROFILE,
  bundledServerCommand,
  quoteTunnelCommandToken,
  resolveBundledRuntimePaths,
  type BundledRuntimePaths,
} from "./bundled-runtime.js";

export {
  activeConnectionProfile,
  connectionProfileIdSchema,
  connectionProfileSchema,
  DEFAULT_DESKTOP_SETTINGS,
  DEFAULT_CONNECTION_PROFILE,
  desktopSettingsSchema,
  defaultDesktopSettingsPath,
  readDesktopSettings,
  writeDesktopSettings,
  synchronizeActiveConnectionProfile,
  type ConnectionProfile,
  type DesktopSettings,
} from "./app-settings.js";

export {
  ONBOARDING_STEPS,
  defaultOnboardingStatePath,
  deriveOnboardingState,
  legacyOnboardingMarkers,
  onboardingStateSchema,
  readOnboardingState,
  restartOnboardingState,
  updateOnboardingState,
  writeOnboardingState,
  type OnboardingState,
  type OnboardingStateReadResult,
  type OnboardingStep,
} from "./onboarding-store.js";

export {
  FolderSelectionVault,
  OnboardingGuardError,
  advanceOnboarding,
  backOnboarding,
  buildOnboardingSnapshot,
  completeOnboarding,
  folderSelectionIdSchema,
  onboardingPermissionPreset,
  type FolderSelection,
  type OnboardingEvidence,
  type OnboardingGuidedPreset,
  type OnboardingRequirement,
  type OnboardingSnapshot,
} from "./onboarding-coordinator.js";

export {
  absolutePathSchema,
  applicationIdInputSchema,
  adoptDevelopmentProjectInputSchema,
  auditQuerySchema,
  authorizedWorkspaceInputSchema,
  browserSessionIdInputSchema,
  connectionProfileNameSchema,
  diagnosticTextSchema,
  developmentProjectIdInputSchema,
  externalDestinationSchema,
  newWorkspaceInputSchema,
  newApplicationInputSchema,
  newAssistedProjectInputSchema,
  onboardingAccessInputSchema,
  onboardingCompletionInputSchema,
  onboardingGuidedPresetSchema,
  localApplicationInputSchema,
  liveViewerMoveInputSchema,
  liveViewerTargetInputSchema,
  listenerRefInputSchema,
  terminalListenerTargetInputSchema,
  terminalSessionIdInputSchema,
  terminalSessionTargetInputSchema,
  tunnelApiKeyInputSchema,
  portableImportSessionIdSchema,
  portableWorkspaceRefSchema,
  setupReviewInputSchema,
  setupPolicyInputSchema,
  workspaceIdInputSchema,
  type ExternalDestination,
} from "./ipc-inputs.js";

export {
  clearEncryptedKey,
  defaultTunnelKeyPath,
  loadEncryptedKey,
  saveEncryptedKey,
  type SecureKeyStoreDeps,
} from "./secure-key-store.js";

export {
  RegistryStoreError,
  buildNewApplication,
  buildNewWorkspace,
  listApplications,
  loadRegistryDocument,
  listWorkspaces,
  migrateRegistryFile,
  removeApplication,
  removeWorkspace,
  replaceRegistry,
  replaceWorkspaces,
  upsertApplication,
  upsertWorkspace,
  type NewApplicationInput,
  type NewWorkspaceInput,
} from "./registry-store.js";

export {
  DevelopmentProjectStoreError,
  buildNewDevelopmentProject,
  listDevelopmentProjects,
  loadDevelopmentProjectStore,
  removeDevelopmentProject,
  replaceDevelopmentProjects,
  upsertDevelopmentProject,
  type NewDevelopmentProjectInput,
} from "./development-project-store.js";

export {
  ProjectCatalogStoreError,
  buildEmptyProjectCatalogRecord,
  loadProjectCatalog,
  loadOrCreateDeviceBinding,
  loadProjectScanStore,
  loadProjectTrustStore,
  migrateDevelopmentProjectsToCatalog,
  removeProjectCatalogRecord,
  removeProjectScanRecord,
  replaceProjectCatalog,
  replaceProjectTrust,
  revokeProjectTrust,
  setProjectTrust,
  upsertProjectCatalogRecord,
  upsertProjectScanRecord,
} from "./project-catalog-store.js";

export {
  createProjectSetupSession,
  interruptProjectSetupSessions,
  listProjectSetupSessions,
  updateProjectSetupSession,
} from "./project-setup-store.js";
export {
  finalizeSetupPlan,
  type FinalizeSetupOptions,
  type FinalizeSetupResult,
} from "./setup-finalizer.js";

export {
  applyPortableConfig,
  buildPortableConfig,
  exportPortableConfigFile,
  portableConfigSchema,
  readPortableConfigFile,
  type PortableConfig,
  type PortableImportResult,
} from "./portability.js";

export {
  testWorkspaceReadiness,
  type WorkspaceReadinessDeps,
  type WorkspaceReadinessItem,
  type WorkspaceReadinessReport,
} from "./workspace-readiness.js";

export { listAuditEvents, listPendingApprovals, type AuditEvent, type AuditQuery, type PendingApproval } from "./audit-view.js";

export {
  TunnelSupervisor,
  MIN_UPTIME_FOR_AUTO_RECONNECT_MS,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  AUTO_RECONNECT_DELAY_MS,
  type SpawnFn,
  type TunnelConnectOptions,
  type TunnelStatus,
  type TunnelSupervisorCallbacks,
  type TunnelSupervisorDeps,
} from "./tunnel-supervisor.js";

export {
  diagnoseTunnelProfile,
  initializeTunnelProfile,
  tunnelIdSchema,
  type ProvisionSpawnFn,
  type TunnelDoctorOptions,
  type TunnelDoctorResult,
  type TunnelProvisionOptions,
  type TunnelProvisionerDeps,
} from "./tunnel-provisioner.js";

export {
  checkControlPlaneConnectivity,
  checkRuntimeReadiness,
  probeBundledServer,
  type RuntimeCheckDeps,
  type RuntimeCheckItem,
  type RuntimeReadinessReport,
} from "./runtime-checks.js";
export { exportDiagnosticFile } from "./diagnostic-export.js";
