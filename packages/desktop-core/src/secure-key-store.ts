/**
 * Persistencia opcional y cifrada de `CONTROL_PLANE_API_KEY` (ADR-0015, adenda).
 *
 * La clave solo toca el disco cuando el usuario mantiene activa la opción de
 * recordarla. Esa persistencia tiene una frontera de seguridad clara: se cifra con
 * el almacén del sistema operativo (`safeStorage` de Electron → DPAPI en
 * Windows), nunca en texto plano. Protege contra "alguien copia el archivo y lo
 * abre en otra máquina"; **no** protege contra otra persona que use la misma
 * cuenta de Windows en este mismo equipo — esa persona sí podría descifrarla.
 *
 * `encrypt`/`decrypt`/`isAvailable` se inyectan a propósito: `safeStorage` solo
 * existe dentro de un proceso Electron real, así que este módulo se testea con
 * dobles en vez de arrastrar Electron a la suite de `vitest`.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent } from "@localbridge/shared";
import { connectionProfileIdSchema, DEFAULT_CONNECTION_PROFILE } from "./app-settings.js";

export interface SecureKeyStoreDeps {
  readonly encrypt: (plainText: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
  readonly isAvailable: () => boolean;
}

export type SecureKeyLoadResult =
  | { readonly status: "available"; readonly value: string }
  | { readonly status: "absent" }
  | { readonly status: "encryption-unavailable" }
  | { readonly status: "unreadable" }
  | { readonly status: "io-error"; readonly code: "KEY_STORE_READ_FAILED" };

export type StoredTunnelKeyState =
  | { readonly status: "available" }
  | { readonly status: "absent" }
  | { readonly status: "encryption-unavailable" }
  | { readonly status: "unreadable" }
  | { readonly status: "io-error"; readonly code: "KEY_STORE_READ_FAILED" };

export type LegacyKeyMigrationResult =
  | { readonly status: "migrated" }
  | { readonly status: "not-needed" }
  | { readonly status: "source-absent" }
  | { readonly status: "ambiguous" }
  | { readonly status: "encryption-unavailable" }
  | { readonly status: "source-unreadable" }
  | { readonly status: "failed"; readonly code: "KEY_MIGRATION_FAILED" };

export interface LegacyKeyMigrationOptions {
  readonly profileIds: readonly string[];
  readonly activeProfileId: string;
  /** Inyectables para probar la migración sin tocar el perfil real del usuario. */
  readonly legacyPath?: string;
  readonly targetPath?: string;
}

export function defaultTunnelKeyPath(profileId: string = DEFAULT_CONNECTION_PROFILE.id): string {
  const validated = connectionProfileIdSchema.parse(profileId);
  return validated === DEFAULT_CONNECTION_PROFILE.id
    ? path.join(os.homedir(), ".localbridge-mcp", "tunnel-key.enc")
    : path.join(os.homedir(), ".localbridge-mcp", "tunnel-keys", `${validated}.enc`);
}

export async function saveEncryptedKey(filePath: string, plainText: string, deps: SecureKeyStoreDeps): Promise<void> {
  if (!deps.isAvailable()) {
    throw new Error("El cifrado seguro del sistema operativo no está disponible en este equipo.");
  }

  const encrypted = deps.encrypt(plainText);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await atomicWrite(dir, path.basename(filePath), encrypted);
}

/**
 * Sustituye una credencial solo si el nuevo blob puede releerse y descifrarse. Si la
 * verificación falla, restaura byte por byte el blob anterior (o vuelve a ausencia).
 * El llamante obtiene únicamente éxito/fallo y nunca necesita materializar el backup.
 */
export async function saveAndVerifyEncryptedKey(
  filePath: string,
  plainText: string,
  deps: SecureKeyStoreDeps,
): Promise<boolean> {
  let previous: Buffer | undefined;
  try {
    previous = await readFile(filePath);
  } catch (error) {
    if (!isEnoent(error)) return false;
  }

  try {
    await saveEncryptedKey(filePath, plainText, deps);
    const verified = await loadEncryptedKey(filePath, deps);
    if (verified.status === "available" && verified.value === plainText) return true;
  } catch {
    // La restauración de abajo cubre tanto escritura como verificación fallidas.
  }

  try {
    if (previous === undefined) {
      await clearEncryptedKey(filePath);
    } else {
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true });
      await atomicWrite(dir, path.basename(filePath), previous);
    }
  } catch {
    // El resultado sigue siendo fallo. No se expone contenido ni se afirma rollback.
  }
  return false;
}

/** Distingue ausencia, indisponibilidad y corrupción para que la UI no oculte la causa. */
export async function loadEncryptedKey(filePath: string, deps: SecureKeyStoreDeps): Promise<SecureKeyLoadResult> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (isEnoent(error)) return { status: "absent" };
    return { status: "io-error", code: "KEY_STORE_READ_FAILED" };
  }

  if (!deps.isAvailable()) return { status: "encryption-unavailable" };

  try {
    return { status: "available", value: deps.decrypt(raw) };
  } catch {
    return { status: "unreadable" };
  }
}

export function publicStoredTunnelKeyState(result: SecureKeyLoadResult): StoredTunnelKeyState {
  if (result.status === "available") return { status: "available" };
  if (result.status === "io-error") return { status: "io-error", code: result.code };
  return { status: result.status };
}

/**
 * Traslada el blob histórico solo cuando su propietario es inequívoco. El secreto se
 * descifra únicamente dentro del proceso principal y vuelve a cifrarse mediante DPAPI;
 * nunca se copia como texto plano ni se registra.
 */
export async function migrateLegacyEncryptedKey(
  options: LegacyKeyMigrationOptions,
  deps: SecureKeyStoreDeps,
): Promise<LegacyKeyMigrationResult> {
  const activeProfileId = connectionProfileIdSchema.parse(options.activeProfileId);
  const profileIds = options.profileIds.map((profileId) => connectionProfileIdSchema.parse(profileId));
  const legacyPath = options.legacyPath ?? defaultTunnelKeyPath(DEFAULT_CONNECTION_PROFILE.id);
  const targetPath = options.targetPath ?? defaultTunnelKeyPath(activeProfileId);

  if (legacyPath === targetPath || activeProfileId === DEFAULT_CONNECTION_PROFILE.id) {
    return { status: "not-needed" };
  }

  const target = await loadEncryptedKey(targetPath, deps);
  if (target.status !== "absent") return { status: "not-needed" };
  if (profileIds.length !== 1 || profileIds[0] !== activeProfileId) return { status: "ambiguous" };

  const source = await loadEncryptedKey(legacyPath, deps);
  if (source.status === "absent") return { status: "source-absent" };
  if (source.status === "encryption-unavailable") return { status: "encryption-unavailable" };
  if (source.status === "unreadable") return { status: "source-unreadable" };
  if (source.status === "io-error") return { status: "failed", code: "KEY_MIGRATION_FAILED" };

  // Mismo contrato que la frontera IPC, sin importar el schema desde aquí y crear un
  // ciclo entre el almacén y los inputs de Electron.
  if (source.value.trim().length === 0 || source.value.length > 16_384) {
    return { status: "source-unreadable" };
  }

  let targetCreated = false;
  try {
    await saveEncryptedKey(targetPath, source.value, deps);
    targetCreated = true;
    const verified = await loadEncryptedKey(targetPath, deps);
    if (verified.status !== "available" || verified.value !== source.value) {
      await clearEncryptedKey(targetPath);
      return { status: "failed", code: "KEY_MIGRATION_FAILED" };
    }
    await clearEncryptedKey(legacyPath);
    return { status: "migrated" };
  } catch {
    if (targetCreated) {
      try {
        await clearEncryptedKey(targetPath);
      } catch {
        // El origen se conserva. La siguiente ejecución nunca sobrescribe un destino
        // que haya quedado presente y no se atribuye una migración incompleta como éxito.
      }
    }
    return { status: "failed", code: "KEY_MIGRATION_FAILED" };
  }
}

export async function clearEncryptedKey(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
