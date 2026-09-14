import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { DevelopmentBrokerError } from "@localbridge/development";
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from "@localbridge/shared";

import type { ToolContext } from "../tool-context.js";
import { toolError, toolSuccess } from "../tool-result.js";

const projectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const reviewedProfileSchema = z.object({
  workspaceId: z.string().max(160),
  name: z.string().max(64),
  available: z.boolean(),
  blockedReason: z.enum(["capability-disabled", "automation-review-required"]).optional(),
}).strict();
const automationAvailabilitySchema = z.object({
  reviewedProfiles: z.object({
    processes: z.array(reviewedProfileSchema).max(256),
    validations: z.array(reviewedProfileSchema).max(256),
    browser: z.array(reviewedProfileSchema).max(256),
  }).strict(),
  detectedProposal: z.object({
    state: z.enum(["none", "detected-awaiting-review", "applying", "detected-inactive"]),
    processCount: z.number().int().min(0).max(128),
    validationCount: z.number().int().min(0).max(128),
  }).strict(),
}).strict();
const emptyAutomationAvailability = {
  reviewedProfiles: { processes: [], validations: [], browser: [] },
  detectedProposal: { state: "none" as const, processCount: 0, validationCount: 0 },
};
const projectSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().max(80),
  description: z.string().max(240),
  workspaceIds: z.array(z.string().max(160)).min(1).max(16),
  applicationId: z.string().regex(/^app_[a-f0-9]{16,32}$/).optional(),
  setupStatus: z.enum(["draft", "review-required", "ready", "interrupted"]),
  /**
   * Estado del proyecto y cobertura del último escaneo local (ADR-0040). Sin
   * recuentos ni rutas: permiten explicar una estructura parcial o una revisión
   * pendiente, no reconstruir el árbol del proyecto.
   */
  state: z.enum(["ready", "review", "unavailable", "conflict"]).default("ready"),
  scanCoverage: z.enum(["complete", "partial", "unknown"]).default("unknown"),
  execution: z.object({
    trustMode: z.enum(["guided", "project-agent", "full-host"]),
    terminalAvailable: z.boolean(),
    blockedReason: z.enum(["trust-inactive", "device-mismatch", "guided-mode", "sandbox-unavailable", "project-not-ready"]).optional(),
  }).strict(),
  automation: automationAvailabilitySchema.default(emptyAutomationAvailability),
}).strict();
const planSummarySchema = z.object({
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  topology: z.enum(["single", "monorepo", "multi-repo"]),
  workspaceCount: z.number().int().min(1).max(16),
  installCount: z.number().int().min(0).max(64),
  packageManagers: z.array(z.enum(["npm", "pnpm", "yarn"])).max(3),
  directDependencyCount: z.number().int().min(0).max(100_000),
  directDevDependencyCount: z.number().int().min(0).max(100_000),
  serverCount: z.number().int().min(0).max(128),
  validationCount: z.number().int().min(0).max(128),
  serviceCount: z.number().int().min(0).max(8),
  actionKinds: z.array(z.enum(["node-install", "git-init", "persist-profiles", "persist-application", "finalize-topology"])).max(5),
}).strict();
const statusSchema = z.object({
  project: projectSchema,
  setup: z.object({
    phase: z.enum(["draft", "analyzing", "awaiting-local-review", "installing", "finalizing", "ready", "failed", "interrupted", "cancelled"]),
    policy: z.enum(["restricted", "compatible", "manual"]),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
    plan: planSummarySchema.optional(),
  }).strict().optional(),
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

function audit(ctx: ToolContext, tool: string, projectId?: string) {
  return {
    dbPath: ctx.config.auditDbPath,
    tool,
    riskLevel: tool === "project.setup.refresh" ? "R2" : "R1",
    startedAt: Date.now(),
    ...(projectId === undefined ? {} : { resource: projectId }),
  };
}

export function registerProjectListTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ projects: z.array(projectSchema).max(500) }).strict();
  server.registerTool("project.list", {
    title: "List assisted local projects",
    description: "Lists user-created project groupings, their readiness, scan coverage, effective terminal availability, locally reviewed profiles and any separately detected setup proposal. A proposal is never a reviewed profile and never blocks a separately authorized full-host terminal. A blockedReason explains why a resource is closed without granting it. It returns opaque references only and never returns roots, commands, manifests, dependencies, logs or environment values.",
    inputSchema: z.object({}).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const auditBase = audit(ctx, "project.list");
    try {
      return toolSuccess(outputSchema.parse(await client(ctx).call("project.list", {})), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "project.list" }, auditBase);
    }
  });
}

export function registerProjectSetupStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("project.setup.status", {
    title: "Read assisted project setup status",
    description: "Returns a bounded setup summary. It cannot approve, install, execute, change permissions or expose the frozen plan contents.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    outputSchema: statusSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => {
    const auditBase = audit(ctx, "project.setup.status", projectId);
    try {
      return toolSuccess(statusSchema.parse(await client(ctx).call("project.setup.status", { projectId })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "project.setup.status", projectId }, auditBase);
    }
  });
}

export function registerProjectSetupRefreshTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("project.setup.refresh", {
    title: "Refresh a project setup proposal",
    description: "Re-scans manifests inside an already authorized project and refreshes its local proposal. It never installs dependencies, runs commands, initializes Git, changes permissions, approves a plan or finalizes profiles. The human must review and execute the proposal in LocalBridge.",
    inputSchema: z.object({ projectId: projectIdSchema }).strict(),
    outputSchema: statusSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ projectId }) => {
    const auditBase = audit(ctx, "project.setup.refresh", projectId);
    try {
      return toolSuccess(statusSchema.parse(await client(ctx).call("project.setup.refresh", { projectId })), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: "project.setup.refresh", projectId }, auditBase);
    }
  });
}
