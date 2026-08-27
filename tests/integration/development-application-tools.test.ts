import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startDevelopmentBroker, type RunningDevelopmentBroker } from '@localbridge/development';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';
import type { LocalApplication } from '@localbridge/workspace';
import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, writeRegistryFile } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;
afterEach(async () => { await harness?.close(); await broker?.close(); harness = undefined; broker = undefined; });

const profile = {
  command: ['npm', 'run', 'dev'], cwd: '.',
  source: { kind: 'package-script' as const, manifestPath: 'package.json' as const, script: 'dev', definitionSha256: 'a'.repeat(64) },
  maxRuntimeSeconds: 300,
};

function app(reviewState: LocalApplication['reviewState'] = 'reviewed'): LocalApplication {
  return {
    id: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'CIP local', description: 'Frontend y API',
    primaryServiceId: 'service_aaaaaaaaaaaaaaaaaaaaaaaa',
    services: [
      { id: 'service_bbbbbbbbbbbbbbbbbbbbbbbb', alias: 'api', workspaceId: 'ws_api', processProfile: 'dev', startupOrder: 0, hostMode: 'manual-localhost', allowManagedWildcard: true },
      { id: 'service_aaaaaaaaaaaaaaaaaaaaaaaa', alias: 'frontend', workspaceId: 'ws_front', processProfile: 'dev', startupOrder: 1, hostMode: 'manual-localhost', allowManagedWildcard: false },
    ],
    viewport: { width: 1280, height: 800 }, reviewState,
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

async function setup(reviewState: LocalApplication['reviewState'] = 'reviewed') {
  const configPath = path.join(os.tmpdir(), `localbridge-app-tools-${randomUUID()}`, 'workspaces.json');
  const permissions = { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: true, browserRead: true };
  await writeRegistryFile(configPath, [
    buildWorkspace({ id: 'ws_api', rootPath: os.tmpdir(), permissions, processProfiles: { dev: profile } }),
    buildWorkspace({ id: 'ws_front', rootPath: os.tmpdir(), permissions, processProfiles: { dev: profile } }),
  ], [app(reviewState)]);
  return configPath;
}

const run = {
  runId: 'run_aaaaaaaaaaaaaaaaaaaaaaaa', applicationId: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', applicationName: 'CIP local',
  primaryWorkspaceId: 'ws_front', state: 'ready', startedAt: '2026-08-24T00:00:00.000Z',
  services: [
    { service: 'api', workspaceId: 'ws_api', processProfile: 'dev', state: 'ready', port: 3007, bindScope: 'wildcard' },
    { service: 'frontend', workspaceId: 'ws_front', processProfile: 'dev', state: 'ready', port: 5173, bindScope: 'loopback' },
  ],
};

describe('tools cerradas de aplicaciones', () => {
  it('lista y orquesta usando solo applicationId/runId opacos', async () => {
    const configPath = await setup();
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => { calls.push(request); return run; } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });

    const listed = await callToolJson(harness.client, 'application.list', {});
    expect(listed.isError).toBe(false);
    expect(listed.parsed['applications']).toEqual([expect.objectContaining({ applicationId: app().id, name: 'CIP local', primaryWorkspaceId: 'ws_front' })]);

    for (const [tool, input] of [
      ['application.start', { applicationId: app().id, operationId: 'start-one' }],
      ['application.status', { applicationId: app().id, runId: run.runId }],
      ['application.stop', { applicationId: app().id, runId: run.runId, operationId: 'stop-one' }],
    ] as const) {
      const result = await callToolJson(harness.client, tool, input);
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.parsed)).not.toMatch(/command|cwd|processId|listenerRef|origin/i);
    }
    expect(calls.map((call) => call.method)).toEqual(['application.start', 'application.status', 'application.status', 'application.stop']);
    expect(JSON.stringify(calls)).not.toMatch(/command|cwd|url|host|workspacePath/i);
  });

  it('abre navegador desde runId sin exponer ni reconstruir listeners', async () => {
    const configPath = await setup();
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return { sessionId: 'session_aaaaaaaaaaaaaaaaaaaaaaaa', profile: `application:${app().id}`, state: 'running', title: 'CIP', path: '/', startedAt: '2026-08-24T00:00:00.000Z', controlState: 'agent_control' };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const result = await callToolJson(harness.client, 'browser.start', { workspaceId: 'ws_front', applicationId: app().id, runId: run.runId });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ method: 'browser.start', params: { workspaceId: 'ws_front', applicationId: app().id, runId: run.runId } }]);
  });

  it('bloquea aplicaciones needs-review antes de contactar el broker', async () => {
    const configPath = await setup('needs-review');
    let calls = 0;
    broker = await startDevelopmentBroker({ handler: async () => { calls += 1; return run; } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const result = await callToolJson(harness.client, 'application.start', { applicationId: app().id });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'APPLICATION_REVIEW_REQUIRED' });
    expect(calls).toBe(0);
  });
});
