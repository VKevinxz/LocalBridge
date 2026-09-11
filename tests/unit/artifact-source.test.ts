import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openWorkspaceArtifactSource } from '@localbridge/filesystem';
import { buildWorkspace, createTempWorkspaceDir, type TempWorkspace } from '../helpers/fixtures.js';

let temporary: TempWorkspace;

beforeEach(async () => {
  temporary = await createTempWorkspaceDir();
});

afterEach(async () => temporary.cleanup());

function policy(mode: 'standard' | 'adaptive' | 'custom', customSourceBytes?: number) {
  return mode === 'custom'
    ? { mode, customSourceBytes: customSourceBytes!, reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 as const }
    : { mode, reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 as const };
}

describe('gateway de artefactos grandes', () => {
  it('abre una fuente sparse/virtual de 200 GiB en adaptive y solo lee el rango solicitado', async () => {
    const filePath = path.join(temporary.root, 'huge.bin');
    const handle = await open(filePath, 'w');
    await handle.truncate(200 * 1024 * 1024 * 1024);
    await handle.close();
    const checkAuthority = vi.fn(async () => undefined);
    const workspace = buildWorkspace({
      rootPath: temporary.root,
      limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: policy('adaptive') },
    });

    const source = await openWorkspaceArtifactSource(workspace, 'huge.bin', {
      standardLimitBytes: 1024 * 1024 * 1024,
      checkAuthority,
    });
    try {
      expect(source.identity.size).toBe(200 * 1024 * 1024 * 1024);
      expect(await source.readRange(source.identity.size - 16, 16)).toEqual(Buffer.alloc(16));
      expect(source.counters()).toMatchObject({ bytesRead: 16, uniqueBytesRead: 16, rangesRead: 1 });
      expect(checkAuthority.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await source.close();
    }
  });

  it('mantiene el techo compatible en standard y el techo explícito en custom', async () => {
    await writeFile(path.join(temporary.root, 'asset.bin'), Buffer.alloc(32));
    const standard = buildWorkspace({
      rootPath: temporary.root,
      limits: { maxFileBytes: 8, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: policy('standard') },
    });
    await expect(openWorkspaceArtifactSource(standard, 'asset.bin', { standardLimitBytes: 16 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const custom = buildWorkspace({
      rootPath: temporary.root,
      limits: { maxFileBytes: 8, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: policy('custom', 24) },
    });
    await expect(openWorkspaceArtifactSource(custom, 'asset.bin', { standardLimitBytes: 16 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('detiene lecturas después de cancelación o cambio de identidad', async () => {
    const filePath = path.join(temporary.root, 'changing.bin');
    await writeFile(filePath, Buffer.alloc(64, 1));
    const workspace = buildWorkspace({
      rootPath: temporary.root,
      limits: { maxFileBytes: 8, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: policy('adaptive') },
    });
    const controller = new AbortController();
    const cancelled = await openWorkspaceArtifactSource(workspace, 'changing.bin', { standardLimitBytes: 16, signal: controller.signal });
    controller.abort();
    await expect(cancelled.readRange(0, 1)).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    await cancelled.close();

    const changing = await openWorkspaceArtifactSource(workspace, 'changing.bin', { standardLimitBytes: 16 });
    await writeFile(filePath, Buffer.alloc(65, 2));
    await expect(changing.readRange(0, 1)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await changing.close();
  });

  it('deja de entregar rangos apenas se revoca la autoridad vigente', async () => {
    await writeFile(path.join(temporary.root, 'revoked.bin'), Buffer.alloc(256, 7));
    const workspace = buildWorkspace({
      rootPath: temporary.root,
      limits: { maxFileBytes: 8, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: policy('adaptive') },
    });
    let allowed = true;
    const source = await openWorkspaceArtifactSource(workspace, 'revoked.bin', {
      standardLimitBytes: 16,
      checkAuthority: async () => {
        if (!allowed) throw Object.assign(new Error('revoked'), { code: 'CAPABILITY_DISABLED' });
      },
    });
    expect(await source.readRange(0, 8)).toEqual(Buffer.alloc(8, 7));
    allowed = false;
    await expect(source.readRange(8, 8)).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    await source.close();
  });
});
