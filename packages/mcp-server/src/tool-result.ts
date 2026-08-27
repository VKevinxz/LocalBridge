import { buildAuditEvent, recordAuditEvent, classifyDecision, type AuditEventInput } from "@localbridge/audit";
import { toErrorPayload, type ErrorCode, type Logger, isLocalBridgeError } from "@localbridge/shared";

/**
 * Contexto de auditoría para una llamada de tool (ADR-0014, SECURITY.md §6.3).
 *
 * `system.health` no lo usa: R0, sin permisos, sin recurso — ruido, no señal
 * de seguridad. El resto de tools sí, incluidas las de solo lectura: el propio
 * ejemplo de `SECURITY.md` incluye `workspace.list ALLOW` y
 * `file.read src/index.ts ALLOW` como eventos esperados.
 */
export interface ToolAuditContext {
  readonly dbPath: string;
  readonly tool: string;
  readonly riskLevel: string;
  /** `Date.now()` al empezar el handler, para calcular `durationMs`. */
  readonly startedAt: number;
  readonly workspaceId?: string;
  /** Ruta relativa o nombre de perfil — nunca una ruta absoluta ni contenido. */
  readonly resource?: string;
  readonly operationId?: string;
}

type AuditOutcomeFields = Pick<AuditEventInput, "decision" | "outcome" | "errorCode">;

/**
 * Nunca deja que un fallo de auditoría rompa la respuesta real de la tool —
 * mismo principio que el logger operativo con un stream roto (ver
 * `packages/shared/src/logger.ts`): la auditoría es evidencia adicional, no
 * una dependencia dura del camino de éxito ni del de error.
 */
function recordSafely(audit: ToolAuditContext, logger: Logger, outcome: AuditOutcomeFields): void {
  try {
    const event = buildAuditEvent({
      action: audit.tool,
      riskLevel: audit.riskLevel,
      durationMs: Date.now() - audit.startedAt,
      ...outcome,
      ...(audit.workspaceId === undefined ? {} : { workspaceId: audit.workspaceId }),
      ...(audit.resource === undefined ? {} : { resource: audit.resource }),
      ...(audit.operationId === undefined ? {} : { operationId: audit.operationId }),
    });
    recordAuditEvent(audit.dbPath, event);
  } catch (auditError) {
    logger.error("audit write failed", { tool: audit.tool, error: auditError });
  }
}

/**
 * Convierte cualquier error de dominio en un `CallToolResult` de error.
 *
 * Deliberadamente sin `structuredContent`: el SDK valida `structuredContent`
 * contra el `outputSchema` de la tool, y el payload de error no tiene la misma
 * forma que una respuesta correcta. Meterlo ahí haría fallar la propia
 * respuesta de error.
 */
export function toolError(error: unknown, logger: Logger, context: Record<string, unknown>, audit?: ToolAuditContext) {
  const payload = toErrorPayload(error);
  logger.warn("tool call failed", { ...context, code: payload.error.code });

  if (audit !== undefined) {
    const errorCode: ErrorCode | undefined = isLocalBridgeError(error) ? error.code : payload.error.code;
    recordSafely(audit, logger, {
      decision: classifyDecision(errorCode),
      outcome: "error",
      errorCode: payload.error.code,
    });
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

/** Envoltorio de éxito consistente: mismo `content`/`structuredContent` en todas las tools. */
export function toolSuccess<T>(result: T, audit?: { context: ToolAuditContext; logger: Logger }) {
  if (audit !== undefined) {
    recordSafely(audit.context, audit.logger, { decision: "allow", outcome: "success" });
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}
