import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** Integración de Fase 3 (TEST_PLAN.md §4, ítems 3, 4, 5). */

let harness: Harness | undefined;
let workspace: TempWorkspace;
let configPath: string;
const workspaceId = 'ws_int_phase3';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  configPath = path.join(os.tmpdir(), `localbridge-integration3-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: true, gitRead: false, validations: false, gitWrite: false },
    }),
  ]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await workspace.cleanup();
});

describe('3. crear archivo', () => {
  it('file.create seguido de workspace.tree y file.read confirma el archivo real', async () => {
    const create = await callToolJson(harness!.client, 'file.create', {
      workspaceId,
      path: 'notas/idea.md',
      content: '# Idea\n',
    });
    expect(create.isError).toBe(false);
    expect(create.parsed['created']).toBe(true);

    const tree = await callToolJson(harness!.client, 'workspace.tree', { workspaceId, relativePath: 'notas' });
    expect((tree.parsed['entries'] as Array<{ path: string }>).map((e) => e.path)).toContain('notas/idea.md');

    const read = await callToolJson(harness!.client, 'file.read', { workspaceId, path: 'notas/idea.md' });
    expect(read.parsed['content']).toBe('# Idea\n');
    expect(read.parsed['sha256']).toBe(create.parsed['sha256']);
  });
});

describe('4. reemplazar con hash', () => {
  it('read -> write_guarded -> read forman un ciclo coherente', async () => {
    const before = await callToolJson(harness!.client, 'file.read', { workspaceId, path: 'src/index.ts' });

    const write = await callToolJson(harness!.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: before.parsed['sha256'],
      content: 'export const updated = true;\n',
    });
    expect(write.isError).toBe(false);
    expect(write.parsed['previousSha256']).toBe(before.parsed['sha256']);

    const after = await callToolJson(harness!.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(after.parsed['content']).toBe('export const updated = true;\n');
    expect(after.parsed['sha256']).toBe(write.parsed['sha256']);
    expect(after.parsed['sha256']).not.toBe(before.parsed['sha256']);
  });
});

describe('5. forzar hash mismatch', () => {
  it('un expectedSha256 arbitrario nunca coincide con un archivo real', async () => {
    const write = await callToolJson(harness!.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: '0'.repeat(64),
      content: 'intento',
    });
    expect(write.isError).toBe(true);
    expect((write.parsed['error'] as { code: string }).code).toBe('HASH_MISMATCH');
  });
});

describe('escritura sobrevive a un "reinicio" del servidor', () => {
  it('un archivo creado por una instancia es visible para una instancia nueva', async () => {
    const create = await callToolJson(harness!.client, 'file.create', {
      workspaceId,
      path: 'persistente.txt',
      content: 'sobrevivo a un reinicio',
    });
    expect(create.isError).toBe(false);
    await harness!.close();

    const restarted = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    harness = restarted;

    const read = await callToolJson(restarted.client, 'file.read', { workspaceId, path: 'persistente.txt' });
    expect(read.parsed['content']).toBe('sobrevivo a un reinicio');
  });
});
