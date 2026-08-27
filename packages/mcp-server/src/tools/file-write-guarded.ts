import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { writeGuardedWorkspaceFile } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import { cacheResult, getCachedResult, idempotencyKey } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `file.write_guarded` — riesgo R3, permiso `overwrite` (TOOL_CATALOG.md §7). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'expectedSha256 must be a 64-character hex SHA-256 digest'),
  content: z.string(),
  operationId: z.string().min(1).optional(),
});

const outputSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
  previousSha256: z.string(),
});

const DESCRIPTION = [
  'Replaces the content of an existing file inside an authorized workspace, guarded by expectedSha256.',
  'expectedSha256 must be the hash returned by a previous file.read or file.metadata call on the same path. The server recomputes the hash of the file on disk immediately before writing; if it no longer matches expectedSha256, the write is rejected with HASH_MISMATCH and nothing is written — re-read the file and retry.',
  'There is no way to force the write past a hash mismatch in this version: re-read, reapply the change, and call again with the fresh hash.',
  'Any symlink at the target path is rejected with SYMLINK_ESCAPE, whether it resolves inside or outside the workspace — writing through a symlink is never allowed.',
  'operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of applying the write twice.',
  'Requires the overwrite capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it. Having write does not imply overwrite — they are granted separately.',
].join(' ');

export function registerFileWriteGuardedTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file.write_guarded',
    {
      title: 'Replace a workspace file, guarded by hash',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, expectedSha256, content, operationId }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'file.write_guarded',
        riskLevel: 'R3',
        startedAt,
        workspaceId,
        resource: path,
        ...(operationId === undefined ? {} : { operationId }),
      };
      try {
        const key = operationId === undefined ? undefined : idempotencyKey('file.write_guarded', workspaceId, operationId);
        if (key !== undefined) {
          const cached = getCachedResult(key);
          if (cached !== undefined) {
            return toolSuccess(cached, { context: auditBase, logger: ctx.logger });
          }
        }

        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'overwrite');
        const result = await writeGuardedWorkspaceFile(workspace, path, expectedSha256.toLowerCase(), content);

        if (key !== undefined) {
          cacheResult(key, result);
        }

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'file.write_guarded', workspaceId }, auditBase);
      }
    },
  );
}
