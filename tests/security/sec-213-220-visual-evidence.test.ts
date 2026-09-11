import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseBrokerParams } from '@localbridge/development';

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), 'utf8');
}

describe('SEC-213..220 — viewport, capturas y evidencia visual', () => {
  it('SEC-213 inicia navegación web y navegadores de proyecto dinámicos en 1920x1080', async () => {
    const web = await source('apps/desktop/src/main/web-controller.ts');
    const browser = await source('apps/desktop/src/main/browser-controller.ts');
    const registry = await source('packages/workspace/src/registry.ts');
    expect(web).toContain('DEFAULT_WEB_VIEWPORT = { width: 1920, height: 1080, mobile: false }');
    expect(browser.match(/viewport: \{ width: 1920, height: 1080 \}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(registry.match(/width: 1920, height: 1080/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('SEC-214 permite otras resoluciones acotadas sin aceptar URL, escala ni ruta', () => {
    const valid = {
      sessionId: `websession_${'a'.repeat(24)}`,
      tabId: `webtab_${'b'.repeat(24)}`,
      width: 390,
      height: 844,
      mobile: true,
      operationId: 'viewport_mobile',
    };
    expect(parseBrokerParams('web.viewport', valid)).toEqual(valid);
    for (const injected of [{ url: 'https://example.com' }, { path: 'C:\\private' }, { deviceScaleFactor: 3 }, { width: 319 }, { height: 2161 }]) {
      expect(() => parseBrokerParams('web.viewport', { ...valid, ...injected })).toThrow();
    }
  });

  it('SEC-215 guarda evidencia web con autoridad web y de workspace reevaluadas', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const controller = await source('apps/desktop/src/main/web-controller.ts');
    expect(main).toContain('withAuthorizedWebProfileEffect(');
    expect(main).toContain('requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, input.workspaceId, "write")');
    expect(main).toContain('withAuthorizedWorkspaceEffect(');
    expect(controller).toContain('captureScreenshotData(tab, false, operationId)');
    expect(controller).toContain('validateDownloadedResource(destinationPath, capture.mimeType, bytes)');
    expect(controller).toContain('profileRevision(current) !== entry.profileRevision');
    expect(main).toContain('input.expectedWorkspace');
    expect(main).toContain('["browserRead", "write"]');
  });

  it('SEC-216 conserva capturas inline dentro del presupuesto y registra solo diagnósticos seguros', async () => {
    const controller = await source('apps/desktop/src/main/web-controller.ts');
    const main = await source('apps/desktop/src/main/index.ts');
    expect(controller).toContain('MAX_BROKER_FRAME_BYTES - 128 * 1024');
    expect(controller).toContain('for (const quality of [85, 70])');
    expect(controller).toContain('WEB_CAPTURE_TOO_LARGE');
    expect(main).toContain('diagnostic.operationId === undefined ? "web.screenshot.diagnostic" : "web.screenshot.save.diagnostic"');
    expect(main).toContain('...(diagnostic.operationId === undefined ? {} : { operationId: diagnostic.operationId })');
    expect(main).not.toMatch(/diagnostic\.(?:data|dataBase64|url|content)/);
  });

  it('SEC-217 descarga assets solo por referencias opacas y valida contenido', async () => {
    const tools = await source('packages/mcp-server/src/tools/web-tools.ts');
    const controller = await source('apps/desktop/src/main/web-controller.ts');
    const policy = await source('apps/desktop/src/main/web-download-policy.ts');
    const main = await source('apps/desktop/src/main/index.ts');
    expect(tools).toContain('web.assets');
    expect(tools).toContain('resourceRef: resourceRefSchema');
    expect(controller).toContain('createDownloadedResourceStreamValidator(');
    expect(controller).toContain('await writer.write(part.value)');
    expect(policy).toContain('createDownloadedResourceStreamValidator');
    expect(policy).not.toContain('image/svg+xml');
    expect(policy).toContain('SVG se deniega');
    expect(controller).toContain('safeObservedResourceUrl');
    expect(controller).toContain('Recurso auxiliar (${resourceLabel})');
    expect(main).toContain('action: "web.download.diagnostic"');
    expect(main).toContain('diagnostic.hostname');
    expect(main).not.toMatch(/web\.download\.diagnostic[\s\S]{0,500}diagnostic\.(?:url|content|data)/);
    expect(controller).toContain('private activeDownloadCount = 0');
  });

  it('SEC-218 compara PNG autorizados y crea el diff sin overwrite', async () => {
    const compare = await source('packages/mcp-server/src/tools/visual-compare.ts');
    expect(compare).toContain("requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, workspaceId, 'read')");
    expect(compare).toContain("if (!workspace.permissions.write) throw new LocalBridgeError('CAPABILITY_DISABLED'");
    expect(compare).toContain('readWorkspaceBinaryFile');
    expect(compare).toContain('createWorkspaceBinaryFile');
    expect(compare).toContain('withAuthorizedWorkspaceCapabilitiesEffect(');
    expect(compare).toContain("['read', 'write']");
    expect(compare).toContain('MAX_VISUAL_PIXELS');
    expect(compare).toContain('2_560 * 1_440');
    expect(compare).toContain('activeVisualComparisons');
  });

  it('SEC-219 obliga a intervención humana para archivos y reporta descargas nativas bloqueadas', async () => {
    const controller = await source('apps/desktop/src/main/web-controller.ts');
    expect(controller).toContain('Page.setInterceptFileChooserDialog');
    expect(controller).toContain('HUMAN_ACTION_REQUIRED');
    expect(controller).toContain('native_download_blocked');
    expect(controller).toContain('dialog_blocked');
    expect(controller).toContain('effect_pending');
    expect(controller).toContain('blockedFileChoosers');
  });

  it('SEC-220 exige evidencia Electron para 1080p, resoluciones personalizadas y devolución humana', async () => {
    const webVerifier = await source('scripts/verify-web-controller.ts');
    const browserVerifier = await source('scripts/verify-browser-controller.ts');
    for (const evidence of [
      'defaultWebViewport1920x1080', 'customWebViewport', 'viewportRestoredAfterHuman',
      'webVideoScreenshotThreeRuns', 'fileSelectionIntercepted', 'nativeDownloadReceipt', 'safeCaptureDiagnostics',
      'largeWebCaptureTransportFallback', 'signedAssetUrlRedacted', 'delayedEffectsObservable', 'staleViewportReceiptRejected',
      'deterministicSaveErrorPreserved', 'viewerTabContext',
    ]) expect(webVerifier).toContain(evidence);
    expect(browserVerifier).toContain('defaultProjectViewport1920x1080');
    expect(browserVerifier).toContain('customViewportSupported');
    expect(browserVerifier).toContain('viewportRestoredAfterHuman');
    expect(browserVerifier).toContain('largeBrowserCaptureTransportFallback');
  });
});
