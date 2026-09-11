/** Creación binaria exclusiva dentro de un workspace autorizado. */

import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveWriteTarget, type AuthorizedWorkspace } from "@localbridge/workspace";

import { atomicWrite } from "./atomic-write.js";
import { mutationLockKey, withMutationLock } from "./mutex.js";
import { runAuthorizedEffect, type MutationOptions } from "./mutation-options.js";

export interface WorkspaceBinaryCreateResult {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly created: true;
}

const MAX_TRUSTED_BINARY_BYTES = 1024 * 1024 * 1024;

export interface WorkspaceBinaryCreateOptions extends MutationOptions {
  /**
   * Límite ampliado aportado por una autoridad local específica, como un
   * perfil web. Nunca se expone como argumento MCP.
   */
  readonly maximumBytes?: number;
  /** Espacio que debe seguir libre tras publicar el archivo. */
  readonly reserveFreeBytes?: number;
  /** Solo para el escritor por chunks; elimina el techo de fuente, no los presupuestos físicos. */
  readonly adaptive?: boolean;
  /** Porcentaje del volumen que debe permanecer libre (0-50). */
  readonly reserveFreePercent?: number;
  /**
   * Revalida la autoridad de una transferencia larga sin mantener bloqueado el
   * registro local durante toda la E/S. Solo se usa por el escritor streaming;
   * la publicación final continúa dentro de `withAuthorizedEffect`.
   */
  readonly checkAuthority?: () => Promise<void>;
}

export interface WorkspaceBinaryStreamWriter {
  readonly size: number;
  write(chunk: Uint8Array): Promise<void>;
}

function validatedLimit(value: number | undefined, fallback: number, ceiling: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) throw new LocalBridgeError("INVALID_INPUT");
  return limit;
}

function validatedReserve(value: number | undefined): number {
  const reserve = value ?? 0;
  if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > Number.MAX_SAFE_INTEGER) {
    throw new LocalBridgeError("INVALID_INPUT");
  }
  return reserve;
}

function validatedReservePercent(value: number | undefined): number {
  const percent = value ?? 0;
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) throw new LocalBridgeError('INVALID_INPUT');
  return percent;
}

async function requiredFreeBytes(directory: string, absolute: number, percent: number): Promise<{ available: number; required: number }> {
  const capacity = await statfs(directory);
  const available = Number(capacity.bavail) * Number(capacity.bsize);
  const total = Number(capacity.blocks) * Number(capacity.bsize);
  if (![available, total].every(Number.isSafeInteger)) throw new LocalBridgeError('INSUFFICIENT_DISK_SPACE');
  return { available, required: Math.max(absolute, Math.ceil(total * percent / 100)) };
}

export async function createWorkspaceBinaryFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  bytes: Uint8Array,
  options: WorkspaceBinaryCreateOptions = {},
): Promise<WorkspaceBinaryCreateResult> {
  const content = Buffer.from(bytes);
  const maximumBytes = validatedLimit(options.maximumBytes, workspace.limits.maxFileBytes, MAX_TRUSTED_BINARY_BYTES);
  const reserveFreeBytes = validatedReserve(options.reserveFreeBytes);
  const reserveFreePercent = validatedReservePercent(options.reserveFreePercent);
  if (options.adaptive === true) throw new LocalBridgeError('INVALID_INPUT');
  if (content.byteLength > maximumBytes) throw new LocalBridgeError("FILE_TOO_LARGE");

  const target = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
  if (isPathDenied(target.relativePath, workspace.denyPatterns)) throw new LocalBridgeError("PATH_DENIED");

  return withMutationLock(mutationLockKey(workspace.id, target.relativePath), async () =>
    runAuthorizedEffect(options, async () => {
      const revalidated = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: true });
      if (revalidated.exists) throw new LocalBridgeError("FILE_ALREADY_EXISTS");
      if (reserveFreeBytes > 0 || reserveFreePercent > 0) {
        const reserve = await requiredFreeBytes(revalidated.realParentDir, reserveFreeBytes, reserveFreePercent);
        if (reserve.available - content.byteLength < reserve.required) {
          throw new LocalBridgeError("INSUFFICIENT_DISK_SPACE");
        }
      }
      await atomicWrite(revalidated.realParentDir, revalidated.basename, content);
      return {
        path: revalidated.relativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
        created: true as const,
      };
    }),
  );
}

/**
 * Crea un binario nuevo desde chunks acotados. Los bytes llegan a un archivo
 * temporal dentro del padre ya resuelto; solo se publican mediante rename una
 * vez que el productor termina y la autoridad sigue vigente.
 */
export async function createWorkspaceBinaryFileFromChunks(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  produce: (writer: WorkspaceBinaryStreamWriter) => Promise<void>,
  options: WorkspaceBinaryCreateOptions = {},
): Promise<WorkspaceBinaryCreateResult> {
  if (options.adaptive === true && options.maximumBytes !== undefined) throw new LocalBridgeError('INVALID_INPUT');
  const maximumBytes = options.adaptive === true
    ? undefined
    : validatedLimit(options.maximumBytes, workspace.limits.maxFileBytes, Number.MAX_SAFE_INTEGER);
  const reserveFreeBytes = validatedReserve(options.reserveFreeBytes);
  const reserveFreePercent = validatedReservePercent(options.reserveFreePercent);
  const target = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
  if (isPathDenied(target.relativePath, workspace.denyPatterns)) throw new LocalBridgeError("PATH_DENIED");

  return withMutationLock(mutationLockKey(workspace.id, target.relativePath), async () => {
    const writePreparedFile = async (
      destination: Awaited<ReturnType<typeof resolveWriteTarget>>,
      temporaryPath: string,
      handle: Awaited<ReturnType<typeof open>>,
      publicationOptions: MutationOptions = options,
    ): Promise<WorkspaceBinaryCreateResult> => {
      const hash = createHash("sha256");
      let size = 0;
      let closed = false;
      try {
        const writer: WorkspaceBinaryStreamWriter = {
          get size() { return size; },
          write: async (chunkInput) => {
            const chunk = Buffer.from(chunkInput);
            if (chunk.byteLength === 0) return;
            await options.checkAuthority?.();
            if (maximumBytes !== undefined && size + chunk.byteLength > maximumBytes) throw new LocalBridgeError("FILE_TOO_LARGE");
            if (reserveFreeBytes > 0 || reserveFreePercent > 0) {
              const reserve = await requiredFreeBytes(destination.realParentDir, reserveFreeBytes, reserveFreePercent);
              if (reserve.available - chunk.byteLength < reserve.required) {
                throw new LocalBridgeError("INSUFFICIENT_DISK_SPACE");
              }
            }
            let offset = 0;
            while (offset < chunk.byteLength) {
              const result = await handle.write(chunk, offset, chunk.byteLength - offset, size + offset);
              if (result.bytesWritten < 1) throw new LocalBridgeError("INTERNAL_ERROR");
              offset += result.bytesWritten;
            }
            hash.update(chunk);
            size += chunk.byteLength;
          },
        };
        await produce(writer);
        if (size === 0) throw new LocalBridgeError("INVALID_INPUT");
        await options.checkAuthority?.();
        await handle.sync();
        await handle.close();
        closed = true;

        return await runAuthorizedEffect(publicationOptions, async () => {
          await options.checkAuthority?.();
          const currentDestination = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: false });
          if (currentDestination.exists || currentDestination.realParentDir !== destination.realParentDir) {
            throw new LocalBridgeError(currentDestination.exists ? "FILE_ALREADY_EXISTS" : "SYMLINK_ESCAPE");
          }
          await rename(temporaryPath, path.join(currentDestination.realParentDir, currentDestination.basename));
          return {
            path: currentDestination.relativePath,
            sha256: hash.digest("hex"),
            size,
            created: true as const,
          };
        });
      } finally {
        if (!closed) await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    };

    if (options.checkAuthority === undefined) {
      // Compatibilidad de las mutaciones cortas existentes: mantienen la
      // autoridad y todo el efecto en una sola sección crítica.
      return runAuthorizedEffect(options, async () => {
        const destination = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: true });
        if (destination.exists) throw new LocalBridgeError("FILE_ALREADY_EXISTS");
        const temporaryBasename = `.${destination.basename}.lbtmp-${randomUUID()}`;
        const temporaryPath = path.join(destination.realParentDir, temporaryBasename);
        const handle = await open(temporaryPath, "wx", 0o600);
        // `runAuthorizedEffect` ya envuelve esta rama completa. Evitar una
        // segunda sección crítica al publicar.
        return writePreparedFile(destination, temporaryPath, handle, {});
      });
    }

    await options.checkAuthority();
    const prepared = await runAuthorizedEffect(options, async () => {
      await options.checkAuthority?.();
      const destination = await resolveWriteTarget(workspace.rootPath, relativePath, { createParentDirs: true });
      if (destination.exists) throw new LocalBridgeError("FILE_ALREADY_EXISTS");
      const temporaryBasename = `.${destination.basename}.lbtmp-${randomUUID()}`;
      const temporaryPath = path.join(destination.realParentDir, temporaryBasename);
      const handle = await open(temporaryPath, "wx", 0o600);
      return { destination, temporaryPath, handle };
    });
    return writePreparedFile(prepared.destination, prepared.temporaryPath, prepared.handle);
  });
}
