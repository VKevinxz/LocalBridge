import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

function method(sourceText: string, start: string, end: string): string {
  return sourceText.slice(sourceText.indexOf(start), sourceText.indexOf(end));
}

describe('SEC-066 — la ventana en vivo pertenece solo a la UI local', () => {
  it('se expone por IPC confiable y no como tool MCP', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const preload = await source('apps/desktop/src/preload/index.ts');
    const server = await source('packages/mcp-server/src/server.ts');
    expect(main).toContain("ipcMain.handle('development:showLiveViewer'");
    expect(main).toContain("ipcMain.handle('development:hideLiveViewer'");
    expect(preload).toContain("ipcRenderer.invoke('development:showLiveViewer'");
    expect(preload).toContain("ipcRenderer.invoke('development:hideLiveViewer'");
    expect(server).not.toContain('showLiveViewer');
    expect(server).not.toContain('liveViewerSessionId');
  });
});

describe('SEC-067 — la vista en vivo reutiliza el navegador aislado', () => {
  it('mueve la ventana existente sin crear otro BrowserWindow ni WebContentsView', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const show = method(controller, 'async showLiveViewerLocally', 'async hideLiveViewerLocally');
    expect(show).toContain('this.positionLiveViewer(entry, workArea)');
    expect(show).toContain('entry.window.showInactive()');
    expect(show).not.toContain('new BrowserWindow');
    expect(show).not.toContain('new WebContentsView');
    expect(show).not.toContain('loadURL(entry.profile.origin)');
  });
});

describe('SEC-068 — observar nunca concede entrada', () => {
  it('ignora ratón, rehúsa foco y se muestra sin activarse', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const show = method(controller, 'async showLiveViewerLocally', 'async hideLiveViewerLocally');
    expect(show).toContain('entry.window.setIgnoreMouseEvents(true)');
    expect(show).toContain('entry.window.setFocusable(false)');
    expect(show).toContain('entry.window.showInactive()');
    expect(show).not.toContain('.focus()');
  });
});

describe('SEC-069 — solo existe una ventana en vivo global', () => {
  it('cierra visualmente la anterior antes de mostrar otra sesión', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain('private liveViewerSessionId: string | undefined');
    const show = method(controller, 'async showLiveViewerLocally', 'async hideLiveViewerLocally');
    expect(show).toContain('this.liveViewerSessionId !== sessionId');
    expect(show).toContain('this.hideLiveViewerEntry(previous, false)');
  });
});

describe('SEC-070 — cualquier control humano oculta la observación', () => {
  it('la autoridad unificada retira la ventana antes de esperar al usuario', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const human = method(controller, 'async requestHumanControl(', 'async humanControlStatus(');
    expect(human).toContain('this.hideLiveViewerEntry(entry)');
    expect(human).toContain("entry.controlState = 'waiting_for_human'");
  });
});

describe('SEC-071 — la banda superior de observación es contenido confiable', () => {
  it('usa una URL interna separada, CSP cerrada y no recibe contenido del proyecto', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const shell = method(controller, 'function agentShellHtml', 'function sameProfile');
    expect(shell).toContain("default-src 'none'");
    expect(shell).toContain('Sin ratón ni teclado');
    expect(shell).not.toContain('<script>');
    expect(controller).toContain('agentShellUrl');
    expect(controller).toContain('entry.trustedShellUrl = entry.agentShellUrl');
  });
});

describe('SEC-072 — los dos visores son mutuamente excluyentes', () => {
  it('detiene capturas antes de abrir en vivo y no ofrece ambos a la vez', async () => {
    const renderer = await source('apps/desktop/src/renderer/src/main.ts');
    const binding = method(renderer, "document.querySelectorAll<HTMLButtonElement>('[data-show-live-browser]')", 'function browserViewerHtml');
    expect(binding).toContain('stopBrowserViewer()');
    expect(renderer).toContain('agentOwns && !liveViewerOpen');
    expect(renderer).toContain('agentOwns && liveViewerOpen');
  });
});

describe('SEC-073 — la vista en vivo no amplía permisos persistentes', () => {
  it('reutiliza browserRead y no agrega una capacidad al workspace o a portabilidad', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const workspaceTypes = await source('packages/workspace/src/types.ts');
    const portability = await source('packages/desktop-core/src/portability.ts');
    const show = method(controller, 'async showLiveViewerLocally', 'async hideLiveViewerLocally');
    expect(show).toContain('await this.requireWorkspace(entry.workspaceId)');
    expect(workspaceTypes).not.toContain('browserLiveViewer');
    expect(portability).not.toContain('browserLiveViewer');
  });
});

describe('SEC-074 — ocultar y destruir convergen en cleanup', () => {
  it('limpia el estado al ocultar y antes de detener la sesión', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const hide = method(controller, 'private hideLiveViewerEntry', 'private async restoreAgentShell');
    const stop = method(controller, 'private async stopEntry', 'async stop(');
    expect(hide).toContain('this.liveViewerSessionId = undefined');
    expect(hide).toContain('entry.window.setPosition(-10_000, -10_000');
    expect(stop).toContain('this.hideLiveViewerEntry(entry, false)');
  });
});

describe('SEC-075 — el verificador nativo cubre identidad y exclusión', () => {
  it('demuestra misma ventana, mismo WebContents, ausencia de foco y auto-ocultado', async () => {
    const verifier = await source('scripts/verify-browser-controller.ts');
    for (const evidence of [
      'liveViewerSameWindow', 'liveViewerSameWebContents', 'liveViewerNonFocusable',
      'liveViewerAgentControlPreserved', 'liveViewerExecutionPreserved', 'liveViewerHumanAutoHide',
    ]) expect(verifier).toContain(`${evidence}: true`);
  });
});
