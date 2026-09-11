import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGET_PROTOCOL_REVISION } from "@localbridge/shared";
import { buildWorkspace, createTempWorkspaceDir, writeRegistryFile, type TempWorkspace } from "../helpers/fixtures.js";
import { createHarness, type Harness } from "../helpers/harness.js";
import { buildPdfFixture } from "../helpers/pdf-fixture.js";

let workspace: TempWorkspace;
let harness: Harness | undefined;

beforeEach(async () => { workspace = await createTempWorkspaceDir(); });
afterEach(async () => { await harness?.close(); harness = undefined; await workspace.cleanup(); });

function pngFixture(width = 16, height = 12): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 25;
    png.data[index + 1] = 120;
    png.data[index + 2] = 220;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function configureWorkspace(read = true): Promise<void> {
  const configPath = path.join(os.tmpdir(), `localbridge-visual-doc-${randomUUID()}`, "workspaces.json");
  await writeRegistryFile(configPath, [buildWorkspace({
    id: "ws_visual_docs",
    rootPath: workspace.root,
    permissions: { read, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
  })]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
}

describe("lectura visual de documentos", () => {
  it("renderiza páginas PDF escaneadas y las entrega como bloques MCP rotulados", async () => {
    await mkdir(path.join(workspace.root, "docs"));
    await writeFile(path.join(workspace.root, "docs", "scan.pdf"), buildPdfFixture({ pages: [null, "Page two"] }));
    await configureWorkspace();

    const result = await harness!.client.callTool({
      name: "document.render",
      arguments: { workspaceId: "ws_visual_docs", path: "docs/scan.pdf", pages: [1, 2], detail: "standard" },
    });
    expect(result.isError).not.toBe(true);
    const metadata = result.structuredContent as Record<string, unknown>;
    expect(metadata).toMatchObject({ path: "docs/scan.pdf", pageCount: 2 });
    expect(metadata["sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect((metadata["pages"] as unknown[])).toHaveLength(2);
    expect(metadata["pages"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ renderer: "pdfium" }),
    ]));
    expect(result.content.map((item) => item.type)).toEqual(["text", "image", "text", "image", "text"]);
    const images = result.content.filter((item) => item.type === "image");
    expect(images).toHaveLength(2);
    for (const image of images) {
      if (image.type !== "image") continue;
      const bytes = Buffer.from(image.data, "base64");
      expect(["89504e470d0a1a0a", "ffd8"]).toContain(bytes.subarray(0, image.mimeType === "image/png" ? 8 : 2).toString("hex"));
    }
  });

  it("rechaza un hash anterior antes de renderizar", async () => {
    await writeFile(path.join(workspace.root, "scan.pdf"), buildPdfFixture());
    await configureWorkspace();
    const result = await harness!.client.callTool({
      name: "document.render",
      arguments: { workspaceId: "ws_visual_docs", path: "scan.pdf", pages: [1], expectedSha256: "0".repeat(64) },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("HASH_MISMATCH") });
  });

  it("valida y entrega una imagen local sin escribir derivados", async () => {
    const source = pngFixture();
    await writeFile(path.join(workspace.root, "asset.png"), source);
    await configureWorkspace();
    const result = await harness!.client.callTool({
      name: "image.read",
      arguments: { workspaceId: "ws_visual_docs", path: "asset.png", detail: "high" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      path: "asset.png", sourceMimeType: "image/png", mimeType: "image/png", width: 16, height: 12, detail: "high",
    });
    expect(result.content.map((item) => item.type)).toEqual(["image", "text"]);
  });

  it("falla cerrado ante extensión activa, traversal y lectura revocada", async () => {
    await writeFile(path.join(workspace.root, "active.svg"), "<svg/>");
    await configureWorkspace(false);
    const denied = await harness!.client.callTool({
      name: "image.read", arguments: { workspaceId: "ws_visual_docs", path: "active.svg" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("IMAGE_UNSUPPORTED") });
    const traversal = await harness!.client.callTool({
      name: "document.render", arguments: { workspaceId: "ws_visual_docs", path: "../scan.pdf", pages: [1] },
    });
    expect(traversal.isError).toBe(true);
    expect(traversal.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("CAPABILITY_DISABLED") });
  });
});
