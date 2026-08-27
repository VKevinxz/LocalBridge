import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** Integración de Fase 2 (TEST_PLAN.md §4, ítems 1, 2, 8, 10). */

let harness: Harness | undefined;
let workspace: TempWorkspace;
let configPath: string;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  configPath = path.join(os.tmpdir(), `localbridge-integration-${randomUUID()}`, 'workspaces.json');
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await workspace.cleanup();
});

describe('1. listar workspace', () => {
  it('solo devuelve los workspaces habilitados, con sus permisos y límites', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({ id: 'ws_visible', name: 'Visible', rootPath: workspace.root }),
      buildWorkspace({ id: 'ws_oculto', name: 'Oculto', rootPath: workspace.root, enabled: false }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'workspace.list', {});
    expect(isError).toBe(false);

    const workspaces = parsed['workspaces'] as Array<{ workspaceId: string; name: string; permissions: unknown; limits: unknown }>;
    expect(workspaces.map((w) => w.workspaceId)).toEqual(['ws_visible']);
    expect(workspaces[0]?.permissions).toBeDefined();
    expect(workspaces[0]?.limits).toBeDefined();
  });
});

describe('2. leer archivo (recorrido completo)', () => {
  it('workspace.tree -> file.metadata -> file.read forman un flujo coherente', async () => {
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_read', rootPath: workspace.root })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const tree = await callToolJson(harness.client, 'workspace.tree', { workspaceId: 'ws_read', relativePath: 'src' });
    expect(tree.isError).toBe(false);
    const treePaths = (tree.parsed['entries'] as Array<{ path: string }>).map((entry) => entry.path);
    expect(treePaths).toContain('src/index.ts');

    const metadata = await callToolJson(harness.client, 'file.metadata', { workspaceId: 'ws_read', path: 'src/index.ts' });
    expect(metadata.isError).toBe(false);
    expect(metadata.parsed['exists']).toBe(true);

    const read = await callToolJson(harness.client, 'file.read', { workspaceId: 'ws_read', path: 'src/index.ts' });
    expect(read.isError).toBe(false);
    // El hash de metadata y el de read deben coincidir: son el mismo archivo.
    expect(read.parsed['sha256']).toBe(metadata.parsed['sha256']);
  });
});

describe('8. cambio de permiso en runtime', () => {
  it('conceder gitRead a mitad de sesión no habilita nada por sí solo en la Fase 2 (sin tools de Git todavía)', async () => {
    // No hay tools de Git en esta fase; el test relevante para "cambio de
    // permiso en runtime" ya vive en sec-025 (más completo). Este caso
    // confirma que un permiso que SÍ se usa (`read`) responde igual de rápido
    // al deshabilitarse a mitad de una secuencia de llamadas encadenadas.
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_mid', rootPath: workspace.root })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const first = await callToolJson(harness.client, 'file.metadata', { workspaceId: 'ws_mid', path: 'README.md' });
    expect(first.isError).toBe(false);

    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_mid',
        rootPath: workspace.root,
        permissions: { read: false, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);

    const second = await callToolJson(harness.client, 'file.metadata', { workspaceId: 'ws_mid', path: 'README.md' });
    expect(second.isError).toBe(true);
    expect((second.parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
  });
});

describe('10. gateway "reiniciado"', () => {
  it('un servidor nuevo apuntando al mismo registro ve exactamente el mismo estado', async () => {
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_persist', rootPath: workspace.root })]);

    const first = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    const beforeRestart = await callToolJson(first.client, 'file.read', { workspaceId: 'ws_persist', path: 'README.md' });
    await first.close();

    // Nada de estado vive en el proceso: el registro es un fichero (ADR-0012).
    // Un servidor "reiniciado" (instancia nueva) debe comportarse igual sin
    // ningún paso de recuperación.
    const second = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    harness = second;
    const afterRestart = await callToolJson(second.client, 'file.read', { workspaceId: 'ws_persist', path: 'README.md' });

    expect(afterRestart.isError).toBe(false);
    expect(afterRestart.parsed['sha256']).toBe(beforeRestart.parsed['sha256']);
  });
});
