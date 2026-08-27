import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseBrokerParams } from '@localbridge/development';
import { applyPortableConfig, buildPortableConfig, DEFAULT_DESKTOP_SETTINGS } from '@localbridge/desktop-core';
import { parseWorkspaceRegistry, registryFileSchema, type LocalApplication, type WorkspaceRegistry } from '@localbridge/workspace';
import { buildWorkspace } from '../helpers/fixtures.js';

const opaque = (prefix: string, character: string): string => `${prefix}_${character.repeat(24)}`;
const profile = {
  command: ['npm', 'run', 'dev'], cwd: '.',
  source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
  maxRuntimeSeconds: 300,
};
const permissions = { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: true, browserRead: true };
const workspace = buildWorkspace({ id: 'ws_front', rootPath: 'C:\\front', permissions, processProfiles: { dev: profile } });
const application: LocalApplication = {
  id: opaque('app', 'a'), name: 'Local', description: '', primaryServiceId: opaque('service', 'a'),
  services: [{ id: opaque('service', 'a'), alias: 'frontend', workspaceId: workspace.id, processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: false }],
  viewport: { width: 1280, height: 800 }, reviewState: 'reviewed',
  createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
};

describe('SEC-048 — application.start es una tool cerrada', () => {
  it('acepta solo IDs opacos y rechaza comandos, servicios, puertos y rutas', () => {
    expect(parseBrokerParams('application.start', { applicationId: application.id, operationId: 'one' })).toEqual({ applicationId: application.id, operationId: 'one' });
    for (const extra of [{ command: ['cmd'] }, { cwd: 'C:\\' }, { port: 5173 }, { services: [] }, { url: 'http://localhost:5173' }]) {
      expect(() => parseBrokerParams('application.start', { applicationId: application.id, ...extra })).toThrow();
    }
  });
});

describe('SEC-049 — runId no concede autoridad de otra aplicación', () => {
  it('la forma de navegador exige applicationId y runId juntos y no admite sustituciones', () => {
    const valid = { workspaceId: workspace.id, applicationId: application.id, runId: opaque('run', 'b') };
    expect(parseBrokerParams('browser.start', valid)).toEqual(valid);
    expect(() => parseBrokerParams('browser.start', { ...valid, applicationId: undefined })).toThrow();
    expect(() => parseBrokerParams('browser.start', { ...valid, listeners: [] })).toThrow();
    expect(() => parseBrokerParams('browser.start', { ...valid, port: 5173 })).toThrow();
  });
});

describe('SEC-050 — migración nunca amplía permisos ni fusiona conflictos', () => {
  it('conserva permisos y desactiva definiciones legacy distintas', () => {
    const low = { ...workspace, permissions: { ...workspace.permissions, processes: false, browserRead: false } };
    const legacyProfile = (hostMode: 'manual-localhost' | 'listener-literal') => ({ primaryService: 'frontend', services: { frontend: { workspaceId: low.id, processProfile: 'dev', startupOrder: 0, hostMode, allowManagedWildcard: false } }, viewport: { width: 1280, height: 800 } });
    const migrated = parseWorkspaceRegistry({ workspaces: [
      { ...low, browserApplications: { Local: legacyProfile('manual-localhost') } },
      { ...buildWorkspace({ id: 'ws_owner', rootPath: 'C:\\owner', processProfiles: { dev: profile } }), browserApplications: { local: legacyProfile('listener-literal') } },
    ] });
    expect(migrated.workspaces[0]?.permissions).toMatchObject({ processes: false, browserRead: false });
    expect(migrated.applications[0]?.reviewState).toBe('conflict');
  });
});

describe('SEC-051 — portabilidad v4 vuelve a default-deny', () => {
  it('apaga runtime, interacción, autenticación y wildcard y exige revisión', () => {
    const registry: WorkspaceRegistry = { schemaVersion: 4, workspaces: [workspace], applications: [{ ...application, services: [{ ...application.services[0]!, allowManagedWildcard: true }] }] };
    const portable = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry);
    const ref = portable.workspaces[0]?.ref;
    if (ref === undefined) throw new Error('ref ausente');
    const imported = applyPortableConfig(portable, { [ref]: 'C:\\mapped' }, DEFAULT_DESKTOP_SETTINGS, { schemaVersion: 4, workspaces: [], applications: [] });
    expect(imported.workspaces[0]?.permissions).toMatchObject({ processes: false, browserRead: false, browserInteract: false, browserHumanControl: false });
    expect(imported.applications[0]).toMatchObject({ reviewState: 'needs-review' });
    expect(imported.applications[0]?.services[0]?.allowManagedWildcard).toBe(false);
  });
});

describe('SEC-052 — entidades incompletas no son persistibles', () => {
  it('rechaza principal ausente, órdenes discontinuos y nombres globales equivalentes', () => {
    expect(registryFileSchema.safeParse({ schemaVersion: 4, workspaces: [workspace], applications: [{ ...application, primaryServiceId: opaque('service', 'f') }] }).success).toBe(false);
    expect(registryFileSchema.safeParse({ schemaVersion: 4, workspaces: [workspace], applications: [{ ...application, services: [{ ...application.services[0]!, startupOrder: 1 }] }] }).success).toBe(false);
    expect(registryFileSchema.safeParse({ schemaVersion: 4, workspaces: [workspace], applications: [application, { ...application, id: opaque('app', 'b'), name: 'local' }] }).success).toBe(false);
  });
});

describe('SEC-053 — la revisión local no abre una sesión al canal MCP', () => {
  it('mantiene una frontera dedicada y excluye esas sesiones de listado, acceso y stop remotos', () => {
    const source = readFileSync('apps/desktop/src/main/browser-controller.ts', 'utf8');
    expect(source).toContain('startApplicationForLocalReview');
    expect(source).toContain("entry.application?.localReview === true");
    expect(source).toContain("entry.application?.localReview !== true");
    expect(source).toContain('stopLocalReviewSession');
  });
});
