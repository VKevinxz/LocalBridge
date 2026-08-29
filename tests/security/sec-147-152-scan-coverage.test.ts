import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TerminalSupervisor } from "@localbridge/development";
import {
  projectCatalogRecordSchema,
  projectScanStoreSchema,
  type ProjectCatalogRecord,
  type ProjectTrustRecord,
} from "@localbridge/workspace";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

const PROJECT_ID = `project_${"a".repeat(24)}`;
const DEVICE = "b".repeat(64);

function catalogRecord(state: ProjectCatalogRecord["state"]): ProjectCatalogRecord {
  return projectCatalogRecordSchema.parse({
    id: PROJECT_ID,
    displayName: "demo",
    description: "",
    selectedRoot: "C:\\demo",
    state,
    topology: "monorepo",
    nodes: [],
    derivedScopes: [{ relativePath: ".", source: "root", status: "active" }],
    compatibilityRefs: [{ kind: "development-project", id: PROJECT_ID }],
    scanFingerprint: "c".repeat(64),
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  });
}

function trustRecord(overrides: Partial<ProjectTrustRecord> = {}): ProjectTrustRecord {
  return {
    projectId: PROJECT_ID,
    mode: "full-host",
    deviceBinding: DEVICE,
    status: "active",
    networkPolicy: "user-session",
    acceptedRiskVersion: "1.0.0",
    reviewedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function supervisorFor(state: ProjectCatalogRecord["state"], trust: ProjectTrustRecord = trustRecord()): TerminalSupervisor {
  return new TerminalSupervisor({
    helperPath: "C:\\nonexistent\\host.exe",
    parentPid: process.pid,
    deviceBinding: DEVICE,
    loadProject: async () => catalogRecord(state),
    loadTrust: async () => trust,
  });
}

describe("SEC-147..152 — cobertura de escaneo separada de la confianza (ADR-0040)", () => {
  it("SEC-147: un recorrido incompleto no degrada el estado, y todo cambio de estado se audita y es reversible", async () => {
    const main = await source("apps/desktop/src/main/index.ts");
    expect(main).not.toContain('topology.truncated ? "review" : "ready"');
    expect(main).toContain('coverage: topology.truncated ? "partial" : "complete"');
    expect(main).toContain("recordProjectAudit(`project.state.${stored.state}`");
    expect(main).toContain('current.state !== "ready" && current.state !== "review"');
    // Una instalación ya degradada no puede recuperarse por actividad, porque la
    // actividad es justo lo bloqueado: se reconcilia al arrancar el runtime.
    expect(main).toContain("await healReviewedProjects();");
    expect(main).toContain('candidate.state === "review"');
  });

  it("SEC-148: la cobertura se informa sin recuentos, rutas ni nombres de carpeta", async () => {
    const tool = await source("packages/mcp-server/src/tools/project-tools.ts");
    expect(tool).toContain('scanCoverage: z.enum(["complete", "partial", "unknown"])');
    expect(tool).not.toMatch(/scannedEntries|selectedRoot|entryLimit/);
  });

  it("SEC-149: iniciar y escribir conservan el gate de estado; leer y cerrar no", async () => {
    const supervisor = supervisorFor("review");
    const sessionId = `terminal_${"d".repeat(24)}`;

    await expect(supervisor.start(PROJECT_ID)).rejects.toMatchObject({ code: "PROJECT_REVIEW_REQUIRED" });
    await expect(supervisor.write(PROJECT_ID, sessionId, "dir\r\n")).rejects.toMatchObject({ code: "PROJECT_REVIEW_REQUIRED" });

    // Pasan el gate de proyecto y fallan al buscar la sesión: la autoridad de
    // sesión ya no depende del estado del catálogo.
    await expect(supervisor.stop(PROJECT_ID, sessionId)).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" });
    await expect(supervisor.status(PROJECT_ID, sessionId)).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" });
    await expect(supervisor.read(PROJECT_ID, sessionId, 0, 1_024)).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" });
  });

  it("SEC-150: cerrar una sesión sigue exigiendo confianza activa del mismo equipo", async () => {
    const sessionId = `terminal_${"d".repeat(24)}`;
    const revoked = supervisorFor("ready", trustRecord({ status: "revoked" }));
    await expect(revoked.stop(PROJECT_ID, sessionId)).rejects.toMatchObject({ code: "TERMINAL_NOT_AUTHORIZED" });

    const otherDevice = supervisorFor("ready", trustRecord({ deviceBinding: "e".repeat(64) }));
    await expect(otherDevice.stop(PROJECT_ID, sessionId)).rejects.toMatchObject({ code: "TERMINAL_NOT_AUTHORIZED" });

    const guided = supervisorFor("ready", trustRecord({ mode: "guided", acceptedRiskVersion: null }));
    await expect(guided.stop(PROJECT_ID, sessionId)).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
  });

  it("SEC-151: la ficha de catálogo conserva su forma estricta y no admite cobertura", () => {
    const record = catalogRecord("ready");
    expect(() => projectCatalogRecordSchema.parse({ ...record, scan: { coverage: "partial" } })).toThrow();
    expect(() => projectCatalogRecordSchema.parse({ ...record, scanCoverage: "partial" })).toThrow();
  });

  it("SEC-152: la cobertura persistida no concede capacidades ni expone rutas", () => {
    const store = projectScanStoreSchema.parse({
      schemaVersion: 1,
      scans: [{
        projectId: PROJECT_ID,
        coverage: "partial",
        scannedEntries: 2_000,
        entryLimit: 2_000,
        observedAt: "2026-08-28T00:00:00.000Z",
      }],
    });
    expect(Object.keys(store.scans[0]!).toSorted()).toEqual([
      "coverage", "entryLimit", "observedAt", "projectId", "scannedEntries",
    ]);
    expect(() => projectScanStoreSchema.parse({
      schemaVersion: 1,
      scans: [{ projectId: PROJECT_ID, coverage: "partial", scannedEntries: 1, entryLimit: 1, observedAt: "2026-08-28T00:00:00.000Z", rootPath: "C:\\demo" }],
    })).toThrow();
  });
});
