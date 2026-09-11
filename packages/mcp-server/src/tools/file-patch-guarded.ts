import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  getFileMetadata,
  patchGuardedWorkspaceFile,
  type FilePatchGuardedResult,
} from "@localbridge/filesystem";
import { requireAuthorizedWorkspace, withAuthorizedWorkspaceCapabilitiesEffect } from "@localbridge/permissions";
import { LocalBridgeError } from "@localbridge/shared";

import { getCachedResult, idempotencyFingerprint, idempotencyKey, runIdempotent } from "../idempotency.js";
import type { ToolContext } from "../tool-context.js";
import { toolError, toolSuccess } from "../tool-result.js";

const editSchema = z.object({
  oldText: z.string().min(1).max(65_536),
  newText: z.string().max(65_536),
  expectedOccurrences: z.number().int().min(1).max(10_000).default(1),
}).strict();
const inputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  edits: z.array(editSchema).min(1).max(100),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();
const outputSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
  previousSha256: z.string(),
  appliedEdits: z.number().int().positive(),
  replacements: z.number().int().positive(),
}).strict();

export function registerFilePatchGuardedTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("file.patch_guarded", {
    title: "Patch a workspace file with context and hash",
    description: "Applies ordered exact-text edits to an existing workspace file. expectedSha256 guards the complete file immediately before replacement, and each oldText must occur exactly expectedOccurrences times in the progressively edited content. A mismatch writes nothing. Re-read the file and reformulate the exact patch after HASH_MISMATCH or INVALID_INPUT; do not escalate to a broad terminal solely because the structured patch context was stale. Paths remain relative to workspaceId.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async ({ workspaceId, path, expectedSha256, edits, operationId }) => {
    const startedAt = Date.now();
    const auditBase = {
      dbPath: ctx.config.auditDbPath,
      tool: "file.patch_guarded",
      riskLevel: "R3",
      startedAt,
      workspaceId,
      resource: path,
      ...(operationId === undefined ? {} : { operationId }),
    };
    try {
      const normalizedHash = expectedSha256.toLowerCase();
      const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, "read");
      if (!workspace.permissions.overwrite) throw new LocalBridgeError("CAPABILITY_DISABLED", { workspaceId, capability: "overwrite" });
      const fingerprint = idempotencyFingerprint(
        JSON.stringify(workspace),
        path,
        normalizedHash,
        JSON.stringify(edits),
      );
      const key = operationId === undefined ? undefined : idempotencyKey("file.patch_guarded", workspaceId, operationId);
      if (key !== undefined) {
        const cached = getCachedResult<FilePatchGuardedResult>(key, fingerprint);
        if (cached !== undefined) {
          await withAuthorizedWorkspaceCapabilitiesEffect(
            ctx.workspaceConfigPath,
            ctx.logger,
            workspace,
            ["read", "overwrite"],
            async () => {
              const current = await getFileMetadata(workspace, path);
              if (!current.exists || current.type !== "file" || current.sha256 !== cached.sha256) {
                throw new LocalBridgeError("IDEMPOTENCY_CONFLICT", {
                  reason: "patched file changed after the cached operation",
                });
              }
            },
          );
          return toolSuccess(outputSchema.parse(cached), { context: auditBase, logger: ctx.logger });
        }
      }
      const mutate = () => patchGuardedWorkspaceFile(workspace, path, normalizedHash, edits, {
        withAuthorizedEffect: (effect) => withAuthorizedWorkspaceCapabilitiesEffect(
          ctx.workspaceConfigPath,
          ctx.logger,
          workspace,
          ["read", "overwrite"],
          effect,
        ),
      });
      const result = key === undefined ? await mutate() : await runIdempotent(key, fingerprint, mutate);
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(error, ctx.logger, { tool: "file.patch_guarded", workspaceId }, auditBase);
    }
  });
}
