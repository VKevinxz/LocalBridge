import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const verifierNames = [
  "verify-browser-controller.ts",
  "verify-electron-process-supervisor.ts",
  "verify-electron-multiservice.ts",
] as const;

describe("verificadores Electron", () => {
  it.each(verifierNames)("%s ignora únicamente EPIPE en streams diagnósticos", async (name) => {
    const source = await readFile(path.join(process.cwd(), "scripts", name), "utf8");

    expect(source).toContain("for (const stream of [process.stdout, process.stderr])");
    expect(source).toContain("if (error.code !== 'EPIPE') throw error;");
  });
});
