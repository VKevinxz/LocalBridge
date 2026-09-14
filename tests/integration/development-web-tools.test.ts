import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DevelopmentBrokerError, startDevelopmentBroker, type RunningDevelopmentBroker } from "@localbridge/development";
import { LocalBridgeError, TARGET_PROTOCOL_REVISION } from "@localbridge/shared";
import { queryAuditEvents } from "@localbridge/audit";
import { callToolJson } from "../helpers/call.js";
import { createHarness, type Harness } from "../helpers/harness.js";

let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;
afterEach(async () => {
  await harness?.close();
  await broker?.close();
  harness = undefined;
  broker = undefined;
});

describe("web.* vía broker privado", () => {
  it("recarga la pestaña actual sin aceptar URL ni omitir operationId", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return {
        tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", title: "Fixture", url: "https://example.com/", state: "ready",
        openedAt: "2026-09-12T00:00:00.000Z", viewport: { width: 1920, height: 1080, mobile: false },
        blockedNativeDownloads: 0, blockedFileChoosers: 0, blockedDialogs: 0,
      };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const result = await callToolJson(harness.client, "web.reload", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      mode: "ignore-cache", operationId: "reload_web_1",
    });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ method: "web.reload", params: expect.objectContaining({ mode: "ignore-cache" }) })]);
    for (const invalid of [
      { sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", mode: "normal" },
      { sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", mode: "normal", operationId: "reload_web_2", url: "https://other.example/" },
    ]) expect((await harness.client.callTool({ name: "web.reload", arguments: invalid })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("descarga solo por referencia observada y conserva destino relativo", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return {
        path: "reports/source.pdf", sha256: "a".repeat(64), size: 12, created: true,
        mimeType: "application/pdf", resourceKind: "document", sourceUrl: "https://example.com/source.pdf",
      };
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      auditDbPath: path.join(os.tmpdir(), `localbridge-web-${randomUUID()}.db`),
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, "web.download", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa",
      tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      resourceRef: "webresource_cccccccccccccccccccc",
      workspaceId: "ws_reports",
      path: "reports/source.pdf",
      operationId: "download_1",
    });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({
      created: true, path: "reports/source.pdf", analysisRequired: true, suggestedTool: "document.read",
    });
    expect(calls).toEqual([expect.objectContaining({
      method: "web.download",
      params: expect.objectContaining({ resourceRef: "webresource_cccccccccccccccccccc", workspaceId: "ws_reports" }),
    })]);
    expect(JSON.stringify(calls)).not.toContain('"url"');
  });

  it("mantiene pendiente de análisis un formato descargado sin tool visual compatible", async () => {
    broker = await startDevelopmentBroker({ handler: async () => ({
      path: "assets/source.avif", sha256: "b".repeat(64), size: 24, created: true,
      mimeType: "image/avif", resourceKind: "image", sourceUrl: "https://example.com/source.avif",
    }) });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });
    const result = await callToolJson(harness.client, "web.download", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa",
      tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      resourceRef: "webresource_cccccccccccccccccccc",
      workspaceId: "ws_reports",
      path: "assets/source.avif",
      operationId: "download_avif",
    });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ analysisRequired: true });
    expect(result.parsed).not.toHaveProperty("suggestedTool");
  });

  it("rechaza URL libre, ruta absoluta e IDs de browser.* antes del broker", async () => {
    let calls = 0;
    broker = await startDevelopmentBroker({ handler: async () => { calls += 1; return {}; } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const base = {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      resourceRef: "webresource_cccccccccccccccccccc", workspaceId: "ws_reports", path: "report.pdf", operationId: "download_2",
    };
    expect((await harness.client.callTool({ name: "web.download", arguments: { ...base, url: "https://example.com/file.pdf" } })).isError).toBe(true);
    expect((await harness.client.callTool({ name: "web.download", arguments: { ...base, path: "C:\\private\\file.pdf" } })).isError).toBe(true);
    expect((await harness.client.callTool({ name: "web.download", arguments: { ...base, sessionId: "session_aaaaaaaaaaaaaaaaaaaaaaaa" } })).isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("permite iniciar investigación sin workspace y no envía roots locales", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return {
        session: { sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", webProfileId: "webprofile_bbbbbbbbbbbbbbbbbbbbbbbb", profileName: "Public", profileKind: "public-research", state: "running", startedAt: "2026-09-05T00:00:00.000Z", controlState: "agent_control", tabCount: 1 },
        tab: { tabId: "webtab_cccccccccccccccccccccccc", title: "", url: "about:blank", state: "ready", openedAt: "2026-09-05T00:00:00.000Z", viewport: { width: 1920, height: 1080, mobile: false }, blockedNativeDownloads: 0, blockedFileChoosers: 0, blockedDialogs: 0 },
      };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const result = await callToolJson(harness.client, "web.start", { webProfileId: "webprofile_bbbbbbbbbbbbbbbbbbbbbbbb", operationId: "research_1" });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(calls)).not.toMatch(/workspace|root|path/i);
  });

  it("acepta el estado compartido de visor y motion al listar pestañas", async () => {
    broker = await startDevelopmentBroker({ handler: async () => [{
      tabId: "webtab_cccccccccccccccccccccccc", title: "Referencia", url: "https://example.com/",
      state: "ready", openedAt: "2026-09-05T00:00:00.000Z",
      viewport: { width: 1920, height: 1080, mobile: false },
      blockedNativeDownloads: 0, blockedFileChoosers: 0, blockedDialogs: 0,
      motionCapture: { completed: 2, total: 12, mode: "auto" },
      lastMotionCapture: { path: "evidence/reference.lbmotion", frameCount: 12, totalSize: 8_000_000, captureMode: "screencast", warnings: [] },
      viewerPresentation: {
        mode: "fit", renderWidth: 1920, renderHeight: 1080, viewWidth: 1280, viewHeight: 720,
        scale: 2 / 3, panX: 0, panY: 0,
      },
    }] });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const result = await callToolJson(harness.client, "web.tabs", { sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ tabs: [expect.objectContaining({
      motionCapture: { completed: 2, total: 12, mode: "auto" },
      viewerPresentation: expect.objectContaining({ mode: "fit", scale: 2 / 3 }),
    })] });
  });

  it("reutiliza el resumen enriquecido en web.open, web.navigate y web.close", async () => {
    const calls: string[] = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request.method);
      return {
        tabId: "webtab_cccccccccccccccccccccccc", title: "Referencia", url: "https://example.com/",
        state: request.method === "web.close" ? "closed" : "ready",
        openedAt: "2026-09-05T00:00:00.000Z", viewport: { width: 1920, height: 1080, mobile: false },
        blockedNativeDownloads: 0, blockedFileChoosers: 0, blockedDialogs: 0,
        lastMotionCapture: { path: "evidence/reference.lbmotion", frameCount: 24, totalSize: 12_000_000, captureMode: "stepped", warnings: [] },
        viewerPresentation: {
          mode: "actual", renderWidth: 1920, renderHeight: 1080, viewWidth: 1200, viewHeight: 700,
          scale: 1, panX: 300, panY: 190,
        },
      };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const sessionId = "websession_aaaaaaaaaaaaaaaaaaaaaaaa";
    const tabId = "webtab_cccccccccccccccccccccccc";

    const opened = await callToolJson(harness.client, "web.open", { sessionId, url: "https://example.com/", operationId: "open_enriched" });
    const navigated = await callToolJson(harness.client, "web.navigate", { sessionId, tabId, url: "https://example.com/next", operationId: "navigate_enriched" });
    const closed = await callToolJson(harness.client, "web.close", { sessionId, tabId, operationId: "close_enriched" });

    for (const result of [opened, navigated, closed]) {
      expect(result.isError).toBe(false);
      expect(result.parsed).toMatchObject({
        lastMotionCapture: { frameCount: 24 },
        viewerPresentation: expect.objectContaining({ mode: "actual", scale: 1 }),
      });
    }
    expect(calls).toEqual(["web.open", "web.navigate", "web.close"]);
  });

  it("enumera assets opacos y configura viewport sin aceptar URL libre", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      if (request.method === "web.assets") return {
        tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", url: "https://example.com/", observedAt: "2026-09-06T00:00:00.000Z",
        assets: [{ resourceRef: "webresource_cccccccccccccccccccc", kind: "image", url: "https://example.com/hero.png", suggestedName: "hero.avif", observedMimeType: "image/avif" }], truncated: false,
      };
      return { sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", width: 1920, height: 1080, mobile: false, state: "ready" };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const assets = await callToolJson(harness.client, "web.assets", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", maxAssets: 50,
    });
    expect(assets.isError).toBe(false);
    expect(assets.parsed).toMatchObject({ assets: [expect.objectContaining({ suggestedName: "hero.avif", observedMimeType: "image/avif" })] });
    expect((await callToolJson(harness.client, "web.viewport", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb", width: 1920, height: 1080, mobile: false, operationId: "viewport_1",
    })).isError).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('"url"');
  });

  it("guarda la captura web como PNG relativo con recibo verificable", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const auditDbPath = path.join(os.tmpdir(), `localbridge-web-save-${randomUUID()}.db`);
    broker = await startDevelopmentBroker({ handler: async (request) => {
      calls.push(request);
      return {
        sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
        path: "evidence/reference.png", sha256: "b".repeat(64), size: 4321, created: true,
        mimeType: "image/png", width: 1920, height: 1080, fallbackUsed: false, sourceUrl: "https://example.com/reference",
      };
    } });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, auditDbPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const saved = await callToolJson(harness.client, "web.screenshot.save", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      workspaceId: "ws_reports", path: "evidence/reference.png", operationId: "save_reference_1",
    });
    expect(saved.isError).toBe(false);
    expect(saved.parsed).toMatchObject({ path: "evidence/reference.png", mimeType: "image/png", fallbackUsed: false });
    expect(calls).toHaveLength(1);
    expect(queryAuditEvents(auditDbPath, { action: "web.screenshot.save" })).toEqual([
      expect.objectContaining({
        workspaceId: "ws_reports", outcome: "success",
        resource: expect.stringContaining("evidence/reference.png:1920x1080:4321"),
      }),
    ]);

    expect((await harness.client.callTool({ name: "web.screenshot.save", arguments: {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      workspaceId: "ws_reports", path: "evidence/reference.jpg", operationId: "save_reference_2",
    } })).isError).toBe(true);
    expect((await harness.client.callTool({ name: "web.screenshot.save", arguments: {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      workspaceId: "ws_reports", path: "C:\\private\\reference.png", operationId: "save_reference_3",
    } })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("conserva FILE_TOO_LARGE al cruzar broker y MCP", async () => {
    broker = await startDevelopmentBroker({ handler: async () => {
      throw new LocalBridgeError("FILE_TOO_LARGE", { path: "C:\\privado\\reference.png" });
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });

    const result = await callToolJson(harness.client, "web.screenshot.save", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      workspaceId: "ws_reports", path: "evidence/reference.png", operationId: "save_too_large",
    });

    expect(result.isError).toBe(true);
    expect(result.parsed["error"]).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(JSON.stringify(result.parsed)).not.toMatch(/privado|reference\.png/i);
  });

  it("conserva una causa web catalogada sin transportar detalles arbitrarios", async () => {
    broker = await startDevelopmentBroker({ handler: async () => {
      throw new DevelopmentBrokerError(
        "WEB_EFFECT_UNCERTAIN",
        "D:\\privado\\navigation.log",
        "WEB_NAVIGATION_FAILED",
      );
    } });
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      developmentBrokerEndpoint: broker.endpoint,
      developmentBrokerToken: broker.token,
    });
    const result = await callToolJson(harness.client, "web.navigate", {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa",
      tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
      url: "https://example.com/current",
      operationId: "navigate_cause",
    });
    expect(result.isError).toBe(true);
    expect(result.parsed["error"]).toMatchObject({
      code: "WEB_EFFECT_UNCERTAIN",
      causeCode: "WEB_NAVIGATION_FAILED",
    });
    expect(JSON.stringify(result.parsed)).not.toContain("privado");
  });

  it("transporta una captura web JPEG acotada sin incluir base64 en structuredContent", async () => {
    broker = await startDevelopmentBroker({ handler: async () => ({
      mimeType: "image/jpeg", dataBase64: Buffer.from("jpeg-test").toString("base64"),
      width: 1920, height: 1080, fallbackUsed: true,
    }) });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
    const result = await harness.client.callTool({ name: "web.screenshot", arguments: {
      sessionId: "websession_aaaaaaaaaaaaaaaaaaaaaaaa", tabId: "webtab_bbbbbbbbbbbbbbbbbbbbbbbb",
    } });
    expect(result.isError).not.toBe(true);
    expect(result.content.some((item) => item.type === "image" && item.mimeType === "image/jpeg")).toBe(true);
    expect(result.structuredContent).toMatchObject({ mimeType: "image/jpeg", width: 1920, height: 1080, fallbackUsed: true });
    expect(JSON.stringify(result.structuredContent)).not.toContain("dataBase64");
  });
});
