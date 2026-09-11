import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { liveViewerMoveInputSchema, liveViewerTargetInputSchema } from '@localbridge/desktop-core';
import { fitViewerPresentation } from '../../apps/desktop/src/main/live-viewer-presentation.js';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-076 — el renderer nunca elige coordenadas', () => {
  it('IPC acepta únicamente IDs opacos y rechaza campos extra', () => {
    const sessionId = `session_${'a'.repeat(24)}`;
    expect(liveViewerTargetInputSchema.parse({ sessionId, displayId: '42' })).toEqual({ sessionId, displayId: '42' });
    expect(liveViewerMoveInputSchema.parse({ sessionId, displayId: '-17' })).toEqual({ sessionId, displayId: '-17' });
    expect(() => liveViewerMoveInputSchema.parse({ sessionId, displayId: '42', x: 0, y: 0 })).toThrow();
    expect(() => liveViewerMoveInputSchema.parse({ sessionId, displayId: 'left' })).toThrow();
  });
});

describe('SEC-077 — main resuelve el ID contra monitores vigentes', () => {
  it('consulta electron.screen y rechaza movimiento a un ID retirado', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    expect(main).toContain('screen.getAllDisplays()');
    expect(main).toContain("if (String(target.id) !== parsed.displayId) throw new Error('La pantalla seleccionada ya no está disponible.')");
    expect(main).toContain('liveViewerMoveInputSchema.parse(input)');
  });
});

describe('SEC-078 — mover conserva aislamiento y no recarga', () => {
  it('solo aplica posición y reafirma foco y ratón bloqueados', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const move = controller.slice(controller.indexOf('async moveLiveViewerLocally'), controller.indexOf('private async requireWorkspace'));
    expect(move).toContain('entry.window.setIgnoreMouseEvents(true)');
    expect(move).toContain('entry.window.setFocusable(false)');
    expect(move).toContain('this.positionLiveViewer(entry, workArea)');
    expect(move).not.toContain('loadURL');
    expect(move).not.toContain('setSize');
    expect(move).not.toContain('new BrowserWindow');
  });
});

describe('SEC-079 — topología y preferencia quedan fuera de MCP', () => {
  it('no agrega catálogo, registro ni portabilidad', async () => {
    const server = await source('packages/mcp-server/src/server.ts');
    const workspace = await source('packages/workspace/src/types.ts');
    const portability = await source('packages/desktop-core/src/portability.ts');
    expect(server).not.toContain('moveLiveViewer');
    expect(server).not.toContain('displayId');
    expect(workspace).not.toContain('liveViewerDisplayId');
    expect(portability).not.toContain('liveViewerDisplayId');
  });
});

describe('SEC-080 — preferencia es local y no crítica', () => {
  it('usa localStorage con fallback cerrado sin introducir rutas o contenido', async () => {
    const renderer = await source('apps/desktop/src/renderer/src/main.ts');
    expect(renderer).toContain("const LIVE_VIEWER_DISPLAY_STORAGE_KEY = 'localbridge.liveViewerDisplayId'");
    expect(renderer).toContain('window.localStorage.setItem(LIVE_VIEWER_DISPLAY_STORAGE_KEY, displayId)');
    expect(renderer).toContain('(developmentActivity.displays ?? []).some((display) => display.id === displayId)');
  });
});

describe('SEC-081 — hot-unplug reubica una vista activa', () => {
  it('escucha retiro y cambios de métricas con fallback local', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    expect(main).toContain("screen.on('display-removed'");
    expect(main).toContain("screen.on('display-metrics-changed'");
    expect(main).toContain('rehomeLiveViewerIfNeeded');
    expect(main).toContain('const fallback = resolveLiveViewerDisplay()');
  });
});

describe('SEC-082 — la colocación usa únicamente workArea validado', () => {
  it('valida enteros, cabe en el área y centra sin aceptar dimensiones imposibles', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const presentation = await source('apps/desktop/src/main/live-viewer-presentation.ts');
    const position = controller.slice(controller.indexOf('private async positionLiveViewer'), controller.indexOf('async showLiveViewerLocally'));
    expect(presentation).toContain('values.every(Number.isSafeInteger)');
    expect(presentation).toContain('workArea.width <= frame.width');
    expect(presentation).toContain('Math.min(1, maximumContentWidth / viewport.width, maximumContentHeight / viewport.height)');
    expect(position).toContain('resolveViewerPresentation(entry.currentViewport');
    expect(position).toContain('entry.window.setBounds(presentation.bounds, false)');
    const fitted = fitViewerPresentation(
      { width: 1920, height: 1080 }, 96,
      { x: -1920, y: 0, width: 1366, height: 768 },
      { width: 16, height: 39 },
    );
    expect(fitted.bounds.x).toBeGreaterThanOrEqual(-1920);
    expect(fitted.bounds.y).toBeGreaterThanOrEqual(0);
    expect(fitted.bounds.x + fitted.bounds.width).toBeLessThanOrEqual(-554);
    expect(fitted.bounds.y + fitted.bounds.height).toBeLessThanOrEqual(768);
    expect(() => fitViewerPresentation({ width: 1920.5, height: 1080 }, 96, { x: 0, y: 0, width: 1366, height: 768 })).toThrow();
  });
});

describe('SEC-083 — verificador real demuestra movimiento sin mutación', () => {
  it('cubre viewport, URL, identidad y control del agente', async () => {
    const verifier = await source('scripts/verify-browser-controller.ts');
    for (const evidence of [
      'liveViewerFitsWorkArea',
      'liveViewerMovedWithoutNavigation',
      'liveViewerMoveAgentControlPreserved',
    ]) expect(verifier).toContain(`${evidence}: true`);
  });
});
