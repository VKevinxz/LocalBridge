import { randomBytes } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';

import { ERROR_CODES, LocalBridgeError } from '@localbridge/shared';

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
    readonly causeCode?: string,
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
  readonly longRequestTimeoutMs?: number;
  readonly downloadRequestTimeoutMs?: number;
}

export interface RunningDevelopmentBroker {
  readonly endpoint: string;
  readonly token: string;
  close(): Promise<void>;
}

function safeCauseCode(value: string | undefined): string | undefined {
  return value !== undefined && (ERROR_CODES as readonly string[]).includes(value) ? value : undefined;
}

function safeBrokerError(error: unknown): { code: string; message: string; causeCode?: string } {
  if (error instanceof DevelopmentBrokerError && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
    const causeCode = safeCauseCode(error.causeCode);
    return { code: error.code, message: error.message.slice(0, 512), ...(causeCode === undefined ? {} : { causeCode }) };
  }
  if (error instanceof LocalBridgeError && (ERROR_CODES as readonly string[]).includes(error.code)) {
    const rawCause = error.details?.['causeCode'];
    const causeCode = typeof rawCause === 'string' ? safeCauseCode(rawCause) : undefined;
    return { code: error.code, message: error.message.slice(0, 512), ...(causeCode === undefined ? {} : { causeCode }) };
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
  const longRequestTimeoutMs = options.longRequestTimeoutMs ?? 75_000;
  const downloadRequestTimeoutMs = options.downloadRequestTimeoutMs ?? 630_000;
  const handshakeTimeoutMs = Math.max(requestTimeoutMs, longRequestTimeoutMs, downloadRequestTimeoutMs);

  const server: Server = net.createServer((socket) => {
    sockets.add(socket);
    // The method is inside the authenticated frame, so the server cannot choose
    // its real deadline until that frame has arrived. Starting with the largest
    // internal deadline prevents the ordinary timeout from racing a valid long
    // request before it can be parsed.
    socket.setTimeout(handshakeTimeoutMs, () => socket.destroy());
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
            const methodTimeoutMs = envelope.data.method === 'browser.motion.capture' || envelope.data.method === 'web.motion.capture'
              ? longRequestTimeoutMs
              : envelope.data.method === 'web.download' ? downloadRequestTimeoutMs : requestTimeoutMs;
            socket.setTimeout(methodTimeoutMs, () => socket.destroy());
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
  readonly longTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
}

export class DevelopmentBrokerClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(options: DevelopmentBrokerClientOptions) {
    this.endpoint = validateBrokerEndpoint(options.endpoint);
    if (!BROKER_TOKEN_PATTERN.test(options.token)) throw new Error('invalid broker token');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.longTimeoutMs = options.longTimeoutMs ?? 75_000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 630_000;
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

    const timeoutMs = method === 'browser.motion.capture' || method === 'web.motion.capture'
      ? this.longTimeoutMs
      : method === 'web.download' ? this.downloadTimeoutMs : this.timeoutMs;
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
      }, timeoutMs);

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
          settle(() => reject(new DevelopmentBrokerError(brokerError.code, brokerError.message, brokerError.causeCode)));
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
