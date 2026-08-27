import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { buildWorkspaceTree } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `workspace.tree` — riesgo R1, permiso `read` (TOOL_CATALOG.md §3). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).default('.'),
  maxDepth: z.number().int().positive().optional(),
  maxEntries: z.number().int().positive().optional(),
});

const outputSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(['file', 'dir']),
      size: z.number().optional(),
    }),
  ),
  truncated: z.boolean(),
  excluded: z.array(z.string()),
});

const DESCRIPTION = [
  'Lists the contents of a directory inside an authorized workspace, bounded by depth and entry-count limits.',
  'Paths are always relative to the workspace root and are addressed by workspaceId, never by an absolute path.',
  'Symlinks are never followed: they are omitted from the listing entirely.',
  'Heavy directories (node_modules, vendor, dist, build, .cache, .git/objects) and paths matching the workspace secret denylist are excluded automatically.',
  'When truncated is true the listing is partial: narrow relativePath or increase maxEntries/maxDepth and call again.',
  'Requires the read capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it.',
].join(' ');

export function registerWorkspaceTreeTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'workspace.tree',
    {
      title: 'List a workspace directory',
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
    async ({ workspaceId, relativePath, maxDepth, maxEntries }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'workspace.tree',
        riskLevel: 'R1',
        startedAt,
        workspaceId,
        resource: relativePath,
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
        const result = await buildWorkspaceTree(workspace, relativePath, maxDepth, maxEntries);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'workspace.tree', workspaceId }, auditBase);
      }
    },
  );
}
