import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { getGitBranches, getGitDiff, getGitLog, getGitStatus } from '@localbridge/git';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

/**
 * Git de solo lectura (TOOL_CATALOG.md §8). Las cuatro tools son cerradas:
 * ninguna acepta una cadena Git, un flag ni un nombre de subcomando. El
 * servidor construye cada array de argumentos; el agente solo aporta valores
 * acotados que viajan después de `--` como pathspec literal.
 *
 * Nota de contrato compartida por las cuatro: las rutas de entrada y de salida
 * son **relativas al workspace**, igual que en `file.read`. Si el workspace es
 * un subdirectorio de un repositorio mayor, la salida se acota a él y se
 * traduce — un agente nunca ve rutas del repositorio que caigan fuera de su
 * workspace autorizado.
 */

const PATHS_NOTE =
  'Paths in both the arguments and the results are relative to the workspace root, consistent with file.read and workspace.tree. If the workspace is a subdirectory of a larger Git repository, results are scoped to the workspace: changes elsewhere in the repository are never reported.';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function registerGitStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.status',
    {
      title: 'Git status',
      description: [
        'Reports the Git working tree status of an authorized workspace: current branch, upstream tracking, ahead/behind counts, and the list of changed files.',
        'Each entry reports whether the change is staged, unstaged, or both, using the porcelain v2 XY code.',
        PATHS_NOTE,
        'Requires the gitRead capability. Fails with GIT_NOT_REPOSITORY if the workspace is not inside a Git repository.',
      ].join(' '),
      inputSchema: z.object({ workspaceId: z.string().min(1) }),
      outputSchema: z.object({
        branch: z.string().optional(),
        upstream: z.string().optional(),
        ahead: z.number().optional(),
        behind: z.number().optional(),
        entries: z.array(
          z.object({
            path: z.string(),
            status: z.string(),
            staged: z.boolean(),
            unstaged: z.boolean(),
          }),
        ),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'git.status', riskLevel: 'R1', startedAt, workspaceId };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        return toolSuccess(await getGitStatus(workspace), { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.status', workspaceId }, auditBase);
      }
    },
  );
}

export function registerGitDiffTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.diff',
    {
      title: 'Git diff',
      description: [
        'Returns the Git diff for an authorized workspace, either of the working tree (default) or of the staged changes (staged: true).',
        'Omit filePath to diff everything inside the workspace, or pass a single workspace-relative path to narrow it.',
        'The diff is truncated at maxBytes; when truncated is true the output is partial, so do not treat it as a complete patch.',
        PATHS_NOTE,
        'Requires the gitRead capability.',
      ].join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        filePath: z.string().min(1).optional(),
        staged: z.boolean().default(false),
        maxBytes: z.number().int().positive().optional(),
      }),
      outputSchema: z.object({
        diff: z.string(),
        staged: z.boolean(),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId, filePath, staged, maxBytes }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'git.diff',
        riskLevel: 'R1',
        startedAt,
        workspaceId,
        ...(filePath === undefined ? {} : { resource: filePath }),
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        return toolSuccess(await getGitDiff(workspace, filePath, staged, maxBytes), { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.diff', workspaceId }, auditBase);
      }
    },
  );
}

export function registerGitLogTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.log',
    {
      title: 'Git log',
      description: [
        'Returns recent commits touching an authorized workspace: short hash, author name, ISO-8601 date and subject line.',
        'maxCount defaults to 20 and is capped at 100 regardless of the value requested.',
        'Pass filePath to limit the history to a single workspace-relative path.',
        PATHS_NOTE,
        'Requires the gitRead capability.',
      ].join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        maxCount: z.number().int().positive().optional(),
        filePath: z.string().min(1).optional(),
      }),
      outputSchema: z.object({
        entries: z.array(
          z.object({
            hash: z.string(),
            author: z.string(),
            date: z.string(),
            subject: z.string(),
          }),
        ),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId, maxCount, filePath }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'git.log',
        riskLevel: 'R1',
        startedAt,
        workspaceId,
        ...(filePath === undefined ? {} : { resource: filePath }),
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        return toolSuccess(await getGitLog(workspace, maxCount, filePath), { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.log', workspaceId }, auditBase);
      }
    },
  );
}

export function registerGitBranchTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.branch',
    {
      title: 'Git branches',
      description: [
        'Lists the local branches of the repository containing an authorized workspace, and which one is currently checked out.',
        'Remote-tracking branches are not listed. current is undefined when HEAD is detached.',
        'Requires the gitRead capability.',
      ].join(' '),
      inputSchema: z.object({ workspaceId: z.string().min(1) }),
      outputSchema: z.object({
        current: z.string().optional(),
        branches: z.array(z.string()),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'git.branch', riskLevel: 'R1', startedAt, workspaceId };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        return toolSuccess(await getGitBranches(workspace), { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.branch', workspaceId }, auditBase);
      }
    },
  );
}
