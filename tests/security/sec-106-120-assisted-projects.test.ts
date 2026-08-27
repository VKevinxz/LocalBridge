import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectProjectTopology } from "@localbridge/desktop-core";
import { brokerMethodSchemas } from "@localbridge/development";
import { setupActionSchema, setupPlanSchema } from "@localbridge/workspace";
import { buildWorkspace } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

describe("SEC-106 — setup no expresa shell o paquetes arbitrarios", () => {
  it("rechaza campos extra y acciones command", () => {
    expect(() => setupActionSchema.parse({ kind: "node-install", manager: "npm", workspaceId: "ws_a", manifestPath: "package.json", mode: "restricted", command: "rm -rf" })).toThrow();
    expect(() => setupActionSchema.parse({ kind: "command", command: ["cmd.exe", "/c", "whoami"] })).toThrow();
  });

  it("el plan no acepta aprobación o entorno aportados", () => {
    const base = {
      id: `plan_${"a".repeat(24)}`,
      projectId: `project_${"b".repeat(24)}`,
      topology: "single",
      proposedWorkspaceRoots: ["."],
      manifestRefs: [{ workspaceId: "ws_a", path: "package.json", sha256: "c".repeat(64) }],
      lockfileRefs: [],
      toolchainFingerprint: "d".repeat(64),
      actions: [],
      proposedProfiles: [],
      policy: "restricted",
      planSha256: "e".repeat(64),
      createdAt: new Date().toISOString(),
    };
    expect(setupPlanSchema.safeParse({ ...base, approved: true }).success).toBe(false);
    expect(setupPlanSchema.safeParse({ ...base, env: { TOKEN: "secret" } }).success).toBe(false);
  });

  it("SEC-107: el broker no ofrece crear, aprobar ni ejecutar proyectos", () => {
    const methods = Object.keys(brokerMethodSchemas);
    expect(methods).toContain("project.setup.refresh");
    expect(methods).not.toContain("project.create");
    expect(methods).not.toContain("project.setup.approve");
    expect(methods).not.toContain("project.setup.execute");
  });
});

describe("SEC-109/115 — scanner contenido y acotado", () => {
  it.runIf(process.platform === "win32")("no sigue una junction que escapa del workspace", async () => {
    const rootPath = await tempRoot("localbridge-scan-root-");
    const outside = await tempRoot("localbridge-scan-outside-");
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ scripts: { stolen: "node secret.js" } }));
    await symlink(outside, path.join(rootPath, "linked"), "junction");

    const result = await detectProjectTopology(buildWorkspace({ rootPath }));

    expect(result.commands).toEqual([]);
    expect(result.warnings).toContain("PATH_SKIPPED");
  });

  it("no recorre node_modules ni archivos denegados", async () => {
    const rootPath = await tempRoot("localbridge-scan-deny-");
    await mkdir(path.join(rootPath, "node_modules", "evil"), { recursive: true });
    await writeFile(path.join(rootPath, "node_modules", "evil", "package.json"), JSON.stringify({ scripts: { stolen: "x" } }));
    await writeFile(path.join(rootPath, ".env"), "TOKEN=secret");

    const result = await detectProjectTopology(buildWorkspace({ rootPath }));

    expect(result.manifests).toEqual([]);
    expect(result.commands).toEqual([]);
  });
});
