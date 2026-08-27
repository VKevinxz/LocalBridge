import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';
import { loadWorkspaceRegistryDocument } from '@localbridge/workspace';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{16,32}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional();
const serviceSchema = z.object({
  service: z.string(),
  workspaceId: z.string(),
  processProfile: z.string(),
  state: z.enum(['pending', 'starting', 'ready', 'stopped', 'failed']),
  port: z.number().int().min(1).max(65_535).optional(),
  bindScope: z.enum(['loopback', 'wildcard']).optional(),
});
const runSchema = z.object({
  runId: runIdSchema,
  applicationId: applicationIdSchema,
  applicationName: z.string(),
  primaryWorkspaceId: z.string(),
  state: z.enum(['starting', 'ready', 'stopping', 'stopped', 'failed', 'failed_cleanup']),
  startedAt: z.iso.datetime(),
  services: z.array(serviceSchema).min(1).max(8),
  errorCode: z.string().optional(),
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

async function requireApplication(ctx: ToolContext, applicationId: string) {
  const registry = await loadWorkspaceRegistryDocument(ctx.workspaceConfigPath, ctx.logger);
  const application = registry.applications.find((candidate) => candidate.id === applicationId);
  if (application === undefined) throw new LocalBridgeError('APPLICATION_PROFILE_NOT_FOUND');
  if (application.reviewState !== 'reviewed') throw new LocalBridgeError('APPLICATION_REVIEW_REQUIRED');
  for (const service of application.services) {
    await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, service.workspaceId, 'processes');
    await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, service.workspaceId, 'browserRead');
  }
  return application;
}

function audit(ctx: ToolContext, tool: string, riskLevel: string, applicationId?: string, operationId?: string) {
  return {
    dbPath: ctx.config.auditDbPath,
    tool,
    riskLevel,
    startedAt: Date.now(),
    ...(applicationId === undefined ? {} : { resource: applicationId }),
    ...(operationId === undefined ? {} : { operationId }),
  };
}

export function registerApplicationListTool(server: McpServer, ctx: ToolContext): void {
  const outputSchema = z.object({ applications: z.array(z.object({
    applicationId: applicationIdSchema,
    name: z.string(),
    description: z.string(),
    reviewState: z.enum(['reviewed', 'needs-review', 'conflict']),
    primaryService: z.string(),
    primaryWorkspaceId: z.string(),
    services: z.array(z.object({ service: z.string(), workspaceId: z.string(), processProfile: z.string(), startupOrder: z.number().int() })),
  })) });
  server.registerTool('application.list', {
    title: 'List locally reviewed applications',
    description: 'Lists global LocalBridge applications and their reviewed service composition. It never returns commands, paths, URLs or ports and never changes configuration.',
    inputSchema: z.object({}).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const auditBase = audit(ctx, 'application.list', 'R1');
    try {
      const registry = await loadWorkspaceRegistryDocument(ctx.workspaceConfigPath, ctx.logger);
      const enabled = new Set(registry.workspaces.filter((workspace) => workspace.enabled).map((workspace) => workspace.id));
      const applications = registry.applications
        .filter((application) => application.services.every((service) => enabled.has(service.workspaceId)))
        .map((application) => {
          const primary = application.services.find((service) => service.id === application.primaryServiceId)!;
          return {
            applicationId: application.id,
            name: application.name,
            description: application.description,
            reviewState: application.reviewState,
            primaryService: primary.alias,
            primaryWorkspaceId: primary.workspaceId,
            services: application.services.map((service) => ({
              service: service.alias,
              workspaceId: service.workspaceId,
              processProfile: service.processProfile,
              startupOrder: service.startupOrder,
            })),
          };
        });
      return toolSuccess(outputSchema.parse({ applications }), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(error, ctx.logger, { tool: 'application.list' }, auditBase);
    }
  });
}

export function registerApplicationStartTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('application.start', {
    title: 'Start a reviewed local application',
    description: 'Starts every fixed service profile in a reviewed LocalBridge application. It accepts only an opaque applicationId; commands, cwd, environment, services, URLs and ports cannot be supplied. Poll application.status until ready before opening the browser.',
    inputSchema: z.object({ applicationId: applicationIdSchema, operationId: operationIdSchema }).strict(),
    outputSchema: runSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ applicationId, operationId }) => {
    const auditBase = audit(ctx, 'application.start', 'R4', applicationId, operationId);
    try {
      await requireApplication(ctx, applicationId);
      const result = await client(ctx).call('application.start', { applicationId, operationId });
      return toolSuccess(runSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'application.start', applicationId }, auditBase);
    }
  });
}

export function registerApplicationStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('application.status', {
    title: 'Read an application run status',
    description: 'Returns bounded readiness for a reviewed application run. It exposes no command, log content, PID, path or environment value.',
    inputSchema: z.object({ applicationId: applicationIdSchema, runId: runIdSchema }).strict(),
    outputSchema: runSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ applicationId, runId }) => {
    const auditBase = audit(ctx, 'application.status', 'R2', applicationId);
    try {
      await requireApplication(ctx, applicationId);
      const result = runSchema.parse(await client(ctx).call('application.status', { runId }));
      if (result.applicationId !== applicationId) throw new LocalBridgeError('APPLICATION_RUN_NOT_FOUND');
      return toolSuccess(result, { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'application.status', applicationId }, auditBase);
    }
  });
}

export function registerApplicationStopTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('application.stop', {
    title: 'Stop a managed application run',
    description: 'Stops the browser and every process started for one opaque application run. It never affects processes that LocalBridge did not start.',
    inputSchema: z.object({ applicationId: applicationIdSchema, runId: runIdSchema, operationId: operationIdSchema }).strict(),
    outputSchema: runSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ applicationId, runId, operationId }) => {
    const auditBase = audit(ctx, 'application.stop', 'R3', applicationId, operationId);
    try {
      await requireApplication(ctx, applicationId);
      const current = runSchema.parse(await client(ctx).call('application.status', { runId }));
      if (current.applicationId !== applicationId) throw new LocalBridgeError('APPLICATION_RUN_NOT_FOUND');
      const result = await client(ctx).call('application.stop', { runId, operationId });
      return toolSuccess(runSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'application.stop', applicationId }, auditBase);
    }
  });
}
