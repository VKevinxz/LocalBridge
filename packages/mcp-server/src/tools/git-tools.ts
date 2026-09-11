import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { getGitBranches, getGitDiff, getGitLog, getGitStatus } from '@localbridge/git';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { fromWorkspaceScopePath, toWorkspaceScopePath } from '@localbridge/workspace';

import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';
import { REPOSITORY_PATH_DESCRIPTION, resolveGitScope } from './git-scope.js';

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
  'Paths in both the arguments and the results are relative to the workspace root, consistent with file.read and workspace.tree. When repositoryPath selects an internal repository, returned file paths retain that prefix. Results never include changes outside the selected repository or authorized workspace.';

const REPOSITORY_PATH_SCHEMA = z.string().min(1).default('.');

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
        REPOSITORY_PATH_DESCRIPTION,
        PATHS_NOTE,
        'Requires the gitRead capability. Fails with GIT_NOT_REPOSITORY if the workspace is not inside a Git repository.',
      ].join(' '),
      inputSchema: z.object({ workspaceId: z.string().min(1), repositoryPath: REPOSITORY_PATH_SCHEMA }).strict(),
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
      }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId, repositoryPath }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'git.status', riskLevel: 'R1', startedAt, workspaceId, resource: repositoryPath };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        const scope = await resolveGitScope(workspace, repositoryPath);
        const status = await getGitStatus(scope.workspace);
        return toolSuccess({
          ...status,
          entries: status.entries.map((entry) => ({
            path: fromWorkspaceScopePath(scope, entry.path),
            status: entry.status,
            staged: entry.staged,
            unstaged: entry.unstaged,
          })),
        }, { context: auditBase, logger: ctx.logger });
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
        REPOSITORY_PATH_DESCRIPTION,
        'The diff is truncated at maxBytes; when truncated is true the output is partial, so do not treat it as a complete patch.',
        PATHS_NOTE,
        'Requires the gitRead capability.',
      ].join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        repositoryPath: REPOSITORY_PATH_SCHEMA,
        filePath: z.string().min(1).optional(),
        staged: z.boolean().default(false),
        maxBytes: z.number().int().positive().optional(),
      }).strict(),
      outputSchema: z.object({
        diff: z.string(),
        staged: z.boolean(),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId, repositoryPath, filePath, staged, maxBytes }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'git.diff',
        riskLevel: 'R1',
        startedAt,
        workspaceId,
        resource: filePath ?? repositoryPath,
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        const scope = await resolveGitScope(workspace, repositoryPath);
        const scopedFilePath = filePath === undefined ? undefined : await toWorkspaceScopePath(scope, filePath);
        const displayPrefix = scope.relativePath === '.' ? undefined : `${scope.relativePath}/`;
        return toolSuccess(await getGitDiff(scope.workspace, scopedFilePath, staged, maxBytes, displayPrefix), { context: auditBase, logger: ctx.logger });
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
        REPOSITORY_PATH_DESCRIPTION,
        PATHS_NOTE,
        'Requires the gitRead capability.',
      ].join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        repositoryPath: REPOSITORY_PATH_SCHEMA,
        maxCount: z.number().int().positive().optional(),
        filePath: z.string().min(1).optional(),
      }).strict(),
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
    async ({ workspaceId, repositoryPath, maxCount, filePath }) => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'git.log',
        riskLevel: 'R1',
        startedAt,
        workspaceId,
        resource: filePath ?? repositoryPath,
      };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        const scope = await resolveGitScope(workspace, repositoryPath);
        const scopedFilePath = filePath === undefined ? undefined : await toWorkspaceScopePath(scope, filePath);
        return toolSuccess(await getGitLog(scope.workspace, maxCount, scopedFilePath), { context: auditBase, logger: ctx.logger });
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
        REPOSITORY_PATH_DESCRIPTION,
        'Requires the gitRead capability.',
      ].join(' '),
      inputSchema: z.object({ workspaceId: z.string().min(1), repositoryPath: REPOSITORY_PATH_SCHEMA }).strict(),
      outputSchema: z.object({
        current: z.string().optional(),
        branches: z.array(z.string()),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ workspaceId, repositoryPath }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'git.branch', riskLevel: 'R1', startedAt, workspaceId, resource: repositoryPath };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitRead');
        const scope = await resolveGitScope(workspace, repositoryPath);
        return toolSuccess(await getGitBranches(scope.workspace), { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.branch', workspaceId }, auditBase);
      }
    },
  );
}
