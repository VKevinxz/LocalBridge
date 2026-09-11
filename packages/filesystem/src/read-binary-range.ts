/** Acceso binario por rangos para parsers cerrados de archivos grandes. */

import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

import { LocalBridgeError, isEnoent } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";

const HASH_CHUNK_BYTES = 1024 * 1024;
export const MAX_BINARY_RANGE_BYTES = 4 * 1024 * 1024;

export interface WorkspaceBinaryRangeReader {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly modifiedAt: string;
  /** Señal pasiva fuera de streams, comentarios y strings PDF; nunca contiene contenido. */
  readonly hasActivePdfSyntax: boolean;
  readRange(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

interface PdfSyntaxScanState {
  inStream: boolean;
  inComment: boolean;
  inHexString: boolean;
  pendingLessThan: boolean;
  stringDepth: number;
  escaped: boolean;
  structuralWindow: string;
  streamEndWindow: string;
}

function scanPdfActiveSyntax(state: PdfSyntaxScanState, bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  for (const character of text) {
    if (state.inStream) {
      state.streamEndWindow = `${state.streamEndWindow}${character}`.slice(-9);
      if (state.streamEndWindow === "endstream") {
        state.inStream = false;
        state.streamEndWindow = "";
        state.structuralWindow = "";
      }
      continue;
    }
    if (state.inComment) {
      if (character === "\r" || character === "\n") state.inComment = false;
      else continue;
    }
    if (state.inHexString) {
      if (character === ">") state.inHexString = false;
      continue;
    }
    if (state.stringDepth > 0) {
      if (state.escaped) state.escaped = false;
      else if (character === "\\") state.escaped = true;
      else if (character === "(") state.stringDepth += 1;
      else if (character === ")") state.stringDepth -= 1;
      continue;
    }
    if (state.pendingLessThan) {
      state.pendingLessThan = false;
      if (character === "<") {
        state.structuralWindow = `${state.structuralWindow}<<`.slice(-128);
      } else {
        state.inHexString = character !== ">";
      }
      continue;
    }
    if (character === "%") {
      state.inComment = true;
      continue;
    }
    if (character === "(") {
      state.stringDepth = 1;
      state.escaped = false;
      continue;
    }
    if (character === "<") {
      state.pendingLessThan = true;
      continue;
    }
    state.structuralWindow = `${state.structuralWindow}${character}`.slice(-128);
    if (/\/(?:JavaScript|OpenAction|AA)\b/.test(state.structuralWindow)) return true;
    if ((character === "\r" || character === "\n") && /(?:^|\s)stream[\r\n]+$/.test(state.structuralWindow)) {
      state.inStream = true;
      state.streamEndWindow = "";
      state.structuralWindow = "";
    }
  }
  return false;
}

export interface WorkspaceBinaryRangeOptions {
  readonly hardLimitBytes: number;
  /** Revalida la autoridad local durante hash y lecturas largas. */
  readonly checkAuthority?: () => Promise<void>;
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) {
    throw new LocalBridgeError("INVALID_INPUT");
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  await handle.close().catch(() => undefined);
}

export async function openWorkspaceBinaryRangeReader(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  options: WorkspaceBinaryRangeOptions,
): Promise<WorkspaceBinaryRangeReader> {
  validateLimit(options.hardLimitBytes);
  await options.checkAuthority?.();
  const safe = await resolveAllowedPath(workspace, relativePath);
  if (!safe.exists) throw new LocalBridgeError("FILE_NOT_FOUND");

  let handle: FileHandle | undefined;
  try {
    handle = await open(safe.realPath, "r");
    const before = await handle.stat();
    if (!before.isFile()) throw new LocalBridgeError("NOT_A_FILE");
    if (before.size > options.hardLimitBytes) throw new LocalBridgeError("FILE_TOO_LARGE");

    const hash = createHash("sha256");
    const syntaxState: PdfSyntaxScanState = {
      inStream: false,
      inComment: false,
      inHexString: false,
      pendingLessThan: false,
      stringDepth: 0,
      escaped: false,
      structuralWindow: "",
      streamEndWindow: "",
    };
    let hasActivePdfSyntax = false;
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      await options.checkAuthority?.();
      const requested = Math.min(buffer.byteLength, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead < 1) throw new LocalBridgeError("HASH_MISMATCH");
      hash.update(buffer.subarray(0, bytesRead));
      if (!hasActivePdfSyntax) hasActivePdfSyntax = scanPdfActiveSyntax(syntaxState, buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterHash = await handle.stat();
    if (afterHash.size !== before.size || afterHash.mtimeMs !== before.mtimeMs) {
      throw new LocalBridgeError("HASH_MISMATCH");
    }

    let closed = false;
    const stableHandle = handle;
    handle = undefined;
    const assertStable = async (): Promise<void> => {
      if (closed) throw new LocalBridgeError("FILE_NOT_FOUND");
      await options.checkAuthority?.();
      const current = await stableHandle.stat();
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
        throw new LocalBridgeError("HASH_MISMATCH");
      }
    };

    return {
      path: safe.relativePath,
      sha256: hash.digest("hex"),
      size: before.size,
      modifiedAt: before.mtime.toISOString(),
      hasActivePdfSyntax,
      readRange: async (rangeOffset, length) => {
        if (!Number.isSafeInteger(rangeOffset) || rangeOffset < 0 ||
          !Number.isSafeInteger(length) || length < 1 || length > MAX_BINARY_RANGE_BYTES ||
          rangeOffset >= before.size || rangeOffset + length > before.size) {
          throw new LocalBridgeError("INVALID_INPUT");
        }
        await assertStable();
        const output = Buffer.allocUnsafe(length);
        let completed = 0;
        while (completed < length) {
          const { bytesRead } = await stableHandle.read(output, completed, length - completed, rangeOffset + completed);
          if (bytesRead < 1) throw new LocalBridgeError("HASH_MISMATCH");
          completed += bytesRead;
        }
        await assertStable();
        return output;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await stableHandle.close();
      },
    };
  } catch (error) {
    await closeQuietly(handle);
    if (isEnoent(error)) throw new LocalBridgeError("FILE_NOT_FOUND");
    throw error;
  }
}
