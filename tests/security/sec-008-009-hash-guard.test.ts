import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-008] y [SEC-009] — guarda por hash, de punta a punta (ADR-0005). */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_hash_guard';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-hash-${randomUUID()}`, 'workspaces.json');
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

describe('[SEC-008] expectedSha256 incorrecto', () => {
  it('HASH_MISMATCH, el archivo queda intacto y recoverable=true', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: 'a'.repeat(64),
      content: 'contenido del atacante',
    });

    expect(isError).toBe(true);
    const error = parsed['error'] as { code: string; recoverable: boolean };
    expect(error.code).toBe('HASH_MISMATCH');
    expect(error.recoverable).toBe(true);

    const after = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(after.parsed['content']).toBe('export const hello = "world";\n');
  });
});

describe('[SEC-009] modificación externa entre lectura y escritura', () => {
  it('el flujo completo read -> modificación externa -> write_guarded falla con HASH_MISMATCH', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    const staleHash = read.parsed['sha256'] as string;

    // El usuario edita el archivo en su editor mientras el agente "piensa".
    await writeFile(path.join(workspace.root, 'src', 'index.ts'), 'cambiado por el usuario\n');

    const write = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: staleHash,
      content: 'lo que el agente cree que debería ir',
    });

    expect(write.isError).toBe(true);
    expect((write.parsed['error'] as { code: string }).code).toBe('HASH_MISMATCH');

    const after = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(after.parsed['content']).toBe('cambiado por el usuario\n');
  });

  it('re-leer tras el mismatch y reintentar con el hash correcto sí funciona', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });

    await writeFile(path.join(workspace.root, 'src', 'index.ts'), 'v2\n');

    const failed = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'v3 basado en v1, obsoleto',
    });
    expect(failed.isError).toBe(true);

    // Camino de recuperación documentado: re-leer y reintentar.
    const reread = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    const retry = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: reread.parsed['sha256'],
      content: 'v3 basado en v2, correcto',
    });

    expect(retry.isError).toBe(false);
    const final = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(final.parsed['content']).toBe('v3 basado en v2, correcto');
  });
});
