/**
 * Clasificación `decision` por código de error (ADR-0014, SECURITY.md §6.3).
 *
 * `Record<ErrorCode, ...>` a propósito: si `packages/shared` añade un código
 * nuevo sin clasificarlo aquí, TypeScript deja de compilar en vez de dejar la
 * clasificación incompleta en silencio.
 */

import type { ErrorCode } from "@localbridge/shared";

export type AuditDecision = "allow" | "deny";

const DECISION_BY_ERROR_CODE: Readonly<Record<ErrorCode, AuditDecision>> = {
  // El motor de permisos o el sandbox de rutas rechazó ANTES de tocar el recurso.
  WORKSPACE_NOT_FOUND: "deny",
  WORKSPACE_DISABLED: "deny",
  CAPABILITY_DISABLED: "deny",
  PATH_OUTSIDE_WORKSPACE: "deny",
  ABSOLUTE_PATH_FORBIDDEN: "deny",
  SYMLINK_ESCAPE: "deny",
  PATH_DENIED: "deny",
  COMMAND_NOT_ALLOWED: "deny",
  INVALID_INPUT: "deny",
  RATE_LIMITED: "deny",
  PROFILE_NOT_FOUND: "deny",
  PROFILE_SOURCE_MISSING: "deny",
  PROFILE_SOURCE_INVALID: "deny",
  PROFILE_STALE: "deny",
  PROFILE_REVIEW_REQUIRED: "deny",
  PROJECT_NOT_FOUND: "deny",
  PROJECT_REVIEW_REQUIRED: "deny",
  PROJECT_UNAVAILABLE: "deny",
  TERMINAL_NOT_AUTHORIZED: "deny",
  SANDBOX_UNAVAILABLE: "deny",
  TERMINAL_NOT_FOUND: "deny",
  TERMINAL_NOT_RUNNING: "deny",
  IDEMPOTENCY_CONFLICT: "deny",
  SETUP_PRIVATE_CONFIG_UNSUPPORTED: "deny",
  TOPOLOGY_REVIEW_REQUIRED: "deny",
  UNSUPPORTED_ECOSYSTEM: "deny",
  APPLICATION_PROFILE_NOT_FOUND: "deny",
  APPLICATION_REVIEW_REQUIRED: "deny",
  APPLICATION_RUN_NOT_FOUND: "deny",
  APPLICATION_SERVICE_MISMATCH: "deny",
  APPLICATION_ORIGIN_CONFLICT: "deny",
  MANAGED_WILDCARD_NOT_APPROVED: "deny",
  LOCALHOST_RESOLUTION_BLOCKED: "deny",
  LOCALHOST_ATTESTATION_FAILED: "deny",
  PROJECT_BROWSER_LISTENER_MISMATCH: "deny",
  PROJECT_BROWSER_ORIGIN_CONFLICT: "deny",
  ORIGIN_BLOCKED: "deny",
  SENSITIVE_INPUT_BLOCKED: "deny",
  HUMAN_CONTROL_NOT_ALLOWED: "deny",
  HUMAN_CONTROL_REQUEST_NOT_FOUND: "deny",
  HUMAN_CONTROL_ACTIVE: "deny",
  HUMAN_CONTROL_DECLINED: "deny",
  HUMAN_CONTROL_BUSY: "deny",
  // El humano dijo que no, o la aprobación no coincide con lo que se pide ahora
  // (contenido cambiado, o emitida para otra operación) — rechazo de política,
  // no un fallo operativo (ADR-0016).
  APPROVAL_DECLINED: "deny",
  APPROVAL_INVALID: "deny",

  // Se autorizó; falló por el estado del recurso o del sistema, no por política.
  FILE_NOT_FOUND: "allow",
  FILE_ALREADY_EXISTS: "allow",
  FILE_TOO_LARGE: "allow",
  NOT_A_FILE: "allow",
  HASH_MISMATCH: "allow",
  GIT_NOT_REPOSITORY: "allow",
  TIMEOUT: "allow",
  OUTPUT_TRUNCATED: "allow",
  // El commit/push se autorizó (aprobado) y se intentó; el remoto lo rechazó
  // por una razón operativa normal (no fast-forward, etc.), no por política.
  GIT_PUSH_REJECTED: "allow",
  FEATURE_UNAVAILABLE: "allow",
  TERMINAL_START_FAILED: "allow",
  SETUP_PLAN_STALE: "allow",
  SETUP_TOOLCHAIN_MISSING: "allow",
  SETUP_ALREADY_RUNNING: "allow",
  SETUP_WORKSPACE_BUSY: "allow",
  SETUP_CANCELLED: "allow",
  SETUP_FAILED: "allow",
  SETUP_INTERRUPTED: "allow",
  PROCESS_NOT_FOUND: "allow",
  APPLICATION_START_FAILED: "allow",
  APPLICATION_CLEANUP_FAILED: "allow",
  LISTENER_NOT_FOUND: "allow",
  LISTENER_STALE: "allow",
  PROJECT_BROWSER_PRIMARY_UNAVAILABLE: "allow",
  SESSION_NOT_FOUND: "allow",
  STALE_SNAPSHOT: "allow",
  HUMAN_CONTROL_EXPIRED: "allow",
  INTERNAL_ERROR: "allow",
};

export function classifyDecision(errorCode: ErrorCode | undefined): AuditDecision {
  if (errorCode === undefined) return "allow"; // sin error: la operación tuvo éxito
  return DECISION_BY_ERROR_CODE[errorCode];
}
