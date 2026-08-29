import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBrokerParams } from "@localbridge/development";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

const sessionId = `session_${"a".repeat(24)}`;

describe("SEC-157..160 — emulación de viewport (ADR-0042)", () => {
  it("SEC-157: el viewport solo acepta dimensiones acotadas y una bandera táctil", () => {
    const valid = { workspaceId: "ws_web", sessionId, width: 1280, height: 800, mobile: false, operationId: "vp-1" };
    expect(parseBrokerParams("browser.viewport", valid)).toEqual(valid);
    for (const injected of [
      { url: "http://127.0.0.1:5173" },
      { origin: "http://evil.local" },
      { port: 5173 },
      { userAgent: "curl/8" },
      { deviceScaleFactor: 3 },
      { selector: "body" },
      { script: "alert(1)" },
      { path: "../.." },
    ]) {
      expect(() => parseBrokerParams("browser.viewport", { ...valid, ...injected }), JSON.stringify(injected)).toThrow();
    }
  });

  it("SEC-158: los límites de tamaño se aplican en el protocolo y en el controlador", async () => {
    const valid = { workspaceId: "ws_web", sessionId, mobile: false, operationId: "vp-1" };
    for (const size of [{ width: 319, height: 800 }, { width: 3841, height: 800 }, { width: 1280, height: 319 }, { width: 1280, height: 2161 }]) {
      expect(() => parseBrokerParams("browser.viewport", { ...valid, ...size }), JSON.stringify(size)).toThrow();
    }
    // La comprobación se repite en el proceso principal: el broker es privado,
    // pero el controlador no confía en que su entrada ya venga validada.
    const controller = await source("apps/desktop/src/main/browser-controller.ts");
    expect(controller).toContain("width < 320 || width > 3840 || height < 320 || height > 2160");
    expect(controller).toContain("INVALID_INPUT");
  });

  it("SEC-159: emular tamaño no concede capacidades ni cambia el origen permitido", async () => {
    const controller = await source("apps/desktop/src/main/browser-controller.ts");
    const method = controller.slice(controller.indexOf("async setViewport("), controller.indexOf("private async clearViewportEmulation("));
    expect(method).toContain("withAgentOperation");
    expect(method).toContain("Emulation.setDeviceMetricsOverride");
    expect(method).toContain("invalidateSnapshot");
    // Ni navega, ni toca la allowlist, ni ejecuta JavaScript de la página.
    expect(method).not.toMatch(/loadURL|allowedOrigins|executeJavaScript|Runtime\.evaluate|setUserAgent/);
  });

  it("SEC-160: el control humano devuelve la ventana a su tamaño real", async () => {
    const controller = await source("apps/desktop/src/main/browser-controller.ts");
    expect(controller).toContain("await this.clearViewportEmulation(entry);");
    expect(controller).toContain("Emulation.clearDeviceMetricsOverride");
    // Capturas y visor informan el tamaño realmente renderizado, no el
    // declarado por el perfil; la única referencia al perfil que queda es el
    // reseteo dentro de `clearViewportEmulation`.
    expect(controller.match(/width: entry\.currentViewport\.width,/g)?.length).toBeGreaterThanOrEqual(2);
    expect(controller.match(/width: entry\.profile\.viewport\.width,/g)?.length).toBe(1);
  });
});
