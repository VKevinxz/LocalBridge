import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { openWorkspaceBinaryRangeReader } from "@localbridge/filesystem";
import { requireAuthorizedWorkspace } from "@localbridge/permissions";
import { LocalBridgeError } from "@localbridge/shared";

import { renderPdfDocument } from "../document-reader.js";
import type { ToolContext } from "../tool-context.js";
import { toolError, toolSuccess } from "../tool-result.js";

const MAX_PDF_SOURCE_BYTES = 250 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const warningSchema = z.enum(["active-content-ignored", "attachments-ignored", "pdfium-render-fallback"]);

const inputSchema = z.object({
  workspaceId: z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/),
  path: z.string().min(1).max(4096),
  pages: z.array(z.number().int().min(1)).min(1).max(4),
  detail: z.enum(["standard", "high"]).default("standard"),
  expectedSha256: hashSchema.optional(),
}).strict().refine((value) => new Set(value.pages).size === value.pages.length, {
  message: "pages must not contain duplicates",
});

const pageSchema = z.object({
  page: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  encodedBytes: z.number().int().positive(),
  detail: z.enum(["standard", "high"]),
  renderer: z.enum(["pdfium", "pdfjs"]),
  fallbackApplied: z.boolean(),
}).strict();

const outputSchema = z.object({
  path: z.string(),
  sha256: hashSchema,
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
  pageCount: z.number().int().positive(),
  warnings: z.array(warningSchema),
  pages: z.array(pageSchema).min(1).max(4),
}).strict();

export function registerDocumentRenderTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("document.render", {
    title: "Render workspace PDF pages for visual inspection",
    description: "Renders one to four pages of a PDF inside an authorized workspace and returns labeled MCP images. Use it after document.read for scanned pages, tables, diagrams, layout, signatures, or whenever the user asks to inspect every page visually. Continue in bounded batches and do not claim complete visual coverage until every required page has been delivered. Never use terminal conversion for supported PDFs.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, pages, detail, expectedSha256 }) => {
    const normalizedPages = pages.toSorted((left, right) => left - right);
    const resource = `${path}#pages=${normalizedPages.join(",")}`;
    const auditBase = { dbPath: ctx.config.auditDbPath, tool: "document.render", riskLevel: "R2", startedAt: Date.now(), workspaceId, resource };
    try {
      if (!path.toLowerCase().endsWith(".pdf")) throw new LocalBridgeError("DOCUMENT_UNSUPPORTED");
      const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, "read");
      const source = await openWorkspaceBinaryRangeReader(workspace, path, {
        hardLimitBytes: MAX_PDF_SOURCE_BYTES,
        checkAuthority: async () => {
          const current = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, "read");
          if (current.rootPath !== workspace.rootPath) throw new LocalBridgeError("CAPABILITY_DISABLED");
        },
      });
      try {
        if (expectedSha256 !== undefined && source.sha256 !== expectedSha256) throw new LocalBridgeError("HASH_MISMATCH");
        const rendered = await renderPdfDocument(source, {
          pages: normalizedPages,
          detail,
          ...(ctx.config.documentWorkerPath === undefined ? {} : { workerPath: ctx.config.documentWorkerPath }),
        });
        const metadata = outputSchema.parse({
          path: source.path,
          sha256: source.sha256,
          size: source.size,
          modifiedAt: source.modifiedAt,
          pageCount: rendered.pageCount,
          warnings: rendered.warnings,
          pages: rendered.pages.map(({ bytes: _bytes, ...page }) => page),
        });
        if (rendered.pages.reduce((total, page) => total + page.encodedBytes, 0) > 6 * 1024 * 1024) {
          throw new LocalBridgeError("DOCUMENT_RENDER_TOO_LARGE");
        }
        const warnings = rendered.warnings.length === 0 ? "none" : rendered.warnings.join(",");
        const success = toolSuccess(metadata, {
          context: {
            ...auditBase,
            resource: `${source.path}#pages=${normalizedPages.join(",")};total=${rendered.pageCount};sha=${source.sha256.slice(0, 12)};warnings=${warnings}`,
          },
          logger: ctx.logger,
        });
        return {
          ...success,
          content: [
            ...rendered.pages.flatMap((page) => [
              { type: "text" as const, text: `${source.path} · page ${page.page} of ${rendered.pageCount}` },
              { type: "image" as const, data: Buffer.from(page.bytes).toString("base64"), mimeType: page.mimeType },
            ]),
            { type: "text" as const, text: JSON.stringify(metadata) },
          ],
        };
      } finally {
        await source.close();
      }
    } catch (error) {
      return toolError(error, ctx.logger, { tool: "document.render", workspaceId }, auditBase);
    }
  });
}
