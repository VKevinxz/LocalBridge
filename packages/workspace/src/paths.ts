/**
 * Sandbox de rutas (SECURITY.md §3). Ninguna otra parte del sistema debe llamar a
 * `fs` con una ruta construida a mano fuera de este módulo (AGENTS.md regla 6).
 *
 * Dos capas independientes, ninguna suficiente por sí sola:
 *
 * 1. Léxica: `path.resolve` + `path.relative` contra la entrada tal cual llega.
 *    Atrapa `..`, rutas absolutas y nombres reservados de Windows sin tocar disco.
 * 2. Real: `fs.realpath` del target (o del ancestro existente más cercano, si el
 *    target no existe todavía) comparado contra `fs.realpath` del root. Atrapa
 *    symlinks y junctions que la capa léxica no puede ver.
 */

import path from "node:path";
import { realpath as fsRealpath } from "node:fs/promises";

import { LocalBridgeError, isEnoent } from "@localbridge/shared";

const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export interface SafePath {
  /** Ruta relativa normalizada con separadores '/', para eco al cliente y para el denylist. */
  relativePath: string;
  /** Ruta real en disco: la del target si existe, o la de su ancestro existente más cercano. */
  realPath: string;
  exists: boolean;
}

/**
 * Valida `inputRelativePath` contra `rootPath` y devuelve su ruta real verificada.
 *
 * Lanza `LocalBridgeError` con el código correspondiente ante cualquier intento de
 * escapar del workspace. No abre ni lee el archivo: solo resuelve la ruta.
 */
export async function resolveSafePath(rootPath: string, inputRelativePath: string): Promise<SafePath> {
  if (path.isAbsolute(inputRelativePath)) {
    throw new LocalBridgeError("ABSOLUTE_PATH_FORBIDDEN");
  }

  assertNoReservedNames(inputRelativePath);

  let target: string;
  let rel: string;
  try {
    target = path.resolve(rootPath, inputRelativePath);
    rel = path.relative(rootPath, target);
  } catch {
    throw new LocalBridgeError("INVALID_INPUT");
  }

  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new LocalBridgeError("PATH_OUTSIDE_WORKSPACE");
  }

  let realRoot: string;
  try {
    realRoot = await fsRealpath(rootPath);
  } catch {
    // El root del workspace no existe o no es accesible: fallo de configuración,
    // no de la entrada del agente. Fallar cerrado sin detalle.
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  let resolved: { realPath: string; exists: boolean };
  try {
    resolved = await realpathNearestExisting(target);
  } catch {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  if (!isContained(realRoot, resolved.realPath)) {
    throw new LocalBridgeError("SYMLINK_ESCAPE");
  }

  return {
    relativePath: rel.split(path.sep).join("/"),
    realPath: resolved.realPath,
    exists: resolved.exists,
  };
}

/** Exportada para que `write-paths.ts` reutilice la misma regla (AGENTS.md: una sola fuente de verdad para path safety). */
export function assertNoReservedNames(inputRelativePath: string): void {
  const segments = inputRelativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    const base = (segment.split(".")[0] ?? "").toLowerCase();
    if (RESERVED_WINDOWS_NAMES.has(base)) {
      throw new LocalBridgeError("INVALID_INPUT", { reservedName: segment });
    }
  }
}

/**
 * Resuelve el `realpath` de `target`; si no existe, camina hacia arriba hasta el
 * primer ancestro que sí exista (SECURITY.md §3.3, paso 2). El root ya se probó
 * accesible en el llamante, así que la caminata siempre termina.
 */
async function realpathNearestExisting(target: string): Promise<{ realPath: string; exists: boolean }> {
  let current = target;
  let exists = true;

  for (;;) {
    try {
      // Secuencial a propósito: cada ancestro depende del resultado del anterior,
      // no es paralelizable.
      // eslint-disable-next-line no-await-in-loop
      const real = await fsRealpath(current);
      return { realPath: real, exists };
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
      exists = false;
    }
  }
}

/** En Windows el filesystem es insensible a mayúsculas; en POSIX no se toca el casing. */
function normalizeCasing(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Exportada por el mismo motivo que `assertNoReservedNames`. */
export function isContained(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(normalizeCasing(realRoot), normalizeCasing(realTarget));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
