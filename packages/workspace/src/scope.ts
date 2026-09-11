/**
 * Sub-scope seguro dentro de un workspace autorizado.
 *
 * Se usa cuando una operación estructurada necesita trabajar desde un directorio
 * interno (por ejemplo, un repositorio dentro de un proyecto multi-repo) sin
 * aceptar un root absoluto nuevo ni convertir ese directorio en autoridad propia.
 */

import { stat } from "node:fs/promises";

import { LocalBridgeError } from "@localbridge/shared";

import { isPathDenied } from "./denylist.js";
import { resolveSafePath } from "./paths.js";
import type { AuthorizedWorkspace } from "./types.js";

export interface AuthorizedWorkspaceScope {
  /** Workspace que conserva la autoridad y los permisos configurados. */
  readonly authority: AuthorizedWorkspace;
  /** Vista interna cuya raíz ya fue resuelta y contenida por el sandbox. */
  readonly workspace: AuthorizedWorkspace;
  /** Ruta normalizada respecto al workspace de autoridad; `.` representa su root. */
  readonly relativePath: string;
}

/**
 * Resuelve un directorio interno sin ampliar autoridad. La vista conserva los
 * límites y permisos del workspace original; solo cambia el root operativo.
 */
export async function resolveWorkspaceScope(
  workspace: AuthorizedWorkspace,
  inputRelativePath = ".",
): Promise<AuthorizedWorkspaceScope> {
  const safe = await resolveSafePath(workspace.rootPath, inputRelativePath);
  if (!safe.exists) throw new LocalBridgeError("FILE_NOT_FOUND");
  if (isPathDenied(safe.relativePath, workspace.denyPatterns)) throw new LocalBridgeError("PATH_DENIED");

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(safe.realPath);
  } catch {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }
  if (!stats.isDirectory()) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "scope path must be a directory" });
  }

  const relativePath = safe.relativePath === "" ? "." : safe.relativePath;
  return {
    authority: workspace,
    relativePath,
    workspace: {
      ...workspace,
      rootPath: safe.realPath,
      // Mantener los patrones originales aplica las reglas globales (por
      // ejemplo `.env` y `.git/config`) dentro de cada repositorio. Los
      // patrones específicos del padre se rebasan además cuando apuntan al
      // sub-scope. Un falso positivo es preferible a perder una exclusión.
      denyPatterns: scopedDenyPatterns(workspace.denyPatterns, relativePath),
    },
  };
}

/**
 * Convierte una ruta relativa al workspace padre en una ruta relativa al
 * sub-scope. Ambas capas se resuelven de nuevo para cerrar traversal y escapes
 * mediante symlink/junction, incluso cuando el destino aún no existe.
 */
export async function toWorkspaceScopePath(scope: AuthorizedWorkspaceScope, inputRelativePath: string): Promise<string> {
  const parentSafe = await resolveSafePath(scope.authority.rootPath, inputRelativePath);
  if (isPathDenied(parentSafe.relativePath, scope.authority.denyPatterns)) throw new LocalBridgeError("PATH_DENIED");

  const prefix = scope.relativePath === "." ? "" : `${scope.relativePath}/`;
  const scopedInput = prefix === ""
    ? parentSafe.relativePath
    : parentSafe.relativePath.startsWith(prefix)
      ? parentSafe.relativePath.slice(prefix.length)
      : undefined;
  if (scopedInput === undefined || scopedInput === "") {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "path is outside the selected repository" });
  }

  const scopedSafe = await resolveSafePath(scope.workspace.rootPath, scopedInput);
  if (isPathDenied(scopedSafe.relativePath, scope.workspace.denyPatterns)) throw new LocalBridgeError("PATH_DENIED");
  return scopedSafe.relativePath;
}

/** Traduce una ruta producida por la operación interna al espacio del workspace padre. */
export function fromWorkspaceScopePath(scope: AuthorizedWorkspaceScope, scopedRelativePath: string): string {
  return scope.relativePath === "." ? scopedRelativePath : `${scope.relativePath}/${scopedRelativePath}`;
}

function scopedDenyPatterns(patterns: readonly string[], relativePath: string): readonly string[] {
  if (relativePath === ".") return patterns;
  const prefix = `${relativePath}/`;
  const rebased = patterns
    .map((pattern) => pattern.split("\\").join("/"))
    .filter((pattern) => pattern.startsWith(prefix) && pattern.length > prefix.length)
    .map((pattern) => pattern.slice(prefix.length));
  return [...new Set([...patterns, ...rebased])];
}
