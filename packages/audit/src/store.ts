/**
 * Persistencia de auditoría (ADR-0014). Sin conexión persistente ni caché: cada
 * llamada abre la base, asegura el esquema, opera, y cierra — mismo patrón que
 * el registro de workspaces (ADR-0012), deliberado por consistencia.
 *
 * `node:sqlite` es experimental en Node 22; su advertencia se suprime de forma
 * dirigida en `apps/server/src/index.ts`, no aquí (este módulo no decide cómo
 * se comporta el proceso completo).
 */

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { AuditEvent, PendingApproval } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  workspace_id TEXT,
  action       TEXT NOT NULL,
  resource     TEXT,
  risk_level   TEXT NOT NULL,
  decision     TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  error_code   TEXT,
  operation_id TEXT,
  duration_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_events_workspace ON audit_events (workspace_id);
CREATE TABLE IF NOT EXISTS pending_approvals (
  id           TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_expiry ON pending_approvals (expires_at);
`;

function openDatabase(dbPath: string): DatabaseSync {
  // `DatabaseSync` no crea el directorio padre por su cuenta, a diferencia del
  // registro de workspaces (que usa `fs.mkdir` explícito por el mismo motivo).
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  // Sin esto, `DatabaseSync` falla al instante con "database is locked"
  // (SQLITE_BUSY) en vez de esperar — verificado con escrituras concurrentes
  // desde procesos de servidor distintos (dos clientes MCP a la vez, cada uno
  // con su propio proceso stdio). Con busy_timeout, un escritor espera a que
  // el otro termine en vez de perder el evento.
  db.exec("PRAGMA busy_timeout = 5000;");
  // WAL: las inserciones concurrentes desde llamadas de lectura simultáneas no
  // se bloquean entre sí a nivel de archivo completo.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const pendingColumns = db.prepare("PRAGMA table_info(pending_approvals)").all() as Array<Record<string, unknown>>;
  if (!pendingColumns.some((column) => String(column["name"]) === "status")) {
    db.exec("ALTER TABLE pending_approvals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';");
  }
  return db;
}

/**
 * Registra un evento. Síncrono a propósito: `DatabaseSync` no ofrece una API
 * asíncrona, y una inserción de una fila es lo bastante rápida como para no
 * justificar moverla a un worker para el volumen esperado en v1.
 */
export function recordAuditEvent(dbPath: string, event: AuditEvent): void {
  const db = openDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO audit_events
        (id, timestamp, request_id, workspace_id, action, resource, risk_level, decision, outcome, error_code, operation_id, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.timestamp,
      event.requestId,
      event.workspaceId ?? null,
      event.action,
      event.resource ?? null,
      event.riskLevel,
      event.decision,
      event.outcome,
      event.errorCode ?? null,
      event.operationId ?? null,
      event.durationMs,
    );
  } finally {
    db.close();
  }
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * Reconstruye un `AuditEvent` desde una fila. Construcción imperativa, no un
 * objeto-literal con spreads condicionales: bajo `exactOptionalPropertyTypes`,
 * un spread condicional termina infiriendo `campo?: string | undefined` en vez
 * de `campo?: string`, que `AuditEvent` no acepta — asignar solo cuando hay
 * valor evita el problema en su origen.
 */
function rowToAuditEvent(row: Record<string, unknown>): AuditEvent {
  const event: AuditEvent = {
    id: String(row["id"]),
    timestamp: String(row["timestamp"]),
    requestId: String(row["request_id"]),
    action: String(row["action"]),
    riskLevel: String(row["risk_level"]),
    decision: row["decision"] as "allow" | "deny",
    outcome: row["outcome"] as "success" | "error",
    durationMs: Number(row["duration_ms"]),
  };

  const workspaceId = optionalString(row["workspace_id"]);
  const resource = optionalString(row["resource"]);
  const errorCode = optionalString(row["error_code"]);
  const operationId = optionalString(row["operation_id"]);

  return {
    ...event,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(operationId !== undefined ? { operationId } : {}),
  };
}

export function readAllAuditEvents(dbPath: string): AuditEvent[] {
  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY timestamp ASC").all() as Array<Record<string, unknown>>;
    return rows.map(rowToAuditEvent);
  } finally {
    db.close();
  }
}

export interface AuditQuery {
  readonly workspaceId?: string;
  readonly action?: string;
  readonly outcome?: "success" | "error";
  readonly limit?: number;
}

export function queryAuditEvents(dbPath: string, query: AuditQuery = {}): AuditEvent[] {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (query.workspaceId !== undefined) {
    conditions.push("workspace_id = ?");
    parameters.push(query.workspaceId);
  }
  if (query.action !== undefined) {
    conditions.push("action = ?");
    parameters.push(query.action);
  }
  if (query.outcome !== undefined) {
    conditions.push("outcome = ?");
    parameters.push(query.outcome);
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  parameters.push(limit);
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const db = openDatabase(dbPath);
  try {
    const rows = db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...parameters) as Array<Record<string, unknown>>;
    return rows.map(rowToAuditEvent);
  } finally {
    db.close();
  }
}

/**
 * Registra una espera MRTR sin persistir el contenido que se está aprobando.
 * Un host que reintenta la misma primera ronda produce el mismo `id`; el
 * `INSERT OR IGNORE` conserva el inicio y la expiración originales en vez de
 * prolongar indefinidamente la solicitud con cada reintento.
 */
const MAX_PENDING_APPROVALS = 100;

export function recordPendingApproval(dbPath: string, approval: PendingApproval): PendingApproval | undefined {
  const db = openDatabase(dbPath);
  try {
    db.prepare("DELETE FROM pending_approvals WHERE expires_at <= ?").run(approval.requestedAt);
    db.prepare(
      `INSERT INTO pending_approvals
        (id, requested_at, expires_at, workspace_id, action, status)
       VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(id) DO UPDATE SET
         requested_at = excluded.requested_at,
         expires_at = excluded.expires_at
       WHERE pending_approvals.status = 'pending'`,
    ).run(approval.id, approval.requestedAt, approval.expiresAt, approval.workspaceId, approval.action);
    db.prepare(
      `DELETE FROM pending_approvals
       WHERE status = 'pending' AND id NOT IN (
         SELECT id FROM pending_approvals
         WHERE status = 'pending'
         ORDER BY requested_at DESC
         LIMIT ?
       )`,
    ).run(MAX_PENDING_APPROVALS);
    const row = db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(approval.id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("pending approval could not be persisted");
    return String(row["status"]) === "pending" ? rowToPendingApproval(row) : undefined;
  } finally {
    db.close();
  }
}

export function resolvePendingApproval(dbPath: string, approval: PendingApproval): void {
  const db = openDatabase(dbPath);
  try {
    db.prepare("DELETE FROM pending_approvals WHERE expires_at <= ?").run(approval.requestedAt);
    db.prepare(
      `INSERT INTO pending_approvals
        (id, requested_at, expires_at, workspace_id, action, status)
       VALUES (?, ?, ?, ?, ?, 'resolved')
       ON CONFLICT(id) DO UPDATE SET
         status = 'resolved',
         expires_at = CASE WHEN excluded.expires_at > pending_approvals.expires_at THEN excluded.expires_at ELSE pending_approvals.expires_at END`,
    ).run(approval.id, approval.requestedAt, approval.expiresAt, approval.workspaceId, approval.action);
  } finally {
    db.close();
  }
}

export function queryPendingApprovals(dbPath: string, now = new Date()): PendingApproval[] {
  const db = openDatabase(dbPath);
  try {
    const rows = db
      .prepare("SELECT * FROM pending_approvals WHERE status = 'pending' AND expires_at > ? ORDER BY requested_at DESC LIMIT ?")
      .all(now.toISOString(), MAX_PENDING_APPROVALS) as Array<Record<string, unknown>>;
    return rows.map(rowToPendingApproval);
  } finally {
    db.close();
  }
}

function rowToPendingApproval(row: Record<string, unknown>): PendingApproval {
  return {
    id: String(row["id"]),
    requestedAt: String(row["requested_at"]),
    expiresAt: String(row["expires_at"]),
    workspaceId: String(row["workspace_id"]),
    action: String(row["action"]) as PendingApproval["action"],
  };
}
