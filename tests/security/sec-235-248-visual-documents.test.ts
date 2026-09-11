import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryAuditEvents } from "@localbridge/audit";
import { openWorkspaceBinaryRangeReader } from "@localbridge/filesystem";
import { LocalBridgeError, TARGET_PROTOCOL_REVISION } from "@localbridge/shared";
import { callToolJson } from "../helpers/call.js";
import {
  buildWorkspace,
  createTempWorkspaceDir,
  tryCreateDirJunction,
  writeRegistryFile,
  type TempWorkspace,
} from "../helpers/fixtures.js";
import { createHarness, type Harness } from "../helpers/harness.js";
import { buildPdfFixture } from "../helpers/pdf-fixture.js";

let workspace: TempWorkspace;
let outside: TempWorkspace;
let harness: Harness | undefined;
let auditDbPath: string;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
  auditDbPath = path.join(os.tmpdir(), `localbridge-sec-visual-${randomUUID()}.db`);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await Promise.all([workspace.cleanup(), outside.cleanup()]);
});

function pngFixture(width = 4, height = 3): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0x77);
  return PNG.sync.write(png);
}

async function start(read = true): Promise<void> {
  const configPath = path.join(os.tmpdir(), `localbridge-sec-visual-config-${randomUUID()}`, "workspaces.json");
  await writeRegistryFile(configPath, [buildWorkspace({
    id: "ws_visual_sec",
    rootPath: workspace.root,
    permissions: { read, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
  })]);
  harness = await createHarness({
    pinProtocol: TARGET_PROTOCOL_REVISION,
    workspaceConfigPath: configPath,
    auditDbPath,
  });
}

describe("SEC-235..248 — lectura visual de documentos", () => {
  it("SEC-235 document.render rechaza rutas absolutas y traversal", async () => {
    await start();
    for (const target of ["../outside.pdf", "C:\\private\\outside.pdf"]) {
      const result = await callToolJson(harness!.client, "document.render", {
        workspaceId: "ws_visual_sec", path: target, pages: [1],
      });
      expect(result.isError).toBe(true);
      expect(["PATH_OUTSIDE_WORKSPACE", "ABSOLUTE_PATH_FORBIDDEN"]).toContain((result.parsed["error"] as { code: string }).code);
    }
  });

  it("SEC-236 image.read rechaza rutas absolutas y traversal", async () => {
    await start();
    for (const target of ["../outside.png", "C:\\private\\outside.png"]) {
      const result = await callToolJson(harness!.client, "image.read", { workspaceId: "ws_visual_sec", path: target });
      expect(result.isError).toBe(true);
      expect(["PATH_OUTSIDE_WORKSPACE", "ABSOLUTE_PATH_FORBIDDEN"]).toContain((result.parsed["error"] as { code: string }).code);
    }
  });

  it("SEC-237 ambas tools exigen lectura vigente", async () => {
    await writeFile(path.join(workspace.root, "scan.pdf"), buildPdfFixture({ pages: [null] }));
    await writeFile(path.join(workspace.root, "asset.png"), pngFixture());
    await start(false);
    for (const [name, args] of [
      ["document.render", { workspaceId: "ws_visual_sec", path: "scan.pdf", pages: [1] }],
      ["image.read", { workspaceId: "ws_visual_sec", path: "asset.png" }],
    ] as const) {
      const result = await callToolJson(harness!.client, name, args);
      expect(result.isError).toBe(true);
      expect((result.parsed["error"] as { code: string }).code).toBe("CAPABILITY_DISABLED");
    }
  });

  it("SEC-238 una junction externa falla cerrada antes del render", async (context) => {
    await mkdir(path.join(outside.root, "docs"));
    await writeFile(path.join(outside.root, "docs", "outside.pdf"), buildPdfFixture());
    const attempt = await tryCreateDirJunction(outside.root, path.join(workspace.root, "linked"));
    if (!attempt.created) {
      context.skip(`junction no disponible: ${attempt.reason ?? "sin detalle"}`);
      return;
    }
    await start();
    const result = await callToolJson(harness!.client, "document.render", {
      workspaceId: "ws_visual_sec", path: "linked/docs/outside.pdf", pages: [1],
    });
    expect(result.isError).toBe(true);
    expect((result.parsed["error"] as { code: string }).code).toBe("SYMLINK_ESCAPE");
  });

  it("SEC-239 el worker recibe bytes o rangos, nunca rutas ni capacidades del sistema", async () => {
    const [reader, worker] = await Promise.all([
      readFile("packages/mcp-server/src/document-reader.ts", "utf8"),
      readFile("packages/mcp-server/src/document-worker.mjs", "utf8"),
    ]);
    expect(reader).toContain("readRange(result.begin, length)");
    expect(reader).not.toMatch(/postMessage\([^)]*(?:path|rootPath|realPath)/);
    expect(worker).not.toMatch(/from ["']node:(?:fs|net|http|https|child_process|process)/);
    expect(worker).not.toContain("process.env");
  });

  it("SEC-240 las acciones y adjuntos PDF no se ejecutan y quedan advertidos", async () => {
    await writeFile(path.join(workspace.root, "active.pdf"), buildPdfFixture({ javascript: true }));
    await start();
    const read = await callToolJson(harness!.client, "document.read", {
      workspaceId: "ws_visual_sec", path: "active.pdf",
    });
    expect(read.isError).toBe(false);
    expect(read.parsed["warnings"]).toContain("active-content-ignored");
    const rendered = await harness!.client.callTool({
      name: "document.render", arguments: { workspaceId: "ws_visual_sec", path: "active.pdf", pages: [1] },
    });
    expect(rendered.isError).not.toBe(true);
    expect((rendered.structuredContent as { warnings: string[] }).warnings).toContain("active-content-ignored");
  });

  it("SEC-241 expectedSha256 evita mezclar revisiones", async () => {
    await writeFile(path.join(workspace.root, "scan.pdf"), buildPdfFixture());
    await start();
    const result = await callToolJson(harness!.client, "document.render", {
      workspaceId: "ws_visual_sec", path: "scan.pdf", pages: [1], expectedSha256: "0".repeat(64),
    });
    expect((result.parsed["error"] as { code: string }).code).toBe("HASH_MISMATCH");
  });

  it("SEC-242 limita páginas, duplicados y píxeles antes de responder", async () => {
    await writeFile(path.join(workspace.root, "scan.pdf"), buildPdfFixture({ pages: [null, null, null, null, null] }));
    const hostile = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(hostile);
    hostile.writeUInt32BE(100_000, 16);
    hostile.writeUInt32BE(100_000, 20);
    await writeFile(path.join(workspace.root, "hostile.png"), hostile);
    await start();
    const tooMany = await harness!.client.callTool({
      name: "document.render", arguments: { workspaceId: "ws_visual_sec", path: "scan.pdf", pages: [1, 2, 3, 4, 5] },
    });
    expect(tooMany.isError).toBe(true);
    const duplicate = await harness!.client.callTool({
      name: "document.render", arguments: { workspaceId: "ws_visual_sec", path: "scan.pdf", pages: [1, 1] },
    });
    expect(duplicate.isError).toBe(true);
    const pixels = await callToolJson(harness!.client, "image.read", { workspaceId: "ws_visual_sec", path: "hostile.png" });
    expect((pixels.parsed["error"] as { code: string }).code).toBe("IMAGE_TOO_LARGE");
  });

  it("SEC-243 firmas falsas, SVG activo y AVIF fuera de contrato se rechazan", async () => {
    await writeFile(path.join(workspace.root, "fake.png"), Buffer.from("not an image"));
    await writeFile(path.join(workspace.root, "active.svg"), "<svg><script>alert(1)</script></svg>");
    await writeFile(path.join(workspace.root, "asset.avif"), Buffer.from("00000018667479706176696600000000617669666d696631", "hex"));
    await start();
    const fake = await callToolJson(harness!.client, "image.read", { workspaceId: "ws_visual_sec", path: "fake.png" });
    const svg = await callToolJson(harness!.client, "image.read", { workspaceId: "ws_visual_sec", path: "active.svg" });
    const avif = await callToolJson(harness!.client, "image.read", { workspaceId: "ws_visual_sec", path: "asset.avif" });
    expect((fake.parsed["error"] as { code: string }).code).toBe("IMAGE_UNSUPPORTED");
    expect((svg.parsed["error"] as { code: string }).code).toBe("IMAGE_UNSUPPORTED");
    expect((avif.parsed["error"] as { code: string }).code).toBe("IMAGE_UNSUPPORTED");
  });

  it("SEC-244 auditoría no contiene texto, píxeles ni base64", async () => {
    const marker = "SECRET_PIXEL_MARKER_NEVER_LOG";
    await writeFile(path.join(workspace.root, "secret.png"), pngFixture());
    await start();
    const result = await harness!.client.callTool({ name: "image.read", arguments: { workspaceId: "ws_visual_sec", path: "secret.png" } });
    expect(result.isError).not.toBe(true);
    const events = queryAuditEvents(auditDbPath, { action: "image.read" });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("secret.png");
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain((result.content.find((item) => item.type === "image") as { data: string }).data);
  });

  it("SEC-245 revocación durante lectura por rangos cancela el acceso", async () => {
    await writeFile(path.join(workspace.root, "large.bin"), Buffer.alloc(128 * 1024));
    let checks = 0;
    const reader = await openWorkspaceBinaryRangeReader(buildWorkspace({ rootPath: workspace.root }), "large.bin", {
      hardLimitBytes: 256 * 1024,
      checkAuthority: async () => {
        checks += 1;
        if (checks > 2) throw new LocalBridgeError("CAPABILITY_DISABLED");
      },
    });
    try {
      await expect(reader.readRange(0, 16)).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    } finally {
      await reader.close();
    }
  });

  it("SEC-246 un fallo parcial conserva isError y no produce imágenes", async () => {
    await writeFile(path.join(workspace.root, "one.pdf"), buildPdfFixture());
    await start();
    const result = await harness!.client.callTool({
      name: "document.render", arguments: { workspaceId: "ws_visual_sec", path: "one.pdf", pages: [1, 2] },
    });
    expect(result.isError).toBe(true);
    expect(result.content.some((item) => item.type === "image")).toBe(false);
  });

  it("SEC-247 conserva las tools documentales R2 dentro del catálogo aditivo", async () => {
    await start();
    const listed = await harness!.client.listTools();
    expect(listed.tools).toHaveLength(100);
    expect(new Set(listed.tools.map((tool) => tool.name)).size).toBe(100);
    for (const name of ["document.read", "document.render", "image.read", "git.commit", "web.download", "browser.screenshot"]) {
      expect(listed.tools.some((tool) => tool.name === name), name).toBe(true);
    }
    for (const name of ["document.render", "image.read"]) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true, destructiveHint: false, openWorldHint: false,
      });
    }
  });

  it("SEC-248 el build incluye los runtimes pasivos de canvas y PDFium", async () => {
    const [vite, builder, packaged] = await Promise.all([
      readFile("apps/desktop/vite.server.config.ts", "utf8"),
      readFile("apps/desktop/electron-builder.yml", "utf8"),
      readFile("tests/integration/packaged-desktop-server.test.ts", "utf8"),
    ]);
    expect(vite).toContain("'@napi-rs/canvas'");
    expect(vite).toContain("canvas-win32-x64-msvc");
    expect(vite).toContain("NATIVE_MODULES_DESTINATION");
    expect(vite).toContain("pdfium.esm.wasm");
    expect(builder).toContain("from: out/server");
    expect(builder).toContain('"*.wasm"');
    expect(packaged).toContain("document.render");
    expect(packaged).toContain("toHaveLength(100)");
  });
});
