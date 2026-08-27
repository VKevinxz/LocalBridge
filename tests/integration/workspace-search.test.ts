import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * Integración de `workspace.search` (v2.3, TOOL_CATALOG.md §3-bis): wiring real
 * a través del servidor MCP completo. Los casos de borde de la búsqueda en sí
 * (denylist, binarios, límites de tamaño, maxResults) ya están cubiertos contra
 * `searchWorkspace` directamente en `tests/unit/filesystem.test.ts`; aquí solo
 * se comprueba que la tool está bien conectada: permiso, forma de la salida
 * por el cable, y los códigos de error correctos.
 */

let harness: Harness | undefined;
let workspace: TempWorkspace;
let configPath: string;
const workspaceId = 'ws_search';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  configPath = path.join(os.tmpdir(), `localbridge-search-${randomUUID()}`, 'workspaces.json');
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await workspace.cleanup();
});

describe('workspace.search', () => {
  it('encuentra una coincidencia real a través del servidor MCP', async () => {
    await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'workspace.search', {
      workspaceId,
      query: 'export const hello',
    });

    expect(isError).toBe(false);
    const matches = parsed['matches'] as Array<{ path: string; line: number; text: string }>;
    expect(matches).toContainEqual({ path: 'src/index.ts', line: 1, text: 'export const hello = "world";' });
    expect(parsed['filesScanned']).toBeGreaterThan(0);
    expect(parsed['truncated']).toBe(false);
  });

  it('read=false deniega la tool con CAPABILITY_DISABLED', async () => {
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: false, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'workspace.search', { workspaceId, query: 'hello' });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
  });

  it('query vacía se rechaza antes de llegar al handler (inputSchema min(1))', async () => {
    await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    // La validación de Zod la rechaza en el propio seam del SDK, antes de que
    // el handler exista siquiera — el texto no es el JSON de un
    // LocalBridgeError como el resto de errores, así que no se usa
    // callToolJson (que asume JSON) aquí.
    const result = await harness.client.callTool({ name: 'workspace.search', arguments: { workspaceId, query: '' } });
    expect(result.isError).toBe(true);
  });

  it('workspaceId inexistente -> WORKSPACE_NOT_FOUND', async () => {
    await writeRegistryFile(configPath, []);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const { isError, parsed } = await callToolJson(harness.client, 'workspace.search', { workspaceId: 'ws_no_existe', query: 'hello' });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('WORKSPACE_NOT_FOUND');
  });
});
