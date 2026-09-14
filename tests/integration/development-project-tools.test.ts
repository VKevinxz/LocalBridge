import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startDevelopmentBroker, type RunningDevelopmentBroker } from "@localbridge/development";
import { TARGET_PROTOCOL_REVISION } from "@localbridge/shared";
import { callToolJson } from "../helpers/call.js";
import { buildWorkspace, writeRegistryFile } from "../helpers/fixtures.js";
import { createHarness, type Harness } from "../helpers/harness.js";

let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;
afterEach(async () => { await harness?.close(); await broker?.close(); harness = undefined; broker = undefined; });

const projectId = `project_${"a".repeat(24)}`;
const project = {
  projectId,
  name: "Proyecto asistido",
  description: "Frontend y API",
  workspaceIds: ["ws_project"],
  setupStatus: "review-required" as const,
  execution: { trustMode: "guided" as const, terminalAvailable: false, blockedReason: "guided-mode" as const },
};
const status = {
  project,
  setup: {
    phase: "awaiting-local-review" as const,
    policy: "restricted" as const,
    plan: {
      planSha256: "b".repeat(64), topology: "single" as const, workspaceCount: 1,
      installCount: 1, packageManagers: ["npm" as const], directDependencyCount: 3, directDevDependencyCount: 2,
      serverCount: 1, validationCount: 1, serviceCount: 1,
      actionKinds: ["node-install", "persist-profiles", "persist-application", "finalize-topology"] as const,
    },
  },
};

async function setup() {
  const configPath = path.join(os.tmpdir(), `localbridge-project-tools-${randomUUID()}`, "workspaces.json");
  await writeRegistryFile(configPath, [buildWorkspace({ id: "ws_project", rootPath: os.tmpdir() })]);
  const calls: Array<{ method: string; params: unknown }> = [];
  broker = await startDevelopmentBroker({ handler: async (request) => {
    calls.push(request);
    if (request.method === "project.list") return { projects: [project] };
    return status;
  } });
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });
  return calls;
}

describe("tools cerradas de proyectos asistidos", () => {
  it("lista, consulta y refresca sin exponer rutas, comandos o contenido del plan", async () => {
    const calls = await setup();
    const listed = await callToolJson(harness!.client, "project.list", {});
    const current = await callToolJson(harness!.client, "project.setup.status", { projectId });
    const refreshed = await callToolJson(harness!.client, "project.setup.refresh", { projectId });

    expect(listed.isError).toBe(false);
    expect(current.isError).toBe(false);
    expect(refreshed.isError).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["project.list", "project.setup.status", "project.setup.refresh"]);
    expect(JSON.stringify([listed.parsed, current.parsed, refreshed.parsed])).not.toMatch(/rootPath|manifestPath|command|environment|token|dependencyName/i);
  });

  it("informa estado y cobertura del escaneo sin exponer recuentos ni rutas", async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-project-coverage-${randomUUID()}`, "workspaces.json");
    await writeRegistryFile(configPath, [buildWorkspace({ id: "ws_project", rootPath: os.tmpdir() })]);
    broker = await startDevelopmentBroker({ handler: async () => ({
      projects: [{ ...project, setupStatus: "ready" as const, state: "ready" as const, scanCoverage: "partial" as const }],
    }) });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });

    const listed = await callToolJson(harness.client, "project.list", {});

    expect(listed.isError).toBe(false);
    // Cobertura parcial informa una estructura incompleta; nunca bloquea ni
    // filtra el tamaño del árbol (ADR-0040).
    expect((listed.parsed["projects"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: "ready",
      scanCoverage: "partial",
    });
    expect(JSON.stringify(listed.parsed)).not.toMatch(/scannedEntries|entryLimit|rootPath/i);
  });

  it("una lista sin estado ni cobertura sigue siendo válida y falla cerrado", async () => {
    const calls = await setup();
    const listed = await callToolJson(harness!.client, "project.list", {});

    expect(calls[0]?.method).toBe("project.list");
    expect((listed.parsed["projects"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: "ready",
      scanCoverage: "unknown",
    });
  });

  it("separa una propuesta detectada de los perfiles revisados sin bloquear Control total", async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-project-availability-${randomUUID()}`, "workspaces.json");
    await writeRegistryFile(configPath, [buildWorkspace({ id: "ws_project", rootPath: os.tmpdir() })]);
    broker = await startDevelopmentBroker({ handler: async () => ({
      projects: [{
        ...project,
        execution: { trustMode: "full-host" as const, terminalAvailable: true },
        automation: {
          reviewedProfiles: { processes: [], validations: [], browser: [] },
          detectedProposal: { state: "detected-awaiting-review" as const, processCount: 1, validationCount: 2 },
        },
      }],
    }) });
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, developmentBrokerEndpoint: broker.endpoint, developmentBrokerToken: broker.token });

    const listed = await callToolJson(harness.client, "project.list", {});

    expect(listed.isError).toBe(false);
    expect((listed.parsed["projects"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      execution: { trustMode: "full-host", terminalAvailable: true },
      automation: {
        reviewedProfiles: { processes: [], validations: [], browser: [] },
        detectedProposal: { state: "detected-awaiting-review", processCount: 1, validationCount: 2 },
      },
    });
  });

  it("rechaza campos para crear, aprobar, ejecutar o inyectar comandos", async () => {
    await setup();
    for (const payload of [
      { projectId, command: "npm install" },
      { projectId, approved: true },
      { projectId, rootPath: "C:\\outside" },
      { projectId, packages: ["evil"] },
    ]) {
      const result = await harness!.client.callTool({ name: "project.setup.refresh", arguments: payload });
      expect(result.isError).toBe(true);
    }
  });
});
