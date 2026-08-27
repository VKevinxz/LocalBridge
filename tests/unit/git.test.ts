import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getGitBranches, getGitDiff, getGitLog, getGitStatus } from '@localbridge/git';
import { isLocalBridgeError } from '@localbridge/shared';

import {
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initGitRepo,
  populateSampleProject,
  type TempWorkspace,
} from '../helpers/fixtures.js';

let repo: TempWorkspace;

beforeEach(async () => {
  repo = await createTempWorkspaceDir();
  await populateSampleProject(repo.root);
  await initGitRepo(repo.root);
  await gitCommitAll(repo.root, 'commit inicial');
});

afterEach(async () => {
  await repo.cleanup();
});

function gitWorkspace(rootPath: string) {
  return buildWorkspace({
    rootPath,
    permissions: { read: true, write: false, overwrite: false, gitRead: true, validations: false, gitWrite: false },
  });
}

describe('getGitStatus', () => {
  it('un repositorio limpio no tiene entradas y reporta la rama', async () => {
    const status = await getGitStatus(gitWorkspace(repo.root));

    expect(status.branch).toBe('main');
    expect(status.entries).toEqual([]);
  });

  it('detecta un archivo modificado sin stage', async () => {
    await writeFile(path.join(repo.root, 'README.md'), '# modificado\n');

    const status = await getGitStatus(gitWorkspace(repo.root));
    const entry = status.entries.find((e) => e.path === 'README.md');

    expect(entry).toBeDefined();
    expect(entry?.unstaged).toBe(true);
    expect(entry?.staged).toBe(false);
  });

  it('detecta un archivo sin seguimiento', async () => {
    await writeFile(path.join(repo.root, 'nuevo.txt'), 'nuevo');

    const status = await getGitStatus(gitWorkspace(repo.root));
    const entry = status.entries.find((e) => e.path === 'nuevo.txt');

    expect(entry?.status).toBe('?');
  });

  it('las entradas salen en orden determinista', async () => {
    await writeFile(path.join(repo.root, 'b.txt'), 'b');
    await writeFile(path.join(repo.root, 'a.txt'), 'a');

    const first = await getGitStatus(gitWorkspace(repo.root));
    const second = await getGitStatus(gitWorkspace(repo.root));

    expect(first.entries.map((e) => e.path)).toEqual(second.entries.map((e) => e.path));
  });

  it('un directorio que no es repositorio -> GIT_NOT_REPOSITORY', async () => {
    const plain = await createTempWorkspaceDir();
    try {
      await getGitStatus(gitWorkspace(plain.root));
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('GIT_NOT_REPOSITORY');
    } finally {
      await plain.cleanup();
    }
  });
});

describe('getGitStatus — workspace como subdirectorio del repo', () => {
  it('NO revela cambios de fuera del workspace, y las rutas son relativas al workspace', async () => {
    // El repo tiene `sub/` (workspace autorizado) y `otro/` (fuera).
    await mkdir(path.join(repo.root, 'sub'), { recursive: true });
    await mkdir(path.join(repo.root, 'otro'), { recursive: true });
    await writeFile(path.join(repo.root, 'sub', 'dentro.txt'), 'v1');
    await writeFile(path.join(repo.root, 'otro', 'secreto.txt'), 'v1');
    await gitCommitAll(repo.root, 'añade sub y otro');

    await writeFile(path.join(repo.root, 'sub', 'dentro.txt'), 'v2 modificado');
    await writeFile(path.join(repo.root, 'otro', 'secreto.txt'), 'v2 modificado');

    // El workspace autorizado es SOLO `sub/`.
    const status = await getGitStatus(gitWorkspace(path.join(repo.root, 'sub')));

    const paths = status.entries.map((e) => e.path);
    expect(paths).toContain('dentro.txt'); // relativa al workspace, no `sub/dentro.txt`
    expect(paths.some((p) => p.includes('secreto'))).toBe(false);
    expect(paths.some((p) => p.includes('otro'))).toBe(false);
    expect(paths.some((p) => p.startsWith('..'))).toBe(false);
  });
});

describe('getGitDiff', () => {
  it('devuelve el diff del working tree', async () => {
    await writeFile(path.join(repo.root, 'README.md'), '# cambiado\n');

    const result = await getGitDiff(gitWorkspace(repo.root), undefined, false, undefined);

    expect(result.diff).toContain('README.md');
    expect(result.diff).toContain('# cambiado');
    expect(result.staged).toBe(false);
  });

  it('acota el diff a un archivo concreto', async () => {
    await writeFile(path.join(repo.root, 'README.md'), '# cambiado\n');
    await writeFile(path.join(repo.root, 'src', 'index.ts'), 'export const x = 1;\n');

    const result = await getGitDiff(gitWorkspace(repo.root), 'README.md', false, undefined);

    expect(result.diff).toContain('README.md');
    expect(result.diff).not.toContain('index.ts');
  });

  it('staged=true muestra lo del índice, no lo del working tree', async () => {
    await writeFile(path.join(repo.root, 'README.md'), '# en el indice\n');
    await gitCommitAll(repo.root, 'commit intermedio');
    await writeFile(path.join(repo.root, 'README.md'), '# solo en el working tree\n');

    const staged = await getGitDiff(gitWorkspace(repo.root), undefined, true, undefined);
    expect(staged.diff).toBe(''); // nada en el índice
  });

  it('un archivo denegado por la denylist -> PATH_DENIED', async () => {
    const workspace = gitWorkspace(repo.root);
    try {
      await getGitDiff(workspace, '.env', false, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('PATH_DENIED');
    }
  });

  it('una ruta fuera del workspace -> PATH_OUTSIDE_WORKSPACE', async () => {
    try {
      await getGitDiff(gitWorkspace(repo.root), '../fuera.txt', false, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('PATH_OUTSIDE_WORKSPACE');
    }
  });
});

describe('getGitLog', () => {
  it('devuelve los commits con hash, autor, fecha y asunto', async () => {
    const result = await getGitLog(gitWorkspace(repo.root), undefined, undefined);

    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const [entry] = result.entries;
    expect(entry?.subject).toBe('commit inicial');
    expect(entry?.author).toBe('LocalBridge Test');
    expect(entry?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(entry?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respeta maxCount', async () => {
    await writeFile(path.join(repo.root, 'a.txt'), '1');
    await gitCommitAll(repo.root, 'segundo');
    await writeFile(path.join(repo.root, 'b.txt'), '2');
    await gitCommitAll(repo.root, 'tercero');

    const result = await getGitLog(gitWorkspace(repo.root), 2, undefined);
    expect(result.entries).toHaveLength(2);
  });

  it('acota maxCount al techo de 100 aunque se pida más', async () => {
    const result = await getGitLog(gitWorkspace(repo.root), 100_000, undefined);
    expect(result.entries.length).toBeLessThanOrEqual(100);
  });

  it('un asunto con caracteres especiales no rompe el parseo', async () => {
    await writeFile(path.join(repo.root, 'c.txt'), '3');
    await gitCommitAll(repo.root, 'fix: algo con | y ; y $(echo hola) y "comillas"');

    const result = await getGitLog(gitWorkspace(repo.root), 1, undefined);
    expect(result.entries[0]?.subject).toBe('fix: algo con | y ; y $(echo hola) y "comillas"');
  });
});

describe('getGitBranches', () => {
  it('lista la rama actual', async () => {
    const result = await getGitBranches(gitWorkspace(repo.root));

    expect(result.current).toBe('main');
    expect(result.branches).toContain('main');
  });

  it('un directorio sin repositorio -> GIT_NOT_REPOSITORY', async () => {
    const plain = await createTempWorkspaceDir();
    try {
      await getGitBranches(gitWorkspace(plain.root));
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('GIT_NOT_REPOSITORY');
    } finally {
      await plain.cleanup();
    }
  });
});
