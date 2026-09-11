import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGET_PROTOCOL_REVISION } from "@localbridge/shared";
import { callToolJson } from "../helpers/call.js";
import { buildWorkspace, createTempWorkspaceDir, writeRegistryFile, type TempWorkspace } from "../helpers/fixtures.js";
import { createHarness, type Harness } from "../helpers/harness.js";
import { buildPdfFixture } from "../helpers/pdf-fixture.js";

let workspace: TempWorkspace;
let harness: Harness | undefined;
beforeEach(async () => { workspace = await createTempWorkspaceDir(); });
afterEach(async () => { await harness?.close(); harness = undefined; await workspace.cleanup(); });

describe("document.read", () => {
  it("lee PDF textual autorizado y devuelve rango, hash y procedencia", async () => {
    await mkdir(path.join(workspace.root, "docs"));
    await writeFile(path.join(workspace.root, "docs", "terms.pdf"), buildPdfFixture({ pages: ["Uno", "Dos"] }));
    const configPath = path.join(os.tmpdir(), `localbridge-doc-${randomUUID()}`, "workspaces.json");
    await writeRegistryFile(configPath, [buildWorkspace({ id: "ws_docs", rootPath: workspace.root })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const result = await callToolJson(harness.client, "document.read", { workspaceId: "ws_docs", path: "docs/terms.pdf", startPage: 2, endPage: 2 });
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ path: "docs/terms.pdf", pageCount: 2, startPage: 2, endPage: 2, text: "Dos", truncated: false });
    expect(result.parsed["sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rechaza extensión, traversal y workspace sin lectura", async () => {
    await writeFile(path.join(workspace.root, "fake.txt"), buildPdfFixture());
    const configPath = path.join(os.tmpdir(), `localbridge-doc-deny-${randomUUID()}`, "workspaces.json");
    await writeRegistryFile(configPath, [buildWorkspace({
      id: "ws_docs", rootPath: workspace.root,
      permissions: { read: false, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    })]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
    expect((await callToolJson(harness.client, "document.read", { workspaceId: "ws_docs", path: "fake.txt" })).parsed["error"]).toMatchObject({ code: "DOCUMENT_UNSUPPORTED" });
    expect((await callToolJson(harness.client, "document.read", { workspaceId: "ws_docs", path: "../secret.pdf" })).parsed["error"]).toMatchObject({ code: "CAPABILITY_DISABLED" });
  });
});
