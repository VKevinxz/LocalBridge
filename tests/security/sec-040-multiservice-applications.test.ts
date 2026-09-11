import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseBrokerParams } from '@localbridge/development';
import { browserApplicationProfileSchema, registryFileSchema, workspaceSchema } from '@localbridge/workspace';

const opaque = (prefix: string, character: string): string => `${prefix}_${character.repeat(24)}`;
const processProfile = {
  command: ['npm', 'run', 'dev'],
  cwd: '.',
  source: {
    kind: 'package-script' as const,
    manifestPath: 'package.json' as const,
    script: 'dev',
    definitionSha256: 'a'.repeat(64),
  },
  maxRuntimeSeconds: 300,
};
const workspace = (id: string) => workspaceSchema.parse({
  id,
  name: id,
  rootPath: `C:\\${id}`,
  enabled: true,
  createdAt: '2026-08-24T00:00:00.000Z',
  permissions: {
    read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    processes: true, browserRead: true,
  },
  limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
  denyPatterns: ['.env'],
  validationProfiles: {},
  processProfiles: { dev: processProfile },
});

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-040 — MCP no aporta autoridad de red ni sustituye servicios', () => {
  it('acepta exclusivamente alias y referencias opacas en la composición revisada', () => {
    const valid = {
      workspaceId: 'ws_frontend',
      application: 'cip',
      listeners: [
        { service: 'frontend', processId: opaque('process', 'a'), listenerRef: opaque('listener', 'a') },
        { service: 'api', processId: opaque('process', 'b'), listenerRef: opaque('listener', 'b') },
      ],
    };
    expect(parseBrokerParams('browser.start', valid)).toEqual(valid);
    expect(() => parseBrokerParams('browser.start', { ...valid, url: 'http://localhost:3007' })).toThrow();
    expect(() => parseBrokerParams('browser.start', {
      ...valid,
      listeners: [{ ...valid.listeners[0], workspaceId: 'ws_other', port: 3007 }],
    })).toThrow();
  });
});

describe('SEC-041 — localhost permanece local y no amplía perfiles estáticos', () => {
  it('solo aparece en aplicaciones atestiguadas y se resuelve sin DNS remoto ni caché', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const staticProfile = {
      origin: 'http://localhost:5173',
      allowedOrigins: ['http://localhost:5173'],
      viewport: { width: 1280, height: 800 },
    };
    expect(workspaceSchema.safeParse({ ...workspace('ws_static'), browserProfiles: { app: staticProfile } }).success).toBe(false);
    expect(controller).toContain("resolveHost('localhost'");
    expect(controller).toContain("source: 'localOnly'");
    expect(controller).toContain("cacheUsage: 'disallowed'");
    expect(controller).toContain("endpoint.address === '127.0.0.1' || endpoint.address === '::1'");
  });
});

describe('SEC-042 — la autoridad exige listener vigente y exclusivo', () => {
  it('conserva familia, clase de bind y exclusividad en cada revalidación', async () => {
    const [controller, supervisor] = await Promise.all([
      source('apps/desktop/src/main/browser-controller.ts'),
      source('packages/development/src/process-supervisor.ts'),
    ]);
    expect(supervisor).toContain("['LBP1', 'LBP2']");
    expect(supervisor).toContain('exclusive');
    expect(controller).toContain('current.bindScope !== binding.expected.bindScope');
    expect(controller).toContain('!current.exclusive');
  });
});

describe('SEC-043 — wildcard administrado requiere consentimiento local', () => {
  it('queda apagado por defecto y nunca es adoptable por el flujo dinámico simple', async () => {
    const parsed = browserApplicationProfileSchema.parse({
      primaryService: 'api',
      services: { api: { workspaceId: 'ws_api', processProfile: 'dev', startupOrder: 0 } },
      viewport: { width: 1280, height: 800 },
    });
    expect(parsed.services.api?.allowManagedWildcard).toBe(false);
    expect(browserApplicationProfileSchema.safeParse({
      ...parsed,
      services: { api: { ...parsed.services.api, hostMode: 'listener-literal', allowManagedWildcard: true } },
    }).success).toBe(false);
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain("listener.bindScope !== 'loopback'");
    expect(controller).toContain("fail('MANAGED_WILDCARD_NOT_APPROVED'");
  });
});

describe('SEC-044 — HTTP y WebSocket revalidan el servicio correspondiente', () => {
  it('convierte ws al origen http y consulta el binding exacto antes de permitir', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain("if (requestUrl.protocol === 'ws:') requestUrl.protocol = 'http:'");
    expect(controller).toContain('listenerBindings.find((candidate) => candidate.origin === requestUrl.origin)');
    expect(controller).toContain('await this.verifyListenerBinding(browserSession, binding)');
  });
});

describe('SEC-045 — perder un servicio destruye el entorno completo', () => {
  it('invalida conexiones inmediatamente y reconcilia todos los bindings', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain('invalidateNetworkAuthority(entry)');
    expect(controller).toContain('clearHostResolverCache()');
    expect(controller).toContain('closeAllConnections()');
    expect(controller).toContain('for (const binding of entry.listenerBindings)');
  });
});

describe('SEC-046 — el login no cruza el protocolo ni los eventos propios', () => {
  it('rechaza secretos extra y conserva eventos de red reducidos a estado y ruta', async () => {
    const valid = {
      workspaceId: 'ws_frontend',
      sessionId: opaque('session', 'a'),
      reason: 'sign_in' as const,
      operationId: 'human_1',
    };
    expect(() => parseBrokerParams('browser.human.request', { ...valid, password: 'secret' })).toThrow();
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain("message: `HTTP ${stringValue(response?.['status'])}`");
    expect(controller).not.toContain("response?.['requestHeaders']");
    expect(controller).not.toContain("response?.['body']");
  });
});

describe('SEC-047 — referencias cruzadas fallan cerradas', () => {
  it('rechaza workspaces o perfiles de proceso inexistentes en una aplicación', () => {
    const frontend = workspace('ws_frontend');
    const application = {
      id: opaque('app', 'a'), name: 'CIP', description: '', primaryServiceId: opaque('service', 'a'),
      services: [{
          id: opaque('service', 'a'), alias: 'api',
          workspaceId: 'ws_missing', processProfile: 'dev', startupOrder: 0,
          hostMode: 'manual-localhost' as const, allowManagedWildcard: false,
        }],
      viewport: { width: 1280, height: 800 },
      reviewState: 'reviewed' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    };
    expect(registryFileSchema.safeParse({
      schemaVersion: 5, workspaces: [frontend], applications: [application],
    }).success).toBe(false);
    expect(registryFileSchema.safeParse({
      schemaVersion: 5, workspaces: [frontend, workspace('ws_api')],
      applications: [{ ...application, services: [{ ...application.services[0], workspaceId: 'ws_api', processProfile: 'missing' }] }],
    }).success).toBe(false);
  });
});
