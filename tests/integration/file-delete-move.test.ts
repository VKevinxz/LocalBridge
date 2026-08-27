import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * Integración de `file.delete`/`file.move` (v2.4, TOOL_CATALOG.md §9-bis):
 * wiring real a través del servidor MCP completo. Los casos de borde de cada
 * operación (hash guard, symlinks, denylist, deadlock de locks) ya están
 * cubiertos contra `deleteWorkspaceFile`/`moveWorkspaceFile` directamente en
 * `tests/unit/write-operations.test.ts`; aquí se comprueba el permiso, la
 * idempotencia por `operationId`, y que la tool está bien conectada de punta
 * a punta.
 */

let harness: Harness | undefined;
let workspace: TempWorkspace;
let configPath: string;
const workspaceId = 'ws_delete_move';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  configPath = path.join(os.tmpdir(), `localbridge-delete-move-${randomUUID()}`, 'workspaces.json');
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await workspace.cleanup();
});

async function currentHash(client: Harness['client'], relPath: string): Promise<string> {
  const { parsed } = await callToolJson(client, 'file.read', { workspaceId, path: relPath });
  return parsed['sha256'] as string;
}

describe('file.delete', () => {
  it('borra un archivo real con el hash correcto', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const hash = await currentHash(harness.client, 'src/index.ts');
    const { isError, parsed } = await callToolJson(harness.client, 'file.delete', { workspaceId, path: 'src/index.ts', expectedSha256: hash });

    expect(isError).toBe(false);
    expect(parsed).toEqual({ path: 'src/index.ts', deleted: true });
    await expect(readFile(path.join(workspace.root, 'src', 'index.ts'))).rejects.toThrow();
  });

  it('overwrite=false deniega la tool con CAPABILITY_DISABLED', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'file.delete', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: 'a'.repeat(64),
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
  });

  it('operationId: reintentar tras borrar devuelve el mismo resultado en vez de FILE_NOT_FOUND', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const hash = await currentHash(harness.client, 'src/index.ts');
    const operationId = 'op_delete_idempotente';

    const first = await callToolJson(harness.client, 'file.delete', { workspaceId, path: 'src/index.ts', expectedSha256: hash, operationId });
    expect(first.isError).toBe(false);

    const second = await callToolJson(harness.client, 'file.delete', { workspaceId, path: 'src/index.ts', expectedSha256: hash, operationId });
    expect(second.isError).toBe(false);
    expect(second.parsed).toEqual(first.parsed);
  });
});

describe('file.move', () => {
  it('mueve un archivo real con el hash correcto', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const hash = await currentHash(harness.client, 'src/index.ts');
    const { isError, parsed } = await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/index.ts',
      destPath: 'src/renombrado.ts',
      expectedSha256: hash,
    });

    expect(isError).toBe(false);
    expect(parsed['sourcePath']).toBe('src/index.ts');
    expect(parsed['destPath']).toBe('src/renombrado.ts');
    const atDest = await readFile(path.join(workspace.root, 'src', 'renombrado.ts'), 'utf8');
    expect(atDest).toBe('export const hello = "world";\n');
  });

  it('destino existente -> FILE_ALREADY_EXISTS sobre el cable', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const hash = await currentHash(harness.client, 'src/index.ts');
    const { isError, parsed } = await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/index.ts',
      destPath: 'src/lib/util.ts',
      expectedSha256: hash,
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('FILE_ALREADY_EXISTS');
  });

  it('overwrite=false deniega la tool con CAPABILITY_DISABLED', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/index.ts',
      destPath: 'src/otro.ts',
      expectedSha256: 'a'.repeat(64),
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
  });

  it('operationId: reintentar tras mover devuelve el mismo resultado en vez de FILE_NOT_FOUND', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const hash = await currentHash(harness.client, 'src/index.ts');
    const operationId = 'op_move_idempotente';

    const first = await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/index.ts',
      destPath: 'src/movido.ts',
      expectedSha256: hash,
      operationId,
    });
    expect(first.isError).toBe(false);

    const second = await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/index.ts',
      destPath: 'src/movido.ts',
      expectedSha256: hash,
      operationId,
    });
    expect(second.isError).toBe(false);
    expect(second.parsed).toEqual(first.parsed);
  });
});
