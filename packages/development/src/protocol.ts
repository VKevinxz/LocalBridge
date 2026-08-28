import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export const DEVELOPMENT_BROKER_PROTOCOL = 9 as const;
export const MAX_BROKER_FRAME_BYTES = 4 * 1024 * 1024;
export const BROKER_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const BROKER_ID_PATTERN = /^[a-f0-9]{32}$/;

const opaqueIdSchema = z.string().regex(/^[a-z]+_[a-f0-9]{16,32}$/);
const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/);
const profileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{16,32}$/);
const operationIdSchema = z.string().min(1).max(128).optional();
const cursorSchema = z.number().int().nonnegative().default(0);
const humanReasonSchema = z.enum(['sign_in', 'file_selection', 'manual_step']);
const projectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const terminalIdSchema = z.string().regex(/^terminal_[a-f0-9]{24}$/);
const terminalListenerSchema = z.object({
  terminalSessionId: terminalIdSchema,
  listenerRef: opaqueIdSchema,
}).strict();

const workspaceParams = z.object({ workspaceId: workspaceIdSchema }).strict();
const processIdParams = workspaceParams.extend({ processId: opaqueIdSchema }).strict();
const sessionIdParams = workspaceParams.extend({ sessionId: opaqueIdSchema }).strict();
const browserStartParams = z.union([
  workspaceParams.extend({ profile: profileNameSchema, operationId: operationIdSchema }).strict(),
  processIdParams.extend({ listenerRef: opaqueIdSchema, operationId: operationIdSchema }).strict(),
  workspaceParams.extend({
    application: profileNameSchema,
    listeners: z.array(z.object({
      service: profileNameSchema,
      processId: opaqueIdSchema,
      listenerRef: opaqueIdSchema,
    }).strict()).min(1).max(8),
    operationId: operationIdSchema,
  }).strict(),
  workspaceParams.extend({
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    operationId: operationIdSchema,
  }).strict(),
  workspaceParams.extend({
    projectId: projectIdSchema,
    terminalSessionId: terminalIdSchema,
    listenerRef: opaqueIdSchema,
    relatedListeners: z.array(terminalListenerSchema).min(1).max(7).optional(),
    operationId: operationIdSchema,
  }).strict(),
]);

export const brokerMethodSchemas = {
  'broker.ping': z.object({}).strict(),
  'project.list': z.object({}).strict(),
  'project.setup.status': z.object({ projectId: projectIdSchema }).strict(),
  'project.setup.refresh': z.object({ projectId: projectIdSchema }).strict(),
  'terminal.start': z.object({ projectId: projectIdSchema, operationId: operationIdSchema }).strict(),
  'terminal.write': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema, text: z.string().min(1).max(65_536), operationId: operationIdSchema }).strict(),
  'terminal.read': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema, cursor: cursorSchema, maxBytes: z.number().int().min(1).max(65_536).default(65_536) }).strict(),
  'terminal.status': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema }).strict(),
  'terminal.stop': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema, operationId: operationIdSchema }).strict(),
  'application.start': z.object({ applicationId: applicationIdSchema, operationId: operationIdSchema }).strict(),
  'application.status': z.object({ runId: runIdSchema }).strict(),
  'application.stop': z.object({ runId: runIdSchema, operationId: operationIdSchema }).strict(),
  'process.start': workspaceParams.extend({ profile: profileNameSchema, operationId: operationIdSchema }).strict(),
  'process.list': workspaceParams,
  'process.listeners': processIdParams,
  'process.logs': processIdParams.extend({ cursor: cursorSchema, maxBytes: z.number().int().min(1).max(65_536).default(65_536) }).strict(),
  'process.stop': processIdParams.extend({ operationId: operationIdSchema }).strict(),
  'browser.start': browserStartParams,
  'browser.list': workspaceParams,
  'browser.navigate': sessionIdParams.extend({ path: z.string().min(1).max(2048), operationId: operationIdSchema }).strict(),
  'browser.snapshot': sessionIdParams.extend({ maxDepth: z.number().int().min(1).max(20).default(12), maxElements: z.number().int().min(1).max(1000).default(500) }).strict(),
  'browser.screenshot': sessionIdParams,
  // Emulación de viewport para probar diseño responsive (ADR-0042). Dimensiones
  // acotadas; no acepta escala, agente de usuario, URL ni selectores.
  'browser.viewport': sessionIdParams.extend({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(320).max(2160),
    mobile: z.boolean().default(false),
    operationId: operationIdSchema,
  }).strict(),
  'browser.events': sessionIdParams.extend({ cursor: cursorSchema, maxBytes: z.number().int().min(1).max(65_536).default(65_536) }).strict(),
  'browser.click': sessionIdParams.extend({ snapshotId: opaqueIdSchema, elementRef: opaqueIdSchema, operationId: operationIdSchema }).strict(),
  'browser.fill': sessionIdParams.extend({ snapshotId: opaqueIdSchema, elementRef: opaqueIdSchema, text: z.string().max(8192), operationId: operationIdSchema }).strict(),
  'browser.press': sessionIdParams.extend({ snapshotId: opaqueIdSchema, elementRef: opaqueIdSchema, key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']), operationId: operationIdSchema }).strict(),
  'browser.human.request': sessionIdParams.extend({ reason: humanReasonSchema, operationId: z.string().min(1).max(128) }).strict(),
  'browser.human.status': sessionIdParams,
  'browser.stop': sessionIdParams.extend({ operationId: operationIdSchema }).strict(),
} as const;

export type BrokerMethod = keyof typeof brokerMethodSchemas;

export const brokerRequestEnvelopeSchema = z
  .object({
    version: z.literal(DEVELOPMENT_BROKER_PROTOCOL),
    id: z.string().regex(BROKER_ID_PATTERN),
    token: z.string().regex(BROKER_TOKEN_PATTERN),
    method: z.enum(Object.keys(brokerMethodSchemas) as [BrokerMethod, ...BrokerMethod[]]),
    params: z.unknown(),
  })
  .strict();

export const brokerSuccessEnvelopeSchema = z
  .object({
    version: z.literal(DEVELOPMENT_BROKER_PROTOCOL),
    id: z.string().regex(BROKER_ID_PATTERN),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const brokerFailureEnvelopeSchema = z
  .object({
    version: z.literal(DEVELOPMENT_BROKER_PROTOCOL),
    id: z.string().regex(BROKER_ID_PATTERN),
    ok: z.literal(false),
    error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), message: z.string().max(512) }).strict(),
  })
  .strict();

export const brokerResponseEnvelopeSchema = z.union([brokerSuccessEnvelopeSchema, brokerFailureEnvelopeSchema]);
export type BrokerRequestEnvelope = z.infer<typeof brokerRequestEnvelopeSchema>;
export type BrokerResponseEnvelope = z.infer<typeof brokerResponseEnvelopeSchema>;

export function parseBrokerParams<M extends BrokerMethod>(method: M, params: unknown): z.infer<(typeof brokerMethodSchemas)[M]> {
  return brokerMethodSchemas[method].parse(params) as z.infer<(typeof brokerMethodSchemas)[M]>;
}

export function brokerTokenMatches(expected: string, actual: string): boolean {
  if (!BROKER_TOKEN_PATTERN.test(expected) || !BROKER_TOKEN_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function createBrokerEndpoint(id: string, platform: NodeJS.Platform = process.platform): string {
  if (!BROKER_ID_PATTERN.test(id)) throw new Error('invalid broker endpoint id');
  return platform === 'win32'
    ? `\\\\.\\pipe\\LOCAL\\localbridge-development-${id}`
    : path.join(os.tmpdir(), `localbridge-development-${id}.sock`);
}

export function validateBrokerEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): string {
  const valid = platform === 'win32'
    ? /^\\\\\.\\pipe\\LOCAL\\localbridge-development-[a-f0-9]{32}$/.test(endpoint)
    : endpoint.startsWith(`${os.tmpdir()}${path.sep}localbridge-development-`) && endpoint.endsWith('.sock');
  if (!valid) throw new Error('invalid broker endpoint');
  return endpoint;
}

export function encodeBrokerFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_BROKER_FRAME_BYTES) throw new Error('broker frame exceeds limit');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class BrokerFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    if (this.buffered.length + chunk.length > MAX_BROKER_FRAME_BYTES + 4) {
      throw new Error('broker frame buffer exceeds limit');
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const values: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_BROKER_FRAME_BYTES) throw new Error('broker frame exceeds limit');
      if (this.buffered.length < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      values.push(JSON.parse(payload.toString('utf8')) as unknown);
    }
    return values;
  }
}
