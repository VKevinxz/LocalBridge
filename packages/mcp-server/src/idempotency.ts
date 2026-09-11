/**
 * Idempotencia de mutaciones por `operationId` (ADR-0013, SECURITY.md amenaza J).
 * La identidad incluye un hash del payload: reutilizar la misma clave para otra
 * intención falla cerrado. Las ejecuciones idénticas concurrentes comparten una
 * sola promesa y solo los éxitos quedan cacheados.
 */

import { createHash } from "node:crypto";

import { LocalBridgeError } from "@localbridge/shared";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 4_096;

interface RunningEntry {
  readonly state: "running";
  readonly fingerprint: string;
  readonly promise: Promise<unknown>;
}

interface CompletedEntry {
  readonly state: "completed";
  readonly fingerprint: string;
  readonly result: unknown;
  readonly expiresAt: number;
}

type Entry = RunningEntry | CompletedEntry;
const store = new Map<string, Entry>();

export function idempotencyKey(tool: string, workspaceId: string, operationId: string): string {
  return createHash("sha256").update(JSON.stringify([tool, workspaceId, operationId]), "utf8").digest("hex");
}

export function idempotencyFingerprint(...parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export function getCachedResult<T>(key: string, fingerprint: string): T | undefined {
  const entry = currentEntry(key);
  if (entry === undefined) return undefined;
  requireSameFingerprint(entry, fingerprint);
  return entry.state === "completed" ? entry.result as T : undefined;
}

export function cacheResult(key: string, fingerprint: string, result: unknown, ttlMs = DEFAULT_TTL_MS): void {
  sweepExpired();
  const existing = store.get(key);
  if (existing !== undefined) requireSameFingerprint(existing, fingerprint);
  store.set(key, { state: "completed", fingerprint, result, expiresAt: Date.now() + ttlMs });
}

export async function runIdempotent<T>(
  key: string,
  fingerprint: string,
  operation: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  sweepExpired();
  const existing = currentEntry(key);
  if (existing !== undefined) {
    requireSameFingerprint(existing, fingerprint);
    return existing.state === "completed" ? existing.result as T : existing.promise as Promise<T>;
  }

  reserveCapacity();
  const promise = Promise.resolve().then(operation);
  const running: RunningEntry = { state: "running", fingerprint, promise };
  store.set(key, running);
  try {
    const result = await promise;
    if (store.get(key) === running) {
      store.set(key, { state: "completed", fingerprint, result, expiresAt: Date.now() + ttlMs });
    }
    return result;
  } catch (error) {
    if (store.get(key) === running) store.delete(key);
    throw error;
  }
}

function currentEntry(key: string): Entry | undefined {
  const entry = store.get(key);
  if (entry?.state === "completed" && Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function requireSameFingerprint(entry: Entry, fingerprint: string): void {
  if (entry.fingerprint !== fingerprint) {
    throw new LocalBridgeError("IDEMPOTENCY_CONFLICT", { reason: "operationId reused with different input" });
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.state === "completed" && now > entry.expiresAt) store.delete(key);
  }
}

function reserveCapacity(): void {
  while (store.size >= MAX_ENTRIES) {
    const completed = [...store.entries()].find(([, entry]) => entry.state === "completed");
    if (completed === undefined) throw new LocalBridgeError("RATE_LIMITED", { reason: "too many idempotent operations in flight" });
    store.delete(completed[0]);
  }
}
