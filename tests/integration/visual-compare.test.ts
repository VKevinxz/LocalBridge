import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, writeRegistryFile } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  await harness?.close();
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  harness = undefined;
  tempRoot = undefined;
});

function png(width: number, height: number, changedPixel = false): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 20;
    image.data[index + 1] = 40;
    image.data[index + 2] = 60;
    image.data[index + 3] = 255;
  }
  if (changedPixel) {
    image.data[0] = 240;
    image.data[1] = 230;
    image.data[2] = 220;
  }
  return PNG.sync.write(image);
}

describe('visual.compare', () => {
  it('crea un diff PNG verificable y no repite la mutación al reintentar', async () => {
    tempRoot = path.join(os.tmpdir(), `localbridge-visual-${randomUUID()}`);
    await mkdir(path.join(tempRoot, 'evidence'), { recursive: true });
    await Promise.all([
      writeFile(path.join(tempRoot, 'evidence', 'reference.png'), png(2, 2)),
      writeFile(path.join(tempRoot, 'evidence', 'candidate.png'), png(2, 2, true)),
    ]);
    const configPath = path.join(tempRoot, 'registry', 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_visual', rootPath: tempRoot,
      permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    const args = {
      workspaceId: 'ws_visual', referencePath: 'evidence/reference.png', candidatePath: 'evidence/candidate.png',
      diffPath: 'evidence/diff.png', operationId: 'visual_compare_1',
    };
    const first = await callToolJson(harness.client, 'visual.compare', args);
    const repeated = await callToolJson(harness.client, 'visual.compare', args);
    expect(first.isError).toBe(false);
    expect(repeated.parsed).toEqual(first.parsed);
    expect(first.parsed).toMatchObject({ width: 2, height: 2, mismatchPixels: 1, mismatchRatio: 0.25, threshold: 0.1 });
    const diff = await readFile(path.join(tempRoot, 'evidence', 'diff.png'));
    expect(diff.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const conflict = await callToolJson(harness.client, 'visual.compare', { ...args, candidatePath: 'evidence/reference.png' });
    expect(conflict.isError).toBe(true);
    expect(conflict.parsed['error']).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_visual', rootPath: tempRoot,
      permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    })]);
    const replayAfterRevocation = await callToolJson(harness.client, 'visual.compare', args);
    expect(replayAfterRevocation.isError).toBe(true);
    expect(replayAfterRevocation.parsed['error']).toMatchObject({ code: 'CAPABILITY_DISABLED' });
  });

  it('exige dimensiones iguales, PNG y permiso de escritura', async () => {
    tempRoot = path.join(os.tmpdir(), `localbridge-visual-denied-${randomUUID()}`);
    await mkdir(path.join(tempRoot, 'evidence'), { recursive: true });
    await Promise.all([
      writeFile(path.join(tempRoot, 'evidence', 'reference.png'), png(2, 2)),
      writeFile(path.join(tempRoot, 'evidence', 'candidate.png'), png(3, 2)),
    ]);
    const oversizedHeader = png(2, 2);
    oversizedHeader.writeUInt32BE(2_561, 16);
    oversizedHeader.writeUInt32BE(1_440, 20);
    await writeFile(path.join(tempRoot, 'evidence', 'oversized.png'), oversizedHeader);
    const configPath = path.join(tempRoot, 'registry', 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_visual_mismatch', rootPath: tempRoot,
        permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
      buildWorkspace({
        id: 'ws_visual_read_only', rootPath: tempRoot,
        permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    const mismatch = await callToolJson(harness.client, 'visual.compare', {
      workspaceId: 'ws_visual_mismatch', referencePath: 'evidence/reference.png', candidatePath: 'evidence/candidate.png',
      diffPath: 'evidence/diff.png', operationId: 'visual_compare_mismatch',
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.parsed['error']).toMatchObject({ code: 'INVALID_INPUT' });
    const oversized = await callToolJson(harness.client, 'visual.compare', {
      workspaceId: 'ws_visual_mismatch', referencePath: 'evidence/oversized.png', candidatePath: 'evidence/oversized.png',
      diffPath: 'evidence/oversized-diff.png', operationId: 'visual_compare_oversized',
    });
    expect(oversized.isError).toBe(true);
    expect(oversized.parsed['error']).toMatchObject({ code: 'INVALID_INPUT' });
    const denied = await callToolJson(harness.client, 'visual.compare', {
      workspaceId: 'ws_visual_read_only', referencePath: 'evidence/reference.png', candidatePath: 'evidence/candidate.png',
      diffPath: 'evidence/diff.png', operationId: 'visual_compare_denied',
    });
    expect(denied.isError).toBe(true);
    expect(denied.parsed['error']).toMatchObject({ code: 'CAPABILITY_DISABLED' });
  });
});
