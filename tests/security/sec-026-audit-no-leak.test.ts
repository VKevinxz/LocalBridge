import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';
import { readAllAuditEvents } from '@localbridge/audit';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * [SEC-026] El registro de auditoría (`audit.db`) nunca contiene una ruta
 * absoluta del disco ni contenido de fichero — sólo lo que `AuditEvent`
 * declara: nombre de tool, ruta *relativa* o nombre de perfil, y metadatos.
 *
 * Distinto de SEC-024: aquél comprueba la respuesta que recibe el cliente;
 * éste comprueba lo que queda persistido en disco, que sobrevive a la
 * conexión y que un operador (o un backup, o un `cat audit.db`) podría leer
 * mucho después.
 */

let harness: Harness;
let workspace: TempWorkspace;
let auditDbPath: string;
const workspaceId = 'ws_sec_audit_no_leak';

// Marcadores tomados del contenido real de `populateSampleProject`: si
// aparecieran en la auditoría, sería porque alguna tool empezó a registrar
// contenido de fichero en vez de sólo su ruta.
const FILE_CONTENT_MARKER = 'export const hello';
const ENV_SECRET_MARKER = 'SECRET=abc123';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-audit-noleak-${randomUUID()}`, 'workspaces.json');
  auditDbPath = path.join(os.tmpdir(), `localbridge-sec-audit-noleak-${randomUUID()}`, 'audit.db');

  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: false },
      validationProfiles: { lint: [process.execPath, '-e', 'console.log("ok")'] },
    }),
  ]);

  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, auditDbPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

function assertAuditTrailClean(): void {
  const events = readAllAuditEvents(auditDbPath);
  expect(events.length).toBeGreaterThan(0);

  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(workspace.root);
  // Ninguna unidad de Windows genérica tampoco: cubre otros workspaces que
  // pudieran haber escrito en el mismo `audit.db` compartido.
  expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
  expect(serialized).not.toContain(FILE_CONTENT_MARKER);
  expect(serialized).not.toContain(ENV_SECRET_MARKER);
  expect(serialized).not.toContain('BEGIN OPENSSH');

  // El único campo de ruta permitido (`resource`) debe ser siempre relativo.
  for (const event of events) {
    if (event.resource !== undefined) {
      expect(path.isAbsolute(event.resource)).toBe(false);
    }
  }
}

describe('[SEC-026] el registro de auditoría no filtra rutas absolutas ni contenido', () => {
  it('lecturas correctas y fallidas quedan auditadas sin filtrar nada', async () => {
    await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    await callToolJson(harness.client, 'file.read', { workspaceId, path: 'no-existe.ts' });
    await callToolJson(harness.client, 'file.read', { workspaceId, path: '../../secret' });
    await callToolJson(harness.client, 'file.metadata', { workspaceId, path: 'src/index.ts' });

    assertAuditTrailClean();
  });

  it('un path absoluto rechazado (ABSOLUTE_PATH_FORBIDDEN) no deja la ruta absoluta como resource', async () => {
    const absolutePath = path.join(os.tmpdir(), 'no-deberia-quedar-registrado.txt');
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: absolutePath });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('ABSOLUTE_PATH_FORBIDDEN');

    assertAuditTrailClean();
  });

  it('workspace.list y workspace.tree quedan auditados sin filtrar nada', async () => {
    await callToolJson(harness.client, 'workspace.list', {});
    await callToolJson(harness.client, 'workspace.tree', { workspaceId, relativePath: '.' });

    assertAuditTrailClean();
  });

  it('escrituras correctas y con HASH_MISMATCH quedan auditadas sin filtrar nada', async () => {
    await callToolJson(harness.client, 'file.create', { workspaceId, path: 'nuevo/anidado.md', content: 'contenido nuevo' });
    await callToolJson(harness.client, 'file.create', { workspaceId, path: '../fuera-del-root.md', content: 'x' });

    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'contenido sobrescrito',
    });
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: 'a'.repeat(64),
      content: 'y',
    });

    assertAuditTrailClean();
  });

  it('file.move y file.delete (correctos y con HASH_MISMATCH) quedan auditados sin filtrar nada', async () => {
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/index.ts',
      destPath: 'src/movido.ts',
      expectedSha256: read.parsed['sha256'],
    });
    await callToolJson(harness.client, 'file.move', {
      workspaceId,
      sourcePath: 'src/lib/util.ts',
      destPath: '../fuera-del-root.ts',
      expectedSha256: 'a'.repeat(64),
    });

    const readMoved = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/movido.ts' });
    await callToolJson(harness.client, 'file.delete', { workspaceId, path: 'src/movido.ts', expectedSha256: readMoved.parsed['sha256'] });
    await callToolJson(harness.client, 'file.delete', { workspaceId, path: 'src/lib/util.ts', expectedSha256: 'a'.repeat(64) });

    assertAuditTrailClean();
  });

  it('workspace.search (con y sin resultados) queda auditada sin filtrar nada', async () => {
    await callToolJson(harness.client, 'workspace.search', { workspaceId, query: FILE_CONTENT_MARKER });
    await callToolJson(harness.client, 'workspace.search', { workspaceId, query: ENV_SECRET_MARKER });

    assertAuditTrailClean();
  });

  it('operaciones de Git (con y sin repo real) quedan auditadas sin filtrar nada', async () => {
    await callToolJson(harness.client, 'git.status', { workspaceId });
    await callToolJson(harness.client, 'git.diff', { workspaceId, filePath: 'src/index.ts' });
    await callToolJson(harness.client, 'git.log', { workspaceId });
    await callToolJson(harness.client, 'git.branch', { workspaceId });

    assertAuditTrailClean();
  });

  it('validation.run (permitida y denegada) queda auditada sin filtrar nada', async () => {
    await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'lint' });
    await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'perfil-inexistente' });

    assertAuditTrailClean();
  });

  it('git.stage y un git.commit/git.push denegados por permisos quedan auditados sin filtrar nada', async () => {
    // gitWrite=false en este workspace: cubre el camino de error de las tres
    // tools de escritura. El camino de éxito (que sí lee diff real) tiene su
    // propia comprobación de fuga en tests/integration/git-write-mrtr.test.ts,
    // que además necesita un repo Git real y una aprobación MRTR completa.
    await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['src/index.ts'] });
    await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'mensaje de commit' });
    await callToolJson(harness.client, 'git.push', { workspaceId });

    assertAuditTrailClean();
  });
});
