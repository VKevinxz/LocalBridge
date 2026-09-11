import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSiteAccountProfile,
  rememberExactSiteAccess,
  webHumanCycleInputSchema,
  webHumanTakeInputSchema,
} from "@localbridge/desktop-core";
import { HumanControlCoordinator, HumanControlCoordinatorError } from "../../apps/desktop/src/main/human-control-coordinator.js";

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}

describe("SEC-199..212 — navegación y control humano unificados", () => {
  it("SEC-199 mantiene Internet como configuración y concentra sesiones en Actividad", async () => {
    const renderer = await source("apps/desktop/src/renderer/src/main.ts");
    expect(renderer).toContain("['web', 'Acceso a Internet']");
    expect(renderer).toContain("<h2>Actividad en curso</h2>");
    expect(renderer).toContain('class="source-pill">LOCAL');
    expect(renderer).toContain('class="source-pill">INTERNET');
  });

  it("SEC-200 permite toma pública solo desde IPC local y conserva el bloqueo MCP", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain('initiatedLocally && entry.profile.kind === "public-research" ? "read" : "humanControl"');
    expect(controller).toContain("return this.beginHumanControl(sessionId, reason, operationId, false)");
  });

  it("SEC-201 serializa globalmente la intervención entre desarrollo e Internet", () => {
    const coordinator = new HumanControlCoordinator();
    coordinator.reserve({ kind: "development", sessionId: "session_a" });
    expect(() => coordinator.reserve({ kind: "web", sessionId: "websession_b" })).toThrow(HumanControlCoordinatorError);
    coordinator.release({ kind: "development", sessionId: "session_a" });
    expect(() => coordinator.reserve({ kind: "web", sessionId: "websession_b" })).not.toThrow();
  });

  it("SEC-201 conserva una prueba Electron de exclusión cruzada", async () => {
    const verifier = await source("scripts/verify-electron-process-supervisor.ts");
    expect(verifier).toContain("globalHumanControlExclusive: true");
    expect(verifier).toContain("error.code === 'HUMAN_CONTROL_BUSY'");
  });

  it("SEC-202 valida toma y cambio de pestaña con objetos IPC estrictos", () => {
    const sessionId = `websession_${"a".repeat(24)}`;
    const tabId = `webtab_${"b".repeat(24)}`;
    expect(webHumanTakeInputSchema.parse({ sessionId, tabId })).toEqual({ sessionId, tabId });
    expect(webHumanCycleInputSchema.parse({ sessionId, direction: "next" })).toEqual({ sessionId, direction: "next" });
    expect(() => webHumanTakeInputSchema.parse({ sessionId, root: "C:\\" })).toThrow();
    expect(() => webHumanCycleInputSchema.parse({ sessionId, direction: "next", command: "cmd" })).toThrow();
  });

  it("SEC-203 descarta respuestas tardías antes de restaurar pestañas observables", async () => {
    const renderer = await source("apps/desktop/src/renderer/src/main.ts");
    expect(renderer).toContain("const generation = ++webRefreshGeneration");
    expect(renderer.match(/generation !== webRefreshGeneration/g)?.length).toBeGreaterThanOrEqual(2);
    expect(renderer).toContain("let nextTabs: Record<string, readonly WebTabActivitySummary[]> = {}");
  });

  it("SEC-204 limita la devolución pública al hostname exacto y a quince minutos", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("entry.delegatedSite = currentHostname");
    expect(controller).toContain("entry.proxy.restrictToHosts([currentHostname])");
    expect(controller).toContain("Date.now() + HUMAN_CONTROL_TTL_MS");
    expect(controller).toContain("hostname === entry.delegatedSite");
  });

  it("SEC-205 cierra conexiones existentes al reducir la salida del proxy", async () => {
    const proxy = await source("apps/desktop/src/main/web-egress-proxy.ts");
    expect(proxy).toContain("restrictedHostnames?.has(hostname)");
    expect(proxy).toContain("for (const socket of sockets) socket.destroy()");
    expect(proxy).toContain("for (const upstream of upstreams) upstream.destroy()");
  });

  it("SEC-206 destruye otras pestañas antes de devolver una sesión pública", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("if (tab.tabId === selected.tabId || tab.state === \"closed\") continue");
    expect(controller).toContain("this.destroyTabWindow(tab)");
    expect(controller).toContain('clearStorageData({ storages: ["serviceworkers", "cachestorage"] })');
    expect(controller).toContain("await selected.content.webContents.loadURL(currentUrl!.href)");
    expect(controller).toContain("reloaded?.hostname !== currentHostname");
  });

  it("SEC-207 mantiene particiones efímeras y borra almacenamiento al cerrar", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).not.toContain("persist:localbridge-web");
    expect(controller).toContain("entry.browserSession.clearStorageData()");
    expect(controller).toContain("entry.browserSession.clearCache()");
  });

  it("SEC-208 confirma localmente usando solo nombre de perfil y hostname", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    const main = await source("apps/desktop/src/main/index.ts");
    expect(controller).toContain("hostname: currentHostname");
    expect(main).toContain("¿Permites que ChatGPT continúe en ${hostname}?");
    expect(main).not.toContain("confirmHumanControlHandoff: async (url");
  });

  it("SEC-209 recordar crea o reutiliza un perfil exacto sin hosts auxiliares", async () => {
    const main = await source("apps/desktop/src/main/index.ts");
    const existing = buildSiteAccountProfile({
      name: "Existente", destinations: ["account.example"], includeSubdomains: false,
    }, new Date("2026-09-06T10:00:00.000Z"));
    const remembered = rememberExactSiteAccess({ schemaVersion: 1, profiles: [existing] }, "account.example");
    expect(remembered.profiles).toHaveLength(1);
    expect(remembered.profiles[0]).toMatchObject({
      id: existing.id,
      enabled: true,
      destinations: [{ hostname: "account.example", includeSubdomains: false }],
      supportHosts: [],
    });
    expect(main).toContain("rememberExactSiteAccess(snapshot.document, hostname)");
    expect(main).toContain("replaceWebProfileStore");
  });

  it("SEC-210 abre popups humanos sin debugger y los mantiene en la sesión", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("this.createTab(entry, destination, true)");
    expect(controller).toContain("if (humanMode)");
    expect(controller).toContain("await this.installDebugger(content.webContents, tab.currentViewport)");
  });

  it("SEC-211 muestra una sola pestaña interactiva durante control humano", async () => {
    const controller = await source("apps/desktop/src/main/web-controller.ts");
    expect(controller).toContain("if (tab.tabId !== selected.tabId)");
    expect(controller).toContain("this.hideHumanWindow(tab)");
    expect(controller).toContain("entry.humanTabId = selected.tabId");
  });

  it("SEC-212 extiende resultados, no la superficie MCP", async () => {
    const tools = await source("packages/mcp-server/src/tools/web-tools.ts");
    const server = await source("packages/mcp-server/src/server.ts");
    const protocol = await source("packages/development/src/protocol.ts");
    expect(tools).toContain("delegatedSite");
    expect(tools).toContain("delegatedExpiresAt");
    expect(protocol).toContain("DEVELOPMENT_BROKER_PROTOCOL = 19 as const");
    expect(server).not.toContain("web.human.take");
  });
});
