/**
 * Motor de aprobaciones genérico (MRTR — ADR-0016). No es específico de Git:
 * cualquier tool que necesite confirmación humana antes de un efecto
 * irreversible pasa por aquí.
 *
 * Construido sobre `createRequestStateCodec` del SDK, no sobre un mecanismo
 * propio — es el helper HMAC que el propio SDK ofrece precisamente para el
 * requisito de integridad que su documentación deja explícito: `requestState`
 * viaja de vuelta por el cliente y es "attacker-controlled input... the SDK
 * provides NO default verification". `RequestStateCodec.verify` ya prueba
 * integridad y caducidad antes de que el handler se ejecute (se conecta en
 * `ServerOptions.requestState.verify` al construir el servidor, ver
 * `server.ts`) — lo que queda por comprobar aquí es más estrecho: que el
 * payload ya verificado corresponde a esta operación exacta, no a otra
 * aprobada antes con distinto contenido.
 */

import { createHash } from "node:crypto";

import { inputRequired, inputResponse, type InputRequiredResult, type RequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";

import { LocalBridgeError } from "@localbridge/shared";

const HASH_SEPARATOR = String.fromCharCode(0);
export const APPROVAL_TTL_SECONDS = 300;

/**
 * Hash estable de lo que se está aprobando — nunca el contenido en sí viaja en
 * el token firmado. Separador NUL, no un espacio: dos combinaciones de partes
 * distintas (por ejemplo ["a b", "c"] y ["a", "b c"]) no deben poder
 * colisionar en el mismo hash.
 */
export function hashApprovalContent(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(HASH_SEPARATOR)).digest("hex");
}

/** ID opaco y determinista para deduplicar reintentos de la primera ronda. */
export function approvalRequestId(instanceId: string, action: string, workspaceId: string, contentHash: string): string {
  return hashApprovalContent(instanceId, action, workspaceId, contentHash);
}

/** Lo que se firma y se verifica en cada ronda — nunca contiene el contenido real, solo su hash. */
export interface ApprovalPayload {
  readonly action: string;
  readonly workspaceId: string;
  readonly contentHash: string;
}

export interface ApprovalRequest extends ApprovalPayload {
  /** Texto que ve el humano al confirmar — debe incluir contenido real, no una pregunta genérica. */
  readonly message: string;
}

const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: { confirm: { type: "boolean" as const } },
  required: ["confirm"],
};

/**
 * Si esta ronda ya trae una aprobación válida y coincidente, la ejecuta el
 * llamante (approved: true); si el humano dijo que no (o canceló), lanza
 * APPROVAL_DECLINED; si todavía no hay nada que verificar, `ask` trae el
 * InputRequiredResult listo para devolver tal cual desde la tool.
 *
 * Usa `inputResponse` (no `acceptedContent`) a propósito: una elicitación
 * declinada o cancelada no trae `content` en absoluto, así que
 * `acceptedContent` devuelve `undefined` para las tres — accept-sin-content,
 * decline y cancel son indistinguibles de "todavía no hay nada". Sin el
 * discriminador explícito de `inputResponse`, un decline se trataba como "aún
 * no hay respuesta" y volvía a pedir aprobación indefinidamente en vez de
 * fallar con APPROVAL_DECLINED — el cliente reintentaba hasta agotar
 * `maxRounds` en vez de recibir un rechazo limpio.
 */
export async function resolveApproval(
  ctx: ServerContext,
  codec: RequestStateCodec<ApprovalPayload>,
  request: ApprovalRequest,
): Promise<{ approved: true } | { approved: false; ask: InputRequiredResult }> {
  const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");
  const state = ctx.mcpReq.requestState<ApprovalPayload>();

  if (view.kind !== "missing" && state !== undefined) {
    const matches = state.action === request.action && state.workspaceId === request.workspaceId && state.contentHash === request.contentHash;
    if (!matches) {
      // Firma válida, pero para otra operación u otro contenido: exactamente
      // el escenario de replay que ADR-0016 §4 exige rechazar de forma
      // explícita y auditable — nunca se trata como "no hay nada todavía".
      throw new LocalBridgeError("APPROVAL_INVALID");
    }
    if (view.kind === "elicit" && view.action === "accept" && view.content?.["confirm"] === true) {
      return { approved: true };
    }
    throw new LocalBridgeError("APPROVAL_DECLINED");
  }

  const payload: ApprovalPayload = { action: request.action, workspaceId: request.workspaceId, contentHash: request.contentHash };
  const mintedState = await codec.mint(payload, ctx);

  return {
    approved: false,
    ask: inputRequired({
      requestState: mintedState,
      inputRequests: {
        confirm: inputRequired.elicit({ message: request.message, requestedSchema: CONFIRM_SCHEMA }),
      },
    }),
  };
}
