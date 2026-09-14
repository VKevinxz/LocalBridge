import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import { startDevelopmentBroker, type RunningDevelopmentBroker } from '@localbridge/development';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, writeRegistryFile } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;

afterEach(async () => {
  await harness?.close();
  await broker?.close();
  harness = undefined;
  broker = undefined;
});

const trajectory = { axis: 'y' as const, startY: 0, distancePx: 800, durationMs: 800, sampleCount: 3 };

function inspection(prefix: 'motion' | 'webmotion') {
  return {
    motionSnapshotId: `${prefix}snapshot_${'a'.repeat(20)}`,
    generation: 1,
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    scroll: { x: 0, y: 0, documentWidth: 1920, documentHeight: 3000 },
    environment: { visibility: 'visible', prefersReducedMotion: false },
    capabilities: { cdpAnimation: true, scrollTimeline: 'partial', screencast: true },
    animations: [], stickyCandidates: [],
    omitted: { crossOriginFrames: 0, animations: 0 }, truncated: false,
  };
}

function capture(sessionId: string, web = false) {
  return {
    sessionId,
    ...(web ? { tabId: `webtab_${'b'.repeat(24)}`, sourceUrl: 'https://example.com/page' } : { sourcePath: '/' }),
    path: 'motion/capture.lbmotion', created: true, totalSize: 1234, fileCount: 5,
    manifestPath: 'motion/capture.lbmotion/manifest.json',
    contactSheetPath: 'motion/capture.lbmotion/contact-sheet.png',
    frameCount: 3, width: 1920, height: 1080, captureMode: 'stepped', temporalFidelity: 'sampled',
    droppedFrames: 0, warnings: [],
  };
}

describe('tools MCP de movimiento', () => {
  it('aplica schemas cerrados y las autoridades existentes antes del broker', async () => {
    const root = path.join(os.tmpdir(), `localbridge-motion-broker-${randomUUID()}`);
    const configPath = path.join(root, 'workspaces.json');
    const permissions = {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false, browserRead: true,
    };
    await writeRegistryFile(configPath, [
      buildWorkspace({ id: 'ws_motion', rootPath: root, permissions }),
      buildWorkspace({ id: 'ws_motion_denied', rootPath: root, permissions: { ...permissions, write: false } }),
    ]);
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      if (request.method === 'browser.motion.inspect') return inspection('motion');
      if (request.method === 'web.motion.inspect') return inspection('webmotion');
      if (request.method === 'browser.motion.capture') return capture(`session_${'a'.repeat(24)}`);
      if (request.method === 'web.motion.capture') return capture(`websession_${'a'.repeat(24)}`, true);
      return {};
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const localInspect = await callToolJson(harness.client, 'browser.motion.inspect', {
      workspaceId: 'ws_motion', sessionId: `session_${'a'.repeat(24)}`,
    });
    expect(localInspect.isError).toBe(false);
    const webInspect = await callToolJson(harness.client, 'web.motion.inspect', {
      sessionId: `websession_${'a'.repeat(24)}`, tabId: `webtab_${'b'.repeat(24)}`,
    });
    expect(webInspect.isError).toBe(false);
    const localCapture = await callToolJson(harness.client, 'browser.motion.capture', {
      workspaceId: 'ws_motion', sessionId: `session_${'a'.repeat(24)}`,
      path: 'motion/capture.lbmotion', operationId: 'motion_local_1', trajectory,
    });
    expect(localCapture.parsed).toMatchObject({ frameCount: 3, width: 1920, height: 1080 });
    const webCapture = await callToolJson(harness.client, 'web.motion.capture', {
      workspaceId: 'ws_motion', sessionId: `websession_${'a'.repeat(24)}`, tabId: `webtab_${'b'.repeat(24)}`,
      path: 'motion/capture.lbmotion', operationId: 'motion_web_1', trajectory,
    });
    expect(webCapture.isError).toBe(false);
    expect(calls.map((item) => item.method)).toEqual([
      'browser.motion.inspect', 'web.motion.inspect', 'browser.motion.capture', 'web.motion.capture',
    ]);

    const denied = await callToolJson(harness.client, 'browser.motion.capture', {
      workspaceId: 'ws_motion_denied', sessionId: `session_${'a'.repeat(24)}`,
      path: 'motion/denied.lbmotion', operationId: 'motion_denied_1', trajectory,
    });
    expect(denied.parsed.error).toMatchObject({ code: 'CAPABILITY_DISABLED' });
    const injected = await harness.client.callTool({ name: 'web.motion.capture', arguments: {
      workspaceId: 'ws_motion', sessionId: `websession_${'a'.repeat(24)}`, tabId: `webtab_${'b'.repeat(24)}`,
      path: 'motion/injected.lbmotion', operationId: 'motion_injected_1', trajectory,
      url: 'https://attacker.invalid/', selector: 'body', script: 'document.cookie',
    } });
    expect(injected.isError).toBe(true);
    expect(calls).toHaveLength(4);
  });
});

function pngBytes(red: number): Buffer {
  const png = new PNG({ width: 8, height: 6 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 1] = 20;
    png.data[offset + 2] = 30;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

interface MotionBundleOverrides {
  readonly progress?: readonly number[];
  readonly scrollY?: readonly number[];
  readonly captureMode?: 'stepped' | 'screencast';
  readonly temporalFidelity?: 'sampled' | 'continuous';
  readonly visibility?: string;
  readonly prefersReducedMotion?: boolean;
  readonly durationMs?: number;
  readonly droppedFrames?: number;
}

async function writeMotionBundle(
  root: string,
  bundle: string,
  reds: readonly number[],
  overrides: MotionBundleOverrides | readonly number[] = {},
) {
  const options: MotionBundleOverrides = Array.isArray(overrides)
    ? { progress: [...overrides] as number[] }
    : overrides as MotionBundleOverrides;
  const progress = options.progress ?? [0, 0.5, 1];
  const frameDir = path.join(root, bundle, 'frames');
  await mkdir(frameDir, { recursive: true });
  const samples = [];
  for (const [index, red] of reds.entries()) {
    const bytes = pngBytes(red);
    const framePath = `frames/frame-${String(index).padStart(3, '0')}.png`;
    await writeFile(path.join(root, bundle, framePath), bytes);
    samples.push({
      index, progress: progress[index], elapsedMs: index * 400, scrollX: 0,
      scrollY: options.scrollY?.[index] ?? index * 400,
      path: framePath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      activeAnimationCount: index === 1 ? 1 : 0,
    });
  }
  const manifest = {
    formatVersion: 1, kind: 'localbridge-motion-trace', sourceFamily: 'browser', source: { path: '/' },
    viewport: { width: 8, height: 6, deviceScaleFactor: 1 },
    environment: {
      prefersReducedMotion: options.prefersReducedMotion ?? false,
      visibility: options.visibility ?? 'visible',
      captureMode: options.captureMode ?? 'stepped',
      temporalFidelity: options.temporalFidelity ?? 'sampled',
    },
    trajectory: { axis: 'y', start: 0, end: 800, durationMs: options.durationMs ?? 800, progress },
    samples, droppedFrames: options.droppedFrames ?? 0, warnings: [], truncated: false,
  };
  await writeFile(path.join(root, bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('visual.motion.compare', () => {
  it('valida hashes y compatibilidad y publica el bundle de diff de forma idempotente', async () => {
    const root = path.join(os.tmpdir(), `localbridge-motion-compare-${randomUUID()}`);
    const configPath = path.join(root, 'workspaces.json');
    const workspace = buildWorkspace({ id: 'ws_motion_compare', rootPath: root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } });
    await writeRegistryFile(configPath, [workspace]);
    await writeMotionBundle(root, 'reference.lbmotion', [10, 20, 30]);
    await writeMotionBundle(root, 'candidate.lbmotion', [10, 80, 30]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    const args = {
      workspaceId: 'ws_motion_compare',
      referenceManifestPath: 'reference.lbmotion/manifest.json',
      candidateManifestPath: 'candidate.lbmotion/manifest.json',
      path: 'comparison.lbmotion', operationId: 'motion_compare_1',
    };
    const first = await callToolJson(harness.client, 'visual.motion.compare', args);
    const repeated = await callToolJson(harness.client, 'visual.motion.compare', args);
    expect(first.isError).toBe(false);
    expect(repeated.parsed).toEqual(first.parsed);
    expect(first.parsed).toMatchObject({ frameCount: 3, width: 8, height: 6, worstFrame: 1 });
    expect(first.parsed.warnings).toEqual([expect.stringContaining('Active animations')]);
    expect((await stat(path.join(root, 'comparison.lbmotion'))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, 'comparison.lbmotion', 'report.json'), 'utf8'))).toMatchObject({
      kind: 'localbridge-motion-comparison', worstFrame: 1,
    });

    const conflict = await callToolJson(harness.client, 'visual.motion.compare', { ...args, threshold: 0.2 });
    expect(conflict.parsed.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('falla cerrado ante trayectorias incompatibles y frames alterados', async () => {
    const root = path.join(os.tmpdir(), `localbridge-motion-invalid-${randomUUID()}`);
    const configPath = path.join(root, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_motion_invalid', rootPath: root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } })]);
    await writeMotionBundle(root, 'reference.lbmotion', [10, 20, 30]);
    await writeMotionBundle(root, 'incompatible.lbmotion', [10, 20, 30], [0, 0.25, 1]);
    await writeMotionBundle(root, 'tampered.lbmotion', [10, 20, 30]);
    await writeFile(path.join(root, 'tampered.lbmotion', 'frames', 'frame-001.png'), pngBytes(250));
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const incompatible = await callToolJson(harness.client, 'visual.motion.compare', {
      workspaceId: 'ws_motion_invalid', referenceManifestPath: 'reference.lbmotion/manifest.json',
      candidateManifestPath: 'incompatible.lbmotion/manifest.json', path: 'diff-incompatible.lbmotion',
      operationId: 'motion_incompatible_1',
    });
    expect(incompatible.parsed.error).toMatchObject({ code: 'MOTION_BUNDLES_INCOMPATIBLE' });
    const tampered = await callToolJson(harness.client, 'visual.motion.compare', {
      workspaceId: 'ws_motion_invalid', referenceManifestPath: 'reference.lbmotion/manifest.json',
      candidateManifestPath: 'tampered.lbmotion/manifest.json', path: 'diff-tampered.lbmotion',
      operationId: 'motion_tampered_1',
    });
    expect(tampered.parsed.error).toMatchObject({ code: 'MOTION_BUNDLE_INVALID' });
  });

  it('advierte cuando el progreso nominal oculta scroll real o entornos distintos', async () => {
    const root = path.join(os.tmpdir(), `localbridge-motion-evidence-${randomUUID()}`);
    const configPath = path.join(root, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_motion_evidence', rootPath: root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } })]);
    await writeMotionBundle(root, 'reference.lbmotion', [10, 20, 30], {
      scrollY: [0, 400, 800], captureMode: 'screencast', temporalFidelity: 'continuous', droppedFrames: 90,
    });
    await writeMotionBundle(root, 'candidate.lbmotion', [10, 20, 30], {
      scrollY: [0, 417, 800], visibility: 'hidden', prefersReducedMotion: true, durationMs: 900,
    });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const result = await callToolJson(harness.client, 'visual.motion.compare', {
      workspaceId: 'ws_motion_evidence', referenceManifestPath: 'reference.lbmotion/manifest.json',
      candidateManifestPath: 'candidate.lbmotion/manifest.json', path: 'evidence-diff.lbmotion',
      operationId: 'motion_evidence_1',
    });

    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ averageMismatchRatio: 0, maximumMismatchRatio: 0 });
    expect(result.parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('17 CSS px'),
      expect.stringContaining('capture modes differ'),
      expect.stringContaining('durations differ'),
      expect.stringContaining('visibility differs'),
      expect.stringContaining('reduced-motion preference differs'),
      expect.stringContaining('90 intermediate screencast events'),
    ]));
    const report = JSON.parse(await readFile(path.join(root, 'evidence-diff.lbmotion', 'report.json'), 'utf8')) as { warnings: string[] };
    expect(report.warnings).toEqual(result.parsed.warnings);
  });

  it('alinea por scroll observado sin reutilizar ni interpolar muestras', async () => {
    const root = path.join(os.tmpdir(), `localbridge-motion-position-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    await writeMotionBundle(root, 'reference.lbmotion', [10, 20, 30, 40], { scrollY: [0, 100, 200, 300], progress: [0, 0.33, 0.66, 1] });
    await writeMotionBundle(root, 'candidate.lbmotion', [10, 20, 30, 40], { scrollY: [0, 102, 200, 450], progress: [0, 0.25, 0.75, 1] });
    const configPath = path.join(root, 'workspaces.json');
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_motion_position', rootPath: root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const result = await callToolJson(harness.client, 'visual.motion.compare', {
      workspaceId: 'ws_motion_position', referenceManifestPath: 'reference.lbmotion/manifest.json',
      candidateManifestPath: 'candidate.lbmotion/manifest.json', path: 'position-diff.lbmotion',
      alignment: 'scroll-position', scrollTolerancePx: 2, operationId: 'motion_position_1',
    });

    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({
      alignment: 'scroll-position', frameCount: 3,
      coverage: {
        matchedPairs: 3, referenceSamples: 4, candidateSamples: 4,
        unmatchedReference: [3], unmatchedCandidate: [3], fitness: 'incomplete',
      },
      quality: { reference: 'unknown', candidate: 'unknown' },
    });
    const differences = result.parsed['differences'] as Array<Record<string, unknown>>;
    expect(differences.map((item) => [item['referenceIndex'], item['candidateIndex']])).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(JSON.stringify(result.parsed['warnings'])).toContain('unmatched samples');
  });
});
