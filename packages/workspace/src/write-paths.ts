/**
 * Resolución de rutas para escritura (ADR-0013). Deliberadamente distinta de
 * `resolveSafePath`: esa función responde "¿puedo alcanzar contenido real?"
 * (apta para lectura); esta responde "¿hay *algo*, sea lo que sea, ya ocupando
 * esta posición?" — la pregunta que importa antes de crear o reemplazar un
 * archivo, porque un symlink colgante "no existe" para la primera pregunta pero
 * sí para la segunda.
 *
 * Camina el árbol de directorios segmento a segmento desde el root verificado,
 * en vez de delegar en `fs.mkdir({recursive:true})`, para poder rechazar con
 * `SYMLINK_ESCAPE` en cuanto aparece un symlink en cualquier nivel — colgante o
 * no — sin excepciones.
 */

import path from "node:path";
import { lstat, mkdir, realpath as fsRealpath } from "node:fs/promises";

import { LocalBridgeError, isEnoent } from "@localbridge/shared";

import { assertNoReservedNames, isContained } from "./paths.js";

export interface WriteTarget {
  /** Ruta relativa normalizada con separadores '/', tal y como se le presenta al cliente. */
  relativePath: string;
  /** Directorio padre, real y verificado, donde debe ocurrir la escritura. */
  realParentDir: string;
  /** Último segmento de la ruta (el nombre del archivo). */
  basename: string;
  /** Si YA existe algo (no symlink) exactamente en esa posición. */
  exists: boolean;
  type?: "file" | "dir";
}

export interface ResolveWriteTargetOptions {
  /**
   * Si `true` (solo `file.create`), crea los directorios intermedios que
   * falten, verificando cada nivel. Si `false` (`file.write_guarded`), un
   * directorio intermedio ausente se trata igual que un archivo ausente:
   * `exists: false`, sin crear nada — no tiene sentido preparar directorios
   * para una operación que va a fallar con `FILE_NOT_FOUND`.
   */
  createParentDirs: boolean;
}

export async function resolveWriteTarget(
  rootPath: string,
  inputRelativePath: string,
  options: ResolveWriteTargetOptions,
): Promise<WriteTarget> {
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
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  const basename = path.basename(target);
  const parentSegments = path
    .relative(rootPath, path.dirname(target))
    .split(path.sep)
    .filter((segment) => segment.length > 0);

  const walk = await walkParentChain(realRoot, parentSegments, options.createParentDirs);
  const relativePath = rel.split(path.sep).join("/");

  if (!walk.reachedEnd) {
    // Un directorio intermedio falta y no se nos pidió crearlo: el target,
    // estructuralmente, tampoco existe.
    return { relativePath, realParentDir: walk.realDir, basename, exists: false };
  }

  const leafPath = path.join(walk.realDir, basename);
  let leafStat;
  try {
    leafStat = await lstat(leafPath);
  } catch (error) {
    if (isEnoent(error)) {
      return { relativePath, realParentDir: walk.realDir, basename, exists: false };
    }
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  if (leafStat.isSymbolicLink()) {
    // Colgante o no, interno o externo: se rechaza sin excepción (ADR-0013).
    throw new LocalBridgeError("SYMLINK_ESCAPE");
  }

  return {
    relativePath,
    realParentDir: walk.realDir,
    basename,
    exists: true,
    type: leafStat.isDirectory() ? "dir" : "file",
  };
}

interface WalkResult {
  /** Real y verificado hasta donde llegó la caminata. */
  realDir: string;
  /** `false` si se detuvo antes de tiempo porque falta un segmento y no se pidió crearlo. */
  reachedEnd: boolean;
}

async function walkParentChain(realRoot: string, segments: string[], createMissing: boolean): Promise<WalkResult> {
  let currentReal = realRoot;

  for (const segment of segments) {
    const next = path.join(currentReal, segment);

    let stats;
    try {
      // eslint-disable-next-line no-await-in-loop -- cada segmento depende del real path verificado del anterior
      stats = await lstat(next);
    } catch (error) {
      if (!isEnoent(error)) {
        throw new LocalBridgeError("INTERNAL_ERROR");
      }
      if (!createMissing) {
        return { realDir: currentReal, reachedEnd: false };
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- idem
        await mkdir(next);
        currentReal = next; // recién creado: su realpath es exactamente `next`, sin symlinks de por medio
        continue;
      } catch (mkdirError) {
        if (!isEexist(mkdirError)) {
          throw new LocalBridgeError("INTERNAL_ERROR");
        }
        // Otra operación concurrente creó este mismo segmento entre nuestro
        // `lstat` y este `mkdir` (dos file.create en un directorio nuevo
        // compartido, en claves de mutex distintas). No es un fallo: caemos al
        // mismo camino de verificación que un directorio ya existente.
        // eslint-disable-next-line no-await-in-loop -- idem
        currentReal = await verifyExistingDirectorySegment(next, realRoot);
        continue;
      }
    }

    if (stats.isSymbolicLink()) {
      throw new LocalBridgeError("SYMLINK_ESCAPE");
    }
    if (!stats.isDirectory()) {
      throw new LocalBridgeError("NOT_A_FILE");
    }

    // eslint-disable-next-line no-await-in-loop -- idem
    currentReal = await verifyExistingDirectorySegment(next, realRoot);
  }

  return { realDir: currentReal, reachedEnd: true };
}

/** Confirma que un segmento ya existente es un directorio real contenido en el root, y devuelve su realpath. */
async function verifyExistingDirectorySegment(segmentPath: string, realRoot: string): Promise<string> {
  let stats;
  try {
    stats = await lstat(segmentPath);
  } catch {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }
  if (stats.isSymbolicLink()) {
    throw new LocalBridgeError("SYMLINK_ESCAPE");
  }
  if (!stats.isDirectory()) {
    throw new LocalBridgeError("NOT_A_FILE");
  }

  let real: string;
  try {
    real = await fsRealpath(segmentPath);
  } catch {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }
  if (!isContained(realRoot, real)) {
    throw new LocalBridgeError("SYMLINK_ESCAPE");
  }
  return real;
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "EEXIST";
}
