import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import { isEnoent, LocalBridgeError } from '@localbridge/shared';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

import { MAX_BINARY_RANGE_BYTES } from './read-binary-range.js';
import { resolveAllowedPath } from './guard.js';

const SEQUENTIAL_CHUNK_BYTES = 1024 * 1024;

export interface ArtifactSourceIdentity {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly fileIdentity: string;
  readonly sha256State: 'not-requested' | 'running' | 'complete' | 'failed';
}

export interface ArtifactSourceCounters {
  readonly bytesRead: number;
  readonly uniqueBytesRead: number;
  readonly rangesRead: number;
}

export interface WorkspaceArtifactSource {
  readonly identity: ArtifactSourceIdentity;
  counters(): ArtifactSourceCounters;
  readRange(offset: number, length: number): Promise<Buffer>;
  readSequential(options?: { readonly start?: number; readonly signal?: AbortSignal }): AsyncGenerator<Buffer>;
  assertStable(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceArtifactSourceOptions {
  /** Techo compatible de la operación cuando el proyecto conserva `standard`. */
  readonly standardLimitBytes: number;
  readonly checkAuthority?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

function validatePositiveSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new LocalBridgeError('INVALID_INPUT');
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new LocalBridgeError('ANALYSIS_CANCELLED');
}

function enforceSourcePolicy(workspace: AuthorizedWorkspace, size: number, standardLimitBytes: number): void {
  validatePositiveSafeInteger(standardLimitBytes);
  const policy = workspace.limits.largeArtifacts;
  if (policy.mode === 'standard' && size > standardLimitBytes) throw new LocalBridgeError('FILE_TOO_LARGE');
  if (policy.mode === 'custom' && size > policy.customSourceBytes) throw new LocalBridgeError('FILE_TOO_LARGE');
}

function identityReceipt(workspace: AuthorizedWorkspace, relativePath: string, stats: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: workspace.id,
    relativePath,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
  })).digest('hex');
}

function addCoveredInterval(intervals: Array<[number, number]>, start: number, end: number): void {
  let nextStart = start;
  let nextEnd = end;
  for (let index = intervals.length - 1; index >= 0; index -= 1) {
    const current = intervals[index]!;
    if (current[1] < nextStart || current[0] > nextEnd) continue;
    nextStart = Math.min(nextStart, current[0]);
    nextEnd = Math.max(nextEnd, current[1]);
    intervals.splice(index, 1);
  }
  intervals.push([nextStart, nextEnd]);
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

export async function openWorkspaceArtifactSource(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  options: WorkspaceArtifactSourceOptions,
): Promise<WorkspaceArtifactSource> {
  assertNotAborted(options.signal);
  await options.checkAuthority?.();
  const safe = await resolveAllowedPath(workspace, relativePath);
  if (!safe.exists) throw new LocalBridgeError('FILE_NOT_FOUND');

  let handle: FileHandle | undefined;
  try {
    handle = await open(safe.realPath, 'r');
    const initial = await handle.stat();
    if (!initial.isFile()) throw new LocalBridgeError('NOT_A_FILE');
    enforceSourcePolicy(workspace, initial.size, options.standardLimitBytes);

    const receipt = identityReceipt(workspace, safe.relativePath, initial);
    const intervals: Array<[number, number]> = [];
    let bytesRead = 0;
    let rangesRead = 0;
    let closed = false;
    const stableHandle = handle;
    handle = undefined;

    const assertStable = async (): Promise<void> => {
      assertNotAborted(options.signal);
      if (closed) throw new LocalBridgeError('FILE_NOT_FOUND');
      await options.checkAuthority?.();
      const current = await stableHandle.stat();
      if (!current.isFile() || identityReceipt(workspace, safe.relativePath, current) !== receipt) {
        throw new LocalBridgeError('HASH_MISMATCH');
      }
    };

    const readRange = async (offset: number, length: number): Promise<Buffer> => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 ||
        length > MAX_BINARY_RANGE_BYTES || offset >= initial.size || offset + length > initial.size) {
        throw new LocalBridgeError('INVALID_INPUT');
      }
      await assertStable();
      const output = Buffer.allocUnsafe(length);
      let completed = 0;
      while (completed < length) {
        assertNotAborted(options.signal);
        const { bytesRead: count } = await stableHandle.read(output, completed, length - completed, offset + completed);
        if (count < 1) throw new LocalBridgeError('HASH_MISMATCH');
        completed += count;
      }
      bytesRead += completed;
      rangesRead += 1;
      addCoveredInterval(intervals, offset, offset + completed);
      await assertStable();
      return output;
    };

    return {
      identity: {
        workspaceId: workspace.id,
        relativePath: safe.relativePath,
        size: initial.size,
        modifiedAt: initial.mtime.toISOString(),
        fileIdentity: receipt,
        sha256State: 'not-requested',
      },
      counters: () => ({
        bytesRead,
        uniqueBytesRead: intervals.reduce((total, [start, end]) => total + end - start, 0),
        rangesRead,
      }),
      readRange,
      readSequential: async function* ({ start = 0, signal } = {}) {
        if (!Number.isSafeInteger(start) || start < 0 || start > initial.size) throw new LocalBridgeError('INVALID_INPUT');
        let offset = start;
        while (offset < initial.size) {
          assertNotAborted(signal);
          const length = Math.min(SEQUENTIAL_CHUNK_BYTES, initial.size - offset);
          yield await readRange(offset, length);
          offset += length;
        }
      },
      assertStable,
      close: async () => {
        if (closed) return;
        closed = true;
        await stableHandle.close();
      },
    };
  } catch (error) {
    await closeQuietly(handle);
    if (isEnoent(error)) throw new LocalBridgeError('FILE_NOT_FOUND');
    throw error;
  }
}
