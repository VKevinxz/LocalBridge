import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { z } from 'zod';

import { DevelopmentBrokerError } from '@localbridge/development';
import { createWorkspaceArtifactDirectory, readWorkspaceBinaryFile, type WorkspaceArtifactWriter } from '@localbridge/filesystem';
import { requireAuthorizedWorkspace, withAuthorizedWorkspaceCapabilitiesEffect } from '@localbridge/permissions';
import { ERROR_CODES, LocalBridgeError, type ErrorCode } from '@localbridge/shared';

import { idempotencyFingerprint, idempotencyKey, runIdempotent } from '../idempotency.js';
import type { ToolContext } from '../tool-context.js';
import { toolError, toolSuccess } from '../tool-result.js';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_MOTION_PIXELS = 3_840 * 2_160;
const CONTACT_CELL_WIDTH = 320;
const CONTACT_CELL_HEIGHT = 180;
const CONTACT_COLUMNS = 4;
let activeMotionComparisons = 0;

const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/);
const browserSessionIdSchema = z.string().regex(/^session_[a-f0-9]{24}$/);
const webSessionIdSchema = z.string().regex(/^websession_[a-f0-9]{24}$/);
const webTabIdSchema = z.string().regex(/^webtab_[a-f0-9]{24}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const relativePathSchema = z.string().min(1).max(4096)
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), 'use a workspace-relative path')
  .refine((value) => !value.split(/[\\/]/).includes('..'), 'path traversal is forbidden');
const bundlePathSchema = relativePathSchema.refine((value) => value.toLowerCase().endsWith('.lbmotion'), 'use a new .lbmotion directory');
const manifestPathSchema = relativePathSchema.refine((value) => /(?:^|[\\/])manifest\.json$/i.test(value), 'use a bundle manifest.json path');
const motionTrajectorySchema = z.object({
  axis: z.literal('y'),
  startY: z.number().int().min(0).max(10_000_000),
  distancePx: z.number().int().min(-20_000).max(20_000).refine((value) => value !== 0, 'distancePx must be non-zero'),
  durationMs: z.number().int().min(250).max(10_000),
  sampleCount: z.number().int().min(3).max(24).default(12),
}).strict();
const captureFields = {
  workspaceId: workspaceIdSchema,
  path: bundlePathSchema,
  operationId: operationIdSchema,
  trajectory: motionTrajectorySchema,
  settleBeforeMs: z.number().int().min(0).max(3_000).default(500),
  captureMode: z.enum(['auto', 'stepped', 'screencast']).default('auto'),
} as const;

const animationSchema = z.object({
  motionRef: z.string().max(64),
  source: z.literal('document-getAnimations'),
  type: z.enum(['css-animation', 'css-transition', 'web-animation']),
  playState: z.string().max(32),
  durationMs: z.number().nullable(),
  delayMs: z.number(),
  iterations: z.union([z.number(), z.string().max(32)]),
  easing: z.string().max(128),
  timeline: z.string().max(64),
  target: z.object({
    tag: z.string().max(32), role: z.string().max(64).optional(),
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  }).strict().optional(),
  properties: z.array(z.string().max(64)).max(32),
  keyframes: z.array(z.object({
    offset: z.number().nullable(),
    easing: z.string().max(128),
    properties: z.record(z.string(), z.string().max(256)),
  }).strict()).max(32),
}).strict();
const motionInspectOutputSchema = z.object({
  motionSnapshotId: z.string().regex(/^(?:motion|webmotion)snapshot_[a-f0-9]{20}$/),
  generation: z.number().int().nonnegative(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), deviceScaleFactor: z.literal(1) }).strict(),
  scroll: z.object({ x: z.number(), y: z.number(), documentWidth: z.number(), documentHeight: z.number() }).strict(),
  environment: z.object({ visibility: z.string().max(32), prefersReducedMotion: z.boolean() }).strict(),
  capabilities: z.object({ cdpAnimation: z.boolean(), scrollTimeline: z.string().max(32), screencast: z.boolean() }).strict(),
  animations: z.array(animationSchema).max(100),
  stickyCandidates: z.array(z.object({
    tag: z.string().max(32), position: z.enum(['sticky', 'fixed']),
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  }).strict()).max(50),
  omitted: z.object({ crossOriginFrames: z.number().int().nonnegative(), animations: z.number().int().nonnegative() }).strict(),
  truncated: z.boolean(),
}).strict();

const captureReceiptFields = {
  path: z.string(),
  created: z.literal(true),
  totalSize: z.number().int().nonnegative(),
  fileCount: z.number().int().positive(),
  manifestPath: z.string(),
  contactSheetPath: z.string(),
  frameCount: z.number().int().min(3).max(24),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  captureMode: z.enum(['stepped', 'screencast']),
  temporalFidelity: z.enum(['sampled', 'continuous']),
  droppedFrames: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(512)).max(16),
} as const;
const captureOutputSchema = z.union([
  z.object({
    sessionId: browserSessionIdSchema,
    ...captureReceiptFields,
    sourcePath: z.string(),
  }).strict(),
  z.object({
    sessionId: webSessionIdSchema,
    tabId: webTabIdSchema,
    ...captureReceiptFields,
    sourceUrl: z.string(),
  }).strict(),
]);

const framePathSchema = z.string().min(1).max(256)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.png$/i);
const manifestSchema = z.object({
  formatVersion: z.literal(1),
  kind: z.literal('localbridge-motion-trace'),
  sourceFamily: z.enum(['web', 'browser']),
  source: z.record(z.string(), z.string().max(4096)),
  viewport: z.object({ width: z.number().int().min(1).max(3840), height: z.number().int().min(1).max(2160), deviceScaleFactor: z.literal(1) }).strict(),
  environment: z.object({
    prefersReducedMotion: z.boolean(), visibility: z.string().max(32),
    captureMode: z.enum(['stepped', 'screencast']), temporalFidelity: z.enum(['sampled', 'continuous']),
  }).strict(),
  trajectory: z.object({
    axis: z.literal('y'), start: z.number(), end: z.number(), durationMs: z.number().int().min(250).max(10_000),
    progress: z.array(z.number().min(0).max(1)).min(3).max(24),
  }).strict(),
  samples: z.array(z.object({
    index: z.number().int().nonnegative(), progress: z.number().min(0).max(1), elapsedMs: z.number().int().nonnegative(),
    scrollX: z.number(), scrollY: z.number(), path: framePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive(), activeAnimationCount: z.number().int().nonnegative(),
  }).strict()).min(3).max(24),
  droppedFrames: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(512)).max(16),
  truncated: z.boolean(),
}).strict();

const compareInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  referenceManifestPath: manifestPathSchema,
  candidateManifestPath: manifestPathSchema,
  path: bundlePathSchema,
  alignment: z.literal('scroll-progress').default('scroll-progress'),
  threshold: z.number().min(0).max(1).default(0.1),
  includeAA: z.boolean().default(false),
  operationId: operationIdSchema,
}).strict();
const frameDifferenceSchema = z.object({
  index: z.number().int().nonnegative(), progress: z.number().min(0).max(1),
  mismatchPixels: z.number().int().nonnegative(), mismatchRatio: z.number().min(0).max(1), path: z.string(),
}).strict();
const compareOutputSchema = z.object({
  path: z.string(), created: z.literal(true), totalSize: z.number().int().nonnegative(), fileCount: z.number().int().positive(),
  reportPath: z.string(), contactSheetPath: z.string(), frameCount: z.number().int().min(3).max(24),
  width: z.number().int().positive(), height: z.number().int().positive(),
  averageMismatchRatio: z.number().min(0).max(1), maximumMismatchRatio: z.number().min(0).max(1),
  worstFrame: z.number().int().nonnegative(), threshold: z.number().min(0).max(1), includeAA: z.boolean(),
  differences: z.array(frameDifferenceSchema).max(24), warnings: z.array(z.string().max(512)).max(32),
}).strict();

function client(ctx: ToolContext) {
  if (ctx.developmentClient === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
  return ctx.developmentClient;
}

function mapBrokerError(error: unknown): unknown {
  if (!(error instanceof DevelopmentBrokerError)) return error;
  if ((ERROR_CODES as readonly string[]).includes(error.code)) {
    const causeCode = error.causeCode !== undefined && (ERROR_CODES as readonly string[]).includes(error.causeCode)
      ? error.causeCode
      : undefined;
    return new LocalBridgeError(error.code as ErrorCode, causeCode === undefined ? undefined : { causeCode });
  }
  return new LocalBridgeError('INTERNAL_ERROR');
}

function audit(ctx: ToolContext, tool: string, riskLevel: string, workspaceId?: string, resource?: string, operationId?: string) {
  return {
    dbPath: ctx.config.auditDbPath,
    tool,
    riskLevel,
    startedAt: Date.now(),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(resource === undefined ? {} : { resource }),
    ...(operationId === undefined ? {} : { operationId }),
  };
}

class ContactSheet {
  private readonly output: PNG;

  constructor(count: number) {
    this.output = new PNG({ width: CONTACT_COLUMNS * CONTACT_CELL_WIDTH, height: Math.ceil(count / CONTACT_COLUMNS) * CONTACT_CELL_HEIGHT });
    this.output.data.fill(0);
  }

  add(index: number, source: PNG): void {
    const scale = Math.min(CONTACT_CELL_WIDTH / source.width, CONTACT_CELL_HEIGHT / source.height);
    const width = Math.max(1, Math.floor(source.width * scale));
    const height = Math.max(1, Math.floor(source.height * scale));
    const offsetX = (index % CONTACT_COLUMNS) * CONTACT_CELL_WIDTH + Math.floor((CONTACT_CELL_WIDTH - width) / 2);
    const offsetY = Math.floor(index / CONTACT_COLUMNS) * CONTACT_CELL_HEIGHT + Math.floor((CONTACT_CELL_HEIGHT - height) / 2);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const destinationOffset = ((offsetY + y) * this.output.width + offsetX + x) * 4;
        source.data.copy(this.output.data, destinationOffset, sourceOffset, sourceOffset + 4);
      }
    }
  }

  encode(): Buffer {
    return PNG.sync.write(this.output, { colorType: 6, inputColorType: 6 });
  }
}

function decodePng(bytes: Buffer): PNG {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > MAX_MOTION_PIXELS) throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  try {
    return PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  }
}

function validateManifest(manifest: z.infer<typeof manifestSchema>): void {
  if (manifest.samples.length !== manifest.trajectory.progress.length) throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  const paths = new Set<string>();
  for (const [index, sample] of manifest.samples.entries()) {
    if (sample.index !== index || sample.progress !== manifest.trajectory.progress[index] || paths.has(sample.path)) {
      throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
    }
    paths.add(sample.path);
  }
}

function requireCompatible(reference: z.infer<typeof manifestSchema>, candidate: z.infer<typeof manifestSchema>): void {
  const same = reference.formatVersion === candidate.formatVersion &&
    JSON.stringify(reference.viewport) === JSON.stringify(candidate.viewport) &&
    reference.trajectory.axis === candidate.trajectory.axis &&
    reference.trajectory.start === candidate.trajectory.start &&
    reference.trajectory.end === candidate.trajectory.end &&
    JSON.stringify(reference.trajectory.progress) === JSON.stringify(candidate.trajectory.progress) &&
    reference.samples.length === candidate.samples.length;
  if (!same) throw new LocalBridgeError('MOTION_BUNDLES_INCOMPATIBLE');
}

async function readManifest(workspace: Awaited<ReturnType<typeof requireAuthorizedWorkspace>>, manifestPath: string) {
  const file = await readWorkspaceBinaryFile(workspace, manifestPath, 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes.toString('utf8'));
  } catch {
    throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  validateManifest(result.data);
  return result.data;
}

async function readDeclaredFrame(
  workspace: Awaited<ReturnType<typeof requireAuthorizedWorkspace>>,
  manifestPath: string,
  sample: z.infer<typeof manifestSchema>['samples'][number],
): Promise<PNG> {
  const base = path.posix.dirname(manifestPath.replaceAll('\\', '/'));
  const framePath = base === '.' ? sample.path : `${base}/${sample.path}`;
  const file = await readWorkspaceBinaryFile(workspace, framePath, MAX_SOURCE_BYTES);
  if (file.sha256 !== sample.sha256 || file.size !== sample.size) throw new LocalBridgeError('MOTION_BUNDLE_INVALID');
  return decodePng(file.bytes);
}

async function compareMotionBundles(
  workspace: Awaited<ReturnType<typeof requireAuthorizedWorkspace>>,
  input: z.infer<typeof compareInputSchema>,
) {
  const [reference, candidate] = await Promise.all([
    readManifest(workspace, input.referenceManifestPath),
    readManifest(workspace, input.candidateManifestPath),
  ]);
  requireCompatible(reference, candidate);
  const contactSheet = new ContactSheet(reference.samples.length);
  const warnings = [...new Set([
    ...reference.warnings,
    ...candidate.warnings,
    ...(reference.samples.some((sample) => sample.activeAnimationCount > 0) || candidate.samples.some((sample) => sample.activeAnimationCount > 0)
      ? ['Active animations were present during at least one sample; compare repeated traces before treating dynamic differences as deterministic.'] : []),
  ])].slice(0, 32);
  return createWorkspaceArtifactDirectory(workspace, input.path, async (writer: WorkspaceArtifactWriter) => {
    const differences: Array<z.infer<typeof frameDifferenceSchema>> = [];
    for (let index = 0; index < reference.samples.length; index += 1) {
      const referenceSample = reference.samples[index]!;
      const candidateSample = candidate.samples[index]!;
      const [referenceFrame, candidateFrame] = await Promise.all([
        readDeclaredFrame(workspace, input.referenceManifestPath, referenceSample),
        readDeclaredFrame(workspace, input.candidateManifestPath, candidateSample),
      ]);
      if (referenceFrame.width !== reference.viewport.width || referenceFrame.height !== reference.viewport.height ||
          candidateFrame.width !== referenceFrame.width || candidateFrame.height !== referenceFrame.height) {
        throw new LocalBridgeError('MOTION_BUNDLES_INCOMPATIBLE');
      }
      const diff = new PNG({ width: referenceFrame.width, height: referenceFrame.height });
      const mismatchPixels = pixelmatch(
        referenceFrame.data,
        candidateFrame.data,
        diff.data,
        referenceFrame.width,
        referenceFrame.height,
        { threshold: input.threshold, includeAA: input.includeAA },
      );
      contactSheet.add(index, diff);
      const relativeDiffPath = `diff/frame-${String(index).padStart(3, '0')}.png`;
      const receipt = await writer.write(relativeDiffPath, PNG.sync.write(diff));
      differences.push({
        index,
        progress: referenceSample.progress,
        mismatchPixels,
        mismatchRatio: mismatchPixels / (referenceFrame.width * referenceFrame.height),
        path: `${input.path}/${receipt.path}`,
      });
    }
    const contact = await writer.write('contact-sheet.png', contactSheet.encode());
    const maximumMismatchRatio = Math.max(...differences.map((item) => item.mismatchRatio));
    const averageMismatchRatio = differences.reduce((sum, item) => sum + item.mismatchRatio, 0) / differences.length;
    const worst = differences.reduce((left, right) => right.mismatchRatio > left.mismatchRatio ? right : left);
    const report = {
      formatVersion: 1,
      kind: 'localbridge-motion-comparison',
      alignment: input.alignment,
      referenceManifestPath: input.referenceManifestPath,
      candidateManifestPath: input.candidateManifestPath,
      viewport: reference.viewport,
      threshold: input.threshold,
      includeAA: input.includeAA,
      averageMismatchRatio,
      maximumMismatchRatio,
      worstFrame: worst.index,
      differences,
      warnings,
    };
    const reportReceipt = await writer.write('report.json', Buffer.from(JSON.stringify(report, null, 2), 'utf8'));
    return {
      reportReceipt,
      contact,
      frameCount: differences.length,
      width: reference.viewport.width,
      height: reference.viewport.height,
      averageMismatchRatio,
      maximumMismatchRatio,
      worstFrame: worst.index,
      differences,
      warnings,
    };
  }, {
    maxFileBytes: 256 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    reserveFreeBytes: 512 * 1024 * 1024,
  });
}

export function registerBrowserMotionInspectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.motion.inspect', {
    title: 'Inspect motion on a local project page',
    description: 'Returns a bounded inventory of active CSS/Web Animations, scroll timelines, sticky elements and temporal-capture capabilities for an isolated project browser. It accepts no script or selector and requires browserRead.',
    inputSchema: z.object({ workspaceId: workspaceIdSchema, sessionId: browserSessionIdSchema, maxAnimations: z.number().int().min(1).max(100).default(100) }).strict(),
    outputSchema: motionInspectOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, maxAnimations }) => {
    const base = audit(ctx, 'browser.motion.inspect', 'R2', workspaceId, sessionId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'browserRead');
      const result = motionInspectOutputSchema.parse(await client(ctx).call('browser.motion.inspect', { workspaceId, sessionId, maxAnimations }));
      return toolSuccess(result, { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.motion.inspect', workspaceId, sessionId }, base);
    }
  });
}

export function registerBrowserMotionCaptureTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser.motion.capture', {
    title: 'Capture a bounded local-page motion trace',
    description: 'Moves the current local page through one bounded vertical scroll trajectory and atomically saves 3-24 PNG samples, a contact sheet and manifest in a new .lbmotion directory. No image bytes cross MCP. Requires browserRead and workspace write.',
    inputSchema: z.object({ sessionId: browserSessionIdSchema, ...captureFields }).strict(),
    outputSchema: captureOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, path: outputPath, operationId, trajectory, settleBeforeMs, captureMode }) => {
    const base = audit(ctx, 'browser.motion.capture', 'R4', workspaceId, outputPath, operationId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'browserRead');
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
      const result = captureOutputSchema.parse(await client(ctx).call('browser.motion.capture', {
        workspaceId, sessionId, path: outputPath, operationId, trajectory, settleBeforeMs, captureMode,
      }));
      return toolSuccess(result, { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'browser.motion.capture', workspaceId, sessionId }, base);
    }
  });
}

export function registerWebMotionInspectTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('web.motion.inspect', {
    title: 'Inspect motion on an isolated Internet page',
    description: 'Returns a bounded inventory of active CSS/Web Animations, scroll timelines, sticky elements and temporal-capture capabilities for an existing web tab. It accepts no script or selector and the web profile read authority remains enforced locally.',
    inputSchema: z.object({ sessionId: webSessionIdSchema, tabId: webTabIdSchema, maxAnimations: z.number().int().min(1).max(100).default(100) }).strict(),
    outputSchema: motionInspectOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ sessionId, tabId, maxAnimations }) => {
    const base = audit(ctx, 'web.motion.inspect', 'R2', undefined, `${sessionId}:${tabId}`);
    try {
      const result = motionInspectOutputSchema.parse(await client(ctx).call('web.motion.inspect', { sessionId, tabId, maxAnimations }));
      return toolSuccess(result, { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'web.motion.inspect', sessionId, tabId }, base);
    }
  });
}

export function registerWebMotionCaptureTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('web.motion.capture', {
    title: 'Capture a bounded Internet-page motion trace',
    description: 'Moves an existing isolated web tab through one bounded vertical scroll trajectory and atomically saves 3-24 PNG samples, a contact sheet and manifest in a new .lbmotion directory. The local web profile must allow read and download; the destination workspace must allow write.',
    inputSchema: z.object({ sessionId: webSessionIdSchema, tabId: webTabIdSchema, ...captureFields }).strict(),
    outputSchema: captureOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ sessionId, tabId, workspaceId, path: outputPath, operationId, trajectory, settleBeforeMs, captureMode }) => {
    const base = audit(ctx, 'web.motion.capture', 'R4', workspaceId, outputPath, operationId);
    try {
      await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'write');
      const result = captureOutputSchema.parse(await client(ctx).call('web.motion.capture', {
        sessionId, tabId, workspaceId, path: outputPath, operationId, trajectory, settleBeforeMs, captureMode,
      }));
      return toolSuccess(result, { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(mapBrokerError(error), ctx.logger, { tool: 'web.motion.capture', workspaceId, sessionId, tabId }, base);
    }
  });
}

export function registerVisualMotionCompareTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('visual.motion.compare', {
    title: 'Compare two saved motion traces',
    description: 'Validates two existing .lbmotion manifest paths and their declared frame hashes, requires identical viewport and scroll-progress vectors, then atomically creates pixel-diff frames, a contact sheet and report in a new .lbmotion directory. If a manifest is missing, capture that trace again after fixing the original capture error. Requires workspace read and write.',
    inputSchema: compareInputSchema,
    outputSchema: compareOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const base = audit(ctx, 'visual.motion.compare', 'R3', input.workspaceId, input.path, input.operationId);
    try {
      const workspace = await requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, input.workspaceId, 'read');
      if (!workspace.permissions.write) throw new LocalBridgeError('CAPABILITY_DISABLED');
      const key = idempotencyKey('visual.motion.compare', input.workspaceId, input.operationId);
      const fingerprint = idempotencyFingerprint(
        input.referenceManifestPath, input.candidateManifestPath, input.path,
        input.alignment, String(input.threshold), String(input.includeAA),
      );
      const compared = await withAuthorizedWorkspaceCapabilitiesEffect(
        ctx.workspaceConfigPath,
        ctx.logger,
        workspace,
        ['read', 'write'],
        () => runIdempotent(key, fingerprint, async () => {
          if (activeMotionComparisons >= 1) throw new LocalBridgeError('MOTION_LIMIT_EXCEEDED');
          activeMotionComparisons += 1;
          try {
            const artifact = await compareMotionBundles(workspace, input);
            return {
              path: artifact.path,
              created: artifact.created,
              totalSize: artifact.totalSize,
              fileCount: artifact.fileCount,
              reportPath: `${artifact.path}/${artifact.value.reportReceipt.path}`,
              contactSheetPath: `${artifact.path}/${artifact.value.contact.path}`,
              frameCount: artifact.value.frameCount,
              width: artifact.value.width,
              height: artifact.value.height,
              averageMismatchRatio: artifact.value.averageMismatchRatio,
              maximumMismatchRatio: artifact.value.maximumMismatchRatio,
              worstFrame: artifact.value.worstFrame,
              threshold: input.threshold,
              includeAA: input.includeAA,
              differences: artifact.value.differences,
              warnings: artifact.value.warnings,
            };
          } finally {
            activeMotionComparisons -= 1;
          }
        }),
      );
      return toolSuccess(compareOutputSchema.parse(compared), { context: base, logger: ctx.logger });
    } catch (error) {
      return toolError(error, ctx.logger, { tool: 'visual.motion.compare', workspaceId: input.workspaceId }, base);
    }
  });
}
