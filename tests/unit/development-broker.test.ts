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
  webTabSummarySchema,
  type RunningDevelopmentBroker,
} from '@localbridge/development';
import { LocalBridgeError } from '@localbridge/shared';

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

  it('conserva códigos de dominio seguros sin filtrar detalles por el broker', async () => {
    broker = await startDevelopmentBroker({
      handler: async () => {
        throw new LocalBridgeError('FILE_TOO_LARGE', { path: 'C:\\privado\\captura.png' });
      },
    });
    const client = new DevelopmentBrokerClient({ endpoint: broker.endpoint, token: broker.token });

    await expect(client.call('broker.ping', {})).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(client.call('broker.ping', {})).rejects.not.toThrow(/privado|captura\.png/i);
  });

  it('transporta un causeCode catalogado y descarta causas arbitrarias', async () => {
    broker = await startDevelopmentBroker({
      handler: async () => {
        throw new DevelopmentBrokerError('MOTION_EFFECT_UNCERTAIN', 'captura incierta', 'FILE_TOO_LARGE');
      },
    });
    let client = new DevelopmentBrokerClient({ endpoint: broker.endpoint, token: broker.token });
    await expect(client.call('broker.ping', {})).rejects.toMatchObject({
      code: 'MOTION_EFFECT_UNCERTAIN', causeCode: 'FILE_TOO_LARGE',
    });
    await broker.close();

    broker = await startDevelopmentBroker({
      handler: async () => {
        throw new DevelopmentBrokerError('MOTION_EFFECT_UNCERTAIN', 'captura incierta', 'C:\\privado\\frame.png');
      },
    });
    client = new DevelopmentBrokerClient({ endpoint: broker.endpoint, token: broker.token });
    await expect(client.call('broker.ping', {})).rejects.toMatchObject({ causeCode: undefined });
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

  it('comparte el contrato completo de pestaña web con visor y motion', () => {
    expect(webTabSummarySchema.parse({
      tabId: `webtab_${'a'.repeat(24)}`, title: 'Referencia', url: 'https://example.com/', state: 'ready',
      openedAt: '2026-09-07T12:00:00.000Z', viewport: { width: 1920, height: 1080, mobile: false },
      blockedNativeDownloads: 0, blockedFileChoosers: 0, blockedDialogs: 0,
      motionCapture: { completed: 1, total: 12, mode: 'auto' },
      lastMotionCapture: { path: 'evidence/reference.lbmotion', frameCount: 12, totalSize: 100, captureMode: 'stepped', warnings: [] },
      viewerPresentation: { mode: 'actual', renderWidth: 1920, renderHeight: 1080, viewWidth: 1280, viewHeight: 720,
        scale: 1, panX: 100, panY: 50 },
    })).toMatchObject({ viewerPresentation: { mode: 'actual' }, lastMotionCapture: { frameCount: 12 } });
  });

  it('da a motion un margen de transporte mayor que el timeout ordinario', async () => {
    broker = await startDevelopmentBroker({ handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    }, requestTimeoutMs: 10, longRequestTimeoutMs: 100 });
    const client = new DevelopmentBrokerClient({ endpoint: broker.endpoint, token: broker.token, timeoutMs: 10, longTimeoutMs: 100 });
    await expect(client.call('web.motion.capture', {
      sessionId: `websession_${'a'.repeat(24)}`, tabId: `webtab_${'b'.repeat(24)}`, workspaceId: 'ws_demo',
      path: 'evidence/test.lbmotion', operationId: 'motion_timeout',
      trajectory: { axis: 'y', startY: 0, distancePx: 100, durationMs: 250, sampleCount: 3 },
      settleBeforeMs: 0, captureMode: 'stepped',
    })).resolves.toEqual({ ok: true });
  });

  it('da a web.download un margen propio mayor que motion y el timeout ordinario', async () => {
    broker = await startDevelopmentBroker({ handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    }, requestTimeoutMs: 10, longRequestTimeoutMs: 20, downloadRequestTimeoutMs: 100 });
    const downloadClient = new DevelopmentBrokerClient({
      endpoint: broker.endpoint,
      token: broker.token,
      timeoutMs: 10,
      longTimeoutMs: 20,
      downloadTimeoutMs: 100,
    });
    await expect(downloadClient.call('web.download', {
      sessionId: `websession_${'a'.repeat(24)}`,
      tabId: `webtab_${'b'.repeat(24)}`,
      resourceRef: `webresource_${'c'.repeat(20)}`,
      workspaceId: 'ws_demo',
      path: 'assets/hero.avif',
      operationId: 'download_timeout',
    })).resolves.toEqual({ ok: true });
  });
});
