import { queryAuditEvents, queryPendingApprovals, type AuditEvent, type AuditQuery, type PendingApproval } from "@localbridge/audit";

export function listAuditEvents(dbPath: string, query: AuditQuery = {}): AuditEvent[] {
  return queryAuditEvents(dbPath, query);
}

export function listPendingApprovals(dbPath: string): PendingApproval[] {
  return queryPendingApprovals(dbPath);
}

export type { AuditEvent, AuditQuery, PendingApproval };
