import { randomBytes } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';

import {
  BROKER_ID_PATTERN,
  BROKER_TOKEN_PATTERN,
  BrokerFrameDecoder,
  DEVELOPMENT_BROKER_PROTOCOL,
  brokerRequestEnvelopeSchema,
  brokerResponseEnvelopeSchema,
  brokerTokenMatches,
  createBrokerEndpoint,
  encodeBrokerFrame,
  parseBrokerParams,
  validateBrokerEndpoint,
  type BrokerMethod,
  type BrokerResponseEnvelope,
} from './protocol.js';

export class DevelopmentBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DevelopmentBrokerError';
  }
}

export interface BrokerRequestContext {
  readonly method: BrokerMethod;
  readonly params: unknown;
}

export type BrokerHandler = (context: BrokerRequestContext) => Promise<unknown>;

export interface DevelopmentBrokerServerOptions {
  readonly endpoint?: string;
  readonly token?: string;
  readonly handler: BrokerHandler;
  readonly requestTimeoutMs?: number;
}

export interface RunningDevelopmentBroker {
  readonly endpoint: string;
  readonly token: string;
  close(): Promise<void>;
}

function safeBrokerError(error: unknown): { code: string; message: string } {
  if (error instanceof DevelopmentBrokerError && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
    return { code: error.code, message: error.message.slice(0, 512) };
  }
  return { code: 'BROKER_REQUEST_FAILED', message: 'La operación del entorno de desarrollo falló.' };
}

function writeResponse(socket: Socket, response: BrokerResponseEnvelope): void {
  if (!socket.destroyed) socket.write(encodeBrokerFrame(response));
}

export async function startDevelopmentBroker(options: DevelopmentBrokerServerOptions): Promise<RunningDevelopmentBroker> {
  const endpointId = randomBytes(16).toString('hex');
  if (!BROKER_ID_PATTERN.test(endpointId)) throw new Error('failed to generate endpoint id');
  const endpoint = options.endpoint === undefined ? createBrokerEndpoint(endpointId) : validateBrokerEndpoint(options.endpoint);
  const token = options.token ?? randomBytes(32).toString('hex');
  if (!BROKER_TOKEN_PATTERN.test(token)) throw new Error('invalid broker token');
  const sockets = new Set<Socket>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  const server: Server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    const decoder = new BrokerFrameDecoder();
    let chain = Promise.resolve();

    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        chain = chain.then(async () => {
          const envelope = brokerRequestEnvelopeSchema.safeParse(frame);
          if (!envelope.success || !brokerTokenMatches(token, envelope.data.token)) {
            socket.destroy();
            return;
          }
          try {
            const params = parseBrokerParams(envelope.data.method, envelope.data.params);
            const result = await options.handler({ method: envelope.data.method, params });
            writeResponse(socket, {
              version: DEVELOPMENT_BROKER_PROTOCOL,
              id: envelope.data.id,
              ok: true,
              result,
            });
          } catch (error) {
            writeResponse(socket, {
              version: DEVELOPMENT_BROKER_PROTOCOL,
              id: envelope.data.id,
              ok: false,
              error: safeBrokerError(error),
            });
          }
        }).catch(() => {
          socket.destroy();
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    endpoint,
    token,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
    },
  };
}

export interface DevelopmentBrokerClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

export class DevelopmentBrokerClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: DevelopmentBrokerClientOptions) {
    this.endpoint = validateBrokerEndpoint(options.endpoint);
    if (!BROKER_TOKEN_PATTERN.test(options.token)) throw new Error('invalid broker token');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async call(method: BrokerMethod, params: unknown): Promise<unknown> {
    const validatedParams = parseBrokerParams(method, params);
    const id = randomBytes(16).toString('hex');
    const request = {
      version: DEVELOPMENT_BROKER_PROTOCOL,
      id,
      token: this.token,
      method,
      params: validatedParams,
    };

    return new Promise<unknown>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      const decoder = new BrokerFrameDecoder();
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        settle(() => reject(new DevelopmentBrokerError('BROKER_TIMEOUT', 'El broker no respondió a tiempo.')));
      }, this.timeoutMs);

      socket.once('connect', () => socket.write(encodeBrokerFrame(request)));
      socket.on('data', (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch (error) {
          socket.destroy();
          settle(() => reject(error));
          return;
        }
        const frame = frames[0];
        if (frame === undefined) return;
        const response = brokerResponseEnvelopeSchema.safeParse(frame);
        socket.end();
        if (!response.success || response.data.id !== id) {
          settle(() => reject(new DevelopmentBrokerError('BROKER_PROTOCOL_ERROR', 'Respuesta inválida del broker.')));
          return;
        }
        const responseData = response.data;
        if (responseData.ok === false) {
          const brokerError = responseData.error;
          settle(() => reject(new DevelopmentBrokerError(brokerError.code, brokerError.message)));
          return;
        }
        settle(() => resolve(responseData.result));
      });
      socket.once('error', () => {
        settle(() => reject(new DevelopmentBrokerError('FEATURE_UNAVAILABLE', 'El broker local no está disponible.')));
      });
      socket.once('close', () => {
        settle(() => reject(new DevelopmentBrokerError('BROKER_PROTOCOL_ERROR', 'El broker cerró la conexión sin responder.')));
      });
    });
  }
}
