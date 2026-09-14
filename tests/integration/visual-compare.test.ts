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

function pngWithChanges(
  width: number,
  height: number,
  changes: readonly { x: number; y: number; width: number; height: number }[],
): Buffer {
  const image = PNG.sync.read(png(width, height));
  for (const change of changes) {
    for (let y = change.y; y < change.y + change.height; y += 1) {
      for (let x = change.x; x < change.x + change.width; x += 1) {
        const offset = (y * width + x) * 4;
        image.data[offset] = 240;
        image.data[offset + 1] = 230;
        image.data[offset + 2] = 220;
      }
    }
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

  it('localiza, filtra y pagina regiones sin cambiar el mismatch global', async () => {
    tempRoot = path.join(os.tmpdir(), `localbridge-visual-regions-${randomUUID()}`);
    await mkdir(path.join(tempRoot, 'evidence'), { recursive: true });
    const changes = [
      { x: 20, y: 24, width: 40, height: 40 },
      { x: 104, y: 72, width: 12, height: 8 },
      { x: 2, y: 2, width: 1, height: 1 },
      { x: 150, y: 110, width: 1, height: 1 },
    ] as const;
    await Promise.all([
      writeFile(path.join(tempRoot, 'evidence', 'reference.png'), png(160, 120)),
      writeFile(path.join(tempRoot, 'evidence', 'candidate.png'), pngWithChanges(160, 120, changes)),
    ]);
    const configPath = path.join(tempRoot, 'registry', 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_visual_regions', rootPath: tempRoot,
      permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    const baseArgs = {
      workspaceId: 'ws_visual_regions', referencePath: 'evidence/reference.png', candidatePath: 'evidence/candidate.png',
      regions: { page: 1, limit: 1, minMismatchPixels: 4 },
    };
    const first = await callToolJson(harness.client, 'visual.compare', {
      ...baseArgs, diffPath: 'evidence/diff-page-1.png', operationId: 'visual_regions_page_1',
    });
    expect(first.isError).toBe(false);
    expect(first.parsed).toMatchObject({ mismatchPixels: 1_698 });
    expect(first.parsed['regions']).toMatchObject({
      grouping: 'connected-tiles-8', page: 1, limit: 1, minMismatchPixels: 4,
      detectedTotal: 4, total: 2, filteredOutTotal: 2, filteredOutMismatchPixels: 2, hasMore: true,
      items: [{ x: 20, y: 24, width: 40, height: 40, area: 1_600, mismatchPixels: 1_600 }],
    });
    const firstRegion = (first.parsed['regions'] as { items: Array<{ contribution: number }> }).items[0];
    expect(firstRegion?.contribution).toBeCloseTo(1_600 / 1_698);

    const second = await callToolJson(harness.client, 'visual.compare', {
      ...baseArgs,
      regions: { ...baseArgs.regions, page: 2 },
      diffPath: 'evidence/diff-page-2.png', operationId: 'visual_regions_page_2',
    });
    expect(second.isError).toBe(false);
    expect(second.parsed['regions']).toMatchObject({
      page: 2, total: 2, hasMore: false,
      items: [{ x: 104, y: 72, width: 12, height: 8, area: 96, mismatchPixels: 96 }],
    });
  });

  it('devuelve cero regiones en un PNG grande idéntico', async () => {
    tempRoot = path.join(os.tmpdir(), `localbridge-visual-large-${randomUUID()}`);
    await mkdir(path.join(tempRoot, 'evidence'), { recursive: true });
    const large = png(1_920, 1_080);
    await Promise.all([
      writeFile(path.join(tempRoot, 'evidence', 'reference.png'), large),
      writeFile(path.join(tempRoot, 'evidence', 'candidate.png'), large),
    ]);
    const configPath = path.join(tempRoot, 'registry', 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_visual_large', rootPath: tempRoot,
      permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    const result = await callToolJson(harness.client, 'visual.compare', {
      workspaceId: 'ws_visual_large', referencePath: 'evidence/reference.png', candidatePath: 'evidence/candidate.png',
      diffPath: 'evidence/diff.png', operationId: 'visual_large_zero', regions: {},
    });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({
      width: 1_920, height: 1_080, mismatchPixels: 0, mismatchRatio: 0,
      regions: { detectedTotal: 0, total: 0, filteredOutTotal: 0, filteredOutMismatchPixels: 0, hasMore: false, items: [] },
    });
  });
});
