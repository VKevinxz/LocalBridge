/** `file.write_guarded` (TOOL_CATALOG.md §7). */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveWriteTarget, type AuthorizedWorkspace } from "@localbridge/workspace";

import { atomicWrite } from "./atomic-write.js";
import { mutationLockKey, withMutationLock } from "./mutex.js";

export interface FileWriteGuardedResult {
  path: string;
  sha256: string;
  size: number;
  previousSha256: string;
}

export async function writeGuardedWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  expectedSha256: string,
  content: string,
): Promise<FileWriteGuardedResult> {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength > workspace.limits.maxFileBytes) {
    throw new LocalBridgeError("FILE_TOO_LARGE");
  }

  const initial = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
  if (isPathDenied(initial.relativePath, workspace.denyPatterns)) {
    throw new LocalBridgeError("PATH_DENIED");
  }

  return withMutationLock(mutationLockKey(workspace.id, initial.relativePath), async () => {
    // Recálculo dentro del mutex, inmediatamente antes de escribir (ADR-0005):
    // no basta con lo que sabíamos al validar la entrada, porque el archivo
    // pudo cambiar entretanto.
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
    if (stats.size > workspace.limits.maxFileBytes) {
      throw new LocalBridgeError("FILE_TOO_LARGE");
    }

    const currentBuffer = await readFile(targetPath);
    const previousSha256 = createHash("sha256").update(currentBuffer).digest("hex");

    if (previousSha256 !== expectedSha256) {
      throw new LocalBridgeError("HASH_MISMATCH");
    }

    await atomicWrite(current.realParentDir, current.basename, buffer);

    return {
      path: current.relativePath,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.byteLength,
      previousSha256,
    };
  });
}
