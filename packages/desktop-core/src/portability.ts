import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createExclusiveFile } from "@localbridge/filesystem";
import {
  applicationNameKey,
  developmentProjectNameKey,
  developmentProjectSchema,
  localApplicationSchema,
  parseWorkspaceRegistry,
  registryFileSchema,
  workspaceSchema,
  type AuthorizedWorkspace,
  type DevelopmentProject,
  type LocalApplication,
  type WorkspaceRegistry,
} from "@localbridge/workspace";
import {
  activeConnectionProfile,
  connectionProfileSchema,
  desktopSettingsSchema,
  type ConnectionProfile,
  type DesktopSettings,
} from "./app-settings.js";

const portableRefSchema = z.string().regex(/^portable_[a-f0-9]{16}$/);
const portableApplicationRefSchema = z.string().regex(/^portable_app_[a-f0-9]{16}$/);
const portableProjectRefSchema = z.string().regex(/^portable_project_[a-f0-9]{16}$/);
const profileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const portableWorkspaceBaseSchema = z.object(workspaceSchema.shape)
  .omit({ id: true, rootPath: true, createdAt: true })
  .extend({ ref: portableRefSchema });

const legacyPortablePermissionsSchema = z.object({
  read: z.boolean(), write: z.boolean(), overwrite: z.boolean(), gitRead: z.boolean(), validations: z.boolean(),
  gitWrite: z.boolean().default(false), processes: z.boolean().default(false), browserRead: z.boolean().default(false),
  browserInteract: z.boolean().default(false), browserAuthenticate: z.boolean().default(false),
  browserManualControl: z.boolean().default(false),
}).strict();

const portableLegacyWorkspaceBaseSchema = portableWorkspaceBaseSchema.extend({ permissions: legacyPortablePermissionsSchema });

const portableWorkspaceV1Schema = portableLegacyWorkspaceBaseSchema
  .extend({ browserApplications: z.record(z.string(), z.never()).optional() })
  .strict();

const portableLegacyApplicationSchema = z.object({
  primaryService: profileNameSchema,
  services: z.record(profileNameSchema, z.object({
    workspaceRef: portableRefSchema,
    processProfile: profileNameSchema,
    startupOrder: z.number().int().min(0).max(100),
    hostMode: z.enum(["manual-localhost", "listener-literal"]),
    allowManagedWildcard: z.boolean(),
  }).strict()),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict(),
}).strict();

const portableWorkspaceV2Schema = portableLegacyWorkspaceBaseSchema
  .extend({ browserApplications: z.record(profileNameSchema, portableLegacyApplicationSchema).default({}) })
  .strict();

const portableWorkspaceV3Schema = portableLegacyWorkspaceBaseSchema.strict();
const portableWorkspaceV4Schema = portableWorkspaceBaseSchema.strict();

const portableApplicationV3Schema = z.object({
  ref: portableApplicationRefSchema,
  name: localApplicationSchema.shape.name,
  description: localApplicationSchema.shape.description,
  primaryServiceAlias: profileNameSchema,
  services: z.array(z.object({
    alias: profileNameSchema,
    workspaceRef: portableRefSchema,
    processProfile: profileNameSchema,
    startupOrder: z.number().int().min(0).max(7),
    hostMode: z.enum(["manual-localhost", "listener-literal"]),
    allowManagedWildcard: z.boolean(),
  }).strict()).min(1).max(8),
  viewport: localApplicationSchema.shape.viewport,
}).strict();

const portableConnectionSchema = connectionProfileSchema.omit({ id: true }).strict();
const portableHeader = {
  format: z.literal("localbridge-portable"),
  exportedAt: z.iso.datetime(),
  connections: z.array(portableConnectionSchema).min(1).max(20),
};

const portableConfigV1Schema = z.object({
  ...portableHeader,
  version: z.literal(1),
  workspaces: z.array(portableWorkspaceV1Schema).max(200),
}).strict();

const portableConfigV2Schema = z.object({
  ...portableHeader,
  version: z.literal(2),
  workspaces: z.array(portableWorkspaceV2Schema).max(200),
}).strict();

const portableConfigV3Schema = z.object({
  ...portableHeader,
  version: z.literal(3),
  workspaces: z.array(portableWorkspaceV3Schema).max(200),
  applications: z.array(portableApplicationV3Schema).max(200),
}).strict();

const portableConfigV4Schema = z.object({
  ...portableHeader,
  version: z.literal(4),
  workspaces: z.array(portableWorkspaceV4Schema).max(200),
  applications: z.array(portableApplicationV3Schema).max(200),
}).strict();

const portableProjectV5Schema = z.object({
  ref: portableProjectRefSchema,
  name: developmentProjectSchema.shape.name,
  description: developmentProjectSchema.shape.description,
  workspaceRefs: z.array(portableRefSchema).min(1).max(16),
  applicationRef: portableApplicationRefSchema.optional(),
}).strict();

const portableConfigV5Schema = z.object({
  ...portableHeader,
  version: z.literal(5),
  workspaces: z.array(portableWorkspaceV4Schema).max(200),
  applications: z.array(portableApplicationV3Schema).max(200),
  projects: z.array(portableProjectV5Schema).max(500),
}).strict();

export const portableConfigSchema = z.discriminatedUnion("version", [portableConfigV1Schema, portableConfigV2Schema, portableConfigV3Schema, portableConfigV4Schema, portableConfigV5Schema]);
export type PortableConfig = z.infer<typeof portableConfigSchema>;

export interface PortableImportResult {
  readonly settings: DesktopSettings;
  readonly registry: WorkspaceRegistry;
  readonly workspaces: readonly AuthorizedWorkspace[];
  readonly applications: readonly LocalApplication[];
  readonly projects: readonly DevelopmentProject[];
  readonly importedProfileIds: readonly string[];
}

function newProfileId(): string {
  return `profile_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function randomLocalId(prefix: "ws" | "app" | "service"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, prefix === "ws" ? 8 : 24)}`;
}

export function buildPortableConfig(
  settings: DesktopSettings,
  registry: WorkspaceRegistry,
  projects?: readonly DevelopmentProject[],
): PortableConfig {
  activeConnectionProfile(settings);
  const refs = new Map(registry.workspaces.map((workspace) => [workspace.id, `portable_${randomUUID().replaceAll("-", "").slice(0, 16)}`]));
  const applicationRefs = new Map(registry.applications.map((application) => [application.id, `portable_app_${randomUUID().replaceAll("-", "").slice(0, 16)}`]));
  const config = {
    format: "localbridge-portable" as const,
    version: projects === undefined ? 4 as const : 5 as const,
    exportedAt: new Date().toISOString(),
    connections: settings.connectionProfiles.map(({ name, tunnelId }) => ({ name, tunnelId })),
    workspaces: registry.workspaces.map(({ id, rootPath: _rootPath, createdAt: _createdAt, ...workspace }) => ({
      ref: refs.get(id),
      ...workspace,
      permissions: {
        ...workspace.permissions,
        processes: false,
        browserRead: false,
        browserInteract: false,
        browserHumanControl: false,
      },
      automationReviewRequired:
        workspace.automationReviewRequired === true ||
        Object.keys(workspace.processProfiles ?? {}).length > 0 ||
        Object.keys(workspace.browserProfiles ?? {}).length > 0,
    })),
    applications: registry.applications.map((application) => {
      const primary = application.services.find((service) => service.id === application.primaryServiceId)!;
      return {
        ref: applicationRefs.get(application.id),
        name: application.name,
        description: application.description,
        primaryServiceAlias: primary.alias,
        services: application.services.map(({ id: _id, workspaceId, ...service }) => {
          const workspaceRef = refs.get(workspaceId);
          if (workspaceRef === undefined) throw new Error(`La aplicación ${application.name} referencia un workspace no exportado.`);
          return { ...service, workspaceRef };
        }),
        viewport: application.viewport,
      };
    }),
    ...(projects === undefined ? {} : {
      projects: projects.map((project) => ({
        ref: `portable_project_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        name: project.name,
        description: project.description,
        workspaceRefs: project.workspaceIds.map((workspaceId) => {
          const ref = refs.get(workspaceId);
          if (ref === undefined) throw new Error(`El proyecto ${project.name} referencia un workspace no exportado.`);
          return ref;
        }),
        ...(project.applicationId === undefined ? {} : {
          applicationRef: (() => {
            const ref = applicationRefs.get(project.applicationId);
            if (ref === undefined) throw new Error(`El proyecto ${project.name} referencia una aplicación no exportada.`);
            return ref;
          })(),
        }),
      })),
    }),
  };
  return portableConfigSchema.parse(config);
}

export async function exportPortableConfigFile(filePath: string, config: PortableConfig): Promise<void> {
  const validated = portableConfigSchema.parse(config);
  await createExclusiveFile(filePath, Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8"));
}

export async function readPortableConfigFile(filePath: string): Promise<PortableConfig> {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("El archivo portable debe ser JSON y medir como máximo 1 MiB.");
  return portableConfigSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

function importedWorkspace(
  workspace: z.infer<typeof portableWorkspaceV1Schema> | z.infer<typeof portableWorkspaceV2Schema> | z.infer<typeof portableWorkspaceV3Schema> | z.infer<typeof portableWorkspaceV4Schema>,
  id: string,
  rootPath: string,
  hasApplications: boolean,
): AuthorizedWorkspace {
  const { ref: _ref, ...portable } = workspace;
  const { browserApplications: _legacy, ...base } = portable as typeof portable & { browserApplications?: unknown };
  const legacyPermissions = base.permissions as typeof base.permissions & { browserAuthenticate?: boolean; browserManualControl?: boolean };
  const { browserAuthenticate: _auth, browserManualControl: _manual, ...permissions } = legacyPermissions;
  return workspaceSchema.parse({
    ...base,
    id,
    rootPath,
    createdAt: new Date().toISOString(),
    permissions: {
      ...permissions,
      processes: false,
      browserRead: false,
      browserInteract: false,
      browserHumanControl: false,
    },
    automationReviewRequired:
      base.automationReviewRequired ||
      Object.keys(base.processProfiles ?? {}).length > 0 ||
      Object.keys(base.browserProfiles ?? {}).length > 0 ||
      hasApplications,
  });
}

export function applyPortableConfig(
  configInput: PortableConfig,
  mappings: Readonly<Record<string, string>>,
  currentSettings: DesktopSettings,
  currentRegistry: WorkspaceRegistry,
  currentProjects: readonly DevelopmentProject[] = [],
): PortableImportResult {
  const config = portableConfigSchema.parse(configInput);
  const expectedRefs = new Set(config.workspaces.map((workspace) => workspace.ref));
  if (Object.keys(mappings).some((ref) => !expectedRefs.has(ref))) throw new Error("El remapeo contiene una referencia desconocida.");
  for (const ref of expectedRefs) {
    if (mappings[ref] === undefined) throw new Error(`Falta elegir una carpeta para ${ref}.`);
    if (!path.isAbsolute(mappings[ref])) throw new Error(`La carpeta remapeada para ${ref} debe ser absoluta.`);
  }

  const importedProfiles: ConnectionProfile[] = config.connections.map((profile) => ({ id: newProfileId(), ...profile }));
  const newWorkspaceIds = new Map(config.workspaces.map((workspace) => [workspace.ref, randomLocalId("ws")]));
  const hasApplications = config.version === 3 || config.version === 4 || config.version === 5
    ? new Set(config.applications.flatMap((application) => application.services.map((service) => service.workspaceRef)))
    : new Set(config.workspaces.filter((workspace) => Object.keys(workspace.browserApplications ?? {}).length > 0).map((workspace) => workspace.ref));
  const importedWorkspaces = config.workspaces.map((workspace) => importedWorkspace(
    workspace,
    newWorkspaceIds.get(workspace.ref)!,
    mappings[workspace.ref]!,
    hasApplications.has(workspace.ref),
  ));

  let importedApplications: LocalApplication[] = [];
  const newApplicationIds = new Map<string, string>();
  if (config.version === 3 || config.version === 4 || config.version === 5) {
    importedApplications = config.applications.map((application) => {
      const services = application.services.map((service) => ({
        id: randomLocalId("service"),
        alias: service.alias,
        workspaceId: newWorkspaceIds.get(service.workspaceRef)!,
        processProfile: service.processProfile,
        startupOrder: service.startupOrder,
        hostMode: service.hostMode,
        allowManagedWildcard: false,
      }));
      const primary = services.find((service) => applicationNameKey(service.alias) === applicationNameKey(application.primaryServiceAlias))!;
      const now = new Date().toISOString();
      const applicationId = randomLocalId("app");
      newApplicationIds.set(application.ref, applicationId);
      return localApplicationSchema.parse({
        id: applicationId,
        name: application.name,
        description: application.description,
        primaryServiceId: primary.id,
        services,
        viewport: application.viewport,
        reviewState: "needs-review",
        createdAt: now,
        updatedAt: now,
      });
    });
  } else if (config.version === 2) {
    const legacyWorkspaces = config.workspaces.map((workspace) => ({
      ...importedWorkspace(workspace, newWorkspaceIds.get(workspace.ref)!, mappings[workspace.ref]!, true),
      browserApplications: Object.fromEntries(Object.entries(workspace.browserApplications).map(([name, application]) => [name, {
        ...application,
        services: Object.fromEntries(Object.entries(application.services).map(([alias, service]) => {
          const { workspaceRef, ...rest } = service;
          return [alias, {
            ...rest,
            workspaceId: newWorkspaceIds.get(workspaceRef),
            allowManagedWildcard: false,
          }];
        })),
      }])),
    }));
    importedApplications = [...parseWorkspaceRegistry({ workspaces: legacyWorkspaces }).applications].map((application) => ({
      ...application,
      reviewState: application.reviewState === "conflict" ? "conflict" : "needs-review",
    }));
  }

  const existingNames = new Set(currentRegistry.applications.map((application) => applicationNameKey(application.name)));
  const duplicate = importedApplications.find((application) => existingNames.has(applicationNameKey(application.name)));
  if (duplicate !== undefined) throw new Error(`Ya existe una aplicación llamada ${duplicate.name}; resuelve el nombre antes de importar.`);

  const importedProjects: DevelopmentProject[] = config.version === 5
    ? config.projects.map((project) => {
      const workspaceIds = project.workspaceRefs.map((ref) => newWorkspaceIds.get(ref));
      if (workspaceIds.some((id) => id === undefined)) throw new Error(`El proyecto ${project.name} referencia una carpeta no incluida.`);
      const resolvedWorkspaceIds = workspaceIds as string[];
      const applicationId = project.applicationRef === undefined ? undefined : newApplicationIds.get(project.applicationRef);
      if (project.applicationRef !== undefined && applicationId === undefined) throw new Error(`El proyecto ${project.name} referencia una aplicación no incluida.`);
      return developmentProjectSchema.parse({
        id: `project_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        name: project.name,
        description: project.description,
        workspaceIds: resolvedWorkspaceIds,
        ...(applicationId === undefined ? {} : { applicationId }),
        setupStatus: "review-required",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    })
    : [];
  const existingProjectNames = new Set(currentProjects.map((project) => developmentProjectNameKey(project.name)));
  const duplicateProject = importedProjects.find((project) => existingProjectNames.has(developmentProjectNameKey(project.name)));
  if (duplicateProject !== undefined) throw new Error(`Ya existe un proyecto llamado ${duplicateProject.name}; resuelve el nombre antes de importar.`);
  const importedProjectNames = new Set<string>();
  const duplicateImportedProject = importedProjects.find((project) => {
    const key = developmentProjectNameKey(project.name);
    if (importedProjectNames.has(key)) return true;
    importedProjectNames.add(key);
    return false;
  });
  if (duplicateImportedProject !== undefined) throw new Error(`La importación contiene más de un proyecto llamado ${duplicateImportedProject.name}.`);

  const registry = registryFileSchema.parse({
    schemaVersion: 4,
    workspaces: [...currentRegistry.workspaces, ...importedWorkspaces],
    applications: [...currentRegistry.applications, ...importedApplications],
  });
  const settings = desktopSettingsSchema.parse({
    ...currentSettings,
    connectionProfiles: [...currentSettings.connectionProfiles, ...importedProfiles],
  });
  return {
    settings,
    registry,
    workspaces: registry.workspaces,
    applications: registry.applications,
    projects: importedProjects,
    importedProfileIds: importedProfiles.map((profile) => profile.id),
  };
}
