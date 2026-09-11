import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildEmptyProjectCatalogRecord,
  buildNewDevelopmentProject,
  loadProjectCatalog,
  loadOrCreateDeviceBinding,
  loadProjectScanStore,
  loadProjectTrustStore,
  migrateDevelopmentProjectsToCatalog,
  removeProjectCatalogRecord,
  removeProjectScanRecord,
  removeProjectTrustRecord,
  revokeProjectTrust,
  upsertProjectScanRecord,
  setProjectTrust,
  upsertProjectCatalogRecord,
} from "@localbridge/desktop-core";
import { buildWorkspace } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-project-catalog-"));
  roots.push(root);
  return {
    catalog: path.join(root, "project-catalog.json"),
    trust: path.join(root, "project-trust.json"),
    scan: path.join(root, "project-scan.json"),
  };
}

describe("project catalog v1", () => {
  it("COMPAT1-001: store ausente no crea ni modifica datos heredados", async () => {
    const files = await fixture();
    expect(await loadProjectCatalog(files.catalog)).toEqual({ schemaVersion: 1, projects: [] });
    await expect(readFile(files.catalog)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("DISC-002: una carpeta vacía es un proyecto válido", async () => {
    const files = await fixture();
    const project = buildEmptyProjectCatalogRecord({ displayName: "Nuevo", selectedRoot: "D:\\Proyectos\\Nuevo" });
    await upsertProjectCatalogRecord(files.catalog, project);

    expect((await loadProjectCatalog(files.catalog)).projects[0]).toMatchObject({
      id: project.id,
      topology: "empty",
      derivedScopes: [{ relativePath: ".", source: "root", status: "active" }],
    });
  });

  it("COMPAT1-004: migra referencias heredadas de forma determinista y sin autoridad", async () => {
    const workspace = buildWorkspace({ id: "ws_existing", rootPath: "D:\\Existing" });
    const legacy = buildNewDevelopmentProject({ name: "Existente", workspaceIds: [workspace.id], setupStatus: "ready" });
    const registry = { schemaVersion: 5 as const, workspaces: [workspace], applications: [] };

    const first = migrateDevelopmentProjectsToCatalog([legacy], registry);
    const second = migrateDevelopmentProjectsToCatalog([legacy], registry);

    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ id: legacy.id, selectedRoot: workspace.rootPath, compatibilityRefs: expect.arrayContaining([
      { kind: "development-project", id: legacy.id },
      { kind: "workspace", id: workspace.id },
    ]) });
  });

  it("TRUST-001/003: la confianza parte vacía y se decide localmente", async () => {
    const files = await fixture();
    expect(await loadProjectTrustStore(files.trust)).toEqual({ schemaVersion: 1, decisions: [] });
    const project = buildEmptyProjectCatalogRecord({ displayName: "Confiable", selectedRoot: "D:\\Trusted" });
    const decision = await setProjectTrust(files.trust, {
      projectId: project.id,
      mode: "full-host",
      deviceBinding: "a".repeat(64),
    });
    expect(decision).toMatchObject({ mode: "full-host", status: "active", acceptedRiskVersion: "1.0.0" });
    expect(await revokeProjectTrust(files.trust, project.id)).toMatchObject({ status: "revoked" });
  });

  it("elimina por completo la decisión de confianza de una ficha", async () => {
    const files = await fixture();
    const project = buildEmptyProjectCatalogRecord({ displayName: "Temporal", selectedRoot: "D:\\Temporal" });
    await setProjectTrust(files.trust, { projectId: project.id, mode: "full-host", deviceBinding: "b".repeat(64) });

    expect(await removeProjectTrustRecord(files.trust, project.id)).toBe(true);
    expect(await removeProjectTrustRecord(files.trust, project.id)).toBe(false);
    expect(await loadProjectTrustStore(files.trust)).toEqual({ schemaVersion: 1, decisions: [] });
  });

  it("TRUST-004: la identidad local es estable y no se hereda por el catálogo", async () => {
    const files = await fixture();
    const bindingPath = path.join(path.dirname(files.catalog), "device-binding.json");
    const first = await loadOrCreateDeviceBinding(bindingPath);
    const second = await loadOrCreateDeviceBinding(bindingPath);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(JSON.parse(await readFile(bindingPath, "utf8"))).toEqual({ deviceBinding: first });
  });

  it("COMPAT1-008: eliminar ficha no afecta el root", async () => {
    const files = await fixture();
    const project = buildEmptyProjectCatalogRecord({ displayName: "Temporal", selectedRoot: "D:\\Temporal" });
    await upsertProjectCatalogRecord(files.catalog, project);
    await removeProjectCatalogRecord(files.catalog, project.id);
    expect(await loadProjectCatalog(files.catalog)).toEqual({ schemaVersion: 1, projects: [] });
  });

  it("SCAN-000: varias raíces sin resolver siguen exigiendo revisión local", async () => {
    const workspaces = [
      buildWorkspace({ id: "ws_uno", rootPath: "D:\\Proyectos\\Uno" }),
      buildWorkspace({ id: "ws_dos", rootPath: "D:\\Proyectos\\Dos" }),
    ];
    const project = buildNewDevelopmentProject({ name: "Multi", workspaceIds: ["ws_uno", "ws_dos"] });
    const [migrated] = migrateDevelopmentProjectsToCatalog([project], { schemaVersion: 5, workspaces, applications: [] });
    expect(migrated?.state).toBe("review");
  });

  it("SCAN-001: la cobertura vive fuera del catálogo y no altera su contenido", async () => {
    const files = await fixture();
    const project = buildEmptyProjectCatalogRecord({ displayName: "Cobertura", selectedRoot: "D:\\Cobertura" });
    await upsertProjectCatalogRecord(files.catalog, project);
    const catalogBefore = await readFile(files.catalog, "utf8");

    await upsertProjectScanRecord(files.scan, {
      projectId: project.id,
      coverage: "partial",
      scannedEntries: 2_000,
      entryLimit: 2_000,
      observedAt: new Date().toISOString(),
    });

    expect(await readFile(files.catalog, "utf8")).toBe(catalogBefore);
    expect((await loadProjectScanStore(files.scan)).scans[0]).toMatchObject({ projectId: project.id, coverage: "partial" });
  });

  it("SCAN-002: cada proyecto conserva una sola cobertura, la más reciente", async () => {
    const files = await fixture();
    const projectId = `project_${"a".repeat(24)}`;
    const base = { projectId, scannedEntries: 10, entryLimit: 2_000, observedAt: "2026-08-28T00:00:00.000Z" };
    await upsertProjectScanRecord(files.scan, { ...base, coverage: "partial" });
    await upsertProjectScanRecord(files.scan, { ...base, coverage: "complete", observedAt: "2026-08-28T01:00:00.000Z" });

    const store = await loadProjectScanStore(files.scan);
    expect(store.scans).toHaveLength(1);
    expect(store.scans[0]).toMatchObject({ coverage: "complete", observedAt: "2026-08-28T01:00:00.000Z" });
  });

  it("SCAN-003: eliminar la cobertura es idempotente y no crea el archivo", async () => {
    const files = await fixture();
    await removeProjectScanRecord(files.scan, `project_${"b".repeat(24)}`);
    await expect(readFile(files.scan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadProjectScanStore(files.scan)).toEqual({ schemaVersion: 1, scans: [] });
  });
});
