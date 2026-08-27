/** `file.read` (TOOL_CATALOG.md §4). */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { LocalBridgeError, isEnoent } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";

export interface FileReadResult {
  path: string;
  content: string;
  sha256: string;
  size: number;
  truncated: boolean;
  modifiedAt: string;
}

export async function readWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  requestedMaxBytes: number | undefined,
): Promise<FileReadResult> {
  const safe = await resolveAllowedPath(workspace, relativePath);

  // Si el target no existe, `safe.realPath` es el de su ancestro existente más
  // cercano (SECURITY.md §3.3) — casi siempre un directorio. Sin esta
  // comprobación, el `stat` de abajo lo vería como "no es un archivo" y
  // devolvería NOT_A_FILE en vez de FILE_NOT_FOUND.
  if (!safe.exists) {
    throw new LocalBridgeError("FILE_NOT_FOUND");
  }

  let stats;
  try {
    stats = await stat(safe.realPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new LocalBridgeError("FILE_NOT_FOUND");
    }
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  if (!stats.isFile()) {
    throw new LocalBridgeError("NOT_A_FILE");
  }

  // SEC-011: se comprueba el tamaño vía stat ANTES de leer. Un archivo que excede
  // el techo del workspace nunca se carga en memoria.
  if (stats.size > workspace.limits.maxFileBytes) {
    throw new LocalBridgeError("FILE_TOO_LARGE");
  }

  const effectiveMaxBytes = Math.min(requestedMaxBytes ?? workspace.limits.maxFileBytes, workspace.limits.maxFileBytes);

  const buffer = await readFile(safe.realPath);
  // El hash es siempre del contenido completo leído del disco, nunca del
  // fragmento truncado — es lo que hace útil `expectedSha256` en la Fase 3.
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const truncated = buffer.byteLength > effectiveMaxBytes;

  return {
    path: safe.relativePath,
    content: buffer.subarray(0, effectiveMaxBytes).toString("utf8"),
    sha256,
    size: buffer.byteLength,
    truncated,
    modifiedAt: stats.mtime.toISOString(),
  };
}
