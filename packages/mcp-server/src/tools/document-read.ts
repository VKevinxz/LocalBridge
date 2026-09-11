import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { openWorkspaceBinaryRangeReader } from "@localbridge/filesystem";
import { requireAuthorizedWorkspace } from "@localbridge/permissions";
import { LocalBridgeError } from "@localbridge/shared";

import { parsePdfDocument } from "../document-reader.js";
import type { ToolContext } from "../tool-context.js";
import { toolError, toolSuccess } from "../tool-result.js";

const MAX_PDF_SOURCE_BYTES = 250 * 1024 * 1024;

const inputSchema = z.object({
  workspaceId: z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/),
  path: z.string().min(1).max(4096),
  startPage: z.number().int().min(1).optional(),
  endPage: z.number().int().min(1).optional(),
  maxChars: z.number().int().min(1_000).max(200_000).default(50_000),
}).strict().refine((value) => value.startPage === undefined || value.endPage === undefined || value.endPage >= value.startPage, {
  message: "endPage must be greater than or equal to startPage",
});

const outputSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
  pageCount: z.number().int().positive(),
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive(),
  text: z.string(),
  truncated: z.boolean(),
  warnings: z.array(z.enum(["active-content-ignored", "attachments-ignored"])),
  pageSummaries: z.array(z.object({
    page: z.number().int().positive(),
    widthPoints: z.number().positive(),
    heightPoints: z.number().positive(),
    textCharacters: z.number().int().nonnegative(),
    hasRasterImages: z.boolean(),
    hasVectorDrawing: z.boolean(),
    classification: z.enum(["text", "mixed", "visual", "empty"]),
  }).strict()),
  recommendedMode: z.enum(["text", "mixed", "visual"]),
  hasMorePages: z.boolean(),
  nextPage: z.number().int().positive().optional(),
}).strict();

export function registerDocumentReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool("document.read", {
    title: "Read text from a workspace PDF",
    description: "Extracts bounded digital text and per-page visual signals from a PDF already inside an authorized workspace. The parser receives bytes or guarded ranges, never a filesystem path, and ignores scripts, attachments and links. If the PDF is scanned or the user asks about tables, diagrams, layout or every page, follow with document.render instead of using terminal conversion. Use relative paths only.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, startPage, endPage, maxChars }) => {
    const auditBase = { dbPath: ctx.config.auditDbPath, tool: "document.read", riskLevel: "R2", startedAt: Date.now(), workspaceId, resource: path };
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
        const parsed = await parsePdfDocument(source, {
          maxChars,
          ...(startPage === undefined ? {} : { startPage }),
          ...(endPage === undefined ? {} : { endPage }),
          ...(ctx.config.documentWorkerPath === undefined ? {} : { workerPath: ctx.config.documentWorkerPath }),
        });
        const output = outputSchema.parse({
          path: source.path,
          sha256: source.sha256,
          size: source.size,
          modifiedAt: source.modifiedAt,
          ...parsed,
        });
        const textPages = parsed.pageSummaries.filter((page) => page.textCharacters > 0).map((page) => page.page).join(",");
        const warnings = parsed.warnings.length === 0 ? "none" : parsed.warnings.join(",");
        return toolSuccess(output, {
          context: {
            ...auditBase,
            resource: `${source.path}#textPages=${textPages};total=${parsed.pageCount};sha=${source.sha256.slice(0, 12)};mode=${parsed.recommendedMode};warnings=${warnings}`,
          },
          logger: ctx.logger,
        });
      } finally {
        await source.close();
      }
    } catch (error) {
      return toolError(error, ctx.logger, { tool: "document.read", workspaceId }, auditBase);
    }
  });
}
