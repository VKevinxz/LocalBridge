/** `git.diff` (TOOL_CATALOG.md §8.2). */

import { resolveSafePath, type AuthorizedWorkspace } from "@localbridge/workspace";
import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied } from "@localbridge/workspace";

import { resolveGitContext, toGitPathspec } from "./context.js";
import { runGitChecked } from "./runner.js";
import { getGitStatus } from "./status.js";

export interface GitDiffResult {
  diff: string;
  staged: boolean;
  truncated: boolean;
}

/**
 * Banderas de seguridad, no de formato:
 *
 * - `--no-ext-diff` impide que `diff.external` (configurable en el propio
 *   repositorio) haga que Git ejecute un binario arbitrario.
 * - `--no-textconv` impide lo mismo vía filtros `textconv` declarados en
 *   `.gitattributes`.
 *
 * Ambas son vectores reales de ejecución de comandos desde contenido del
 * repositorio, que es justamente contenido no confiable (SECURITY.md Amenaza C).
 */
const SAFE_DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"] as const;

export async function getGitDiff(
  workspace: AuthorizedWorkspace,
  filePath: string | undefined,
  staged: boolean,
  maxBytes: number | undefined,
  displayPrefix?: string,
): Promise<GitDiffResult> {
  const context = await resolveGitContext(workspace);

  const args: string[] = ["diff", ...SAFE_DIFF_FLAGS];
  if (displayPrefix !== undefined) {
    args.push(`--src-prefix=a/${displayPrefix}`, `--dst-prefix=b/${displayPrefix}`);
  }
  if (staged) args.push("--cached");
  args.push("--");

  if (filePath === undefined) {
    // La vista general tampoco puede revelar contenido de rutas denegadas que
    // hayan sido modificadas o staged por otro programa. Se construye una
    // allowlist desde status, ya filtrado por workspace y denylist.
    const status = await getGitStatus(workspace);
    const paths = status.entries
      .filter((entry) => staged ? entry.staged : entry.unstaged)
      .map((entry) => toGitPathspec(entry.path));
    if (paths.length === 0) return { diff: "", staged, truncated: false };
    args.push(...paths);
  } else {
    // La ruta pasa por el sandbox ANTES de convertirse en argumento, y va
    // después de `--` como pathspec literal.
    const safe = await resolveSafePath(workspace.rootPath, filePath);
    if (isPathDenied(safe.relativePath, workspace.denyPatterns)) {
      throw new LocalBridgeError("PATH_DENIED");
    }
    args.push(toGitPathspec(safe.relativePath));
  }

  const result = await runGitChecked(args, { cwd: context.cwd, ...(maxBytes === undefined ? {} : { maxBytes }) });

  return { diff: result.stdout, staged, truncated: result.truncated };
}
