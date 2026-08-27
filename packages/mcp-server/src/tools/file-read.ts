import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { readWorkspaceFile } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `file.read` — riesgo R1, permiso `read` (TOOL_CATALOG.md §4). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
});

const outputSchema = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string(),
  size: z.number(),
  truncated: z.boolean(),
  modifiedAt: z.string(),
});

const DESCRIPTION = [
  'Reads a file inside an authorized workspace. The path is relative to the workspace root and is addressed by workspaceId, never by an absolute path.',
  'sha256 is always the hash of the complete file on disk, even when the returned content is truncated by maxBytes — use it later as expectedSha256 when a guarded write tool becomes available.',
  'If truncated is true, the returned content is only a prefix of the file: do not treat it as the full file when reconstructing a replacement.',
  'Requires the read capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it, or FILE_TOO_LARGE if the file exceeds the workspace size limit.',
].join(' ');

export function registerFileReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file.read',
    {
      title: 'Read a workspace file',
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
    async ({ workspaceId, path, maxBytes }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'file.read', riskLevel: 'R1', startedAt, workspaceId, resource: path };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
        const result = await readWorkspaceFile(workspace, path, maxBytes);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'file.read', workspaceId }, auditBase);
      }
    },
  );
}
