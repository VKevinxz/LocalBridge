import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildNewApplication,
  buildNewWorkspace,
  listApplications,
  listWorkspaces,
  loadRegistryDocument,
  migrateRegistryFile,
  removeApplication,
  removeRegistryEntriesIfPresent,
  upsertApplication,
  upsertWorkspace,
} from '@localbridge/desktop-core';
import { buildWorkspace } from '../helpers/fixtures.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRegistry(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localbridge-registry-v5-'));
  roots.push(root);
  return { root, file: path.join(root, 'workspaces.json') };
}

const processProfile = {
  command: ['npm', 'run', 'dev'], cwd: '.',
  source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
  maxRuntimeSeconds: 300,
};

describe('registry store v5', () => {
  it('inicializa el registro cuando aún no existe su directorio de configuración', async () => {
    const { root } = await tempRegistry();
    const file = path.join(root, 'fresh-profile', '.localbridge-mcp', 'workspaces.json');

    await expect(migrateRegistryFile(file)).resolves.toEqual({ schemaVersion: 5, workspaces: [], applications: [] });
    await expect(readFile(`${file}.authority-lock/owner.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('conserva el límite seguro por defecto y aplica una elección local explícita', () => {
    const base = {
      name: 'Proyecto', rootPath: 'C:\\proyecto',
      permissions: buildWorkspace({ rootPath: 'C:\\fixture' }).permissions,
    };
    expect(buildNewWorkspace(base).limits.maxFileBytes).toBe(1_048_576);
    expect(buildNewWorkspace(base).limits.largeArtifacts.mode).toBe('standard');
    expect(buildNewWorkspace({ ...base, maxFileBytes: 8 * 1024 * 1024 }).limits.maxFileBytes).toBe(8 * 1024 * 1024);
    expect(buildNewWorkspace({
      ...base,
      largeArtifacts: {
        mode: 'adaptive',
        reserve: { minimumFreeBytes: 2 * 1024 * 1024 * 1024, minimumFreePercent: 15 },
        maxConcurrentJobs: 2,
      },
    }).limits.largeArtifacts.mode).toBe('adaptive');
  });

  it('crea backup exclusivo antes de migrar un registro v0.4', async () => {
    const { file } = await tempRegistry();
    const workspace = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', processProfiles: { dev: processProfile } });
    const legacy = { workspaces: [{ ...workspace, browserApplications: {
      Local: { primaryService: 'web', services: { web: { workspaceId: workspace.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: false } }, viewport: { width: 1280, height: 800 } },
    } }] };
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await migrateRegistryFile(file);

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.applications).toHaveLength(1);
    expect(JSON.parse(await readFile(`${file}.pre-v5-backup.json`, 'utf8'))).toEqual(legacy);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 5 });
    await migrateRegistryFile(file);
    expect(JSON.parse(await readFile(`${file}.pre-v5-backup.json`, 'utf8'))).toEqual(legacy);
  });

  it('migra v3 con intersección de permisos, revisión local y backup exacto', async () => {
    const { file } = await tempRegistry();
    const current = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front' });
    const { browserHumanControl: _human, ...commonPermissions } = current.permissions;
    const v3 = {
      schemaVersion: 3,
      workspaces: [{
        ...current,
        permissions: { ...commonPermissions, browserRead: true, browserAuthenticate: true, browserManualControl: false },
      }],
      applications: [],
    };
    await writeFile(file, JSON.stringify(v3));

    const migrated = await migrateRegistryFile(file);

    expect(migrated).toMatchObject({ schemaVersion: 5 });
    expect(migrated.workspaces[0]?.permissions.browserHumanControl).toBe(false);
    expect(migrated.workspaces[0]?.automationReviewRequired).toBe(true);
    expect(JSON.parse(await readFile(`${file}.pre-v5-backup.json`, 'utf8'))).toEqual(v3);
  });

  it('deja intacto un registro corrupto y no crea backup engañoso', async () => {
    const { file } = await tempRegistry();
    const corrupt = '{"schemaVersion":3,"workspaces":[';
    await writeFile(file, corrupt);

    await expect(migrateRegistryFile(file)).rejects.toThrow('no es JSON válido');
    expect(await readFile(file, 'utf8')).toBe(corrupt);
    await expect(readFile(`${file}.pre-v5-backup.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('crea, actualiza y elimina aplicaciones globales con nombre único normalizado', async () => {
    const { file } = await tempRegistry();
    const workspace = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', processProfiles: { dev: processProfile } });
    await upsertWorkspace(file, workspace);
    const application = buildNewApplication({
      name: 'Aplicación Local', primaryServiceAlias: 'frontend',
      services: [{ alias: 'frontend', workspaceId: workspace.id, processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: false }],
    });
    await upsertApplication(file, application);
    await expect(upsertApplication(file, { ...buildNewApplication({
      name: 'aplicación local', primaryServiceAlias: 'frontend',
      services: [{ alias: 'frontend', workspaceId: workspace.id, processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: false }],
    }) })).rejects.toThrow('Ya existe una aplicación');
    expect(await listApplications(file)).toHaveLength(1);
    await removeApplication(file, application.id);
    expect(await listApplications(file)).toEqual([]);
  });

  it('retira entradas concretas sin sobrescribir altas recientes y es idempotente', async () => {
    const { file } = await tempRegistry();
    const target = buildWorkspace({ id: 'ws_target', rootPath: 'C:\\target', processProfiles: { dev: processProfile } });
    const survivor = buildWorkspace({ id: 'ws_survivor', rootPath: 'C:\\survivor', processProfiles: { dev: processProfile } });
    await upsertWorkspace(file, target);
    await upsertWorkspace(file, survivor);
    const application = buildNewApplication({
      name: 'Objetivo', primaryServiceAlias: 'frontend',
      services: [{ alias: 'frontend', workspaceId: target.id, processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: false }],
    });
    await upsertApplication(file, application);

    await expect(removeRegistryEntriesIfPresent(file, {
      workspaceIds: [target.id], applicationIds: [application.id],
    })).resolves.toEqual({ workspaceIds: [target.id], applicationIds: [application.id] });
    expect((await listWorkspaces(file)).map((workspace) => workspace.id)).toEqual([survivor.id]);
    expect(await listApplications(file)).toEqual([]);
    await expect(removeRegistryEntriesIfPresent(file, {
      workspaceIds: [target.id], applicationIds: [application.id],
    })).resolves.toEqual({ workspaceIds: [], applicationIds: [] });
  });

  it('no retira un workspace que una aplicación conservada todavía utiliza', async () => {
    const { file } = await tempRegistry();
    const workspace = buildWorkspace({ id: 'ws_shared_app', rootPath: 'C:\\shared-app', processProfiles: { dev: processProfile } });
    await upsertWorkspace(file, workspace);
    const survivor = buildNewApplication({
      name: 'Sobrevive', primaryServiceAlias: 'frontend',
      services: [{ alias: 'frontend', workspaceId: workspace.id, processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: false }],
    });
    await upsertApplication(file, survivor);

    await expect(removeRegistryEntriesIfPresent(file, {
      workspaceIds: [workspace.id], applicationIds: [],
    })).resolves.toEqual({ workspaceIds: [], applicationIds: [] });
    expect((await listWorkspaces(file)).map((entry) => entry.id)).toEqual([workspace.id]);
    expect((await listApplications(file)).map((entry) => entry.id)).toEqual([survivor.id]);
  });

  it('marca needs-review si cambia el perfil usado por una aplicación', async () => {
    const { file } = await tempRegistry();
    const workspace = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: true, browserRead: true }, processProfiles: { dev: processProfile } });
    await upsertWorkspace(file, workspace);
    const application = buildNewApplication({
      name: 'Local', primaryServiceAlias: 'frontend', reviewState: 'reviewed',
      services: [{ alias: 'frontend', workspaceId: workspace.id, processProfile: 'dev', hostMode: 'manual-localhost', allowManagedWildcard: false }],
    });
    await upsertApplication(file, application);
    await upsertWorkspace(file, { ...workspace, processProfiles: { dev: { ...processProfile, maxRuntimeSeconds: 600 } } });
    expect((await loadRegistryDocument(file)).applications[0]?.reviewState).toBe('needs-review');
  });
});
