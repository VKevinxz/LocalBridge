import path from "node:path";
import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openWorkspaceBinaryRangeReader } from "@localbridge/filesystem";
import { buildWorkspace, createTempWorkspaceDir, type TempWorkspace } from "../helpers/fixtures.js";

let temporary: TempWorkspace;

beforeEach(async () => { temporary = await createTempWorkspaceDir(); });
afterEach(async () => { await temporary.cleanup(); });

describe("lector binario seguro por rangos", () => {
  it("calcula hash completo y solo entrega rangos acotados", async () => {
    await writeFile(path.join(temporary.root, "large.bin"), Buffer.from("0123456789abcdef"));
    const authority = vi.fn(async () => undefined);
    const reader = await openWorkspaceBinaryRangeReader(buildWorkspace({ rootPath: temporary.root }), "large.bin", {
      hardLimitBytes: 1024,
      checkAuthority: authority,
    });
    try {
      expect(reader).toMatchObject({ path: "large.bin", size: 16 });
      expect(reader.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(reader.readRange(4, 6)).resolves.toEqual(Buffer.from("456789"));
      await expect(reader.readRange(0, 0)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(authority).toHaveBeenCalled();
    } finally {
      await reader.close();
    }
  });

  it("aplica límite antes de exponer contenido", async () => {
    await writeFile(path.join(temporary.root, "large.bin"), Buffer.alloc(32));
    await expect(openWorkspaceBinaryRangeReader(buildWorkspace({ rootPath: temporary.root }), "large.bin", {
      hardLimitBytes: 16,
    })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("distingue acciones PDF de nombres coincidentes dentro de streams y strings hexadecimales", async () => {
    const passive = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Length 13 >>\nstream\nbytes /AA x\nendstream\n2 0 obj\n<2F4141>\nendobj\n%%EOF\n",
      "latin1",
    );
    const active = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /OpenAction 2 0 R >>\nendobj\n%%EOF\n",
      "latin1",
    );
    await writeFile(path.join(temporary.root, "passive.pdf"), passive);
    await writeFile(path.join(temporary.root, "active.pdf"), active);

    const workspace = buildWorkspace({ rootPath: temporary.root });
    const passiveReader = await openWorkspaceBinaryRangeReader(workspace, "passive.pdf", { hardLimitBytes: 1024 });
    const activeReader = await openWorkspaceBinaryRangeReader(workspace, "active.pdf", { hardLimitBytes: 1024 });
    try {
      expect(passiveReader.hasActivePdfSyntax).toBe(false);
      expect(activeReader.hasActivePdfSyntax).toBe(true);
    } finally {
      await Promise.all([passiveReader.close(), activeReader.close()]);
    }
  });
});
