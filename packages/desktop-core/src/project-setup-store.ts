import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent } from "@localbridge/shared";
import {
  projectSetupSessionSchema,
  projectSetupStoreSchema,
  type ProjectSetupSession,
  type ProjectSetupStore,
  type SetupPolicy,
} from "@localbridge/workspace";

function emptyStore(): ProjectSetupStore {
  return { schemaVersion: 1, sessions: [] };
}

async function readStore(filePath: string): Promise<ProjectSetupStore> {
  try {
    return projectSetupStoreSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isEnoent(error)) return emptyStore();
    throw new Error("El estado local de preparación no es válido.", { cause: error });
  }
}

async function writeStore(filePath: string, store: ProjectSetupStore): Promise<void> {
  const validated = projectSetupStoreSchema.parse(store);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await atomicWrite(directory, path.basename(filePath), Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8"));
}

export async function createProjectSetupSession(
  filePath: string,
  projectId: string,
  provisionalWorkspaceId: string,
  policy: SetupPolicy,
  initializeGit = false,
): Promise<ProjectSetupSession> {
  const current = await readStore(filePath);
  const active = current.sessions.find((session) => session.projectId === projectId && !["ready", "failed", "interrupted", "cancelled"].includes(session.phase));
  if (active !== undefined) return active;
  const now = new Date().toISOString();
  const session = projectSetupSessionSchema.parse({
    id: `setup_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    projectId,
    provisionalWorkspaceId,
    policy,
    initializeGit,
    phase: "draft",
    createdAt: now,
    updatedAt: now,
  });
  await writeStore(filePath, { schemaVersion: 1, sessions: [...current.sessions, session] });
  return session;
}

export async function listProjectSetupSessions(filePath: string): Promise<ProjectSetupSession[]> {
  return [...(await readStore(filePath)).sessions];
}

export async function updateProjectSetupSession(filePath: string, session: ProjectSetupSession): Promise<ProjectSetupSession> {
  const validated = projectSetupSessionSchema.parse(session);
  const current = await readStore(filePath);
  const index = current.sessions.findIndex((candidate) => candidate.id === validated.id);
  if (index === -1) throw new Error("Sesión de preparación no encontrada.");
  await writeStore(filePath, { schemaVersion: 1, sessions: current.sessions.with(index, validated) });
  return validated;
}

export async function interruptProjectSetupSessions(filePath: string): Promise<ProjectSetupSession[]> {
  const current = await readStore(filePath);
  const now = new Date().toISOString();
  const sessions = current.sessions.map((session) =>
    session.phase === "installing" || session.phase === "finalizing" || session.phase === "analyzing"
      ? { ...session, phase: "interrupted" as const, errorCode: "SETUP_INTERRUPTED", updatedAt: now }
      : session);
  if (JSON.stringify(sessions) !== JSON.stringify(current.sessions)) await writeStore(filePath, { schemaVersion: 1, sessions });
  return sessions;
}
