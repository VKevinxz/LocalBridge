import {
  recordPendingApproval,
  resolvePendingApproval,
  type PendingApproval,
} from "@localbridge/audit";
import type { Logger } from "@localbridge/shared";

interface ApprovalStatusContext {
  readonly dbPath: string;
  readonly logger: Logger;
  readonly action: PendingApproval["action"];
  readonly workspaceId: string;
}

interface WaitingApprovalContext extends ApprovalStatusContext {
  readonly id: string;
  readonly ttlSeconds: number;
}

/** La observabilidad nunca es una puerta de autorización. */
export function markApprovalWaiting(context: WaitingApprovalContext): void {
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + context.ttlSeconds * 1_000);
  try {
    const persisted = recordPendingApproval(context.dbPath, {
      id: context.id,
      requestedAt: requestedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      workspaceId: context.workspaceId,
      action: context.action,
    });
    context.logger.info(persisted === undefined ? "approval resolved" : "approval waiting", {
      tool: context.action,
      workspaceId: context.workspaceId,
      ...(persisted === undefined ? {} : { expiresAt: persisted.expiresAt }),
    });
  } catch (error) {
    context.logger.error("approval status write failed", { tool: context.action, workspaceId: context.workspaceId, error });
  }
}

export function markApprovalResolved(context: ApprovalStatusContext & { readonly id: string; readonly ttlSeconds: number }): void {
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + context.ttlSeconds * 1_000);
  try {
    resolvePendingApproval(context.dbPath, {
      id: context.id,
      requestedAt: requestedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      workspaceId: context.workspaceId,
      action: context.action,
    });
    context.logger.info("approval resolved", { tool: context.action, workspaceId: context.workspaceId });
  } catch (error) {
    context.logger.error("approval status write failed", { tool: context.action, workspaceId: context.workspaceId, error });
  }
}
