import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const verifierNames = [
  "verify-browser-controller.ts",
  "verify-electron-process-supervisor.ts",
  "verify-electron-multiservice.ts",
  "verify-web-controller.ts",
] as const;

describe("verificadores Electron", () => {
  it.each(verifierNames)("%s ignora únicamente EPIPE en streams diagnósticos", async (name) => {
    const source = await readFile(path.join(process.cwd(), "scripts", name), "utf8");

    expect(source).toContain("for (const stream of [process.stdout, process.stderr])");
    expect(source).toContain("if (error.code !== 'EPIPE') throw error;");
  });

  it("aísla el bloqueo de instancia del smoke sin cerrar una instalación activa", async () => {
    const source = await readFile(path.join(process.cwd(), "scripts", "smoke-packaged-desktop.ps1"), "utf8");

    expect(source).toContain("$env:APPDATA = $appDataPath");
    expect(source).toContain("$env:LOCALAPPDATA = $localAppDataPath");
    expect(source).toContain("$env:USERPROFILE = $userProfilePath");
    expect(source).toContain("verify-packaged-first-run.mjs");
    expect(source).toContain("did not exit through app:quit");
    expect(source).toContain("$env:APPDATA = $previousAppData");
    expect(source).toContain("$env:LOCALAPPDATA = $previousLocalAppData");
    expect(source).toContain("$env:USERPROFILE = $previousUserProfile");
  });

  it("empaqueta mcp-server dentro del proceso principal para no cargar TypeScript crudo", async () => {
    const source = await readFile(path.join(process.cwd(), "apps", "desktop", "electron.vite.config.ts"), "utf8");
    expect(source).toContain("'@localbridge/mcp-server'");
  });
});
