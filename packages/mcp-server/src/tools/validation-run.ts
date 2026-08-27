import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { runValidation } from '@localbridge/validation';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/** `validation.run` — riesgo R4, permiso `validations` (TOOL_CATALOG.md §9). */

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  profile: z.string().min(1),
});

const outputSchema = z.object({
  profile: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
  timedOut: z.literal(false),
});

const DESCRIPTION = [
  'Runs a preapproved validation profile (for example "test", "lint", "typecheck" or "build") inside an authorized workspace and returns its output.',
  'The profile is chosen by name only. The actual command, its arguments, its environment and its working directory are fixed by the workspace configuration and are never visible to or overridable by the model — there is no way to run an arbitrary command through this tool.',
  'A non-zero exitCode is a normal, valid result, not a tool error: it means the underlying command (e.g. the test suite) failed, and the agent should read stdout/stderr to see why. The only tool-level errors are an unrecognized profile (COMMAND_NOT_ALLOWED) and exceeding the time limit (TIMEOUT).',
  'stdout and stderr are truncated at a fixed size; when truncated is true the output is partial. Only one validation runs at a time per workspace — a second call waits for the first to finish.',
  'Requires the validations capability on the workspace.',
].join(' ');

export function registerValidationRunTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'validation.run',
    {
      title: 'Run a preapproved validation profile',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, profile }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'validation.run',
        riskLevel: 'R4',
        startedAt,
        workspaceId,
        resource: profile,
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'validations');
        const result = await runValidation(workspace, profile);
        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'validation.run', workspaceId, profile }, auditBase);
      }
    },
  );
}
