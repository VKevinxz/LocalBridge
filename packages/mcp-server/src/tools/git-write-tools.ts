import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  commitStaged,
  getCommitSnapshot,
  getGitDiff,
  getGitStatus,
  getPushSnapshot,
  previewPushCommits,
  pushCommits,
  stageFiles,
  type PushResult,
  type PushPreview,
} from '@localbridge/git';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { fromWorkspaceScopePath, toWorkspaceScopePath } from '@localbridge/workspace';
import { LocalBridgeError } from '@localbridge/shared';

import { APPROVAL_TTL_SECONDS, approvalRequestId, hashApprovalContent, resolveApproval, type ApprovalPayload } from '../approval.js';
import { markApprovalResolved, markApprovalWaiting } from '../approval-status.js';
import { getCachedResult, idempotencyFingerprint, idempotencyKey, runIdempotent } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';
import { REPOSITORY_PATH_DESCRIPTION, resolveGitScope, withAuthorizedGitScopeEffect } from './git-scope.js';

/**
 * Git de escritura (ADR-0016, TOOL_CATALOG.md §8-bis). `git.stage` es local y
 * reversible con `git reset`, así que no exige aprobación. `git.commit` y
 * `git.push` sí: cada uno pasa por `resolveApproval`, atado criptográficamente
 * (`hashApprovalContent`) al contenido exacto de la operación — no a "cualquier
 * commit" ni "cualquier push" — para que una aprobación no pueda reutilizarse
 * para otra operación distinta de la que el humano vio.
 *
 * Ninguna de las tres acepta un flag `force`, ni existe forma de que uno llegue
 * a Git desde aquí: ver la cabecera de `packages/git/src/write.ts`.
 */

const APPROVAL_DIFF_MAX_BYTES = 4096;
const REPOSITORY_PATH_SCHEMA = z.string().min(1).default('.');

function buildCommitApprovalMessage(repositoryPath: string, message: string, stagedPaths: readonly string[], diff: { diff: string; truncated: boolean }): string {
  const fileList = stagedPaths.length > 0 ? stagedPaths.join(', ') : '(none)';
  const diffNote = diff.truncated ? '\n\n(diff truncated)' : '';
  return `Create a commit in repository "${repositoryPath}" with message "${message}".\n\nFiles staged (${stagedPaths.length}): ${fileList}\n\nDiff:\n${diff.diff}${diffNote}`;
}

function buildPushApprovalMessage(repositoryPath: string, remote: string | undefined, branch: string | undefined, preview: PushPreview): string {
  const target = `${remote ?? '(default remote)'} ${branch ?? '(current branch)'}`;
  if (!preview.available) {
    return `Push repository "${repositoryPath}" to ${target}.\n\nCould not determine which commits are new relative to the remote (first push of this branch, or no upstream configured) — review git.log / git.status before approving.`;
  }
  if (preview.commits.length === 0) {
    return `Push repository "${repositoryPath}" to ${target}.\n\nNo new commits relative to the remote — this push would be a no-op.`;
  }
  const list = preview.commits.map((commit) => `${commit.hash} ${commit.subject}`).join('\n');
  const truncatedNote = preview.truncated ? '\n(list truncated)' : '';
  return `Push repository "${repositoryPath}" to ${target}.\n\nCommits that would be published (${preview.commits.length}):\n${list}${truncatedNote}`;
}

const LOCAL_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const REMOTE_WRITE_ANNOTATIONS = {
  ...LOCAL_WRITE_ANNOTATIONS,
  openWorldHint: true,
} as const;

function commitApprovalDescription(ctx: ToolContext): string {
  return ctx.config.gitApprovalMode === 'mrtr'
    ? 'Requires human approval via the multi-round-trip protocol: the first call returns an input_required result carrying the exact commit message, the staged file list and a diff preview; approving retries the call, which then creates the commit.'
    : 'Uses the MCP host approval policy. An explicit user request may authorize the call without an extra prompt; once the host delivers it, invoke it once. LocalBridge executes without returning a second input_required round and cannot independently verify how the host authorized the call.';
}

function pushApprovalDescription(ctx: ToolContext): string {
  return ctx.config.gitApprovalMode === 'mrtr'
    ? 'Requires human approval via the multi-round-trip protocol, always — including immediately after approving the commit being pushed. The approval message lists the commits that would be published when they can be determined.'
    : 'Uses the MCP host approval policy for push. An explicit user request may authorize it without an extra prompt; once the host delivers the call, invoke it once. LocalBridge does not return a second input_required round.';
}

export function registerGitStageTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.stage',
    {
      title: 'Stage files for commit',
      description: [
        'Adds workspace-relative paths to the Git index (git add), inside an authorized workspace. Local and fully reversible with a plain git reset, so it does not require human approval.',
        REPOSITORY_PATH_DESCRIPTION,
        'Each path is validated the same way as file.read: it must exist, resolve inside the workspace, and not be blocked by the deny patterns — staging a denied path (for example .env) fails with PATH_DENIED, and staging it does not bypass the denylist for any other tool.',
        'Only regular files within the workspace size limit are accepted. Paths with a Git filter attribute (including Git LFS) are rejected because git add could execute a repository-defined clean filter.',
        'Requires the gitWrite capability.',
      ].join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        repositoryPath: REPOSITORY_PATH_SCHEMA,
        paths: z.array(z.string().min(1)).min(1),
      }).strict(),
      outputSchema: z.object({ staged: z.array(z.string()) }),
      annotations: LOCAL_WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, repositoryPath, paths }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'git.stage', riskLevel: 'R2', startedAt, workspaceId, resource: repositoryPath };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitWrite');
        const scope = await resolveGitScope(workspace, repositoryPath);
        const scopedPaths = await Promise.all(paths.map((filePath) => toWorkspaceScopePath(scope, filePath)));
        const result = await stageFiles(scope.workspace, scopedPaths, {
          withAuthorizedEffect: (effect) => withAuthorizedGitScopeEffect(ctx, scope, 'gitWrite', effect),
        });
        return toolSuccess({ staged: result.staged.map((filePath) => fromWorkspaceScopePath(scope, filePath)) }, { context: auditBase, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.stage', workspaceId }, auditBase);
      }
    },
  );
}

export function registerGitCommitTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.commit',
    {
      title: 'Commit staged changes',
      description: [
        'Creates a commit from whatever is currently staged (git.stage) in an authorized workspace.',
        REPOSITORY_PATH_DESCRIPTION,
        commitApprovalDescription(ctx),
        ctx.config.gitApprovalMode === 'mrtr' ? 'When the first call returns input_required, present its elicitation to the human and wait. Do not repeat git.commit without inputResponses: an identical retry remains pending and cannot create the commit.' : '',
        ctx.config.gitApprovalMode === 'mrtr'
          ? 'The MRTR approval is cryptographically bound to this exact message, staged tree, parent and branch ref. The approved tree is committed with an atomic branch compare-and-swap; hooks and implicit GPG signing are not executed.'
          : 'Execution is bound to the exact staged tree, parent and branch ref captured after the host-approved call arrives. The tree is committed with an atomic branch compare-and-swap; hooks and implicit GPG signing are not executed.',
        'The selected repository must resolve inside the authorized workspace and its complete index must pass the denylist. A staged denylisted path blocks the commit even if another program staged it.',
        'Fails with INVALID_INPUT if nothing is staged. operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of creating a second commit.',
        'Requires the gitWrite capability. Never uses --amend: every call that reaches Git creates a new commit.',
      ].filter((part) => part.length > 0).join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        repositoryPath: REPOSITORY_PATH_SCHEMA,
        message: z.string().min(1).max(4096),
        operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
      }).strict(),
      outputSchema: z.object({ commitHash: z.string() }),
      annotations: LOCAL_WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, repositoryPath, message, operationId }, callCtx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'git.commit',
        riskLevel: 'R3',
        startedAt,
        workspaceId,
        ...(operationId === undefined ? {} : { operationId }),
      };
      try {
        const key = operationId === undefined ? undefined : idempotencyKey('git.commit', workspaceId, operationId);
        const fingerprint = idempotencyFingerprint(repositoryPath, message);
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitWrite');
        const scope = await resolveGitScope(workspace, repositoryPath);
        const status = await getGitStatus(scope.workspace);
        const stagedPaths = status.entries
          .filter((entry) => entry.staged)
          .map((entry) => fromWorkspaceScopePath(scope, entry.path))
          .toSorted();
        const snapshot = await getCommitSnapshot(scope.workspace);
        if (key !== undefined) {
          const cached = getCachedResult<{ result: { commitHash: string }; snapshot: typeof snapshot }>(key, fingerprint);
          if (cached !== undefined) {
            if (stagedPaths.length === 0 && snapshot.parentHash === cached.result.commitHash && snapshot.branchRef === cached.snapshot.branchRef) {
              return toolSuccess(cached.result, { context: { ...auditBase, resource: cached.result.commitHash }, logger: ctx.logger });
            }
            throw new LocalBridgeError('IDEMPOTENCY_CONFLICT', { reason: 'repository state changed since commit operation' });
          }
        }
        if (stagedPaths.length === 0) throw new LocalBridgeError('INVALID_INPUT', { reason: 'nothing staged' });
        if (ctx.config.gitApprovalMode === 'mrtr') {
          const contentHash = hashApprovalContent(scope.relativePath, message, snapshot.treeHash, snapshot.parentHash ?? '', snapshot.branchRef);
          const approvalId = approvalRequestId(ctx.approvalInstanceId, 'git.commit', workspaceId, contentHash);
          const priorApproval = callCtx.mcpReq.requestState<ApprovalPayload>();
          const displayPrefix = scope.relativePath === '.' ? undefined : `${scope.relativePath}/`;
          const diff = await getGitDiff(scope.workspace, undefined, true, APPROVAL_DIFF_MAX_BYTES, displayPrefix);

          try {
            const resolution = await resolveApproval(callCtx, ctx.approvalCodec, {
              action: 'git.commit',
              workspaceId,
              contentHash,
              message: buildCommitApprovalMessage(scope.relativePath, message, stagedPaths, diff),
            });
            if (!resolution.approved) {
              markApprovalWaiting({
                dbPath: ctx.config.auditDbPath,
                logger: ctx.logger,
                action: 'git.commit',
                workspaceId,
                id: approvalId,
                ttlSeconds: APPROVAL_TTL_SECONDS,
              });
              return resolution.ask;
            }
            markApprovalResolved({ dbPath: ctx.config.auditDbPath, logger: ctx.logger, action: 'git.commit', workspaceId, id: approvalId, ttlSeconds: APPROVAL_TTL_SECONDS });
          } catch (error) {
            if (error instanceof LocalBridgeError && error.code === 'APPROVAL_DECLINED') {
              markApprovalResolved({ dbPath: ctx.config.auditDbPath, logger: ctx.logger, action: 'git.commit', workspaceId, id: approvalId, ttlSeconds: APPROVAL_TTL_SECONDS });
            } else if (error instanceof LocalBridgeError && error.code === 'APPROVAL_INVALID') {
              const staleId = priorApproval === undefined
                ? approvalId
                : approvalRequestId(ctx.approvalInstanceId, priorApproval.action, priorApproval.workspaceId, priorApproval.contentHash);
              markApprovalResolved({ dbPath: ctx.config.auditDbPath, logger: ctx.logger, action: 'git.commit', workspaceId, id: staleId, ttlSeconds: APPROVAL_TTL_SECONDS });
            }
            throw error;
          }
        } else {
          ctx.logger.info('git approval delegated to MCP host', { tool: 'git.commit', workspaceId });
        }

        const mutate = async () => ({
          result: await commitStaged(scope.workspace, message, snapshot, {
            withAuthorizedEffect: (effect) => withAuthorizedGitScopeEffect(ctx, scope, 'gitWrite', effect),
          }),
          snapshot,
        });
        const completed = key === undefined ? await mutate() : await runIdempotent(key, fingerprint, mutate);
        const result = completed.result;

        return toolSuccess(result, { context: { ...auditBase, resource: result.commitHash }, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.commit', workspaceId }, auditBase);
      }
    },
  );
}

export function registerGitPushTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.push',
    {
      title: 'Push commits to a remote',
      description: [
        'Pushes the current branch to a remote from an authorized workspace. Omit remote and branch to push to the configured upstream; pass both to target a specific remote/branch.',
        REPOSITORY_PATH_DESCRIPTION,
        pushApprovalDescription(ctx),
        ctx.config.gitApprovalMode === 'mrtr' ? 'When the first call returns input_required, present its elicitation to the human and wait. Do not repeat git.push without inputResponses: an identical retry remains pending and cannot publish anything.' : '',
        ctx.config.gitApprovalMode === 'mrtr'
          ? 'The MRTR approval is cryptographically bound to the exact HEAD, remote, branch and resolved push URL. Execution publishes that exact hash to that exact destination even if HEAD or remote configuration changes afterward.'
          : 'Execution is bound to the exact HEAD, remote, branch and resolved push URL captured after the host-approved call arrives. It publishes that exact hash to that exact destination even if HEAD or remote configuration changes afterward.',
        'The selected repository must resolve inside the authorized workspace. Repository hooks, repository credential helpers, remote helpers and URL rewrites are not executed; only safe protocols and system/user credential helpers are accepted.',
        'Never force-pushes: there is no parameter that produces --force or --force-with-lease. A rejection from the remote (for example, non-fast-forward) fails with GIT_PUSH_REJECTED, which is never retried automatically with force.',
        'A successful result distinguishes pushed from up_to_date, verifies the remote branch by hash, and reports whether the matching local remote-tracking ref is synchronized. Do not retry a successful push merely because localTrackingSynchronized is false.',
        'operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of pushing twice.',
        'Requires the gitWrite capability.',
      ].filter((part) => part.length > 0).join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        repositoryPath: REPOSITORY_PATH_SCHEMA,
        remote: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
      }).strict().refine((value) => (value.remote === undefined) === (value.branch === undefined), {
        message: 'remote and branch must be provided together',
      }),
      outputSchema: z.object({
        status: z.enum(['pushed', 'up_to_date']),
        commitHash: z.string(),
        remote: z.string(),
        branch: z.string(),
        remoteVerified: z.boolean(),
        localTrackingSynchronized: z.boolean(),
      }),
      annotations: REMOTE_WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, repositoryPath, remote, branch, operationId }, callCtx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      const startedAt = Date.now();
      const auditBase = {
        dbPath: ctx.config.auditDbPath,
        tool: 'git.push',
        riskLevel: 'R3',
        startedAt,
        workspaceId,
        ...(operationId === undefined ? {} : { operationId }),
      };
      try {
        const key = operationId === undefined ? undefined : idempotencyKey('git.push', workspaceId, operationId);
        const fingerprint = idempotencyFingerprint(repositoryPath, remote ?? '', branch ?? '');
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitWrite');
        const scope = await resolveGitScope(workspace, repositoryPath);
        const snapshot = await getPushSnapshot(scope.workspace, remote, branch);
        if (key !== undefined) {
          const cached = getCachedResult<{ result: PushResult; snapshot: typeof snapshot }>(key, fingerprint);
          if (cached !== undefined) {
            if (snapshot.headHash === cached.snapshot.headHash && snapshot.remote === cached.snapshot.remote &&
                snapshot.branch === cached.snapshot.branch && snapshot.remoteUrl === cached.snapshot.remoteUrl) {
              return toolSuccess(cached.result, { context: { ...auditBase, resource: cached.result.commitHash }, logger: ctx.logger });
            }
            throw new LocalBridgeError('IDEMPOTENCY_CONFLICT', { reason: 'repository state changed since push operation' });
          }
        }
        if (ctx.config.gitApprovalMode === 'mrtr') {
          const contentHash = hashApprovalContent(scope.relativePath, snapshot.remote, snapshot.branch, snapshot.headHash, snapshot.remoteUrl);
          const approvalId = approvalRequestId(ctx.approvalInstanceId, 'git.push', workspaceId, contentHash);
          const priorApproval = callCtx.mcpReq.requestState<ApprovalPayload>();
          const preview = await previewPushCommits(scope.workspace, snapshot);

          try {
            const resolution = await resolveApproval(callCtx, ctx.approvalCodec, {
              action: 'git.push',
              workspaceId,
              contentHash,
              message: buildPushApprovalMessage(scope.relativePath, snapshot.remote, snapshot.branch, preview),
            });
            if (!resolution.approved) {
              markApprovalWaiting({
                dbPath: ctx.config.auditDbPath,
                logger: ctx.logger,
                action: 'git.push',
                workspaceId,
                id: approvalId,
                ttlSeconds: APPROVAL_TTL_SECONDS,
              });
              return resolution.ask;
            }
            markApprovalResolved({ dbPath: ctx.config.auditDbPath, logger: ctx.logger, action: 'git.push', workspaceId, id: approvalId, ttlSeconds: APPROVAL_TTL_SECONDS });
          } catch (error) {
            if (error instanceof LocalBridgeError && error.code === 'APPROVAL_DECLINED') {
              markApprovalResolved({ dbPath: ctx.config.auditDbPath, logger: ctx.logger, action: 'git.push', workspaceId, id: approvalId, ttlSeconds: APPROVAL_TTL_SECONDS });
            } else if (error instanceof LocalBridgeError && error.code === 'APPROVAL_INVALID') {
              const staleId = priorApproval === undefined
                ? approvalId
                : approvalRequestId(ctx.approvalInstanceId, priorApproval.action, priorApproval.workspaceId, priorApproval.contentHash);
              markApprovalResolved({ dbPath: ctx.config.auditDbPath, logger: ctx.logger, action: 'git.push', workspaceId, id: staleId, ttlSeconds: APPROVAL_TTL_SECONDS });
            }
            throw error;
          }
        } else {
          ctx.logger.info('git approval delegated to MCP host', { tool: 'git.push', workspaceId });
        }

        const mutate = async () => ({
          result: await pushCommits(scope.workspace, snapshot, {
            withAuthorizedEffect: (effect) => withAuthorizedGitScopeEffect(ctx, scope, 'gitWrite', effect),
          }),
          snapshot,
        });
        const completed = key === undefined ? await mutate() : await runIdempotent(key, fingerprint, mutate);
        const result = completed.result;

        return toolSuccess(result, { context: { ...auditBase, resource: result.commitHash }, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.push', workspaceId }, auditBase);
      }
    },
  );
}
