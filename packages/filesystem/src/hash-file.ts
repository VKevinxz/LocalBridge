import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { LocalBridgeError, isEnoent } from '@localbridge/shared';

export const MAX_MANAGED_ASSET_BYTES = 1024 * 1024 * 1024;

/** Hashea un archivo ya resuelto mediante streaming y detecta cambios durante la lectura. */
export async function hashResolvedFile(realPath: string, maximumBytes = MAX_MANAGED_ASSET_BYTES): Promise<{
  readonly sha256: string;
  readonly size: number;
  readonly modifiedAt: string;
}> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_MANAGED_ASSET_BYTES) {
    throw new LocalBridgeError('INVALID_INPUT');
  }
  let handle;
  try {
    handle = await open(realPath, 'r');
  } catch (error) {
    if (isEnoent(error)) throw new LocalBridgeError('FILE_NOT_FOUND');
    throw new LocalBridgeError('INTERNAL_ERROR');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new LocalBridgeError('NOT_A_FILE');
    if (before.size > maximumBytes) throw new LocalBridgeError('FILE_TOO_LARGE');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength;
      if (size > maximumBytes) throw new LocalBridgeError('FILE_TOO_LARGE');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || size !== before.size) {
      throw new LocalBridgeError('HASH_MISMATCH');
    }
    return { sha256: hash.digest('hex'), size, modifiedAt: after.mtime.toISOString() };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
