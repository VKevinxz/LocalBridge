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
  WEB_PROFILE_STORE_SCHEMA_VERSION,
  WebProfileStoreError,
  buildPublicResearchProfile,
  enablePublicInternetAccess,
  buildSiteAccountProfile,
  rememberExactSiteAccess,
  defaultWebProfileStorePath,
  readWebProfileStore,
  requireCurrentWebProfileAuthority,
  replaceWebProfileStore,
  webHostRuleSchema,
  webProfileIdSchema,
  webProfileLimitsSchema,
  webProfilePermissionsSchema,
  webProfileRevision,
  withAuthorizedWebProfileEffect,
  webProfileSchema,
  webProfileStoreSchema,
  type WebHostRule,
  type WebProfile,
  type WebTransferPolicy,
  type WebProfileStore,
  type WebProfileStoreSnapshot,
} from "./web-profile-store.js";

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
  analysisJobTargetInputSchema,
  taskBatchTargetInputSchema,
  applicationIdInputSchema,
  adoptDevelopmentProjectInputSchema,
  auditQuerySchema,
  authorizedWorkspaceInputSchema,
  browserSessionIdInputSchema,
  browserMotionCancelInputSchema,
  browserViewportInputSchema,
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
  liveViewerPresentationInputSchema,
  liveViewerTargetInputSchema,
  viewerPresentationModeSchema,
  listenerRefInputSchema,
  terminalListenerTargetInputSchema,
  terminalSessionIdInputSchema,
  terminalSessionTargetInputSchema,
  tunnelApiKeyInputSchema,
  tunnelConnectInputSchema,
  portableImportSessionIdSchema,
  portableWorkspaceRefSchema,
  setupReviewInputSchema,
  setupPolicyInputSchema,
  workspaceIdInputSchema,
  webHumanSessionInputSchema,
  webHumanTakeInputSchema,
  webHumanCycleInputSchema,
  webLiveViewerHideInputSchema,
  webLiveViewerMoveInputSchema,
  webLiveViewerPresentationInputSchema,
  webLiveViewerShowInputSchema,
  webMotionCancelInputSchema,
  webProfileCreateInputSchema,
  webProfileEnableInternetInputSchema,
  webProfileRemoveInputSchema,
  webProfileResetInputSchema,
  webProfileUpdateInputSchema,
  webSessionIdInputSchema,
  webTabIdInputSchema,
  webTabsInputSchema,
  webViewerStateInputSchema,
  webViewportInputSchema,
  type ExternalDestination,
  type TunnelConnectInput,
} from "./ipc-inputs.js";

export {
  clearEncryptedKey,
  defaultTunnelKeyPath,
  loadEncryptedKey,
  migrateLegacyEncryptedKey,
  publicStoredTunnelKeyState,
  saveAndVerifyEncryptedKey,
  saveEncryptedKey,
  type LegacyKeyMigrationOptions,
  type LegacyKeyMigrationResult,
  type SecureKeyLoadResult,
  type SecureKeyStoreDeps,
  type StoredTunnelKeyState,
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
  removeRegistryEntriesIfPresent,
  removeWorkspace,
  replaceRegistry,
  replaceWorkspaces,
  upsertApplication,
  upsertWorkspace,
  type NewApplicationInput,
  type RegistryEntryRemovalResult,
  type NewWorkspaceInput,
} from "./registry-store.js";

export {
  connectWithTunnelCredential,
  type TunnelCredentialConnectResult,
  type TunnelCredentialFlowOptions,
  type TunnelCredentialRequest,
} from "./tunnel-credential-flow.js";

export {
  DevelopmentProjectStoreError,
  buildNewDevelopmentProject,
  listDevelopmentProjects,
  loadDevelopmentProjectStore,
  removeDevelopmentProject,
  removeDevelopmentProjectIfPresent,
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
  removeProjectTrustRecord,
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
  removeProjectSetupSessions,
  updateProjectSetupSession,
} from "./project-setup-store.js";
export {
  planDevelopmentProjectRemoval,
  type DevelopmentProjectRemovalPlan,
} from "./development-project-removal.js";
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
  TunnelConnectionWaitError,
  TunnelSupervisor,
  MIN_UPTIME_FOR_AUTO_RECONNECT_MS,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  AUTO_RECONNECT_DELAY_MS,
  type SpawnFn,
  type TunnelConnectionWaitCode,
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
