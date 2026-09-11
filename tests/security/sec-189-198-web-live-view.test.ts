import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`No se encontró la sección ${start}`);
  return text.slice(from, to);
}

describe("SEC-189..198 — vista web local pasiva", () => {
  it("SEC-189 muestra el WebContents remoto existente sin duplicar navegación", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const show = section(controller, "async showLiveViewerLocally(", "async hideLiveViewerLocally(");
    expect(controller).toContain("readonly content: WebContentsView");
    expect(show).toContain("this.showViewerWindow(entry, tab, workArea, presentationMode)");
    expect(show).not.toContain("new BrowserWindow");
    expect(show).not.toContain("new WebContentsView");
    expect(show).not.toContain("content.webContents.loadURL");
    const createTab = section(controller, "private async createTab(", "async start(");
    expect(createTab.match(/content\.webContents\.loadURL\(destination\.href\)/g)).toHaveLength(1);
  });

  it("SEC-190 la presentación pasiva rechaza foco y ratón", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const show = section(controller, "private async showViewerWindow", "private liveTabs");
    expect(show).toContain("setIgnoreMouseEvents(true)");
    expect(show).toContain("setFocusable(false)");
    expect(show).toContain("showInactive()");
    expect(show).not.toContain(".focus()");
  });

  it("SEC-191 observar exige read, no interact ni humanControl", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const show = section(controller, "async showLiveViewerLocally(", "async hideLiveViewerLocally(");
    expect(show).toContain("this.requireSession(sessionId)");
    expect(show).not.toContain('requireSession(sessionId, "interact")');
    expect(show).not.toContain('requireSession(sessionId, "humanControl")');
  });

  it("SEC-192 la banda confiable está aislada de la página remota", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("default-src 'none'; style-src 'unsafe-inline'");
    expect(controller).toContain('partition: `localbridge-web-shell-${randomBytes(16)');
    expect(controller).toContain("window.contentView.addChildView(frame)");
    expect(controller).toContain("frame.addChildView(content)");
    expect(controller).toContain("shellContents.setWindowOpenHandler(() => ({ action: \"deny\" }))");
    expect(controller).toContain('callback({ cancel: !(details.url === "about:blank" || details.url.startsWith("data:text/html")) })');
  });

  it("SEC-193 todos los canales locales validan sender y objetos estrictos", async () => {
    const main = await source("apps/desktop/src/main/index.ts");
    const schemas = await source("packages/desktop-core/src/ipc-inputs.ts");
    for (const channel of ["viewerState", "tabs", "showLiveViewer", "hideLiveViewer", "moveLiveViewer"]) {
      const handler = section(main, `ipcMain.handle("webActivity:${channel}"`, "  });");
      expect(handler).toContain("assertTrustedSender(event)");
    }
    for (const schema of ["webViewerStateInputSchema", "webTabsInputSchema", "webLiveViewerShowInputSchema", "webLiveViewerHideInputSchema", "webLiveViewerMoveInputSchema"]) {
      expect(schemas).toMatch(new RegExp(`${schema}[\\s\\S]{0,700}\\.strict\\(\\)`));
    }
    expect(schemas).not.toContain("workArea");
  });

  it("SEC-194 el visor no agrega tools MCP, permisos ni revisión de protocolo", async () => {
    const server = await source("packages/mcp-server/src/server.ts");
    const workspaceTypes = await source("packages/workspace/src/types.ts");
    const protocol = await source("packages/development/src/protocol.ts");
    expect(server).not.toContain("web.showLiveViewer");
    expect(server).not.toContain("web.hideLiveViewer");
    expect(workspaceTypes).not.toContain("webLiveViewer");
    expect(protocol).toContain("DEVELOPMENT_BROKER_PROTOCOL = 19 as const");
  });

  it("SEC-195 el handoff retira el visor y la devolución no lo reabre", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const request = section(controller, "private async beginHumanControl(", "async requestHumanControl(");
    const complete = section(controller, "async completeHumanControlLocally(", "async declineHumanControlLocally(");
    expect(request).toContain("await this.hideLiveViewerLocally(entry.sessionId)");
    expect(request.indexOf('entry.controlState = "waiting_for_human"')).toBeLessThan(request.indexOf("await this.hideLiveViewerLocally(entry.sessionId)"));
    expect(request.indexOf("reserveHumanControl")).toBeLessThan(request.indexOf('entry.controlState = "waiting_for_human"'));
    expect(complete).toContain("setIgnoreMouseEvents(true)");
    expect(complete).toContain("setFocusable(false)");
    expect(complete).toContain("await this.stopEntry(entry)");
    expect(complete).not.toContain("showLiveViewerLocally");
  });

  it("SEC-196 un coordinador global serializa web y desarrollo", async () => {
    const coordinator = await source("apps/desktop/src/main/live-viewer-coordinator.ts");
    const main = await source("apps/desktop/src/main/index.ts");
    expect(coordinator).toContain('kind: "development"');
    expect(coordinator).toContain('kind: "web"');
    expect(coordinator).toContain("await this.hideTarget(previous)");
    expect(coordinator).toContain("private tail: Promise<void>");
    expect(coordinator).toContain("this.pendingTarget = target");
    expect(main).toContain("liveViewerCoordinator.show(");
    expect(main).toContain("reconcileLiveViewerCoordinatorState()");
    expect(main).toContain("liveViewerCoordinator?.release(current)");
  });

  it("SEC-197 ocultar y cerrar visualmente conservan la pestaña; cerrar real destruye ambos recursos", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const hide = section(controller, "async hideLiveViewerLocally(", "async moveLiveViewerLocally(");
    const destroy = section(controller, "private destroyTabWindow", "private async showViewerWindow");
    expect(hide).toContain("this.hideViewerWindow(tab)");
    expect(hide).not.toContain("destroyTabWindow");
    expect(controller).toContain("event.preventDefault()");
    expect(destroy).toContain("removeChildView(tab.content)");
    expect(destroy).toContain("contents.close()");
    expect(destroy).toContain("tab.window.destroy()");
  });

  it("SEC-198 Electron real cubre identidad, modos, privacidad, ciclos y coexistencia", async () => {
    const webVerifier = await source("scripts/verify-web-controller.ts");
    const coexistenceVerifier = await source("scripts/verify-electron-process-supervisor.ts");
    for (const evidence of [
      "publicReadOnlyLiveViewer", "trustedLocalToolbar", "passiveCloseOnlyHides",
      "stableWebContentsIdentity", "repeatedViewerCycles: 50", "followAndPinnedModes",
      "remoteFullscreenBlocked", "concurrentFollowUsesLatestStart",
      "privateHandoffClosesViewer", "noAutomaticViewerRestore", "failedReturnClosesSession",
      "publicDirectHumanControl", "humanTabSelectorPrivate", "delegatedExactHostname",
      "delegatedPrivateUrlRedacted", "delegatedOtherTabsDestroyed", "delegatedExpiryClosesSession",
    ]) expect(webVerifier).toContain(evidence);
    expect(coexistenceVerifier).toContain("exclusiveLiveViewerCoexistence: true");
    expect(await source("apps/desktop/src/main/web-controller.ts")).toContain('sendCommand("Page.captureScreenshot"');
  });
});
