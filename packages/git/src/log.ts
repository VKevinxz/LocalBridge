/** `git.log` (TOOL_CATALOG.md §8.3). */

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveSafePath, type AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveGitContext, toGitPathspec } from "./context.js";
import { runGitChecked } from "./runner.js";

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitLogResult {
  entries: GitLogEntry[];
  truncated: boolean;
}

const MAX_COUNT_CEILING = 100;

/**
 * Separadores de campo y de registro con caracteres de control (US y RS), no con
 * comas o tabulaciones: un asunto de commit puede contener cualquier texto
 * imprimible, incluidos los separadores "obvios", pero no bytes de control.
 */
const FIELD_SEPARATOR = "\u001F";
const RECORD_SEPARATOR = "\u001E";

export async function getGitLog(
  workspace: AuthorizedWorkspace,
  maxCount: number | undefined,
  filePath: string | undefined,
): Promise<GitLogResult> {
  const context = await resolveGitContext(workspace);

  const effectiveMaxCount = Math.min(Math.max(maxCount ?? 20, 1), MAX_COUNT_CEILING);

  const args: string[] = [
    "log",
    "--no-color",
    `--max-count=${effectiveMaxCount}`,
    `--format=%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
    "--",
  ];

  if (filePath === undefined) {
    args.push(".");
  } else {
    const safe = await resolveSafePath(workspace.rootPath, filePath);
    if (isPathDenied(safe.relativePath, workspace.denyPatterns)) {
      throw new LocalBridgeError("PATH_DENIED");
    }
    args.push(toGitPathspec(safe.relativePath));
  }

  const result = await runGitChecked(args, { cwd: context.cwd });

  const entries = result.stdout
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash = "", author = "", date = "", subject = ""] = record.split(FIELD_SEPARATOR);
      return { hash, author, date, subject };
    });

  return { entries, truncated: result.truncated };
}
