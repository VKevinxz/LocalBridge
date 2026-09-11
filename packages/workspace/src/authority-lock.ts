import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { LocalBridgeError, isEnoent } from "@localbridge/shared";

const RETRY_MS = 25;
const ACQUIRE_TIMEOUT_MS = 150_000;
const ORPHAN_GRACE_MS = 10_000;

interface LockOwner {
  readonly token: string;
  readonly pid: number;
}

function ownerPath(lockPath: string): string {
  return `${lockPath}/owner.json`;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(ownerPath(lockPath), "utf8")) as Partial<LockOwner>;
    if (typeof parsed.token === "string" && typeof parsed.pid === "number") return { token: parsed.token, pid: parsed.pid };
  } catch {
    // Un owner ausente o parcial solo se recupera tras la gracia de orfandad.
  }
  return undefined;
}

async function recoverOrphan(lockPath: string): Promise<boolean> {
  let details;
  try {
    details = await stat(lockPath);
  } catch (error) {
    return isEnoent(error);
  }
  const owner = await readOwner(lockPath);
  if ((owner !== undefined && processExists(owner.pid)) || Date.now() - details.mtimeMs < ORPHAN_GRACE_MS) return false;
  try {
    await unlink(ownerPath(lockPath)).catch((error: unknown) => { if (!isEnoent(error)) throw error; });
    await rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquire(configPath: string): Promise<{ lockPath: string; token: string }> {
  const lockPath = `${configPath}.authority-lock`;
  // En una instalación limpia el directorio interno de configuración todavía no
  // existe. Prepararlo antes del mkdir exclusivo conserva la atomicidad del lock
  // y evita que el proceso de escritorio falle antes de registrar sus IPC.
  await mkdir(path.dirname(configPath), { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      const token = randomUUID();
      try {
        await writeFile(ownerPath(lockPath), JSON.stringify({ token, pid: process.pid }), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }
      return { lockPath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverOrphan(lockPath);
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw new LocalBridgeError("TIMEOUT", { reason: "workspace authority lock busy" });
}

async function release(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return;
  await unlink(ownerPath(lockPath)).catch(() => undefined);
  await rmdir(lockPath).catch(() => undefined);
}

/**
 * Serializa entre procesos los cambios del registro y el efecto autorizado.
 * Una revocación administrada por LocalBridge gana el lock antes del efecto o
 * espera a que ese efecto termine; nunca puede intercalarse entre ambos.
 */
export async function withWorkspaceAuthorityLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const { lockPath, token } = await acquire(configPath);
  try {
    return await operation();
  } finally {
    await release(lockPath, token);
  }
}
