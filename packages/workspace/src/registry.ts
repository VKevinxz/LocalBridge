/**
 * Registro de workspaces autorizados (ADR-0003, ADR-0012).
 *
 * Deliberadamente sin caché: cada llamada relee el fichero. Es lo que hace que
 * `SEC-025` (deshabilitar un workspace en runtime) funcione sin ningún mecanismo
 * de invalidación — ver ADR-0012.
 *
 * Esta es la única puerta de entrada al filesystem para el resto del sistema:
 * ninguna tool ni ningún otro paquete debe leer `workspaces.json` por su cuenta.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { isEnoent, nodeErrorCode, type Logger } from "@localbridge/shared";

import type {
  AuthorizedWorkspace,
  BrowserApplicationProfile,
  LocalApplication,
  WorkspaceRegistry,
} from "./types.js";

/**
 * Denylist por defecto (SECURITY.md §5). Se aplica cuando un workspace no define
 * la suya propia; un workspace puede sustituirla, nunca desactivarla del todo
 * omitiendo el campo — omitir es "usa el valor seguro", no "sin filtro".
 */
export const DEFAULT_DENY_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  ".npmrc",
  ".netrc",
  ".git/config",
];

const DEFAULT_LIMITS = {
  maxFileBytes: 1_048_576,
  maxTreeEntries: 300,
  maxTreeDepth: 3,
  largeArtifacts: {
    mode: "standard",
    reserve: {
      minimumFreeBytes: 1024 * 1024 * 1024,
      minimumFreePercent: 10,
    },
    maxConcurrentJobs: 1,
  },
} as const;

export const largeArtifactPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("standard"),
    reserve: z.object({
      minimumFreeBytes: z.number().int().min(64 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER),
      minimumFreePercent: z.number().min(1).max(50),
    }).strict(),
    maxConcurrentJobs: z.union([z.literal(1), z.literal(2)]),
  }).strict(),
  z.object({
    mode: z.literal("custom"),
    customSourceBytes: z.number().int().min(1024 * 1024).max(Number.MAX_SAFE_INTEGER),
    reserve: z.object({
      minimumFreeBytes: z.number().int().min(64 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER),
      minimumFreePercent: z.number().min(1).max(50),
    }).strict(),
    maxConcurrentJobs: z.union([z.literal(1), z.literal(2)]),
  }).strict(),
  z.object({
    mode: z.literal("adaptive"),
    reserve: z.object({
      minimumFreeBytes: z.number().int().min(64 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER),
      minimumFreePercent: z.number().min(1).max(50),
    }).strict(),
    maxConcurrentJobs: z.union([z.literal(1), z.literal(2)]),
  }).strict(),
]);

export function defaultLargeArtifactPolicy() {
  return largeArtifactPolicySchema.parse(DEFAULT_LIMITS.largeArtifacts);
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const relativeDirectorySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "la ruta relativa no puede contener NUL")
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value), "la ruta debe ser relativa")
  .refine(
    (value) => value.split(/[\\/]+/).every((segment) => segment !== ".."),
    "la ruta relativa no puede escapar del workspace",
  );

const relativeManifestPathSchema = relativeDirectorySchema.refine(
  (value) => value !== "." && !value.endsWith("/") && !value.endsWith("\\"),
  "se requiere la ruta relativa de un manifiesto",
);

function parseLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return (
      url.protocol === "http:" &&
      loopback &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export const loopbackOriginSchema = z
  .string()
  .max(128)
  .refine(parseLoopbackOrigin, "se requiere un origen HTTP loopback exacto con puerto");

const definitionSha256Schema = z.string().regex(SHA256_PATTERN);

export const processProfileSchema = z
  .object({
    command: z.array(z.string().min(1).max(1024)).min(1).max(32),
    cwd: relativeDirectorySchema.default("."),
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("package-script"),
        manifestPath: relativeManifestPathSchema.refine(
          (value) => value.split(/[\\/]/).at(-1) === "package.json",
          "el manifiesto debe ser package.json",
        ),
        script: z.string().min(1).max(128),
        definitionSha256: definitionSha256Schema,
      }).strict(),
      z.object({
        kind: z.literal("composer-script"),
        manifestPath: relativeManifestPathSchema.refine(
          (value) => value.split(/[\\/]/).at(-1) === "composer.json",
          "el manifiesto debe ser composer.json",
        ),
        script: z.string().min(1).max(128),
        definitionSha256: definitionSha256Schema,
      }).strict(),
      z.object({
        kind: z.literal("make-target"),
        manifestPath: relativeManifestPathSchema.refine(
          (value) => ["Makefile", "makefile", "GNUmakefile"].includes(value.split(/[\\/]/).at(-1) ?? ""),
          "el manifiesto debe ser un Makefile reconocido",
        ),
        target: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(128),
        definitionSha256: definitionSha256Schema,
      }).strict(),
    ]),
    maxRuntimeSeconds: z.number().int().min(10).max(8 * 60 * 60).default(4 * 60 * 60),
  })
  .strict();

export const browserProfileSchema = z
  .object({
    origin: loopbackOriginSchema,
    allowedOrigins: z.array(loopbackOriginSchema).min(1).max(10),
    viewport: z.object({
      width: z.number().int().min(640).max(2560),
      height: z.number().int().min(480).max(1600),
    }).strict().default({ width: 1920, height: 1080 }),
    linkedProcessProfile: z.string().regex(PROFILE_NAME_PATTERN).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (!profile.allowedOrigins.includes(profile.origin)) {
      context.addIssue({ code: "custom", path: ["allowedOrigins"], message: "debe incluir el origen principal" });
    }
  });

const applicationServiceNameSchema = z.string().regex(PROFILE_NAME_PATTERN);
const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const applicationServiceIdSchema = z.string().regex(/^service_[a-f0-9]{16,32}$/);

export const browserApplicationProfileSchema = z
  .object({
    primaryService: applicationServiceNameSchema,
    services: z.record(
      applicationServiceNameSchema,
      z.object({
        workspaceId: z.string().min(1).max(160),
        processProfile: z.string().regex(PROFILE_NAME_PATTERN),
        startupOrder: z.number().int().min(0).max(100).default(0),
        hostMode: z.enum(["manual-localhost", "listener-literal"]).default("manual-localhost"),
        allowManagedWildcard: z.boolean().default(false),
      }).strict(),
    ),
    viewport: z.object({
      width: z.number().int().min(640).max(2560),
      height: z.number().int().min(480).max(1600),
    }).strict().default({ width: 1920, height: 1080 }),
  })
  .strict()
  .superRefine((application, context) => {
    const services = Object.entries(application.services);
    if (services.length < 1 || services.length > 8) {
      context.addIssue({ code: "custom", path: ["services"], message: "se requieren entre 1 y 8 servicios" });
    }
    if (application.services[application.primaryService] === undefined) {
      context.addIssue({ code: "custom", path: ["primaryService"], message: "el servicio principal no existe" });
    }
    for (const [name, service] of services) {
      if (service.hostMode === "listener-literal" && service.allowManagedWildcard) {
        context.addIssue({
          code: "custom",
          path: ["services", name, "allowManagedWildcard"],
          message: "wildcard solo es compatible con manual-localhost",
        });
      }
    }
  });

export const localApplicationServiceSchema = z.object({
  id: applicationServiceIdSchema,
  alias: applicationServiceNameSchema,
  workspaceId: z.string().min(1).max(160),
  processProfile: z.string().regex(PROFILE_NAME_PATTERN),
  startupOrder: z.number().int().min(0).max(7),
  hostMode: z.enum(["manual-localhost", "listener-literal"]).default("manual-localhost"),
  allowManagedWildcard: z.boolean().default(false),
}).strict().superRefine((service, context) => {
  if (service.hostMode === "listener-literal" && service.allowManagedWildcard) {
    context.addIssue({
      code: "custom",
      path: ["allowManagedWildcard"],
      message: "wildcard solo es compatible con manual-localhost",
    });
  }
});

const legacyApplicationCandidateSchema = z.object({
  ownerWorkspaceId: z.string().min(1).max(160),
  profile: browserApplicationProfileSchema,
}).strict();

export function applicationNameKey(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export const localApplicationSchema = z.object({
  id: applicationIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(""),
  primaryServiceId: applicationServiceIdSchema,
  services: z.array(localApplicationServiceSchema).min(1).max(8),
  viewport: z.object({
    width: z.number().int().min(640).max(2560),
    height: z.number().int().min(480).max(1600),
  }).strict().default({ width: 1920, height: 1080 }),
  reviewState: z.enum(["reviewed", "needs-review", "conflict"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  conflictCandidates: z.array(legacyApplicationCandidateSchema).min(2).max(20).optional(),
}).strict().superRefine((application, context) => {
  const ids = new Set(application.services.map((service) => service.id));
  const aliases = new Set(application.services.map((service) => applicationNameKey(service.alias)));
  const orders = application.services.map((service) => service.startupOrder).toSorted((left, right) => left - right);
  if (ids.size !== application.services.length) {
    context.addIssue({ code: "custom", path: ["services"], message: "los IDs de servicio deben ser únicos" });
  }
  if (aliases.size !== application.services.length) {
    context.addIssue({ code: "custom", path: ["services"], message: "los aliases de servicio deben ser únicos" });
  }
  if (!application.services.some((service) => service.id === application.primaryServiceId)) {
    context.addIssue({ code: "custom", path: ["primaryServiceId"], message: "el servicio principal no existe" });
  }
  if (orders.some((order, index) => order !== index)) {
    context.addIssue({ code: "custom", path: ["services"], message: "el orden debe ser continuo desde cero" });
  }
  if (application.reviewState === "conflict" && application.conflictCandidates === undefined) {
    context.addIssue({ code: "custom", path: ["conflictCandidates"], message: "un conflicto debe conservar sus candidatos" });
  }
  if (application.reviewState !== "conflict" && application.conflictCandidates !== undefined) {
    context.addIssue({ code: "custom", path: ["conflictCandidates"], message: "solo los conflictos conservan candidatos" });
  }
});

const workspaceFields = {
  id: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  limits: z
    .object({
      maxFileBytes: z.number().int().positive(),
      maxTreeEntries: z.number().int().positive(),
      maxTreeDepth: z.number().int().positive(),
      largeArtifacts: largeArtifactPolicySchema.default(() => defaultLargeArtifactPolicy()),
    })
    .default(DEFAULT_LIMITS),
  denyPatterns: z.array(z.string()).default(() => [...DEFAULT_DENY_PATTERNS]),
  validationProfiles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
  processProfiles: z.record(z.string().regex(PROFILE_NAME_PATTERN), processProfileSchema).default({}),
  browserProfiles: z.record(z.string().regex(PROFILE_NAME_PATTERN), browserProfileSchema).default({}),
  automationReviewRequired: z.boolean().default(false),
} as const;

const commonPermissionsFields = {
    read: z.boolean(),
    write: z.boolean(),
    overwrite: z.boolean(),
    gitRead: z.boolean(),
    validations: z.boolean(),
    // Opcional con default `false`, a propósito (ADR-0010/ADR-0016): un
    // workspace ya configurado sin este campo no debe fallar el schema
    // entero (que fail-closed vaciaría TODO el registro, ADR-0012) — debe
    // simplemente no tener Git de escritura, que es lo mismo que decir
    // "ausencia = denegado" (ADR-0004).
    gitWrite: z.boolean().default(false),
    processes: z.boolean().default(false),
    browserRead: z.boolean().default(false),
    browserInteract: z.boolean().default(false),
} as const;

const workspacePermissionsSchema = z.object({
    ...commonPermissionsFields,
    browserHumanControl: z.boolean().default(false),
  }).strict();

const legacyV3PermissionsSchema = z.object({
    ...commonPermissionsFields,
    browserAuthenticate: z.boolean().default(false),
    browserManualControl: z.boolean().default(false),
  }).strict();

const workspaceBaseSchema = z.object({ ...workspaceFields, permissions: workspacePermissionsSchema }).strict();
const legacyV3WorkspaceBaseSchema = z.object({ ...workspaceFields, permissions: legacyV3PermissionsSchema }).strict();

function validateWorkspace(workspace: z.infer<typeof workspaceBaseSchema>, context: z.RefinementCtx): void {
  if (workspace.permissions.browserInteract && !workspace.permissions.browserRead) {
    context.addIssue({
      code: "custom",
      path: ["permissions", "browserInteract"],
      message: "browserInteract requiere browserRead",
    });
  }
  if (workspace.permissions.browserHumanControl && !workspace.permissions.browserRead) {
    context.addIssue({
      code: "custom",
      path: ["permissions", "browserHumanControl"],
      message: "browserHumanControl requiere browserRead",
    });
  }
  for (const [name, profile] of Object.entries(workspace.browserProfiles)) {
    if (profile.linkedProcessProfile !== undefined && workspace.processProfiles[profile.linkedProcessProfile] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["browserProfiles", name, "linkedProcessProfile"],
        message: "el perfil de proceso vinculado no existe",
      });
    }
  }
}

export const workspaceSchema = workspaceBaseSchema.superRefine(validateWorkspace);

function validateLegacyV3Workspace(workspace: z.infer<typeof legacyV3WorkspaceBaseSchema>, context: z.RefinementCtx): void {
  if (workspace.permissions.browserInteract && !workspace.permissions.browserRead) {
    context.addIssue({ code: "custom", path: ["permissions", "browserInteract"], message: "browserInteract requiere browserRead" });
  }
  if (workspace.permissions.browserAuthenticate && !workspace.permissions.browserRead) {
    context.addIssue({ code: "custom", path: ["permissions", "browserAuthenticate"], message: "browserAuthenticate requiere browserRead" });
  }
  if (workspace.permissions.browserManualControl && !workspace.permissions.browserRead) {
    context.addIssue({ code: "custom", path: ["permissions", "browserManualControl"], message: "browserManualControl requiere browserRead" });
  }
  for (const [name, profile] of Object.entries(workspace.browserProfiles)) {
    if (profile.linkedProcessProfile !== undefined && workspace.processProfiles[profile.linkedProcessProfile] === undefined) {
      context.addIssue({ code: "custom", path: ["browserProfiles", name, "linkedProcessProfile"], message: "el perfil de proceso vinculado no existe" });
    }
  }
}

const legacyV3WorkspaceSchema = legacyV3WorkspaceBaseSchema.superRefine(validateLegacyV3Workspace);

const legacyWorkspaceSchema = legacyV3WorkspaceBaseSchema.extend({
  browserApplications: z.record(z.string().regex(PROFILE_NAME_PATTERN), browserApplicationProfileSchema).default({}),
}).strict().superRefine(validateLegacyV3Workspace);

const legacyV4WorkspaceSchema = workspaceBaseSchema.extend({
  browserApplications: z.record(z.string().regex(PROFILE_NAME_PATTERN), browserApplicationProfileSchema).default({}),
}).strict().superRefine(validateWorkspace);

function validateWorkspaceIds<T extends { readonly id: string }>(workspaces: readonly T[], context: z.RefinementCtx): Map<string, T> {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  if (byId.size !== workspaces.length) {
    context.addIssue({ code: "custom", path: ["workspaces"], message: "los IDs de workspace deben ser únicos" });
  }
  return byId;
}

function validateApplicationReferences(
  applications: readonly z.infer<typeof localApplicationSchema>[],
  byId: ReadonlyMap<string, { readonly processProfiles: Readonly<Record<string, unknown>> }>,
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  const ids = new Set<string>();
  applications.forEach((application, applicationIndex) => {
    const nameKey = applicationNameKey(application.name);
    if (names.has(nameKey)) {
      context.addIssue({ code: "custom", path: ["applications", applicationIndex, "name"], message: "el nombre de aplicación debe ser único" });
    }
    if (ids.has(application.id)) {
      context.addIssue({ code: "custom", path: ["applications", applicationIndex, "id"], message: "el ID de aplicación debe ser único" });
    }
    names.add(nameKey);
    ids.add(application.id);
    for (const [serviceIndex, service] of application.services.entries()) {
      const target = byId.get(service.workspaceId);
      if (target === undefined) {
        if (application.reviewState !== "reviewed") continue;
        context.addIssue({
          code: "custom",
          path: ["applications", applicationIndex, "services", serviceIndex, "workspaceId"],
          message: "el workspace del servicio no existe",
        });
        continue;
      }
      if (target.processProfiles[service.processProfile] === undefined && application.reviewState === "reviewed") {
        context.addIssue({
          code: "custom",
          path: ["applications", applicationIndex, "services", serviceIndex, "processProfile"],
          message: "el perfil de proceso del servicio no existe",
        });
      }
    }
  });
}

export const registryFileSchema = z.object({
  schemaVersion: z.literal(5),
  workspaces: z.array(workspaceSchema).default([]),
  applications: z.array(localApplicationSchema).default([]),
}).strict().superRefine((registry, context) => {
  const byId = validateWorkspaceIds(registry.workspaces, context);
  validateApplicationReferences(registry.applications, byId, context);
});

const legacyV4RegistryFileSchema = z.object({
  schemaVersion: z.literal(4),
  workspaces: z.array(workspaceSchema).default([]),
  applications: z.array(localApplicationSchema).default([]),
}).strict().superRefine((registry, context) => {
  const byId = validateWorkspaceIds(registry.workspaces, context);
  validateApplicationReferences(registry.applications, byId, context);
});

const legacyV3RegistryFileSchema = z.object({
  schemaVersion: z.literal(3),
  workspaces: z.array(legacyV3WorkspaceSchema).default([]),
  applications: z.array(localApplicationSchema).default([]),
}).strict().superRefine((registry, context) => {
  const byId = validateWorkspaceIds(registry.workspaces, context);
  validateApplicationReferences(registry.applications, byId, context);
});

export const legacyRegistryFileSchema = z.object({
  workspaces: z.array(legacyWorkspaceSchema).default([]),
}).strict().superRefine((registry, context) => {
  const byId = validateWorkspaceIds(registry.workspaces, context);
  registry.workspaces.forEach((owner, ownerIndex) => {
    for (const [applicationName, application] of Object.entries(owner.browserApplications)) {
      for (const [serviceName, service] of Object.entries(application.services)) {
        const target = byId.get(service.workspaceId);
        if (target === undefined) {
          context.addIssue({
            code: "custom",
            path: ["workspaces", ownerIndex, "browserApplications", applicationName, "services", serviceName, "workspaceId"],
            message: "el workspace del servicio no existe",
          });
          continue;
        }
        if (target.processProfiles[service.processProfile] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["workspaces", ownerIndex, "browserApplications", applicationName, "services", serviceName, "processProfile"],
            message: "el perfil de proceso del servicio no existe",
          });
        }
      }
    }
  });
});

const legacyUnversionedV4RegistryFileSchema = z.object({
  workspaces: z.array(legacyV4WorkspaceSchema).default([]),
}).strict().superRefine((registry, context) => {
  const byId = validateWorkspaceIds(registry.workspaces, context);
  registry.workspaces.forEach((owner, ownerIndex) => {
    for (const [applicationName, application] of Object.entries(owner.browserApplications)) {
      for (const [serviceName, service] of Object.entries(application.services)) {
        const target = byId.get(service.workspaceId);
        if (target === undefined || target.processProfiles[service.processProfile] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["workspaces", ownerIndex, "browserApplications", applicationName, "services", serviceName],
            message: target === undefined ? "el workspace del servicio no existe" : "el perfil de proceso del servicio no existe",
          });
        }
      }
    }
  });
});

function deterministicId(prefix: "app" | "service", seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

function canonicalProfile(profile: BrowserApplicationProfile): string {
  return JSON.stringify({
    primaryService: profile.primaryService,
    services: Object.entries(profile.services)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([alias, service]) => [alias, service]),
    viewport: profile.viewport,
  });
}

function convertLegacyApplication(name: string, profile: BrowserApplicationProfile, timestamp: string) {
  const appKey = applicationNameKey(name);
  const services = Object.entries(profile.services)
    .toSorted(([, left], [, right]) => left.startupOrder - right.startupOrder)
    .map(([alias, service], index) => ({
      id: deterministicId("service", `${appKey}:${alias}:${service.workspaceId}:${service.processProfile}`),
      alias,
      ...service,
      startupOrder: index,
    }));
  const primary = services.find((service) => service.alias === profile.primaryService) ?? services[0]!;
  return {
    id: deterministicId("app", appKey),
    name,
    description: "",
    primaryServiceId: primary.id,
    services,
    viewport: profile.viewport,
    reviewState: "reviewed" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function migrateV3Workspace(workspace: z.infer<typeof legacyV3WorkspaceSchema>): AuthorizedWorkspace {
  const { browserAuthenticate, browserManualControl, ...permissions } = workspace.permissions;
  return workspaceSchema.parse({
    ...workspace,
    automationReviewRequired: workspace.automationReviewRequired || browserAuthenticate !== browserManualControl,
    permissions: {
      ...permissions,
      browserHumanControl: browserAuthenticate && browserManualControl,
    },
  });
}

/** Lee v5 o migra en memoria v4/v3/v0.4.x sin ampliar permisos ni consumo. */
export function parseWorkspaceRegistry(input: unknown): WorkspaceRegistry {
  const current = registryFileSchema.safeParse(input);
  if (current.success) return current.data;

  const v4 = legacyV4RegistryFileSchema.safeParse(input);
  if (v4.success) {
    return registryFileSchema.parse({
      schemaVersion: 5,
      workspaces: v4.data.workspaces,
      applications: v4.data.applications,
    });
  }

  const v3 = legacyV3RegistryFileSchema.safeParse(input);
  if (v3.success) {
    return registryFileSchema.parse({
      schemaVersion: 5,
      workspaces: v3.data.workspaces.map(migrateV3Workspace),
      applications: v3.data.applications,
    });
  }

  const legacyV3 = legacyRegistryFileSchema.safeParse(input);
  let legacy: z.infer<typeof legacyRegistryFileSchema> | z.infer<typeof legacyUnversionedV4RegistryFileSchema>;
  let legacyUsesV3Permissions: boolean;
  if (legacyV3.success) {
    legacy = legacyV3.data;
    legacyUsesV3Permissions = true;
  } else {
    const legacyV4 = legacyUnversionedV4RegistryFileSchema.safeParse(input);
    if (!legacyV4.success) throw legacyV3.error;
    legacy = legacyV4.data;
    legacyUsesV3Permissions = false;
  }
  const timestamp = legacy.workspaces.map((workspace) => workspace.createdAt).toSorted()[0] ?? "1970-01-01T00:00:00.000Z";
  const grouped = new Map<string, Array<{ name: string; ownerWorkspaceId: string; profile: BrowserApplicationProfile }>>();
  for (const owner of legacy.workspaces) {
    for (const [name, profile] of Object.entries(owner.browserApplications)) {
      const key = applicationNameKey(name);
      const entries = grouped.get(key) ?? [];
      entries.push({ name, ownerWorkspaceId: owner.id, profile });
      grouped.set(key, entries);
    }
  }

  const applications: LocalApplication[] = [];
  for (const entries of grouped.values()) {
    const first = entries[0]!;
    const distinct = new Map(entries.map((entry) => [canonicalProfile(entry.profile), entry]));
    const converted = convertLegacyApplication(first.name, first.profile, timestamp);
    applications.push(localApplicationSchema.parse(distinct.size === 1 ? converted : {
      ...converted,
      reviewState: "conflict",
      conflictCandidates: entries.map((entry) => ({
        ownerWorkspaceId: entry.ownerWorkspaceId,
        profile: entry.profile,
      })),
    }));
  }

  const workspaces = legacy.workspaces.map(({ browserApplications: _legacy, ...workspace }) =>
    legacyUsesV3Permissions ? migrateV3Workspace(workspace as z.infer<typeof legacyV3WorkspaceSchema>) : workspaceSchema.parse(workspace));
  return registryFileSchema.parse({ schemaVersion: 5, workspaces, applications });
}

/**
 * Carga el registro completo. Fallo cerrado: un fichero ausente o inválido
 * produce lista vacía, nunca una excepción que tumbe el servidor — `system.health`
 * debe seguir respondiendo aunque la configuración de workspaces esté rota.
 */
export async function loadWorkspaceRegistry(
  configPath: string,
  logger: Logger,
): Promise<readonly AuthorizedWorkspace[]> {
  return (await loadWorkspaceRegistryDocument(configPath, logger)).workspaces;
}

export async function loadWorkspaceRegistryDocument(
  configPath: string,
  logger: Logger,
): Promise<WorkspaceRegistry> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { schemaVersion: 5, workspaces: [], applications: [] };
    }
    logger.error("workspace registry unreadable", { code: nodeErrorCode(error) });
    return { schemaVersion: 5, workspaces: [], applications: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error("workspace registry is not valid JSON");
    return { schemaVersion: 5, workspaces: [], applications: [] };
  }

  try {
    return parseWorkspaceRegistry(parsed);
  } catch (error) {
    logger.error("workspace registry failed schema validation", {
      issueCount: error instanceof z.ZodError ? error.issues.length : 1,
    });
    return { schemaVersion: 5, workspaces: [], applications: [] };
  }
}

export async function getWorkspace(
  configPath: string,
  logger: Logger,
  workspaceId: string,
): Promise<AuthorizedWorkspace | undefined> {
  const workspaces = await loadWorkspaceRegistry(configPath, logger);
  return workspaces.find((workspace) => workspace.id === workspaceId);
}
