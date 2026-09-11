import type { McpServer } from '@modelcontextprotocol/server';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { z } from 'zod';

import { createWorkspaceBinaryFile, readWorkspaceBinaryFile } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace, withAuthorizedWorkspaceCapabilitiesEffect } from '@localbridge/permissions';
import { LocalBridgeError } from '@localbridge/shared';

import { idempotencyFingerprint, idempotencyKey, runIdempotent } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_VISUAL_PIXELS = 2_560 * 1_440;
const MAX_SOURCE_BYTES = 32 * 1_024 * 1_024;
let activeVisualComparisons = 0;

const relativePngPathSchema = z.string().min(1).max(4096)
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), 'use a relative path')
  .refine((value) => value.toLowerCase().endsWith('.png'), 'use a .png path');

const inputSchema = z.object({
  workspaceId: z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/),
  referencePath: relativePngPathSchema,
  candidatePath: relativePngPathSchema,
  diffPath: relativePngPathSchema,
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();

const imageReceiptSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
}).strict();

const outputSchema = z.object({
  reference: imageReceiptSchema,
  candidate: imageReceiptSchema,
  diff: imageReceiptSchema.extend({ created: z.literal(true) }),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mismatchPixels: z.number().int().nonnegative(),
  mismatchRatio: z.number().min(0).max(1),
  threshold: z.literal(0.1),
}).strict();

function inspectPngHeader(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new LocalBridgeError('INVALID_INPUT', { reason: 'visual.compare accepts valid PNG files only' });
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > MAX_VISUAL_PIXELS) {
    throw new LocalBridgeError('INVALID_INPUT', { reason: 'PNG dimensions exceed the bounded visual comparison limit' });
  }
  return { width, height };
}

function decodePng(bytes: Buffer): PNG {
  inspectPngHeader(bytes);
  try {
    return PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new LocalBridgeError('INVALID_INPUT', { reason: 'PNG decoding failed' });
  }
}

export function registerVisualCompareTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('visual.compare', {
    title: 'Compare two saved PNG captures',
    description: 'Reads a reference PNG and candidate PNG from the same authorized workspace, requires identical dimensions, creates a new pixel-diff PNG without overwrite, and returns hashes plus a thresholded mismatch ratio. Capture both pages at the same requested viewport before calling this tool. Requires read and write.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, referencePath, candidatePath, diffPath, operationId }) => {
    const auditBase = {
      dbPath: ctx.config.auditDbPath,
      tool: 'visual.compare',
      riskLevel: 'R3',
      startedAt: Date.now(),
      workspaceId,
      resource: diffPath,
      operationId,
    };
    try {
      const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read');
      if (!workspace.permissions.write) throw new LocalBridgeError('CAPABILITY_DISABLED', { workspaceId, capability: 'write' });
      const key = idempotencyKey('visual.compare', workspaceId, operationId);
      const fingerprint = idempotencyFingerprint(referencePath, candidatePath, diffPath);
      const result = await withAuthorizedWorkspaceCapabilitiesEffect(
        ctx.workspaceConfigPath,
        ctx.logger,
        workspace,
        ['read', 'write'],
        () => runIdempotent(key, fingerprint, async () => {
          if (activeVisualComparisons >= 1) throw new LocalBridgeError('RATE_LIMITED', { reason: 'another visual comparison is running' });
          activeVisualComparisons += 1;
          try {
            const [referenceFile, candidateFile] = await Promise.all([
              readWorkspaceBinaryFile(workspace, referencePath, MAX_SOURCE_BYTES),
              readWorkspaceBinaryFile(workspace, candidatePath, MAX_SOURCE_BYTES),
            ]);
            const referenceHeader = inspectPngHeader(referenceFile.bytes);
            const candidateHeader = inspectPngHeader(candidateFile.bytes);
            if (referenceHeader.width !== candidateHeader.width || referenceHeader.height !== candidateHeader.height) {
              throw new LocalBridgeError('INVALID_INPUT', { reason: 'reference and candidate PNG dimensions must match' });
            }
            const reference = decodePng(referenceFile.bytes);
            const candidate = decodePng(candidateFile.bytes);
            const diff = new PNG({ width: reference.width, height: reference.height });
            const mismatchPixels = pixelmatch(
              reference.data,
              candidate.data,
              diff.data,
              reference.width,
              reference.height,
              { threshold: 0.1 },
            );
            const encodedDiff = PNG.sync.write(diff);
            // The workspace authority lock above covers both reads and this exclusive
            // create, so a root or permission change cannot interleave with the compare.
            const savedDiff = await createWorkspaceBinaryFile(workspace, diffPath, encodedDiff);
            return {
              reference: { path: referenceFile.path, sha256: referenceFile.sha256, size: referenceFile.size },
              candidate: { path: candidateFile.path, sha256: candidateFile.sha256, size: candidateFile.size },
              diff: savedDiff,
              width: reference.width,
              height: reference.height,
              mismatchPixels,
              mismatchRatio: mismatchPixels / (reference.width * reference.height),
              threshold: 0.1 as const,
            };
          } finally {
            activeVisualComparisons -= 1;
          }
        }),
      );
      return toolSuccess(outputSchema.parse(result), { context: auditBase, logger: ctx.logger });
    } catch (error) {
      return toolError(error, ctx.logger, { tool: 'visual.compare', workspaceId }, auditBase);
    }
  });
}
