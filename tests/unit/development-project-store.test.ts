import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildNewApplication,
  buildNewDevelopmentProject,
  loadDevelopmentProjectStore,
  loadRegistryDocument,
  removeDevelopmentProject,
  upsertApplication,
  upsertDevelopmentProject,
  upsertWorkspace,
} from "@localbridge/desktop-core";
import { buildWorkspace } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; registryPath: string; projectsPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-project-store-"));
  roots.push(root);
  return {
    root,
    registryPath: path.join(root, "workspaces.json"),
    projectsPath: path.join(root, "development-projects.json"),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const processProfile = {
  command: ["npm", "run", "dev"],
  cwd: ".",
  source: { kind: "package-script" as const, manifestPath: "package.json" as const, script: "dev", definitionSha256: "a".repeat(64) },
  maxRuntimeSeconds: 300,
};

describe("development project store v1 — compatibilidad v0.8", () => {
  it("COMPAT-001: abrir el store ausente no crea ni reescribe el registro v4", async () => {
    const { registryPath, projectsPath } = await fixture();
    const workspace = buildWorkspace({ id: "ws_existing", rootPath: "C:\\existing" });
    await upsertWorkspace(registryPath, workspace);
    const before = await readFile(registryPath);

    const store = await loadDevelopmentProjectStore(projectsPath, await loadRegistryDocument(registryPath));

    expect(store).toEqual({ schemaVersion: 1, projects: [] });
    expect(sha256(await readFile(registryPath))).toBe(sha256(before));
    await expect(readFile(projectsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("COMPAT-008/009: agrupar y eliminar no modifica workspace ni aplicación", async () => {
    const { registryPath, projectsPath } = await fixture();
    const workspace = buildWorkspace({
      id: "ws_existing",
      rootPath: "C:\\existing",
      permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: true, processes: true, browserRead: true, browserInteract: true, browserHumanControl: true },
      processProfiles: { dev: processProfile },
    });
    await upsertWorkspace(registryPath, workspace);
    const application = buildNewApplication({
      name: "Existente",
      primaryServiceAlias: "frontend",
      reviewState: "reviewed",
      services: [{ alias: "frontend", workspaceId: workspace.id, processProfile: "dev", hostMode: "manual-localhost", allowManagedWildcard: false }],
    });
    await upsertApplication(registryPath, application);
    const registryBefore = await readFile(registryPath);
    const registry = await loadRegistryDocument(registryPath);
    const project = buildNewDevelopmentProject({
      name: "Proyecto existente",
      workspaceIds: [workspace.id],
      applicationId: application.id,
      setupStatus: "ready",
    });

    await upsertDevelopmentProject(projectsPath, registry, project);
    await removeDevelopmentProject(projectsPath, project.id);

    expect(sha256(await readFile(registryPath))).toBe(sha256(registryBefore));
    expect(await loadDevelopmentProjectStore(projectsPath, registry)).toEqual({ schemaVersion: 1, projects: [] });
  });

  it("falla cerrado si una aplicación usa un workspace ajeno al proyecto", async () => {
    const { registryPath, projectsPath } = await fixture();
    const frontend = buildWorkspace({ id: "ws_front", rootPath: "C:\\front", processProfiles: { dev: processProfile } });
    const api = buildWorkspace({ id: "ws_api", rootPath: "C:\\api", processProfiles: { dev: processProfile } });
    await upsertWorkspace(registryPath, frontend);
    await upsertWorkspace(registryPath, api);
    const application = buildNewApplication({
      name: "Dos servicios",
      primaryServiceAlias: "front",
      services: [
        { alias: "front", workspaceId: frontend.id, processProfile: "dev", hostMode: "manual-localhost", allowManagedWildcard: false },
        { alias: "api", workspaceId: api.id, processProfile: "dev", hostMode: "manual-localhost", allowManagedWildcard: false },
      ],
    });
    await upsertApplication(registryPath, application);
    const project = buildNewDevelopmentProject({ name: "Incompleto", workspaceIds: [frontend.id], applicationId: application.id });

    await expect(upsertDevelopmentProject(projectsPath, await loadRegistryDocument(registryPath), project))
      .rejects.toMatchObject({ code: "PROJECT_APPLICATION_MISMATCH" });
  });

  it("reconcilia una referencia rota en memoria sin reescribir el store", async () => {
    const { projectsPath } = await fixture();
    const project = buildNewDevelopmentProject({ name: "Roto", workspaceIds: ["ws_missing"], setupStatus: "ready" });
    const raw = `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`;
    await writeFile(projectsPath, raw);

    const reconciled = await loadDevelopmentProjectStore(projectsPath, { schemaVersion: 5, workspaces: [], applications: [] });

    expect(reconciled.projects[0]?.setupStatus).toBe("interrupted");
    expect(await readFile(projectsPath, "utf8")).toBe(raw);
  });

  it("rechaza nombres equivalentes normalizados", async () => {
    const { registryPath, projectsPath } = await fixture();
    const workspace = buildWorkspace({ id: "ws_existing", rootPath: "C:\\existing" });
    await upsertWorkspace(registryPath, workspace);
    const registry = await loadRegistryDocument(registryPath);
    await upsertDevelopmentProject(projectsPath, registry, buildNewDevelopmentProject({ name: "Proyecto Único", workspaceIds: [workspace.id] }));

    await expect(upsertDevelopmentProject(projectsPath, registry, buildNewDevelopmentProject({ name: " proyecto único ", workspaceIds: [workspace.id] })))
      .rejects.toMatchObject({ code: "PROJECT_NAME_CONFLICT" });
  });
});
