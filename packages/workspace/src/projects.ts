import { z } from "zod";

const opaqueProjectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const opaqueSetupIdSchema = z.string().regex(/^setup_[a-f0-9]{24}$/);
const opaquePlanIdSchema = z.string().regex(/^plan_[a-f0-9]{24}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceReferenceSchema = z.string().min(1).max(160);
const applicationReferenceSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const safeRelativeRootSchema = z.string().min(1).max(512).refine(
  (value) => value === "." || (!value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..")),
  "la raíz propuesta debe ser relativa y permanecer dentro del workspace",
);

export const setupPolicySchema = z.enum(["restricted", "compatible", "manual"]);
export type SetupPolicy = z.infer<typeof setupPolicySchema>;

export const developmentProjectSetupStatusSchema = z.enum([
  "draft",
  "review-required",
  "ready",
  "interrupted",
]);
export type DevelopmentProjectSetupStatus = z.infer<typeof developmentProjectSetupStatusSchema>;

export function developmentProjectNameKey(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export const developmentProjectSchema = z.object({
  id: opaqueProjectIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(""),
  workspaceIds: z.array(workspaceReferenceSchema).min(1).max(16),
  applicationId: applicationReferenceSchema.optional(),
  setupStatus: developmentProjectSetupStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((project, context) => {
  if (new Set(project.workspaceIds).size !== project.workspaceIds.length) {
    context.addIssue({ code: "custom", path: ["workspaceIds"], message: "los workspaces deben ser únicos" });
  }
});

export type DevelopmentProject = z.infer<typeof developmentProjectSchema>;

export const developmentProjectStoreSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(developmentProjectSchema).max(500),
}).strict().superRefine((store, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  store.projects.forEach((project, index) => {
    const nameKey = developmentProjectNameKey(project.name);
    if (ids.has(project.id)) {
      context.addIssue({ code: "custom", path: ["projects", index, "id"], message: "ID de proyecto duplicado" });
    }
    if (names.has(nameKey)) {
      context.addIssue({ code: "custom", path: ["projects", index, "name"], message: "nombre de proyecto duplicado" });
    }
    ids.add(project.id);
    names.add(nameKey);
  });
});

export type DevelopmentProjectStore = z.infer<typeof developmentProjectStoreSchema>;

export const setupManifestRefSchema = z.object({
  workspaceId: workspaceReferenceSchema,
  path: z.string().min(1).max(512),
  sha256: sha256Schema,
}).strict();
export type SetupManifestRef = z.infer<typeof setupManifestRefSchema>;

export const setupActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("node-install"),
    manager: z.enum(["npm", "pnpm", "yarn"]),
    workspaceId: workspaceReferenceSchema,
    manifestPath: z.string().min(1).max(512),
    mode: z.enum(["restricted", "compatible"]),
  }).strict(),
  z.object({ kind: z.literal("git-init"), workspaceId: workspaceReferenceSchema }).strict(),
  z.object({ kind: z.literal("persist-profiles"), workspaceId: workspaceReferenceSchema, proposalId: z.string().regex(/^proposal_[a-f0-9]{24}$/) }).strict(),
  z.object({ kind: z.literal("persist-application"), proposalId: z.string().regex(/^proposal_[a-f0-9]{24}$/) }).strict(),
  z.object({ kind: z.literal("finalize-topology"), proposalId: z.string().regex(/^proposal_[a-f0-9]{24}$/) }).strict(),
]);
export type SetupAction = z.infer<typeof setupActionSchema>;

export const setupProfileProposalSchema = z.object({
  id: z.string().regex(/^proposal_[a-f0-9]{24}$/),
  workspaceId: workspaceReferenceSchema,
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  role: z.enum(["server", "validation"]),
  runner: z.enum(["npm", "pnpm", "yarn", "composer", "make"]),
  sourceKind: z.enum(["package-script", "composer-script", "make-target"]),
  manifestPath: z.string().min(1).max(512),
  entry: z.string().min(1).max(128),
  definitionSha256: sha256Schema,
  cwd: z.string().min(1).max(512),
}).strict();
export type SetupProfileProposal = z.infer<typeof setupProfileProposalSchema>;

export const setupApplicationProposalSchema = z.object({
  id: z.string().regex(/^proposal_[a-f0-9]{24}$/),
  name: z.string().trim().min(1).max(80),
  primaryProfileProposalId: setupProfileProposalSchema.shape.id,
  services: z.array(z.object({
    profileProposalId: setupProfileProposalSchema.shape.id,
    alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    startupOrder: z.number().int().min(0).max(7),
    hostMode: z.enum(["manual-localhost", "listener-literal"]),
    allowManagedWildcard: z.boolean(),
  }).strict()).min(1).max(8),
}).strict().superRefine((proposal, context) => {
  const ids = new Set(proposal.services.map((service) => service.profileProposalId));
  const aliases = new Set(proposal.services.map((service) => service.alias.toLocaleLowerCase("en-US")));
  const orders = proposal.services.map((service) => service.startupOrder).toSorted((left, right) => left - right);
  if (ids.size !== proposal.services.length || aliases.size !== proposal.services.length) {
    context.addIssue({ code: "custom", path: ["services"], message: "los servicios deben ser únicos" });
  }
  if (!ids.has(proposal.primaryProfileProposalId)) {
    context.addIssue({ code: "custom", path: ["primaryProfileProposalId"], message: "el servicio principal no existe" });
  }
  if (orders.some((order, index) => order !== index)) {
    context.addIssue({ code: "custom", path: ["services"], message: "el orden debe ser continuo" });
  }
});
export type SetupApplicationProposal = z.infer<typeof setupApplicationProposalSchema>;

export const setupPlanSchema = z.object({
  id: opaquePlanIdSchema,
  projectId: opaqueProjectIdSchema,
  topology: z.enum(["single", "monorepo", "multi-repo"]),
  proposedWorkspaceRoots: z.array(safeRelativeRootSchema).min(1).max(16),
  manifestRefs: z.array(setupManifestRefSchema).min(1).max(64),
  lockfileRefs: z.array(setupManifestRefSchema).max(64),
  packageManagers: z.array(z.enum(["npm", "pnpm", "yarn"])).max(3).default([]),
  directDependencyCount: z.number().int().min(0).max(100_000).default(0),
  directDevDependencyCount: z.number().int().min(0).max(100_000).default(0),
  toolchainFingerprint: sha256Schema,
  actions: z.array(setupActionSchema).max(128),
  proposedProfiles: z.array(setupProfileProposalSchema).max(128),
  proposedApplication: setupApplicationProposalSchema.optional(),
  policy: setupPolicySchema,
  planSha256: sha256Schema,
  createdAt: z.iso.datetime(),
}).strict();
export type SetupPlan = z.infer<typeof setupPlanSchema>;

export const projectSetupPhaseSchema = z.enum([
  "draft",
  "analyzing",
  "awaiting-local-review",
  "installing",
  "finalizing",
  "ready",
  "failed",
  "interrupted",
  "cancelled",
]);
export type ProjectSetupPhase = z.infer<typeof projectSetupPhaseSchema>;

export const projectSetupSessionSchema = z.object({
  id: opaqueSetupIdSchema,
  projectId: opaqueProjectIdSchema,
  provisionalWorkspaceId: workspaceReferenceSchema,
  policy: setupPolicySchema,
  /** Intención local persistida; permite reanalizar un proyecto vacío sin perder la decisión del usuario. */
  initializeGit: z.boolean().default(false),
  phase: projectSetupPhaseSchema,
  plan: setupPlanSchema.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type ProjectSetupSession = z.infer<typeof projectSetupSessionSchema>;

export const projectSetupStoreSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(projectSetupSessionSchema).max(500),
}).strict();
export type ProjectSetupStore = z.infer<typeof projectSetupStoreSchema>;
