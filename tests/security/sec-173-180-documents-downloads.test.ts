import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceBinaryFile, readWorkspaceBinaryFile } from "@localbridge/filesystem";
import { validateDownloadedDocument } from "../../apps/desktop/src/main/web-download-policy.js";
import { buildWorkspace, createTempWorkspaceDir, tryCreateDirJunction, type TempWorkspace } from "../helpers/fixtures.js";

let workspace: TempWorkspace;
let outside: TempWorkspace;

function expectDownloadBlocked(effect: () => void, code = "WEB_MEDIA_TYPE_MISMATCH"): void {
  try {
    effect();
    expect.unreachable("se esperaba un rechazo de descarga");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
});
afterEach(async () => { await workspace.cleanup(); await outside.cleanup(); });

describe("SEC-173..180 — documentos y descargas", () => {
  it("SEC-173 el worker PDF no importa filesystem, red ni procesos y recibe bytes", async () => {
    const source = await readFile(path.resolve("packages/mcp-server/src/document-worker.mjs"), "utf8");
    expect(source).toContain("message.bytes");
    expect(source).not.toMatch(/node:(?:fs|net|http|https|dns|child_process)/);
    expect(source).not.toContain("message.path");
    expect(source).toContain("isEvalSupported: false");
  });

  it("SEC-174 lectura binaria conserva guard, denylist y límite previo", async () => {
    await writeFile(path.join(workspace.root, "doc.pdf"), Buffer.from("%PDF-test"));
    await writeFile(path.join(workspace.root, ".env"), Buffer.from("secret"));
    const ws = buildWorkspace({ rootPath: workspace.root, limits: { maxFileBytes: 8, maxTreeEntries: 10, maxTreeDepth: 2 } });
    await expect(readWorkspaceBinaryFile(ws, ".env")).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(readWorkspaceBinaryFile(ws, "doc.pdf")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(readWorkspaceBinaryFile(ws, "../outside.pdf")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("SEC-175 crea binarios sin sobrescribir", async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const first = await createWorkspaceBinaryFile(ws, "downloads/report.txt", Buffer.from("first"));
    expect(first.created).toBe(true);
    await expect(createWorkspaceBinaryFile(ws, "downloads/report.txt", Buffer.from("second")))
      .rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS" });
    expect(await readFile(path.join(workspace.root, "downloads", "report.txt"), "utf8")).toBe("first");
  });

  it("SEC-176 una junction de destino no cruza el workspace", async () => {
    const attempt = await tryCreateDirJunction(outside.root, path.join(workspace.root, "escape"));
    if (!attempt.created) return;
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(createWorkspaceBinaryFile(ws, "escape/file.pdf", Buffer.from("%PDF-")))
      .rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await expect(readFile(path.join(outside.root, "file.pdf"))).rejects.toThrow();
  });

  it("SEC-177 valida extensión, MIME y firma antes de guardar", () => {
    expect(() => validateDownloadedDocument("report.pdf", "application/pdf", Buffer.from("%PDF-1.4"))).not.toThrow();
    expectDownloadBlocked(() => validateDownloadedDocument("report.pdf", "text/html", Buffer.from("<html>")));
    expectDownloadBlocked(() => validateDownloadedDocument("report.exe", "application/octet-stream", Buffer.from("MZ")), "WEB_MEDIA_TYPE_UNSUPPORTED");
    expectDownloadBlocked(() => validateDownloadedDocument("report.json", "application/json", Buffer.from("{broken")));
  });

  it("SEC-178 rechaza texto binario o codificación inválida", () => {
    expectDownloadBlocked(() => validateDownloadedDocument("report.txt", "text/plain", Uint8Array.from([0xff, 0x00])));
  });

  it("SEC-179 el contrato MCP de descarga no contiene una URL libre", async () => {
    const source = await readFile(path.resolve("packages/mcp-server/src/tools/web-tools.ts"), "utf8");
    const downloadStart = source.indexOf("web.download");
    const downloadBlock = source.slice(downloadStart, source.indexOf("web.click", downloadStart));
    expect(downloadBlock).toContain("resourceRef");
    expect(downloadBlock).not.toContain("url:");
    expect(downloadBlock).toContain("workspaceId");
    expect(downloadBlock).not.toContain("maximumBytes");
    expect(downloadBlock).not.toContain("maxTotalDownloadBytes");
  });

  it("SEC-180 no hay API de subida ni apertura/ejecución de la descarga", async () => {
    const sources = await Promise.all([
      readFile(path.resolve("packages/mcp-server/src/tools/web-tools.ts"), "utf8"),
      readFile(path.resolve("apps/desktop/src/main/web-controller.ts"), "utf8"),
    ]);
    expect(sources.join("\n")).not.toContain("web.upload");
    expect(sources.join("\n")).not.toMatch(/shell\.openPath|child_process|execFile\(/);
  });
});
