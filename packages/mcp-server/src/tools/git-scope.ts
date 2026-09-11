import { LocalBridgeError } from "@localbridge/shared";
import {
  resolveWorkspaceScope,
  type AuthorizedWorkspace,
  type AuthorizedWorkspaceScope,
  type WorkspaceCapability,
} from "@localbridge/workspace";
import { withAuthorizedWorkspaceEffect } from "@localbridge/permissions";

import type { ToolContext } from "../tool-context.js";

export const REPOSITORY_PATH_DESCRIPTION =
  "For a multi-repository workspace, pass repositoryPath with the repository node relativePath returned by project.list. Omit it or use '.' when the workspace root is the repository. Always use structured git.* tools for supported Git operations instead of terminal.*.";

export async function resolveGitScope(workspace: AuthorizedWorkspace, repositoryPath: string): Promise<AuthorizedWorkspaceScope> {
  return resolveWorkspaceScope(workspace, repositoryPath);
}

/**
 * Revalida tanto la autoridad persistida como la resolución real del sub-scope
 * inmediatamente antes del efecto Git. Una junction retargeteada o un cambio
 * de configuración invalida la operación en vez de moverla a otro repositorio.
 */
export function withAuthorizedGitScopeEffect<T>(
  ctx: ToolContext,
  scope: AuthorizedWorkspaceScope,
  capability: WorkspaceCapability,
  effect: () => Promise<T>,
): Promise<T> {
  return withAuthorizedWorkspaceEffect(
    ctx.workspaceConfigPath,
    ctx.logger,
    scope.authority,
    capability,
    async () => {
      const current = await resolveWorkspaceScope(scope.authority, scope.relativePath);
      if (current.workspace.rootPath !== scope.workspace.rootPath) {
        throw new LocalBridgeError("APPROVAL_INVALID", { reason: "repository scope changed before effect" });
      }
      return effect();
    },
  );
}
