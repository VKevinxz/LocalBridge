import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent } from "@localbridge/shared";
import {
  developmentProjectNameKey,
  developmentProjectSchema,
  developmentProjectStoreSchema,
  type DevelopmentProject,
  type DevelopmentProjectStore,
  type WorkspaceRegistry,
} from "@localbridge/workspace";

export class DevelopmentProjectStoreError extends Error {
  constructor(message: string, readonly code = "PROJECT_STORE_INVALID") {
    super(message);
    this.name = "DevelopmentProjectStoreError";
  }
}

export interface NewDevelopmentProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly workspaceIds: readonly string[];
  readonly applicationId?: string | undefined;
  readonly setupStatus?: DevelopmentProject["setupStatus"] | undefined;
}

function emptyStore(): DevelopmentProjectStore {
  return { schemaVersion: 1, projects: [] };
}

async function readStore(filePath: string): Promise<DevelopmentProjectStore> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return emptyStore();
    throw new DevelopmentProjectStoreError("No se pudo leer el almacén de proyectos.");
  }
  try {
    return developmentProjectStoreSchema.parse(JSON.parse(raw));
  } catch {
    throw new DevelopmentProjectStoreError("El almacén de proyectos no es válido.");
  }
}

async function preserveBackup(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.backup.json`, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") {
      throw new DevelopmentProjectStoreError("No se pudo crear el backup del almacén de proyectos.");
    }
  }
}

async function writeStore(filePath: string, store: DevelopmentProjectStore): Promise<void> {
  const validated = developmentProjectStoreSchema.parse(store);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await preserveBackup(filePath);
  await atomicWrite(directory, path.basename(filePath), Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8"));
}

function referenceProblem(project: DevelopmentProject, registry: WorkspaceRegistry): string | undefined {
  const workspaceIds = new Set(registry.workspaces.map((workspace) => workspace.id));
  const missingWorkspace = project.workspaceIds.find((workspaceId) => !workspaceIds.has(workspaceId));
  if (missingWorkspace !== undefined) return "PROJECT_WORKSPACE_MISSING";
  if (project.applicationId === undefined) return undefined;
  const application = registry.applications.find((candidate) => candidate.id === project.applicationId);
  if (application === undefined) return "PROJECT_APPLICATION_MISSING";
  const members = new Set(project.workspaceIds);
  if (application.services.some((service) => !members.has(service.workspaceId))) return "PROJECT_APPLICATION_MISMATCH";
  if (project.setupStatus === "ready" && application.reviewState !== "reviewed") return "PROJECT_REVIEW_REQUIRED";
  return undefined;
}

function reconcileProject(project: DevelopmentProject, registry: WorkspaceRegistry): DevelopmentProject {
  return referenceProblem(project, registry) === undefined || project.setupStatus === "interrupted"
    ? project
    : { ...project, setupStatus: "interrupted" };
}

export function buildNewDevelopmentProject(input: NewDevelopmentProjectInput): DevelopmentProject {
  const now = new Date().toISOString();
  return developmentProjectSchema.parse({
    id: `project_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    name: input.name,
    description: input.description ?? "",
    workspaceIds: input.workspaceIds,
    ...(input.applicationId === undefined ? {} : { applicationId: input.applicationId }),
    setupStatus: input.setupStatus ?? "draft",
    createdAt: now,
    updatedAt: now,
  });
}

export async function loadDevelopmentProjectStore(
  filePath: string,
  registry: WorkspaceRegistry,
): Promise<DevelopmentProjectStore> {
  const store = await readStore(filePath);
  return developmentProjectStoreSchema.parse({
    ...store,
    projects: store.projects.map((project) => reconcileProject(project, registry)),
  });
}

export async function listDevelopmentProjects(
  filePath: string,
  registry: WorkspaceRegistry,
): Promise<DevelopmentProject[]> {
  return [...(await loadDevelopmentProjectStore(filePath, registry)).projects];
}

export async function upsertDevelopmentProject(
  filePath: string,
  registry: WorkspaceRegistry,
  project: DevelopmentProject,
): Promise<DevelopmentProject> {
  const validated = developmentProjectSchema.parse(project);
  const problem = referenceProblem(validated, registry);
  if (problem !== undefined) throw new DevelopmentProjectStoreError("El proyecto necesita revisión local.", problem);
  const current = await readStore(filePath);
  const duplicate = current.projects.find((candidate) =>
    candidate.id !== validated.id && developmentProjectNameKey(candidate.name) === developmentProjectNameKey(validated.name));
  if (duplicate !== undefined) throw new DevelopmentProjectStoreError(`Ya existe un proyecto llamado ${duplicate.name}.`, "PROJECT_NAME_CONFLICT");
  const index = current.projects.findIndex((candidate) => candidate.id === validated.id);
  const projects = index === -1 ? [...current.projects, validated] : current.projects.with(index, validated);
  await writeStore(filePath, { schemaVersion: 1, projects });
  return validated;
}

export async function removeDevelopmentProject(filePath: string, projectId: string): Promise<void> {
  const current = await readStore(filePath);
  const projects = current.projects.filter((project) => project.id !== projectId);
  if (projects.length === current.projects.length) throw new DevelopmentProjectStoreError("Proyecto no encontrado.", "PROJECT_NOT_FOUND");
  await writeStore(filePath, { schemaVersion: 1, projects });
}

export async function removeDevelopmentProjectIfPresent(filePath: string, projectId: string): Promise<boolean> {
  const current = await readStore(filePath);
  const projects = current.projects.filter((project) => project.id !== projectId);
  if (projects.length === current.projects.length) return false;
  await writeStore(filePath, { schemaVersion: 1, projects });
  return true;
}

export async function replaceDevelopmentProjects(
  filePath: string,
  projects: readonly DevelopmentProject[],
): Promise<void> {
  await writeStore(filePath, { schemaVersion: 1, projects: [...projects] });
}
