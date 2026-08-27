import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import {
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initGitRepo,
  populateSampleProject,
  writeRegistryFile,
  type TempWorkspace,
} from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** Integración de Fase 4 (TEST_PLAN.md §4, ítems 6 y 7). */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_int_phase4';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await initGitRepo(workspace.root);
  await gitCommitAll(workspace.root, 'commit inicial');

  const configPath = path.join(os.tmpdir(), `localbridge-integration4-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: false, overwrite: true, gitRead: true, validations: false, gitWrite: false },
    }),
  ]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('6. git status', () => {
  it('refleja un cambio hecho por el propio agente vía file.write_guarded', async () => {
    const clean = await callToolJson(harness.client, 'git.status', { workspaceId });
    expect(clean.isError).toBe(false);
    expect(clean.parsed['entries']).toEqual([]);

    // El agente modifica un archivo con sus propias tools...
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      content: '# modificado por el agente\n',
    });

    // ...y Git lo ve, con la misma ruta relativa que usó para escribir.
    const dirty = await callToolJson(harness.client, 'git.status', { workspaceId });
    const entry = (dirty.parsed['entries'] as Array<{ path: string; unstaged: boolean }>).find(
      (e) => e.path === 'README.md',
    );
    expect(entry).toBeDefined();
    expect(entry?.unstaged).toBe(true);
  });
});

describe('7. git diff', () => {
  it('muestra el contenido del cambio, coherente con file.read', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'export const hello = "localbridge";\n',
    });

    const diff = await callToolJson(harness.client, 'git.diff', { workspaceId, filePath: 'src/index.ts' });

    expect(diff.isError).toBe(false);
    expect(diff.parsed['diff']).toContain('localbridge');
    expect(diff.parsed['diff']).toContain('src/index.ts');
  });
});

describe('flujo completo del escenario E2E de TEST_PLAN §7', () => {
  it('tree -> read -> write_guarded -> status -> diff -> log encadenan sin fricción', async () => {
    const tree = await callToolJson(harness.client, 'workspace.tree', { workspaceId, relativePath: 'src' });
    expect(tree.isError).toBe(false);

    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(read.isError).toBe(false);

    const write = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'export function hello(name: string) {\n  return `hola ${name}`;\n}\n',
    });
    expect(write.isError).toBe(false);

    const status = await callToolJson(harness.client, 'git.status', { workspaceId });
    expect((status.parsed['entries'] as Array<{ path: string }>).map((e) => e.path)).toContain('src/index.ts');

    const diff = await callToolJson(harness.client, 'git.diff', { workspaceId, filePath: 'src/index.ts' });
    expect(diff.parsed['diff']).toContain('hola');

    const log = await callToolJson(harness.client, 'git.log', { workspaceId, maxCount: 5 });
    expect((log.parsed['entries'] as unknown[]).length).toBeGreaterThanOrEqual(1);

    const branch = await callToolJson(harness.client, 'git.branch', { workspaceId });
    expect(branch.parsed['current']).toBe('main');
  });
});

describe('git.status tras un commit externo', () => {
  it('el log refleja commits hechos fuera del servidor', async () => {
    await writeFile(path.join(workspace.root, 'externo.txt'), 'hecho por el usuario');
    await gitCommitAll(workspace.root, 'commit hecho por el usuario');

    const log = await callToolJson(harness.client, 'git.log', { workspaceId, maxCount: 1 });
    expect((log.parsed['entries'] as Array<{ subject: string }>)[0]?.subject).toBe('commit hecho por el usuario');
  });
});

describe('Git bloqueado por otro proceso (TEST_PLAN §8, recuperación)', () => {
  it('git.status responde con éxito aunque exista un .git/index.lock ajeno', async () => {
    // Simula un `git add`/`commit`/rebase concurrente de otra herramienta que
    // dejó el lock puesto. `GIT_OPTIONAL_LOCKS=0` (runner.ts) es justo lo que
    // hace que Git se salte el refresco del índice en vez de fallar o colgarse.
    const lockPath = path.join(workspace.root, '.git', 'index.lock');
    await writeFile(lockPath, '');

    try {
      const status = await callToolJson(harness.client, 'git.status', { workspaceId });
      expect(status.isError).toBe(false);
      expect(status.parsed['branch']).toBe('main');
    } finally {
      await rm(lockPath, { force: true });
    }
  });
});
