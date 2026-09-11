import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';
import { mutationLockKey, withMutationLock } from '@localbridge/filesystem';
import { upsertWorkspace } from '@localbridge/desktop-core';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-025] Deshabilitar un workspace en runtime surte efecto sin reiniciar (ADR-0004, ADR-0012). */

let harness: Harness;
let workspace: TempWorkspace;
let configPath: string;
const workspaceId = 'ws_sec_toggle';
const writePermissions = { read: true, write: true, overwrite: true, gitRead: false, validations: false, gitWrite: false };

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  configPath = path.join(os.tmpdir(), `localbridge-sec-toggle-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root, permissions: writePermissions })]);

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

  it('un resultado idempotente no salta la revocación posterior', async () => {
    const input = { workspaceId, path: 'cacheado.md', content: 'x', operationId: 'cached-before-revoke' };
    expect((await callToolJson(harness.client, 'file.create', input)).isError).toBe(false);
    await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root, enabled: false, permissions: writePermissions })]);

    const replay = await callToolJson(harness.client, 'file.create', input);

    expect(replay.isError).toBe(true);
    expect((replay.parsed['error'] as { code: string }).code).toBe('WORKSPACE_DISABLED');
  });

  it('una mutación en cola revalida autoridad justo antes del efecto', async () => {
    let releaseLock!: () => void;
    let announceLock!: () => void;
    const locked = new Promise<void>((resolve) => { announceLock = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = withMutationLock(mutationLockKey(workspaceId, 'en-cola.md'), async () => {
      announceLock();
      await release;
    });
    await locked;

    const pending = callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'en-cola.md',
      content: 'no debe escribirse',
      operationId: 'queued-revocation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root, enabled: false, permissions: writePermissions })]);
    releaseLock();
    await held;

    const result = await pending;
    expect(result.isError).toBe(true);
    expect((result.parsed['error'] as { code: string }).code).toBe('WORKSPACE_DISABLED');
    await expect(access(path.join(workspace.root, 'en-cola.md'))).rejects.toBeDefined();
  });

  it('rechaza una mutación en cola si cambia el root autorizado', async () => {
    const replacement = await createTempWorkspaceDir();
    try {
      let releaseLock!: () => void;
      let announceLock!: () => void;
      const locked = new Promise<void>((resolve) => { announceLock = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const held = withMutationLock(mutationLockKey(workspaceId, 'root-cambiado.md'), async () => {
        announceLock();
        await release;
      });
      await locked;

      const pending = callToolJson(harness.client, 'file.create', {
        workspaceId,
        path: 'root-cambiado.md',
        content: 'no debe escribirse en ningún root',
        operationId: 'queued-root-change',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await upsertWorkspace(configPath, buildWorkspace({
        id: workspaceId,
        rootPath: replacement.root,
        permissions: writePermissions,
      }));
      releaseLock();
      await held;

      const result = await pending;
      expect(result.isError).toBe(true);
      expect((result.parsed['error'] as { code: string }).code).toBe('APPROVAL_INVALID');
      await expect(access(path.join(workspace.root, 'root-cambiado.md'))).rejects.toBeDefined();
      await expect(access(path.join(replacement.root, 'root-cambiado.md'))).rejects.toBeDefined();
    } finally {
      await replacement.cleanup();
    }
  });

  it('file.patch_guarded no inspecciona ni escribe después de una revocación mientras esperaba el lock', async () => {
    const target = path.join(workspace.root, 'README.md');
    const original = await readFile(target);
    const hash = createHash('sha256').update(original).digest('hex');
    let releaseLock!: () => void;
    let announceLock!: () => void;
    const locked = new Promise<void>((resolve) => { announceLock = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = withMutationLock(mutationLockKey(workspaceId, 'README.md'), async () => {
      announceLock();
      await release;
    });
    await locked;

    const pending = callToolJson(harness.client, 'file.patch_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: hash,
      edits: [{ oldText: 'sample', newText: 'should-not-appear' }],
      operationId: 'queued-patch-revocation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeRegistryFile(configPath, [
      buildWorkspace({ id: workspaceId, rootPath: workspace.root, enabled: false, permissions: writePermissions }),
    ]);
    releaseLock();
    await held;

    const result = await pending;
    expect(result.isError).toBe(true);
    expect((result.parsed['error'] as { code: string }).code).toBe('WORKSPACE_DISABLED');
    expect(await readFile(target)).toEqual(original);
  });
});
