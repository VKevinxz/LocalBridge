import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildNewDevelopmentProject,
  buildSetupPlan,
  detectProjectTopology,
  finalizeSetupPlan,
  listDevelopmentProjects,
  loadRegistryDocument,
} from "@localbridge/desktop-core";
import { buildWorkspace, writeRegistryFile } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const npmEvidence = [{ manager: "npm" as const, executableSha256: "f".repeat(64), version: "10.9.0" }];

async function fixture(name = "Proyecto") {
  const base = await mkdtemp(path.join(os.tmpdir(), "localbridge-finalizer-"));
  roots.push(base);
  const registryPath = path.join(base, "state", "workspaces.json");
  const projectStorePath = path.join(base, "state", "projects.json");
  const rootPath = path.join(base, "source");
  await mkdir(rootPath, { recursive: true });
  const workspace = buildWorkspace({
    id: "ws_setup",
    name,
    rootPath,
    permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: false, processes: true, browserRead: true, browserInteract: true, browserHumanControl: true },
  });
  await writeRegistryFile(registryPath, [workspace]);
  const project = buildNewDevelopmentProject({ name, workspaceIds: [workspace.id] });
  return { registryPath, projectStorePath, rootPath, workspace, project };
}

describe("finalización asistida", () => {
  it("persiste perfiles y deja la aplicación en revisión antes de marcarla lista", async () => {
    const value = await fixture();
    await writeFile(path.join(value.rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
    const plan = buildSetupPlan(value.project, await detectProjectTopology(value.workspace), "restricted", npmEvidence);
    const result = await finalizeSetupPlan({ ...value, registry: await loadRegistryDocument(value.registryPath), plan });
    const registry = await loadRegistryDocument(value.registryPath);

    expect(result.applicationId).toMatch(/^app_/);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.id).toBe(value.workspace.id);
    expect(result.project.workspaceIds).toEqual([value.workspace.id]);
    expect(registry.workspaces[0]?.processProfiles?.["dev"]).toBeDefined();
    expect(registry.workspaces[0]?.validationProfiles["build"]).toBeDefined();
    expect(registry.applications[0]?.reviewState).toBe("needs-review");
    expect((await listDevelopmentProjects(value.projectStorePath, registry))[0]?.setupStatus).toBe("review-required");
  });

  it("divide un contenedor con repositorios hermanos sin ampliar permisos ni borrar la raíz", async () => {
    const value = await fixture("Suite");
    for (const service of ["api", "frontend"]) {
      await mkdir(path.join(value.rootPath, service, ".git"), { recursive: true });
      await writeFile(path.join(value.rootPath, service, "package.json"), JSON.stringify({ scripts: { dev: service === "api" ? "node server.js" : "vite" } }));
    }
    const plan = buildSetupPlan(value.project, await detectProjectTopology(value.workspace), "restricted", npmEvidence);
    expect(plan.topology).toBe("multi-repo");
    expect(plan.proposedWorkspaceRoots).toEqual(["api", "frontend"]);

    const result = await finalizeSetupPlan({ ...value, registry: await loadRegistryDocument(value.registryPath), plan });
    const registry = await loadRegistryDocument(value.registryPath);
    const application = registry.applications.find((candidate) => candidate.id === result.applicationId);
    expect(result.workspaces).toHaveLength(2);
    expect(registry.workspaces.find((workspace) => workspace.id === value.workspace.id)?.enabled).toBe(false);
    expect(result.workspaces.every((workspace) => workspace.enabled)).toBe(true);
    expect(result.workspaces.every((workspace) => workspace.permissions.gitWrite === false)).toBe(true);
    expect(result.project.workspaceIds.toSorted()).toEqual(result.workspaces.map((workspace) => workspace.id).toSorted());
    expect(application?.services).toHaveLength(2);
    expect(application?.services.map((service) => service.startupOrder)).toEqual([0, 1]);
    expect(application?.services.some((service) => service.id === application.primaryServiceId)).toBe(true);
    expect(application?.services.map((service) => service.workspaceId).toSorted()).toEqual(result.workspaces.map((workspace) => workspace.id).toSorted());
    expect(application?.reviewState).toBe("needs-review");
    expect(await readFile(path.join(value.rootPath, "api", "package.json"), "utf8")).toContain("server.js");
  });

  it("finaliza una librería sin inventar navegador ni aplicación", async () => {
    const value = await fixture("Library");
    await writeFile(path.join(value.rootPath, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const plan = buildSetupPlan(value.project, await detectProjectTopology(value.workspace), "manual", []);
    const result = await finalizeSetupPlan({ ...value, registry: await loadRegistryDocument(value.registryPath), plan });
    const registry = await loadRegistryDocument(value.registryPath);
    expect(result.applicationId).toBeUndefined();
    expect(registry.applications).toEqual([]);
    expect((await listDevelopmentProjects(value.projectStorePath, registry))[0]?.setupStatus).toBe("ready");
  });

  it("revierte la referencia si el registro operativo no puede publicarse", async () => {
    const value = await fixture("Rollback");
    await writeFile(path.join(value.rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(path.dirname(value.registryPath), "invalid-registry.json"), "no es JSON");
    const registry = await loadRegistryDocument(value.registryPath);
    const plan = buildSetupPlan(value.project, await detectProjectTopology(value.workspace), "restricted", npmEvidence);
    const invalidRegistryPath = path.join(path.dirname(value.registryPath), "invalid-registry.json");

    await expect(finalizeSetupPlan({ ...value, registryPath: invalidRegistryPath, registry, plan })).rejects.toThrow();

    const [restored] = await listDevelopmentProjects(value.projectStorePath, registry);
    expect(restored).toMatchObject({
      id: value.project.id,
      workspaceIds: [value.workspace.id],
      setupStatus: value.project.setupStatus,
    });
    expect(await readFile(value.registryPath, "utf8")).toContain(value.workspace.id);
  });
});
