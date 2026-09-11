/** Context patching for an existing file, guarded by the complete file hash. */

import { LocalBridgeError } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import type { MutationOptions } from "./mutation-options.js";
import { transformGuardedWorkspaceFile, type FileWriteGuardedResult } from "./write-guarded.js";

export interface GuardedTextEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences?: number;
}

export interface FilePatchGuardedResult extends FileWriteGuardedResult {
  readonly appliedEdits: number;
  readonly replacements: number;
}

function occurrenceCount(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const found = content.indexOf(needle, offset);
    if (found === -1) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

export async function patchGuardedWorkspaceFile(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  expectedSha256: string,
  edits: readonly GuardedTextEdit[],
  options: MutationOptions = {},
): Promise<FilePatchGuardedResult> {
  if (edits.length < 1 || edits.length > 100) throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid edit count" });

  let replacements = 0;
  const result = await transformGuardedWorkspaceFile(workspace, relativePath, expectedSha256, (current) => {
    let content: string;
    try {
      // `ignoreBOM: true` hace que el BOM se exponga como U+FEFF y vuelva a
      // codificarse; el valor por defecto lo consumiría y alteraría bytes fuera
      // del contexto solicitado.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current);
    } catch {
      throw new LocalBridgeError("INVALID_INPUT", { reason: "file is not valid UTF-8 text" });
    }
    let contentBytes = current.byteLength;
    for (const [editIndex, edit] of edits.entries()) {
      if (edit.oldText.length === 0) throw new LocalBridgeError("INVALID_INPUT", { reason: "oldText cannot be empty", editIndex });
      const expectedOccurrences = edit.expectedOccurrences ?? 1;
      if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1 || expectedOccurrences > 10_000) {
        throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid expectedOccurrences", editIndex });
      }
      const actualOccurrences = occurrenceCount(content, edit.oldText);
      if (actualOccurrences !== expectedOccurrences) {
        throw new LocalBridgeError("INVALID_INPUT", {
          reason: "patch context occurrence mismatch",
          expectedOccurrences,
          actualOccurrences,
          editIndex,
        });
      }
      const projectedBytes = contentBytes + actualOccurrences * (Buffer.byteLength(edit.newText) - Buffer.byteLength(edit.oldText));
      if (projectedBytes > workspace.limits.maxFileBytes) throw new LocalBridgeError("FILE_TOO_LARGE");
      content = content.split(edit.oldText).join(edit.newText);
      contentBytes = projectedBytes;
      replacements += actualOccurrences;
    }
    return Buffer.from(content, "utf8");
  }, options);
  return { ...result, appliedEdits: edits.length, replacements };
}
