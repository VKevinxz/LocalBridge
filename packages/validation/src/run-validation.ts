/** `validation.run` (TOOL_CATALOG.md §9). */

import { LocalBridgeError, mutationLockKey, withMutationLock } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { runValidationCommand } from "./runner.js";

export interface ValidationResult {
  profile: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: false;
}

/**
 * Clave de mutex con un prefijo que ninguna ruta de archivo real puede tener
 * (`resolveSafePath` normaliza a `/`, nunca produce un segmento con `:`), para
 * que el lock de "una validación a la vez por workspace" no pueda coincidir
 * por accidente con el de escritura de un archivo llamado literalmente
 * `validation-run` en la raíz del workspace.
 */
function validationLockKey(workspaceId: string): string {
  return mutationLockKey(workspaceId, "validation-run:");
}

export async function runValidation(workspace: AuthorizedWorkspace, profile: string): Promise<ValidationResult> {
  const command = workspace.validationProfiles[profile];
  if (command === undefined) {
    throw new LocalBridgeError("COMMAND_NOT_ALLOWED", { profile });
  }

  return withMutationLock(validationLockKey(workspace.id), async () => {
    const result = await runValidationCommand(command, { cwd: workspace.rootPath });

    return {
      profile,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      durationMs: result.durationMs,
      // Un timeout real se propaga como error de tool (TOOL_CATALOG §9); si se
      // llegó hasta aquí es porque no lo hubo.
      timedOut: false,
    };
  });
}
