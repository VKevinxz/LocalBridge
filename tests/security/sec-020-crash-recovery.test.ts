import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * [SEC-020] Crash a mitad de escritura → destino intacto, sin temporales huérfanos.
 *
 * `atomicWrite` en sí (temp + fsync + rename, limpieza en el `catch`) ya está
 * cubierta a nivel unitario en `tests/unit/write-primitives.test.ts`, incluido
 * un fallo real de `open()`. Esta suite verifica la propiedad observable de
 * punta a punta: tras escrituras exitosas repetidas vía MCP, el directorio del
 * workspace nunca contiene un fichero `.{nombre}.tmp-*` huérfano.
 */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_crash';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-crash-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: true, gitRead: false, validations: false, gitWrite: false },
    }),
  ]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

function hasOrphanedTempFile(entries: string[]): boolean {
  return entries.some((name) => /\.tmp-/.test(name));
}

describe('[SEC-020] sin temporales huérfanos tras escrituras vía MCP', () => {
  it('file.create no deja temporales en el directorio', async () => {
    await callToolJson(harness.client, 'file.create', { workspaceId, path: 'nuevo.md', content: 'contenido' });

    const entries = await readdir(workspace.root);
    expect(hasOrphanedTempFile(entries)).toBe(false);
    expect(await readFile(path.join(workspace.root, 'nuevo.md'), 'utf8')).toBe('contenido');
  });

  it('file.write_guarded no deja temporales en el directorio', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      content: 'reemplazado',
    });

    const entries = await readdir(workspace.root);
    expect(hasOrphanedTempFile(entries)).toBe(false);
  });

  it('un write_guarded que falla (HASH_MISMATCH) tampoco deja temporales', async () => {
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: 'a'.repeat(64),
      content: 'no debería escribirse',
    });

    const entries = await readdir(workspace.root);
    expect(hasOrphanedTempFile(entries)).toBe(false);
    expect(await readFile(path.join(workspace.root, 'README.md'), 'utf8')).toBe('# sample\n');
  });

  it('varias escrituras sucesivas sobre el mismo archivo no acumulan temporales', async () => {
    let hash = (await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' })).parsed['sha256'] as string;

    for (let i = 0; i < 5; i += 1) {
      const result = await callToolJson(harness.client, 'file.write_guarded', {
        workspaceId,
        path: 'README.md',
        expectedSha256: hash,
        content: `versión ${i}`,
      });
      hash = result.parsed['sha256'] as string;
    }

    const entries = await readdir(workspace.root);
    expect(entries.filter((name) => name.startsWith('README'))).toEqual(['README.md']);
    expect(hasOrphanedTempFile(entries)).toBe(false);
  });
});
