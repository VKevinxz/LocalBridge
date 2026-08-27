import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-006] y [SEC-007] — permisos de escritura, de punta a punta. */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_write_perms';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('[SEC-006] file.create con write=false', () => {
  it('se deniega con CAPABILITY_DISABLED, sin crear nada', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-sec006-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'nuevo.md',
      content: 'contenido',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');

    const tree = await callToolJson(harness.client, 'workspace.tree', { workspaceId, relativePath: '.' });
    expect((tree.parsed['entries'] as Array<{ path: string }>).some((e) => e.path === 'nuevo.md')).toBe(false);
  });
});

describe('[SEC-007] file.write_guarded con overwrite=false', () => {
  it('se deniega con CAPABILITY_DISABLED, incluso con el hash correcto', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-sec007-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    const { isError, parsed } = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      content: 'pisado',
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');

    const after = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    expect(after.parsed['content']).toBe('# sample\n');
  });

  it('write=true no implica overwrite=true', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-sec007b-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    // write=true sí permite crear.
    const create = await callToolJson(harness.client, 'file.create', { workspaceId, path: 'nuevo.md', content: 'x' });
    expect(create.isError).toBe(false);

    // pero no permite sobrescribir NADA, ni siquiera lo que se acaba de crear.
    const write = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'nuevo.md',
      expectedSha256: create.parsed['sha256'],
      content: 'y',
    });
    expect(write.isError).toBe(true);
    expect((write.parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
  });
});
