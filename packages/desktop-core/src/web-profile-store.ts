import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent, LocalBridgeError } from "@localbridge/shared";
import { withWorkspaceAuthorityLock } from "@localbridge/workspace";
import { z } from "zod";

export const WEB_PROFILE_STORE_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const webProfileIdSchema = z.string().regex(/^webprofile_[a-f0-9]{24}$/);

function validDnsHostname(value: string): boolean {
  if (value !== value.toLowerCase() || value.length > 253 || value.endsWith(".") || !value.includes(".")) return false;
  if (net.isIP(value) !== 0) return false;
  return value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export const webHostRuleSchema = z.object({
  hostname: z.string().refine(validDnsHostname, "se requiere un hostname DNS normalizado"),
  includeSubdomains: z.boolean().default(true),
}).strict();

export const webProfilePermissionsSchema = z.object({
  read: z.boolean(),
  interact: z.boolean(),
  download: z.boolean(),
  humanControl: z.boolean(),
}).strict().superRefine((permissions, context) => {
  if (permissions.interact && !permissions.read) {
    context.addIssue({ code: "custom", path: ["interact"], message: "interact requiere read" });
  }
  if (permissions.download && !permissions.read) {
    context.addIssue({ code: "custom", path: ["download"], message: "download requiere read" });
  }
  if (permissions.humanControl && !permissions.read) {
    context.addIssue({ code: "custom", path: ["humanControl"], message: "humanControl requiere read" });
  }
});

export const webProfileLimitsSchema = z.object({
  maxSessions: z.number().int().min(1).max(4).default(2),
  maxTabsPerSession: z.number().int().min(1).max(12).default(8),
  maxExtractedChars: z.number().int().min(1_000).max(200_000).default(50_000),
  maxDownloadBytes: z.number().int().min(1_024).max(1024 * 1024 * 1024).default(1024 * 1024 * 1024),
  maxTotalDownloadBytes: z.number().int().min(1_024).max(10 * 1024 * 1024 * 1024).default(10 * 1024 * 1024 * 1024),
  transferPolicy: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('fixed') }).strict(),
    z.object({ mode: z.literal('adaptive') }).strict(),
  ]).default({ mode: 'fixed' }),
}).strict().superRefine((limits, context) => {
  if (limits.maxTotalDownloadBytes < limits.maxDownloadBytes) {
    context.addIssue({
      code: "custom",
      path: ["maxTotalDownloadBytes"],
      message: "la cuota acumulada debe ser igual o mayor que el máximo por asset",
    });
  }
});

export const webProfileSchema = z.object({
  id: webProfileIdSchema,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["public-research", "site-account"]),
  enabled: z.boolean(),
  reviewRequired: z.boolean(),
  destinations: z.array(webHostRuleSchema).max(100),
  supportHosts: z.array(webHostRuleSchema).max(200),
  permissions: webProfilePermissionsSchema,
  limits: webProfileLimitsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((profile, context) => {
  if (profile.kind === "public-research" && (profile.destinations.length !== 0 || profile.supportHosts.length !== 0)) {
    context.addIssue({ code: "custom", path: ["destinations"], message: "investigación pública no usa allowlists" });
  }
  if (profile.kind === "public-research" && profile.permissions.humanControl) {
    context.addIssue({ code: "custom", path: ["permissions", "humanControl"], message: "investigación pública no inicia sesión" });
  }
  if (profile.kind === "site-account" && profile.destinations.length === 0) {
    context.addIssue({ code: "custom", path: ["destinations"], message: "un perfil con cuenta requiere destinos" });
  }
  const allRules = [...profile.destinations, ...profile.supportHosts];
  const keys = allRules.map((rule) => `${rule.hostname}:${String(rule.includeSubdomains)}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["supportHosts"], message: "las reglas de host deben ser únicas" });
  }
});

export const webProfileStoreSchema = z.object({
  schemaVersion: z.literal(WEB_PROFILE_STORE_SCHEMA_VERSION),
  profiles: z.array(webProfileSchema).max(20),
}).strict().superRefine((document, context) => {
  if (new Set(document.profiles.map((profile) => profile.id)).size !== document.profiles.length) {
    context.addIssue({ code: "custom", path: ["profiles"], message: "los IDs de perfil deben ser únicos" });
  }
});

export type WebHostRule = z.infer<typeof webHostRuleSchema>;
export type WebTransferPolicy = z.infer<typeof webProfileLimitsSchema>['transferPolicy'];
export type WebProfile = z.infer<typeof webProfileSchema>;
export type WebProfileStore = z.infer<typeof webProfileStoreSchema>;

export interface WebProfileStoreSnapshot {
  readonly state: "ready" | "missing" | "corrupt";
  readonly document: WebProfileStore;
  /** Hash exacto del archivo observado; también permite reemplazar localmente uno corrupto. */
  readonly sha256: string | null;
}

export class WebProfileStoreError extends Error {
  constructor(readonly code: "WEB_PROFILE_CONFLICT" | "WEB_PROFILE_STORE_CORRUPT") {
    super(code === "WEB_PROFILE_CONFLICT"
      ? "El registro web cambió; vuelve a cargarlo antes de guardar."
      : "El registro web está corrupto y requiere revisión local.");
    this.name = "WebProfileStoreError";
  }
}

const EMPTY_STORE: WebProfileStore = { schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION, profiles: [] };

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashesEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  if (!sha256Schema.safeParse(left).success || !sha256Schema.safeParse(right).success) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function defaultWebProfileStorePath(): string {
  return path.join(os.homedir(), ".localbridge-mcp", "web-profiles.json");
}

export async function readWebProfileStore(storePath: string): Promise<WebProfileStoreSnapshot> {
  let raw: Buffer;
  try {
    raw = await readFile(storePath);
  } catch (error) {
    if (isEnoent(error)) return { state: "missing", document: EMPTY_STORE, sha256: null };
    return { state: "corrupt", document: EMPTY_STORE, sha256: null };
  }

  const sha256 = hash(raw);
  try {
    const document = webProfileStoreSchema.parse(JSON.parse(raw.toString("utf8")));
    return { state: "ready", document, sha256 };
  } catch {
    return { state: "corrupt", document: EMPTY_STORE, sha256 };
  }
}

/**
 * Única mutación del registro web. La UI local aporta el hash de su revisión;
 * MCP no puede invocar esta función ni crear autoridad.
 */
export async function replaceWebProfileStore(
  storePath: string,
  next: WebProfileStore,
  expectedSha256: string | null,
): Promise<WebProfileStoreSnapshot> {
  const validated = webProfileStoreSchema.parse(next);
  return withWorkspaceAuthorityLock(storePath, async () => {
    const current = await readWebProfileStore(storePath);
    if (!hashesEqual(current.sha256, expectedSha256)) throw new WebProfileStoreError("WEB_PROFILE_CONFLICT");
    await mkdir(path.dirname(storePath), { recursive: true });
    const content = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await atomicWrite(path.dirname(storePath), path.basename(storePath), content);
    return { state: "ready", document: validated, sha256: hash(content) };
  });
}

export function buildPublicResearchProfile(now = new Date(), name = "Investigación pública"): WebProfile {
  const timestamp = now.toISOString();
  return webProfileSchema.parse({
    id: `webprofile_${randomBytes(12).toString("hex")}`,
    name,
    kind: "public-research",
    // Crear el borrador no concede acceso. La UI debe mostrar el alcance y habilitarlo.
    enabled: false,
    reviewRequired: false,
    destinations: [],
    supportHosts: [],
    permissions: { read: true, interact: true, download: false, humanControl: false },
    limits: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** Aplica la decisión local de habilitar Internet en una sola mutación revisable. */
export function enablePublicInternetAccess(
  document: WebProfileStore,
  download: boolean,
  now = new Date(),
): WebProfileStore {
  const current = webProfileStoreSchema.parse(document);
  const existingIndex = current.profiles.findIndex((profile) => profile.kind === "public-research");
  if (existingIndex < 0) {
    if (current.profiles.length >= 20) throw new Error("Se alcanzó el límite de 20 accesos web guardados.");
    const created = buildPublicResearchProfile(now);
    return webProfileStoreSchema.parse({
      ...current,
      profiles: [...current.profiles, {
        ...created,
        enabled: true,
        permissions: { read: true, interact: true, download, humanControl: false },
      }],
    });
  }
  const existing = current.profiles[existingIndex]!;
  const profiles = [...current.profiles];
  profiles[existingIndex] = webProfileSchema.parse({
    ...existing,
    enabled: true,
    reviewRequired: false,
    permissions: { read: true, interact: true, download, humanControl: false },
    updatedAt: now.toISOString(),
  });
  return webProfileStoreSchema.parse({ ...current, profiles });
}

function normalizeProfileHostname(hostname: string, includeSubdomains = true): WebHostRule {
  return { hostname: hostname.trim().toLowerCase(), includeSubdomains };
}

export function buildSiteAccountProfile(
  input: {
    readonly name: string;
    readonly destinations: readonly string[];
    readonly supportHosts?: readonly string[];
    readonly includeSubdomains?: boolean;
  },
  now = new Date(),
): WebProfile {
  const timestamp = now.toISOString();
  return webProfileSchema.parse({
    id: `webprofile_${randomBytes(12).toString("hex")}`,
    name: input.name,
    kind: "site-account",
    enabled: false,
    reviewRequired: false,
    destinations: input.destinations.map((hostname) => normalizeProfileHostname(hostname, input.includeSubdomains ?? true)),
    supportHosts: (input.supportHosts ?? []).map((hostname) => normalizeProfileHostname(hostname)),
    permissions: { read: true, interact: true, download: false, humanControl: true },
    limits: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** Construye el acceso exacto confirmado localmente sin duplicar una regla equivalente. */
export function rememberExactSiteAccess(
  document: WebProfileStore,
  hostname: string,
  now = new Date(),
): WebProfileStore {
  const current = webProfileStoreSchema.parse(document);
  const destination = webHostRuleSchema.parse(normalizeProfileHostname(hostname, false));
  const existingIndex = current.profiles.findIndex((profile) =>
    profile.kind === "site-account" && profile.destinations.length === 1 &&
    profile.destinations[0]?.hostname === destination.hostname &&
    profile.destinations[0].includeSubdomains === false && profile.supportHosts.length === 0);
  if (existingIndex >= 0) {
    const existing = current.profiles[existingIndex]!;
    if (existing.enabled && !existing.reviewRequired && existing.permissions.read &&
        existing.permissions.interact && existing.permissions.humanControl) return document;
    const profiles = [...current.profiles];
    profiles[existingIndex] = webProfileSchema.parse({
      ...existing,
      enabled: true,
      reviewRequired: false,
      permissions: { ...existing.permissions, read: true, interact: true, humanControl: true },
      updatedAt: now.toISOString(),
    });
    return webProfileStoreSchema.parse({ ...current, profiles });
  }
  if (current.profiles.length >= 20) throw new Error("Se alcanzó el límite de 20 accesos web guardados.");
  const created = buildSiteAccountProfile({
    name: `Acceso a ${destination.hostname}`.slice(0, 80),
    destinations: [destination.hostname],
    includeSubdomains: false,
  }, now);
  return webProfileStoreSchema.parse({
    ...current,
    profiles: [...current.profiles, { ...created, enabled: true }],
  });
}

export function webProfileRevision(profile: WebProfile): string {
  const current = webProfileSchema.parse(profile);
  // La revisión de autoridad excluye nombre, fecha y presupuestos de consumo.
  // Ajustar una cuota no cierra sesiones ni concede destinos/capacidades.
  return createHash("sha256").update(JSON.stringify({
    id: current.id,
    kind: current.kind,
    enabled: current.enabled,
    reviewRequired: current.reviewRequired,
    destinations: current.destinations,
    supportHosts: current.supportHosts,
    permissions: current.permissions,
  })).digest("hex");
}

/** Revalida un perfil sin retener el lock durante una transferencia larga. */
export async function requireCurrentWebProfileAuthority(
  storePath: string,
  webProfileId: string,
  expectedRevision: string,
  capability: keyof WebProfile["permissions"],
): Promise<WebProfile> {
  const snapshot = await readWebProfileStore(storePath);
  if (snapshot.state !== "ready") throw new LocalBridgeError("PROFILE_NOT_FOUND");
  const profile = snapshot.document.profiles.find((candidate) => candidate.id === webProfileId);
  if (profile === undefined) throw new LocalBridgeError("PROFILE_NOT_FOUND");
  if (!profile.enabled || profile.reviewRequired || !profile.permissions[capability]) {
    throw new LocalBridgeError("CAPABILITY_DISABLED");
  }
  if (webProfileRevision(profile) !== expectedRevision) throw new LocalBridgeError("APPROVAL_INVALID");
  return profile;
}

/** Mantiene la revisión del perfil y el efecto externo en una sección crítica. */
export async function withAuthorizedWebProfileEffect<T>(
  storePath: string,
  webProfileId: string,
  expectedRevision: string,
  capability: keyof WebProfile["permissions"],
  effect: () => Promise<T>,
): Promise<T> {
  return withWorkspaceAuthorityLock(storePath, async () => {
    await requireCurrentWebProfileAuthority(storePath, webProfileId, expectedRevision, capability);
    return effect();
  });
}
