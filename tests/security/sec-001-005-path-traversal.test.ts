import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, tryCreateDirJunction, tryCreateFileSymlink, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * SEC-001 a SEC-005 (TEST_PLAN.md §5), a través del camino real:
 * cliente MCP -> servidor -> tool -> permisos -> sandbox de rutas.
 *
 * No basta con probar `resolveSafePath` en aislamiento (ver tests/unit/paths.test.ts):
 * esta suite demuestra que el error correcto llega hasta el cliente MCP.
 */

let harness: Harness;
let workspace: TempWorkspace;
let outside: TempWorkspace;
const workspaceId = 'ws_sec_paths';

function tempConfigPath(): string {
  return path.join(os.tmpdir(), `localbridge-sec-paths-${randomUUID()}`, 'workspaces.json');
}

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = tempConfigPath();
  await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root })]);

  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
  await outside.cleanup();
});

describe('[SEC-001] path traversal vía file.read', () => {
  it('".." es rechazado', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: '..' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('"../../../etc/passwd" es rechazado', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', {
      workspaceId,
      path: '../../../etc/passwd',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('path traversal vía workspace.tree también se rechaza', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'workspace.tree', {
      workspaceId,
      relativePath: '../',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_OUTSIDE_WORKSPACE');
  });
});

describe('[SEC-002] rutas absolutas', () => {
  it('una ruta absoluta de Windows es rechazada por file.read', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', {
      workspaceId,
      path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('ABSOLUTE_PATH_FORBIDDEN');
  });

  it('una ruta absoluta es rechazada por file.metadata', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.metadata', {
      workspaceId,
      path: '/etc/passwd',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('ABSOLUTE_PATH_FORBIDDEN');
  });
});

describe('[SEC-003] escape por symlink de archivo, vía file.read', () => {
  it('un symlink a un secreto existente fuera del workspace es denegado', async () => {
    await writeFile(path.join(outside.root, 'id_rsa'), 'external secret\n');
    const attempt = await tryCreateFileSymlink(path.join(outside.root, 'id_rsa'), path.join(workspace.root, 'escape-link'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks de archivo no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    const { isError, parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'escape-link' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('SYMLINK_ESCAPE');
  });

  it('un symlink colgante (target externo que aún no existe) da FILE_NOT_FOUND, no SYMLINK_ESCAPE', async () => {
    // Documenta un límite real de la detección por realpath: `fs.realpath` no
    // puede revelar el destino de un symlink roto, así que la caminata al
    // ancestro más cercano llega hasta el root (contenido) y concluye
    // "no existe". No es explotable en la Fase 2 (nada que leer si no existe),
    // pero es la razón por la que la Fase 3 (escritura) no puede confiar solo
    // en realpath: debe comprobar con `lstat` si el segmento inmediato es un
    // symlink, exista o no su destino, antes de escribir a través de él.
    const attempt = await tryCreateFileSymlink(
      path.join(outside.root, 'no-existe-todavia.txt'),
      path.join(workspace.root, 'dangling-link'),
    );
    if (!attempt.created) {
      console.warn(`[skip] symlinks de archivo no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    const { isError, parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'dangling-link' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('FILE_NOT_FOUND');
  });
});

describe('[SEC-004] escape por junction de Windows, vía file.read', () => {
  it('workspace/tmp/link -> fuera del root es denegado aunque el archivo final no exista', async () => {
    await mkdir(path.join(workspace.root, 'tmp'), { recursive: true });

    const attempt = await tryCreateDirJunction(outside.root, path.join(workspace.root, 'tmp', 'link'));
    if (!attempt.created) {
      console.warn(`[skip] junctions no soportadas en este entorno: ${attempt.reason}`);
      return;
    }

    const { isError, parsed } = await callToolJson(harness.client, 'file.read', {
      workspaceId,
      path: 'tmp/link/x.ts',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('SYMLINK_ESCAPE');
  });
});

describe('[SEC-005] workspaceId no autorizado', () => {
  it('un workspaceId inventado no revela si existe', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', {
      workspaceId: 'ws_no_existe_jamas',
      path: 'src/index.ts',
    });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('lo mismo aplica a workspace.tree y file.metadata', async () => {
    const tree = await callToolJson(harness.client, 'workspace.tree', { workspaceId: 'ws_falso' });
    const meta = await callToolJson(harness.client, 'file.metadata', { workspaceId: 'ws_falso', path: 'x' });

    expect((tree.parsed['error'] as { code: string }).code).toBe('WORKSPACE_NOT_FOUND');
    expect((meta.parsed['error'] as { code: string }).code).toBe('WORKSPACE_NOT_FOUND');
  });
});
