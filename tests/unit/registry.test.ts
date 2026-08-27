import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@localbridge/shared';
import { DEFAULT_DENY_PATTERNS, loadWorkspaceRegistry, parseWorkspaceRegistry } from '@localbridge/workspace';

import { buildWorkspace, writeRegistryFile } from '../helpers/fixtures.js';

function tempConfigPath(): string {
  return path.join(os.tmpdir(), `localbridge-registry-test-${randomUUID()}`, 'workspaces.json');
}

function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { logger: createLogger({ stream }), lines: () => chunks };
}

function legacyApplication(workspaceId: string, hostMode: 'manual-localhost' | 'listener-literal' = 'manual-localhost') {
  return {
    primaryService: 'frontend',
    services: { frontend: { workspaceId, processProfile: 'dev', startupOrder: 0, hostMode, allowManagedWildcard: false } },
    viewport: { width: 1280, height: 800 },
  };
}

describe('loadWorkspaceRegistry — ADR-0012, fallo cerrado', () => {
  it('fichero ausente -> lista vacía, sin lanzar', async () => {
    const { logger } = captureLogger();
    const result = await loadWorkspaceRegistry(tempConfigPath(), logger);
    expect(result).toEqual([]);
  });

  it('JSON inválido -> lista vacía, y se registra el fallo', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{ esto no es json');

    const { logger, lines } = captureLogger();
    const result = await loadWorkspaceRegistry(configPath, logger);

    expect(result).toEqual([]);
    expect(lines().some((line) => line.includes('not valid JSON'))).toBe(true);
  });

  it('JSON válido pero que no cumple el schema -> lista vacía, y se registra el fallo', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ workspaces: [{ id: 'sin-los-demas-campos' }] }));

    const { logger, lines } = captureLogger();
    const result = await loadWorkspaceRegistry(configPath, logger);

    expect(result).toEqual([]);
    expect(lines().some((line) => line.includes('schema validation'))).toBe(true);
  });

  it('un archivo roto nunca tumba el proceso ni amplía acceso', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'no soy json ni nada parecido {{{');

    const { logger } = captureLogger();
    await expect(loadWorkspaceRegistry(configPath, logger)).resolves.toEqual([]);
  });

  it('fichero válido: aplica denyPatterns y limits por defecto cuando se omiten', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        workspaces: [
          {
            id: 'ws_min',
            name: 'mínimo',
            rootPath: 'C:\\proyecto',
            enabled: true,
            createdAt: new Date().toISOString(),
            permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false },
          },
        ],
      }),
    );

    const { logger } = captureLogger();
    const [workspace] = await loadWorkspaceRegistry(configPath, logger);

    expect(workspace?.limits).toEqual({ maxFileBytes: 1_048_576, maxTreeEntries: 300, maxTreeDepth: 3 });
    expect(workspace?.denyPatterns).toEqual(DEFAULT_DENY_PATTERNS);
    // Deny-by-default (ADR-0004): sin perfiles configurados, ninguno se puede
    // ejecutar — nunca "ejecuta lo que parezca razonable".
    expect(workspace?.validationProfiles).toEqual({});
    expect(workspace?.permissions).toMatchObject({
      processes: false,
      browserRead: false,
      browserInteract: false,
      browserHumanControl: false,
    });
    expect(workspace?.processProfiles).toEqual({});
    expect(workspace?.browserProfiles).toEqual({});
    expect(workspace?.automationReviewRequired).toBe(false);
  });

  it('deniega configuraciones web no loopback y dependencias de permisos incompletas', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    const base = buildWorkspace({ rootPath: 'C:\\proyecto' });
    await writeFile(configPath, JSON.stringify({
      workspaces: [{
        ...base,
        permissions: { ...base.permissions, browserInteract: true, browserRead: false },
        browserProfiles: {
          app: {
            origin: 'https://example.com',
            allowedOrigins: ['https://example.com'],
            viewport: { width: 1280, height: 800 },
          },
        },
      }],
    }));

    const { logger } = captureLogger();
    await expect(loadWorkspaceRegistry(configPath, logger)).resolves.toEqual([]);
  });

  it('deniega control humano si no se concedió también observación web', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    const base = buildWorkspace({ rootPath: 'C:\\proyecto' });
    await writeFile(configPath, JSON.stringify({
      workspaces: [{
        ...base,
        permissions: { ...base.permissions, browserHumanControl: true, browserRead: false },
      }],
    }));

    const { logger } = captureLogger();
    await expect(loadWorkspaceRegistry(configPath, logger)).resolves.toEqual([]);
  });

  it('fichero válido: respeta validationProfiles explícitos', async () => {
    const configPath = tempConfigPath();
    await writeRegistryFile(configPath, [
      buildWorkspace({
        rootPath: 'C:\\proyecto',
        validationProfiles: { test: ['pnpm', 'test'], lint: ['pnpm', 'lint'] },
      }),
    ]);

    const { logger } = captureLogger();
    const [workspace] = await loadWorkspaceRegistry(configPath, logger);

    expect(workspace?.validationProfiles).toEqual({ test: ['pnpm', 'test'], lint: ['pnpm', 'lint'] });
  });

  it('un perfil con comando vacío no valida (fallo cerrado del fichero completo)', async () => {
    const configPath = tempConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        workspaces: [
          {
            id: 'ws_bad_profile',
            name: 'perfil roto',
            rootPath: 'C:\\proyecto',
            enabled: true,
            createdAt: new Date().toISOString(),
            permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: true },
            validationProfiles: { test: [] },
          },
        ],
      }),
    );

    const { logger } = captureLogger();
    const result = await loadWorkspaceRegistry(configPath, logger);

    expect(result).toEqual([]);
  });

  it('fichero válido: respeta denyPatterns y limits explícitos', async () => {
    const configPath = tempConfigPath();
    const custom = buildWorkspace({
      rootPath: 'C:\\proyecto',
      limits: { maxFileBytes: 2048, maxTreeEntries: 10, maxTreeDepth: 1 },
      denyPatterns: ['secrets/'],
    });
    await writeRegistryFile(configPath, [custom]);

    const { logger } = captureLogger();
    const [workspace] = await loadWorkspaceRegistry(configPath, logger);

    expect(workspace?.limits.maxFileBytes).toBe(2048);
    expect(workspace?.denyPatterns).toEqual(['secrets/']);
  });

  it('sin caché: dos lecturas sucesivas ven un cambio hecho entre medias', async () => {
    const configPath = tempConfigPath();
    const { logger } = captureLogger();

    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_a', rootPath: 'C:\\a' })]);
    const first = await loadWorkspaceRegistry(configPath, logger);
    expect(first.map((w) => w.id)).toEqual(['ws_a']);

    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_b', rootPath: 'C:\\b' })]);
    const second = await loadWorkspaceRegistry(configPath, logger);
    expect(second.map((w) => w.id)).toEqual(['ws_b']);
  });
});

describe('registro global v4 — ADR-0032/0036', () => {
  const processProfile = {
    command: ['npm', 'run', 'dev'], cwd: '.',
    source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
    maxRuntimeSeconds: 300,
  };
  it('migra una aplicación anidada a una entidad global revisada', () => {
    const owner = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', processProfiles: { dev: processProfile } });
    const registry = parseWorkspaceRegistry({ workspaces: [{ ...owner, browserApplications: { CIP: legacyApplication(owner.id) } }] });
    expect(registry.schemaVersion).toBe(4);
    expect(registry.workspaces[0]).not.toHaveProperty('browserApplications');
    expect(registry.applications[0]).toMatchObject({ name: 'CIP', reviewState: 'reviewed' });
    expect(registry.applications[0]?.services[0]).toMatchObject({ alias: 'frontend', workspaceId: owner.id });
  });

  it('deduplica definiciones idénticas aun con diferencias de mayúsculas', () => {
    const first = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', processProfiles: { dev: processProfile } });
    const second = buildWorkspace({ id: 'ws_owner', rootPath: 'C:\\owner', processProfiles: { dev: processProfile } });
    const registry = parseWorkspaceRegistry({ workspaces: [
      { ...first, browserApplications: { CIP: legacyApplication(first.id) } },
      { ...second, browserApplications: { cip: legacyApplication(first.id) } },
    ] });
    expect(registry.applications).toHaveLength(1);
    expect(registry.applications[0]?.reviewState).toBe('reviewed');
  });

  it('nunca fusiona definiciones distintas: conserva candidatos y bloquea ejecución', () => {
    const first = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', processProfiles: { dev: processProfile } });
    const second = buildWorkspace({ id: 'ws_other', rootPath: 'C:\\other', processProfiles: { dev: processProfile } });
    const registry = parseWorkspaceRegistry({ workspaces: [
      { ...first, browserApplications: { CIP: legacyApplication(first.id) } },
      { ...second, browserApplications: { cip: legacyApplication(second.id, 'listener-literal') } },
    ] });
    expect(registry.applications).toHaveLength(1);
    expect(registry.applications[0]).toMatchObject({ reviewState: 'conflict' });
    expect(registry.applications[0]?.conflictCandidates).toHaveLength(2);
  });
});
