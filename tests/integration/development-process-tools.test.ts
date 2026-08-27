import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DevelopmentBrokerError, startDevelopmentBroker, type RunningDevelopmentBroker } from '@localbridge/development';
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

describe('tools de procesos vía broker privado', () => {
  it('repite permisos y devuelve identificadores opacos, nunca comandos o PID', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-process-tools-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_process',
      rootPath: os.tmpdir(),
      permissions: {
        read: true,
        write: false,
        overwrite: false,
        gitRead: false,
        validations: false,
        gitWrite: false,
        processes: true,
      },
    })]);
    const summary = {
      processId: 'process_aaaaaaaaaaaaaaaaaaaaaaaa',
      profile: 'dev',
      state: 'running',
      startedAt: '2026-08-23T00:00:00.000Z',
      deadline: '2026-08-23T04:00:00.000Z',
    };
    const listener = {
      listenerRef: 'listener_aaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'http://127.0.0.1:5173',
      addressFamily: 'ipv4',
      port: 5173,
      bindScope: 'loopback',
      exclusive: true,
      observedAt: '2026-08-23T00:00:01.000Z',
    };
    broker = await startDevelopmentBroker({
      handler: async ({ method }) => {
        if (method === 'process.list') return [summary];
        if (method === 'process.listeners') return { process: summary, listeners: [listener] };
        return summary;
      },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'process.start', {
      workspaceId: 'ws_process',
      profile: 'dev',
      operationId: 'start_1',
    });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject(summary);
    expect(JSON.stringify(result.parsed)).not.toMatch(/pid|command|rootPath/i);

    const listeners = await callToolJson(harness.client, 'process.listeners', {
      workspaceId: 'ws_process',
      processId: summary.processId,
    });
    expect(listeners.isError).toBe(false);
    expect(listeners.parsed).toEqual({ process: summary, listeners: [listener] });
    expect(JSON.stringify(listeners.parsed)).not.toMatch(/ownerPid|command|rootPath/i);
  });

  it('deniega antes del broker cuando el permiso no está activo', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-process-denied-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_denied', rootPath: os.tmpdir() })]);
    let calls = 0;
    broker = await startDevelopmentBroker({ handler: async () => { calls += 1; return {}; } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'process.list', { workspaceId: 'ws_denied' });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'CAPABILITY_DISABLED' });
    expect(calls).toBe(0);
  });

  it('preserva el error recuperable cuando el perfil no existe', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-process-profile-missing-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({
      id: 'ws_profile_missing',
      rootPath: os.tmpdir(),
      permissions: {
        read: true,
        write: false,
        overwrite: false,
        gitRead: false,
        validations: false,
        gitWrite: false,
        processes: true,
      },
    })]);
    broker = await startDevelopmentBroker({
      handler: async () => { throw new DevelopmentBrokerError('PROFILE_NOT_FOUND', 'perfil ausente'); },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'process.start', {
      workspaceId: 'ws_profile_missing',
      profile: 'preview',
    });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'PROFILE_NOT_FOUND', recoverable: true });
    expect(JSON.stringify(result.parsed)).not.toContain('perfil ausente');
  });
});
