import { z } from "zod";

const projectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const nodeIdSchema = z.string().regex(/^node_[a-f0-9]{24}$/);
const workspaceIdSchema = z.string().min(1).max(160);
const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const relativeScopeSchema = z.string().min(1).max(1024).refine(
  (value) => value === "." || (!value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..")),
  "el scope debe ser relativo y permanecer dentro del proyecto",
);

export const projectTrustModeSchema = z.enum(["guided", "project-agent", "full-host"]);
export type ProjectTrustMode = z.infer<typeof projectTrustModeSchema>;

export const projectCatalogStateSchema = z.enum(["ready", "review", "unavailable", "conflict"]);
export type ProjectCatalogState = z.infer<typeof projectCatalogStateSchema>;

export const projectTopologyKindSchema = z.enum([
  "empty",
  "files",
  "single-repo",
  "monorepo",
  "multi-repo",
  "multi-service",
  "ambiguous",
]);
export type ProjectTopologyKind = z.infer<typeof projectTopologyKindSchema>;

export const projectNodeSchema = z.object({
  id: nodeIdSchema,
  kind: z.enum(["folder", "repository", "package", "service"]),
  name: z.string().trim().min(1).max(160),
  relativePath: relativeScopeSchema,
  parentId: nodeIdSchema.optional(),
  workspaceId: workspaceIdSchema.optional(),
  source: z.enum(["detected", "derived", "legacy"]),
  state: z.enum(["ready", "review", "unavailable"]),
}).strict();
export type ProjectNode = z.infer<typeof projectNodeSchema>;

export const derivedProjectScopeSchema = z.object({
  relativePath: relativeScopeSchema,
  source: z.enum(["root", "detected", "created", "legacy"]),
  status: z.enum(["active", "review", "unavailable"]),
}).strict();
export type DerivedProjectScope = z.infer<typeof derivedProjectScopeSchema>;

export const projectCompatibilityReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), id: workspaceIdSchema }).strict(),
  z.object({ kind: z.literal("application"), id: applicationIdSchema }).strict(),
  z.object({ kind: z.literal("development-project"), id: projectIdSchema }).strict(),
]);
export type ProjectCompatibilityReference = z.infer<typeof projectCompatibilityReferenceSchema>;

export const projectCatalogRecordSchema = z.object({
  id: projectIdSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(""),
  selectedRoot: z.string().min(1).max(4096),
  state: projectCatalogStateSchema,
  topology: projectTopologyKindSchema,
  nodes: z.array(projectNodeSchema).max(1_000),
  derivedScopes: z.array(derivedProjectScopeSchema).min(1).max(1_000),
  compatibilityRefs: z.array(projectCompatibilityReferenceSchema).max(64),
  scanFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((record, context) => {
  const nodeIds = new Set(record.nodes.map((node) => node.id));
  if (nodeIds.size !== record.nodes.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "los nodos deben ser únicos" });
  }
  for (const [index, node] of record.nodes.entries()) {
    if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "parentId"], message: "el nodo padre no existe" });
    }
  }
  const scopeKeys = record.derivedScopes.map((scope) => scope.relativePath.toLocaleLowerCase("en-US"));
  if (new Set(scopeKeys).size !== scopeKeys.length) {
    context.addIssue({ code: "custom", path: ["derivedScopes"], message: "los scopes deben ser únicos" });
  }
});
export type ProjectCatalogRecord = z.infer<typeof projectCatalogRecordSchema>;

export const projectCatalogStoreSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(projectCatalogRecordSchema).max(500),
}).strict().superRefine((store, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  store.projects.forEach((project, index) => {
    const name = project.displayName.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    if (ids.has(project.id)) context.addIssue({ code: "custom", path: ["projects", index, "id"], message: "ID duplicado" });
    if (names.has(name)) context.addIssue({ code: "custom", path: ["projects", index, "displayName"], message: "nombre duplicado" });
    ids.add(project.id);
    names.add(name);
  });
});
export type ProjectCatalogStore = z.infer<typeof projectCatalogStoreSchema>;

/**
 * Cobertura del recorrido de topología (ADR-0040). Describe cuánto se alcanzó a
 * inspeccionar, nunca si el proyecto puede operar: vive fuera de
 * `projectCatalogRecordSchema` porque ese esquema es `.strict()` y un campo
 * nuevo dejaría sin arrancar a una versión anterior que leyera el catálogo.
 */
export const projectScanCoverageSchema = z.enum(["complete", "partial"]);
export type ProjectScanCoverage = z.infer<typeof projectScanCoverageSchema>;

export const projectScanRecordSchema = z.object({
  projectId: projectIdSchema,
  coverage: projectScanCoverageSchema,
  scannedEntries: z.number().int().min(0).max(10_000_000),
  entryLimit: z.number().int().min(1).max(10_000_000),
  observedAt: z.iso.datetime(),
}).strict();
export type ProjectScanRecord = z.infer<typeof projectScanRecordSchema>;

export const projectScanStoreSchema = z.object({
  schemaVersion: z.literal(1),
  scans: z.array(projectScanRecordSchema).max(500),
}).strict().superRefine((store, context) => {
  const ids = new Set<string>();
  store.scans.forEach((scan, index) => {
    if (ids.has(scan.projectId)) {
      context.addIssue({ code: "custom", path: ["scans", index, "projectId"], message: "cobertura duplicada" });
    }
    ids.add(scan.projectId);
  });
});
export type ProjectScanStore = z.infer<typeof projectScanStoreSchema>;

export const projectTrustRecordSchema = z.object({
  projectId: projectIdSchema,
  mode: projectTrustModeSchema,
  deviceBinding: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["active", "review", "revoked"]),
  networkPolicy: z.enum(["closed", "declared", "user-session"]),
  acceptedRiskVersion: z.string().max(32).nullable(),
  reviewedAt: z.iso.datetime(),
}).strict();
export type ProjectTrustRecord = z.infer<typeof projectTrustRecordSchema>;

export const projectTrustStoreSchema = z.object({
  schemaVersion: z.literal(1),
  decisions: z.array(projectTrustRecordSchema).max(500),
}).strict().superRefine((store, context) => {
  const ids = new Set<string>();
  store.decisions.forEach((decision, index) => {
    if (ids.has(decision.projectId)) {
      context.addIssue({ code: "custom", path: ["decisions", index, "projectId"], message: "decisión duplicada" });
    }
    ids.add(decision.projectId);
  });
});
export type ProjectTrustStore = z.infer<typeof projectTrustStoreSchema>;
