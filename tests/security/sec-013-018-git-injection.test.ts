import { readdir, writeFile } from 'node:fs/promises';
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

/**
 * [SEC-013] metacaracteres de shell y [SEC-018] inyección de argumentos Git,
 * de punta a punta (SECURITY.md Amenaza F).
 *
 * La propiedad que se prueba no es "el servidor filtra entradas peligrosas",
 * sino que **no hay intérprete de shell en el camino** y que ningún valor
 * controlado por el modelo puede llegar a Git como opción. Por eso los casos
 * comprueban dos cosas a la vez: que la llamada no tiene efectos secundarios, y
 * que el valor se trató como una ruta literal.
 */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_git';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await initGitRepo(workspace.root);
  await gitCommitAll(workspace.root, 'commit inicial');

  const configPath = path.join(os.tmpdir(), `localbridge-sec-git-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: false, overwrite: false, gitRead: true, validations: false, gitWrite: false },
    }),
  ]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('[SEC-013] metacaracteres de shell en filePath', () => {
  const payloads = [
    '; rm -rf .',
    '&& echo pwned > pwned.txt',
    '| cat .env',
    '$(touch inyectado.txt)',
    '`touch inyectado2.txt`',
    'a.txt; touch inyectado3.txt',
    '../../etc/passwd',
    '\n touch inyectado4.txt',
  ];

  it.each(payloads)('git.diff con filePath %j no ejecuta nada ni escribe archivos', async (payload) => {
    const before = (await readdir(workspace.root)).toSorted();

    const { isError } = await callToolJson(harness.client, 'git.diff', { workspaceId, filePath: payload });

    // Puede fallar (ruta fuera del workspace) o devolver un diff vacío (ruta
    // literal que no existe). Lo que NUNCA puede pasar es que se ejecute algo.
    expect(typeof isError).toBe('boolean');

    const after = (await readdir(workspace.root)).toSorted();
    expect(after).toEqual(before);
    expect(after.some((name) => name.startsWith('inyectado'))).toBe(false);
    expect(after).not.toContain('pwned.txt');
  });

  it.each(payloads)('git.log con filePath %j tampoco ejecuta nada', async (payload) => {
    const before = (await readdir(workspace.root)).toSorted();

    await callToolJson(harness.client, 'git.log', { workspaceId, filePath: payload });

    const after = (await readdir(workspace.root)).toSorted();
    expect(after).toEqual(before);
  });
});

describe('[SEC-018] filePath que empieza por "-" se trata como ruta, no como opción', () => {
  it('un filePath con forma de flag no altera el comportamiento de git diff', async () => {
    // Sin el `--` que separa opciones de rutas, Git interpretaría esto como una
    // opción y el comando fallaría o cambiaría de significado.
    const { isError, parsed } = await callToolJson(harness.client, 'git.diff', {
      workspaceId,
      filePath: '--output=/tmp/pwned-diff.txt',
    });

    // El valor viaja como pathspec literal: no existe ese archivo, así que el
    // diff sale vacío en vez de escribir en /tmp.
    if (!isError) {
      expect(parsed['diff']).toBe('');
    }
    await expect(readdir('/tmp/pwned-diff.txt')).rejects.toThrow();
  });

  it('un filePath "--all" no expande el alcance del log', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'git.log', {
      workspaceId,
      filePath: '--all',
    });

    if (!isError) {
      // Tratado como ruta inexistente: sin commits, no como "todas las ramas".
      expect(parsed['entries']).toEqual([]);
    }
  });

  it('un filePath con comodín no se expande como glob', async () => {
    await writeFile(path.join(workspace.root, 'uno.txt'), 'uno');
    await writeFile(path.join(workspace.root, 'dos.txt'), 'dos');
    await gitCommitAll(workspace.root, 'dos archivos');
    await writeFile(path.join(workspace.root, 'uno.txt'), 'uno modificado');
    await writeFile(path.join(workspace.root, 'dos.txt'), 'dos modificado');

    const { isError, parsed } = await callToolJson(harness.client, 'git.diff', {
      workspaceId,
      filePath: '*.txt',
    });

    // `:(literal)` desactiva la magia de pathspec: `*.txt` es el nombre literal
    // de un archivo que no existe, no un patrón que coincida con uno.txt/dos.txt.
    if (!isError) {
      expect(parsed['diff']).toBe('');
    }
  });
});

describe('[SEC-018] el agente no puede inyectar subcomandos ni flags de Git', () => {
  it('no existe ninguna tool que acepte una cadena Git arbitraria', async () => {
    const tools = await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    const gitTools = tools.tools.filter((tool) => tool.name.startsWith('git.'));

    expect(gitTools.map((t) => t.name).toSorted()).toEqual([
      'git.branch',
      'git.commit',
      'git.diff',
      'git.log',
      'git.push',
      'git.stage',
      'git.status',
    ]);

    for (const tool of gitTools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      // Ninguna acepta algo con lo que construir un comando.
      expect(properties).not.toContain('command');
      expect(properties).not.toContain('args');
      expect(properties).not.toContain('ref');
      expect(properties).not.toContain('revision');
    }
  });

  it('git.log con maxCount absurdo se acota, no se pasa tal cual a Git', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'git.log', {
      workspaceId,
      maxCount: 999_999_999,
    });

    expect(isError).toBe(false);
    expect((parsed['entries'] as unknown[]).length).toBeLessThanOrEqual(100);
  });
});

describe('[SEC-013] la denylist se respeta también en las tools de Git', () => {
  it('git.diff sobre un archivo denegado -> PATH_DENIED', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'git.diff', {
      workspaceId,
      filePath: '.env',
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_DENIED');
  });

  it('git.status y el diff general no revelan un archivo denegado modificado externamente', async () => {
    await writeFile(path.join(workspace.root, '.env'), 'SECRET=no-debe-salir\n');

    const status = await callToolJson(harness.client, 'git.status', { workspaceId });
    expect(status.isError).toBe(false);
    expect(JSON.stringify(status.parsed)).not.toContain('.env');
    expect(JSON.stringify(status.parsed)).not.toContain('no-debe-salir');

    const diff = await callToolJson(harness.client, 'git.diff', { workspaceId });
    expect(diff.isError).toBe(false);
    expect(JSON.stringify(diff.parsed)).not.toContain('.env');
    expect(JSON.stringify(diff.parsed)).not.toContain('no-debe-salir');
  });
});

describe('permisos de Git', () => {
  it('gitRead=false deniega las cuatro tools', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-sec-git-noperm-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_no_git',
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);
    const restricted = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    try {
      for (const tool of ['git.status', 'git.diff', 'git.log', 'git.branch']) {
        const { isError, parsed } = await callToolJson(restricted.client, tool, { workspaceId: 'ws_no_git' });
        expect(isError).toBe(true);
        expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
      }
    } finally {
      await restricted.close();
    }
  });

  it('gitWrite=false deniega las tres tools de escritura, antes de pedir ninguna aprobación', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-sec-git-nowrite-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_no_gitwrite',
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: false, gitRead: true, validations: false, gitWrite: false },
      }),
    ]);
    const restricted = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['git.stage', { workspaceId: 'ws_no_gitwrite', paths: ['README.md'] }],
        ['git.commit', { workspaceId: 'ws_no_gitwrite', message: 'debería fallar antes de esto' }],
        ['git.push', { workspaceId: 'ws_no_gitwrite' }],
      ];
      for (const [tool, args] of calls) {
        const { isError, parsed } = await callToolJson(restricted.client, tool, args);
        expect(isError).toBe(true);
        expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
      }
    } finally {
      await restricted.close();
    }
  });
});
