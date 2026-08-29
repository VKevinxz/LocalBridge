import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startDevelopmentBroker, parseBrokerParams, type RunningDevelopmentBroker } from '@localbridge/development';
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

const sessionId = `session_${'a'.repeat(24)}`;

async function setup(): Promise<Array<{ method: string; params: unknown }>> {
  const configPath = path.join(os.tmpdir(), `localbridge-browser-viewport-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [buildWorkspace({
    id: 'ws_web', rootPath: os.tmpdir(),
    permissions: {
      read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false,
      browserRead: true,
    },
  })]);
  const calls: Array<{ method: string; params: unknown }> = [];
  broker = await startDevelopmentBroker({ handler: async (request) => {
    calls.push(request);
    const params = request.params as { width: number; height: number; mobile?: boolean };
    return { sessionId, width: params.width, height: params.height, mobile: params.mobile ?? false, state: 'running' };
  } });
  harness = await createHarness({
    pinProtocol: TARGET_PROTOCOL_REVISION,
    workspaceConfigPath: configPath,
    developmentBrokerEndpoint: broker.endpoint,
    developmentBrokerToken: broker.token,
  });
  return calls;
}

describe('browser.viewport — pruebas responsive', () => {
  it('emula los anchos habituales de una batería responsive', async () => {
    const calls = await setup();
    const breakpoints = [[375, 812], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]] as const;

    for (const [width, height] of breakpoints) {
      const result = await callToolJson(harness!.client, 'browser.viewport', { workspaceId: 'ws_web', sessionId, width, height });
      expect(result.isError, `${width}x${height}`).toBe(false);
      expect(result.parsed).toMatchObject({ sessionId, width, height, mobile: false });
    }
    expect(calls.map((call) => call.method)).toEqual(Array.from({ length: breakpoints.length }, () => 'browser.viewport'));
  });

  it('emula un dispositivo táctil cuando se pide', async () => {
    await setup();
    const result = await callToolJson(harness!.client, 'browser.viewport', {
      workspaceId: 'ws_web', sessionId, width: 390, height: 844, mobile: true,
    });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ width: 390, height: 844, mobile: true });
  });

  it('rechaza dimensiones fuera de rango y campos desconocidos', async () => {
    await setup();
    for (const payload of [
      { workspaceId: 'ws_web', sessionId, width: 100, height: 800 },
      { workspaceId: 'ws_web', sessionId, width: 5000, height: 800 },
      { workspaceId: 'ws_web', sessionId, width: 1280, height: 100 },
      { workspaceId: 'ws_web', sessionId, width: 1280, height: 4000 },
      { workspaceId: 'ws_web', sessionId, width: 1280.5, height: 800 },
      { workspaceId: 'ws_web', sessionId, width: 1280, height: 800, url: 'http://127.0.0.1:5173' },
      { workspaceId: 'ws_web', sessionId, width: 1280, height: 800, userAgent: 'curl/8' },
      { workspaceId: 'ws_web', sessionId, width: 1280, height: 800, deviceScaleFactor: 4 },
    ]) {
      const result = await harness!.client.callTool({ name: 'browser.viewport', arguments: payload });
      expect(result.isError, JSON.stringify(payload)).toBe(true);
    }
  });

  it('el protocolo del broker acota el viewport y no acepta escala ni agente de usuario', () => {
    const valid = { workspaceId: 'ws_web', sessionId, width: 1280, height: 800, mobile: false, operationId: 'vp-1' };
    expect(parseBrokerParams('browser.viewport', valid)).toEqual(valid);
    for (const injected of [
      { deviceScaleFactor: 3 }, { userAgent: 'x' }, { url: 'http://127.0.0.1:1' }, { selector: 'body' }, { width: 10 },
    ]) {
      expect(() => parseBrokerParams('browser.viewport', { ...valid, ...injected }), JSON.stringify(injected)).toThrow();
    }
  });
});
