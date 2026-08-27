/** Combina sandbox de rutas + denylist: el paso previo obligatorio de toda operación de fichero. */

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveSafePath, type AuthorizedWorkspace, type SafePath } from "@localbridge/workspace";

export async function resolveAllowedPath(workspace: AuthorizedWorkspace, relativePath: string): Promise<SafePath> {
  const safe = await resolveSafePath(workspace.rootPath, relativePath);

  if (isPathDenied(safe.relativePath, workspace.denyPatterns)) {
    throw new LocalBridgeError("PATH_DENIED", { relativePath: safe.relativePath });
  }

  return safe;
}
