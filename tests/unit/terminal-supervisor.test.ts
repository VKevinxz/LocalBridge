import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TerminalSupervisor } from "@localbridge/development";
import type { ProjectCatalogRecord, ProjectTrustRecord } from "@localbridge/workspace";

const roots: string[] = [];
const supervisors: TerminalSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  mode: ProjectTrustRecord["mode"] = "full-host",
  onProjectActivity?: (projectId: string) => void,
  additionalProjectId?: string,
  withProjectSandbox = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-terminal-"));
  roots.push(root);
  const project: ProjectCatalogRecord = {
    id: "project_aaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Terminal",
    description: "",
    selectedRoot: root,
    state: "ready",
    topology: "empty",
    nodes: [],
    derivedScopes: [{ relativePath: ".", source: "root", status: "active" }],
    compatibilityRefs: [],
    scanFingerprint: "a".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const trust: ProjectTrustRecord = {
    projectId: project.id,
    mode,
    deviceBinding: "b".repeat(64),
    status: "active",
    networkPolicy: mode === "full-host" ? "user-session" : "closed",
    acceptedRiskVersion: mode === "full-host" ? "1.0.0" : null,
    reviewedAt: new Date().toISOString(),
  };
  const supervisor = new TerminalSupervisor({
    helperPath: path.resolve("apps/desktop/vendor/process-host/localbridge-process-host.exe"),
    parentPid: process.pid,
    deviceBinding: "b".repeat(64),
    loadProject: async (id) => id === project.id ? project : id === additionalProjectId ? { ...project, id } : undefined,
    loadTrust: async (id) => id === project.id ? trust : id === additionalProjectId ? { ...trust, projectId: id } : undefined,
    ...(withProjectSandbox ? {
      projectSandbox: {
        available: true as const,
        command: async (_project: ProjectCatalogRecord, shell: string) => [shell],
      },
    } : {}),
    ...(onProjectActivity === undefined ? {} : { onProjectActivity }),
  });
  supervisors.push(supervisor);
  return { project, trust, supervisor };
}

async function waitForOutput(supervisor: TerminalSupervisor, projectId: string, sessionId: string, expected: string) {
  const deadline = Date.now() + 8_000;
  let observed = "";
  while (Date.now() < deadline) {
    const result = await supervisor.read(projectId, sessionId, 0, 65_536);
    observed = result.entries.map((entry) => entry.text).join("");
    if (observed.includes(expected)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No apareció ${expected}; salida=${JSON.stringify(observed)}`);
}

async function quietTerminalCursor(supervisor: TerminalSupervisor, projectId: string, sessionId: string): Promise<number> {
  let cursor = (await supervisor.read(projectId, sessionId, 0, 65_536)).nextCursor;
  let consecutiveDeadlines = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await supervisor.read(projectId, sessionId, cursor, 65_536, 250);
    cursor = result.nextCursor;
    consecutiveDeadlines = result.waitOutcome === "deadline" ? consecutiveDeadlines + 1 : 0;
    if (consecutiveDeadlines === 2) return cursor;
  }
  return cursor;
}

describe.skipIf(process.platform !== "win32")("terminal supervisor Windows", () => {
  it("TERM-001/003: inicia ConPTY, acepta stdin y detiene el árbol", async () => {
    const { project, supervisor } = await fixture();
    const session = await supervisor.start(project.id, "start-1");
    await supervisor.write(project.id, session.sessionId, "Write-Output TERMINAL_OK\r\n", "write-1");
    const output = await waitForOutput(supervisor, project.id, session.sessionId, "TERMINAL_OK");
    expect(output.entries.map((entry) => entry.text).join("")).toContain("TERMINAL_OK");
    expect((await supervisor.stop(project.id, session.sessionId)).state).toBe("stopped");
  });

  it("TERM-013: lista solo las sesiones retenidas del proyecto autorizado", async () => {
    const otherProjectId = "project_bbbbbbbbbbbbbbbbbbbbbbbb";
    const { project, supervisor } = await fixture("full-host", undefined, otherProjectId);
    const own = await supervisor.start(project.id, "list-own");
    const other = await supervisor.start(otherProjectId, "list-other");

    expect(await supervisor.list(project.id)).toEqual([expect.objectContaining({ sessionId: own.sessionId, projectId: project.id })]);
    expect((await supervisor.list(project.id)).some((session) => session.sessionId === other.sessionId)).toBe(false);
  });

  it("TERM-014: oculta output retenido si cambia la aprobación de la sesión", async () => {
    const { project, trust, supervisor } = await fixture("full-host", undefined, undefined, true);
    const session = await supervisor.start(project.id, "retained-authority");
    await supervisor.write(project.id, session.sessionId, "Write-Output OLD_AUTHORITY_OUTPUT\r\n", "retained-write");
    await waitForOutput(supervisor, project.id, session.sessionId, "OLD_AUTHORITY_OUTPUT");
    await supervisor.stop(project.id, session.sessionId);
    Object.assign(trust, {
      mode: "project-agent",
      networkPolicy: "closed",
      acceptedRiskVersion: null,
      reviewedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    expect(await supervisor.list(project.id)).toEqual([]);
    await expect(supervisor.read(project.id, session.sessionId, 0, 65_536))
      .rejects.toMatchObject({ code: "TERMINAL_NOT_AUTHORIZED" });
    await expect(supervisor.status(project.id, session.sessionId))
      .rejects.toMatchObject({ code: "TERMINAL_NOT_AUTHORIZED" });
    expect((await supervisor.stop(project.id, session.sessionId)).state).toBe("stopped");
  });

  it("SEC-134: no detiene una sesión de otro proyecto", async () => {
    const otherProjectId = "project_bbbbbbbbbbbbbbbbbbbbbbbb";
    const { project, supervisor } = await fixture("full-host", undefined, otherProjectId);
    const session = await supervisor.start(project.id, "cross-project-start");

    await expect(supervisor.stop(otherProjectId, session.sessionId)).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" });
    expect((await supervisor.status(project.id, session.sessionId)).session.state).toBe("running");
  });

  it("TERM-012: respeta maxBytes incluso si el primer bloque es mayor", async () => {
    const { project, supervisor } = await fixture();
    const session = await supervisor.start(project.id, "bounded-read-start");
    await supervisor.write(project.id, session.sessionId, "Write-Output BOUNDED_OUTPUT\r\n", "bounded-read-write");
    await waitForOutput(supervisor, project.id, session.sessionId, "BOUNDED_OUTPUT");

    const output = await supervisor.read(project.id, session.sessionId, 0, 1);
    expect(output.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0)).toBeLessThanOrEqual(1);
    expect(output.nextCursor).toBeLessThanOrEqual(1);
  });

  it("TERM-015: espera salida sin consumir cursores de otros clientes y distingue deadline", async () => {
    const { project, supervisor } = await fixture();
    const session = await supervisor.start(project.id, "long-poll-start");
    const cursor = await quietTerminalCursor(supervisor, project.id, session.sessionId);
    const firstClient = supervisor.read(project.id, session.sessionId, cursor, 65_536, 3_000);
    const secondClient = supervisor.read(project.id, session.sessionId, cursor, 65_536, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supervisor.write(project.id, session.sessionId, "Write-Output LONG_POLL_OK\r\n", "long-poll-write");
    const [first, second] = await Promise.all([firstClient, secondClient]);
    expect(first.waitOutcome).toBe("output");
    expect(second.waitOutcome).toBe("output");
    expect(first.nextCursor).toBe(second.nextCursor);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const firstObserved = await supervisor.read(project.id, session.sessionId, cursor, 65_536);
    const secondObserved = await supervisor.read(project.id, session.sessionId, cursor, 65_536);
    expect(firstObserved.entries.map((entry) => entry.text).join("")).toContain("LONG_POLL_OK");
    expect(secondObserved.entries).toEqual(firstObserved.entries);

    const quietCursor = await quietTerminalCursor(supervisor, project.id, session.sessionId);
    const deadline = await supervisor.read(project.id, session.sessionId, quietCursor, 65_536, 100);
    expect(deadline.waitOutcome).toBe("deadline");
    expect(deadline.session.state).toBe("running");
    expect(deadline.entries).toEqual([]);
    expect(deadline.waitedMs).toBeGreaterThanOrEqual(75);
  });

  it("TERM-016: despierta por cierre y acota suscripciones por sesión", async () => {
    const { project, supervisor } = await fixture();
    const session = await supervisor.start(project.id, "long-poll-capacity");
    const quietCursor = await quietTerminalCursor(supervisor, project.id, session.sessionId);
    const waits = Array.from({ length: 8 }, () => supervisor.read(project.id, session.sessionId, quietCursor, 65_536, 3_000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(supervisor.read(project.id, session.sessionId, quietCursor, 65_536, 3_000))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
    await supervisor.stop(project.id, session.sessionId);
    const results = await Promise.all(waits);
    expect(results.every((result) => result.session.state === "stopped")).toBe(true);
    expect(results.every((result) => result.waitOutcome === "terminal-ended" || result.waitOutcome === "output")).toBe(true);
  });

  it("TRUST-001/SEC-124: guided y project-agent sin sandbox fallan cerrados", async () => {
    const guided = await fixture("guided");
    await expect(guided.supervisor.start(guided.project.id)).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    const sandboxed = await fixture("project-agent");
    await expect(sandboxed.supervisor.start(sandboxed.project.id)).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  });

  it("TERM-006: operationId es idempotente y no cruza sesiones", async () => {
    const { project, supervisor } = await fixture();
    const first = await supervisor.start(project.id, "same-start");
    expect((await supervisor.start(project.id, "same-start")).sessionId).toBe(first.sessionId);
    await supervisor.write(project.id, first.sessionId, "Write-Output ONCE\r\n", "same-write");
    await supervisor.write(project.id, first.sessionId, "Write-Output ONCE\r\n", "same-write");
    await expect(supervisor.write(project.id, first.sessionId, "Write-Output OTHER\r\n", "same-write"))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("INT-003/005: atribuye un listener real al árbol de la terminal", async () => {
    const { project, supervisor } = await fixture();
    const session = await supervisor.start(project.id, "listener-start");
    await supervisor.write(
      project.id,
      session.sessionId,
      `node -e "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'::1',()=>console.log('Local: http://localhost:'+s.address().port+'/'))"\r\n`,
      "listener-write",
    );
    const deadline = Date.now() + 8_000;
    let listener: Awaited<ReturnType<TerminalSupervisor["status"]>>["listeners"][number] | undefined;
    while (Date.now() < deadline && listener === undefined) {
      listener = (await supervisor.status(project.id, session.sessionId)).listeners[0];
      if (listener === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await waitForOutput(supervisor, project.id, session.sessionId, "Local: http://localhost:");
    expect(listener).toMatchObject({ bindScope: "loopback", addressFamily: "ipv6", exclusive: true });
    const resolved = await supervisor.resolveListener(project.id, session.sessionId, listener!.listenerRef);
    expect(resolved).toMatchObject({
      processId: session.sessionId,
      profile: "terminal",
      origin: listener!.origin,
      technicalOrigin: `http://[::1]:${listener!.port}`,
      browserOrigin: `http://localhost:${listener!.port}`,
      trustMode: "full-host",
    });
    await supervisor.stop(project.id, session.sessionId);
  });

  it("DISC-003/INT-001: notifica actividad para reconciliar nuevos hijos", async () => {
    const observed: string[] = [];
    const { project, supervisor } = await fixture("full-host", (projectId) => observed.push(projectId));
    const session = await supervisor.start(project.id, "graph-start");
    await supervisor.write(project.id, session.sessionId, "Write-Output GRAPH_CHANGED\r\n", "graph-write");
    await waitForOutput(supervisor, project.id, session.sessionId, "GRAPH_CHANGED");
    expect(observed).toContain(project.id);
  });

  it("TERM-011: no hereda secretos internos ni flags del host Electron", async () => {
    const previousSecret = process.env["LOCALBRIDGE_SYNTHETIC_SECRET"];
    const previousElectron = process.env["ELECTRON_SYNTHETIC_FLAG"];
    process.env["LOCALBRIDGE_SYNTHETIC_SECRET"] = "terminal-secret-must-not-leak";
    process.env["ELECTRON_SYNTHETIC_FLAG"] = "electron-flag-must-not-leak";
    try {
      const { project, supervisor } = await fixture();
      const session = await supervisor.start(project.id, "secret-start");
      await supervisor.write(
        project.id,
        session.sessionId,
        'Write-Output "$env:LOCALBRIDGE_SYNTHETIC_SECRET|$env:ELECTRON_SYNTHETIC_FLAG|ENV_DONE"\r\n',
        "secret-write",
      );
      const output = await waitForOutput(supervisor, project.id, session.sessionId, "ENV_DONE");
      const text = output.entries.map((entry) => entry.text).join("");
      expect(text).not.toContain("terminal-secret-must-not-leak");
      expect(text).not.toContain("electron-flag-must-not-leak");
    } finally {
      if (previousSecret === undefined) delete process.env["LOCALBRIDGE_SYNTHETIC_SECRET"];
      else process.env["LOCALBRIDGE_SYNTHETIC_SECRET"] = previousSecret;
      if (previousElectron === undefined) delete process.env["ELECTRON_SYNTHETIC_FLAG"];
      else process.env["ELECTRON_SYNTHETIC_FLAG"] = previousElectron;
    }
  });

  it("TERM-010: desactiva la persistencia de historial de PowerShell", async () => {
    const { project, supervisor } = await fixture();
    const session = await supervisor.start(project.id, "history-start");
    await supervisor.write(project.id, session.sessionId, "Write-Output ((Get-PSReadLineOption).HistorySaveStyle)\r\n", "history-write");
    const output = await waitForOutput(supervisor, project.id, session.sessionId, "SaveNothing");
    expect(output.entries.map((entry) => entry.text).join("")).toContain("SaveNothing");
  });
});
