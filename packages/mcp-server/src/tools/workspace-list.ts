import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { loadWorkspaceRegistryDocument } from '@localbridge/workspace';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `workspace.list` — riesgo R1, sin permiso propio (TOOL_CATALOG.md §2). */

const inputSchema = z.object({});

const permissionsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  overwrite: z.boolean(),
  gitRead: z.boolean(),
  validations: z.boolean(),
  gitWrite: z.boolean(),
  processes: z.boolean(),
  browserRead: z.boolean(),
  browserInteract: z.boolean(),
  browserHumanControl: z.boolean(),
});

const limitsSchema = z.object({
  maxFileBytes: z.number(),
  maxTreeEntries: z.number(),
  maxTreeDepth: z.number(),
});

const outputSchema = z.object({
  workspaces: z.array(
    z.object({
      workspaceId: z.string(),
      name: z.string(),
      permissions: permissionsSchema,
      limits: limitsSchema,
      applicationIds: z.array(z.string()),
    }),
  ),
  applications: z.array(z.object({
    applicationId: z.string(),
    name: z.string(),
    reviewState: z.enum(['reviewed', 'needs-review', 'conflict']),
    primaryService: z.string(),
    services: z.array(z.object({
      service: z.string(),
      workspaceId: z.string(),
      processProfile: z.string(),
      startupOrder: z.number().int(),
    })),
  })),
});

const DESCRIPTION = [
  'Lists the workspaces the user has authorized for this server, with their current permissions and limits.',
  'Only enabled workspaces are returned; the model can never see or reference a workspace the user has not explicitly authorized.',
  'Use this before any other workspace or file tool to discover valid workspaceId values and avoid calling operations that will be denied.',
  'Requires no permissions and never modifies state.',
].join(' ');

export function registerWorkspaceListTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'workspace.list',
    {
      title: 'List authorized workspaces',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'workspace.list', riskLevel: 'R1', startedAt };
      try {
        const registry = await loadWorkspaceRegistryDocument(ctx.workspaceConfigPath, ctx.logger);
        const enabledIds = new Set(registry.workspaces.filter((workspace) => workspace.enabled).map((workspace) => workspace.id));
        const result = {
          workspaces: registry.workspaces
            .filter((workspace) => workspace.enabled)
            .map((workspace) => ({
              workspaceId: workspace.id,
              name: workspace.name,
              permissions: workspace.permissions,
              limits: workspace.limits,
              applicationIds: registry.applications
                .filter((application) => application.services.some((service) => service.workspaceId === workspace.id))
                .map((application) => application.id),
            })),
          applications: registry.applications
            .filter((application) => application.services.every((service) => enabledIds.has(service.workspaceId)))
            .map((application) => ({
              applicationId: application.id,
              name: application.name,
              reviewState: application.reviewState,
              primaryService: application.services.find((service) => service.id === application.primaryServiceId)?.alias ?? '',
              services: application.services.map((service) => ({
                service: service.alias,
                workspaceId: service.workspaceId,
                processProfile: service.processProfile,
                startupOrder: service.startupOrder,
              })),
            })),
        };

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'workspace.list' }, auditBase);
      }
    },
  );
}
