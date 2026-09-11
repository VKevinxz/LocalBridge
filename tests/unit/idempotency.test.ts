import { describe, expect, it, vi } from 'vitest';

import {
  cacheResult,
  getCachedResult,
  idempotencyFingerprint,
  idempotencyKey,
  runIdempotent,
} from '@localbridge/mcp-server';

describe('idempotencyKey', () => {
  it('compone sin colisiones ambiguas tool, workspaceId y operationId', () => {
    const key = idempotencyKey('file.create', 'ws_a', 'op_1');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toBe(idempotencyKey('file.create', 'ws_a:op', '1'));
    expect(key).not.toBe(idempotencyKey('file.create', 'ws_a', 'op:1'));
  });

  it('claves distintas no colisionan entre tools o workspaces', () => {
    expect(idempotencyKey('file.create', 'ws_a', 'op_1')).not.toBe(idempotencyKey('file.write_guarded', 'ws_a', 'op_1'));
    expect(idempotencyKey('file.create', 'ws_a', 'op_1')).not.toBe(idempotencyKey('file.create', 'ws_b', 'op_1'));
  });
});

describe('cacheResult / getCachedResult', () => {
  it('un resultado cacheado se devuelve tal cual', () => {
    const key = idempotencyKey('file.create', 'ws_a', 'op_x');
    const fingerprint = idempotencyFingerprint('a.txt', 'content');
    cacheResult(key, fingerprint, { path: 'a.txt', sha256: 'abc' });

    expect(getCachedResult(key, fingerprint)).toEqual({ path: 'a.txt', sha256: 'abc' });
  });

  it('una clave nunca vista devuelve undefined', () => {
    expect(getCachedResult(idempotencyKey('file.create', 'ws_a', 'op_nunca_visto'), idempotencyFingerprint('x'))).toBeUndefined();
  });

  it('expira tras el TTL', () => {
    vi.useFakeTimers();
    try {
      const key = idempotencyKey('file.create', 'ws_a', 'op_ttl');
      const fingerprint = idempotencyFingerprint('ttl');
      cacheResult(key, fingerprint, { ok: true }, 1000);

      expect(getCachedResult(key, fingerprint)).toEqual({ ok: true });

      vi.advanceTimersByTime(1001);

      expect(getCachedResult(key, fingerprint)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechaza reutilizar operationId con otro payload', () => {
    const key = idempotencyKey('file.create', 'ws_a', 'op_conflict');
    const first = idempotencyFingerprint('a.txt', 'uno');
    cacheResult(key, first, { ok: true });

    expect(() => getCachedResult(key, idempotencyFingerprint('a.txt', 'dos')))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('coalesce dos ejecuciones concurrentes idénticas', async () => {
    const key = idempotencyKey('file.create', 'ws_a', 'op_concurrent');
    const fingerprint = idempotencyFingerprint('same');
    const operation = vi.fn(async () => {
      await Promise.resolve();
      return { ok: true };
    });

    const [first, second] = await Promise.all([
      runIdempotent(key, fingerprint, operation),
      runIdempotent(key, fingerprint, operation),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
