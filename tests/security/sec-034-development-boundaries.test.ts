import { describe, expect, it } from 'vitest';

import { workspaceSchema } from '@localbridge/workspace';

import { isAllowedBrowserRequest } from '../../apps/desktop/src/main/browser-network-policy.js';

const base = {
  id: 'ws_security',
  name: 'Security',
  rootPath: 'C:\\project',
  enabled: true,
  createdAt: '2026-08-23T00:00:00.000Z',
  permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
  limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2 },
  denyPatterns: ['.env'],
  validationProfiles: {},
};

const browserProfile = (origin: string) => ({ origin, allowedOrigins: [origin], viewport: { width: 1280, height: 800 } });

describe('SEC-034 — fronteras del runtime de desarrollo', () => {
  it('migra V0.2.x con todas las capacidades nuevas desactivadas', () => {
    const workspace = workspaceSchema.parse(base);
    expect(workspace.permissions).toMatchObject({ processes: false, browserRead: false, browserInteract: false, browserHumanControl: false });
    expect(workspace.processProfiles).toEqual({});
    expect(workspace.browserProfiles).toEqual({});
  });

  it('rechaza cwd absoluto o con traversal en un perfil de proceso', () => {
    const profile = {
      command: ['npm', 'run', 'dev'],
      cwd: '..\\outside',
      source: { kind: 'package-script', manifestPath: 'package.json', script: 'dev', definitionSha256: 'a'.repeat(64) },
      maxRuntimeSeconds: 300,
    };
    expect(workspaceSchema.safeParse({ ...base, processProfiles: { dev: profile } }).success).toBe(false);
    expect(workspaceSchema.safeParse({ ...base, processProfiles: { dev: { ...profile, cwd: 'C:\\outside' } } }).success).toBe(false);
  });

  it('rechaza red, hostname ambiguo y dependencia incompleta de interacción', () => {
    expect(workspaceSchema.safeParse({ ...base, browserProfiles: { app: browserProfile('http://192.168.1.10:5173') } }).success).toBe(false);
    expect(workspaceSchema.safeParse({ ...base, browserProfiles: { app: browserProfile('http://localhost:5173') } }).success).toBe(false);
    expect(workspaceSchema.safeParse({
      ...base,
      permissions: { ...base.permissions, browserInteract: true, browserRead: false },
    }).success).toBe(false);
    expect(workspaceSchema.safeParse({
      ...base,
      permissions: { ...base.permissions, browserHumanControl: true, browserRead: false },
    }).success).toBe(false);
  });

  it('permite HMR solo en la misma IP y puerto HTTP ya aprobados', () => {
    const allowedOrigins = new Set(['http://127.0.0.1:5173']);

    expect(isAllowedBrowserRequest('http://127.0.0.1:5173/src/main.ts', 'script', allowedOrigins)).toBe(true);
    expect(isAllowedBrowserRequest('ws://127.0.0.1:5173/', 'webSocket', allowedOrigins)).toBe(true);
    expect(isAllowedBrowserRequest('ws://127.0.0.1:5174/', 'webSocket', allowedOrigins)).toBe(false);
    expect(isAllowedBrowserRequest('ws://127.0.0.1:5173/', 'xhr', allowedOrigins)).toBe(false);
    expect(isAllowedBrowserRequest('wss://127.0.0.1:5173/', 'webSocket', allowedOrigins)).toBe(false);
    expect(isAllowedBrowserRequest('ws://user:secret@127.0.0.1:5173/', 'webSocket', allowedOrigins)).toBe(false);
    expect(isAllowedBrowserRequest('ws://localhost:5173/', 'webSocket', allowedOrigins)).toBe(false);
    expect(isAllowedBrowserRequest('ws://192.168.1.10:5173/', 'webSocket', allowedOrigins)).toBe(false);
    expect(isAllowedBrowserRequest('ws://[::1]:5173/', 'webSocket', new Set(['http://[::1]:5173']))).toBe(true);
  });
});
