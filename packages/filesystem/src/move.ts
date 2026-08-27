/**
 * `file.move` (TOOL_CATALOG.md §9-bis, v2.4). Mueve o renombra un archivo
 * dentro del workspace — nunca fuera de él, en ninguno de los dos extremos.
 * Mismo posicionamiento que `file.delete`: guarda por hash, permiso
 * `overwrite`, sin aprobación MRTR.
 *
 * Si el destino ya existe, falla con `FILE_ALREADY_EXISTS` — nunca lo
 * sobrescribe implícitamente. Igual invariante que `file.create`: crear (aquí,
 * aparecer en el destino) y sobrescribir son actos separados; si de verdad se
 * quiere reemplazar el destino, hace falta borrarlo primero con su propia
 * llamada guardada por hash.
 */

import { createHash } from "node:crypto";
import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveWriteTarget, type AuthorizedWorkspace } from "@localbridge/workspace";

import { mutationLockKey, withMutationLock } from "./mutex.js";

export interface FileMoveResult {
  sourcePath: string;
  destPath: string;
  sha256: string;
  size: number;
}

export async function moveWorkspaceFile(
  workspace: AuthorizedWorkspace,
  sourceRelativePath: string,
  destRelativePath: string,
  expectedSha256: string,
): Promise<FileMoveResult> {
  const sourceInitial = await resolveWriteTarget(workspace.rootPath, sourceRelativePath, { createParentDirs: false });
  if (isPathDenied(sourceInitial.relativePath, workspace.denyPatterns)) {
    throw new LocalBridgeError("PATH_DENIED");
  }

  const destInitial = await resolveWriteTarget(workspace.rootPath, destRelativePath, { createParentDirs: true });
  if (isPathDenied(destInitial.relativePath, workspace.denyPatterns)) {
    throw new LocalBridgeError("PATH_DENIED");
  }

  if (sourceInitial.relativePath === destInitial.relativePath) {
    // Además de no tener sentido, dos locks sobre la misma clave se
    // interbloquearían (el mutex no es reentrante) — se rechaza antes de
    // intentar adquirir nada.
    throw new LocalBridgeError("INVALID_INPUT", { reason: "source and destination are the same path" });
  }

  // Orden canónico (lexicográfico), no el orden origen/destino de esta
  // llamada: dos `file.move` concurrentes con origen y destino intercambiados
  // (A→B y B→A a la vez) deben pelear por el mismo primer lock en el mismo
  // orden, o se interbloquean en vez de serializarse.
  const [lowerPath, higherPath] = [sourceInitial.relativePath, destInitial.relativePath].toSorted() as [string, string];
  const firstKey = mutationLockKey(workspace.id, lowerPath);
  const secondKey = mutationLockKey(workspace.id, higherPath);

  return withMutationLock(firstKey, () =>
    withMutationLock(secondKey, async () => {
      const source = await resolveWriteTarget(workspace.rootPath, sourceRelativePath, { createParentDirs: false });
      if (!source.exists) {
        throw new LocalBridgeError("FILE_NOT_FOUND");
      }
      if (source.type !== "file") {
        throw new LocalBridgeError("NOT_A_FILE");
      }

      const sourcePath = path.join(source.realParentDir, source.basename);

      let stats;
      try {
        stats = await stat(sourcePath);
      } catch {
        throw new LocalBridgeError("INTERNAL_ERROR");
      }
      if (stats.size > workspace.limits.maxFileBytes) {
        throw new LocalBridgeError("FILE_TOO_LARGE");
      }

      const buffer = await readFile(sourcePath);
      const currentSha256 = createHash("sha256").update(buffer).digest("hex");
      if (currentSha256 !== expectedSha256) {
        throw new LocalBridgeError("HASH_MISMATCH");
      }

      // Revalidación del destino dentro del lock: pudo aparecer algo entre la
      // primera pasada y aquí. No se crean directorios en esta segunda pasada
      // (ya se crearon, si hacía falta, en la primera fuera del lock).
      const dest = await resolveWriteTarget(workspace.rootPath, destRelativePath, { createParentDirs: false });
      if (dest.exists) {
        throw new LocalBridgeError("FILE_ALREADY_EXISTS");
      }

      const destPath = path.join(dest.realParentDir, dest.basename);
      await rename(sourcePath, destPath);

      return { sourcePath: source.relativePath, destPath: dest.relativePath, sha256: currentSha256, size: buffer.byteLength };
    }),
  );
}
