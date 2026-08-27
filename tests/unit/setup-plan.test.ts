import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildNewDevelopmentProject, buildSetupPlan, detectProjectTopology, validateSetupPlan } from "@localbridge/desktop-core";
import { buildWorkspace } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "localbridge-plan-"));
  roots.push(rootPath);
  const workspace = buildWorkspace({ id: "ws_plan", rootPath });
  const project = buildNewDevelopmentProject({ name: "Plan", workspaceIds: [workspace.id] });
  return { rootPath, workspace, project, registry: { schemaVersion: 4 as const, workspaces: [workspace], applications: [] } };
}

const npmEvidence = [{ manager: "npm" as const, executableSha256: "f".repeat(64), version: "10.9.0" }];
const gitEvidence = { manager: "git" as const, executableSha256: "e".repeat(64), version: "2.51.0" };

describe("setup plan inmutable", () => {
  it("deriva acciones cerradas y una aplicación desde manifests", async () => {
    const { rootPath, workspace, project } = await fixture();
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "1" }, devDependencies: { vite: "1", typescript: "1" } }));
    await writeFile(path.join(rootPath, "package-lock.json"), "{}");
    const topology = await detectProjectTopology(workspace);

    const plan = buildSetupPlan(project, topology, "restricted", [...npmEvidence, gitEvidence], { initializeGit: true });

    expect(plan.actions).toContainEqual({ kind: "node-install", manager: "npm", workspaceId: workspace.id, manifestPath: "package.json", mode: "restricted" });
    expect(plan.actions).toContainEqual({ kind: "git-init", workspaceId: workspace.id });
    expect(plan.proposedApplication?.services).toHaveLength(1);
    expect(plan.packageManagers).toEqual(["npm"]);
    expect(plan.directDependencyCount).toBe(1);
    expect(plan.directDevDependencyCount).toBe(2);
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("SEC-108: cambiar el manifest después de aprobar invalida el plan", async () => {
    const { rootPath, workspace, project, registry } = await fixture();
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const plan = buildSetupPlan(project, await detectProjectTopology(workspace), "restricted", npmEvidence);
    expect(await validateSetupPlan(plan, registry, npmEvidence)).toEqual({ valid: true, code: "READY" });

    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite --host" } }));

    expect(await validateSetupPlan(plan, registry, npmEvidence)).toEqual({ valid: false, code: "SETUP_PLAN_STALE" });
  });

  it("SEC-118: cambiar evidencia de toolchain invalida el plan", async () => {
    const { rootPath, workspace, project, registry } = await fixture();
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const plan = buildSetupPlan(project, await detectProjectTopology(workspace), "restricted", npmEvidence);

    expect(await validateSetupPlan(plan, registry, [{ ...npmEvidence[0]!, executableSha256: "0".repeat(64) }]))
      .toEqual({ valid: false, code: "SETUP_TOOLCHAIN_MISSING" });
  });

  it("el modo manual no necesita toolchain ni acción de instalación", async () => {
    const { rootPath, workspace, project, registry } = await fixture();
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const plan = buildSetupPlan(project, await detectProjectTopology(workspace), "manual", []);

    expect(plan.actions.some((action) => action.kind === "node-install")).toBe(false);
    expect(await validateSetupPlan(plan, registry, [])).toEqual({ valid: true, code: "READY" });
  });

  it("falla cerrado ante un ecosistema no soportado", async () => {
    const { rootPath, workspace, project } = await fixture();
    await writeFile(path.join(rootPath, "Cargo.toml"), "[package]\nname = \"demo\"");
    const topology = await detectProjectTopology(workspace);
    expect(topology.warnings).toContain("UNSUPPORTED_ECOSYSTEM");
    expect(() => buildSetupPlan(project, topology, "manual", [])).toThrow("UNSUPPORTED_ECOSYSTEM");
  });
});
