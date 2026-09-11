import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-022] Reintento de mutación con el mismo `operationId` → aplicada una sola vez. */

let harness: Harness;
let workspace: TempWorkspace;
let configPath: string;
const workspaceId = 'ws_sec_idempotency';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  configPath = path.join(os.tmpdir(), `localbridge-sec-idem-${randomUUID()}`, 'workspaces.json');
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

describe('[SEC-022] file.create con operationId repetido', () => {
  it('la segunda llamada devuelve el mismo resultado sin volver a crear ni fallar', async () => {
    const first = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'nuevo.md',
      content: 'contenido original',
      operationId: 'op-fixed-1',
    });
    expect(first.isError).toBe(false);

    // Reintento — simula un stream roto tras el éxito, antes de que el cliente
    // viera la respuesta (MASTER_SPEC §6.7 / SECURITY.md amenaza J).
    const second = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'nuevo.md',
      content: 'contenido original',
      operationId: 'op-fixed-1',
    });

    expect(second.isError).toBe(false);
    expect(second.parsed).toEqual(first.parsed);

    // No hay un segundo intento real: sin operationId, la misma llamada
    // fallaría con FILE_ALREADY_EXISTS. Lo comprobamos explícitamente.
    const withoutIdempotency = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'nuevo.md',
      content: 'contenido original',
    });
    expect(withoutIdempotency.isError).toBe(true);
    expect((withoutIdempotency.parsed['error'] as { code: string }).code).toBe('FILE_ALREADY_EXISTS');
  });

  it('la misma clave con otro payload falla cerrado y conserva el primer efecto', async () => {
    const operationId = 'op-conflicting-payload';
    const first = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'conflicto.md',
      content: 'primero',
      operationId,
    });
    expect(first.isError).toBe(false);

    const conflicting = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'conflicto.md',
      content: 'segundo',
      operationId,
    });

    expect(conflicting.isError).toBe(true);
    expect((conflicting.parsed['error'] as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await readFile(path.join(workspace.root, 'conflicto.md'), 'utf8')).toBe('primero');
  });
});

describe('[SEC-022] file.write_guarded con operationId repetido', () => {
  it('la segunda llamada devuelve el resultado cacheado sin exigir el hash ya consumido', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });

    const first = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      content: 'contenido nuevo',
      operationId: 'op-fixed-2',
    });
    expect(first.isError).toBe(false);

    // Reintento con el MISMO expectedSha256 (ya obsoleto tras el primer
    // éxito) — sin idempotencia, esto fallaría con HASH_MISMATCH.
    const second = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      content: 'contenido nuevo',
      operationId: 'op-fixed-2',
    });

    expect(second.isError).toBe(false);
    expect(second.parsed).toEqual(first.parsed);

    const onDisk = await readFile(path.join(workspace.root, 'README.md'), 'utf8');
    expect(onDisk).toBe('contenido nuevo');
  });
});

describe('[SEC-022] file.patch_guarded con operationId repetido', () => {
  it('recupera el resultado exacto y rechaza reutilizar la clave con otras ediciones', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    const input = {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      edits: [{ oldText: 'sample', newText: 'patched' }],
      operationId: 'op-patch-1',
    };
    const first = await callToolJson(harness.client, 'file.patch_guarded', input);
    const replay = await callToolJson(harness.client, 'file.patch_guarded', input);

    expect(first.isError).toBe(false);
    expect(replay.parsed).toEqual(first.parsed);
    expect(await readFile(path.join(workspace.root, 'README.md'), 'utf8')).toBe('# patched\n');

    const conflict = await callToolJson(harness.client, 'file.patch_guarded', {
      ...input,
      edits: [{ oldText: 'sample', newText: 'different' }],
    });
    expect(conflict.isError).toBe(true);
    expect((conflict.parsed['error'] as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('no confirma el resultado cacheado si el archivo cambió después del parche', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    const input = {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      edits: [{ oldText: 'sample', newText: 'patched' }],
      operationId: 'op-patch-state-change',
    };
    expect((await callToolJson(harness.client, 'file.patch_guarded', input)).isError).toBe(false);
    await writeFile(path.join(workspace.root, 'README.md'), 'changed externally\n');

    const replay = await callToolJson(harness.client, 'file.patch_guarded', input);

    expect(replay.isError).toBe(true);
    expect((replay.parsed['error'] as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await readFile(path.join(workspace.root, 'README.md'), 'utf8')).toBe('changed externally\n');
  });

  it('no reutiliza un parche cacheado si el workspaceId apunta a otro root', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'README.md' });
    const input = {
      workspaceId,
      path: 'README.md',
      expectedSha256: read.parsed['sha256'],
      edits: [{ oldText: 'sample', newText: 'patched' }],
      operationId: 'op-patch-root-change',
    };
    expect((await callToolJson(harness.client, 'file.patch_guarded', input)).isError).toBe(false);

    const replacement = await createTempWorkspaceDir();
    try {
      await populateSampleProject(replacement.root);
      await writeRegistryFile(configPath, [buildWorkspace({
        id: workspaceId,
        rootPath: replacement.root,
        permissions: { read: true, write: true, overwrite: true, gitRead: false, validations: false, gitWrite: false },
      })]);

      const replay = await callToolJson(harness.client, 'file.patch_guarded', input);

      expect(replay.isError).toBe(true);
      expect((replay.parsed['error'] as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await readFile(path.join(replacement.root, 'README.md'), 'utf8')).toBe('# sample\n');
    } finally {
      await replacement.cleanup();
    }
  });
});

describe('[SEC-022] operationId distinto no reutiliza el resultado', () => {
  it('dos operationId distintos son mutaciones independientes', async () => {
    const a = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'a.md',
      content: 'A',
      operationId: 'op-a',
    });
    const b = await callToolJson(harness.client, 'file.create', {
      workspaceId,
      path: 'b.md',
      content: 'B',
      operationId: 'op-b',
    });

    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(a.parsed['path']).toBe('a.md');
    expect(b.parsed['path']).toBe('b.md');
  });
});
