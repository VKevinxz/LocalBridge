/** `git.branch` (TOOL_CATALOG.md §8.4). */

import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveGitContext } from "./context.js";
import { runGitChecked } from "./runner.js";

export interface GitBranchResult {
  current: string | undefined;
  branches: string[];
  truncated: boolean;
}

/** US (0x1F). Como secuencia de escape a propósito: un carácter de control literal en el fuente es frágil y se pierde con facilidad. */
const FIELD_SEPARATOR = "\u001F";

export async function getGitBranches(workspace: AuthorizedWorkspace): Promise<GitBranchResult> {
  const context = await resolveGitContext(workspace);

  // `for-each-ref` sobre `refs/heads/` en lugar de `git branch`: no depende de
  // la configuración de columnas ni del color, y no lista remotas por accidente.
  const result = await runGitChecked(
    ["for-each-ref", `--format=%(HEAD)${FIELD_SEPARATOR}%(refname:short)`, "refs/heads/"],
    { cwd: context.cwd },
  );

  const branches: string[] = [];
  let current: string | undefined;

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const [marker = "", name = ""] = trimmed.split(FIELD_SEPARATOR);
    if (name.length === 0) continue;

    branches.push(name);
    if (marker === "*") current = name;
  }

  return { current, branches, truncated: result.truncated };
}
