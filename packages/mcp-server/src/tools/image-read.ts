import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { MAX_BINARY_RANGE_BYTES, openWorkspaceBinaryRangeReader, type WorkspaceBinaryRangeReader } from "@localbridge/filesystem";
import { requireAuthorizedWorkspace } from "@localbridge/permissions";
import { LocalBridgeError } from "@localbridge/shared";

import { readRasterImage } from "../document-reader.js";
import type { ToolContext } from "../tool-context.js";
import { toolError, toolSuccess } from "../tool-result.js";

const MAX_IMAGE_SOURCE_BYTES = 100 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const supportedExtension = /\.(?:png|jpe?g|webp)$/i;

const inputSchema = z.object({
  workspaceId: z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/),
  path: z.string().min(1).max(4096),
  detail: z.enum(["standard", "high"]).default("standard"),
  expectedSha256: hashSchema.optional(),
}).strict();

const outputSchema = z.object({
  path: z.string(),
  sha256: hashSchema,
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
  sourceMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  encodedBytes: z.number().int().positive(),
  detail: z.enum(["standard", "high"]),
  fallbackApplied: z.boolean(),
}).strict();

async function readImageBytes(source: WorkspaceBinaryRangeReader): Promise<Buffer> {
  const output = Buffer.allocUnsafe(source.size);
  let offset = 0;
  while (offset < source.size) {
    const length = Math.min(MAX_BINARY_RANGE_BYTES, source.size - offset);
    const chunk = await source.readRange(offset, length);
    chunk.copy(output, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function registerImageReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("image.read", {
    title: "Read a workspace image visually",
    description: "Validates and delivers a passive PNG, JPEG, or WebP image already inside an authorized workspace as MCP image content. Use it for downloaded image assets that the user asks you to inspect. It verifies the file signature, bounds decoded pixels, and never accepts URLs, SVG, paths outside the workspace, or terminal-based conversion.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, detail, expectedSha256 }) => {
    const auditBase = { dbPath: ctx.config.auditDbPath, tool: "image.read", riskLevel: "R2", startedAt: Date.now(), workspaceId, resource: path };
    try {
      if (!supportedExtension.test(path)) throw new LocalBridgeError("IMAGE_UNSUPPORTED");
      const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, "read");
      const source = await openWorkspaceBinaryRangeReader(workspace, path, {
        hardLimitBytes: MAX_IMAGE_SOURCE_BYTES,
        checkAuthority: async () => {
          const current = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, "read");
          if (current.rootPath !== workspace.rootPath) throw new LocalBridgeError("CAPABILITY_DISABLED");
        },
      });
      try {
        if (expectedSha256 !== undefined && source.sha256 !== expectedSha256) throw new LocalBridgeError("HASH_MISMATCH");
        const image = await readRasterImage(await readImageBytes(source), {
          detail,
          ...(ctx.config.documentWorkerPath === undefined ? {} : { workerPath: ctx.config.documentWorkerPath }),
        });
        const metadata = outputSchema.parse({
          path: source.path,
          sha256: source.sha256,
          size: source.size,
          modifiedAt: source.modifiedAt,
          sourceMimeType: image.sourceMimeType,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          encodedBytes: image.encodedBytes,
          detail: image.detail,
          fallbackApplied: image.fallbackApplied,
        });
        const success = toolSuccess(metadata, {
          context: {
            ...auditBase,
            resource: `${source.path}#image=1;sha=${source.sha256.slice(0, 12)};mime=${image.sourceMimeType}`,
          },
          logger: ctx.logger,
        });
        return {
          ...success,
          content: [
            { type: "image" as const, data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType },
            { type: "text" as const, text: JSON.stringify(metadata) },
          ],
        };
      } finally {
        await source.close();
      }
    } catch (error) {
      return toolError(error, ctx.logger, { tool: "image.read", workspaceId }, auditBase);
    }
  });
}
