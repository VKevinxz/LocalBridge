import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const workspaceId = z.string().min(1);
const sessionId = z.string().regex(/^session_[a-f0-9]{24}$/);
const operationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const reason = z.enum(['sign_in', 'file_selection', 'manual_step']);
const outputSchema = z.object({
  requestId: z.string().regex(/^humanreq_[a-f0-9]{24}$/),
  reason,
  state: z.enum(['waiting_for_human', 'human_control', 'ready', 'declined', 'expired', 'stopped']),
  expiresAt: z.iso.datetime().optional(),
  retryAfterMs: z.number().int().positive().optional(),
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

async function requireHumanControl(ctx: ToolContext, id: string): Promise<void> {
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, id, 'browserRead');
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, id, 'browserHumanControl');
}

export function registerBrowserHumanRequestTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.human.request', {
    title: 'Request exclusive human browser control',
    description: 'Pauses all agent browser access and informs the user that a local step is required. The reason is informational only. This tool never opens the window, accepts credentials, paths, files, URLs, selectors or free-form instructions. The user explicitly takes and returns control in LocalBridge. Poll browser.human.status after requesting. Requires browserRead and browserHumanControl.',
    inputSchema: z.object({ workspaceId, sessionId, reason, operationId }).strict(),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const audit = { dbPath: ctx.config.auditDbPath, tool: 'browser.human.request', riskLevel: 'R5', startedAt: Date.now(), workspaceId: input.workspaceId, resource: input.sessionId, operationId: input.operationId };
    try {
      await requireHumanControl(ctx, input.workspaceId);
      const result = await client(ctx).call('browser.human.request', input);
      return toolSuccess(outputSchema.parse(result), { context: audit, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.human.request', workspaceId: input.workspaceId, sessionId: input.sessionId }, audit);
    }
  });
}

export function registerBrowserHumanStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.human.status', {
    title: 'Check exclusive human-control status',
    description: 'Returns only the state and informational reason of a human-control request. It never exposes credentials, selected paths, file bytes, page contents or user input. While human control is pending or active, do not use other browser tools. Requires browserRead and browserHumanControl.',
    inputSchema: z.object({ workspaceId, sessionId }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const audit = { dbPath: ctx.config.auditDbPath, tool: 'browser.human.status', riskLevel: 'R2', startedAt: Date.now(), workspaceId: input.workspaceId, resource: input.sessionId };
    try {
      await requireHumanControl(ctx, input.workspaceId);
      const result = await client(ctx).call('browser.human.status', input);
      return toolSuccess(outputSchema.parse(result), { context: audit, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.human.status', workspaceId: input.workspaceId, sessionId: input.sessionId }, audit);
    }
  });
}
