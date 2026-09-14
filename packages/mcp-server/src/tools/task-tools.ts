import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError, TASK_BATCH_LIMITS, type TaskBatchRequest } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';
import { isPathDenied, resolveSafePath, resolveWriteTarget } from '@localbridge/workspace';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const batchIdSchema = z.string().regex(/^batch_[a-f0-9]{24}$/);
const localIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const relativePathSchema = z.string().min(1).max(4096)
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), 'se requiere una ruta relativa')
  .refine((value) => !value.split(/[\\/]/).includes('..'), 'no se permite traversal');
const profileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const dependencies = z.array(localIdSchema).max(TASK_BATCH_LIMITS.maxChildrenPerBatch).default([]);
const common = { localId: localIdSchema, dependsOn: dependencies } as const;
const childInputSchema = z.discriminatedUnion('operationKind', [
  z.object({ ...common, operationKind: z.literal('artifact.inspect'), sourcePath: relativePathSchema, parameters: z.object({}).strict() }).strict(),
  z.object({ ...common, operationKind: z.literal('artifact.hash'), sourcePath: relativePathSchema, parameters: z.object({}).strict() }).strict(),
  z.object({ ...common, operationKind: z.literal('artifact.text.read'), sourcePath: relativePathSchema,
    parameters: z.object({ cursor: z.string().max(512).optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict() }).strict(),
  z.object({ ...common, operationKind: z.literal('binary.inspect'), sourcePath: relativePathSchema,
    parameters: z.object({ depth: z.enum(['quick', 'standard', 'deep']).default('standard') }).strict() }).strict(),
  z.object({ ...common, operationKind: z.literal('document.process'), sourcePath: relativePathSchema,
    parameters: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('read'), startPage: z.number().int().positive().optional(), endPage: z.number().int().positive().optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict(),
      z.object({ mode: z.literal('render'), pages: z.array(z.number().int().positive()).min(1).max(4), detail: z.enum(['standard', 'high']).default('standard') }).strict(),
    ]) }).strict(),
  z.object({ ...common, operationKind: z.literal('web.download.start'), sourcePath: relativePathSchema,
    parameters: z.object({
      sessionId: z.string().regex(/^websession_[a-f0-9]{24}$/),
      tabId: z.string().regex(/^webtab_[a-f0-9]{24}$/),
      resourceRef: z.string().regex(/^webresource_[a-f0-9]{20}$/),
    }).strict() }).strict(),
  z.object({ ...common, operationKind: z.literal('validation.run'), parameters: z.object({ profile: profileSchema }).strict() }).strict(),
]);

const timingSchema = z.object({
  admissionMs: z.number().nonnegative(),
  dependencyWaitMs: z.number().nonnegative(),
  capacityWaitMs: z.number().nonnegative(),
  lockWaitMs: z.number().nonnegative(),
  lockHoldMs: z.number().nonnegative(),
  executionMs: z.number().nonnegative(),
  persistenceMs: z.number().nonnegative(),
  clientWaitMs: z.literal(0),
}).strict();
const childStateSchema = z.enum([
  'admitted', 'waiting_dependency', 'waiting_resource', 'running', 'cancel_requested',
  'cancelled', 'completed', 'failed', 'skipped_dependency', 'interrupted',
]);
const childOutputSchema = z.object({
  localId: localIdSchema,
  operationKind: z.enum([
    'artifact.inspect', 'artifact.hash', 'artifact.text.read', 'binary.inspect',
    'document.process', 'web.download.start', 'validation.run',
  ]),
  sourcePath: relativePathSchema.optional(),
  dependsOn: z.array(localIdSchema),
  state: childStateSchema,
  stage: z.string().min(1).max(128),
  effectState: z.enum(['not_started', 'applied', 'not_applied', 'uncertain']),
  coverage: z.enum(['unknown', 'supported', 'partial', 'unsupported', 'source_changed']),
  resource: z.object({
    resourceId: z.string().regex(/^taskresource_[a-f0-9]{24}$/),
    kind: z.enum(['workspace-source', 'workspace-destination', 'validation-profile']),
    ownership: z.enum(['reused', 'created']),
  }).strict(),
  timing: timingSchema,
  analysisJobId: z.string().regex(/^job_[a-f0-9]{24}$/).optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  resultAvailable: z.boolean(),
  resultExpired: z.boolean(),
  summary: z.record(z.string(), z.unknown()),
}).strict();
const countsSchema = z.object({
  admitted: z.number().int().nonnegative(),
  waiting_dependency: z.number().int().nonnegative(),
  waiting_resource: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  cancel_requested: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped_dependency: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
}).strict();
const batchOutputSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: batchIdSchema,
  workspaceId: workspaceIdSchema,
  operationId: operationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['queued', 'running', 'cancel_requested', 'cancelled', 'completed', 'partial', 'failed', 'interrupted']),
  revision: z.number().int().positive(),
  failurePolicy: z.enum(['continue', 'cancel_remaining']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  retentionUntil: z.iso.datetime(),
  deliveryMs: z.number().nonnegative(),
  counts: countsSchema,
  children: z.array(childOutputSchema).max(TASK_BATCH_LIMITS.maxChildrenPerBatch),
}).strict();
const validationResultSchema = z.object({
  profile: profileSchema,
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  timedOut: z.literal(false),
  reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const statusChildSchema = childOutputSchema.extend({ result: validationResultSchema.optional() }).strict();

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

async function preflight(ctx: ToolContext, request: z.infer<typeof childInputSchema>[], workspaceId: string): Promise<void> {
  const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
  for (const child of request) {
    if (child.operationKind === 'validation.run') {
      const validationWorkspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'validations');
      if (validationWorkspace.validationProfiles[child.parameters.profile] === undefined) {
        throw new LocalBridgeError('COMMAND_NOT_ALLOWED');
      }
      continue;
    }
    if (isPathDenied(child.sourcePath, workspace.denyPatterns)) throw new LocalBridgeError('PATH_DENIED');
    if (child.operationKind === 'web.download.start') {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
      const destination = await resolveWriteTarget(workspace.rootPath, child.sourcePath, { createParentDirs: false });
      if (destination.exists) throw new LocalBridgeError('FILE_ALREADY_EXISTS');
      continue;
    }
    const source = await resolveSafePath(workspace.rootPath, child.sourcePath);
    if (!source.exists) throw new LocalBridgeError('FILE_NOT_FOUND');
  }
}

export const TASK_TOOL_COUNT = 5;

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('task.runMany', {
    title: 'Start several authorized tasks together',
    description: 'Admits a bounded group of existing artifact, document, download and reviewed validation operations for one workspace. Independent children can overlap within the current limits; dependencies stay ordered. This tool does not add permissions, commands, source-size limits, browser sessions or approval rounds. Reuse the returned batchId across chats.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, operationId: operationIdSchema,
      children: z.array(childInputSchema).min(1).max(TASK_BATCH_LIMITS.maxChildrenPerBatch),
      failurePolicy: z.enum(['continue', 'cancel_remaining']).default('continue') }).strict(),
    outputSchema: batchOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ workspaceId, operationId, children, failurePolicy }) => {
    const base = audit(ctx, 'task.runMany', 'R4', workspaceId, undefined, operationId);
    try {
      await preflight(ctx, children, workspaceId);
      const request: TaskBatchRequest = { workspaceId, operationId, children, failurePolicy };
      return toolSuccess(batchOutputSchema.parse(await client(ctx).call('task.runMany', request)), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'task.runMany', workspaceId }, base);
    }
  });

  server.registerTool('task.list', {
    title: 'List recoverable task batches',
    description: 'Lists recent task batches for the authorized workspace. Use it after reconnecting or changing chats before starting duplicate work.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    outputSchema: z.object({ batches: z.array(batchOutputSchema), nextCursor: z.number().int().nonnegative().optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, cursor, limit }) => {
    const base = audit(ctx, 'task.list', 'R1', workspaceId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
      const schema = z.object({ batches: z.array(batchOutputSchema), nextCursor: z.number().int().nonnegative().optional() }).strict();
      return toolSuccess(schema.parse(await client(ctx).call('task.list', { workspaceId, cursor, limit })), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'task.list', workspaceId }, base);
    }
  });

  server.registerTool('task.statusMany', {
    title: 'Read task batch progress',
    description: 'Returns bounded child progress, timing, effect and evidence coverage. Analysis results stay behind their existing analysisJobId; validation output is returned only while retained. A finished child is not proof that the broader user objective is complete.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, batchId: batchIdSchema,
      localIds: z.array(localIdSchema).min(1).max(24).optional(), cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(TASK_BATCH_LIMITS.maxStatusChildren).default(TASK_BATCH_LIMITS.maxStatusChildren) }).strict(),
    outputSchema: z.object({ batch: batchOutputSchema, children: z.array(statusChildSchema), nextCursor: z.number().int().nonnegative().optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, batchId, localIds, cursor, limit }) => {
    const base = audit(ctx, 'task.statusMany', 'R1', workspaceId, batchId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
      const schema = z.object({ batch: batchOutputSchema, children: z.array(statusChildSchema), nextCursor: z.number().int().nonnegative().optional() }).strict();
      return toolSuccess(schema.parse(await client(ctx).call('task.statusMany', { workspaceId, batchId, localIds, cursor, limit })), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'task.statusMany', workspaceId }, base);
    }
  });

  server.registerTool('task.waitMany', {
    title: 'Wait for task batch progress',
    description: 'Waits for a newer batch revision or for all children to finish, up to 20 seconds. The response separates this client wait from LocalBridge capacity wait. It never restarts or cancels children.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, batchId: batchIdSchema,
      afterRevision: z.number().int().nonnegative(), condition: z.enum(['changed', 'all_finished']).default('changed'),
      waitMs: z.number().int().min(0).max(TASK_BATCH_LIMITS.maxWaitMs).default(10_000) }).strict(),
    outputSchema: z.object({ batch: batchOutputSchema, deadlineReached: z.boolean(), clientWaitMs: z.number().nonnegative() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, batchId, afterRevision, condition, waitMs }) => {
    const base = audit(ctx, 'task.waitMany', 'R1', workspaceId, batchId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
      const schema = z.object({ batch: batchOutputSchema, deadlineReached: z.boolean(), clientWaitMs: z.number().nonnegative() }).strict();
      return toolSuccess(schema.parse(await client(ctx).call('task.waitMany', { workspaceId, batchId, afterRevision, condition, waitMs })), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'task.waitMany', workspaceId }, base);
    }
  });

  server.registerTool('task.cancelMany', {
    title: 'Cancel selected task children',
    description: 'Requests cancellation for selected children or the whole batch. It preserves applied results and never stops reused browsers, terminals or servers. The returned state may remain cancel_requested until the owned operation has actually stopped.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, batchId: batchIdSchema,
      localIds: z.array(localIdSchema).min(1).max(24).optional(), operationId: operationIdSchema }).strict(),
    outputSchema: batchOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async ({ workspaceId, batchId, localIds, operationId }) => {
    const base = audit(ctx, 'task.cancelMany', 'R3', workspaceId, batchId, operationId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
      return toolSuccess(batchOutputSchema.parse(await client(ctx).call('task.cancelMany', { workspaceId, batchId, localIds, operationId })), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'task.cancelMany', workspaceId }, base);
    }
  });
}
