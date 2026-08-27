import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-025] Deshabilitar un workspace en runtime surte efecto sin reiniciar (ADR-0004, ADR-0012). */

let harness: Harness;
let workspace: TempWorkspace;
let configPath: string;
const workspaceId = 'ws_sec_toggle';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  configPath = path.join(os.tmpdir(), `localbridge-sec-toggle-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root })]);

  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('[SEC-025] workspace deshabilitado en runtime', () => {
  it('una operación previamente exitosa falla en la siguiente llamada tras deshabilitar, sin reiniciar el servidor', async () => {
    const before = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(before.isError).toBe(false);

    await writeRegistryFile(configPath, [
      buildWorkspace({ id: workspaceId, rootPath: workspace.root, enabled: false }),
    ]);

    const after = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(after.isError).toBe(true);
    expect((after.parsed['error'] as { code: string }).code).toBe('WORKSPACE_DISABLED');
  });

  it('workspace.list deja de mostrarlo en la siguiente llamada', async () => {
    const before = await callToolJson(harness.client, 'workspace.list', {});
    expect((before.parsed['workspaces'] as unknown[]).map((w) => (w as { workspaceId: string }).workspaceId)).toContain(
      workspaceId,
    );

    await writeRegistryFile(configPath, [
      buildWorkspace({ id: workspaceId, rootPath: workspace.root, enabled: false }),
    ]);

    const after = await callToolJson(harness.client, 'workspace.list', {});
    expect((after.parsed['workspaces'] as unknown[]).map((w) => (w as { workspaceId: string }).workspaceId)).not.toContain(
      workspaceId,
    );
  });

  it('reducir un permiso (overwrite) surte efecto sin reiniciar', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    await harness.close();
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const before = await callToolJson(harness.client, 'workspace.list', {});
    const workspaceEntry = (before.parsed['workspaces'] as Array<{ workspaceId: string; permissions: { overwrite: boolean } }>).find(
      (w) => w.workspaceId === workspaceId,
    );
    expect(workspaceEntry?.permissions.overwrite).toBe(true);

    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);

    const after = await callToolJson(harness.client, 'workspace.list', {});
    const updatedEntry = (after.parsed['workspaces'] as Array<{ workspaceId: string; permissions: { overwrite: boolean } }>).find(
      (w) => w.workspaceId === workspaceId,
    );
    expect(updatedEntry?.permissions.overwrite).toBe(false);
  });
});
