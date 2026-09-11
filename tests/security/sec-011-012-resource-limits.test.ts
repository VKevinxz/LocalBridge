import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-011] y [SEC-012] SECURITY.md Amenaza G — límites de recursos, de punta a punta. */

let harness: Harness | undefined;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_limits';

async function setUpHarness(limits: { maxFileBytes: number; maxTreeEntries: number; maxTreeDepth: number }): Promise<void> {
  const configPath = path.join(os.tmpdir(), `localbridge-sec-limits-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root, limits })]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
}

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await workspace.cleanup();
});

describe('[SEC-011] archivo mayor que el límite del workspace', () => {
  it('file.read rechaza el archivo sin devolver contenido', async () => {
    await writeFile(path.join(workspace.root, 'big.bin'), Buffer.alloc(4096, 'x'));
    await setUpHarness({ maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 });

    const { isError, parsed } = await callToolJson(harness!.client, 'file.read', { workspaceId, path: 'big.bin' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('FILE_TOO_LARGE');
    expect(parsed['content']).toBeUndefined();
  });

  it('file.metadata obtiene el hash por streaming sin convertir el asset en respuesta de contenido', async () => {
    await writeFile(path.join(workspace.root, 'big.bin'), Buffer.alloc(4096, 'x'));
    await setUpHarness({ maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 });

    const { isError, parsed } = await callToolJson(harness!.client, 'file.metadata', { workspaceId, path: 'big.bin' });
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ exists: true, type: 'file', size: 4096 });
    expect(parsed['sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed['content']).toBeUndefined();
  });
});

describe('[SEC-012] bomba de profundidad/entradas en workspace.tree', () => {
  it('maxEntries acota el resultado y lo marca truncated, no se cuelga', async () => {
    await mkdir(path.join(workspace.root, 'many'), { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(workspace.root, 'many', `f${i}.txt`), 'x');
    }
    await setUpHarness({ maxFileBytes: 1_048_576, maxTreeEntries: 10, maxTreeDepth: 3 });

    const { isError, parsed } = await callToolJson(harness!.client, 'workspace.tree', { workspaceId, relativePath: 'many' });
    expect(isError).toBe(false);
    expect((parsed['entries'] as unknown[]).length).toBeLessThanOrEqual(10);
    expect(parsed['truncated']).toBe(true);
  });

  it('un maxDepth pedido por encima del límite del workspace se acota, no se ignora', async () => {
    await mkdir(path.join(workspace.root, 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(path.join(workspace.root, 'a', 'b', 'c', 'd', 'deep.txt'), 'x');
    await setUpHarness({ maxFileBytes: 1_048_576, maxTreeEntries: 300, maxTreeDepth: 2 });

    const { isError, parsed } = await callToolJson(harness!.client, 'workspace.tree', {
      workspaceId,
      relativePath: 'a',
      maxDepth: 100,
    });
    expect(isError).toBe(false);
    const paths = (parsed['entries'] as Array<{ path: string }>).map((entry) => entry.path);
    // Con el límite del workspace en 2, "a/b" se lista pero "a/b/c" no debería
    // alcanzarse (2 niveles desde "a": b, y los hijos de b).
    expect(paths).toContain('a/b');
    expect(paths.some((p) => p.includes('deep.txt'))).toBe(false);
  });

  it('node_modules pesado no se recorre, solo se reporta como excluido', async () => {
    await mkdir(path.join(workspace.root, 'node_modules', 'pkg'), { recursive: true });
    for (let i = 0; i < 30; i += 1) {
      await writeFile(path.join(workspace.root, 'node_modules', 'pkg', `f${i}.js`), 'x');
    }
    await setUpHarness({ maxFileBytes: 1_048_576, maxTreeEntries: 5, maxTreeDepth: 3 });

    const { isError, parsed } = await callToolJson(harness!.client, 'workspace.tree', { workspaceId, relativePath: '.' });
    expect(isError).toBe(false);
    // Si el servidor hubiera intentado recorrer node_modules, maxEntries=5 se
    // habría agotado ahí y "README.md"/"src" no aparecerían.
    expect(parsed['excluded']).toContain('node_modules');
    const paths = (parsed['entries'] as Array<{ path: string }>).map((entry) => entry.path);
    expect(paths).toContain('README.md');
  });
});
