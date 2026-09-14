import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';

import type { WorkspaceArtifactWriter } from '@localbridge/filesystem';
import { capturePageMotion } from '../../apps/desktop/src/main/motion-capture-engine.js';

function frame(width = 1920, height = 1080): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (let offset = 3; offset < png.data.length; offset += 4) png.data[offset] = 255;
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
}

function fakeWriter(maxFileBytes: number, maxTotalBytes = 64 * 1024 * 1024): { writer: WorkspaceArtifactWriter; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  let totalSize = 0;
  return {
    files,
    writer: {
      get totalSize() { return totalSize; },
      get fileCount() { return files.size; },
      get maxFileBytes() { return maxFileBytes; },
      get maxTotalBytes() { return maxTotalBytes; },
      ensureCapacity: async (requiredBytes) => {
        if (totalSize + requiredBytes > maxTotalBytes) throw Object.assign(new Error('large'), { code: 'FILE_TOO_LARGE' });
      },
      write: async (path, input) => {
        const bytes = Buffer.from(input);
        if (bytes.byteLength > maxFileBytes) throw Object.assign(new Error('large'), { code: 'FILE_TOO_LARGE' });
        files.set(path, bytes);
        totalSize += bytes.byteLength;
        return { path, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
    },
  };
}

function fakeWebContents(png: Buffer) {
  const commands: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  let scrollY = 0;
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    commands.push({ method, params });
    if (method === 'Page.captureScreenshot') return { data: png.toString('base64') };
    if (method !== 'Runtime.evaluate') return {};
    const expression = String(params?.['expression'] ?? '');
    if (expression.includes('prefersReducedMotion')) {
      return { result: { value: { prefersReducedMotion: false, visibility: 'visible' } } };
    }
    const target = /window\.scrollTo\(0,\s*([\d.]+)/.exec(expression)?.[1];
    if (target !== undefined) scrollY = Number(target);
    return { result: { value: { scrollX: 0, scrollY, activeAnimationCount: 1 } } };
  });
  return {
    commands,
    webContents: { debugger: { sendCommand } } as unknown as Electron.WebContents,
  };
}

function captureContext(webContents: Electron.WebContents, writer: WorkspaceArtifactWriter, onEffectStart = vi.fn()) {
  return {
    webContents,
    writer,
    viewport: { width: 1920, height: 1080, mobile: false },
    trajectory: { axis: 'y' as const, startY: 0, distancePx: 500, durationMs: 250, sampleCount: 3 },
    settleBeforeMs: 0,
    captureMode: 'stepped' as const,
    sourceFamily: 'web' as const,
    source: { origin: 'https://example.com', path: '/' },
    generation: 1,
    assertCurrent: vi.fn(),
    onEffectStart,
  };
}

describe('captura temporal', () => {
  it('produce tres frames 1920x1080 con presupuesto visual independiente de la cuota de texto', async () => {
    const png = frame();
    expect(png.byteLength).toBeLessThan(1024 * 1024);
    const { writer, files } = fakeWriter(64 * 1024 * 1024);
    const browser = fakeWebContents(png);

    const result = await capturePageMotion(captureContext(browser.webContents, writer));

    expect(result).toMatchObject({ frameCount: 3, width: 1920, height: 1080, captureMode: 'stepped' });
    expect([...files.keys()]).toEqual([
      'frames/frame-000.png', 'frames/frame-001.png', 'frames/frame-002.png', 'contact-sheet.png', 'manifest.json', 'quality.json',
    ]);
    const captureCalls = browser.commands.filter((entry) => entry.method === 'Page.captureScreenshot');
    expect(captureCalls).toHaveLength(4);
    expect(captureCalls.every((entry) => entry.params?.['optimizeForSpeed'] === false)).toBe(true);
    const manifestBytes = files.get('manifest.json');
    const qualityBytes = files.get('quality.json');
    if (manifestBytes === undefined || qualityBytes === undefined) throw new Error('motion metadata missing');
    const quality = JSON.parse(qualityBytes.toString('utf8')) as {
      manifestSha256: string;
      samples: Array<{ requestAtMs: number; receivedAtMs: number; persistDurationMs: number; observedScrollBefore: { y: number }; observedScrollAfter: { y: number } }>;
    };
    expect(quality.manifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
    expect(quality.samples).toHaveLength(3);
    expect(quality.samples.every((sample) => sample.receivedAtMs >= sample.requestAtMs && sample.persistDurationMs >= 0)).toBe(true);
    expect(quality.samples.map((sample) => sample.observedScrollBefore.y)).toEqual([0, 250, 500]);
    expect(quality.samples.map((sample) => sample.observedScrollAfter.y)).toEqual([0, 250, 500]);
  });

  it('hace preflight antes de desplazar cuando un frame no cabe', async () => {
    const png = frame();
    const { writer, files } = fakeWriter(png.byteLength - 1);
    const browser = fakeWebContents(png);
    const onEffectStart = vi.fn();

    await expect(capturePageMotion(captureContext(browser.webContents, writer, onEffectStart)))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(onEffectStart).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    expect(browser.commands.some((entry) => entry.method === 'Runtime.evaluate' &&
      String(entry.params?.['expression']).includes('window.scrollTo'))).toBe(false);
  });

  it('estima frames, hoja y manifiesto antes del primer efecto', async () => {
    const png = frame();
    const { writer, files } = fakeWriter(1024 * 1024, 512 * 1024);
    const browser = fakeWebContents(png);
    const onEffectStart = vi.fn();

    await expect(capturePageMotion(captureContext(browser.webContents, writer, onEffectStart)))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(onEffectStart).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it('restaura la posición inicial si falla después del primer desplazamiento', async () => {
    const png = frame();
    const { writer, files } = fakeWriter(64 * 1024 * 1024);
    const browser = fakeWebContents(png);
    await browser.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'window.scrollTo(0, 275)' });
    writer.write = vi.fn(async () => {
      throw Object.assign(new Error('storage failed'), { code: 'INSUFFICIENT_DISK_SPACE' });
    });
    const onEffectStart = vi.fn();

    await expect(capturePageMotion(captureContext(browser.webContents, writer, onEffectStart)))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_DISK_SPACE' });

    expect(onEffectStart).toHaveBeenCalledOnce();
    expect(files.size).toBe(0);
    const scrollExpressions = browser.commands
      .filter((entry) => entry.method === 'Runtime.evaluate')
      .map((entry) => String(entry.params?.['expression'] ?? ''))
      .filter((expression) => expression.includes('window.scrollTo'));
    expect(scrollExpressions.at(-1)).toContain('window.scrollTo(0, 275)');
  });
});
