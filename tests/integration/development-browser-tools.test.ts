import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startDevelopmentBroker, type RunningDevelopmentBroker } from '@localbridge/development';
import { queryAuditEvents } from '@localbridge/audit';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, writeRegistryFile } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;

afterEach(async () => {
  await harness?.close();
  await broker?.close();
  harness = undefined;
  broker = undefined;
});

describe('tools web de solo lectura vía broker privado', () => {
  it('solicita control humano exclusivo con razón cerrada y sin aceptar datos sensibles', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-human-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_manual', rootPath: os.tmpdir(),
      permissions: {
        read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false,
        browserRead: true, browserHumanControl: true,
      },
    })]);
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return request.method === 'browser.human.request'
        ? { requestId: 'humanreq_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'file_selection', state: 'waiting_for_human', expiresAt: '2026-08-25T20:00:00.000Z', retryAfterMs: 1000 }
        : { requestId: 'humanreq_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'file_selection', state: 'ready' };
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const requested = await callToolJson(harness.client, 'browser.human.request', {
      workspaceId: 'ws_manual', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'file_selection', operationId: 'human_1',
    });
    expect(requested.isError).toBe(false);
    expect(requested.parsed).toMatchObject({ state: 'waiting_for_human', reason: 'file_selection' });
    const status = await callToolJson(harness.client, 'browser.human.status', {
      workspaceId: 'ws_manual', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(status.parsed).toMatchObject({ state: 'ready', reason: 'file_selection' });
    expect(calls).toEqual([
      expect.objectContaining({ method: 'browser.human.request' }),
      expect.objectContaining({ method: 'browser.human.status' }),
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/path|fileName|filePath|bytes|selector|instruction|credential|password/i);

    const injectedPath = await harness.client.callTool({
      name: 'browser.human.request',
      arguments: {
        workspaceId: 'ws_manual', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'file_selection', operationId: 'human_2',
        path: 'C:\\privado\\archivo.xlsx',
      },
    });
    expect(injectedPath.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('deniega control humano antes del broker cuando falta el permiso independiente', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-human-denied-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_manual_denied', rootPath: os.tmpdir(),
      permissions: {
        read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false,
        browserRead: true, browserHumanControl: false,
      },
    })]);
    let calls = 0;
    broker = await startDevelopmentBroker({ handler: async () => { calls += 1; return {}; } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'browser.human.request', {
      workspaceId: 'ws_manual_denied', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'manual_step', operationId: 'human_denied_1',
    });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'CAPABILITY_DISABLED' });
    expect(calls).toBe(0);
  });

  it('usa el mismo control humano para iniciar sesión sin aceptar credenciales', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-human-sign-in-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_auth', rootPath: os.tmpdir(),
      permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, browserRead: true, browserHumanControl: true },
    })]);
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return request.method === 'browser.human.request'
        ? { requestId: 'humanreq_bbbbbbbbbbbbbbbbbbbbbbbb', reason: 'sign_in', state: 'waiting_for_human', expiresAt: '2026-08-24T02:00:00.000Z', retryAfterMs: 1000 }
        : { requestId: 'humanreq_bbbbbbbbbbbbbbbbbbbbbbbb', reason: 'sign_in', state: 'ready', expiresAt: '2026-08-24T02:30:00.000Z' };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const requested = await callToolJson(harness.client, 'browser.human.request', { workspaceId: 'ws_auth', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'sign_in', operationId: 'human_sign_in_1' });
    expect(requested.isError).toBe(false);
    expect(requested.parsed).toMatchObject({ state: 'waiting_for_human', reason: 'sign_in' });
    const status = await callToolJson(harness.client, 'browser.human.status', { workspaceId: 'ws_auth', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(status.parsed).toMatchObject({ state: 'ready', reason: 'sign_in' });
    expect(JSON.stringify(calls)).not.toMatch(/password|credential|cookie|token/i);
  });

  it('adopta solo referencias verificadas y exige procesos además de browserRead', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-dynamic-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_dynamic',
      rootPath: os.tmpdir(),
      permissions: {
        read: true,
        write: false,
        overwrite: false,
        gitRead: false,
        validations: false,
        gitWrite: false,
        processes: true,
        browserRead: true,
      },
    })]);
    const calls: unknown[] = [];
    broker = await startDevelopmentBroker({
      handler: async (request) => {
        calls.push(request);
        return {
          sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
          profile: 'detected:dev',
          state: 'running',
          title: 'Development page',
          path: '/',
          startedAt: '2026-08-23T00:00:00.000Z',
          controlState: 'agent_control',
        };
      },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'browser.start', {
      workspaceId: 'ws_dynamic',
      processId: 'process_aaaaaaaaaaaaaaaaaaaaaaaa',
      listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
      operationId: 'browser_dynamic_1',
    });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([expect.objectContaining({
      method: 'browser.start',
      params: {
        workspaceId: 'ws_dynamic',
        processId: 'process_aaaaaaaaaaaaaaaaaaaaaaaa',
        listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
        operationId: 'browser_dynamic_1',
      },
    })]);
    expect(JSON.stringify(calls)).not.toMatch(/127\.0\.0\.1|origin|port/i);
  });

  it('adopta una aplicación multiservicio solo con el conjunto exacto de aliases revisados', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-application-${randomUUID()}`, 'workspaces.json');
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
    const permissions = {
      read: true,
      write: false,
      overwrite: false,
      gitRead: false,
      validations: false,
      gitWrite: false,
      processes: true,
      browserRead: true,
    };
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_frontend',
        rootPath: os.tmpdir(),
        permissions,
        processProfiles: { dev: processProfile },
      }),
      buildWorkspace({ id: 'ws_api', rootPath: os.tmpdir(), permissions, processProfiles: { dev: processProfile } }),
    ], [{
      id: 'app_aaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'cip',
      description: '',
      primaryServiceId: 'service_aaaaaaaaaaaaaaaaaaaaaaaa',
      services: [
        { id: 'service_aaaaaaaaaaaaaaaaaaaaaaaa', alias: 'frontend', workspaceId: 'ws_frontend', processProfile: 'dev', startupOrder: 1, hostMode: 'manual-localhost', allowManagedWildcard: false },
        { id: 'service_bbbbbbbbbbbbbbbbbbbbbbbb', alias: 'api', workspaceId: 'ws_api', processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: true },
      ],
      viewport: { width: 1280, height: 800 },
      reviewState: 'reviewed',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }]);
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return {
        sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
        profile: 'application:cip',
        state: 'running',
        title: 'CIP',
        path: '/',
        startedAt: '2026-08-24T00:00:00.000Z',
        controlState: 'agent_control',
      };
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });
    const listeners = [
      { service: 'frontend', processId: 'process_aaaaaaaaaaaaaaaaaaaaaaaa', listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa' },
      { service: 'api', processId: 'process_bbbbbbbbbbbbbbbbbbbbbbbb', listenerRef: 'listener_bbbbbbbbbbbbbbbbbbbbbbbb' },
    ];

    const result = await callToolJson(harness.client, 'browser.start', {
      workspaceId: 'ws_frontend', application: 'cip', listeners, operationId: 'browser_cip_1',
    });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([expect.objectContaining({
      method: 'browser.start',
      params: { workspaceId: 'ws_frontend', application: 'cip', listeners, operationId: 'browser_cip_1' },
    })]);
    expect(JSON.stringify(calls)).not.toMatch(/localhost|127\.0\.0\.1|workspaceId":"ws_api|port/i);

    const missing = await callToolJson(harness.client, 'browser.start', {
      workspaceId: 'ws_frontend', application: 'cip', listeners: listeners.slice(0, 1),
    });
    expect(missing.isError).toBe(true);
    expect(missing.parsed['error']).toMatchObject({ code: 'APPLICATION_SERVICE_MISMATCH' });
    expect(calls).toHaveLength(1);
  });

  it('deniega adopción dinámica sin permiso de procesos antes del broker', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-dynamic-denied-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_dynamic_denied',
      rootPath: os.tmpdir(),
      permissions: {
        read: true,
        write: false,
        overwrite: false,
        gitRead: false,
        validations: false,
        gitWrite: false,
        processes: false,
        browserRead: true,
      },
    })]);
    let calls = 0;
    broker = await startDevelopmentBroker({ handler: async () => { calls += 1; return {}; } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'browser.start', {
      workspaceId: 'ws_dynamic_denied',
      processId: 'process_aaaaaaaaaaaaaaaaaaaaaaaa',
      listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'CAPABILITY_DISABLED' });
    expect(calls).toBe(0);
  });

  it('reenvía una composición project-first usando solo refs opacas', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-project-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_project', rootPath: os.tmpdir(),
      permissions: {
        read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false,
        processes: true, browserRead: true,
      },
    })]);
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return {
        sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa', profile: 'project:2-services', state: 'running',
        title: 'CIP', path: '/', startedAt: '2026-08-26T00:00:00.000Z', controlState: 'agent_control',
      };
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });
    const relatedListeners = [{
      terminalSessionId: 'terminal_bbbbbbbbbbbbbbbbbbbbbbbb',
      listenerRef: 'listener_bbbbbbbbbbbbbbbbbbbbbbbb',
    }];
    const result = await callToolJson(harness.client, 'browser.start', {
      workspaceId: 'ws_project',
      projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
      terminalSessionId: 'terminal_aaaaaaaaaaaaaaaaaaaaaaaa',
      listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
      relatedListeners,
      operationId: 'browser_project_1',
    });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([expect.objectContaining({
      method: 'browser.start',
      params: {
        workspaceId: 'ws_project',
        projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
        terminalSessionId: 'terminal_aaaaaaaaaaaaaaaaaaaaaaaa',
        listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
        relatedListeners,
        operationId: 'browser_project_1',
      },
    })]);
    expect(JSON.stringify(calls)).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]|port|root|trustMode/i);
  });

  it('expone snapshot y captura sin filtrar origen ni almacenamiento local', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-tools-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_browser',
      rootPath: os.tmpdir(),
      permissions: {
        read: true,
        write: false,
        overwrite: false,
        gitRead: false,
        validations: false,
        gitWrite: false,
        browserRead: true,
      },
    })]);
    broker = await startDevelopmentBroker({
      handler: async ({ method }) => {
        if (method === 'browser.snapshot') {
          return { snapshotId: 'snapshot_aaaaaaaaaaaaaaaaaaaa', title: 'App', path: '/', nodes: [{ depth: 1, role: 'button', name: 'Guardar', elementRef: 'element_aaaaaaaaaaaaaaaaaaaa' }] };
        }
        if (method === 'browser.screenshot') {
          return { mimeType: 'image/png', dataBase64: Buffer.from('png-test').toString('base64'), width: 800, height: 600 };
        }
        return {};
      },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const snapshot = await callToolJson(harness.client, 'browser.snapshot', {
      workspaceId: 'ws_browser',
      sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(snapshot.isError).toBe(false);
    expect(snapshot.parsed['nodes']).toEqual([expect.objectContaining({ role: 'button', name: 'Guardar' })]);
    expect(JSON.stringify(snapshot.parsed)).not.toContain('127.0.0.1');

    const screenshot = await harness.client.callTool({
      name: 'browser.screenshot',
      arguments: { workspaceId: 'ws_browser', sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(screenshot.isError).not.toBe(true);
    expect(screenshot.content.some((item) => item.type === 'image')).toBe(true);
    expect(JSON.stringify(screenshot.structuredContent)).not.toContain('dataBase64');
  });

  it('deniega navegación sin browserRead antes de contactar el broker', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-denied-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_denied', rootPath: os.tmpdir() })]);
    let calls = 0;
    broker = await startDevelopmentBroker({ handler: async () => { calls += 1; return {}; } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });
    const result = await callToolJson(harness.client, 'browser.navigate', {
      workspaceId: 'ws_denied',
      sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
      path: '/',
    });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'CAPABILITY_DISABLED' });
    expect(calls).toBe(0);
  });

  it('interactúa solo con permiso doble y no persiste el texto completado en auditoría', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-browser-interact-${randomUUID()}`, 'workspaces.json');
    const auditDbPath = path.join(os.tmpdir(), `localbridge-browser-audit-${randomUUID()}.db`);
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_interact',
      rootPath: os.tmpdir(),
      permissions: {
        read: true,
        write: false,
        overwrite: false,
        gitRead: false,
        validations: false,
        gitWrite: false,
        browserRead: true,
        browserInteract: true,
      },
    })]);
    broker = await startDevelopmentBroker({ handler: async () => ({
      sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
      applied: true,
      snapshotInvalidated: true,
    }) });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });
    const secretLikeText = 'texto-privado-que-no-va-a-auditoria';
    const result = await callToolJson(harness.client, 'browser.fill', {
      workspaceId: 'ws_interact',
      sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa',
      snapshotId: 'snapshot_aaaaaaaaaaaaaaaaaaaa',
      elementRef: 'element_aaaaaaaaaaaaaaaaaaaa',
      text: secretLikeText,
      operationId: 'fill_1',
    });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ applied: true, snapshotInvalidated: true });
    expect(JSON.stringify(queryAuditEvents(auditDbPath, { action: 'browser.fill' }))).not.toContain(secretLikeText);
  });
});
