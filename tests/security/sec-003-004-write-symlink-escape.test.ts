import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import {
  buildWorkspace,
  createTempWorkspaceDir,
  populateSampleProject,
  tryCreateFileSymlink,
  writeRegistryFile,
  type TempWorkspace,
} from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * [SEC-003]/[SEC-004] extendidos a escritura, de punta a punta (ADR-0013).
 *
 * La Fase 2 demostró estos códigos para lectura. Esta suite demuestra la parte
 * que motivó el ADR-0013: escribir a través de un symlink —colgante o no— debe
 * rechazarse *antes* de tocar el disco, no solo al leer.
 */

let harness: Harness;
let workspace: TempWorkspace;
let outside: TempWorkspace;
const workspaceId = 'ws_sec_write_symlink';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-write-symlink-${randomUUID()}`, 'workspaces.json');
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
  await outside.cleanup();
});

describe('file.create a través de un symlink', () => {
  it('un symlink colgante hacia fuera del workspace no permite crear el archivo externo', async () => {
    const externalTarget = path.join(outside.root, 'creado-por-el-agente.txt');
    const attempt = await tryCreateFileSymlink(externalTarget, path.join(workspace.root, 'trampa.md'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    const { isError, parsed } = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'trampa.md',
      content: 'contenido que no debería llegar fuera',
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('SYMLINK_ESCAPE');
    await expect(readFile(externalTarget, 'utf8')).rejects.toThrow();
  });
});

describe('file.write_guarded a través de un symlink', () => {
  it('un symlink existente hacia un archivo externo real no permite sobrescribirlo', async () => {
    const externalTarget = path.join(outside.root, 'externo.txt');
    await writeFile(externalTarget, 'contenido original externo');
    const attempt = await tryCreateFileSymlink(externalTarget, path.join(workspace.root, 'apunta-fuera.md'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados en este entorno: ${attempt.reason}`);
      return;
    }

    // No importa qué expectedSha256 se pase: la comprobación de symlink ocurre
    // antes de siquiera intentar leer/hashear el destino.
    const { isError, parsed } = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'apunta-fuera.md',
      expectedSha256: 'a'.repeat(64),
      content: 'sobrescrito por el agente',
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('SYMLINK_ESCAPE');

    const externalContent = await readFile(externalTarget, 'utf8');
    expect(externalContent).toBe('contenido original externo');
  });
});
