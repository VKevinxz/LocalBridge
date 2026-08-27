import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLocalBridgeError } from '@localbridge/shared';
import { resolveWriteTarget } from '@localbridge/workspace';

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
    expect((error as { code: string }).code).toBe(code);
  }
}

describe('resolveWriteTarget — casos válidos', () => {
  it('un archivo nuevo en un directorio existente: exists=false', async () => {
    const result = await resolveWriteTarget(workspace.root, 'docs/new.md', { createParentDirs: true });
    expect(result.exists).toBe(false);
    expect(result.basename).toBe('new.md');
  });

  it('un archivo existente: exists=true, type=file', async () => {
    const result = await resolveWriteTarget(workspace.root, 'src/index.ts', { createParentDirs: true });
    expect(result.exists).toBe(true);
    expect(result.type).toBe('file');
  });

  it('createParentDirs=true crea la cadena de directorios que falte', async () => {
    const result = await resolveWriteTarget(workspace.root, 'a/b/c/new.md', { createParentDirs: true });
    expect(result.exists).toBe(false);
    expect(result.realParentDir.endsWith(path.join('a', 'b', 'c'))).toBe(true);

    // Verificable de verdad: escribiendo en esa ruta real debe funcionar.
    await writeFile(path.join(result.realParentDir, result.basename), 'contenido');
  });

  it('createParentDirs=false NO crea nada y trata la ruta como inexistente', async () => {
    const result = await resolveWriteTarget(workspace.root, 'no/existe/aun.md', { createParentDirs: false });
    expect(result.exists).toBe(false);
    // No se creó "no/" ni "no/existe/".
    await expect(resolveWriteTarget(workspace.root, 'no', { createParentDirs: false })).resolves.toMatchObject({
      exists: false,
    });
  });
});

describe('resolveWriteTarget — [SEC-006/007 relacionado] permisos y existencia', () => {
  it('un directorio existente en la posición del target: exists=true, type=dir', async () => {
    const result = await resolveWriteTarget(workspace.root, 'src', { createParentDirs: true });
    expect(result.exists).toBe(true);
    expect(result.type).toBe('dir');
  });
});

describe('resolveWriteTarget — path traversal y rutas absolutas', () => {
  it('rechaza ".."', async () => {
    await expectCode(resolveWriteTarget(workspace.root, '../escape.md', { createParentDirs: true }), 'PATH_OUTSIDE_WORKSPACE');
  });

  it('rechaza una ruta absoluta', async () => {
    await expectCode(
      resolveWriteTarget(workspace.root, 'C:\\Windows\\evil.md', { createParentDirs: true }),
      'ABSOLUTE_PATH_FORBIDDEN',
    );
  });
});

describe('resolveWriteTarget — [SEC-020 relacionado] symlink en el componente final', () => {
  it('un symlink existente (resuelve a un archivo real) en el target -> SYMLINK_ESCAPE', async () => {
    await writeFile(path.join(outside.root, 'target.txt'), 'contenido externo');
    const attempt = await tryCreateFileSymlink(path.join(outside.root, 'target.txt'), path.join(workspace.root, 'link.md'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    await expectCode(resolveWriteTarget(workspace.root, 'link.md', { createParentDirs: true }), 'SYMLINK_ESCAPE');
  });

  it('un symlink COLGANTE (destino externo inexistente) en el target -> SYMLINK_ESCAPE, no "no existe"', async () => {
    // Este es el caso que motivó ADR-0013: resolveSafePath (de lectura) trataría
    // esto como "no existe"; resolveWriteTarget debe rechazarlo explícitamente.
    const attempt = await tryCreateFileSymlink(
      path.join(outside.root, 'no-existe-todavia.txt'),
      path.join(workspace.root, 'dangling.md'),
    );
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    await expectCode(resolveWriteTarget(workspace.root, 'dangling.md', { createParentDirs: true }), 'SYMLINK_ESCAPE');
  });

  it('un symlink interno (apunta dentro del workspace) en el target también se rechaza', async () => {
    const attempt = await tryCreateFileSymlink(path.join(workspace.root, 'README.md'), path.join(workspace.root, 'internal-link.md'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    // ADR-0013: se rechaza CUALQUIER symlink en el target, interno o no.
    await expectCode(resolveWriteTarget(workspace.root, 'internal-link.md', { createParentDirs: true }), 'SYMLINK_ESCAPE');
  });

  it('un symlink de directorio en un segmento intermedio (junction) -> SYMLINK_ESCAPE', async () => {
    const attempt = await tryCreateDirJunction(outside.root, path.join(workspace.root, 'linked-dir'));
    if (!attempt.created) {
      console.warn(`[skip] junctions no soportadas en este entorno: ${attempt.reason}`);
      return;
    }

    await expectCode(
      resolveWriteTarget(workspace.root, 'linked-dir/new.md', { createParentDirs: true }),
      'SYMLINK_ESCAPE',
    );
  });

  it('una junction colgante como segmento intermedio también se rechaza al crear directorios', async () => {
    // outside2 no existe todavía: junction colgante de directorio.
    const nonExistentTarget = path.join(outside.root, 'no-existe-aun');
    const attempt = await tryCreateDirJunction(nonExistentTarget, path.join(workspace.root, 'dangling-dir-link'));
    if (!attempt.created) {
      console.warn(`[skip] junctions colgantes no soportadas en este entorno: ${attempt.reason}`);
      return;
    }

    await expectCode(
      resolveWriteTarget(workspace.root, 'dangling-dir-link/new.md', { createParentDirs: true }),
      'SYMLINK_ESCAPE',
    );
  });
});

describe('resolveWriteTarget — segmento intermedio que es un archivo, no un directorio', () => {
  it('rechaza con NOT_A_FILE', async () => {
    await mkdir(path.join(workspace.root, 'flat'), { recursive: true });
    await writeFile(path.join(workspace.root, 'flat', 'im-a-file'), 'x');

    await expectCode(
      resolveWriteTarget(workspace.root, 'flat/im-a-file/new.md', { createParentDirs: true }),
      'NOT_A_FILE',
    );
  });
});
