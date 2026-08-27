/**
 * Motor de permisos deny-by-default (ADR-0004). Punto único de entrada: toda tool
 * que toque un workspace pasa por aquí antes de hacer nada más (AGENTS.md regla 7).
 *
 * El permiso se comprueba en cada llamada contra el registro recién leído
 * (`getWorkspace` no cachea, ADR-0012), así que un cambio de configuración surte
 * efecto en la siguiente llamada sin reiniciar el servidor.
 */

import { LocalBridgeError, type Logger } from "@localbridge/shared";
import { getWorkspace, type AuthorizedWorkspace, type WorkspaceCapability } from "@localbridge/workspace";

export async function requireAuthorizedWorkspace(
  configPath: string,
  logger: Logger,
  workspaceId: string,
  capability: WorkspaceCapability,
): Promise<AuthorizedWorkspace> {
  const workspace = await getWorkspace(configPath, logger, workspaceId);

  if (workspace === undefined) {
    throw new LocalBridgeError("WORKSPACE_NOT_FOUND", { workspaceId });
  }
  if (!workspace.enabled) {
    throw new LocalBridgeError("WORKSPACE_DISABLED", { workspaceId });
  }
  // Deny-by-default: ausencia de la capacidad equivale a denegada, nunca se infiere.
  if (!workspace.permissions[capability]) {
    throw new LocalBridgeError("CAPABILITY_DISABLED", { workspaceId, capability });
  }

  return workspace;
}
