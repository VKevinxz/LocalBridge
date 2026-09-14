import { afterEach, describe, expect, it } from 'vitest';

import { DevelopmentBrokerError, startDevelopmentBroker, type RunningDevelopmentBroker } from '@localbridge/development';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;

afterEach(async () => {
  await harness?.close();
  await broker?.close();
  harness = undefined;
  broker = undefined;
});

const projectId = 'project_aaaaaaaaaaaaaaaaaaaaaaaa';
const sessionId = 'terminal_bbbbbbbbbbbbbbbbbbbbbbbb';
const summary = {
  sessionId,
  projectId,
  state: 'running',
  trustMode: 'full-host',
  startedAt: '2026-08-26T00:00:00.000Z',
  deadline: '2026-08-26T04:00:00.000Z',
  nextCursor: 0,
} as const;

describe('terminal de confianza vía broker privado', () => {
  it('opera solo con identificadores opacos y salida acotada', async () => {
    const methods: string[] = [];
    let readParams: unknown;
    broker = await startDevelopmentBroker({
      handler: async ({ method, params }) => {
        methods.push(method);
        if (method === 'terminal.list') return [summary];
        if (method === 'terminal.read') {
          readParams = params;
          return { session: { ...summary, nextCursor: 1 }, entries: [{ cursor: 0, stream: 'terminal', text: 'ready\r\n' }], nextCursor: 1, truncatedBeforeCursor: false, waitOutcome: 'output', waitedMs: 25 };
        }
        if (method === 'terminal.status') {
          return {
            session: summary,
            listeners: [{
              listenerRef: 'listener_cccccccccccccccccccccccc',
              origin: 'http://127.0.0.1:5173',
              addressFamily: 'ipv4',
              bindScope: 'loopback',
              exclusive: true,
              port: 5173,
              observedAt: '2026-08-26T00:00:01.000Z',
            }],
          };
        }
        if (method === 'terminal.write') return { session: { ...summary, nextCursor: 1 }, nextCursor: 1 };
        return summary;
      },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    expect((await callToolJson(harness.client, 'terminal.start', { projectId, operationId: 'start-1' })).parsed).toMatchObject(summary);
    expect((await callToolJson(harness.client, 'terminal.list', { projectId })).parsed).toEqual({ sessions: [summary] });
    expect((await callToolJson(harness.client, 'terminal.write', { projectId, sessionId, text: 'npm run dev\r', operationId: 'write-1' })).parsed).toMatchObject({ nextCursor: 1 });
    expect((await callToolJson(harness.client, 'terminal.read', { projectId, sessionId, cursor: 0, maxBytes: 1024, waitMs: 5_000 })).parsed).toMatchObject({ entries: [{ text: 'ready\r\n' }], waitOutcome: 'output', waitedMs: 25 });
    expect((await callToolJson(harness.client, 'terminal.status', { projectId, sessionId })).parsed).toMatchObject({ listeners: [{ port: 5173 }] });
    expect((await callToolJson(harness.client, 'terminal.stop', { projectId, sessionId, operationId: 'stop-1' })).parsed).toMatchObject(summary);
    expect(readParams).toMatchObject({ waitMs: 5_000, cursor: 0 });
    expect(methods).toEqual(['terminal.start', 'terminal.list', 'terminal.write', 'terminal.read', 'terminal.status', 'terminal.stop']);
  });

  it('preserva un fallo cerrado de confianza sin revelar su detalle interno', async () => {
    broker = await startDevelopmentBroker({
      handler: async () => { throw new DevelopmentBrokerError('TERMINAL_NOT_AUTHORIZED', 'ruta y decisión privadas'); },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, 'terminal.start', { projectId });
    expect(result.isError).toBe(true);
    expect(result.parsed['error']).toMatchObject({ code: 'TERMINAL_NOT_AUTHORIZED' });
    expect(JSON.stringify(result.parsed)).not.toContain('ruta y decisión privadas');
  });

  it('distingue capacidad de terminal y de esperas con recuperación cerrada', async () => {
    broker = await startDevelopmentBroker({
      handler: async () => { throw new DevelopmentBrokerError('RATE_LIMITED', 'detalle privado de capacidad'); },
    });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const start = await callToolJson(harness.client, 'terminal.start', { projectId, operationId: 'capacity-start' });
    const read = await callToolJson(harness.client, 'terminal.read', { projectId, sessionId, cursor: 0, waitMs: 5_000 });
    expect(start.parsed['error']).toMatchObject({
      code: 'RATE_LIMITED',
      rateLimit: { resource: 'terminal-sessions', scope: 'project', recoveryTool: 'terminal.list', action: 'list-and-reuse' },
    });
    expect(read.parsed['error']).toMatchObject({
      code: 'RATE_LIMITED',
      rateLimit: { resource: 'terminal-output-waits', scope: 'session', recoveryTool: 'terminal.read', action: 'immediate-read' },
    });
    expect(JSON.stringify([start.parsed, read.parsed])).not.toContain('detalle privado');
  });
});
