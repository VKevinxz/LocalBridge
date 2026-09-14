import { randomBytes } from 'node:crypto';

import type { WebContents } from 'electron';
import { PNG } from 'pngjs';

import { DevelopmentBrokerError } from '@localbridge/development';
import type { ArtifactFileReceipt, WorkspaceArtifactWriter } from '@localbridge/filesystem';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_INSPECTION_BYTES = 512 * 1024;
const CONTACT_CELL_WIDTH = 320;
const CONTACT_CELL_HEIGHT = 180;
const CONTACT_COLUMNS = 4;
const CAPTURE_DEADLINE_MS = 60_000;
const MAX_MANIFEST_ESTIMATE_BYTES = 512 * 1024;
const PNG_CONTAINER_MARGIN_BYTES = 1024 * 1024;
let activeCapture = false;

export interface MotionViewport {
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}

export interface MotionTrajectory {
  readonly axis: 'y';
  readonly startY: number;
  readonly distancePx: number;
  readonly durationMs: number;
  readonly sampleCount: number;
}

export type MotionCaptureMode = 'auto' | 'stepped' | 'screencast';

export interface MotionCaptureProgress {
  readonly completed: number;
  readonly total: number;
}

export interface MotionCaptureValue {
  readonly manifest: ArtifactFileReceipt;
  readonly quality: ArtifactFileReceipt;
  readonly contactSheet: ArtifactFileReceipt;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly captureMode: 'stepped' | 'screencast';
  readonly temporalFidelity: 'sampled' | 'continuous';
  readonly droppedFrames: number;
  readonly warnings: readonly string[];
}

interface MotionFrameSample {
  readonly index: number;
  readonly progress: number;
  readonly elapsedMs: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly activeAnimationCount: number;
}

interface MotionFrameQuality {
  readonly index: number;
  readonly targetProgress: number;
  readonly observedScrollBefore: { readonly x: number; readonly y: number };
  readonly observedScrollAfter: { readonly x: number; readonly y: number };
  readonly requestAtMs: number;
  readonly receivedAtMs: number;
  readonly persistDurationMs: number;
}

interface PageMotionState {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly activeAnimationCount: number;
}

export interface MotionCaptureContext {
  readonly webContents: WebContents;
  readonly writer: WorkspaceArtifactWriter;
  readonly viewport: MotionViewport;
  readonly trajectory: MotionTrajectory;
  readonly settleBeforeMs: number;
  readonly captureMode: MotionCaptureMode;
  readonly sourceFamily: 'web' | 'browser';
  readonly source: Readonly<Record<string, string>>;
  readonly generation: number;
  readonly assertCurrent: () => void;
  readonly onEffectStart?: () => void;
  readonly onProgress?: (progress: MotionCaptureProgress) => void;
}

function fail(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function ensurePng(bytes: Buffer, viewport: MotionViewport): void {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail('WEB_CAPTURE_FAILED', 'La captura temporal no produjo un PNG válido.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== viewport.width || height !== viewport.height) {
    fail('WEB_CAPTURE_FAILED', 'La captura temporal no coincide con el viewport renderizado.');
  }
}

async function capturePng(webContents: WebContents, viewport: MotionViewport): Promise<Buffer> {
  const captured = await webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    // La compresión normal mantiene los frames 1920x1080 dentro de la cuota
    // habitual. optimizeForSpeed produce PNG notablemente mayores y fue la
    // causa reproducida en la prueba física de Jeff Milanes.
    optimizeForSpeed: false,
  }) as { data?: unknown };
  if (typeof captured.data !== 'string') fail('WEB_CAPTURE_FAILED', 'Chromium no devolvió bytes de captura temporal.');
  const bytes = Buffer.from(captured.data, 'base64');
  ensurePng(bytes, viewport);
  return bytes;
}

async function pageState(webContents: WebContents): Promise<PageMotionState> {
  const evaluated = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: `(() => ({
      scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
      scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0,
      activeAnimationCount: typeof document.getAnimations === 'function'
        ? document.getAnimations({ subtree: true }).filter((item) => item.playState === 'running' || item.playState === 'pending').length
        : 0
    }))()`,
    returnByValue: true,
  }) as { result?: { value?: Partial<PageMotionState> } };
  return {
    scrollX: finite(evaluated.result?.value?.scrollX),
    scrollY: finite(evaluated.result?.value?.scrollY),
    activeAnimationCount: Math.max(0, Math.trunc(finite(evaluated.result?.value?.activeAnimationCount))),
  };
}

async function pageEnvironment(webContents: WebContents): Promise<{ prefersReducedMotion: boolean; visibility: string }> {
  const evaluated = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: `(() => ({
      prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      visibility: String(document.visibilityState || 'unknown').slice(0, 32)
    }))()`,
    returnByValue: true,
  }) as { result?: { value?: { prefersReducedMotion?: unknown; visibility?: unknown } } };
  return {
    prefersReducedMotion: evaluated.result?.value?.prefersReducedMotion === true,
    visibility: typeof evaluated.result?.value?.visibility === 'string'
      ? evaluated.result.value.visibility.slice(0, 32)
      : 'unknown',
  };
}

async function setScrollPosition(webContents: WebContents, y: number): Promise<PageMotionState> {
  const expression = `new Promise((resolve) => {
    window.scrollTo(0, ${JSON.stringify(y)});
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeAnimationCount: typeof document.getAnimations === 'function'
        ? document.getAnimations({ subtree: true }).filter((item) => item.playState === 'running' || item.playState === 'pending').length
        : 0
    })));
  })`;
  const evaluated = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }) as { result?: { value?: Partial<PageMotionState> } };
  return {
    scrollX: finite(evaluated.result?.value?.scrollX),
    scrollY: finite(evaluated.result?.value?.scrollY),
    activeAnimationCount: Math.max(0, Math.trunc(finite(evaluated.result?.value?.activeAnimationCount))),
  };
}

function startSmoothScroll(webContents: WebContents, trajectory: MotionTrajectory): Promise<void> {
  const expression = `new Promise((resolve) => {
    const start = ${JSON.stringify(trajectory.startY)};
    const distance = ${JSON.stringify(trajectory.distancePx)};
    const duration = ${JSON.stringify(trajectory.durationMs)};
    window.scrollTo(0, start);
    const began = performance.now();
    const step = (now) => {
      const progress = Math.min(1, Math.max(0, (now - began) / duration));
      window.scrollTo(0, start + distance * progress);
      if (progress >= 1) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`;
  return webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }).then(() => undefined);
}

class ContactSheet {
  private readonly output: PNG;

  constructor(private readonly count: number) {
    const rows = Math.ceil(count / CONTACT_COLUMNS);
    this.output = new PNG({ width: CONTACT_COLUMNS * CONTACT_CELL_WIDTH, height: rows * CONTACT_CELL_HEIGHT });
    this.output.data.fill(0);
  }

  add(index: number, bytes: Buffer): void {
    const source = PNG.sync.read(bytes, { checkCRC: true });
    const scale = Math.min(CONTACT_CELL_WIDTH / source.width, CONTACT_CELL_HEIGHT / source.height);
    const width = Math.max(1, Math.floor(source.width * scale));
    const height = Math.max(1, Math.floor(source.height * scale));
    const cellX = (index % CONTACT_COLUMNS) * CONTACT_CELL_WIDTH;
    const cellY = Math.floor(index / CONTACT_COLUMNS) * CONTACT_CELL_HEIGHT;
    const offsetX = cellX + Math.floor((CONTACT_CELL_WIDTH - width) / 2);
    const offsetY = cellY + Math.floor((CONTACT_CELL_HEIGHT - height) / 2);
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

async function persistFrame(
  context: MotionCaptureContext,
  contactSheet: ContactSheet,
  samples: MotionFrameSample[],
  quality: MotionFrameQuality[],
  index: number,
  progress: number,
  elapsedMs: number,
  state: PageMotionState,
  stateAfter: PageMotionState,
  bytes: Buffer,
  requestAtMs: number,
  receivedAtMs: number,
): Promise<void> {
  ensurePng(bytes, context.viewport);
  contactSheet.add(index, bytes);
  const path = `frames/frame-${String(index).padStart(3, '0')}.png`;
  const persistStarted = performance.now();
  const receipt = await context.writer.write(path, bytes);
  samples.push({ index, progress, elapsedMs, scrollX: state.scrollX, scrollY: state.scrollY,
    path: receipt.path, sha256: receipt.sha256, size: receipt.size, activeAnimationCount: state.activeAnimationCount });
  quality.push({
    index,
    targetProgress: progress,
    observedScrollBefore: { x: state.scrollX, y: state.scrollY },
    observedScrollAfter: { x: stateAfter.scrollX, y: stateAfter.scrollY },
    requestAtMs,
    receivedAtMs,
    persistDurationMs: Math.max(0, Math.round(performance.now() - persistStarted)),
  });
  context.onProgress?.({ completed: index + 1, total: context.trajectory.sampleCount });
}

async function captureStepped(context: MotionCaptureContext, contactSheet: ContactSheet): Promise<{ samples: MotionFrameSample[]; quality: MotionFrameQuality[]; droppedFrames: number }> {
  const samples: MotionFrameSample[] = [];
  const quality: MotionFrameQuality[] = [];
  const interval = context.trajectory.durationMs / (context.trajectory.sampleCount - 1);
  const began = performance.now();
  for (let index = 0; index < context.trajectory.sampleCount; index += 1) {
    context.assertCurrent();
    if (index > 0) await delay(Math.max(0, interval - (performance.now() - began - interval * (index - 1))));
    const progress = index / (context.trajectory.sampleCount - 1);
    if (index === 0) context.onEffectStart?.();
    const state = await setScrollPosition(context.webContents,
      context.trajectory.startY + context.trajectory.distancePx * progress);
    context.assertCurrent();
    const requestAtMs = Math.max(0, Math.round(performance.now() - began));
    const bytes = await capturePng(context.webContents, context.viewport);
    const receivedAtMs = Math.max(requestAtMs, Math.round(performance.now() - began));
    const stateAfter = await pageState(context.webContents);
    await persistFrame(context, contactSheet, samples, quality, index, progress,
      receivedAtMs, state, stateAfter, bytes, requestAtMs, receivedAtMs);
  }
  return { samples, quality, droppedFrames: 0 };
}

async function captureScreencast(context: MotionCaptureContext, contactSheet: ContactSheet): Promise<{ samples: MotionFrameSample[]; quality: MotionFrameQuality[]; droppedFrames: number } | undefined> {
  let latestSequence: number | undefined;
  let sequence = 0;
  let consumedSequence = 0;
  let droppedFrames = 0;
  let resolveFirst!: () => void;
  const firstFrame = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
    if (method !== 'Page.screencastFrame' || typeof params !== 'object' || params === null) return;
    const data = (params as { data?: unknown }).data;
    const sessionId = (params as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'number') {
      void context.webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
    }
    if (typeof data !== 'string') return;
    if (latestSequence !== undefined && latestSequence > consumedSequence) droppedFrames += 1;
    // El screencast proporciona cadencia y backpressure. Cada muestra se
    // persiste con Page.captureScreenshot para conservar exactamente el
    // viewport lógico aun cuando el visor físico esté escalado.
    void data;
    latestSequence = ++sequence;
    resolveFirst();
  };
  context.webContents.debugger.on('message', onMessage);
  let started = false;
  try {
    await context.webContents.debugger.sendCommand('Page.startScreencast', {
      format: 'png',
      maxWidth: context.viewport.width,
      maxHeight: context.viewport.height,
      everyNthFrame: 1,
    });
    started = true;
    const available = await Promise.race([firstFrame.then(() => true), delay(750).then(() => false)]);
    if (!available || latestSequence === undefined) return undefined;

    const samples: MotionFrameSample[] = [];
    const quality: MotionFrameQuality[] = [];
    const began = performance.now();
    context.onEffectStart?.();
    let scrollError: unknown;
    const scroll = startSmoothScroll(context.webContents, context.trajectory).catch((error: unknown) => { scrollError = error; });
    try {
      for (let index = 0; index < context.trajectory.sampleCount; index += 1) {
        const target = context.trajectory.durationMs * index / (context.trajectory.sampleCount - 1);
        const remaining = target - (performance.now() - began);
        if (remaining > 0) await delay(remaining);
        context.assertCurrent();
        if (latestSequence === undefined) fail('MOTION_CAPTURE_INTERRUPTED', 'El screencast dejó de producir frames.');
        consumedSequence = latestSequence;
        const state = await pageState(context.webContents);
        const requestAtMs = Math.max(0, Math.round(performance.now() - began));
        const bytes = await capturePng(context.webContents, context.viewport);
        const receivedAtMs = Math.max(requestAtMs, Math.round(performance.now() - began));
        const stateAfter = await pageState(context.webContents);
        await persistFrame(context, contactSheet, samples, quality, index, index / (context.trajectory.sampleCount - 1),
          receivedAtMs, state, stateAfter, bytes, requestAtMs, receivedAtMs);
      }
      await scroll;
      if (scrollError !== undefined) throw scrollError;
    } finally {
      await scroll;
    }
    return { samples, quality, droppedFrames };
  } finally {
    if (started) await context.webContents.debugger.sendCommand('Page.stopScreencast').catch(() => undefined);
    context.webContents.debugger.off('message', onMessage);
  }
}

export async function inspectPageMotion(
  webContents: WebContents,
  viewport: MotionViewport,
  generation: number,
  maxAnimations: number,
  idPrefix: 'motion' | 'webmotion',
): Promise<unknown> {
  if (activeCapture) fail('MOTION_LIMIT_EXCEEDED', 'Hay una captura temporal activa; espera a que termine.');
  const referencePrefix = `${idPrefix}_${randomBytes(6).toString('hex')}`;
  let cdpAnimation = false;
  try {
    await webContents.debugger.sendCommand('Animation.enable');
    cdpAnimation = true;
  } catch {
    cdpAnimation = false;
  } finally {
    if (cdpAnimation) await webContents.debugger.sendCommand('Animation.disable').catch(() => undefined);
  }
  let screencast = false;
  try {
    await webContents.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 1, everyNthFrame: 1_000_000 });
    screencast = true;
  } catch {
    screencast = false;
  } finally {
    if (screencast) await webContents.debugger.sendCommand('Page.stopScreencast').catch(() => undefined);
  }

  const expression = `(() => {
    const limit = ${JSON.stringify(maxAnimations)};
    const clean = (value, max = 256) => {
      const text = String(value ?? '').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').slice(0, max);
      return /url\\s*\\(/i.test(text) ? '[url-redacted]' : text;
    };
    const allowed = new Set(['opacity','transform','filter','clipPath','backgroundColor','color','borderColor','width','height']);
    const animations = typeof document.getAnimations === 'function' ? document.getAnimations({ subtree: true }) : [];
    const selected = animations.slice(0, limit).map((animation, index) => {
      const effect = animation.effect;
      const target = effect && 'target' in effect ? effect.target : null;
      const rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
      const timing = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : {};
      const keyframes = effect && typeof effect.getKeyframes === 'function' ? effect.getKeyframes().slice(0, 32).map((frame) => {
        const properties = {};
        for (const key of Object.keys(frame)) if (allowed.has(key) && Object.keys(properties).length < 32) properties[key] = clean(frame[key]);
        return { offset: Number.isFinite(frame.computedOffset) ? frame.computedOffset : null, easing: clean(frame.easing, 128), properties };
      }) : [];
      const constructorName = clean(animation.constructor && animation.constructor.name, 64);
      const timelineName = clean(animation.timeline && animation.timeline.constructor && animation.timeline.constructor.name, 64);
      return {
        motionRef: ${JSON.stringify(referencePrefix)} + '_' + index.toString(16).padStart(4, '0'),
        source: 'document-getAnimations',
        type: constructorName === 'CSSAnimation' ? 'css-animation' : constructorName === 'CSSTransition' ? 'css-transition' : 'web-animation',
        playState: clean(animation.playState, 32),
        durationMs: typeof timing.duration === 'number' && Number.isFinite(timing.duration) ? timing.duration : null,
        delayMs: Number.isFinite(timing.delay) ? timing.delay : 0,
        iterations: Number.isFinite(timing.iterations) ? timing.iterations : clean(timing.iterations, 32),
        easing: clean(timing.easing, 128),
        timeline: timelineName || 'DocumentTimeline',
        target: target ? { tag: clean(target.tagName, 32).toLowerCase(), role: clean(target.getAttribute && target.getAttribute('role'), 64) || undefined,
          x: rect ? rect.x : 0, y: rect ? rect.y : 0, width: rect ? rect.width : 0, height: rect ? rect.height : 0 } : undefined,
        properties: [...new Set(keyframes.flatMap((frame) => Object.keys(frame.properties)))].slice(0, 32),
        keyframes,
      };
    });
    const stickyCandidates = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let visited = 0;
    while (walker.nextNode() && visited++ < 5000 && stickyCandidates.length < 50) {
      const element = walker.currentNode;
      const position = getComputedStyle(element).position;
      if (position !== 'sticky' && position !== 'fixed') continue;
      const rect = element.getBoundingClientRect();
      stickyCandidates.push({ tag: clean(element.tagName, 32).toLowerCase(), position, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    let inaccessible = 0;
    for (let index = 0; index < window.frames.length; index += 1) try { void window.frames[index].location.href; } catch { inaccessible += 1; }
    return {
      scroll: { x: window.scrollX, y: window.scrollY, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight },
      environment: { visibility: document.visibilityState, prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
      animationCount: animations.length,
      selected,
      stickyCandidates,
      inaccessible,
      scrollTimeline: selected.some((item) => item.timeline === 'ScrollTimeline' || item.timeline === 'ViewTimeline') ? 'partial' : 'none'
    };
  })()`;
  const evaluated = await webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true }) as {
    result?: { value?: Record<string, unknown> };
  };
  const raw = evaluated.result?.value ?? {};
  const selected = Array.isArray(raw.selected) ? [...raw.selected] : [];
  const allAnimations = Math.max(selected.length, Math.trunc(finite(raw.animationCount, selected.length)));
  const result: Record<string, unknown> = {
    motionSnapshotId: `${idPrefix}snapshot_${randomBytes(10).toString('hex')}`,
    generation,
    viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 },
    scroll: raw.scroll ?? { x: 0, y: 0, documentWidth: viewport.width, documentHeight: viewport.height },
    environment: raw.environment ?? { visibility: 'unknown', prefersReducedMotion: false },
    capabilities: { cdpAnimation, scrollTimeline: raw.scrollTimeline ?? 'none', screencast },
    animations: selected,
    stickyCandidates: Array.isArray(raw.stickyCandidates) ? raw.stickyCandidates : [],
    omitted: { crossOriginFrames: Math.max(0, Math.trunc(finite(raw.inaccessible))), animations: Math.max(0, allAnimations - selected.length) },
    truncated: allAnimations > selected.length,
  };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_INSPECTION_BYTES && selected.length > 0) {
    selected.pop();
    (result.omitted as { animations: number }).animations += 1;
    result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_INSPECTION_BYTES) {
    result.stickyCandidates = [];
    result.truncated = true;
  }
  return result;
}

export async function capturePageMotion(context: MotionCaptureContext): Promise<MotionCaptureValue> {
  if (activeCapture) fail('MOTION_LIMIT_EXCEEDED', 'Ya existe una captura temporal activa.');
  const { trajectory } = context;
  if (trajectory.axis !== 'y' || !Number.isSafeInteger(trajectory.startY) || trajectory.startY < 0 || trajectory.startY > 10_000_000 ||
      !Number.isSafeInteger(trajectory.distancePx) || trajectory.distancePx === 0 || Math.abs(trajectory.distancePx) > 20_000 ||
      !Number.isSafeInteger(trajectory.durationMs) || trajectory.durationMs < 250 || trajectory.durationMs > 10_000 ||
      !Number.isSafeInteger(trajectory.sampleCount) || trajectory.sampleCount < 3 || trajectory.sampleCount > 24 ||
      !Number.isSafeInteger(context.settleBeforeMs) || context.settleBeforeMs < 0 || context.settleBeforeMs > 3_000 ||
      !['auto', 'stepped', 'screencast'].includes(context.captureMode)) {
    fail('MOTION_LIMIT_EXCEEDED', 'La trayectoria temporal excede los límites permitidos.');
  }
  const deadline = performance.now() + CAPTURE_DEADLINE_MS;
  const assertWithinDeadline = (): void => {
    if (performance.now() > deadline) fail('TIMEOUT', 'La captura temporal superó el límite interno de 60 segundos.');
    context.assertCurrent();
  };
  let effectStarted = false;
  const boundedContext: MotionCaptureContext = {
    ...context,
    assertCurrent: assertWithinDeadline,
    onEffectStart: () => {
      effectStarted = true;
      context.onEffectStart?.();
    },
  };
  activeCapture = true;
  let initialScrollY: number | undefined;
  try {
    assertWithinDeadline();
    if (context.settleBeforeMs > 0) await delay(context.settleBeforeMs);
    assertWithinDeadline();
    initialScrollY = (await pageState(context.webContents)).scrollY;
    assertWithinDeadline();
    const environment = await pageEnvironment(context.webContents);
    assertWithinDeadline();
    // Preflight sin desplazar la página. El presupuesto usa el peor tamaño
    // RGBA razonable de cada frame, porque una sección posterior puede comprimir
    // peor que el primer viewport aun con las mismas dimensiones.
    const preflight = await capturePng(context.webContents, context.viewport);
    const worstFrameBytes = context.viewport.width * context.viewport.height * 4 + PNG_CONTAINER_MARGIN_BYTES;
    if (preflight.byteLength > context.writer.maxFileBytes || worstFrameBytes > context.writer.maxFileBytes) {
      fail('FILE_TOO_LARGE', 'Un frame temporal comprimido supera el límite por archivo del workspace.');
    }
    const preflightSheet = new ContactSheet(trajectory.sampleCount);
    for (let index = 0; index < trajectory.sampleCount; index += 1) preflightSheet.add(index, preflight);
    const preflightContactSheet = preflightSheet.encode();
    const contactRows = Math.ceil(trajectory.sampleCount / CONTACT_COLUMNS);
    const worstContactSheetBytes = CONTACT_COLUMNS * CONTACT_CELL_WIDTH * contactRows * CONTACT_CELL_HEIGHT * 4 + PNG_CONTAINER_MARGIN_BYTES;
    const worstTotal = worstFrameBytes * trajectory.sampleCount + worstContactSheetBytes + MAX_MANIFEST_ESTIMATE_BYTES;
    if (preflightContactSheet.byteLength > context.writer.maxFileBytes || worstContactSheetBytes > context.writer.maxFileBytes ||
        worstTotal > context.writer.maxTotalBytes) {
      fail('FILE_TOO_LARGE', 'La hoja de contacto o el bundle temporal estimado supera la cuota disponible.');
    }
    await context.writer.ensureCapacity(worstTotal);
    assertWithinDeadline();
    const contactSheet = new ContactSheet(trajectory.sampleCount);
    let captured: { samples: MotionFrameSample[]; quality: MotionFrameQuality[]; droppedFrames: number } | undefined;
    let mode: 'stepped' | 'screencast' = 'stepped';
    if (context.captureMode !== 'stepped') {
      captured = await captureScreencast(boundedContext, contactSheet);
      if (captured !== undefined) mode = 'screencast';
      else if (context.captureMode === 'screencast') fail('MOTION_CAPTURE_UNAVAILABLE', 'El screencast no está disponible en esta sesión.');
    }
    if (captured === undefined) captured = await captureStepped(boundedContext, contactSheet);
    assertWithinDeadline();
    const contactReceipt = await context.writer.write('contact-sheet.png', contactSheet.encode());
    assertWithinDeadline();
    const progress = captured.samples.map((sample) => sample.progress);
    const manifest = {
      formatVersion: 1,
      kind: 'localbridge-motion-trace',
      sourceFamily: context.sourceFamily,
      source: context.source,
      viewport: { width: context.viewport.width, height: context.viewport.height, deviceScaleFactor: 1 },
      environment: {
        prefersReducedMotion: environment.prefersReducedMotion,
        visibility: environment.visibility,
        captureMode: mode,
        temporalFidelity: mode === 'screencast' ? 'continuous' : 'sampled',
      },
      trajectory: {
        axis: context.trajectory.axis,
        start: context.trajectory.startY,
        end: context.trajectory.startY + context.trajectory.distancePx,
        durationMs: context.trajectory.durationMs,
        progress,
      },
      samples: captured.samples,
      droppedFrames: captured.droppedFrames,
      warnings: captured.droppedFrames > 0 ? [`${captured.droppedFrames} intermediate screencast frames were dropped by bounded backpressure.`] : [],
      truncated: false,
    };
    const manifestReceipt = await context.writer.write('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    assertWithinDeadline();
    const quality = {
      formatVersion: 1,
      kind: 'localbridge-motion-quality',
      manifestSha256: manifestReceipt.sha256,
      clock: 'performance.now',
      timingOrigin: 'capture-start',
      samples: captured.quality,
    };
    const qualityReceipt = await context.writer.write('quality.json', Buffer.from(JSON.stringify(quality, null, 2), 'utf8'));
    assertWithinDeadline();
    return {
      manifest: manifestReceipt,
      quality: qualityReceipt,
      contactSheet: contactReceipt,
      frameCount: captured.samples.length,
      width: context.viewport.width,
      height: context.viewport.height,
      captureMode: mode,
      temporalFidelity: mode === 'screencast' ? 'continuous' : 'sampled',
      droppedFrames: captured.droppedFrames,
      warnings: manifest.warnings,
    };
  } catch (error) {
    if (effectStarted && initialScrollY !== undefined) {
      await setScrollPosition(context.webContents, initialScrollY).catch(() => undefined);
    }
    throw error;
  } finally {
    activeCapture = false;
  }
}
