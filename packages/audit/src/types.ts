/** `AuditEvent` de MASTER_SPEC.md §8. */

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly workspaceId?: string;
  /** Nombre de la tool. */
  readonly action: string;
  /** Ruta relativa o nombre de perfil — nunca una ruta absoluta ni contenido. */
  readonly resource?: string;
  readonly riskLevel: string;
  readonly decision: "allow" | "deny";
  readonly outcome: "success" | "error";
  readonly errorCode?: string;
  readonly operationId?: string;
  readonly durationMs: number;
}

/** Estado transitorio MRTR; nunca contiene el mensaje, diff ni rutas. */
export interface PendingApproval {
  readonly id: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly workspaceId: string;
  readonly action: "git.commit" | "git.push";
}
