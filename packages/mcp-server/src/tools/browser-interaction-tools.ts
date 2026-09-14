import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { BROWSER_KEY_ALLOWLIST, DevelopmentBrokerError } from '@localbridge/development';
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
const keyboardSequenceOutputSchema = z.object({
  sessionId: baseInput.sessionId,
  requestedKeys: z.number().int().min(1).max(16),
  keysSent: z.number().int().min(0).max(16),
  actionState: z.enum(['complete', 'partial', 'uncertain']),
  snapshotInvalidated: z.boolean(),
  stoppedReason: z.enum(['sensitive_focus', 'document_changed', 'target_unavailable', 'dispatch_failed']).optional(),
}).strict();
const actionCaptureWaitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delay'), settleMs: z.number().int().min(0).max(5_000).default(300) }).strict(),
  z.object({ kind: z.literal('stable'), intervalMs: z.number().int().min(100).max(2_000).default(300),
    tolerancePx: z.number().min(0).max(5).default(0.5), timeoutMs: z.number().int().min(100).max(5_000).default(2_000),
    allowUnstable: z.boolean().default(false) }).strict(),
]);
const actionCaptureMetadataSchema = z.object({
  sessionId: baseInput.sessionId,
  actionState: z.enum(['complete', 'uncertain']),
  captureState: z.enum(['complete', 'unstable', 'failed', 'skipped']),
  waitedMs: z.number().int().nonnegative(),
  snapshotInvalidated: z.boolean(),
  failureCode: z.string().max(64).optional(),
  mimeType: z.enum(['image/png', 'image/jpeg']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fallbackUsed: z.boolean().optional(),
  receipt: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), created: z.literal(true) }).strict().optional(),
}).strict();
const actionCaptureBrokerSchema = actionCaptureMetadataSchema.extend({ dataBase64: z.string().optional() }).strict();
const assertionConditionSchemas = [
  z.object({ kind: z.literal('path'), value: z.string().min(1).max(2048), operator: z.enum(['equals', 'contains']).default('equals') }).strict(),
  z.object({ kind: z.literal('title'), value: z.string().min(1).max(256), operator: z.enum(['equals', 'contains']).default('equals') }).strict(),
  z.object({ kind: z.literal('text'), value: z.string().min(1).max(512), state: z.enum(['present', 'absent']).default('present') }).strict(),
  z.object({ kind: z.literal('element'), snapshotId: baseInput.snapshotId, elementRef: baseInput.elementRef, state: z.enum(['attached', 'visible', 'enabled', 'checked', 'selected']), expected: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('response'), path: z.string().min(1).max(2048).regex(/^\/(?!\/)/), status: z.number().int().min(100).max(599).optional(), afterCursor: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ kind: z.literal('no-console-errors'), afterCursor: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ kind: z.literal('dialog'), state: z.enum(['open', 'closed']) }).strict(),
] as const;
const assertionConditionSchema = z.discriminatedUnion('kind', assertionConditionSchemas);
const waitConditionSchema = z.discriminatedUnion('kind', [
  ...assertionConditionSchemas,
  z.object({ kind: z.literal('stable'), snapshotId: baseInput.snapshotId, elementRef: baseInput.elementRef,
    intervalMs: z.number().int().min(100).max(2_000).default(300), tolerancePx: z.number().min(0).max(5).default(0.5) }).strict(),
]);
const conditionOutputSchema = z.object({
  sessionId: baseInput.sessionId,
  satisfied: z.literal(true),
  conditionKind: z.enum(['path', 'title', 'text', 'element', 'response', 'no-console-errors', 'dialog', 'stable']),
  waitedMs: z.number().int().nonnegative().optional(),
}).strict();

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

async function requireRead(ctx: ToolContext, workspaceId: string): Promise<void> {
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'browserRead');
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
    inputSchema: z.object(baseInput).strict(),
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
    inputSchema: z.object({ ...baseInput, text: z.string().max(8192) }).strict(),
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
    inputSchema: z.object({ ...baseInput, key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }).strict(),
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

export function registerBrowserKeyboardSequenceTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.keyboard.sequence', {
    title: 'Press a bounded sequence while preserving page focus',
    description: 'Focuses one current opaque element once, then sends up to 16 allowed navigation keys while revalidating authority, document and the active field before every next key. It stops before typing into a sensitive field and reports partial or uncertain effects without replaying the sequence. Requires browserRead and browserInteract.',
    inputSchema: z.object({
      ...baseInput,
      keys: z.array(z.enum(BROWSER_KEY_ALLOWLIST)).min(1).max(16),
      operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    }).strict(),
    outputSchema: keyboardSequenceOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, keys, operationId }) => {
    const auditBase = audit(ctx, 'browser.keyboard.sequence', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.keyboard.sequence', { workspaceId, sessionId, snapshotId, elementRef, keys, operationId });
      return toolSuccess(keyboardSequenceOutputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.keyboard.sequence', workspaceId, sessionId, elementRef }, auditBase);
    }
  });
}

export function registerBrowserActionCaptureTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.action.capture', {
    title: 'Apply one browser action and capture its visual result',
    description: 'Applies one bounded click, hover or allowed key, waits by a bounded delay or target stability policy, and captures evidence inside the desktop controller. A saved destination is preflighted before the effect and never overwritten. The result separates action and capture state so a failed save never causes an automatic repeated click. Requires browserRead and browserInteract; saving also requires write.',
    inputSchema: z.object({
      ...baseInput,
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('click') }).strict(),
        z.object({ kind: z.literal('hover') }).strict(),
        z.object({ kind: z.literal('key'), key: z.enum(BROWSER_KEY_ALLOWLIST) }).strict(),
      ]),
      wait: actionCaptureWaitSchema,
      output: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('inline') }).strict(),
        z.object({ kind: z.literal('save'), workspaceId: baseInput.workspaceId,
          path: z.string().min(1).max(4096).refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), 'use a relative path').refine((value) => value.toLowerCase().endsWith('.png'), 'use a .png path') }).strict(),
      ]),
      operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    }).strict().superRefine((value, issue) => {
      if (value.output.kind === 'save' && value.output.workspaceId !== value.workspaceId) issue.addIssue({ code: 'custom', path: ['output', 'workspaceId'], message: 'use the browser session workspace' });
    }),
    outputSchema: actionCaptureMetadataSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, action, wait, output, operationId }) => {
    const auditBase = audit(ctx, 'browser.action.capture', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      if (output.kind === 'save') await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
      const brokerResult = actionCaptureBrokerSchema.parse(await client(ctx).call('browser.action.capture', {
        workspaceId, sessionId, snapshotId, elementRef, action, wait, output, operationId,
      }));
      const metadata = actionCaptureMetadataSchema.parse(brokerResult);
      const success = toolSuccess(metadata, { context: auditBase, logger: ctx.logger });
      return brokerResult.dataBase64 === undefined || brokerResult.mimeType === undefined
        ? success
        : { ...success, content: [{ type: 'image' as const, data: brokerResult.dataBase64, mimeType: brokerResult.mimeType }, { type: 'text' as const, text: JSON.stringify(metadata) }] };
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.action.capture', workspaceId, sessionId, elementRef }, auditBase);
    }
  });
}

export function registerBrowserAssertTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.assert', {
    title: 'Assert a typed browser condition',
    description: 'Checks a bounded path, title, accessible text, opaque element state, observed response, console-error absence or dialog state. It never accepts JavaScript or selectors. Requires browserRead.',
    inputSchema: z.object({ workspaceId: baseInput.workspaceId, sessionId: baseInput.sessionId, condition: assertionConditionSchema }).strict(),
    outputSchema: conditionOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, condition }) => {
    const auditBase = audit(ctx, 'browser.assert', workspaceId, sessionId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.assert', { workspaceId, sessionId, condition });
      return toolSuccess(conditionOutputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.assert', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserWaitTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.wait', {
    title: 'Wait for a typed browser condition',
    description: 'Waits up to 30 seconds for one bounded typed condition: path, title, text, element state, response after a chosen event cursor, absence of console errors after a chosen cursor, dialog state, or stability of one referenced element. Element stability samples its geometry and relevant transition state for the requested interval; it does not wait for global network silence, HMR, unrelated infinite animations or absolute visual stillness. It never accepts JavaScript or selectors and returns TIMEOUT when unmet. Keep the 5 second default unless the condition is known to be immediate; a 1 second wait is usually too short for a page transition. Requires browserRead.',
    inputSchema: z.object({ workspaceId: baseInput.workspaceId, sessionId: baseInput.sessionId, condition: waitConditionSchema, timeoutMs: z.number().int().min(100).max(30_000).default(5_000) }).strict(),
    outputSchema: conditionOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, condition, timeoutMs }) => {
    const auditBase = audit(ctx, 'browser.wait', workspaceId, sessionId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.wait', { workspaceId, sessionId, condition, timeoutMs });
      return toolSuccess(conditionOutputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.wait', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserHoverTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.hover', {
    title: 'Hover a visible snapshot element',
    description: 'Moves the pointer to the visible center of an opaque element reference after hit testing. Requires browserRead and browserInteract.',
    inputSchema: z.object(baseInput).strict(), outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, operationId }) => {
    const auditBase = audit(ctx, 'browser.hover', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.hover', { workspaceId, sessionId, snapshotId, elementRef, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) { return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.hover', workspaceId, sessionId, elementRef }, auditBase); }
  });
}

export function registerBrowserScrollTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.scroll', {
    title: 'Scroll the current browser viewport',
    description: 'Scrolls the current document by a bounded amount in one direction. It accepts no coordinates or JavaScript. Requires browserRead and browserInteract.',
    inputSchema: z.object({ workspaceId: baseInput.workspaceId, sessionId: baseInput.sessionId, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(5000), operationId: baseInput.operationId }).strict(), outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, direction, amount, operationId }) => {
    const auditBase = audit(ctx, 'browser.scroll', workspaceId, sessionId, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.scroll', { workspaceId, sessionId, direction, amount, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) { return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.scroll', workspaceId, sessionId }, auditBase); }
  });
}

export function registerBrowserSelectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.select', {
    title: 'Choose an option from a snapshot select',
    description: 'Chooses one bounded value in an opaque select reference and dispatches input/change. Selectors and JavaScript are not accepted. Requires browserRead and browserInteract.',
    inputSchema: z.object({ ...baseInput, value: z.string().max(1024) }).strict(), outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, value, operationId }) => {
    const auditBase = audit(ctx, 'browser.select', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.select', { workspaceId, sessionId, snapshotId, elementRef, value, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) { return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.select', workspaceId, sessionId, elementRef }, auditBase); }
  });
}

export function registerBrowserDragTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.drag', {
    title: 'Drag between two snapshot elements',
    description: 'Dispatches bounded pointer events between two visible hit-tested opaque references from the same snapshot. Requires browserRead and browserInteract.',
    inputSchema: z.object({ ...baseInput, targetElementRef: baseInput.elementRef }).strict(), outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, snapshotId, elementRef, targetElementRef, operationId }) => {
    const auditBase = audit(ctx, 'browser.drag', workspaceId, elementRef, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.drag', { workspaceId, sessionId, snapshotId, elementRef, targetElementRef, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) { return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.drag', workspaceId, sessionId, elementRef }, auditBase); }
  });
}

export function registerBrowserDialogTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.dialog', {
    title: 'Accept or dismiss a JavaScript dialog',
    description: 'Handles the currently open JavaScript alert/confirm dialog with a fixed accept or dismiss action. Prompt text is never supplied. Requires browserRead and browserInteract.',
    inputSchema: z.object({ workspaceId: baseInput.workspaceId, sessionId: baseInput.sessionId, action: z.enum(['accept', 'dismiss']), operationId: baseInput.operationId }).strict(), outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, action, operationId }) => {
    const auditBase = audit(ctx, 'browser.dialog', workspaceId, sessionId, operationId);
    try {
      await requireInteraction(ctx, workspaceId);
      const result = await client(ctx).call('browser.dialog', { workspaceId, sessionId, action, operationId });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) { return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.dialog', workspaceId, sessionId }, auditBase); }
  });
}
