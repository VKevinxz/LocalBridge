import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SetupSupervisor } from "@localbridge/development";
import { setupPlanSchema, type AuthorizedWorkspace, type SetupAction } from "@localbridge/workspace";
import { buildWorkspace } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function plan(action: SetupAction) {
  return setupPlanSchema.parse({
    id: `plan_${"a".repeat(24)}`,
    projectId: `project_${"b".repeat(24)}`,
    topology: "single",
    proposedWorkspaceRoots: ["."],
    manifestRefs: [{ workspaceId: "ws_setup", path: "package.json", sha256: "c".repeat(64) }],
    lockfileRefs: [],
    toolchainFingerprint: "d".repeat(64),
    actions: [action],
    proposedProfiles: [],
    policy: "restricted",
    planSha256: "e".repeat(64),
    createdAt: new Date().toISOString(),
  });
}

async function fixture(permissions: Partial<AuthorizedWorkspace["permissions"]> = {}) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "localbridge-setup-supervisor-"));
  roots.push(rootPath);
  await writeFile(path.join(rootPath, "package.json"), "{}");
  const workspace = buildWorkspace({
    id: "ws_setup",
    rootPath,
    permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: true, processes: true, ...permissions },
  });
  return { rootPath, workspace };
}

function supervisor(workspace: AuthorizedWorkspace, isWorkspaceBusy = false) {
  return new SetupSupervisor({
    helperPath: "unused-helper.exe",
    nodeBinaryPath: "unused-node.exe",
    parentPid: process.pid,
    loadWorkspace: async (workspaceId) => workspaceId === workspace.id ? workspace : undefined,
    isWorkspaceBusy: () => isWorkspaceBusy,
  });
}

describe("SetupSupervisor — preflight cerrado", () => {
  it("rechaza configuración privada del gestor antes de iniciar un proceso", async () => {
    const { rootPath, workspace } = await fixture();
    await writeFile(path.join(rootPath, ".npmrc"), "//registry.example/:_authToken=secret");
    await expect(supervisor(workspace).start(plan({ kind: "node-install", manager: "npm", workspaceId: workspace.id, manifestPath: "package.json", mode: "restricted" }), []))
      .rejects.toThrow("SETUP_PRIVATE_CONFIG_UNSUPPORTED");
  });

  it("no prepara una carpeta con otro proceso gestionado activo", async () => {
    const { workspace } = await fixture();
    await expect(supervisor(workspace, true).start(plan({ kind: "node-install", manager: "npm", workspaceId: workspace.id, manifestPath: "package.json", mode: "restricted" }), []))
      .rejects.toThrow("SETUP_WORKSPACE_BUSY");
  });

  it("git-init exige gitWrite además de procesos", async () => {
    const { workspace } = await fixture({ gitWrite: false });
    await expect(supervisor(workspace).start(plan({ kind: "git-init", workspaceId: workspace.id }), []))
      .rejects.toThrow("CAPABILITY_DISABLED");
  });
});
