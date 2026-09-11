import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/);
const relativePathSchema = z.string().min(1).max(4096)
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), 'se requiere una ruta relativa')
  .refine((value) => !value.split(/[\\/]/).includes('..'), 'no se permite traversal');
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const jobIdSchema = z.string().regex(/^job_[a-f0-9]{24}$/);
const webSessionIdSchema = z.string().regex(/^websession_[a-f0-9]{24}$/);
const webTabIdSchema = z.string().regex(/^webtab_[a-f0-9]{24}$/);
const webResourceRefSchema = z.string().regex(/^webresource_[a-f0-9]{20}$/);

const coverageSchema = z.object({
  status: z.enum(['supported', 'partial', 'unsupported', 'source_changed']),
  bytesRead: z.number().int().nonnegative(),
  uniqueBytesRead: z.number().int().nonnegative(),
  rangesRead: z.number().int().nonnegative().optional(),
  sourceBytes: z.number().int().nonnegative().optional(),
  pagesExamined: z.array(z.number().int().positive()).optional(),
  pagesDelivered: z.array(z.number().int().positive()).optional(),
  omissions: z.array(z.string().max(256)).optional(),
}).strict();

const progressSchema = z.object({
  stage: z.string().min(1).max(128),
  completed: z.number().nonnegative(),
  total: z.number().nonnegative().optional(),
  unit: z.enum(['bytes', 'pages', 'items']),
  coverage: coverageSchema.partial().optional(),
}).strict();

const jobSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: jobIdSchema,
  operationId: operationIdSchema,
  operationKind: z.enum([
    'artifact.inspect', 'artifact.hash', 'artifact.text.read', 'binary.inspect',
    'document.process', 'web.download.start',
  ]),
  workspaceId: workspaceIdSchema,
  sourcePath: relativePathSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  retentionUntil: z.iso.datetime(),
  state: z.enum([
    'queued', 'running', 'waiting_resource', 'cancel_requested', 'cancelled',
    'completed', 'failed', 'source_changed', 'interrupted',
  ]),
  stage: z.string().min(1).max(128),
  progress: progressSchema,
  attempt: z.number().int().positive(),
  effectState: z.enum(['not_started', 'applied', 'not_applied', 'uncertain']),
  resumeCapability: z.enum(['continue', 'restart', 'result_only', 'none']),
  coverage: coverageSchema,
  summary: z.record(z.string(), z.unknown()),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
}).strict();

const rawResultItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), value: z.unknown() }).strict(),
  z.object({ kind: z.literal('text'), text: z.string() }).strict(),
  z.object({
    kind: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg']),
    dataBase64: z.string(),
  }).strict(),
]);

const deliveredResultItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), value: z.unknown() }).strict(),
  z.object({ kind: z.literal('text'), text: z.string() }).strict(),
  z.object({
    kind: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg']),
    encodedBytes: z.number().int().positive(),
  }).strict(),
]);

const statusOutputSchema = z.object({
  job: jobSchema,
  items: z.array(deliveredResultItemSchema),
  resultsAvailable: z.boolean(),
  nextCursor: z.number().int().nonnegative().optional(),
}).strict();

function client(ctx: ToolContext) {
  if (ctx.developmentClient === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
  return ctx.developmentClient;
}

function mapBrokerError(error: unknown): unknown {
  if (!(error instanceof DevelopmentBrokerError)) return error;
  if ((ERROR_CODES as readonly string[]).includes(error.code)) {
    const causeCode = error.causeCode !== undefined && (ERROR_CODES as readonly string[]).includes(error.causeCode)
      ? error.causeCode as ErrorCode
      : undefined;
    return new LocalBridgeError(error.code as ErrorCode, causeCode === undefined ? undefined : { causeCode });
  }
  return new LocalBridgeError('INTERNAL_ERROR');
}

function audit(ctx: ToolContext, tool: string, riskLevel: string, workspaceId: string, resource?: string, operationId?: string) {
  return {
    dbPath: ctx.config.auditDbPath,
    tool,
    riskLevel,
    startedAt: Date.now(),
    workspaceId,
    ...(resource === undefined ? {} : { resource }),
    ...(operationId === undefined ? {} : { operationId }),
  };
}

async function requireRead(ctx: ToolContext, workspaceId: string): Promise<void> {
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
}

async function startJob(
  ctx: ToolContext,
  tool: string,
  workspaceId: string,
  sourcePath: string,
  operationId: string,
  operationKind: 'artifact.inspect' | 'artifact.hash' | 'artifact.text.read' | 'binary.inspect' | 'document.process' | 'web.download.start',
  parameters: Record<string, unknown>,
  riskLevel = 'R2',
) {
  const base = audit(ctx, tool, riskLevel, workspaceId, sourcePath, operationId);
  try {
    await requireRead(ctx, workspaceId);
    if (operationKind === 'web.download.start') {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
    }
    const job = jobSchema.parse(await client(ctx).call('analysis.start', {
      operationKind, workspaceId, sourcePath, operationId, parameters,
    }));
    return toolSuccess(job, { context: base, logger: ctx.logger });
  } catch (error) {
    return toolError(mapBrokerError(error), ctx.logger, { tool, workspaceId }, base);
  }
}

export const ANALYSIS_TOOL_COUNT = 9;

export function registerAnalysisTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('analysis.list', {
    title: 'List recoverable analysis jobs',
    description: 'Lists recent long-running jobs for an authorized workspace. Use it after reconnecting or changing chats before starting duplicate work. A queued or running job is progress, not a permission prompt.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    outputSchema: z.object({ jobs: z.array(jobSchema), nextCursor: z.number().int().nonnegative().optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, cursor, limit }) => {
    const base = audit(ctx, 'analysis.list', 'R1', workspaceId);
    try {
      await requireRead(ctx, workspaceId);
      const schema = z.object({ jobs: z.array(jobSchema), nextCursor: z.number().int().nonnegative().optional() }).strict();
      return toolSuccess(schema.parse(await client(ctx).call('analysis.list', { workspaceId, cursor, limit })), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'analysis.list', workspaceId }, base);
    }
  });

  server.registerTool('analysis.status', {
    title: 'Read analysis progress and results',
    description: 'Returns the current stage, measured coverage and a bounded page of results for one job. Poll this jobId instead of starting the same operation again. Completed means this operation finished; inspect coverage and omissions before claiming the broader task is complete.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: jobIdSchema, cursor: z.number().int().nonnegative().default(0), maxItems: z.number().int().min(1).max(10).default(4) }).strict(),
    outputSchema: statusOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, jobId, cursor, maxItems }) => {
    const base = audit(ctx, 'analysis.status', 'R1', workspaceId, jobId);
    try {
      await requireRead(ctx, workspaceId);
      const rawSchema = z.object({
        job: jobSchema,
        items: z.array(rawResultItemSchema),
        resultsAvailable: z.boolean(),
        nextCursor: z.number().int().nonnegative().optional(),
      }).strict();
      const raw = rawSchema.parse(await client(ctx).call('analysis.status', { workspaceId, jobId, cursor, maxItems }));
      const items = raw.items.map((item) => item.kind === 'image'
        ? { kind: 'image' as const, mimeType: item.mimeType, encodedBytes: Buffer.byteLength(item.dataBase64, 'base64') }
        : item);
      const metadata = statusOutputSchema.parse({ ...raw, items });
      const success = toolSuccess(metadata, { context: base, logger: ctx.logger });
      const resultContent: Array<
        { readonly type: 'text'; readonly text: string }
        | { readonly type: 'image'; readonly data: string; readonly mimeType: 'image/png' | 'image/jpeg' }
      > = [{ type: 'text', text: JSON.stringify({ ...metadata, items: metadata.items.filter((item) => item.kind === 'json') }) }];
      for (const item of raw.items) {
        if (item.kind === 'image') resultContent.push({ type: 'image', data: item.dataBase64, mimeType: item.mimeType });
        else if (item.kind === 'text') resultContent.push({ type: 'text', text: item.text });
      }
      return {
        ...success,
        content: resultContent,
      };
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'analysis.status', workspaceId, jobId }, base);
    }
  });

  server.registerTool('analysis.cancel', {
    title: 'Cancel one analysis job',
    description: 'Requests cancellation of one queued or running job. It does not stop browsers, terminals, servers or unrelated jobs.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: jobIdSchema }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async ({ workspaceId, jobId }) => {
    const base = audit(ctx, 'analysis.cancel', 'R3', workspaceId, jobId);
    try {
      await requireRead(ctx, workspaceId);
      return toolSuccess(jobSchema.parse(await client(ctx).call('analysis.cancel', { workspaceId, jobId })), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'analysis.cancel', workspaceId, jobId }, base);
    }
  });

  server.registerTool('artifact.inspect', {
    title: 'Inspect a large workspace artifact',
    description: 'Starts bounded signature and metadata inspection without materializing the whole source. Use this before choosing a text, document or binary adapter. Adaptive projects have no fixed source-size ceiling, while memory and output remain bounded.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema, operationId: operationIdSchema }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, ({ workspaceId, path, operationId }) => startJob(ctx, 'artifact.inspect', workspaceId, path, operationId, 'artifact.inspect', {}));

  server.registerTool('artifact.hash', {
    title: 'Hash a large workspace artifact',
    description: 'Starts an incremental SHA-256 pass over one authorized file. It reports byte progress and detects observable source changes; it never loads the complete file into one buffer.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema, operationId: operationIdSchema }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, ({ workspaceId, path, operationId }) => startJob(ctx, 'artifact.hash', workspaceId, path, operationId, 'artifact.hash', {}));

  server.registerTool('artifact.text.read', {
    title: 'Read a large text artifact incrementally',
    description: 'Starts a bounded UTF-8 text read and returns a signed continuation cursor in the completed result when more bytes remain. Reuse that cursor only with the same workspace file identity.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema, operationId: operationIdSchema, cursor: z.string().max(512).optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, ({ workspaceId, path, operationId, cursor, maxChars }) => startJob(ctx, 'artifact.text.read', workspaceId, path, operationId, 'artifact.text.read', {
    ...(cursor === undefined ? {} : { cursor }), maxChars,
  }));

  server.registerTool('binary.inspect', {
    title: 'Inspect a PE binary statically',
    description: 'Starts passive Portable Executable inspection for headers, mitigations, sections, imports, exports, signature presence and optional hashes. It never loads or executes the binary and never labels it safe solely from structure.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema, operationId: operationIdSchema, depth: z.enum(['quick', 'standard', 'deep']).default('standard') }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, ({ workspaceId, path, operationId, depth }) => startJob(ctx, 'binary.inspect', workspaceId, path, operationId, 'binary.inspect', { depth }));

  server.registerTool('document.process', {
    title: 'Process a large PDF as a durable job',
    description: 'Starts bounded PDF text extraction or visual page rendering through the existing passive document worker. Use render for scanned or visually important pages. Results and coverage are retrieved with analysis.status.',
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      operationId: operationIdSchema,
      request: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('read'), startPage: z.number().int().positive().optional(), endPage: z.number().int().positive().optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict(),
        z.object({ mode: z.literal('render'), pages: z.array(z.number().int().positive()).min(1).max(4), detail: z.enum(['standard', 'high']).default('standard') }).strict(),
      ]),
    }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, ({ workspaceId, path, operationId, request }) => startJob(ctx, 'document.process', workspaceId, path, operationId, 'document.process', request));

  server.registerTool('web.download.start', {
    title: 'Start a large observed web download',
    description: 'Starts an asynchronous download from an opaque resource observed in the current isolated web tab into a new relative workspace file. It accepts no URL and uses the same web profile and write authority as web.download.',
    inputSchema: z.object({
      sessionId: webSessionIdSchema,
      tabId: webTabIdSchema,
      resourceRef: webResourceRefSchema,
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      operationId: operationIdSchema,
    }).strict(),
    outputSchema: jobSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, ({ sessionId, tabId, resourceRef, workspaceId, path, operationId }) => startJob(
    ctx, 'web.download.start', workspaceId, path, operationId, 'web.download.start', { sessionId, tabId, resourceRef }, 'R4',
  ));
}
