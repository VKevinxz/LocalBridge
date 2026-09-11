/**
 * Preferencias propias de la UI de escritorio (dónde está `tunnel-client`, qué
 * perfil usar). Deliberadamente separado de `workspaces.json`: esto no es un
 * límite de seguridad — perderlo no expone ni oculta ningún proyecto, solo
 * obliga a volver a escribir unas rutas — así que no necesita el mismo
 * tratamiento "fallar ruidoso ante corrupción" que `registry-store.ts`. Un
 * fichero ausente representa una instalación nueva; uno existente, roto o sin
 * un campo de seguridad conserva el fallback compatible y restrictivo.
 */

import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { atomicWrite } from "@localbridge/filesystem";
import { GIT_APPROVAL_MODES, isEnoent, type GitApprovalMode } from "@localbridge/shared";
import { defaultLargeArtifactPolicy, largeArtifactPolicySchema, type LargeArtifactPolicy } from "@localbridge/workspace";
import { tunnelIdSchema } from "./tunnel-provisioner.js";

export interface DesktopSettings {
  readonly onboardingStep: number;
  readonly onboardingCompleted: boolean;
  readonly minimizeToTray: boolean;
  /** Preferencia que se copia a proyectos nuevos; no modifica proyectos ya autorizados. */
  readonly largeArtifactPreference: LargeArtifactPolicy;
  /** Modo de aprobación para commit/push; se aplica al reconectar el túnel. */
  readonly gitApprovalMode: GitApprovalMode;
  readonly activeConnectionProfileId: string;
  readonly connectionProfiles: readonly ConnectionProfile[];
  /** Identificador público/no secreto del túnel administrado por LocalBridge. */
  readonly tunnelId: string;
  readonly tunnelBinaryPath: string;
  readonly tunnelProfile: string;
  readonly tunnelProfileDir: string;
  /** `cwd` del servidor LocalBridge — la raíz del repo, para el comando relativo del perfil. */
  readonly serverCwd: string;
}

export interface ConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly tunnelId: string;
}

export const connectionProfileIdSchema = z.string().regex(/^profile_[a-z0-9]{8,32}$/);
export const connectionProfileSchema = z
  .object({
    id: connectionProfileIdSchema,
    name: z.string().trim().min(1).max(80),
    tunnelId: tunnelIdSchema.or(z.literal("")),
  })
  .strict();

export const DEFAULT_CONNECTION_PROFILE: ConnectionProfile = {
  id: "profile_default0",
  name: "Personal",
  tunnelId: "",
};

const configuredPathSchema = z
  .string()
  .refine((value) => value === "" || path.isAbsolute(value), "la ruta configurada debe ser absoluta");

const desktopSettingsBaseSchema = z
  .object({
    onboardingStep: z.number().int().min(0).max(4),
    onboardingCompleted: z.boolean(),
    minimizeToTray: z.boolean(),
    largeArtifactPreference: largeArtifactPolicySchema,
    gitApprovalMode: z.enum(GIT_APPROVAL_MODES),
    activeConnectionProfileId: connectionProfileIdSchema,
    connectionProfiles: z.array(connectionProfileSchema).min(1).max(20),
    tunnelId: tunnelIdSchema.or(z.literal("")),
    tunnelBinaryPath: configuredPathSchema,
    tunnelProfile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "nombre de perfil no válido"),
    tunnelProfileDir: configuredPathSchema,
    serverCwd: configuredPathSchema,
  })
  .strict();

export const desktopSettingsSchema = desktopSettingsBaseSchema.superRefine((value, context) => {
    if (!value.connectionProfiles.some((profile) => profile.id === value.activeConnectionProfileId)) {
      context.addIssue({ code: "custom", path: ["activeConnectionProfileId"], message: "el perfil activo no existe" });
    }
    if (new Set(value.connectionProfiles.map((profile) => profile.id)).size !== value.connectionProfiles.length) {
      context.addIssue({ code: "custom", path: ["connectionProfiles"], message: "los ids de perfil deben ser únicos" });
    }
});

const partialDesktopSettingsSchema = desktopSettingsBaseSchema.partial().strict();

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  onboardingStep: 0,
  onboardingCompleted: false,
  minimizeToTray: true,
  largeArtifactPreference: defaultLargeArtifactPolicy(),
  // La aplicación conecta ChatGPT por defecto. Instalaciones históricas sin
  // este campo conservan MRTR explícitamente en readDesktopSettings.
  gitApprovalMode: "host",
  activeConnectionProfileId: DEFAULT_CONNECTION_PROFILE.id,
  connectionProfiles: [DEFAULT_CONNECTION_PROFILE],
  tunnelId: "",
  tunnelBinaryPath: "",
  tunnelProfile: "local-stdio",
  tunnelProfileDir: "",
  serverCwd: "",
};

const SAFE_EXISTING_SETTINGS_FALLBACK: DesktopSettings = {
  ...DEFAULT_DESKTOP_SETTINGS,
  gitApprovalMode: "mrtr",
};

export function defaultDesktopSettingsPath(): string {
  return path.join(os.homedir(), ".localbridge-mcp", "desktop-settings.json");
}

export async function readDesktopSettings(settingsPath: string): Promise<DesktopSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return DEFAULT_DESKTOP_SETTINGS;
    return SAFE_EXISTING_SETTINGS_FALLBACK;
  }

  try {
    const partial = partialDesktopSettingsSchema.parse(JSON.parse(raw));
    const merged = {
      ...DEFAULT_DESKTOP_SETTINGS,
      // No migrar silenciosamente instalaciones existentes al modo delegado.
      gitApprovalMode: partial.gitApprovalMode ?? "mrtr",
      ...partial,
    };
    const legacyTunnelId = merged.tunnelId ?? "";
    if (partial.connectionProfiles === undefined && legacyTunnelId !== "") {
      merged.connectionProfiles = [{ ...DEFAULT_CONNECTION_PROFILE, tunnelId: legacyTunnelId }];
    }
    return desktopSettingsSchema.parse(merged);
  } catch {
    return SAFE_EXISTING_SETTINGS_FALLBACK;
  }
}

export function activeConnectionProfile(settings: DesktopSettings): ConnectionProfile {
  const profile = settings.connectionProfiles.find((candidate) => candidate.id === settings.activeConnectionProfileId);
  if (profile === undefined) throw new Error("El perfil de conexión activo no existe.");
  return profile;
}

export function synchronizeActiveConnectionProfile(settings: DesktopSettings): DesktopSettings {
  const profiles = settings.connectionProfiles.map((profile) =>
    profile.id === settings.activeConnectionProfileId ? { ...profile, tunnelId: settings.tunnelId } : profile,
  );
  return desktopSettingsSchema.parse({ ...settings, connectionProfiles: profiles });
}

export async function writeDesktopSettings(settingsPath: string, settings: DesktopSettings): Promise<void> {
  const validated = desktopSettingsSchema.parse(settings);
  const dir = path.dirname(settingsPath);
  await mkdir(dir, { recursive: true });
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  await atomicWrite(dir, path.basename(settingsPath), Buffer.from(content, "utf8"));
}
