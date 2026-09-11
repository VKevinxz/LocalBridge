import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { DevelopmentBrokerError } from "@localbridge/development";
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from "@localbridge/shared";

import type { ToolContext } from "../tool-context.js";
import { toolError, toolSuccess } from "../tool-result.js";

const projectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const sessionIdSchema = z.string().regex(/^terminal_[a-f0-9]{24}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional();
const terminalSummarySchema = z.object({
  sessionId: sessionIdSchema,
  projectId: projectIdSchema,
  state: z.enum(["running", "exited", "stopped", "revoked", "timed_out"]),
  trustMode: z.enum(["project-agent", "full-host"]),
  startedAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  nextCursor: z.number().int().nonnegative(),
  exitCode: z.number().int().optional(),
}).strict();
const listenerSchema = z.object({
  listenerRef: z.string().regex(/^listener_[a-f0-9]{24}$/),
  origin: z.string().regex(/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/),
  addressFamily: z.enum(["ipv4", "ipv6"]),
  bindScope: z.enum(["loopback", "wildcard"]),
  exclusive: z.boolean(),
  port: z.number().int().min(1).max(65_535),
  observedAt: z.iso.datetime(),
}).strict();

function client(ctx: ToolContext) {
  if (ctx.developmentClient === undefined) throw new LocalBridgeError("FEATURE_UNAVAILABLE");
  return ctx.developmentClient;
}
function mapBrokerError(error: unknown): unknown {
  if (!(error instanceof DevelopmentBrokerError)) return error;
  if ((ERROR_CODES as readonly string[]).includes(error.code)) return new LocalBridgeError(error.code as ErrorCode);
  return new LocalBridgeError("INTERNAL_ERROR");
}

function audit(ctx: ToolContext, tool: string, riskLevel: string, projectId: string, sessionId?: string, operationId?: string) {
  return {
    dbPath: ctx.config.auditDbPath,
    tool,
    riskLevel,
    startedAt: Date.now(),
    resource: sessionId === undefined ? projectId : `${projectId}:${sessionId}`,
    ...(operationId === undefined ? {} : { operationId }),
  };
}

export function registerTerminalStartTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("terminal.start", {
    title: "Start a trusted project terminal",
    description: "Starts an interactive local terminal for a project using the trust level chosen in LocalBridge. It cannot choose a root, shell, environment or trust mode. Guided projects and unavailable sandboxes fail closed. Full-host mode has the same authority as the signed-in Windows user. Do not use terminal tools for Git operations supported by git.*; prefer structured git.* and web.download tools when available. For an ad-hoc development server, bind to 127.0.0.1 or ::1 unless the user explicitly requested LAN access; wildcard binds such as 0.0.0.0 and :: may trigger the Windows Firewall and expose the service to the local network. Multi-repository projects use repositoryPath from project.list.",
    inputSchema: z.object({ projectId: projectIdSchema, operationId: operationIdSchema }).strict(),
    outputSchema: terminalSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
  }, async ({ projectId, operationId }) => {
    const auditBase = audit(ctx, "terminal.start", "R6", projectId, undefined, operationId);
    try {
      return toolSuccess(terminalSummarySchema.parse(await client(ctx).call("terminal.start", { projectId, operationId })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "terminal.start", projectId }, auditBase);
    }
  });
}

export function registerTerminalListTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ sessions: z.array(terminalSummarySchema).max(256) }).strict();
  server.registerTool("terminal.list", {
    title: "List project terminal sessions",
    description: "Lists retained terminal sessions for one locally authorized project so a reconnected client can resume reading or stop them. It exposes no PID, root, environment or command history.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => {
    const auditBase = audit(ctx, "terminal.list", "R1", projectId);
    try {
      const sessions = await client(ctx).call("terminal.list", { projectId });
      return toolSuccess(outputSchema.parse({ sessions }), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "terminal.list", projectId }, auditBase);
    }
  });
}

export function registerTerminalWriteTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ session: terminalSummarySchema, nextCursor: z.number().int().nonnegative() }).strict();
  server.registerTool("terminal.write", {
    title: "Write to a trusted project terminal",
    description: "Writes bounded text or control characters to an existing interactive terminal. The local project trust decision is revalidated on every call. Commands are not persisted by LocalBridge. Do not use terminal tools for Git operations supported by git.*; prefer structured web.download for observed assets. When starting a local server, bind to 127.0.0.1 or ::1 unless LAN access was explicitly requested; after launch call terminal.status and report any wildcard listener instead of treating a firewall prompt as normal setup.",
    inputSchema: z.object({ projectId: projectIdSchema, sessionId: sessionIdSchema, text: z.string().min(1).max(65_536), operationId: operationIdSchema }).strict(),
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
  }, async ({ projectId, sessionId, text, operationId }) => {
    const auditBase = audit(ctx, "terminal.write", "R6", projectId, sessionId, operationId);
    try {
      return toolSuccess(outputSchema.parse(await client(ctx).call("terminal.write", { projectId, sessionId, text, operationId })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "terminal.write", projectId, sessionId }, auditBase);
    }
  });
}

export function registerTerminalReadTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({
    session: terminalSummarySchema,
    entries: z.array(z.object({ cursor: z.number().int().nonnegative(), stream: z.enum(["terminal", "diagnostic"]), text: z.string().max(65_536) }).strict()).max(2_048),
    nextCursor: z.number().int().nonnegative(),
    truncatedBeforeCursor: z.boolean(),
    minimumBytesToProgress: z.number().int().min(1).max(4).optional(),
  }).strict();
  server.registerTool("terminal.read", {
    title: "Read bounded terminal output",
    description: "Reads a cursor-based bounded window from a LocalBridge terminal. Control sequences are sanitized and old output may be explicitly truncated.",
    inputSchema: z.object({ projectId: projectIdSchema, sessionId: sessionIdSchema, cursor: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(65_536).default(65_536) }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, sessionId, cursor, maxBytes }) => {
    const auditBase = audit(ctx, "terminal.read", "R1", projectId, sessionId);
    try {
      return toolSuccess(outputSchema.parse(await client(ctx).call("terminal.read", { projectId, sessionId, cursor, maxBytes })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "terminal.read", projectId, sessionId }, auditBase);
    }
  });
}

export function registerTerminalStatusTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ session: terminalSummarySchema, listeners: z.array(listenerSchema).max(128) }).strict();
  server.registerTool("terminal.status", {
    title: "Read terminal status and verified listeners",
    description: "Returns terminal state and listeners proven to belong to its Job Object. Report bindScope=wildcard to the user because it listens beyond loopback; prefer 127.0.0.1 or ::1 for local development. It exposes no PID, root, environment or command history.",
    inputSchema: z.object({ projectId: projectIdSchema, sessionId: sessionIdSchema }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, sessionId }) => {
    const auditBase = audit(ctx, "terminal.status", "R1", projectId, sessionId);
    try {
      return toolSuccess(outputSchema.parse(await client(ctx).call("terminal.status", { projectId, sessionId })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "terminal.status", projectId, sessionId }, auditBase);
    }
  });
}

export function registerTerminalStopTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("terminal.stop", {
    title: "Stop a trusted project terminal",
    description: "Stops one LocalBridge terminal and its complete managed process tree. It cannot target arbitrary operating-system processes.",
    inputSchema: z.object({ projectId: projectIdSchema, sessionId: sessionIdSchema, operationId: operationIdSchema }).strict(),
    outputSchema: terminalSummarySchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId, sessionId, operationId }) => {
    const auditBase = audit(ctx, "terminal.stop", "R2", projectId, sessionId, operationId);
    try {
      return toolSuccess(terminalSummarySchema.parse(await client(ctx).call("terminal.stop", { projectId, sessionId, operationId })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "terminal.stop", projectId, sessionId }, auditBase);
    }
  });
}
