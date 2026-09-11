import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { searchWorkspace } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `workspace.search` — riesgo R1, permiso `read` (TOOL_CATALOG.md §3-bis, v2.3). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1),
  relativePath: z.string().min(1).default('.'),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().positive().optional(),
}).strict();

const outputSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      text: z.string(),
    }),
  ),
  filesScanned: z.number(),
  truncated: z.boolean(),
});

const DESCRIPTION = [
  'Searches for a literal substring across text files inside an authorized workspace, scoped to relativePath (a file or a directory; default the whole workspace).',
  'query is matched as a literal substring, never a regular expression — there is no regex mode, deliberately, to avoid a query that hangs the server (catastrophic backtracking). caseSensitive defaults to false.',
  'Binary files are skipped automatically (detected by encoding/BOM and a bounded binary sniff), as are symlinks and the same heavy directories workspace.tree excludes (node_modules, vendor, dist, build, .cache, .git/objects). Standard projects retain the ordinary file-size ceiling; adaptive projects stream larger text sources without a fixed source-size ceiling. Paths matching the workspace secret denylist are never scanned.',
  'Each match reports the file path (relative to the workspace), the 1-indexed line number, and the matching line text (truncated if extremely long — that only affects what is returned, not whether it counts as a match).',
  'When truncated is true, either maxResults was reached or the search hit its time budget: results are partial. Narrow relativePath or the query and call again.',
  'Requires the read capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it.',
].join(' ');

export function registerWorkspaceSearchTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'workspace.search',
    {
      title: 'Search file contents in a workspace',
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
    async ({ workspaceId, query, relativePath, caseSensitive, maxResults }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'workspace.search',
        riskLevel: 'R1',
        startedAt,
        workspaceId,
        resource: relativePath,
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
        const result = await searchWorkspace(workspace, relativePath, query, caseSensitive, maxResults);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'workspace.search', workspaceId }, auditBase);
      }
    },
  );
}
