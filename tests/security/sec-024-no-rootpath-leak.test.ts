import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * [SEC-024] Ninguna respuesta ni error contiene `rootPath` absoluto.
 *
 * Se comprueba contra el `rootPath` real del fixture (una ruta absoluta de
 * Windows genuina bajo %TEMP%), no contra un patrón genérico, para que el test
 * falle si alguna tool empieza a filtrar la ruta real del disco.
 */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_no_leak';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-noleak-${randomUUID()}`, 'workspaces.json');
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
  await harness.close();
  await workspace.cleanup();
});

function assertNoRootPathLeak(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(workspace.root);
  // Ninguna respuesta debe llevar tampoco una unidad de Windows genérica.
  expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
}

describe('[SEC-024] ninguna respuesta contiene rootPath', () => {
  it('workspace.list no expone rootPath', async () => {
    const { parsed } = await callToolJson(harness.client, 'workspace.list', {});
    assertNoRootPathLeak(parsed);
  });

  it('file.read con éxito no expone rootPath', async () => {
    const { parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    assertNoRootPathLeak(parsed);
  });

  it('workspace.tree no expone rootPath', async () => {
    const { parsed } = await callToolJson(harness.client, 'workspace.tree', { workspaceId, relativePath: '.' });
    assertNoRootPathLeak(parsed);
  });

  it('un error de ruta (PATH_OUTSIDE_WORKSPACE) no expone rootPath', async () => {
    const { parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: '../../secret' });
    assertNoRootPathLeak(parsed);
  });

  it('file.create con éxito no expone rootPath ni realParentDir', async () => {
    const { parsed } = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'nuevo/anidado.md',
      content: 'x',
    });
    assertNoRootPathLeak(parsed);
  });

  it('file.write_guarded con éxito no expone rootPath', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    const { parsed } = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'y',
    });
    assertNoRootPathLeak(parsed);
  });

  it('un HASH_MISMATCH no expone rootPath', async () => {
    const { parsed } = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: 'a'.repeat(64),
      content: 'y',
    });
    assertNoRootPathLeak(parsed);
  });

  it('un SYMLINK_ESCAPE en escritura no expone rootPath', async () => {
    const { parsed } = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: '../fuera-del-root.md',
      content: 'y',
    });
    assertNoRootPathLeak(parsed);
  });

  it('un error interno (workspace mal configurado) tampoco expone rootPath', async () => {
    const brokenConfigPath = path.join(os.tmpdir(), `localbridge-sec-noleak-broken-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(brokenConfigPath, [
      buildWorkspace({ id: 'ws_broken', rootPath: path.join(workspace.root, 'no-existe-este-directorio') }),
    ]);
    const brokenHarness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: brokenConfigPath });

    try {
      const { isError, parsed } = await callToolJson(brokenHarness.client, 'file.read', {
        workspaceId: 'ws_broken',
        path: 'x.ts',
      });
      expect(isError).toBe(true);
      expect((parsed['error'] as { code: string }).code).toBe('INTERNAL_ERROR');
      assertNoRootPathLeak(parsed);
    } finally {
      await brokenHarness.close();
    }
  });
});
