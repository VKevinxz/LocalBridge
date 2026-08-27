/**
 * `file.delete` (TOOL_CATALOG.md §9-bis, v2.4).
 *
 * Guarda por hash, igual patrón que `file.write_guarded` — no aprobación MRTR
 * como `git.commit`/`git.push`. Decisión deliberada: borrar un archivo dentro
 * de un workspace ya autorizado con permiso `overwrite` es la misma clase de
 * riesgo que reemplazar su contenido (ambas destruyen el estado anterior sin
 * posibilidad de deshacer desde este servidor), y `file.write_guarded` ya
 * resuelve esa clase con hash-guard + permiso, no con un humano confirmando
 * cada llamada. Pedir aprobación aquí y no allí sería inconsistente sin una
 * razón de seguridad real que lo justifique — a diferencia de `git.push`, que
 * sí tiene una razón distinta y concreta (el efecto sale de la máquina).
 *
 * Solo borra **archivos**, nunca directorios: no hay recursión, no hay `-r`,
 * no hay forma de que una sola llamada borre más de una ruta.
 */

import { createHash } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveWriteTarget, type AuthorizedWorkspace } from "@localbridge/workspace";

import { mutationLockKey, withMutationLock } from "./mutex.js";

export interface FileDeleteResult {
  path: string;
  deleted: true;
}

export async function deleteWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  expectedSha256: string,
): Promise<FileDeleteResult> {
  const initial = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
  if (isPathDenied(initial.relativePath, workspace.denyPatterns)) {
    throw new LocalBridgeError("PATH_DENIED");
  }

  return withMutationLock(mutationLockKey(workspace.id, initial.relativePath), async () => {
    // Revalidación dentro del mutex (ADR-0005/ADR-0013): el archivo pudo
    // cambiar, desaparecer, o convertirse en symlink entre la primera pasada
    // y la adquisición del lock.
    const current = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });

    if (!current.exists) {
      throw new LocalBridgeError("FILE_NOT_FOUND");
    }
    if (current.type !== "file") {
      throw new LocalBridgeError("NOT_A_FILE");
    }

    const targetPath = path.join(current.realParentDir, current.basename);

    let stats;
    try {
      stats = await stat(targetPath);
    } catch {
      throw new LocalBridgeError("INTERNAL_ERROR");
    }
    // Mismo invariante que file.write_guarded: nunca se carga en memoria un
    // archivo que excede el techo del workspace, ni para hashearlo.
    if (stats.size > workspace.limits.maxFileBytes) {
      throw new LocalBridgeError("FILE_TOO_LARGE");
    }

    const buffer = await readFile(targetPath);
    const currentSha256 = createHash("sha256").update(buffer).digest("hex");
    if (currentSha256 !== expectedSha256) {
      throw new LocalBridgeError("HASH_MISMATCH");
    }

    await unlink(targetPath);

    return { path: current.relativePath, deleted: true as const };
  });
}
