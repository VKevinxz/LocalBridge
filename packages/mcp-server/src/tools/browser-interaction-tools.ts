import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const baseInput = {
  workspaceId: z.string().min(1),
  sessionId: z.string().regex(/^session_[a-f0-9]{24}$/),
  snapshotId: z.string().regex(/^snapshot_[a-f0-9]{20}$/),
  elementRef: z.string().regex(/^element_[a-f0-9]{20}$/),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
};
const outputSchema = z.object({
  sessionId: z.string().regex(/^session_[a-f0-9]{24}$/),
  applied: z.literal(true),
  snapshotInvalidated: z.literal(true),
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

async function requireInteraction(ctx: ToolContext, workspaceId: string): Promise<void> {
  // Las dos comprobaciones son deliberadas: browserInteract nunca implica
  // browserRead por inferencia aunque el schema local exija la dependencia.
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'browserRead');
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'browserInteract');
}

function audit(ctx: ToolContext, tool: string, workspaceId: string, elementRef: string, operationId?: string) {
  return {
    dbPath: ctx.config.auditDbPath,
    tool,
    riskLevel: 'R4',
    startedAt: Date.now(),
    workspaceId,
    resource: elementRef,
    ...(operationId === undefined ? {} : { operationId }),
  };
}

export function registerBrowserClickTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.click', {
    title: 'Click an element from the current snapshot',
    description: 'Clicks only an opaque element reference issued by the current accessibility snapshot. CSS/XPath selectors and coordinates are not accepted. The snapshot is invalidated after the action. Requires browserRead and browserInteract.',
    inputSchema: z.object(baseInput),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, operationId }) => {
    const auditBase = audit(ctx, 'browser.click', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.click', { workspaceId, sessionId, snapshotId, elementRef, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.click', workspaceId, sessionId, elementRef }, auditBase);
    }
  });
}

export function registerBrowserFillTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.fill', {
    title: 'Fill a non-sensitive field from the current snapshot',
    description: 'Replaces text in an approved non-sensitive field referenced by the current snapshot. Password, file, hidden, token, payment and one-time-code fields are rejected. Text is never recorded in LocalBridge audit logs. Requires browserRead and browserInteract.',
    inputSchema: z.object({ ...baseInput, text: z.string().max(8192) }),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, text, operationId }) => {
    const auditBase = audit(ctx, 'browser.fill', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.fill', { workspaceId, sessionId, snapshotId, elementRef, text, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.fill', workspaceId, sessionId, elementRef }, auditBase);
    }
  });
}

export function registerBrowserPressTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.press', {
    title: 'Press an allowed key on a snapshot element',
    description: 'Focuses an opaque snapshot element and presses one key from a fixed allowlist. Arbitrary key sequences and shortcuts are not accepted. Requires browserRead and browserInteract.',
    inputSchema: z.object({ ...baseInput, key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, key, operationId }) => {
    const auditBase = audit(ctx, 'browser.press', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.press', { workspaceId, sessionId, snapshotId, elementRef, key, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.press', workspaceId, sessionId, elementRef }, auditBase);
    }
  });
}
