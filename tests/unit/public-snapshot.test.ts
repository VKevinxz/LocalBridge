import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("public source snapshot", () => {
  it.skipIf(process.platform !== "win32")("runs the publication gate with the same argument-free call used by release workflows", async () => {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", path.resolve("scripts/check-publication-readiness.ps1"),
    ], { cwd: process.cwd(), timeout: 30_000, windowsHide: true });

    expect(stdout).toContain("Publication metadata is ready for v1.8.1.");
  }, 45_000);

  it.skipIf(process.platform !== "win32")("exports a clean tree without internal decision history", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "localbridge-public-snapshot-"));
    const destination = path.join(parent, "source");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", path.resolve("scripts/export-public-source.ps1"),
        "-Destination", destination,
      ], { cwd: process.cwd(), timeout: 30_000, windowsHide: true });

      expect(stdout).toContain("Public snapshot audit passed");
      expect(stdout).toContain("Public snapshot created");
      await expect(readFile(path.join(destination, "README.md"), "utf8")).resolves.toContain("LocalBridge MCP");
      await expect(readFile(path.join(destination, "docs", "ARCHITECTURE.md"), "utf8")).resolves.toContain("Arquitectura");
      await expect(readFile(path.join(destination, "docs", "STATUS.md"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(destination, "docs", "adr", "0039-onboarding-project-first.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 45_000);

  it("keeps the approved no-license posture as an explicit fail-closed publication gate", async () => {
    const source = await readFile("scripts/check-publication-readiness.ps1", "utf8");
    expect(source).toContain("UNLICENSED");
    expect(source).toContain("COPYRIGHT.md");
    expect(source).toContain("VKevinXZ");
    expect(source).toContain("https://github.com/VKevinxz/LocalBridge");
    expect(source).toContain("LICENSE must be absent");
    expect(source).toContain("throw \"Publication readiness failed");
  });
});
