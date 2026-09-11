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
  lineRange?: {
    startLine: number;
    endLine: number;
    totalLines: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
  };
}

export interface FileReadOptions {
  readonly startLine?: number;
  readonly endLine?: number;
}

export async function readWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  requestedMaxBytes: number | undefined,
  options: FileReadOptions = {},
): Promise<FileReadResult> {
  if ((options.startLine !== undefined && (!Number.isInteger(options.startLine) || options.startLine < 1))
    || (options.endLine !== undefined && (!Number.isInteger(options.endLine) || options.endLine < 1))) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "line numbers must be positive integers" });
  }
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
  let selected = buffer;
  let lineRange: FileReadResult["lineRange"];
  if (options.startLine !== undefined || options.endLine !== undefined) {
    const startLine = options.startLine ?? 1;
    const text = buffer.toString("utf8");
    const lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n" && index + 1 < text.length) lineStarts.push(index + 1);
    }
    const totalLines = lineStarts.length;
    if (startLine > totalLines) throw new LocalBridgeError("INVALID_INPUT", { reason: "startLine exceeds file length" });
    const endLine = Math.min(options.endLine ?? Math.min(totalLines, startLine + 499), totalLines);
    if (endLine < startLine || endLine - startLine + 1 > 2_000) {
      throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid line range" });
    }
    const startOffset = lineStarts[startLine - 1] ?? 0;
    const endOffset = endLine < totalLines ? lineStarts[endLine] ?? text.length : text.length;
    selected = Buffer.from(text.slice(startOffset, endOffset), "utf8");
    lineRange = { startLine, endLine, totalLines, hasMoreBefore: startLine > 1, hasMoreAfter: endLine < totalLines };
  }
  const truncated = selected.byteLength > effectiveMaxBytes;

  return {
    path: safe.relativePath,
    content: selected.subarray(0, effectiveMaxBytes).toString("utf8"),
    sha256,
    size: buffer.byteLength,
    truncated,
    modifiedAt: stats.mtime.toISOString(),
    ...(lineRange === undefined ? {} : { lineRange }),
  };
}
