/** `file.metadata` (TOOL_CATALOG.md §5). */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { LocalBridgeError } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";

export interface FileMetadataResult {
  path: string;
  exists: boolean;
  type?: "file" | "dir";
  size?: number;
  sha256?: string;
  modifiedAt?: string;
}

export async function getFileMetadata(workspace: AuthorizedWorkspace, relativePath: string): Promise<FileMetadataResult> {
  const safe = await resolveAllowedPath(workspace, relativePath);

  // Un archivo inexistente es una consulta legítima, no un fallo (TOOL_CATALOG §5).
  if (!safe.exists) {
    return { path: safe.relativePath, exists: false };
  }

  let stats;
  try {
    stats = await stat(safe.realPath);
  } catch {
    // `safe.exists` acaba de confirmar que resolvía; un fallo aquí es una
    // condición de carrera genuina, no una entrada del agente.
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  if (stats.isDirectory()) {
    return { path: safe.relativePath, exists: true, type: "dir" };
  }

  if (!stats.isFile()) {
    return { path: safe.relativePath, exists: true };
  }

  // Mismo techo que file.read (SEC-011): metadata también hashea el archivo
  // completo, así que no puede convertirse en una vía indirecta para forzar la
  // lectura de un archivo que file.read rechazaría por tamaño.
  if (stats.size > workspace.limits.maxFileBytes) {
    throw new LocalBridgeError("FILE_TOO_LARGE");
  }

  const buffer = await readFile(safe.realPath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  return {
    path: safe.relativePath,
    exists: true,
    type: "file",
    size: buffer.byteLength,
    sha256,
    modifiedAt: stats.mtime.toISOString(),
  };
}
