/** Publicación transaccional de un directorio nuevo dentro de un workspace. */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';

import { LocalBridgeError, isLocalBridgeError } from '@localbridge/shared';
import { isPathDenied, resolveSafePath, resolveWriteTarget, type AuthorizedWorkspace } from '@localbridge/workspace';

import { atomicWrite } from './atomic-write.js';
import { mutationLockKey, withMutationLock } from './mutex.js';
import { runAuthorizedEffect, type MutationOptions } from './mutation-options.js';

const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TRUSTED_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_TRUSTED_ARTIFACT_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_DISK_RESERVE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 64;
const MAX_RECOVERY_ENTRIES = 50_000;
const MAX_RECOVERY_DEPTH = 32;
const STAGING_NAME = /^\..{1,255}\.lbtmp-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGING_MARKER_NAME = '.localbridge-artifact-staging-v1';
const STAGING_MARKER_CONTENT = 'localbridge-artifact-staging-v1\n';
const RECOVERY_SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.pnpm-store']);

export interface ArtifactFileReceipt {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface WorkspaceArtifactWriter {
  write(relativePath: string, bytes: Uint8Array): Promise<ArtifactFileReceipt>;
  ensureCapacity(requiredBytes: number): Promise<void>;
  readonly totalSize: number;
  readonly fileCount: number;
  /** Límite efectivo por archivo para este artefacto autorizado. */
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface ArtifactDirectoryOptions extends MutationOptions {
  readonly maxTotalBytes?: number;
  /** Autoridad interna acotada para binarios administrados; nunca viene de MCP. */
  readonly maxFileBytes?: number;
  /** Espacio que debe seguir libre mientras se construye el artefacto. */
  readonly reserveFreeBytes?: number;
}

export interface WorkspaceArtifactDirectoryResult<T> {
  readonly path: string;
  readonly created: true;
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly ArtifactFileReceipt[];
  readonly value: T;
}

export interface ArtifactStagingCleanupResult {
  readonly removed: number;
  readonly scanned: number;
  readonly truncated: boolean;
}

/** Recupera staging abandonado tras un cierre abrupto sin seguir symlinks o junctions. */
export async function cleanupWorkspaceArtifactStaging(
  workspace: AuthorizedWorkspace,
  options: MutationOptions = {},
): Promise<ArtifactStagingCleanupResult> {
  if (!workspace.enabled) throw new LocalBridgeError('WORKSPACE_DISABLED');
  if (!workspace.permissions.write) throw new LocalBridgeError('CAPABILITY_DISABLED');
  return runAuthorizedEffect(options, async () => {
    const root = await resolveSafePath(workspace.rootPath, '.');
    const queue: Array<{ realPath: string; relativePath: string; depth: number }> = [
      { realPath: root.realPath, relativePath: '', depth: 0 },
    ];
    let removed = 0;
    let scanned = 0;
    while (queue.length > 0 && scanned < MAX_RECOVERY_ENTRIES) {
      const current = queue.shift()!;
      let entries;
      try { entries = await readdir(current.realPath, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_RECOVERY_ENTRIES) break;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relativePath = current.relativePath === '' ? entry.name : `${current.relativePath}/${entry.name}`;
        if (isPathDenied(relativePath, workspace.denyPatterns)) continue;
        if (STAGING_NAME.test(entry.name)) {
          const target = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
          if (target.exists && target.type === 'dir') {
            const markerPath = path.join(target.realParentDir, target.basename, STAGING_MARKER_NAME);
            const marker = await readFile(markerPath, 'utf8').catch(() => undefined);
            if (marker === STAGING_MARKER_CONTENT) {
              await rm(path.join(target.realParentDir, target.basename), { recursive: true, force: false });
              removed += 1;
            }
          }
          continue;
        }
        if (current.depth < MAX_RECOVERY_DEPTH && !RECOVERY_SKIP_DIRECTORIES.has(entry.name)) {
          const child = await resolveSafePath(workspace.rootPath, relativePath);
          if (child.exists) queue.push({ realPath: child.realPath, relativePath, depth: current.depth + 1 });
        }
      }
    }
    return { removed, scanned: Math.min(scanned, MAX_RECOVERY_ENTRIES), truncated: queue.length > 0 || scanned > MAX_RECOVERY_ENTRIES };
  });
}

export async function createWorkspaceArtifactDirectory<T>(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  produce: (writer: WorkspaceArtifactWriter) => Promise<T>,
  options: ArtifactDirectoryOptions = {},
): Promise<WorkspaceArtifactDirectoryResult<T>> {
  const maximumTotal = options.maxTotalBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maximumFile = options.maxFileBytes ?? workspace.limits.maxFileBytes;
  const reserveFreeBytes = options.reserveFreeBytes ?? 0;
  if (!Number.isSafeInteger(maximumTotal) || maximumTotal < 1 || maximumTotal > MAX_TRUSTED_ARTIFACT_BYTES ||
      !Number.isSafeInteger(maximumFile) || maximumFile < 1 || maximumFile > MAX_TRUSTED_ARTIFACT_FILE_BYTES ||
      !Number.isSafeInteger(reserveFreeBytes) || reserveFreeBytes < 0 || reserveFreeBytes > MAX_DISK_RESERVE_BYTES) {
    throw new LocalBridgeError('INVALID_INPUT');
  }

  const initial = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
  if (isPathDenied(initial.relativePath, workspace.denyPatterns)) throw new LocalBridgeError('PATH_DENIED');

  return withMutationLock(mutationLockKey(workspace.id, initial.relativePath), async () =>
    runAuthorizedEffect(options, async () => {
      const destination = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: true });
      if (destination.exists) throw new LocalBridgeError('FILE_ALREADY_EXISTS');

      const stagingBasename = `.${destination.basename}.lbtmp-${randomUUID()}`;
      const stagingPath = path.join(destination.realParentDir, stagingBasename);
      await mkdir(stagingPath);
      try {
        await atomicWrite(stagingPath, STAGING_MARKER_NAME, Buffer.from(STAGING_MARKER_CONTENT, 'utf8'));
      } catch (error) {
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      let complete = false;
      const receipts: ArtifactFileReceipt[] = [];
      let totalSize = 0;
      const writer: WorkspaceArtifactWriter = {
        get totalSize() { return totalSize; },
        get fileCount() { return receipts.length; },
        get maxFileBytes() { return maximumFile; },
        get maxTotalBytes() { return maximumTotal; },
        ensureCapacity: async (requiredBytes) => {
          if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new LocalBridgeError('INVALID_INPUT');
          if (totalSize + requiredBytes > maximumTotal) throw new LocalBridgeError('FILE_TOO_LARGE');
          if (reserveFreeBytes > 0) {
            const capacity = await statfs(stagingPath);
            const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
            if (!Number.isSafeInteger(availableBytes) || availableBytes - requiredBytes < reserveFreeBytes) {
              throw new LocalBridgeError('INSUFFICIENT_DISK_SPACE');
            }
          }
        },
        write: async (childPath, inputBytes) => {
          if (receipts.length >= MAX_ARTIFACT_FILES) throw new LocalBridgeError('RATE_LIMITED', { reason: 'artifact file count exceeded' });
          const bytes = Buffer.from(inputBytes);
          if (bytes.byteLength > maximumFile || totalSize + bytes.byteLength > maximumTotal) {
            throw new LocalBridgeError('FILE_TOO_LARGE');
          }
          const child = await resolveWriteTarget(stagingPath, childPath, { createParentDirs: true });
          const finalChildPath = `${destination.relativePath}/${child.relativePath}`;
          if (isPathDenied(finalChildPath, workspace.denyPatterns)) throw new LocalBridgeError('PATH_DENIED');
          if (child.exists || receipts.some((receipt) => receipt.path === child.relativePath)) {
            throw new LocalBridgeError('FILE_ALREADY_EXISTS');
          }
          if (reserveFreeBytes > 0) {
            const capacity = await statfs(child.realParentDir);
            const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
            if (!Number.isSafeInteger(availableBytes) || availableBytes - bytes.byteLength < reserveFreeBytes) {
              throw new LocalBridgeError('INSUFFICIENT_DISK_SPACE');
            }
          }
          await atomicWrite(child.realParentDir, child.basename, bytes);
          const receipt = {
            path: child.relativePath,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.byteLength,
          };
          receipts.push(receipt);
          totalSize += bytes.byteLength;
          return receipt;
        },
      };

      try {
        const value = await produce(writer);
        if (receipts.length === 0) throw new LocalBridgeError('INVALID_INPUT', { reason: 'artifact cannot be empty' });

        const currentDestination = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
        if (currentDestination.exists) throw new LocalBridgeError('FILE_ALREADY_EXISTS');
        const parentRelative = path.posix.dirname(currentDestination.relativePath);
        const stagingRelative = parentRelative === '.' ? stagingBasename : `${parentRelative}/${stagingBasename}`;
        const currentStaging = await resolveWriteTarget(workspace.rootPath, stagingRelative, { createParentDirs: false });
        if (!currentStaging.exists || currentStaging.type !== 'dir' ||
            currentStaging.realParentDir !== currentDestination.realParentDir) {
          throw new LocalBridgeError('SYMLINK_ESCAPE');
        }
        await rename(
          path.join(currentStaging.realParentDir, currentStaging.basename),
          path.join(currentDestination.realParentDir, currentDestination.basename),
        );
        complete = true;
        await unlink(path.join(currentDestination.realParentDir, currentDestination.basename, STAGING_MARKER_NAME)).catch(() => undefined);
        return {
          path: currentDestination.relativePath,
          created: true as const,
          totalSize,
          fileCount: receipts.length,
          files: receipts,
          value,
        };
      } catch (error) {
        if (isLocalBridgeError(error) || error instanceof Error) throw error;
        throw new LocalBridgeError('INTERNAL_ERROR');
      } finally {
        if (!complete) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
}
