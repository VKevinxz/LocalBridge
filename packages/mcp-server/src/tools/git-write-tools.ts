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
import { LocalBridgeError } from '@localbridge/shared';

import { APPROVAL_TTL_SECONDS, approvalRequestId, hashApprovalContent, resolveApproval, type ApprovalPayload } from '../approval.js';
import { markApprovalResolved, markApprovalWaiting } from '../approval-status.js';
import { cacheResult, getCachedResult, idempotencyKey } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

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

function buildCommitApprovalMessage(message: string, stagedPaths: readonly string[], diff: { diff: string; truncated: boolean }): string {
  const fileList = stagedPaths.length > 0 ? stagedPaths.join(', ') : '(none)';
  const diffNote = diff.truncated ? '\n\n(diff truncated)' : '';
  return `Create a commit with message "${message}".\n\nFiles staged (${stagedPaths.length}): ${fileList}\n\nDiff:\n${diff.diff}${diffNote}`;
}

function buildPushApprovalMessage(remote: string | undefined, branch: string | undefined, preview: PushPreview): string {
  const target = `${remote ?? '(default remote)'} ${branch ?? '(current branch)'}`;
  if (!preview.available) {
    return `Push to ${target}.\n\nCould not determine which commits are new relative to the remote (first push of this branch, or no upstream configured) — review git.log / git.status before approving.`;
  }
  if (preview.commits.length === 0) {
    return `Push to ${target}.\n\nNo new commits relative to the remote — this push would be a no-op.`;
  }
  const list = preview.commits.map((commit) => `${commit.hash} ${commit.subject}`).join('\n');
  const truncatedNote = preview.truncated ? '\n(list truncated)' : '';
  return `Push to ${target}.\n\nCommits that would be published (${preview.commits.length}):\n${list}${truncatedNote}`;
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
    : 'Uses the MCP host native approval UI. After ChatGPT approves this tool call, invoke it once: LocalBridge executes without returning a second input_required round. This mode is an explicit compatibility setting; LocalBridge cannot independently verify the host button.';
}

function pushApprovalDescription(ctx: ToolContext): string {
  return ctx.config.gitApprovalMode === 'mrtr'
    ? 'Requires human approval via the multi-round-trip protocol, always — including immediately after approving the commit being pushed. The approval message lists the commits that would be published when they can be determined.'
    : 'Uses a separate MCP host native approval for push, even after commit was approved. After ChatGPT approves this tool call, invoke it once: LocalBridge does not return a second input_required round.';
}

export function registerGitStageTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'git.stage',
    {
      title: 'Stage files for commit',
      description: [
        'Adds workspace-relative paths to the Git index (git add), inside an authorized workspace. Local and fully reversible with a plain git reset, so it does not require human approval.',
        'Each path is validated the same way as file.read: it must exist, resolve inside the workspace, and not be blocked by the deny patterns — staging a denied path (for example .env) fails with PATH_DENIED, and staging it does not bypass the denylist for any other tool.',
        'Only regular files within the workspace size limit are accepted. Paths with a Git filter attribute (including Git LFS) are rejected because git add could execute a repository-defined clean filter.',
        'Requires the gitWrite capability.',
      ].join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
      }),
      outputSchema: z.object({ staged: z.array(z.string()) }),
      annotations: LOCAL_WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, paths }) => {
      const startedAt = Date.now();
      const auditBase = { dbPath: ctx.config.auditDbPath, tool: 'git.stage', riskLevel: 'R2', startedAt, workspaceId };
      try {
        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitWrite');
        const result = await stageFiles(workspace, paths);
        return toolSuccess(result, { context: auditBase, logger: ctx.logger });
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
        commitApprovalDescription(ctx),
        ctx.config.gitApprovalMode === 'mrtr' ? 'When the first call returns input_required, present its elicitation to the human and wait. Do not repeat git.commit without inputResponses: an identical retry remains pending and cannot create the commit.' : '',
        ctx.config.gitApprovalMode === 'mrtr'
          ? 'The MRTR approval is cryptographically bound to this exact message, staged tree, parent and branch ref. The approved tree is committed with an atomic branch compare-and-swap; hooks and implicit GPG signing are not executed.'
          : 'Execution is bound to the exact staged tree, parent and branch ref captured after the host-approved call arrives. The tree is committed with an atomic branch compare-and-swap; hooks and implicit GPG signing are not executed.',
        'The authorized workspace must be the repository root. A staged denylisted path blocks the commit even if another program staged it.',
        'Fails with INVALID_INPUT if nothing is staged. operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of creating a second commit.',
        'Requires the gitWrite capability. Never uses --amend: every call that reaches Git creates a new commit.',
      ].filter((part) => part.length > 0).join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        message: z.string().min(1).max(4096),
        operationId: z.string().min(1).optional(),
      }),
      outputSchema: z.object({ commitHash: z.string() }),
      annotations: LOCAL_WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, message, operationId }, callCtx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
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
        if (key !== undefined) {
          const cached = getCachedResult<{ commitHash: string }>(key);
          if (cached !== undefined) {
            return toolSuccess(cached, { context: { ...auditBase, resource: cached.commitHash }, logger: ctx.logger });
          }
        }

        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitWrite');

        const status = await getGitStatus(workspace);
        const stagedPaths = status.entries
          .filter((entry) => entry.staged)
          .map((entry) => entry.path)
          .toSorted();
        if (stagedPaths.length === 0) {
          throw new LocalBridgeError('INVALID_INPUT', { reason: 'nothing staged' });
        }

        const snapshot = await getCommitSnapshot(workspace);
        if (ctx.config.gitApprovalMode === 'mrtr') {
          const contentHash = hashApprovalContent(message, snapshot.treeHash, snapshot.parentHash, snapshot.branchRef);
          const approvalId = approvalRequestId(ctx.approvalInstanceId, 'git.commit', workspaceId, contentHash);
          const priorApproval = callCtx.mcpReq.requestState<ApprovalPayload>();
          const diff = await getGitDiff(workspace, undefined, true, APPROVAL_DIFF_MAX_BYTES);

          try {
            const resolution = await resolveApproval(callCtx, ctx.approvalCodec, {
              action: 'git.commit',
              workspaceId,
              contentHash,
              message: buildCommitApprovalMessage(message, stagedPaths, diff),
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

        const result = await commitStaged(workspace, message, snapshot);

        if (key !== undefined) cacheResult(key, result);

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
        pushApprovalDescription(ctx),
        ctx.config.gitApprovalMode === 'mrtr' ? 'When the first call returns input_required, present its elicitation to the human and wait. Do not repeat git.push without inputResponses: an identical retry remains pending and cannot publish anything.' : '',
        ctx.config.gitApprovalMode === 'mrtr'
          ? 'The MRTR approval is cryptographically bound to the exact HEAD, remote, branch and resolved push URL. Execution publishes that exact hash to that exact destination even if HEAD or remote configuration changes afterward.'
          : 'Execution is bound to the exact HEAD, remote, branch and resolved push URL captured after the host-approved call arrives. It publishes that exact hash to that exact destination even if HEAD or remote configuration changes afterward.',
        'The authorized workspace must be the repository root. Repository hooks, credential helpers, remote helpers and URL rewrites are not executed; only safe protocols and system/user credential helpers are accepted.',
        'Never force-pushes: there is no parameter that produces --force or --force-with-lease. A rejection from the remote (for example, non-fast-forward) fails with GIT_PUSH_REJECTED, which is never retried automatically with force.',
        'A successful result distinguishes pushed from up_to_date, verifies the remote branch by hash, and reports whether the matching local remote-tracking ref is synchronized. Do not retry a successful push merely because localTrackingSynchronized is false.',
        'operationId is optional: pass the same value on a retry after a broken connection to get back the original result instead of pushing twice.',
        'Requires the gitWrite capability.',
      ].filter((part) => part.length > 0).join(' '),
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        remote: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        operationId: z.string().min(1).optional(),
      }).refine((value) => (value.remote === undefined) === (value.branch === undefined), {
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
    async ({ workspaceId, remote, branch, operationId }, callCtx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
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
        if (key !== undefined) {
          const cached = getCachedResult<PushResult>(key);
          if (cached !== undefined) {
            return toolSuccess(cached, { context: { ...auditBase, resource: cached.commitHash }, logger: ctx.logger });
          }
        }

        const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'gitWrite');

        const snapshot = await getPushSnapshot(workspace, remote, branch);
        if (ctx.config.gitApprovalMode === 'mrtr') {
          const contentHash = hashApprovalContent(snapshot.remote, snapshot.branch, snapshot.headHash, snapshot.remoteUrl);
          const approvalId = approvalRequestId(ctx.approvalInstanceId, 'git.push', workspaceId, contentHash);
          const priorApproval = callCtx.mcpReq.requestState<ApprovalPayload>();
          const preview = await previewPushCommits(workspace, snapshot);

          try {
            const resolution = await resolveApproval(callCtx, ctx.approvalCodec, {
              action: 'git.push',
              workspaceId,
              contentHash,
              message: buildPushApprovalMessage(snapshot.remote, snapshot.branch, preview),
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

        const result = await pushCommits(workspace, snapshot);

        if (key !== undefined) cacheResult(key, result);

        return toolSuccess(result, { context: { ...auditBase, resource: result.commitHash }, logger: ctx.logger });
      } catch (error) {
        return toolError(error, ctx.logger, { tool: 'git.push', workspaceId }, auditBase);
      }
    },
  );
}
