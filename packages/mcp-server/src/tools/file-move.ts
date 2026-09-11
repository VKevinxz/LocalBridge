import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { moveWorkspaceFile } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace, withAuthorizedWorkspaceEffect } from '@localbridge/permissions';

import { getCachedResult, idempotencyFingerprint, idempotencyKey, runIdempotent } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `file.move` — riesgo R3, permiso `overwrite` (TOOL_CATALOG.md §9-bis, v2.4). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  sourcePath: z.string().min(1),
  destPath: z.string().min(1),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'expectedSha256 must be a 64-character hex SHA-256 digest'),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();

const outputSchema = z.object({
  sourcePath: z.string(),
  destPath: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const DESCRIPTION = [
  'Moves or renames a file inside an authorized workspace, guarded by expectedSha256 on the source file — the same guard file.write_guarded uses, not human approval.',
  'expectedSha256 must be the hash returned by a previous file.read or file.metadata call on sourcePath. If sourcePath no longer matches expectedSha256, the move is rejected with HASH_MISMATCH and nothing moves.',
  'If destPath already exists, fails with FILE_ALREADY_EXISTS — this never silently overwrites a destination. Delete the destination first (its own hash-guarded call) if you actually want to replace it.',
  'Both sourcePath and destPath must resolve inside the workspace; a symlink at either position is rejected with SYMLINK_ESCAPE. sourcePath equal to destPath fails with INVALID_INPUT.',
  'operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of erroring with FILE_NOT_FOUND on a file the first call already moved.',
  'Requires the overwrite capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it.',
].join(' ');

export function registerFileMoveTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file.move',
    {
      title: 'Move or rename a workspace file, guarded by hash',
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
    async ({ workspaceId, sourcePath, destPath, expectedSha256, operationId }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'file.move',
        riskLevel: 'R3',
        startedAt,
        workspaceId,
        resource: sourcePath,
        ...(operationId === undefined ? {} : { operationId }),
      };
      try {
        const key = operationId === undefined ? undefined : idempotencyKey('file.move', workspaceId, operationId);
        const fingerprint = idempotencyFingerprint(sourcePath, destPath, expectedSha256.toLowerCase());
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'overwrite');
        if (key !== undefined) {
          const cached = getCachedResult(key, fingerprint);
          if (cached !== undefined) {
            return toolSuccess(cached, { context: auditBase, logger: ctx.logger });
          }
        }

        const mutate = () => moveWorkspaceFile(workspace, sourcePath, destPath, expectedSha256.toLowerCase(), {
          withAuthorizedEffect: (effect) => withAuthorizedWorkspaceEffect(ctx.workspaceConfigPath, ctx.logger, workspace, 'overwrite', effect),
        });
        const result = key === undefined ? await mutate() : await runIdempotent(key, fingerprint, mutate);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'file.move', workspaceId }, auditBase);
      }
    },
  );
}
