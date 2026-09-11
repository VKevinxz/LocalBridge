import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const workspaceInput = { workspaceId: z.string().min(1) };
const processIdSchema = z.string().regex(/^process_[a-f0-9]{24}$/);
const listenerSchema = z.object({
  listenerRef: z.string().regex(/^listener_[a-f0-9]{24}$/),
  origin: z.string().regex(/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/),
  addressFamily: z.enum(['ipv4', 'ipv6']),
  bindScope: z.enum(['loopback', 'wildcard']),
  exclusive: z.boolean(),
  port: z.number().int().min(1).max(65_535),
  observedAt: z.iso.datetime(),
});
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional();
const processSummarySchema = z.object({
  processId: processIdSchema,
  profile: z.string(),
  state: z.enum(['running', 'exited', 'stopped', 'timed_out']),
  startedAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  exitCode: z.number().int().optional(),
});

function client(ctx: ToolContext) {
  if (ctx.developmentClient === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
  return ctx.developmentClient;
}

function mapBrokerError(error: unknown): unknown {
  if (!(error instanceof DevelopmentBrokerError)) return error;
  if ((ERROR_CODES as readonly string[]).includes(error.code)) return new LocalBridgeError(error.code as ErrorCode);
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

export function registerProcessStartTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('process.start', {
    title: 'Start an approved development process',
    description: 'Starts one process profile previously reviewed in LocalBridge, or returns the already-running compatible instance for that workspace and profile. Call process.list first after reconnecting. The model supplies no command, arguments, environment or working directory. Requires the processes capability.',
    inputSchema: z.object({ ...workspaceInput, profile: z.string().min(1).max(64), operationId: operationIdSchema }).strict(),
    outputSchema: processSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, profile, operationId }) => {
    const auditBase = audit(ctx, 'process.start', 'R4', workspaceId, profile, operationId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'processes');
      const result = await client(ctx).call('process.start', { workspaceId, profile, operationId });
      return toolSuccess(processSummarySchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'process.start', workspaceId, profile }, auditBase);
    }
  });
}

export function registerProcessListTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ processes: z.array(processSummarySchema) });
  server.registerTool('process.list', {
    title: 'List development processes',
    description: 'Lists LocalBridge-managed processes for one authorized workspace without exposing operating-system PIDs or commands. Requires the processes capability.',
    inputSchema: z.object(workspaceInput).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    const auditBase = audit(ctx, 'process.list', 'R2', workspaceId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'processes');
      const processes = await client(ctx).call('process.list', { workspaceId });
      return toolSuccess(outputSchema.parse({ processes }), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'process.list', workspaceId }, auditBase);
    }
  });
}

export function registerProcessListenersTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ process: processSummarySchema, listeners: z.array(listenerSchema).max(128) });
  server.registerTool('process.listeners', {
    title: 'List verified loopback listeners',
    description: 'Lists TCP listeners that Windows proves belong to one LocalBridge-managed process tree. Exact loopback listeners are directly adoptable; managed wildcard listeners are reported with an explicit warning and can only be used by a locally reviewed multiservice application. Stdout URLs and ports owned by other processes never create authority. Requires the processes capability.',
    inputSchema: z.object({ ...workspaceInput, processId: processIdSchema }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, processId }) => {
    const auditBase = audit(ctx, 'process.listeners', 'R2', workspaceId, processId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'processes');
      const result = await client(ctx).call('process.listeners', { workspaceId, processId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'process.listeners', workspaceId, processId }, auditBase);
    }
  });
}

export function registerProcessLogsTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({
    process: processSummarySchema,
    entries: z.array(z.object({ cursor: z.number().int().nonnegative(), stream: z.enum(['stdout', 'stderr']), text: z.string() })),
    nextCursor: z.number().int().nonnegative(),
    truncatedBeforeCursor: z.boolean(),
  });
  server.registerTool('process.logs', {
    title: 'Read bounded process logs',
    description: 'Reads a bounded cursor-based window of stdout/stderr from a LocalBridge-managed process. Requires the processes capability.',
    inputSchema: z.object({ ...workspaceInput, processId: processIdSchema, cursor: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(65_536).default(65_536) }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, processId, cursor, maxBytes }) => {
    const auditBase = audit(ctx, 'process.logs', 'R2', workspaceId, processId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'processes');
      const result = await client(ctx).call('process.logs', { workspaceId, processId, cursor, maxBytes });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'process.logs', workspaceId, processId }, auditBase);
    }
  });
}

export function registerProcessStopTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('process.stop', {
    title: 'Stop a managed development process',
    description: 'Stops one LocalBridge-managed process and its complete child tree. It cannot target arbitrary operating-system processes. Requires the processes capability.',
    inputSchema: z.object({ ...workspaceInput, processId: processIdSchema, operationId: operationIdSchema }).strict(),
    outputSchema: processSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, processId, operationId }) => {
    const auditBase = audit(ctx, 'process.stop', 'R3', workspaceId, processId, operationId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'processes');
      const result = await client(ctx).call('process.stop', { workspaceId, processId, operationId });
      return toolSuccess(processSummarySchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'process.stop', workspaceId, processId }, auditBase);
    }
  });
}
