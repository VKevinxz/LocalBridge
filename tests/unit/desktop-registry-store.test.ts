import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildNewApplication,
  listApplications,
  loadRegistryDocument,
  migrateRegistryFile,
  removeApplication,
  upsertApplication,
  upsertWorkspace,
} from '@localbridge/desktop-core';
import { buildWorkspace } from '../helpers/fixtures.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRegistry(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localbridge-registry-v4-'));
  roots.push(root);
  return { root, file: path.join(root, 'workspaces.json') };
}

const processProfile = {
  command: ['npm', 'run', 'dev'], cwd: '.',
  source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
  maxRuntimeSeconds: 300,
};

describe('registry store v4', () => {
  it('crea backup exclusivo antes de migrar un registro v0.4', async () => {
    const { file } = await tempRegistry();
    const workspace = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', processProfiles: { dev: processProfile } });
    const legacy = { workspaces: [{ ...workspace, browserApplications: {
      Local: { primaryService: 'web', services: { web: { workspaceId: workspace.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: false } }, viewport: { width: 1280, height: 800 } },
    } }] };
    await writeFile(file, JSON.stringify(legacy));

    const migrated = await migrateRegistryFile(file);

    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.applications).toHaveLength(1);
    expect(JSON.parse(await readFile(`${file}.pre-v4-backup.json`, 'utf8'))).toEqual(legacy);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 4 });
    await migrateRegistryFile(file);
    expect(JSON.parse(await readFile(`${file}.pre-v4-backup.json`, 'utf8'))).toEqual(legacy);
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

    expect(migrated).toMatchObject({ schemaVersion: 4 });
    expect(migrated.workspaces[0]?.permissions.browserHumanControl).toBe(false);
    expect(migrated.workspaces[0]?.automationReviewRequired).toBe(true);
    expect(JSON.parse(await readFile(`${file}.pre-v4-backup.json`, 'utf8'))).toEqual(v3);
  });

  it('deja intacto un registro corrupto y no crea backup engañoso', async () => {
    const { file } = await tempRegistry();
    const corrupt = '{"schemaVersion":3,"workspaces":[';
    await writeFile(file, corrupt);

    await expect(migrateRegistryFile(file)).rejects.toThrow('no es JSON válido');
    expect(await readFile(file, 'utf8')).toBe(corrupt);
    await expect(readFile(`${file}.pre-v4-backup.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
