export type {
  AuthorizedWorkspace,
  ApplicationReviewState,
  BrowserProfile,
  BrowserApplicationProfile,
  BrowserApplicationService,
  LargeArtifactPolicy,
  LegacyApplicationCandidate,
  LocalApplication,
  LocalApplicationService,
  ProcessProfile,
  ProcessProfileSource,
  WorkspaceCapability,
  WorkspaceLimits,
  WorkspacePermissions,
  WorkspaceRegistry,
} from "./types.js";

export {
  applicationNameKey,
  browserProfileSchema,
  browserApplicationProfileSchema,
  defaultLargeArtifactPolicy,
  DEFAULT_DENY_PATTERNS,
  getWorkspace,
  legacyRegistryFileSchema,
  loadWorkspaceRegistryDocument,
  loadWorkspaceRegistry,
  localApplicationSchema,
  localApplicationServiceSchema,
  largeArtifactPolicySchema,
  loopbackOriginSchema,
  parseWorkspaceRegistry,
  processProfileSchema,
  registryFileSchema,
  workspaceSchema,
} from "./registry.js";

export { resolveSafePath, type SafePath } from "./paths.js";

export {
  fromWorkspaceScopePath,
  resolveWorkspaceScope,
  toWorkspaceScopePath,
  type AuthorizedWorkspaceScope,
} from "./scope.js";

export { isPathDenied } from "./denylist.js";

export { withWorkspaceAuthorityLock } from "./authority-lock.js";

export { resolveWriteTarget, type ResolveWriteTargetOptions, type WriteTarget } from "./write-paths.js";

export {
  developmentProjectNameKey,
  developmentProjectSchema,
  developmentProjectSetupStatusSchema,
  developmentProjectStoreSchema,
  projectSetupPhaseSchema,
  projectSetupSessionSchema,
  projectSetupStoreSchema,
  setupActionSchema,
  setupApplicationProposalSchema,
  setupManifestRefSchema,
  setupPlanSchema,
  setupPolicySchema,
  setupProfileProposalSchema,
  type DevelopmentProject,
  type DevelopmentProjectSetupStatus,
  type DevelopmentProjectStore,
  type ProjectSetupPhase,
  type ProjectSetupSession,
  type ProjectSetupStore,
  type SetupAction,
  type SetupApplicationProposal,
  type SetupManifestRef,
  type SetupPlan,
  type SetupPolicy,
  type SetupProfileProposal,
} from "./projects.js";

export {
  derivedProjectScopeSchema,
  projectCatalogRecordSchema,
  projectCatalogStateSchema,
  projectCatalogStoreSchema,
  projectCompatibilityReferenceSchema,
  projectNodeSchema,
  projectScanCoverageSchema,
  projectScanRecordSchema,
  projectScanStoreSchema,
  projectTopologyKindSchema,
  projectTrustModeSchema,
  projectTrustRecordSchema,
  projectTrustStoreSchema,
  type DerivedProjectScope,
  type ProjectCatalogRecord,
  type ProjectCatalogState,
  type ProjectCatalogStore,
  type ProjectCompatibilityReference,
  type ProjectNode,
  type ProjectScanCoverage,
  type ProjectScanRecord,
  type ProjectScanStore,
  type ProjectTopologyKind,
  type ProjectTrustMode,
  type ProjectTrustRecord,
  type ProjectTrustStore,
} from "./project-catalog.js";
