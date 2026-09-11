import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DESKTOP_SETTINGS,
  applyPortableConfig,
  buildPortableConfig,
  exportPortableConfigFile,
  portableConfigSchema,
} from '@localbridge/desktop-core';
import type { AuthorizedWorkspace, DevelopmentProject, LocalApplication, WorkspaceRegistry } from '@localbridge/workspace';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((target) => rm(target, { force: true }))));

function workspace(): AuthorizedWorkspace {
  return {
    id: 'ws_local', name: 'Proyecto', rootPath: 'D:\\Privado\\Proyecto', enabled: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 } },
    denyPatterns: ['.env'], validationProfiles: {},
  };
}

function workspaceWithAutomation(): AuthorizedWorkspace {
  return {
    ...workspace(),
    permissions: { ...workspace().permissions, processes: true, browserRead: true, browserInteract: true },
    processProfiles: {
      dev: {
        command: ['pnpm', 'run', 'dev'], cwd: '.',
        source: { kind: 'package-script', manifestPath: 'package.json', script: 'dev', definitionSha256: 'a'.repeat(64) },
        maxRuntimeSeconds: 14_400,
      },
    },
    browserProfiles: {
      app: { origin: 'http://127.0.0.1:5173', allowedOrigins: ['http://127.0.0.1:5173'], viewport: { width: 1280, height: 800 }, linkedProcessProfile: 'dev' },
    },
  };
}

function application(): LocalApplication {
  return {
    id: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Local', description: 'Frontend local',
    primaryServiceId: 'service_aaaaaaaaaaaaaaaaaaaaaaaa',
    services: [{ id: 'service_aaaaaaaaaaaaaaaaaaaaaaaa', alias: 'frontend', workspaceId: 'ws_local', processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: true }],
    viewport: { width: 1280, height: 800 }, reviewState: 'reviewed',
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function registry(workspaces: AuthorizedWorkspace[], applications: LocalApplication[] = []): WorkspaceRegistry {
  return { schemaVersion: 5, workspaces, applications };
}

function project(): DevelopmentProject {
  return {
    id: `project_${'a'.repeat(24)}`, name: 'Suite local', description: 'Proyecto asistido',
    workspaceIds: ['ws_local'], applicationId: application().id, setupStatus: 'ready',
    createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
  };
}

describe('configuración portable v4', () => {
  it('omite rutas, ids locales, claves y directorios de perfil', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspace()]));
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('D:\\\\Privado');
    expect(serialized).not.toContain('ws_local');
    expect(serialized).not.toContain('tunnel-key');
    expect(serialized).not.toContain('serverCwd');
    expect(config.workspaces[0]?.name).toBe('Proyecto');
  });

  it('exige remapear y genera identidades locales nuevas', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspace()]));
    expect(() => applyPortableConfig(config, {}, DEFAULT_DESKTOP_SETTINGS, registry([]))).toThrow('Falta elegir una carpeta');
    const ref = config.workspaces[0]?.ref;
    if (ref === undefined) throw new Error('ref ausente');
    const result = applyPortableConfig(config, { [ref]: path.resolve('remapped-project') }, DEFAULT_DESKTOP_SETTINGS, registry([]));
    expect(result.workspaces[0]).toMatchObject({ name: 'Proyecto', rootPath: path.resolve('remapped-project') });
    expect(result.workspaces[0]?.id).not.toBe('ws_local');
    expect(result.importedProfileIds).toHaveLength(1);
  });

  it('transporta aplicaciones globales con permisos apagados y revisión obligatoria', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspaceWithAutomation()], [application()]));
    expect(config.version).toBe(4);
    if (config.version !== 4) throw new Error('formato inesperado');
    expect(config.workspaces[0]?.permissions).toMatchObject({ processes: false, browserRead: false, browserInteract: false, browserHumanControl: false });
    expect(config.applications[0]?.services[0]).toMatchObject({ alias: 'frontend', allowManagedWildcard: true });
    expect(JSON.stringify(config)).not.toContain('ws_local');
    const ref = config.workspaces[0]?.ref;
    if (ref === undefined) throw new Error('workspace portable ausente');
    const result = applyPortableConfig(config, { [ref]: path.resolve('portable-automation') }, DEFAULT_DESKTOP_SETTINGS, registry([]));
    expect(result.workspaces[0]?.automationReviewRequired).toBe(true);
    expect(result.applications[0]).toMatchObject({ name: 'Local', reviewState: 'needs-review' });
    expect(result.applications[0]?.services[0]).toMatchObject({ workspaceId: result.workspaces[0]?.id, allowManagedWildcard: false });
  });

  it('rechaza colisiones globales de nombre al importar', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspaceWithAutomation()], [application()]));
    const ref = config.workspaces[0]?.ref;
    if (ref === undefined) throw new Error('ref ausente');
    expect(() => applyPortableConfig(config, { [ref]: path.resolve('collision') }, DEFAULT_DESKTOP_SETTINGS, registry([], [application()]))).toThrow('Ya existe una aplicación');
  });

  it('exporta JSON validado creando exclusivamente', async () => {
    const target = path.join(os.tmpdir(), `localbridge-portable-${randomUUID()}.json`);
    created.push(target);
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([]));
    await exportPortableConfigFile(target, config);
    expect(portableConfigSchema.parse(JSON.parse(await readFile(target, 'utf8')))).toEqual(config);
    await expect(exportPortableConfigFile(target, config)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('configuración portable v5', () => {
  it('transporta referencias de proyecto sin IDs/rutas y fuerza revisión al importar', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspaceWithAutomation()], [application()]), [project()]);
    expect(config.version).toBe(5);
    expect(JSON.stringify(config)).not.toMatch(/ws_local|D:\\\\Privado|project_aaaaaaaa/);
    if (config.version !== 5) throw new Error('formato inesperado');
    const ref = config.workspaces[0]?.ref;
    if (ref === undefined) throw new Error('ref ausente');
    const result = applyPortableConfig(config, { [ref]: path.resolve('portable-v5') }, DEFAULT_DESKTOP_SETTINGS, registry([]));
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({ name: 'Suite local', setupStatus: 'review-required' });
    expect(result.projects[0]?.workspaceIds).toEqual([result.workspaces[0]?.id]);
    expect(result.projects[0]?.applicationId).toBe(result.applications[0]?.id);
  });

  it('mantiene una exportación v4 explícita compatible con v0.8', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspaceWithAutomation()], [application()]));
    expect(config.version).toBe(4);
    expect('projects' in config).toBe(false);
  });

  it('rechaza referencias de aplicación de proyecto que no están incluidas', () => {
    const config = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry([workspaceWithAutomation()], [application()]), [project()]);
    if (config.version !== 5) throw new Error('formato inesperado');
    const ref = config.workspaces[0]?.ref;
    if (ref === undefined) throw new Error('ref ausente');
    const broken = { ...config, projects: [{ ...config.projects[0]!, applicationRef: `portable_app_${'f'.repeat(16)}` }] };
    expect(() => applyPortableConfig(broken, { [ref]: path.resolve('portable-broken') }, DEFAULT_DESKTOP_SETTINGS, registry([])))
      .toThrow('aplicación no incluida');
  });
});
