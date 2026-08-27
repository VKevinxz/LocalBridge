/**
 * Persistencia opcional y cifrada de `CONTROL_PLANE_API_KEY` (ADR-0015, adenda).
 *
 * Por defecto la clave nunca toca el disco — vive solo en memoria mientras la
 * app está abierta. Esto es la persistencia que el usuario pidió explícitamente
 * por practicidad, con una frontera de seguridad clara y distinta: cifrada con
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
 * `undefined` cubre tres casos a propósito, todos con la misma respuesta
 * correcta ("no hay clave recordada, que el usuario la escriba"): no existe el
 * fichero, el cifrado no está disponible ahora mismo, o el contenido no se
 * pudo descifrar (p. ej. se copió el fichero desde otra cuenta de Windows).
 */
export async function loadEncryptedKey(filePath: string, deps: SecureKeyStoreDeps): Promise<string | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  if (!deps.isAvailable()) return undefined;

  try {
    return deps.decrypt(raw);
  } catch {
    return undefined;
  }
}

export async function clearEncryptedKey(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
