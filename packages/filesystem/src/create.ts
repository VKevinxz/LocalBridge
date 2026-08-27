/** `file.create` (TOOL_CATALOG.md §6). */

import { createHash } from "node:crypto";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveWriteTarget, type AuthorizedWorkspace } from "@localbridge/workspace";

import { atomicWrite } from "./atomic-write.js";
import { mutationLockKey, withMutationLock } from "./mutex.js";

export interface FileCreateResult {
  path: string;
  sha256: string;
  size: number;
  created: true;
}

export async function createWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  content: string,
): Promise<FileCreateResult> {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength > workspace.limits.maxFileBytes) {
    throw new LocalBridgeError("FILE_TOO_LARGE");
  }

  // Primera pasada fuera del mutex: valida la ruta y crea los directorios
  // padre que falten. Aceptamos como compromiso menor que, si el resultado
  // termina denegado por la denylist, pueda quedar un directorio vacío creado
  // de más — no escribe contenido en ningún sitio, así que no es un problema
  // de seguridad, solo una limpieza cosmética pendiente.
  const target = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: true });

  if (isPathDenied(target.relativePath, workspace.denyPatterns)) {
    throw new LocalBridgeError("PATH_DENIED");
  }

  return withMutationLock(mutationLockKey(workspace.id, target.relativePath), async () => {
    // Revalidación dentro del mutex (ADR-0013): otra operación pudo crear el
    // archivo, o sustituir el segmento final por un symlink, entre la primera
    // pasada y la adquisición del lock. No se crean directorios aquí: si algo
    // desapareció, es una condición de carrera genuina, no algo que arreglar
    // silenciosamente.
    const revalidated = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });

    if (revalidated.exists) {
      throw new LocalBridgeError("FILE_ALREADY_EXISTS");
    }

    await atomicWrite(revalidated.realParentDir, revalidated.basename, buffer);

    return {
      path: target.relativePath,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.byteLength,
      created: true as const,
    };
  });
}
