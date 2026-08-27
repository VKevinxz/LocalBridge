/** `git.status` (TOOL_CATALOG.md §8.1). */

import { isPathDenied, type AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveGitContext, toWorkspacePath } from "./context.js";
import { runGitChecked } from "./runner.js";

export interface GitStatusEntry {
  path: string;
  /** Código XY de porcelain v2: X = índice, Y = working tree. `?` = sin seguimiento. */
  status: string;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatusResult {
  branch: string | undefined;
  upstream: string | undefined;
  ahead: number | undefined;
  behind: number | undefined;
  entries: GitStatusEntry[];
  truncated: boolean;
}

export async function getGitStatus(workspace: AuthorizedWorkspace): Promise<GitStatusResult> {
  const context = await resolveGitContext(workspace);

  // `-- .` acota la salida al workspace: sin él, un workspace que sea
  // subdirectorio de un repo mayor listaría cambios de fuera del root.
  const result = await runGitChecked(["status", "--porcelain=v2", "--branch", "-z", "--", "."], { cwd: context.cwd });

  const tokens = result.stdout.split("\0").filter((token) => token.length > 0);
  const entries: GitStatusEntry[] = [];

  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;

    if (token.startsWith("# ")) {
      const [key, ...rest] = token.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") branch = value === "(detached)" ? undefined : value;
      if (key === "branch.upstream") upstream = value;
      if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          ahead = Number.parseInt(match[1], 10);
          behind = Number.parseInt(match[2], 10);
        }
      }
      continue;
    }

    const parsed = parseEntry(token);
    if (parsed === undefined) continue;

    // Las entradas de tipo 2 (renombrado) arrastran una ruta de origen extra.
    // Se valida también: una ruta denegada no puede reaparecer indirectamente
    // como el origen de un nombre aparentemente permitido.
    const sourcePath = parsed.consumesExtraToken ? tokens[index + 1] : undefined;
    if (parsed.consumesExtraToken) index += 1;

    const workspacePath = toWorkspacePath(parsed.path, context.prefix);
    if (workspacePath === undefined) continue; // fuera del workspace: se descarta
    if (isPathDenied(workspacePath, workspace.denyPatterns)) continue;
    if (sourcePath !== undefined) {
      const workspaceSourcePath = toWorkspacePath(sourcePath, context.prefix);
      if (workspaceSourcePath === undefined || isPathDenied(workspaceSourcePath, workspace.denyPatterns)) continue;
    }

    entries.push({
      path: workspacePath,
      status: parsed.status,
      staged: parsed.staged,
      unstaged: parsed.unstaged,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { branch, upstream, ahead, behind, entries, truncated: result.truncated };
}

interface ParsedEntry {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  consumesExtraToken: boolean;
}

/**
 * Parsea una entrada de `--porcelain=v2`. El número de campos antes de la ruta
 * depende del tipo, y la ruta puede contener espacios — de ahí el corte por
 * índice en lugar de un `split` simple.
 */
function parseEntry(token: string): ParsedEntry | undefined {
  const type = token[0];
  const fields = token.split(" ");

  if (type === "?") {
    return {
      path: fields.slice(1).join(" "),
      status: "?",
      staged: false,
      unstaged: true,
      consumesExtraToken: false,
    };
  }

  const pathStartIndex = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : -1;
  if (pathStartIndex === -1) return undefined;

  const xy = fields[1] ?? "";
  return {
    path: fields.slice(pathStartIndex).join(" "),
    status: xy,
    staged: xy[0] !== "." && xy[0] !== undefined,
    unstaged: xy[1] !== "." && xy[1] !== undefined,
    consumesExtraToken: type === "2",
  };
}
