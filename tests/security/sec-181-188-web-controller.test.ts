import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBrokerParams } from "@localbridge/development";

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}

describe("SEC-181..188 — navegador web externo aislado", () => {
  it("SEC-181 usa una partición efímera y renderer sin Node", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("partition: `localbridge-web-${randomBytes(16)");
    expect(controller).not.toContain("persist:localbridge-web");
    expect(controller).toContain("nodeIntegration: false");
    expect(controller).toContain("contextIsolation: true");
    expect(controller).toContain("sandbox: true");
    expect(controller).toContain("webSecurity: true");
    expect(controller).toContain("allowRunningInsecureContent: false");
    expect(controller).toContain("devTools: false");
  });

  it("SEC-182 deniega permisos Chromium y descargas iniciadas por la página", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("setPermissionCheckHandler(() => false)");
    expect(controller).toContain("setPermissionRequestHandler((_contents, _permission, callback) => callback(false))");
    expect(controller).toContain('browserSession.on("will-download", (event, _item, webContents) => {');
    expect(controller).toContain('event.preventDefault()');
    expect(controller).toContain('tab.blockedDownloadSequence += 1');
  });

  it("SEC-183 aplica proxy y filtro vivo a todos los recursos, redirects y popups", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain('proxyBypassRules: "<-loopback>"');
    expect(controller).toContain("browserSession.webRequest.onBeforeRequest");
    expect(controller).toContain("isAllowedPartitionRequest(current, details.url, details.resourceType, entry.delegatedSite)");
    expect(controller).toContain('contents.on("will-redirect", validateMainDestination)');
    expect(controller).toContain("contents.setWindowOpenHandler");
    expect(controller).toContain('return { action: "deny" }');
  });

  it("SEC-184 deshabilita QUIC y UDP WebRTC no mediado antes de arrancar Electron", async () => {
    const main = await source("apps/desktop/src/main/index.ts");
    expect(main).toContain('app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp")');
    expect(main).toContain('app.commandLine.appendSwitch("disable-quic")');
  });

  it("SEC-185 mantiene controladores, IDs y presupuestos separados", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const main = await source("apps/desktop/src/main/index.ts");
    expect(main).toContain("browserController = new BrowserController");
    expect(main).toContain("webController = new WebController");
    expect(controller).toContain('`websession_${randomBytes(12)');
    expect(controller).toContain('`webtab_${randomBytes(12)');
    expect(controller).toContain("MAX_GLOBAL_WEB_SESSIONS");
    expect(controller).toContain("MAX_GLOBAL_WEB_TABS");
  });

  it("SEC-186 no expone subida, selector, JavaScript, cookies ni credenciales por MCP", async () => {
    const tools = await source("packages/mcp-server/src/tools/web-tools.ts");
    expect(tools).not.toContain("web.upload");
    const base = {
      sessionId: `websession_${"a".repeat(24)}`,
      tabId: `webtab_${"b".repeat(24)}`,
      url: "https://example.com/",
      operationId: "navigate_1",
    };
    for (const key of ["cssSelector", "xpath", "javascript", "cookie", "password", "credential", "filePath"]) {
      expect(() => parseBrokerParams("web.navigate", { ...base, [key]: "unsafe" })).toThrow();
    }
  });

  it("SEC-187 conserva operaciones pendientes y nunca repite un efecto incierto", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain('state: "pending"');
    expect(controller).toContain('if (previous.state !== "complete") fail("WEB_EFFECT_UNCERTAIN"');
    expect(controller.match(/fail\("WEB_EFFECT_UNCERTAIN"/g)?.length).toBeGreaterThanOrEqual(7);
    expect(controller).toContain("effectStarted = true");
    expect(controller).toContain("saveStarted = true");
  });

  it("SEC-188 revocación y control humano invalidan toda observación/acción web", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("profileRevision(current) !== entry.profileRevision");
    expect(controller).toContain("await this.stopEntry(entry)");
    expect(controller).toContain('fail("HUMAN_CONTROL_ACTIVE"');
    expect(controller).toContain("await this.waitForAgentOperations(entry)");
    expect(controller).toContain("this.ensureAgentControl(entry)");
    expect(controller).toContain("tab.snapshot = undefined");
    expect(controller).toContain("tab.resources.clear()");
  });

  it("SEC-188a intercepta selección de archivo directa e indirecta", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain('Page.setInterceptFileChooserDialog');
    expect(controller).toContain('method === "Page.fileChooserOpened"');
    expect(controller).toContain("label.control instanceof HTMLInputElement");
    expect(controller).toContain('fail("HUMAN_ACTION_REQUIRED"');
  });
});
