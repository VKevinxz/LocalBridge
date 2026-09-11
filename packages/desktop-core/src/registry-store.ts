/** Registro local versionado para la UI de escritorio (ADR-0015/ADR-0032). */

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent } from "@localbridge/shared";
import {
  applicationNameKey,
  localApplicationSchema,
  parseWorkspaceRegistry,
  registryFileSchema,
  workspaceSchema,
  withWorkspaceAuthorityLock,
  type AuthorizedWorkspace,
  type BrowserProfile,
  type LocalApplication,
  type LargeArtifactPolicy,
  type ProcessProfile,
  type WorkspacePermissions,
  type WorkspaceRegistry,
} from "@localbridge/workspace";

export class RegistryStoreError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = "RegistryStoreError";
  }
}

interface ReadRegistryResult {
  readonly registry: WorkspaceRegistry;
  readonly legacyRaw?: string | undefined;
}

function emptyRegistry(): WorkspaceRegistry {
  return { schemaVersion: 5, workspaces: [], applications: [] };
}

async function readRegistry(configPath: string): Promise<ReadRegistryResult> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { registry: emptyRegistry() };
    throw new RegistryStoreError(`No se pudo leer ${configPath}`, String(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryStoreError(`${configPath} no es JSON válido`, String(error));
  }
  try {
    const current = registryFileSchema.safeParse(parsed);
    return { registry: current.success ? current.data : parseWorkspaceRegistry(parsed), ...(current.success ? {} : { legacyRaw: raw }) };
  } catch (error) {
    throw new RegistryStoreError(`${configPath} no cumple el esquema del registro`, String(error));
  }
}

async function preserveLegacyBackup(configPath: string, raw: string | undefined): Promise<void> {
  if (raw === undefined) return;
  const backupPath = `${configPath}.pre-v5-backup.json`;
  try {
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw new RegistryStoreError("No se pudo crear el backup previo a la migración", String(error));
  }
}

async function writeRegistry(configPath: string, registry: WorkspaceRegistry, legacyRaw?: string): Promise<void> {
  const validated = registryFileSchema.parse(registry);
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  await preserveLegacyBackup(configPath, legacyRaw);
  await atomicWrite(dir, path.basename(configPath), Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8"));
}

export async function loadRegistryDocument(configPath: string): Promise<WorkspaceRegistry> {
  return (await readRegistry(configPath)).registry;
}

/** Migra formatos anteriores en disco con backup exclusivo; es idempotente para v5. */
export async function migrateRegistryFile(configPath: string): Promise<WorkspaceRegistry> {
  return withWorkspaceAuthorityLock(configPath, async () => {
    const current = await readRegistry(configPath);
    if (current.legacyRaw !== undefined) await writeRegistry(configPath, current.registry, current.legacyRaw);
    return current.registry;
  });
}

export async function listWorkspaces(configPath: string): Promise<AuthorizedWorkspace[]> {
  return [...(await loadRegistryDocument(configPath)).workspaces];
}

export async function listApplications(configPath: string): Promise<LocalApplication[]> {
  return [...(await loadRegistryDocument(configPath)).applications];
}

export interface NewWorkspaceInput {
  readonly name: string;
  readonly rootPath: string;
  readonly permissions: WorkspacePermissions;
  readonly maxFileBytes?: number;
  readonly largeArtifacts?: LargeArtifactPolicy;
  readonly validationProfiles?: Readonly<Record<string, readonly string[]>>;
  readonly processProfiles?: Readonly<Record<string, ProcessProfile>>;
  readonly browserProfiles?: Readonly<Record<string, BrowserProfile>>;
  readonly automationReviewRequired?: boolean;
}

export interface NewApplicationInput {
  readonly name: string;
  readonly description?: string;
  readonly primaryServiceAlias: string;
  readonly services: readonly Omit<LocalApplication["services"][number], "id" | "startupOrder">[];
  readonly viewport?: LocalApplication["viewport"];
  readonly reviewState?: LocalApplication["reviewState"];
}

export function buildNewWorkspace(input: NewWorkspaceInput): AuthorizedWorkspace {
  const workspace = workspaceSchema.parse({
    id: `ws_${randomUUID().slice(0, 8)}`,
    name: input.name,
    rootPath: input.rootPath,
    enabled: true,
    createdAt: new Date().toISOString(),
    permissions: input.permissions,
    validationProfiles: input.validationProfiles ?? {},
    processProfiles: input.processProfiles ?? {},
    browserProfiles: input.browserProfiles ?? {},
    automationReviewRequired: input.automationReviewRequired ?? false,
    ...(input.largeArtifacts === undefined ? {} : {
      limits: { maxFileBytes: input.maxFileBytes ?? 1_048_576, maxTreeEntries: 300, maxTreeDepth: 3, largeArtifacts: input.largeArtifacts },
    }),
  });
  return input.maxFileBytes === undefined || input.largeArtifacts !== undefined ? workspace : workspaceSchema.parse({
    ...workspace,
    limits: { ...workspace.limits, maxFileBytes: input.maxFileBytes },
  });
}

export function buildNewApplication(input: NewApplicationInput): LocalApplication {
  const now = new Date().toISOString();
  const services = input.services.map((service, startupOrder) => ({
    ...service,
    id: `service_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    startupOrder,
  }));
  const primary = services.find((service) => applicationNameKey(service.alias) === applicationNameKey(input.primaryServiceAlias));
  if (primary === undefined) throw new RegistryStoreError("El servicio principal no forma parte de la aplicación.");
  return localApplicationSchema.parse({
    id: `app_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    name: input.name,
    description: input.description ?? "",
    primaryServiceId: primary.id,
    services,
    viewport: input.viewport ?? { width: 1920, height: 1080 },
    reviewState: input.reviewState ?? "needs-review",
    createdAt: now,
    updatedAt: now,
  });
}

function profileChanged(previous: AuthorizedWorkspace | undefined, next: AuthorizedWorkspace, service: LocalApplication["services"][number]): boolean {
  if (service.workspaceId !== next.id) return false;
  const before = previous?.processProfiles?.[service.processProfile];
  const after = next.processProfiles?.[service.processProfile];
  return JSON.stringify(before) !== JSON.stringify(after) || next.permissions.processes !== true || next.permissions.browserRead !== true;
}

function reconcileForWorkspaceUpdate(
  applications: readonly LocalApplication[],
  previous: AuthorizedWorkspace | undefined,
  next: AuthorizedWorkspace,
): LocalApplication[] {
  const now = new Date().toISOString();
  return applications.map((application) => {
    if (application.reviewState === "conflict" || !application.services.some((service) => profileChanged(previous, next, service))) return application;
    return { ...application, reviewState: "needs-review", updatedAt: now };
  });
}

export async function upsertWorkspace(configPath: string, workspace: AuthorizedWorkspace): Promise<void> {
  await withWorkspaceAuthorityLock(configPath, async () => {
    const validated = workspaceSchema.parse(workspace);
    const current = await readRegistry(configPath);
    const existingIndex = current.registry.workspaces.findIndex((entry) => entry.id === validated.id);
    const previous = existingIndex === -1 ? undefined : current.registry.workspaces[existingIndex];
    const workspaces = existingIndex === -1
      ? [...current.registry.workspaces, validated]
      : current.registry.workspaces.with(existingIndex, validated);
    const applications = reconcileForWorkspaceUpdate(current.registry.applications, previous, validated);
    await writeRegistry(configPath, { schemaVersion: 5, workspaces, applications }, current.legacyRaw);
  });
}

export async function removeWorkspace(configPath: string, workspaceId: string): Promise<void> {
  await withWorkspaceAuthorityLock(configPath, async () => {
    const current = await readRegistry(configPath);
    const workspaces = current.registry.workspaces.filter((workspace) => workspace.id !== workspaceId);
    if (workspaces.length === current.registry.workspaces.length) throw new RegistryStoreError(`Workspace no encontrado: ${workspaceId}`);
    const now = new Date().toISOString();
    const applications = current.registry.applications.map((application) =>
      application.services.some((service) => service.workspaceId === workspaceId)
        ? { ...application, reviewState: "needs-review" as const, updatedAt: now }
        : application,
    );
    await writeRegistry(configPath, { schemaVersion: 5, workspaces, applications }, current.legacyRaw);
  });
}

export async function replaceWorkspaces(configPath: string, workspaces: readonly AuthorizedWorkspace[]): Promise<void> {
  await withWorkspaceAuthorityLock(configPath, async () => {
    const current = await readRegistry(configPath);
    await writeRegistry(configPath, {
      schemaVersion: 5,
      workspaces: workspaces.map((workspace) => workspaceSchema.parse(workspace)),
      applications: current.registry.applications,
    }, current.legacyRaw);
  });
}

export async function replaceRegistry(configPath: string, registry: WorkspaceRegistry): Promise<void> {
  await withWorkspaceAuthorityLock(configPath, async () => {
    const current = await readRegistry(configPath);
    await writeRegistry(configPath, registry, current.legacyRaw);
  });
}

export interface RegistryEntryRemovalResult {
  readonly workspaceIds: readonly string[];
  readonly applicationIds: readonly string[];
}

/**
 * Retira entradas concretas sobre la revisión más reciente del registro. A diferencia de
 * `replaceRegistry`, no puede sobrescribir altas concurrentes con un snapshot anterior.
 */
export async function removeRegistryEntriesIfPresent(
  configPath: string,
  input: { readonly workspaceIds: readonly string[]; readonly applicationIds: readonly string[] },
): Promise<RegistryEntryRemovalResult> {
  return withWorkspaceAuthorityLock(configPath, async () => {
    const current = await readRegistry(configPath);
    const requestedWorkspaces = new Set(input.workspaceIds);
    const requestedApplications = new Set(input.applicationIds);
    const applicationIds = current.registry.applications
      .filter((application) => requestedApplications.has(application.id))
      .map((application) => application.id);
    const retainedApplications = current.registry.applications
      .filter((application) => !requestedApplications.has(application.id));
    const retainedApplicationWorkspaces = new Set(retainedApplications
      .flatMap((application) => application.services.map((service) => service.workspaceId)));
    const workspaceIds = current.registry.workspaces
      .filter((workspace) => requestedWorkspaces.has(workspace.id) && !retainedApplicationWorkspaces.has(workspace.id))
      .map((workspace) => workspace.id);
    const removableWorkspaces = new Set(workspaceIds);
    if (workspaceIds.length > 0 || applicationIds.length > 0) {
      await writeRegistry(configPath, {
        ...current.registry,
        workspaces: current.registry.workspaces.filter((workspace) => !removableWorkspaces.has(workspace.id)),
        applications: retainedApplications,
      }, current.legacyRaw);
    }
    return { workspaceIds, applicationIds };
  });
}

export async function upsertApplication(configPath: string, application: LocalApplication): Promise<LocalApplication> {
  return withWorkspaceAuthorityLock(configPath, async () => {
    const validated = localApplicationSchema.parse(application);
    const current = await readRegistry(configPath);
    const duplicate = current.registry.applications.find((candidate) =>
      candidate.id !== validated.id && applicationNameKey(candidate.name) === applicationNameKey(validated.name));
    if (duplicate !== undefined) throw new RegistryStoreError(`Ya existe una aplicación llamada ${duplicate.name}.`);
    const index = current.registry.applications.findIndex((candidate) => candidate.id === validated.id);
    const applications = index === -1
      ? [...current.registry.applications, validated]
      : current.registry.applications.with(index, validated);
    await writeRegistry(configPath, { ...current.registry, applications }, current.legacyRaw);
    return validated;
  });
}

export async function removeApplication(configPath: string, applicationId: string): Promise<void> {
  await withWorkspaceAuthorityLock(configPath, async () => {
    const current = await readRegistry(configPath);
    const applications = current.registry.applications.filter((application) => application.id !== applicationId);
    if (applications.length === current.registry.applications.length) throw new RegistryStoreError("Aplicación no encontrada.");
    await writeRegistry(configPath, { ...current.registry, applications }, current.legacyRaw);
  });
}
