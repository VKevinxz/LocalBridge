import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { getFileMetadata } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `file.metadata` — riesgo R1, permiso `read` (TOOL_CATALOG.md §5). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
}).strict();

const outputSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  type: z.enum(['file', 'dir']).optional(),
  size: z.number().optional(),
  sha256: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const DESCRIPTION = [
  'Returns metadata for a path inside an authorized workspace without reading its content into the response.',
  'A non-existent path is a normal result (exists: false), not an error — use this to check before file.read without spending context on content.',
  'sha256 is the hash of the complete file, computed the same way as file.read, so the two are directly comparable.',
  'Requires the read capability on the workspace; a path excluded by the workspace secret denylist fails with PATH_DENIED even if it exists.',
].join(' ');

export function registerFileMetadataTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file.metadata',
    {
      title: 'Get workspace file metadata',
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
    async ({ workspaceId, path }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'file.metadata', riskLevel: 'R1', startedAt, workspaceId, resource: path };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
        const result = await getFileMetadata(workspace, path);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'file.metadata', workspaceId }, auditBase);
      }
    },
  );
}
