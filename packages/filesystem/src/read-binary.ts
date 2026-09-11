/** Lectura binaria interna para parsers cerrados; nunca expone una ruta absoluta. */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { LocalBridgeError, isEnoent } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";

export interface WorkspaceBinaryReadResult {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export async function readWorkspaceBinaryFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  hardLimitBytes?: number,
): Promise<WorkspaceBinaryReadResult> {
  const safe = await resolveAllowedPath(workspace, relativePath);
  if (!safe.exists) throw new LocalBridgeError("FILE_NOT_FOUND");

  let stats;
  try {
    stats = await stat(safe.realPath);
  } catch (error) {
    if (isEnoent(error)) throw new LocalBridgeError("FILE_NOT_FOUND");
    throw new LocalBridgeError("INTERNAL_ERROR");
  }
  if (!stats.isFile()) throw new LocalBridgeError("NOT_A_FILE");

  const effectiveLimit = hardLimitBytes ?? workspace.limits.maxFileBytes;
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > 1024 * 1024 * 1024) {
    throw new LocalBridgeError('INVALID_INPUT');
  }
  if (stats.size > effectiveLimit) throw new LocalBridgeError("FILE_TOO_LARGE");

  const bytes = await readFile(safe.realPath);
  if (bytes.byteLength > effectiveLimit) throw new LocalBridgeError("FILE_TOO_LARGE");
  return {
    path: safe.relativePath,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    modifiedAt: stats.mtime.toISOString(),
  };
}
