/**
 * Almacén de idempotencia por `operationId` (ADR-0013, SECURITY.md amenaza J).
 *
 * En memoria, sin persistencia entre reinicios — protege contra el reintento
 * de una mutación que ya se aplicó dentro de la misma sesión del servidor
 * (por ejemplo, tras un stream roto), no contra la recuperación tras un crash.
 *
 * Solo se cachean **éxitos**. Un fallo (p. ej. `HASH_MISMATCH`) no se cachea:
 * reintentar una mutación que no llegó a aplicarse es seguro y puede tener un
 * resultado distinto la segunda vez.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface CachedEntry {
  result: unknown;
  expiresAt: number;
}

const store = new Map<string, CachedEntry>();

export function idempotencyKey(tool: string, workspaceId: string, operationId: string): string {
  return `${tool}:${workspaceId}:${operationId}`;
}

export function getCachedResult<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.result as T;
}

export function cacheResult(key: string, result: unknown, ttlMs = DEFAULT_TTL_MS): void {
  sweepExpired();
  store.set(key, { result, expiresAt: Date.now() + ttlMs });
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(key);
    }
  }
}
