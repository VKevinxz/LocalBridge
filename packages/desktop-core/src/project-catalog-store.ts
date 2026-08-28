import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent } from "@localbridge/shared";
import {
  projectCatalogRecordSchema,
  projectCatalogStoreSchema,
  projectScanRecordSchema,
  projectScanStoreSchema,
  projectTrustRecordSchema,
  projectTrustStoreSchema,
  type DevelopmentProject,
  type ProjectCatalogRecord,
  type ProjectCatalogStore,
  type ProjectScanRecord,
  type ProjectScanStore,
  type ProjectTrustMode,
  type ProjectTrustRecord,
  type ProjectTrustStore,
  type WorkspaceRegistry,
} from "@localbridge/workspace";

export class ProjectCatalogStoreError extends Error {
  constructor(message: string, readonly code = "PROJECT_CATALOG_INVALID") {
    super(message);
    this.name = "ProjectCatalogStoreError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function emptyCatalog(): ProjectCatalogStore {
  return { schemaVersion: 1, projects: [] };
}

function emptyTrust(): ProjectTrustStore {
  return { schemaVersion: 1, decisions: [] };
}

function emptyScans(): ProjectScanStore {
  return { schemaVersion: 1, scans: [] };
}

async function readJson<T>(filePath: string, schema: { parse(value: unknown): T }, fallback: T, message: string): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isEnoent(error)) return fallback;
    throw new ProjectCatalogStoreError(message);
  }
}

async function preserveBackup(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.backup.json`, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") throw new ProjectCatalogStoreError("No se pudo crear el backup del catálogo.");
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await preserveBackup(filePath);
  await atomicWrite(directory, path.basename(filePath), Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export async function loadProjectCatalog(filePath: string): Promise<ProjectCatalogStore> {
  return readJson(filePath, projectCatalogStoreSchema, emptyCatalog(), "El catálogo de proyectos no es válido.");
}

export async function replaceProjectCatalog(filePath: string, projects: readonly ProjectCatalogRecord[]): Promise<void> {
  await writeJson(filePath, projectCatalogStoreSchema.parse({ schemaVersion: 1, projects }));
}

export async function upsertProjectCatalogRecord(filePath: string, record: ProjectCatalogRecord): Promise<ProjectCatalogRecord> {
  const validated = projectCatalogRecordSchema.parse(record);
  const current = await loadProjectCatalog(filePath);
  const duplicate = current.projects.find((candidate) => candidate.id !== validated.id
    && candidate.displayName.normalize("NFKC").trim().toLocaleLowerCase("en-US")
      === validated.displayName.normalize("NFKC").trim().toLocaleLowerCase("en-US"));
  if (duplicate !== undefined) throw new ProjectCatalogStoreError(`Ya existe un proyecto llamado ${duplicate.displayName}.`, "PROJECT_NAME_CONFLICT");
  const index = current.projects.findIndex((candidate) => candidate.id === validated.id);
  const projects = index === -1 ? [...current.projects, validated] : current.projects.with(index, validated);
  await replaceProjectCatalog(filePath, projects);
  return validated;
}

export async function removeProjectCatalogRecord(filePath: string, projectId: string): Promise<void> {
  const current = await loadProjectCatalog(filePath);
  const projects = current.projects.filter((project) => project.id !== projectId);
  if (projects.length === current.projects.length) throw new ProjectCatalogStoreError("Proyecto no encontrado.", "PROJECT_NOT_FOUND");
  await replaceProjectCatalog(filePath, projects);
}

/**
 * Cobertura del último recorrido de topología (ADR-0040). Archivo aparte del
 * catálogo para que un downgrade siga leyendo `project-catalog.json`; una
 * versión anterior simplemente ignora este archivo.
 */
export async function loadProjectScanStore(filePath: string): Promise<ProjectScanStore> {
  return readJson(filePath, projectScanStoreSchema, emptyScans(), "El registro de cobertura de escaneo no es válido.");
}

export async function upsertProjectScanRecord(filePath: string, record: ProjectScanRecord): Promise<ProjectScanRecord> {
  const validated = projectScanRecordSchema.parse(record);
  const current = await loadProjectScanStore(filePath);
  const index = current.scans.findIndex((candidate) => candidate.projectId === validated.projectId);
  const scans = index === -1 ? [...current.scans, validated] : current.scans.with(index, validated);
  await writeJson(filePath, projectScanStoreSchema.parse({ schemaVersion: 1, scans }));
  return validated;
}

export async function removeProjectScanRecord(filePath: string, projectId: string): Promise<void> {
  const current = await loadProjectScanStore(filePath);
  const scans = current.scans.filter((scan) => scan.projectId !== projectId);
  if (scans.length === current.scans.length) return;
  await writeJson(filePath, projectScanStoreSchema.parse({ schemaVersion: 1, scans }));
}

export async function loadProjectTrustStore(filePath: string): Promise<ProjectTrustStore> {
  return readJson(filePath, projectTrustStoreSchema, emptyTrust(), "El almacén de confianza no es válido.");
}

export async function replaceProjectTrust(filePath: string, decisions: readonly ProjectTrustRecord[]): Promise<void> {
  await writeJson(filePath, projectTrustStoreSchema.parse({ schemaVersion: 1, decisions }));
}

/** Identidad local no secreta. Vincula decisiones de confianza a esta instalación. */
export async function loadOrCreateDeviceBinding(filePath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { deviceBinding?: unknown };
    const value = parsed.deviceBinding;
    if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
    throw new ProjectCatalogStoreError("La identidad local de confianza no es válida.", "DEVICE_BINDING_INVALID");
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const value = randomBytes(32).toString("hex");
  await writeJson(filePath, { deviceBinding: value });
  const stored = JSON.parse(await readFile(filePath, "utf8")) as { deviceBinding?: unknown };
  if (stored.deviceBinding !== value) throw new ProjectCatalogStoreError("No se pudo crear la identidad local.");
  return value;
}

export async function setProjectTrust(
  filePath: string,
  input: { projectId: string; mode: ProjectTrustMode; deviceBinding: string; networkPolicy?: ProjectTrustRecord["networkPolicy"] },
): Promise<ProjectTrustRecord> {
  const decision = projectTrustRecordSchema.parse({
    projectId: input.projectId,
    mode: input.mode,
    deviceBinding: input.deviceBinding,
    status: "active",
    networkPolicy: input.networkPolicy ?? (input.mode === "project-agent" ? "declared" : input.mode === "full-host" ? "user-session" : "closed"),
    acceptedRiskVersion: input.mode === "full-host" ? "1.0.0" : null,
    reviewedAt: new Date().toISOString(),
  });
  const current = await loadProjectTrustStore(filePath);
  const index = current.decisions.findIndex((candidate) => candidate.projectId === decision.projectId);
  const decisions = index === -1 ? [...current.decisions, decision] : current.decisions.with(index, decision);
  await writeJson(filePath, projectTrustStoreSchema.parse({ schemaVersion: 1, decisions }));
  return decision;
}

export async function revokeProjectTrust(filePath: string, projectId: string): Promise<ProjectTrustRecord> {
  const current = await loadProjectTrustStore(filePath);
  const decision = current.decisions.find((candidate) => candidate.projectId === projectId);
  if (decision === undefined) throw new ProjectCatalogStoreError("Decisión de confianza no encontrada.", "PROJECT_TRUST_NOT_FOUND");
  const revoked = projectTrustRecordSchema.parse({ ...decision, status: "revoked", reviewedAt: new Date().toISOString() });
  await writeJson(filePath, projectTrustStoreSchema.parse({
    schemaVersion: 1,
    decisions: current.decisions.map((candidate) => candidate.projectId === projectId ? revoked : candidate),
  }));
  return revoked;
}

export function migrateDevelopmentProjectsToCatalog(
  projects: readonly DevelopmentProject[],
  registry: WorkspaceRegistry,
): ProjectCatalogRecord[] {
  return projects.flatMap((project) => {
    const workspaces = project.workspaceIds.flatMap((id) => {
      const workspace = registry.workspaces.find((candidate) => candidate.id === id);
      return workspace === undefined ? [] : [workspace];
    });
    if (workspaces.length === 0) return [];
    const selectedRoot = workspaces[0]!.rootPath;
    const now = project.updatedAt;
    const refs: ProjectCatalogRecord["compatibilityRefs"] = [
      { kind: "development-project", id: project.id },
      ...project.workspaceIds.map((id) => ({ kind: "workspace" as const, id })),
      ...(project.applicationId === undefined ? [] : [{ kind: "application" as const, id: project.applicationId }]),
    ];
    const nodes: ProjectCatalogRecord["nodes"] = workspaces.map((workspace) => ({
      id: `node_${sha256(`${project.id}:${workspace.id}`).slice(0, 24)}`,
      kind: "folder",
      name: workspace.name,
      relativePath: workspace.rootPath.toLocaleLowerCase("en-US") === selectedRoot.toLocaleLowerCase("en-US") ? "." : ".",
      workspaceId: workspace.id,
      source: "legacy",
      state: workspace.enabled ? "ready" : "unavailable",
    }));
    return [projectCatalogRecordSchema.parse({
      id: project.id,
      displayName: project.name,
      description: project.description,
      selectedRoot,
      state: workspaces.length === 1 && workspaces.length === project.workspaceIds.length ? "ready" : "review",
      topology: workspaces.length > 1 ? "multi-repo" : "files",
      nodes,
      derivedScopes: [{ relativePath: ".", source: "legacy", status: "active" }],
      compatibilityRefs: refs,
      scanFingerprint: sha256(JSON.stringify({ projectId: project.id, workspaceIds: project.workspaceIds, applicationId: project.applicationId ?? null })),
      createdAt: project.createdAt,
      updatedAt: now,
    })];
  });
}

export function buildEmptyProjectCatalogRecord(input: { displayName: string; description?: string; selectedRoot: string }): ProjectCatalogRecord {
  const now = new Date().toISOString();
  return projectCatalogRecordSchema.parse({
    id: `project_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    displayName: input.displayName,
    description: input.description ?? "",
    selectedRoot: input.selectedRoot,
    state: "ready",
    topology: "empty",
    nodes: [],
    derivedScopes: [{ relativePath: ".", source: "root", status: "active" }],
    compatibilityRefs: [],
    scanFingerprint: sha256("empty"),
    createdAt: now,
    updatedAt: now,
  });
}
