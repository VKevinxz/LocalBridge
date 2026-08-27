import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBridgeError, isLocalBridgeError } from '@localbridge/shared';
import { resolveSafePath } from '@localbridge/workspace';

import {
  createTempWorkspaceDir,
  populateSampleProject,
  tryCreateDirJunction,
  tryCreateFileSymlink,
  type TempWorkspace,
} from '../helpers/fixtures.js';

let workspace: TempWorkspace;
let outside: TempWorkspace;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await writeFile(path.join(outside.root, 'id_rsa'), 'external secret\n');
});

afterEach(async () => {
  await workspace.cleanup();
  await outside.cleanup();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`esperaba que lanzara ${code}`);
  } catch (error) {
    expect(isLocalBridgeError(error)).toBe(true);
    expect((error as LocalBridgeError).code).toBe(code);
  }
}

describe('resolveSafePath — casos válidos', () => {
  it('resuelve una ruta normal dentro del workspace', async () => {
    const result = await resolveSafePath(workspace.root, 'src/index.ts');
    expect(result.exists).toBe(true);
    expect(result.relativePath).toBe('src/index.ts');
  });

  it('resuelve el propio root con "."', async () => {
    const result = await resolveSafePath(workspace.root, '.');
    expect(result.exists).toBe(true);
    expect(result.relativePath).toBe('');
  });

  it('un archivo inexistente dentro del workspace no lanza, exists=false', async () => {
    const result = await resolveSafePath(workspace.root, 'src/no-existe.ts');
    expect(result.exists).toBe(false);
  });

  it('un archivo cuyo directorio padre tampoco existe todavía: exists=false, sin lanzar', async () => {
    const result = await resolveSafePath(workspace.root, 'a/b/c/no-existe.ts');
    expect(result.exists).toBe(false);
  });

  it('tolera separadores de Windows en la entrada', async () => {
    const result = await resolveSafePath(workspace.root, 'src\\index.ts');
    expect(result.exists).toBe(true);
    expect(result.relativePath).toBe('src/index.ts');
  });

  it('en Windows, el filesystem es insensible a mayúsculas: casing distinto sigue resolviendo', async () => {
    const result = await resolveSafePath(workspace.root, 'SRC/INDEX.TS');
    expect(result.exists).toBe(true);
  });
});

describe('resolveSafePath — [SEC-001] path traversal', () => {
  it('rechaza ".." simple', async () => {
    await expectCode(resolveSafePath(workspace.root, '..'), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rechaza ".." anidado apuntando fuera', async () => {
    await expectCode(resolveSafePath(workspace.root, '../../../etc/passwd'), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rechaza ".." mezclado con segmentos válidos', async () => {
    await expectCode(resolveSafePath(workspace.root, 'src/../../outside.ts'), 'PATH_OUTSIDE_WORKSPACE');
  });
});

describe('resolveSafePath — [SEC-002] rutas absolutas', () => {
  it('rechaza una ruta absoluta de Windows', async () => {
    await expectCode(resolveSafePath(workspace.root, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), 'ABSOLUTE_PATH_FORBIDDEN');
  });

  it('rechaza una ruta absoluta estilo POSIX', async () => {
    await expectCode(resolveSafePath(workspace.root, '/etc/passwd'), 'ABSOLUTE_PATH_FORBIDDEN');
  });

  it('rechaza una ruta UNC', async () => {
    await expectCode(resolveSafePath(workspace.root, '\\\\server\\share\\file.txt'), 'ABSOLUTE_PATH_FORBIDDEN');
  });
});

describe('resolveSafePath — nombres reservados de Windows', () => {
  it.each(['CON', 'con', 'NUL', 'com1', 'LPT1', 'con.txt'])('rechaza el nombre reservado "%s"', async (segment) => {
    await expectCode(resolveSafePath(workspace.root, `src/${segment}`), 'INVALID_INPUT');
  });

  it('no rechaza un nombre parecido pero no reservado', async () => {
    const result = await resolveSafePath(workspace.root, 'src/console.ts');
    expect(result.exists).toBe(false); // no existe, pero no debe lanzar
  });
});

describe('resolveSafePath — [SEC-003] escape por symlink de archivo', () => {
  it('un symlink interno (dentro del root) es accesible con normalidad', async () => {
    const linkPath = path.join(workspace.root, 'src', 'internal-link.ts');
    const attempt = await tryCreateFileSymlink(path.join(workspace.root, 'README.md'), linkPath);
    if (!attempt.created) {
      console.warn(`[skip] no se pudieron crear symlinks de archivo en este entorno: ${attempt.reason}`);
      return;
    }

    const result = await resolveSafePath(workspace.root, 'src/internal-link.ts');
    expect(result.exists).toBe(true);
  });

  it('workspace/link -> fuera del root => SYMLINK_ESCAPE', async () => {
    const linkPath = path.join(workspace.root, 'link-to-secret');
    const attempt = await tryCreateFileSymlink(path.join(outside.root, 'id_rsa'), linkPath);
    if (!attempt.created) {
      console.warn(`[skip] no se pudieron crear symlinks de archivo en este entorno: ${attempt.reason}`);
      return;
    }

    await expectCode(resolveSafePath(workspace.root, 'link-to-secret'), 'SYMLINK_ESCAPE');
  });
});

describe('resolveSafePath — [SEC-004] escape por junction de Windows', () => {
  it('workspace/tmp/link -> fuera del root (ancestro inexistente) => SYMLINK_ESCAPE', async () => {
    await mkdir(path.join(workspace.root, 'tmp'), { recursive: true });
    const linkPath = path.join(workspace.root, 'tmp', 'link');
    const attempt = await tryCreateDirJunction(outside.root, linkPath);
    if (!attempt.created) {
      console.warn(`[skip] no se pudieron crear junctions en este entorno: ${attempt.reason}`);
      return;
    }

    // El archivo final no existe, pero el ancestro "tmp/link" sí, y resuelve
    // fuera del root: exactamente el ejemplo de SECURITY.md §3.3.
    await expectCode(resolveSafePath(workspace.root, 'tmp/link/x.ts'), 'SYMLINK_ESCAPE');
  });

  it('una junction que apunta dentro del root es accesible con normalidad', async () => {
    const linkPath = path.join(workspace.root, 'alias-src');
    const attempt = await tryCreateDirJunction(path.join(workspace.root, 'src'), linkPath);
    if (!attempt.created) {
      console.warn(`[skip] no se pudieron crear junctions en este entorno: ${attempt.reason}`);
      return;
    }

    const result = await resolveSafePath(workspace.root, 'alias-src/index.ts');
    expect(result.exists).toBe(true);
  });
});

describe('resolveSafePath — revalidación repetible', () => {
  it('llamar dos veces seguidas da el mismo resultado (idempotente)', async () => {
    const first = await resolveSafePath(workspace.root, 'src/index.ts');
    const second = await resolveSafePath(workspace.root, 'src/index.ts');
    expect(first.realPath).toBe(second.realPath);
  });
});
