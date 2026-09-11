import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseBrokerParams } from '@localbridge/development';
import { buildPortableConfig, DEFAULT_DESKTOP_SETTINGS } from '@localbridge/desktop-core';
import { parseWorkspaceRegistry, workspaceSchema, type WorkspaceRegistry } from '@localbridge/workspace';

import { buildWorkspace } from '../helpers/fixtures.js';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

const base = buildWorkspace({ id: 'ws_human', rootPath: 'C:\\project' });
const request = {
  workspaceId: 'ws_human',
  sessionId: `session_${'a'.repeat(24)}`,
  reason: 'manual_step' as const,
  operationId: 'human_request_1',
};

describe('SEC-084 — control humano es una única autoridad default-deny', () => {
  it('queda apagado por defecto y exige browserRead', () => {
    expect(workspaceSchema.parse(base).permissions.browserHumanControl).toBe(false);
    expect(workspaceSchema.safeParse({
      ...base,
      permissions: { ...base.permissions, browserRead: false, browserHumanControl: true },
    }).success).toBe(false);
  });
});

describe('SEC-085 — migración v3 usa la intersección de autoridades previas', () => {
  it.each([
    [false, false, false], [true, false, false], [false, true, false], [true, true, true],
  ])('auth=%s manual=%s -> unified=%s', (browserAuthenticate, browserManualControl, expected) => {
    const migrated = parseWorkspaceRegistry({
      schemaVersion: 3,
      workspaces: [{
        ...base,
        permissions: { ...base.permissions, browserRead: true, browserAuthenticate, browserManualControl },
      }],
      applications: [],
    });
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.workspaces[0]?.permissions.browserHumanControl).toBe(expected);
    expect(migrated.workspaces[0]?.automationReviewRequired).toBe(browserAuthenticate !== browserManualControl);
  });
});

describe('SEC-086 — protocolo humano transporta solo identificadores y razón cerrada', () => {
  it('rechaza rutas, archivos, secretos, URL, selector e instrucciones', () => {
    expect(parseBrokerParams('browser.human.request', request)).toEqual(request);
    for (const extra of [
      { path: 'C:\\private\\fixture.xlsx' }, { fileName: 'fixture.xlsx' }, { bytes: 'AAAA' },
      { url: 'http://127.0.0.1:5173/upload' }, { selector: '#file' }, { instruction: 'haz clic' },
      { password: 'secret' }, { credential: 'secret' }, { cookie: 'secret' },
    ]) expect(() => parseBrokerParams('browser.human.request', { ...request, ...extra })).toThrow();
    expect(() => parseBrokerParams('browser.human.request', { ...request, reason: 'upload_anything' })).toThrow();
    expect(() => parseBrokerParams('browser.human.status', {
      workspaceId: request.workspaceId, sessionId: request.sessionId, selectedFile: 'fixture.xlsx',
    })).toThrow();
  });
});

describe('SEC-087 — herramientas MCP exigen ambas capacidades', () => {
  it('requieren browserRead y browserHumanControl y no exponen datos ingresados', async () => {
    const tools = await source('packages/mcp-server/src/tools/browser-human-tools.ts');
    expect(tools).toContain("requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, id, 'browserRead')");
    expect(tools).toContain("requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, id, 'browserHumanControl')");
    expect(tools).toContain("z.enum(['sign_in', 'file_selection', 'manual_step'])");
    expect(tools).not.toMatch(/password|selectedFile|filePath|dataBase64/);
  });
});

describe('SEC-088 — catálogo público retira autoridades antiguas', () => {
  it('registra solo browser.human.request/status', async () => {
    const server = await source('packages/mcp-server/src/server.ts');
    expect(server).toContain('registerBrowserHumanRequestTool');
    expect(server).toContain('registerBrowserHumanStatusTool');
    expect(server).not.toContain('registerBrowserAuth');
    expect(server).not.toContain('registerBrowserManual');
  });
});

describe('SEC-089 — el agente queda excluido durante todo el control humano', () => {
  it('bloquea operaciones, invalida referencias y drena las que estaban en curso', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain("fail('HUMAN_CONTROL_ACTIVE'");
    expect(controller).toContain('waitForAgentOperations');
    expect(controller).toContain('controlEpoch');
    expect(controller).toContain('this.invalidateSnapshot(entry)');
  });
});

describe('SEC-090 — el agente no observa durante control humano', () => {
  it('oculta eventos, capturas y listado antes de abrir la ventana', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain("['waiting_for_human', 'human_control', 'returning_to_agent']");
    expect(controller).toContain("state: 'private'");
    expect(controller).toContain('entry.events.length = 0');
    expect(controller).toContain('entry.content.webContents.debugger.detach()');
  });
});

describe('SEC-091 — el usuario toma control solo mediante acción local explícita', () => {
  it('la solicitud MCP reserva pero no invoca la apertura de la ventana', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const requestBody = controller.slice(controller.indexOf('async requestHumanControl('), controller.indexOf('async humanControlStatus('));
    expect(requestBody).toContain("entry.controlState = 'waiting_for_human'");
    expect(requestBody).not.toContain('openHumanControlLocally');
    expect(controller).toContain('async takeHumanControlLocally(');
  });
});

describe('SEC-092 — solo puede existir una sesión humana activa', () => {
  it('mantiene un cerrojo global y falla cerrado ante concurrencia', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain('private humanSessionId: string | undefined');
    expect(controller).toContain("fail('HUMAN_CONTROL_BUSY'");
  });
});

describe('SEC-093 — selector de archivos permanece bajo control humano', () => {
  it('intercepta el selector bajo CDP y bloquea inputs file al agente', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain('Page.fileChooserOpened');
    expect(controller).toContain("Page.setInterceptFileChooserDialog', { enabled: true }");
    expect(controller).toContain('input[type="file"]');
    expect(controller.match(/SENSITIVE_INPUT_BLOCKED/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('SEC-094 — devolución reinstala toda la frontera del agente', () => {
  it('oculta ventana, limpia observaciones, restaura shell y vuelve a adjuntar CDP', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const handoff = controller.slice(controller.indexOf('async completeHumanControlLocally('), controller.indexOf('async declineHumanControlLocally('));
    expect(handoff).toContain('entry.window.setIgnoreMouseEvents(true)');
    expect(handoff).toContain('entry.events.length = 0');
    expect(handoff).toContain('await this.restoreAgentShell(entry)');
    expect(handoff).toContain('await this.installDebugger(entry');
    expect(handoff).toContain('await entry.window.loadURL(entry.trustedShellUrl)');
    expect(handoff).toContain("entry.controlState = 'human_control'");
    expect(handoff.indexOf('this.invalidateSnapshot(entry)')).toBeLessThan(handoff.indexOf('await this.installDebugger(entry'));
  });
});

describe('SEC-095 — el plazo posterior a la devolución es duro', () => {
  it('se crea una sola vez y no puede extenderse por una nueva intervención', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain('entry.postHumanExpiresAt ??= Date.now() + POST_HUMAN_SESSION_TTL_MS');
    expect(controller).not.toContain('entry.postHumanExpiresAt = Date.now() + POST_HUMAN_SESSION_TTL_MS');
    expect(controller).toContain("void this.stopEntry(entry, 'expired')");
  });
});

describe('SEC-096 — revocar el permiso destruye la autoridad viva', () => {
  it('revalida browserHumanControl en sesión y en todas las dependencias', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller.match(/permissions\.browserHumanControl !== true/g)?.length).toBeGreaterThanOrEqual(4);
    expect(controller).toContain('await this.requireApplicationWorkspace(service.workspaceId, true)');
  });
});

describe('SEC-097 — portabilidad v4 nunca concede control humano', () => {
  it('exporta la capacidad apagada aunque estuviera activa localmente', () => {
    const workspace = workspaceSchema.parse({
      ...base,
      permissions: { ...base.permissions, browserRead: true, browserHumanControl: true },
    });
    const registry: WorkspaceRegistry = { schemaVersion: 5, workspaces: [workspace], applications: [] };
    const portable = buildPortableConfig(DEFAULT_DESKTOP_SETTINGS, registry);
    expect(portable.version).toBe(4);
    if (portable.version !== 4) throw new Error('formato portable inesperado');
    expect(portable.workspaces[0]?.permissions.browserHumanControl).toBe(false);
  });
});

describe('SEC-098 — visor ligero sigue siendo solo salida', () => {
  it('usa una imagen sin eventos de entrada ni persistencia local', async () => {
    const renderer = await source('apps/desktop/src/renderer/src/main.ts');
    const css = await source('apps/desktop/src/renderer/src/style.css');
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(renderer).not.toMatch(/browser-viewer-image[^\n]+addEventListener/);
    expect(css).toMatch(/\.browser-viewer-stage[\s\S]*?pointer-events:\s*none/);
    const capture = controller.slice(controller.indexOf('async captureForLocalViewer'), controller.indexOf('async reconcile'));
    expect(capture).not.toMatch(/writeFile|createWriteStream|appendFile|mkdtemp|tmpdir/);
  });
});

describe('SEC-099 — control humano conserva el mismo navegador aislado', () => {
  it('reutiliza BrowserWindow/WebContents y no crea una segunda sesión', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    const open = controller.slice(controller.indexOf('async openHumanControlLocally('), controller.indexOf('async completeHumanControlLocally('));
    expect(open).toContain('entry.window.loadURL(entry.trustedShellUrl)');
    expect(open).not.toContain('new BrowserWindow');
    expect(open).not.toContain('new WebContentsView');
  });
});

describe('SEC-100 — control humano respeta la frontera multimonitor', () => {
  it('resuelve el monitor localmente y nunca por el protocolo MCP', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const protocol = await source('packages/development/src/protocol.ts');
    expect(main).toContain('screen.getAllDisplays()');
    expect(main).toContain("ipcMain.handle('development:takeHumanControl'");
    expect(protocol).not.toMatch(/displayId|workArea|screenId/);
  });
});

describe('SEC-101 — IPC no expone un canal arbitrario', () => {
  it('preload publica acciones cerradas y no expone ipcRenderer', async () => {
    const preload = await source('apps/desktop/src/preload/index.ts');
    expect(preload).toContain("ipcRenderer.invoke('development:takeHumanControl'");
    expect(preload).toContain("ipcRenderer.invoke('development:declineHumanControl'");
    expect(preload).toContain("ipcRenderer.invoke('development:revokeHumanControl'");
    expect(preload).not.toContain('contextBridge.exposeInMainWorld(\'ipcRenderer\'');
  });
});

describe('SEC-102 — razones no crean permisos distintos', () => {
  it('las tres razones usan exactamente la misma herramienta y transición', async () => {
    const tools = await source('packages/mcp-server/src/tools/browser-human-tools.ts');
    expect(tools.match(/registerBrowserHumanRequestTool/g)?.length).toBeGreaterThanOrEqual(1);
    expect(tools).not.toMatch(/requireSignIn|requireFileSelection|permissionByReason/);
  });
});

describe('SEC-103 — cancelar, denegar y expirar convergen en limpieza', () => {
  it('detiene la sesión, limpia almacenamiento y olvida operaciones', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain('entry.browserSession.clearStorageData()');
    expect(controller).toContain('this.humanControlOperations.delete(key)');
    expect(controller).toContain("await this.stopEntry(entry, 'declined')");
  });
});

describe('SEC-104 — listado remoto no revela una sesión privada', () => {
  it('excluye estados humanos de la superficie de agente', async () => {
    const controller = await source('apps/desktop/src/main/browser-controller.ts');
    expect(controller).toContain("entry.controlState !== 'agent_control'");
    expect(controller).toContain('return entries.map(summary)');
    expect(controller).toContain('this.ensureAgentControl(entry)');
  });
});

describe('SEC-105 — la UI ofrece una única decisión de autoridad', () => {
  it('usa un permiso y un botón de toma de control', async () => {
    const renderer = await source('apps/desktop/src/renderer/src/main.ts');
    expect(renderer).toContain("browserHumanControl: 'Permitir control humano exclusivo'");
    expect(renderer).toContain('data-human-take');
    expect(renderer).not.toContain('data-manual-open');
    expect(renderer).not.toContain('data-auth-open');
  });
});
