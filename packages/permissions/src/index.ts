/**
 * Motor de permisos deny-by-default (ADR-0004). Punto único de entrada: toda tool
 * que toque un workspace pasa por aquí antes de hacer nada más (AGENTS.md regla 7).
 *
 * El permiso se comprueba en cada llamada contra el registro recién leído
 * (`getWorkspace` no cachea, ADR-0012), así que un cambio de configuración surte
 * efecto en la siguiente llamada sin reiniciar el servidor.
 */

import { LocalBridgeError, type Logger } from "@localbridge/shared";
import { getWorkspace, withWorkspaceAuthorityLock, type AuthorizedWorkspace, type WorkspaceCapability } from "@localbridge/workspace";

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

function sameActionAuthority(
  current: AuthorizedWorkspace,
  expected: AuthorizedWorkspace,
  capabilities: readonly WorkspaceCapability[],
): boolean {
  if (current.id !== expected.id || current.rootPath !== expected.rootPath || current.enabled !== expected.enabled) return false;
  if (JSON.stringify(current.denyPatterns) !== JSON.stringify(expected.denyPatterns)) return false;
  return capabilities.every((capability) => current.permissions[capability] === expected.permissions[capability]);
}

/**
 * Revalida solo la autoridad que gobierna una acción larga. Los presupuestos
 * locales pueden cambiar sin convertirse en permiso, mientras root, denylist,
 * estado y capacidades continúan fallando cerrado.
 */
export async function requireCurrentWorkspaceAuthority(
  configPath: string,
  logger: Logger,
  expectedWorkspace: AuthorizedWorkspace,
  capabilities: readonly WorkspaceCapability[],
): Promise<AuthorizedWorkspace> {
  const current = await getWorkspace(configPath, logger, expectedWorkspace.id);
  if (current === undefined) throw new LocalBridgeError("WORKSPACE_NOT_FOUND", { workspaceId: expectedWorkspace.id });
  if (!current.enabled) throw new LocalBridgeError("WORKSPACE_DISABLED", { workspaceId: expectedWorkspace.id });
  for (const capability of capabilities) {
    if (!current.permissions[capability]) {
      throw new LocalBridgeError("CAPABILITY_DISABLED", { workspaceId: expectedWorkspace.id, capability });
    }
  }
  if (!sameActionAuthority(current, expectedWorkspace, capabilities)) {
    throw new LocalBridgeError("APPROVAL_INVALID", { reason: "workspace authority changed before effect" });
  }
  return current;
}

export async function withCurrentWorkspaceAuthorityEffect<T>(
  configPath: string,
  logger: Logger,
  expectedWorkspace: AuthorizedWorkspace,
  capabilities: readonly WorkspaceCapability[],
  effect: () => Promise<T>,
): Promise<T> {
  return withWorkspaceAuthorityLock(configPath, async () => {
    await requireCurrentWorkspaceAuthority(configPath, logger, expectedWorkspace, capabilities);
    return effect();
  });
}

export async function withAuthorizedWorkspaceEffect<T>(
  configPath: string,
  logger: Logger,
  expectedWorkspace: AuthorizedWorkspace,
  capability: WorkspaceCapability,
  effect: () => Promise<T>,
): Promise<T> {
  return withAuthorizedWorkspaceCapabilitiesEffect(configPath, logger, expectedWorkspace, [capability], effect);
}

export async function withAuthorizedWorkspaceCapabilitiesEffect<T>(
  configPath: string,
  logger: Logger,
  expectedWorkspace: AuthorizedWorkspace,
  capabilities: readonly WorkspaceCapability[],
  effect: () => Promise<T>,
): Promise<T> {
  return withWorkspaceAuthorityLock(configPath, async () => {
    const current = await getWorkspace(configPath, logger, expectedWorkspace.id);
    if (current === undefined) throw new LocalBridgeError("WORKSPACE_NOT_FOUND", { workspaceId: expectedWorkspace.id });
    if (!current.enabled) throw new LocalBridgeError("WORKSPACE_DISABLED", { workspaceId: expectedWorkspace.id });
    for (const capability of capabilities) {
      if (!current.permissions[capability]) {
        throw new LocalBridgeError("CAPABILITY_DISABLED", { workspaceId: expectedWorkspace.id, capability });
      }
    }
    if (JSON.stringify(current) !== JSON.stringify(expectedWorkspace)) {
      throw new LocalBridgeError("APPROVAL_INVALID", { reason: "workspace authority changed before effect" });
    }
    return effect();
  });
}
