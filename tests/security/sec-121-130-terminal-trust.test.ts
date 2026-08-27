import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBrokerParams } from "@localbridge/development";
import { terminalListenerTargetInputSchema } from "@localbridge/desktop-core";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("SEC-121..130 — terminal v1 y confianza local", () => {
  it("SEC-124/126/127: MCP acepta solo IDs opacos y nunca root, shell o confianza", () => {
    const valid = { projectId: `project_${"a".repeat(24)}`, operationId: "start-1" };
    expect(parseBrokerParams("terminal.start", valid)).toEqual(valid);
    for (const injected of [
      { root: "C:\\" }, { cwd: "C:\\Users" }, { shell: "cmd.exe" }, { trustMode: "full-host" }, { env: { TOKEN: "x" } },
    ]) expect(() => parseBrokerParams("terminal.start", { ...valid, ...injected })).toThrow();
  });

  it("SEC-128: escritura exige proyecto y sesión opacos del protocolo", () => {
    const valid = {
      projectId: `project_${"a".repeat(24)}`,
      sessionId: `terminal_${"b".repeat(24)}`,
      text: "pnpm test\r\n",
      operationId: "write-1",
    };
    expect(parseBrokerParams("terminal.write", valid)).toEqual(valid);
    expect(() => parseBrokerParams("terminal.write", { ...valid, sessionId: "terminal_external" })).toThrow();
    expect(() => parseBrokerParams("terminal.write", { ...valid, text: "x".repeat(65_537) })).toThrow();
  });

  it("INT-005: navegador desde terminal usa solo listener opaco, nunca URL o puerto", () => {
    const valid = {
      workspaceId: "ws_demo",
      projectId: `project_${"a".repeat(24)}`,
      terminalSessionId: `terminal_${"b".repeat(24)}`,
      listenerRef: `listener_${"c".repeat(24)}`,
    };
    expect(parseBrokerParams("browser.start", valid)).toEqual(valid);
    expect(() => parseBrokerParams("browser.start", { ...valid, url: "http://127.0.0.1:5173" })).toThrow();
    expect(() => parseBrokerParams("browser.start", { ...valid, port: 5173 })).toThrow();
  });

  it("SEC-141..145: composición terminal acepta solo siete refs secundarias opacas", () => {
    const valid = {
      workspaceId: "ws_demo",
      projectId: `project_${"a".repeat(24)}`,
      terminalSessionId: `terminal_${"b".repeat(24)}`,
      listenerRef: `listener_${"c".repeat(24)}`,
      relatedListeners: [{
        terminalSessionId: `terminal_${"d".repeat(24)}`,
        listenerRef: `listener_${"e".repeat(24)}`,
      }],
    };
    expect(parseBrokerParams("browser.start", valid)).toEqual(valid);
    expect(() => parseBrokerParams("browser.start", { ...valid, relatedListeners: Array.from({ length: 8 }, (_, index) => ({
      terminalSessionId: `terminal_${index.toString(16).padStart(24, "0")}`,
      listenerRef: `listener_${index.toString(16).padStart(24, "1")}`,
    })) })).toThrow();
    for (const injected of [
      { url: "http://localhost:3007" }, { host: "localhost" }, { port: 3007 },
      { root: "C:\\" }, { trustMode: "full-host" }, { workspaceId: "ws_other", secondaryWorkspaceId: "ws_api" },
    ]) expect(() => parseBrokerParams("browser.start", { ...valid, ...injected })).toThrow();
  });

  it("SEC-129/130: entorno y salida se mantienen en memoria y eliminan secretos propios", async () => {
    const terminal = await source("packages/development/src/terminal-supervisor.ts");
    expect(terminal).toContain("TERMINAL_SECRET_NAME");
    expect(terminal).toContain("MAX_OUTPUT_BYTES");
    expect(terminal).not.toContain("writeFile(entry.output");
  });

  it("SEC-146: la apertura local revalida refs opacas y no acepta URL o puerto del renderer", async () => {
    const target = {
      projectId: `project_${"a".repeat(24)}`,
      terminalSessionId: `terminal_${"b".repeat(24)}`,
      listenerRef: `listener_${"c".repeat(24)}`,
    };
    expect(terminalListenerTargetInputSchema.parse(target)).toEqual(target);
    expect(() => terminalListenerTargetInputSchema.parse({ ...target, url: "http://evil.example" })).toThrow();
    expect(() => terminalListenerTargetInputSchema.parse({ ...target, port: 5173 })).toThrow();
    const main = await source("apps/desktop/src/main/index.ts");
    const handler = main.slice(main.indexOf('ipcMain.handle("development:openTerminalListener"'));
    expect(handler.indexOf("terminalListenerTargetInputSchema.parse")).toBeLessThan(handler.indexOf("resolveListener"));
    expect(handler.indexOf("resolveListener")).toBeLessThan(handler.indexOf("shell.openExternal"));
    expect(handler).toContain('if (!listener.exclusive)');
    expect(handler).toContain('origin.protocol !== "http:"');
  });
});
