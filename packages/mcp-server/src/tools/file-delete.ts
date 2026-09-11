import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { deleteWorkspaceFile } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace, withAuthorizedWorkspaceEffect } from '@localbridge/permissions';

import { getCachedResult, idempotencyFingerprint, idempotencyKey, runIdempotent } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `file.delete` — riesgo R3, permiso `overwrite` (TOOL_CATALOG.md §9-bis, v2.4). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'expectedSha256 must be a 64-character hex SHA-256 digest'),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();

const outputSchema = z.object({
  path: z.string(),
  deleted: z.literal(true),
});

const DESCRIPTION = [
  'Deletes an existing file inside an authorized workspace, guarded by expectedSha256 — the same guard file.write_guarded uses, not human approval.',
  'expectedSha256 must be the hash returned by a previous file.read or file.metadata call on the same path. If the file no longer matches expectedSha256, the delete is rejected with HASH_MISMATCH and nothing is deleted — re-read the file and retry if you still want to delete it.',
  'Only deletes a single file, never a directory: fails with NOT_A_FILE if path is a directory. There is no recursive variant.',
  'Any symlink at the target path is rejected with SYMLINK_ESCAPE — deleting through a symlink is never allowed, whether it resolves inside or outside the workspace.',
  'operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of erroring with FILE_NOT_FOUND on a file the first call already deleted.',
  'Requires the overwrite capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it.',
].join(' ');

export function registerFileDeleteTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file.delete',
    {
      title: 'Delete a workspace file, guarded by hash',
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
    async ({ workspaceId, path, expectedSha256, operationId }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'file.delete',
        riskLevel: 'R3',
        startedAt,
        workspaceId,
        resource: path,
        ...(operationId === undefined ? {} : { operationId }),
      };
      try {
        const key = operationId === undefined ? undefined : idempotencyKey('file.delete', workspaceId, operationId);
        const fingerprint = idempotencyFingerprint(path, expectedSha256.toLowerCase());
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'overwrite');
        if (key !== undefined) {
          const cached = getCachedResult(key, fingerprint);
          if (cached !== undefined) {
            return toolSuccess(cached, { context: auditBase, logger: ctx.logger });
          }
        }

        const mutate = () => deleteWorkspaceFile(workspace, path, expectedSha256.toLowerCase(), {
          withAuthorizedEffect: (effect) => withAuthorizedWorkspaceEffect(ctx.workspaceConfigPath, ctx.logger, workspace, 'overwrite', effect),
        });
        const result = key === undefined ? await mutate() : await runIdempotent(key, fingerprint, mutate);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'file.delete', workspaceId }, auditBase);
      }
    },
  );
}
