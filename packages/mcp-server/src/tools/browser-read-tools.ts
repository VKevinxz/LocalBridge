import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';
import { applicationNameKey, loadWorkspaceRegistryDocument } from '@localbridge/workspace';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const workspaceIdSchema = z.string().min(1);
const sessionIdSchema = z.string().regex(/^session_[a-f0-9]{24}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional();
const requiredOperationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const processIdSchema = z.string().regex(/^process_[a-f0-9]{24}$/);
const listenerRefSchema = z.string().regex(/^listener_[a-f0-9]{24}$/);
const profileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{16,32}$/);
const projectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const terminalSessionIdSchema = z.string().regex(/^terminal_[a-f0-9]{24}$/);
const relatedTerminalListenerSchema = z.object({
  terminalSessionId: terminalSessionIdSchema,
  listenerRef: listenerRefSchema,
}).strict();
const browserStartInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  profile: profileNameSchema.optional(),
  processId: processIdSchema.optional(),
  listenerRef: listenerRefSchema.optional(),
  application: profileNameSchema.optional(),
  listeners: z.array(z.object({
    service: profileNameSchema,
    processId: processIdSchema,
    listenerRef: listenerRefSchema,
  }).strict()).min(1).max(8).optional(),
  applicationId: applicationIdSchema.optional(),
  runId: runIdSchema.optional(),
  projectId: projectIdSchema.optional(),
  terminalSessionId: terminalSessionIdSchema.optional(),
  relatedListeners: z.array(relatedTerminalListenerSchema).min(1).max(7).optional(),
  operationId: operationIdSchema,
}).strict().superRefine((input, context) => {
  const noTerminal = input.projectId === undefined && input.terminalSessionId === undefined && input.relatedListeners === undefined;
  const staticProfile = input.profile !== undefined && input.processId === undefined && input.listenerRef === undefined &&
    input.application === undefined && input.listeners === undefined && input.applicationId === undefined && input.runId === undefined && noTerminal;
  const detectedListener = input.profile === undefined && input.processId !== undefined && input.listenerRef !== undefined &&
    input.application === undefined && input.listeners === undefined && input.applicationId === undefined && input.runId === undefined && noTerminal;
  const application = input.profile === undefined && input.processId === undefined && input.listenerRef === undefined &&
    input.application !== undefined && input.listeners !== undefined && input.applicationId === undefined && input.runId === undefined && noTerminal;
  const applicationRun = input.profile === undefined && input.processId === undefined && input.listenerRef === undefined &&
    input.application === undefined && input.listeners === undefined && input.applicationId !== undefined && input.runId !== undefined && noTerminal;
  const terminalListener = input.profile === undefined && input.processId === undefined && input.listenerRef !== undefined &&
    input.application === undefined && input.listeners === undefined && input.applicationId === undefined && input.runId === undefined &&
    input.projectId !== undefined && input.terminalSessionId !== undefined;
  if (!staticProfile && !detectedListener && !application && !applicationRun && !terminalListener) {
    context.addIssue({
      code: 'custom',
      message: 'usa profile, processId + listenerRef, projectId + terminalSessionId + listenerRef, application + listeners o applicationId + runId, nunca una combinación',
    });
  }
});
const sessionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  profile: z.string(),
  state: z.enum(['running', 'stopped']),
  title: z.string(),
  path: z.string(),
  startedAt: z.iso.datetime(),
  controlState: z.enum(['agent_control', 'waiting_for_human', 'human_control', 'returning_to_agent', 'declined', 'expired', 'stopped']),
  controlExpiresAt: z.iso.datetime().optional(),
  postHumanExpiresAt: z.iso.datetime().optional(),
  humanReason: z.enum(['sign_in', 'file_selection', 'manual_step']).optional(),
  viewport: z.object({ width: z.number().int(), height: z.number().int(), mobile: z.boolean() }).strict().optional(),
});

function client(ctx: ToolContext) {
  if (ctx.developmentClient === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
  return ctx.developmentClient;
}

function mapBrokerError(error: unknown, rateLimit?: Record<string, unknown>): unknown {
  if (!(error instanceof DevelopmentBrokerError)) return error;
  if ((ERROR_CODES as readonly string[]).includes(error.code)) {
    const causeCode = error.causeCode !== undefined && (ERROR_CODES as readonly string[]).includes(error.causeCode)
      ? error.causeCode
      : undefined;
    return new LocalBridgeError(error.code as ErrorCode, {
      ...(causeCode === undefined ? {} : { causeCode }),
      ...(error.code === 'RATE_LIMITED' && rateLimit !== undefined ? { rateLimit } : {}),
    });
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
  await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'browserRead');
}

export function registerBrowserStartTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.start', {
    title: 'Start an isolated local browser session',
    description: 'Starts an ephemeral isolated browser using a reviewed static profile, one verified listener, or preferably an opaque applicationId + ready runId. It never accepts a URL, host, port, command or workspace substitution from the model.',
    inputSchema: browserStartInputSchema,
    outputSchema: sessionSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, profile, processId, listenerRef, application, listeners, applicationId, runId, projectId, terminalSessionId, relatedListeners, operationId }) => {
    const resource = profile ?? applicationId ?? application ?? processId ?? terminalSessionId;
    const auditBase = audit(ctx, 'browser.start', 'R3', workspaceId, resource, operationId);
    try {
      await requireRead(ctx, workspaceId);
      if (processId !== undefined || terminalSessionId !== undefined) {
        await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'processes');
      }
      if (application !== undefined && listeners !== undefined) {
        const registry = await loadWorkspaceRegistryDocument(ctx.workspaceConfigPath, ctx.logger);
        const configured = registry.applications.find((candidate) =>
          candidate.id === application || applicationNameKey(candidate.name) === applicationNameKey(application));
        if (configured === undefined || configured.reviewState !== 'reviewed') throw new LocalBridgeError('APPLICATION_PROFILE_NOT_FOUND');
        const primary = configured.services.find((service) => service.id === configured.primaryServiceId);
        if (primary?.workspaceId !== workspaceId) throw new LocalBridgeError('APPLICATION_SERVICE_MISMATCH');
        const expectedAliases = configured.services.map((service) => service.alias).toSorted();
        const suppliedAliases = listeners.map((item) => item.service).toSorted();
        if (new Set(suppliedAliases).size !== suppliedAliases.length ||
            JSON.stringify(expectedAliases) !== JSON.stringify(suppliedAliases)) {
          throw new LocalBridgeError('APPLICATION_SERVICE_MISMATCH');
        }
        for (const service of configured.services) {
          await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, service.workspaceId, 'processes');
          await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, service.workspaceId, 'browserRead');
        }
      }
      if (applicationId !== undefined && runId !== undefined) {
        const registry = await loadWorkspaceRegistryDocument(ctx.workspaceConfigPath, ctx.logger);
        const configured = registry.applications.find((candidate) => candidate.id === applicationId);
        if (configured === undefined || configured.reviewState !== 'reviewed') throw new LocalBridgeError('APPLICATION_REVIEW_REQUIRED');
        const primary = configured.services.find((service) => service.id === configured.primaryServiceId);
        if (primary?.workspaceId !== workspaceId) throw new LocalBridgeError('APPLICATION_SERVICE_MISMATCH');
        for (const service of configured.services) {
          await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, service.workspaceId, 'processes');
          await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, service.workspaceId, 'browserRead');
        }
      }
      const result = await client(ctx).call('browser.start', {
        workspaceId,
        ...(projectId !== undefined && terminalSessionId !== undefined && listenerRef !== undefined
          ? { projectId, terminalSessionId, listenerRef, ...(relatedListeners === undefined ? {} : { relatedListeners }) }
          : applicationId !== undefined && runId !== undefined
          ? { applicationId, runId }
          : profile !== undefined
          ? { profile }
          : application !== undefined
            ? { application, listeners }
            : { processId, listenerRef }),
        operationId,
      });
      return toolSuccess(sessionSummarySchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error, {
        resource: 'local-browser-sessions', scope: 'global', capacity: 4,
        recoveryTool: 'browser.list', action: 'list-and-reuse',
      }), ctx.logger, { tool: 'browser.start', workspaceId, resource }, auditBase);
    }
  });
}

export function registerBrowserListTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ sessions: z.array(sessionSummarySchema) });
  server.registerTool('browser.list', {
    title: 'List isolated browser sessions',
    description: 'Lists browser sessions managed by LocalBridge for one workspace. Call it before browser.start after reconnecting or from another conversation, and reuse a compatible running sessionId instead of creating a duplicate. A running session is active, not idle or available for destructive cleanup. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    const auditBase = audit(ctx, 'browser.list', 'R2', workspaceId);
    try {
      await requireRead(ctx, workspaceId);
      const sessions = await client(ctx).call('browser.list', { workspaceId });
      return toolSuccess(outputSchema.parse({ sessions }), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.list', workspaceId }, auditBase);
    }
  });
}

export function registerBrowserNavigateTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.navigate', {
    title: 'Navigate within approved local origins',
    description: 'Navigates an isolated session using a root-relative path. Absolute URLs and unapproved origins are rejected. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema, path: z.string().min(1).max(2048).regex(/^\/(?!\/)/), operationId: operationIdSchema }).strict(),
    outputSchema: sessionSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, path, operationId }) => {
    const auditBase = audit(ctx, 'browser.navigate', 'R3', workspaceId, sessionId, operationId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.navigate', { workspaceId, sessionId, path, operationId });
      return toolSuccess(sessionSummarySchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.navigate', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserReloadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.reload', {
    title: 'Reload the current local page',
    description: 'Reloads the current approved local page in the same isolated session and storage partition, preserving cookies, local storage and viewport. It revalidates current listener authority before the effect. ignore-cache bypasses HTTP cache for this page load; it does not regenerate Vite prebundles, restart the development process or clear service workers. Use process/application resources or an already-authorized terminal when that separate recovery is required. Prior element references become stale. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema, mode: z.enum(['normal', 'ignore-cache']).default('normal'), operationId: requiredOperationIdSchema }).strict(),
    outputSchema: sessionSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, mode, operationId }) => {
    const auditBase = audit(ctx, 'browser.reload', 'R3', workspaceId, sessionId, operationId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.reload', { workspaceId, sessionId, mode, operationId });
      return toolSuccess(sessionSummarySchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.reload', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserSnapshotTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({
    snapshotId: z.string().regex(/^snapshot_[a-f0-9]{20}$/),
    title: z.string(),
    path: z.string(),
    nodes: z.array(z.object({
      depth: z.number().int().nonnegative(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      elementRef: z.string().regex(/^element_[a-f0-9]{20}$/).optional(),
    }).strict()),
    truncated: z.boolean(),
  }).strict();
  server.registerTool('browser.snapshot', {
    title: 'Read an accessibility snapshot',
    description: 'Returns a bounded accessibility tree and opaque references for interactive elements. `truncated` is true when maxDepth or maxElements omitted accessible nodes. References are valid only for this snapshot. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema, maxDepth: z.number().int().min(1).max(20).default(12), maxElements: z.number().int().min(1).max(1000).default(500) }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, maxDepth, maxElements }) => {
    const auditBase = audit(ctx, 'browser.snapshot', 'R2', workspaceId, sessionId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.snapshot', { workspaceId, sessionId, maxDepth, maxElements });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.snapshot', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserViewportTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({
    sessionId: sessionIdSchema,
    width: z.number().int(),
    height: z.number().int(),
    mobile: z.boolean(),
    state: z.string().max(32),
  }).strict();
  server.registerTool('browser.viewport', {
    title: 'Resize the isolated local page for responsive testing',
    description: 'Emulates a viewport size in an isolated LocalBridge browser session so responsive layouts and breakpoints can be verified, and optionally emulates a touch device. The default desktop baseline is 1920x1080; common presets are 1440x900, 1024x768 and mobile 390x844. Width must be 320-3840 and height 320-2160. It does not resize the user window, navigate, change the allowed origin or grant any capability, and it invalidates the current snapshot because the layout changes. Take a new snapshot or screenshot afterwards. Requires browserRead.',
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema,
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(320).max(2160),
      mobile: z.boolean().default(false),
      operationId: operationIdSchema,
    }).strict(),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, width, height, mobile, operationId }) => {
    const auditBase = audit(ctx, 'browser.viewport', 'R2', workspaceId, sessionId, operationId);
    try {
      await requireRead(ctx, workspaceId);
      const result = outputSchema.parse(await client(ctx).call('browser.viewport', {
        workspaceId, sessionId, width, height, mobile, ...(operationId === undefined ? {} : { operationId }),
      }));
      return toolSuccess(result, { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.viewport', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserScreenshotTool(server: McpServer, ctx: ToolContext): void {
  const brokerSchema = z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), dataBase64: z.string(), width: z.number().int(), height: z.number().int(), fallbackUsed: z.boolean() }).strict();
  const outputSchema = brokerSchema.omit({ dataBase64: true });
  server.registerTool('browser.screenshot', {
    title: 'Capture the isolated local page',
    description: 'Captures the rendered viewport of an isolated LocalBridge browser session as PNG, with bounded JPEG fallback only when PNG cannot fit the private broker frame. For visual fidelity work, set the same viewport on reference and candidate, capture both, and only claim high or pixel-level similarity when both captures are available and comparable. If either capture fails, explicitly report visual fidelity as unverified. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema, settleMs: z.number().int().min(0).max(3_000).default(0) }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, settleMs }) => {
    const auditBase = audit(ctx, 'browser.screenshot', 'R2', workspaceId, sessionId);
    try {
      await requireRead(ctx, workspaceId);
      const brokerResult = brokerSchema.parse(await client(ctx).call('browser.screenshot', { workspaceId, sessionId, settleMs }));
      const metadata = outputSchema.parse({
        mimeType: brokerResult.mimeType,
        width: brokerResult.width,
        height: brokerResult.height,
        fallbackUsed: brokerResult.fallbackUsed,
      });
      const success = toolSuccess(metadata, { context: auditBase, logger: ctx.logger });
      return {
        ...success,
        content: [
          { type: 'image' as const, data: brokerResult.dataBase64, mimeType: brokerResult.mimeType },
          { type: 'text' as const, text: JSON.stringify(metadata) },
        ],
      };
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.screenshot', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserScreenshotSaveTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({
    sessionId: sessionIdSchema,
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    created: z.literal(true),
    mimeType: z.literal('image/png'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fallbackUsed: z.literal(false),
    sourcePath: z.string(),
  }).strict();
  server.registerTool('browser.screenshot.save', {
    title: 'Save local browser visual evidence',
    description: 'Captures the current local project viewport and creates a new PNG in a write-enabled workspace with size and SHA-256 receipt. It accepts only workspaceId and a relative destination path and never overwrites. Use the same viewport as the reference before comparing visual fidelity. If FILE_TOO_LARGE is returned, ask the user to choose a larger per-file limit in the LocalBridge workspace settings. Requires browserRead and write.',
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema,
      path: z.string().min(1).max(4096).refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), 'use a relative path'),
      settleMs: z.number().int().min(0).max(3_000).default(0),
      operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    }).strict(),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, path, operationId, settleMs }) => {
    const auditBase = audit(ctx, 'browser.screenshot.save', 'R3', workspaceId, `${sessionId}:${path}`, operationId);
    try {
      await requireRead(ctx, workspaceId);
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
      const result = outputSchema.parse(await client(ctx).call('browser.screenshot.save', { workspaceId, sessionId, path, operationId, settleMs }));
      return toolSuccess(result, {
        context: { ...auditBase, resource: `${sessionId}:${path}:${result.width}x${result.height}:${result.size}` },
        logger: ctx.logger,
      });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.screenshot.save', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserEventsTool(server: McpServer, ctx: ToolContext): void {
  type ConsoleValue = {
    kind: 'primitive' | 'object' | 'reference' | 'unavailable';
    type?: string | undefined;
    value?: string | number | boolean | null | undefined;
    truncated?: boolean | undefined;
    ref?: string | undefined;
    subtype?: string | undefined;
    className?: string | undefined;
    description?: string | undefined;
    properties?: Array<{ name: string; kind: 'value' | 'accessor'; value?: ConsoleValue | undefined }> | undefined;
  };
  const consoleValueSchema: z.ZodType<ConsoleValue> = z.lazy(() => z.object({
    kind: z.enum(['primitive', 'object', 'reference', 'unavailable']),
    type: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    truncated: z.boolean().optional(),
    ref: z.string().optional(),
    subtype: z.string().optional(),
    className: z.string().optional(),
    description: z.string().optional(),
    properties: z.array(z.object({
      name: z.string(), kind: z.enum(['value', 'accessor']), value: consoleValueSchema.optional(),
    }).strict()).optional(),
  }).strict());
  const outputSchema = z.object({
    events: z.array(z.object({
      cursor: z.number().int().nonnegative(), type: z.enum(['console', 'network', 'error', 'navigation']),
      level: z.string(), message: z.string(), path: z.string().optional(), navigationEpoch: z.number().int().nonnegative(),
      arguments: z.array(consoleValueSchema).optional(), argumentsTruncated: z.boolean().optional(),
    }).strict()),
    nextCursor: z.number().int().nonnegative(),
    truncatedBeforeCursor: z.boolean(),
    navigationEpoch: z.number().int().nonnegative(),
  }).strict();
  server.registerTool('browser.events', {
    title: 'Read browser console and network events',
    description: 'Reads bounded cursor-based console, network, navigation and page errors without response bodies or headers. At the start of a QA step, read once and retain nextCursor; later read from that cursor so historical errors are not attributed to the current action. Console arguments are optional bounded snapshots of own properties; accessors are identified but never invoked, and cycles or truncation are explicit. Use current-navigation to exclude prior document epochs while retaining history for later queries. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema, cursor: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(65_536).default(65_536), scope: z.enum(['history', 'current-navigation']).default('history') }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, cursor, maxBytes, scope }) => {
    const auditBase = audit(ctx, 'browser.events', 'R2', workspaceId, sessionId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.events', { workspaceId, sessionId, cursor, maxBytes, scope });
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.events', workspaceId, sessionId }, auditBase);
    }
  });
}

export function registerBrowserStopTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.stop', {
    title: 'Stop an isolated browser session',
    description: 'Stops one LocalBridge browser session and destroys its ephemeral storage partition. Requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema, operationId: operationIdSchema }).strict(),
    outputSchema: sessionSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, operationId }) => {
    const auditBase = audit(ctx, 'browser.stop', 'R3', workspaceId, sessionId, operationId);
    try {
      await requireRead(ctx, workspaceId);
      const result = await client(ctx).call('browser.stop', { workspaceId, sessionId, operationId });
      return toolSuccess(sessionSummarySchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.stop', workspaceId, sessionId }, auditBase);
    }
  });
}
