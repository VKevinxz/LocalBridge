import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProjectSetupSession,
  interruptProjectSetupSessions,
  listProjectSetupSessions,
  updateProjectSetupSession,
} from "@localbridge/desktop-core";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function storePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-setup-store-"));
  roots.push(root);
  return path.join(root, "project-setup.json");
}

describe("project setup store v1", () => {
  it("crea una sola sesión activa por proyecto", async () => {
    const file = await storePath();
    const first = await createProjectSetupSession(file, `project_${"a".repeat(24)}`, "ws_a", "restricted", true);
    const second = await createProjectSetupSession(file, first.projectId, "ws_a", "compatible");
    expect(second.id).toBe(first.id);
    expect(await listProjectSetupSessions(file)).toHaveLength(1);
    expect(first.initializeGit).toBe(true);
  });

  it("SEC-119: una ejecución no se reanuda después de reiniciar", async () => {
    const file = await storePath();
    const session = await createProjectSetupSession(file, `project_${"b".repeat(24)}`, "ws_b", "restricted");
    await updateProjectSetupSession(file, { ...session, phase: "installing", updatedAt: new Date().toISOString() });

    const [interrupted] = await interruptProjectSetupSessions(file);

    expect(interrupted?.phase).toBe("interrupted");
    expect(interrupted?.errorCode).toBe("SETUP_INTERRUPTED");
  });
});
