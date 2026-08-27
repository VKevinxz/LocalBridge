import { describe, expect, it, vi } from 'vitest';

import { cacheResult, getCachedResult, idempotencyKey } from '@localbridge/mcp-server';

describe('idempotencyKey', () => {
  it('compone tool, workspaceId y operationId', () => {
    expect(idempotencyKey('file.create', 'ws_a', 'op_1')).toBe('file.create:ws_a:op_1');
  });

  it('claves distintas no colisionan entre tools o workspaces', () => {
    expect(idempotencyKey('file.create', 'ws_a', 'op_1')).not.toBe(idempotencyKey('file.write_guarded', 'ws_a', 'op_1'));
    expect(idempotencyKey('file.create', 'ws_a', 'op_1')).not.toBe(idempotencyKey('file.create', 'ws_b', 'op_1'));
  });
});

describe('cacheResult / getCachedResult', () => {
  it('un resultado cacheado se devuelve tal cual', () => {
    const key = idempotencyKey('file.create', 'ws_a', 'op_x');
    cacheResult(key, { path: 'a.txt', sha256: 'abc' });

    expect(getCachedResult(key)).toEqual({ path: 'a.txt', sha256: 'abc' });
  });

  it('una clave nunca vista devuelve undefined', () => {
    expect(getCachedResult(idempotencyKey('file.create', 'ws_a', 'op_nunca_visto'))).toBeUndefined();
  });

  it('expira tras el TTL', () => {
    vi.useFakeTimers();
    try {
      const key = idempotencyKey('file.create', 'ws_a', 'op_ttl');
      cacheResult(key, { ok: true }, 1000);

      expect(getCachedResult(key)).toEqual({ ok: true });

      vi.advanceTimersByTime(1001);

      expect(getCachedResult(key)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
