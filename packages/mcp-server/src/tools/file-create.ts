import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { createWorkspaceFile } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace, withAuthorizedWorkspaceEffect } from '@localbridge/permissions';

import { getCachedResult, idempotencyFingerprint, idempotencyKey, runIdempotent } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `file.create` — riesgo R2, permiso `write` (TOOL_CATALOG.md §6). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();

const outputSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
  created: z.literal(true),
});

const DESCRIPTION = [
  'Creates a new file inside an authorized workspace. Fails with FILE_ALREADY_EXISTS if the path already exists — never overwrites; use file.write_guarded for an existing file instead.',
  'Missing parent directories are created automatically, but only inside the workspace root.',
  'Any symlink at the target path is rejected with SYMLINK_ESCAPE, whether it resolves inside or outside the workspace and whether its destination currently exists or not — writing through a symlink is never allowed.',
  'operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of creating the file twice.',
  'Requires the write capability on the workspace; fails with CAPABILITY_DISABLED if the workspace does not grant it.',
].join(' ');

export function registerFileCreateTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'file.create',
    {
      title: 'Create a workspace file',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path, content, operationId }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'file.create',
        riskLevel: 'R2',
        startedAt,
        workspaceId,
        resource: path,
        ...(operationId === undefined ? {} : { operationId }),
      };
      try {
        const key = operationId === undefined ? undefined : idempotencyKey('file.create', workspaceId, operationId);
        const fingerprint = idempotencyFingerprint(path, content);
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
        if (key !== undefined) {
          const cached = getCachedResult(key, fingerprint);
          if (cached !== undefined) {
            return toolSuccess(cached, { context: auditBase, logger: ctx.logger });
          }
        }

        const mutate = () => createWorkspaceFile(workspace, path, content, {
          withAuthorizedEffect: (effect) => withAuthorizedWorkspaceEffect(ctx.workspaceConfigPath, ctx.logger, workspace, 'write', effect),
        });
        const result = key === undefined ? await mutate() : await runIdempotent(key, fingerprint, mutate);

        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'file.create', workspaceId }, auditBase);
      }
    },
  );
}
