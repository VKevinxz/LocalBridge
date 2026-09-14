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
const REGION_TILE_SIZE = 8;
const MAX_REGION_PAGE = 10_000;
const MAX_REGION_LIMIT = 100;
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
  regions: z.object({
    page: z.number().int().min(1).max(MAX_REGION_PAGE).default(1),
    limit: z.number().int().min(1).max(MAX_REGION_LIMIT).default(20),
    minMismatchPixels: z.number().int().min(1).max(MAX_VISUAL_PIXELS).default(1),
  }).strict().optional(),
}).strict();

const imageReceiptSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
}).strict();

const differenceRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  area: z.number().int().positive(),
  mismatchPixels: z.number().int().positive(),
  contribution: z.number().min(0).max(1),
}).strict();

const differenceRegionsSchema = z.object({
  grouping: z.literal('connected-tiles-8'),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  minMismatchPixels: z.number().int().positive(),
  detectedTotal: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  filteredOutTotal: z.number().int().nonnegative(),
  filteredOutMismatchPixels: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  items: z.array(differenceRegionSchema).max(MAX_REGION_LIMIT),
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
  regions: differenceRegionsSchema.optional(),
}).strict();

interface RegionAccumulator {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  mismatchPixels: number;
}

interface RegionRequest {
  page: number;
  limit: number;
  minMismatchPixels: number;
}

function isMismatchPixel(data: Buffer, pixelIndex: number): boolean {
  const offset = pixelIndex * 4;
  return data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 0 && data[offset + 3] === 255;
}

/**
 * Groups mismatches through an 8x8 tile grid. The typed arrays stay below one
 * megabyte at the maximum accepted PNG size, avoiding one JS object per pixel.
 * Bounds are refined from the real mismatch pixels after component labelling.
 */
function locateDifferenceRegions(
  diffData: Buffer,
  width: number,
  height: number,
  mismatchPixels: number,
  request: RegionRequest,
): z.infer<typeof differenceRegionsSchema> {
  const tileColumns = Math.ceil(width / REGION_TILE_SIZE);
  const tileRows = Math.ceil(height / REGION_TILE_SIZE);
  const tileTotal = tileColumns * tileRows;
  const tileCounts = new Uint32Array(tileTotal);

  for (let y = 0; y < height; y += 1) {
    const tileRow = Math.floor(y / REGION_TILE_SIZE) * tileColumns;
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      if (isMismatchPixel(diffData, rowStart + x)) {
        const tileIndex = tileRow + Math.floor(x / REGION_TILE_SIZE);
        tileCounts[tileIndex] = (tileCounts[tileIndex] ?? 0) + 1;
      }
    }
  }

  const labels = new Uint32Array(tileTotal);
  const queue = new Uint32Array(tileTotal);
  const accumulators: RegionAccumulator[] = [];
  let componentId = 0;

  for (let start = 0; start < tileTotal; start += 1) {
    if (tileCounts[start] === 0 || labels[start] !== 0) continue;
    componentId += 1;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    labels[start] = componentId;
    while (head < tail) {
      const current = queue[head] as number;
      head += 1;
      const tileX = current % tileColumns;
      const tileY = Math.floor(current / tileColumns);
      for (let dy = -1; dy <= 1; dy += 1) {
        const nextY = tileY + dy;
        if (nextY < 0 || nextY >= tileRows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = tileX + dx;
          if (nextX < 0 || nextX >= tileColumns) continue;
          const next = nextY * tileColumns + nextX;
          if (tileCounts[next] === 0 || labels[next] !== 0) continue;
          labels[next] = componentId;
          queue[tail] = next;
          tail += 1;
        }
      }
    }
    accumulators.push({ xMin: width, yMin: height, xMax: -1, yMax: -1, mismatchPixels: 0 });
  }

  for (let y = 0; y < height; y += 1) {
    const tileRow = Math.floor(y / REGION_TILE_SIZE) * tileColumns;
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!isMismatchPixel(diffData, rowStart + x)) continue;
      const label = labels[tileRow + Math.floor(x / REGION_TILE_SIZE)] as number;
      const region = accumulators[label - 1];
      if (region === undefined) continue;
      region.xMin = Math.min(region.xMin, x);
      region.yMin = Math.min(region.yMin, y);
      region.xMax = Math.max(region.xMax, x);
      region.yMax = Math.max(region.yMax, y);
      region.mismatchPixels += 1;
    }
  }

  const detected = accumulators
    .filter((region) => region.mismatchPixels > 0)
    .map((region) => {
      const regionWidth = region.xMax - region.xMin + 1;
      const regionHeight = region.yMax - region.yMin + 1;
      return {
        x: region.xMin,
        y: region.yMin,
        width: regionWidth,
        height: regionHeight,
        area: regionWidth * regionHeight,
        mismatchPixels: region.mismatchPixels,
        contribution: mismatchPixels === 0 ? 0 : region.mismatchPixels / mismatchPixels,
      };
    })
    .toSorted((left, right) => right.mismatchPixels - left.mismatchPixels || right.area - left.area || left.y - right.y || left.x - right.x);
  const visible = detected.filter((region) => region.mismatchPixels >= request.minMismatchPixels);
  const filtered = detected.filter((region) => region.mismatchPixels < request.minMismatchPixels);
  const offset = (request.page - 1) * request.limit;
  return {
    grouping: 'connected-tiles-8',
    page: request.page,
    limit: request.limit,
    minMismatchPixels: request.minMismatchPixels,
    detectedTotal: detected.length,
    total: visible.length,
    filteredOutTotal: filtered.length,
    filteredOutMismatchPixels: filtered.reduce((sum, region) => sum + region.mismatchPixels, 0),
    hasMore: offset + request.limit < visible.length,
    items: visible.slice(offset, offset + request.limit),
  };
}

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
    description: 'Reads a reference PNG and candidate PNG from the same authorized workspace, requires identical dimensions, creates a new pixel-diff PNG without overwrite, and returns hashes plus a thresholded mismatch ratio. Optional regions localize connected groups of mismatched pixels with bounded-memory 8x8 tile grouping, pagination, and a presentation-only noise filter; the global mismatch count never changes. Regions are geometric evidence, not inferred DOM components. Capture both pages at the same requested viewport before calling this tool. Requires read and write.',
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, referencePath, candidatePath, diffPath, operationId, regions }) => {
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
      const fingerprint = idempotencyFingerprint(referencePath, candidatePath, diffPath, JSON.stringify(regions ?? null));
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
            const differenceRegions = regions === undefined
              ? undefined
              : locateDifferenceRegions(diff.data, reference.width, reference.height, mismatchPixels, regions);
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
              ...(differenceRegions === undefined ? {} : { regions: differenceRegions }),
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
