import { randomBytes } from 'node:crypto';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DevelopmentBrokerClient,
  DevelopmentBrokerError,
  MAX_BROKER_FRAME_BYTES,
  createBrokerEndpoint,
  encodeBrokerFrame,
  startDevelopmentBroker,
  type RunningDevelopmentBroker,
} from '@localbridge/development';

describe('development broker', () => {
  let broker: RunningDevelopmentBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('atiende una llamada real por IPC autenticado', async () => {
    broker = await startDevelopmentBroker({
      handler: async ({ method }) => ({ method, ready: true }),
    });
    const client = new DevelopmentBrokerClient({ endpoint: broker.endpoint, token: broker.token });

    await expect(client.call('broker.ping', {})).resolves.toEqual({ method: 'broker.ping', ready: true });
  });

  it('rechaza un token incorrecto sin ejecutar el handler', async () => {
    let calls = 0;
    broker = await startDevelopmentBroker({
      handler: async () => {
        calls += 1;
        return {};
      },
      requestTimeoutMs: 500,
    });
    const client = new DevelopmentBrokerClient({ endpoint: broker.endpoint, token: randomBytes(32).toString('hex'), timeoutMs: 1000 });

    await expect(client.call('broker.ping', {})).rejects.toBeInstanceOf(DevelopmentBrokerError);
    expect(calls).toBe(0);
  });

  it('cierra la conexión ante un frame declarado por encima del límite', async () => {
    broker = await startDevelopmentBroker({ handler: async () => ({}) });
    const socket = net.createConnection(broker.endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_BROKER_FRAME_BYTES + 1);
    socket.write(header);
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  });

  it('valida endpoint, método y parámetros antes de tocar el transporte', async () => {
    expect(() => createBrokerEndpoint('bad')).toThrow('invalid broker endpoint id');
    expect(() => encodeBrokerFrame('x'.repeat(MAX_BROKER_FRAME_BYTES + 1))).toThrow('exceeds limit');
    expect(() => new DevelopmentBrokerClient({ endpoint: 'tcp://127.0.0.1:1', token: randomBytes(32).toString('hex') })).toThrow('invalid broker endpoint');
  });
});
