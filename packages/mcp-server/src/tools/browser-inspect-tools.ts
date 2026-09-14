import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { BROWSER_INSPECTABLE_CSS_PROPERTIES, DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/);
const browserSessionIdSchema = z.string().regex(/^session_[a-f0-9]{24}$/);
const webSessionIdSchema = z.string().regex(/^websession_[a-f0-9]{24}$/);
const webTabIdSchema = z.string().regex(/^webtab_[a-f0-9]{24}$/);
const browserSnapshotIdSchema = z.string().regex(/^snapshot_[a-f0-9]{20}$/);
const browserElementRefSchema = z.string().regex(/^element_[a-f0-9]{20}$/);
const webSnapshotIdSchema = z.string().regex(/^websnapshot_[a-f0-9]{20}$/);
const webElementRefSchema = z.string().regex(/^webelement_[a-f0-9]{20}$/);
const cssPropertiesSchema = z.array(z.enum(BROWSER_INSPECTABLE_CSS_PROPERTIES)).max(32)
  .default(['color', 'background-color', 'font-family', 'font-size', 'font-weight']);
const cssVariablesSchema = z.array(z.string().regex(/^--[A-Za-z0-9_-]{1,126}$/)).max(16).default([]);
const inspectionOutputFields = {
  target: z.enum(['element', 'active']),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict(),
  styles: z.record(z.string(), z.string().max(512)),
  variables: z.record(z.string(), z.string().max(512)),
  state: z.object({
    attached: z.boolean(), visible: z.boolean(), enabled: z.boolean(), focusable: z.boolean(), active: z.boolean(),
    role: z.string().max(64), name: z.string().max(256),
  }).strict(),
} as const;

function mapBrokerError(error: unknown): unknown {
  if (!(error instanceof DevelopmentBrokerError)) return error;
  return (ERROR_CODES as readonly string[]).includes(error.code)
    ? new LocalBridgeError(error.code as ErrorCode)
    : new LocalBridgeError('INTERNAL_ERROR');
}

function audit(ctx: ToolContext, tool: string, workspaceId: string | undefined, resource: string) {
  return { dbPath: ctx.config.auditDbPath, tool, riskLevel: 'R2', startedAt: Date.now(),
    ...(workspaceId === undefined ? {} : { workspaceId }), resource };
}

export function registerBrowserInspectTool(server: McpServer, ctx: ToolContext): void {
  const inputSchema = z.object({
    workspaceId: workspaceIdSchema, sessionId: browserSessionIdSchema,
    target: z.enum(['element', 'active']).default('element'), snapshotId: browserSnapshotIdSchema.optional(),
    elementRef: browserElementRefSchema.optional(), cssProperties: cssPropertiesSchema, cssVariables: cssVariablesSchema,
  }).strict().superRefine((value, issue) => {
    if (value.target === 'element' && (value.snapshotId === undefined || value.elementRef === undefined)) {
      issue.addIssue({ code: 'custom', message: 'snapshotId and elementRef are required for target element' });
    }
  });
  const outputSchema = z.object({ sessionId: browserSessionIdSchema, ...inspectionOutputFields }).strict();
  server.registerTool('browser.inspect', {
    title: 'Inspect bounded computed styles for a browser element',
    description: 'Reads geometry, accessible state, selected computed CSS properties and named CSS variables from an opaque current element reference or the active element. It accepts no selector or JavaScript, does not move focus, and never reads field values. Requires browserRead.',
    inputSchema, outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const base = audit(ctx, 'browser.inspect', input.workspaceId, input.sessionId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, input.workspaceId, 'browserRead');
      if (ctx.developmentClient === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
      const result = outputSchema.parse(await ctx.developmentClient.call('browser.inspect', input));
      return toolSuccess(result, { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.inspect', workspaceId: input.workspaceId, sessionId: input.sessionId }, base);
    }
  });
}

export function registerWebInspectTool(server: McpServer, ctx: ToolContext): void {
  const inputSchema = z.object({
    sessionId: webSessionIdSchema, tabId: webTabIdSchema,
    target: z.enum(['element', 'active']).default('element'), snapshotId: webSnapshotIdSchema.optional(),
    elementRef: webElementRefSchema.optional(), cssProperties: cssPropertiesSchema, cssVariables: cssVariablesSchema,
  }).strict().superRefine((value, issue) => {
    if (value.target === 'element' && (value.snapshotId === undefined || value.elementRef === undefined)) {
      issue.addIssue({ code: 'custom', message: 'snapshotId and elementRef are required for target element' });
    }
  });
  const outputSchema = z.object({ sessionId: webSessionIdSchema, tabId: webTabIdSchema, ...inspectionOutputFields }).strict();
  server.registerTool('web.inspect', {
    title: 'Inspect bounded computed styles for a web element',
    description: 'Reads geometry, accessible state, selected computed CSS properties and named CSS variables from an opaque element reference or the active element in an authorized public web tab. It accepts no selector or JavaScript and never reads field values.',
    inputSchema, outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    const base = audit(ctx, 'web.inspect', undefined, `${input.sessionId}:${input.tabId}`);
    try {
      if (ctx.developmentClient === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
      const result = outputSchema.parse(await ctx.developmentClient.call('web.inspect', input));
      return toolSuccess(result, { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'web.inspect', sessionId: input.sessionId, tabId: input.tabId }, base);
    }
  });
}
