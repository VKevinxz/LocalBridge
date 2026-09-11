import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitStaged, getCommitSnapshot, getPushSnapshot, pushCommits, runGit, stageFiles } from '@localbridge/git';
import { isLocalBridgeError } from '@localbridge/shared';

import {
  addGitRemote,
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initBareGitRepo,
  initGitRepo,
  populateSampleProject,
  type TempWorkspace,
} from '../helpers/fixtures.js';

let workspace: TempWorkspace;
const REAL_GIT_HOOK_TIMEOUT_MS = 30_000;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await initGitRepo(workspace.root);
  await gitCommitAll(workspace.root, 'commit inicial');
}, REAL_GIT_HOOK_TIMEOUT_MS);

afterEach(async () => {
  await workspace.cleanup();
}, REAL_GIT_HOOK_TIMEOUT_MS);

function gitWorkspace() {
  return buildWorkspace({
    rootPath: workspace.root,
    permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: false, gitWrite: true },
  });
}

async function commit(message: string) {
  const target = gitWorkspace();
  return commitStaged(target, message, await getCommitSnapshot(target));
}

async function push(remote?: string, branch?: string) {
  const target = gitWorkspace();
  return pushCommits(target, await getPushSnapshot(target, remote, branch));
}

describe('stageFiles', () => {
  it('mete el archivo en el índice, verificable con git diff --cached', async () => {
    await writeFile(path.join(workspace.root, 'README.md'), '# cambiado\n');

    const result = await stageFiles(gitWorkspace(), ['README.md']);

    expect(result.staged).toEqual(['README.md']);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const diff = await run('git', ['diff', '--cached', '--name-only'], { cwd: workspace.root });
    expect(diff.stdout.trim()).toBe('README.md');
  });

  it('stagea un asset administrado mayor que la cuota de texto', async () => {
    await writeFile(path.join(workspace.root, 'large-asset.bin'), Buffer.alloc(2 * 1024 * 1024, 0x6b));
    const target = buildWorkspace({
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: false, gitWrite: true },
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });

    await expect(stageFiles(target, ['large-asset.bin'])).resolves.toEqual({ staged: ['large-asset.bin'] });
    const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: workspace.root });
    expect(staged.stdout.trim()).toBe('large-asset.bin');
  });

  it('rechaza una ruta fuera del workspace', async () => {
    await expect(stageFiles(gitWorkspace(), ['../fuera.txt'])).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rechaza un archivo denegado por la denylist', async () => {
    await writeFile(path.join(workspace.root, '.env'), 'SECRET=x\n');

    await expect(stageFiles(gitWorkspace(), ['.env'])).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('rechaza un archivo que no existe', async () => {
    await expect(stageFiles(gitWorkspace(), ['no-existe.txt'])).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('permite stagear la eliminación de un archivo tracked', async () => {
    await writeFile(path.join(workspace.root, 'eliminado.txt'), 'tracked\n');
    await stageFiles(gitWorkspace(), ['eliminado.txt']);
    await commit('agrega archivo que luego se elimina');
    await rm(path.join(workspace.root, 'eliminado.txt'));

    await expect(stageFiles(gitWorkspace(), ['eliminado.txt'])).resolves.toEqual({ staged: ['eliminado.txt'] });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const diff = await promisify(execFile)('git', ['diff', '--cached', '--name-status'], { cwd: workspace.root });
    expect(diff.stdout.trim()).toBe('D\teliminado.txt');
  });

  it('permite stagear ambos extremos de un rename', async () => {
    await writeFile(path.join(workspace.root, 'antes.txt'), 'tracked\n');
    await stageFiles(gitWorkspace(), ['antes.txt']);
    await commit('agrega archivo que luego se renombra');
    await rename(path.join(workspace.root, 'antes.txt'), path.join(workspace.root, 'despues.txt'));

    await stageFiles(gitWorkspace(), ['antes.txt', 'despues.txt']);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const diff = await promisify(execFile)('git', ['diff', '--cached', '--name-status'], { cwd: workspace.root });
    expect(diff.stdout.trim()).toMatch(/^R\d+\tantes\.txt\tdespues\.txt$/);
  });

  it('rechaza una lista vacía de rutas', async () => {
    await expect(stageFiles(gitWorkspace(), [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rechaza filtros clean que podrían ejecutar programas durante git add', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await writeFile(path.join(workspace.root, '.gitattributes'), '*.txt filter=malicioso\n');
    await run('git', ['config', 'filter.malicioso.clean', 'programa-que-no-debe-ejecutarse'], { cwd: workspace.root });
    await writeFile(path.join(workspace.root, 'filtrado.txt'), 'contenido\n');

    await expect(stageFiles(gitWorkspace(), ['filtrado.txt'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('runner Git', () => {
  it('permite un timeout específico y termina una operación que queda esperando entrada', async () => {
    await expect(runGit(['cat-file', '--batch'], { cwd: workspace.root, timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('commitStaged', () => {
  it('crea el primer commit de un repositorio sin HEAD', async () => {
    const empty = await createTempWorkspaceDir();
    try {
      await initGitRepo(empty.root);
      await writeFile(path.join(empty.root, 'README.md'), '# primero\n');
      const target = buildWorkspace({
        rootPath: empty.root,
        permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: false, gitWrite: true },
      });
      await stageFiles(target, ['README.md']);

      const snapshot = await getCommitSnapshot(target);
      expect(snapshot.parentHash).toBeUndefined();
      const result = await commitStaged(target, 'primer commit', snapshot);

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const shown = await promisify(execFile)('git', ['log', '-1', '--format=%H %P %s'], { cwd: empty.root });
      expect(shown.stdout.trim()).toBe(`${result.commitHash}  primer commit`);
    } finally {
      await empty.cleanup();
    }
  });

  it('rechaza un archivo denegado que otro programa haya dejado staged', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await writeFile(path.join(workspace.root, '.env'), 'SECRET=nuevo\n');
    await run('git', ['add', '--', '.env'], { cwd: workspace.root });

    await expect(getCommitSnapshot(gitWorkspace())).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('crea un commit real y devuelve su hash', async () => {
    await writeFile(path.join(workspace.root, 'README.md'), '# cambiado de verdad\n');
    await stageFiles(gitWorkspace(), ['README.md']);

    const result = await commit('actualiza el README');

    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const log = await run('git', ['log', '-1', '--format=%H %s'], { cwd: workspace.root });
    expect(log.stdout.trim()).toBe(`${result.commitHash} actualiza el README`);
  });

  it('nunca usa --amend: dos commits seguidos dejan dos commits reales', async () => {
    await writeFile(path.join(workspace.root, 'a.txt'), 'a\n');
    await stageFiles(gitWorkspace(), ['a.txt']);
    const first = await commit('primero');

    await writeFile(path.join(workspace.root, 'b.txt'), 'b\n');
    await stageFiles(gitWorkspace(), ['b.txt']);
    const second = await commit('segundo');

    expect(first.commitHash).not.toBe(second.commitHash);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const log = await run('git', ['log', '--format=%s'], { cwd: workspace.root });
    expect(log.stdout.trim().split('\n')).toEqual(['segundo', 'primero', 'commit inicial']);
  });

  it('falla cerrado si la rama cambia después del snapshot aprobado', async () => {
    await writeFile(path.join(workspace.root, 'README.md'), '# aprobado\n');
    await stageFiles(gitWorkspace(), ['README.md']);
    const snapshot = await getCommitSnapshot(gitWorkspace());

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await writeFile(path.join(workspace.root, 'cambio-concurrente.txt'), 'otro proceso\n');
    await run('git', ['add', '--', 'cambio-concurrente.txt'], { cwd: workspace.root });
    await run('git', ['commit', '-m', 'commit concurrente'], { cwd: workspace.root });
    const concurrentHead = (await run('git', ['rev-parse', 'HEAD'], { cwd: workspace.root })).stdout.trim();

    await expect(commitStaged(gitWorkspace(), 'snapshot ya obsoleto', snapshot)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: workspace.root })).stdout.trim()).toBe(concurrentHead);
  });

  it('crea el árbol aprobado aunque el índice cambie después del snapshot', async () => {
    await writeFile(path.join(workspace.root, 'README.md'), '# árbol aprobado\n');
    await stageFiles(gitWorkspace(), ['README.md']);
    const snapshot = await getCommitSnapshot(gitWorkspace());

    await writeFile(path.join(workspace.root, 'posterior.txt'), 'no aprobado\n');
    await stageFiles(gitWorkspace(), ['posterior.txt']);
    const result = await commitStaged(gitWorkspace(), 'solo árbol aprobado', snapshot);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const committedTree = (await run('git', ['rev-parse', `${result.commitHash}^{tree}`], { cwd: workspace.root })).stdout.trim();
    expect(committedTree).toBe(snapshot.treeHash);
    await expect(run('git', ['show', `${result.commitHash}:posterior.txt`], { cwd: workspace.root })).rejects.toBeDefined();
  });

  it('no ejecuta hooks de commit ni firma GPG configurados por el repositorio', async () => {
    const hooks = path.join(workspace.root, 'malicious-hooks');
    await mkdir(hooks);
    const hook = path.join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 73\n');
    await chmod(hook, 0o755);
    const referenceHook = path.join(hooks, 'reference-transaction');
    await writeFile(referenceHook, '#!/bin/sh\nexit 75\n');
    await chmod(referenceHook, 0o755);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['config', 'core.hooksPath', hooks], { cwd: workspace.root });
    await run('git', ['config', 'commit.gpgSign', 'true'], { cwd: workspace.root });
    await run('git', ['config', 'gpg.program', path.join(workspace.root, 'programa-que-no-existe')], { cwd: workspace.root });

    await writeFile(path.join(workspace.root, 'README.md'), '# sin ejecución implícita\n');
    await stageFiles(gitWorkspace(), ['README.md']);
    await expect(commit('commit seguro')).resolves.toMatchObject({ commitHash: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});

describe('pushCommits', () => {
  let remoteRoot: string;

  beforeEach(async () => {
    const remoteWorkspace = await createTempWorkspaceDir();
    remoteRoot = remoteWorkspace.root;
    await initBareGitRepo(remoteRoot);
    await addGitRemote(workspace.root, 'origin', remoteRoot);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['push', '-u', 'origin', 'main'], { cwd: workspace.root });
  }, REAL_GIT_HOOK_TIMEOUT_MS);

  it('empuja un commit real a un remoto real', async () => {
    await writeFile(path.join(workspace.root, 'nuevo.txt'), 'contenido\n');
    await stageFiles(gitWorkspace(), ['nuevo.txt']);
    const { commitHash } = await commit('para el remoto');

    const result = await push();

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const remoteLog = await run('git', ['log', '-1', '--format=%H'], { cwd: remoteRoot });
    expect(remoteLog.stdout.trim()).toBe(commitHash);
    expect(result).toEqual({
      status: 'pushed',
      commitHash,
      remote: 'origin',
      branch: 'main',
      remoteVerified: true,
      localTrackingSynchronized: true,
    });
    expect((await run('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: workspace.root })).stdout.trim()).toBe(commitHash);
  });

  it('un push sin nada nuevo se identifica como up_to_date y refresca el tracking local', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const remoteHead = (await run('git', ['rev-parse', 'main'], { cwd: remoteRoot })).stdout.trim();
    const staleHead = (await run('git', ['rev-parse', 'HEAD~0'], { cwd: workspace.root })).stdout.trim();
    expect(staleHead).toBe(remoteHead);

    const result = await push();

    expect(result).toEqual({
      status: 'up_to_date',
      commitHash: remoteHead,
      remote: 'origin',
      branch: 'main',
      remoteVerified: true,
      localTrackingSynchronized: true,
    });
  });

  it('no pisa una referencia tracking modificada concurrentemente', async () => {
    await writeFile(path.join(workspace.root, 'aprobado-tracking.txt'), 'aprobado\n');
    await stageFiles(gitWorkspace(), ['aprobado-tracking.txt']);
    const approved = await commit('push con tracking concurrente');
    const snapshot = await getPushSnapshot(gitWorkspace(), undefined, undefined);

    await writeFile(path.join(workspace.root, 'posterior-tracking.txt'), 'posterior\n');
    await stageFiles(gitWorkspace(), ['posterior-tracking.txt']);
    const later = await commit('avance local concurrente');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['update-ref', 'refs/remotes/origin/main', later.commitHash], { cwd: workspace.root });

    const result = await pushCommits(gitWorkspace(), snapshot);

    expect(result).toMatchObject({
      status: 'pushed',
      commitHash: approved.commitHash,
      remoteVerified: true,
      localTrackingSynchronized: false,
    });
    expect((await run('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: workspace.root })).stdout.trim()).toBe(later.commitHash);
    expect((await run('git', ['rev-parse', 'main'], { cwd: remoteRoot })).stdout.trim()).toBe(approved.commitHash);
  });

  it('un push que el remoto rechaza (no fast-forward) da GIT_PUSH_REJECTED, no INTERNAL_ERROR', async () => {
    // Otro clon empuja primero, dejando el remoto por delante del workspace local.
    const otherClone = await createTempWorkspaceDir();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['clone', remoteRoot, otherClone.root]);
    await run('git', ['config', 'user.email', 'test@localbridge.invalid'], { cwd: otherClone.root });
    await run('git', ['config', 'user.name', 'LocalBridge Test'], { cwd: otherClone.root });
    await writeFile(path.join(otherClone.root, 'desde-otro-clon.txt'), 'x\n');
    await run('git', ['add', '-A'], { cwd: otherClone.root });
    await run('git', ['commit', '-m', 'desde otro clon'], { cwd: otherClone.root });
    await run('git', ['push', 'origin', 'main'], { cwd: otherClone.root });

    // El workspace local no tiene ese commit todavía: su push debe ser rechazado.
    await writeFile(path.join(workspace.root, 'local.txt'), 'y\n');
    await stageFiles(gitWorkspace(), ['local.txt']);
    await commit('commit local divergente');

    try {
      await push();
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('GIT_PUSH_REJECTED');
    }
  });

  it('no ejecuta el hook pre-push configurado por el repositorio', async () => {
    const hooks = path.join(workspace.root, 'malicious-push-hooks');
    await mkdir(hooks);
    const hook = path.join(hooks, 'pre-push');
    await writeFile(hook, '#!/bin/sh\nexit 74\n');
    await chmod(hook, 0o755);
    const referenceHook = path.join(hooks, 'reference-transaction');
    await writeFile(referenceHook, '#!/bin/sh\nexit 75\n');
    await chmod(referenceHook, 0o755);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['config', 'core.hooksPath', hooks], { cwd: workspace.root });

    await writeFile(path.join(workspace.root, 'sin-hook.txt'), 'seguro\n');
    await stageFiles(gitWorkspace(), ['sin-hook.txt']);
    const { commitHash } = await commit('push sin hooks');
    await expect(push()).resolves.toMatchObject({ localTrackingSynchronized: true });
    expect((await run('git', ['rev-parse', 'main'], { cwd: remoteRoot })).stdout.trim()).toBe(commitHash);
  });

  it('publica solo el hash aprobado aunque HEAD avance antes de ejecutar el push', async () => {
    await writeFile(path.join(workspace.root, 'aprobado.txt'), 'sí\n');
    await stageFiles(gitWorkspace(), ['aprobado.txt']);
    const approved = await commit('aprobado para push');
    const snapshot = await getPushSnapshot(gitWorkspace(), undefined, undefined);

    await writeFile(path.join(workspace.root, 'posterior-push.txt'), 'no\n');
    await stageFiles(gitWorkspace(), ['posterior-push.txt']);
    const later = await commit('posterior al permiso');
    expect(later.commitHash).not.toBe(approved.commitHash);

    await pushCommits(gitWorkspace(), snapshot);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    expect((await run('git', ['rev-parse', 'main'], { cwd: remoteRoot })).stdout.trim()).toBe(approved.commitHash);
  });

  it('conserva el destino aprobado aunque la configuración del remote cambie', async () => {
    await writeFile(path.join(workspace.root, 'destino-aprobado.txt'), 'sí\n');
    await stageFiles(gitWorkspace(), ['destino-aprobado.txt']);
    const approved = await commit('destino aprobado');
    const snapshot = await getPushSnapshot(gitWorkspace(), undefined, undefined);

    const alternate = await createTempWorkspaceDir();
    try {
      await initBareGitRepo(alternate.root);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      await run('git', ['remote', 'set-url', 'origin', alternate.root], { cwd: workspace.root });

      await pushCommits(gitWorkspace(), snapshot);

      expect((await run('git', ['rev-parse', 'main'], { cwd: remoteRoot })).stdout.trim()).toBe(approved.commitHash);
      await expect(run('git', ['rev-parse', 'main'], { cwd: alternate.root })).rejects.toBeDefined();
    } finally {
      await alternate.cleanup();
    }
  });

  it('rechaza helpers remotos y reescrituras de URL definidos por el repositorio', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    await run('git', ['remote', 'set-url', 'origin', 'malicioso::destino'], { cwd: workspace.root });
    await expect(getPushSnapshot(gitWorkspace(), 'origin', 'main')).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await run('git', ['remote', 'set-url', 'origin', remoteRoot], { cwd: workspace.root });
    await run('git', ['config', '--local', 'url.malicioso::.insteadOf', remoteRoot], { cwd: workspace.root });
    await expect(getPushSnapshot(gitWorkspace(), 'origin', 'main')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('límite de autorización Git write', () => {
  it('rechaza commit y push si el workspace es solo un subdirectorio del repositorio', async () => {
    const nested = buildWorkspace({
      rootPath: path.join(workspace.root, 'src'),
      permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: false, gitWrite: true },
    });

    await expect(getCommitSnapshot(nested)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(getPushSnapshot(nested, 'origin', 'main')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('read-back tras escritura real, contra el binario de git real', () => {
  it('el contenido commiteado es exactamente el que se escribió', async () => {
    const content = 'contenido exacto verificado\n';
    await writeFile(path.join(workspace.root, 'verificar.txt'), content);
    await stageFiles(gitWorkspace(), ['verificar.txt']);
    const { commitHash } = await commit('verificación de contenido');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const shown = await run('git', ['show', `${commitHash}:verificar.txt`], { cwd: workspace.root });
    expect(shown.stdout).toBe(content);

    const onDisk = await readFile(path.join(workspace.root, 'verificar.txt'), 'utf8');
    expect(onDisk).toBe(content);
  });
});
