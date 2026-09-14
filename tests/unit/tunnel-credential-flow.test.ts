import { describe, expect, it, vi } from 'vitest';

import { connectWithTunnelCredential, type SecureKeyLoadResult } from '@localbridge/desktop-core';

function flow(stored: SecureKeyLoadResult, request: { apiKey?: string; remember: boolean }) {
  const events: string[] = [];
  const validate = vi.fn((apiKey: string) => { events.push(`validate:${apiKey}`); });
  const start = vi.fn(async (apiKey: string) => { events.push(`start:${apiKey}`); });
  const waitUntilConnected = vi.fn(async () => { events.push('connected'); });
  const disconnect = vi.fn(() => { events.push('disconnect'); });
  const persist = vi.fn(async (apiKey: string) => { events.push(`persist:${apiKey}`); return true; });
  return { events, validate, start, waitUntilConnected, disconnect, persist, options: { request, stored, validate, start, waitUntilConnected, disconnect, persist } };
}

describe('flujo transaccional de credencial del túnel', () => {
  it('persiste una clave nueva únicamente después de conexión comprobada', async () => {
    const candidate = flow({ status: 'absent' }, { apiKey: 'sk-nueva', remember: true });

    await expect(connectWithTunnelCredential(candidate.options)).resolves.toEqual({ connected: true, remembered: true });
    expect(candidate.events).toEqual(['validate:sk-nueva', 'start:sk-nueva', 'connected', 'persist:sk-nueva']);
  });

  it('no persiste y desconecta cuando la conexión falla', async () => {
    const candidate = flow({ status: 'available', value: 'sk-anterior' }, { apiKey: 'sk-invalida', remember: true });
    candidate.waitUntilConnected.mockImplementationOnce(async () => { candidate.events.push('failed'); throw new Error('TUNNEL_CONNECTION_FAILED'); });

    await expect(connectWithTunnelCredential(candidate.options)).rejects.toThrow('TUNNEL_CONNECTION_FAILED');
    expect(candidate.persist).not.toHaveBeenCalled();
    expect(candidate.disconnect).toHaveBeenCalledOnce();
    expect(candidate.events).toEqual(['validate:sk-invalida', 'start:sk-invalida', 'failed', 'disconnect']);
  });

  it('limpia el supervisor cuando el arranque falla antes de poder esperar', async () => {
    const candidate = flow({ status: 'absent' }, { apiKey: 'sk-nueva', remember: true });
    candidate.start.mockImplementationOnce(async () => { candidate.events.push('start-failed'); throw new Error('spawn failed'); });

    await expect(connectWithTunnelCredential(candidate.options)).rejects.toThrow('spawn failed');
    expect(candidate.waitUntilConnected).not.toHaveBeenCalled();
    expect(candidate.disconnect).toHaveBeenCalledOnce();
    expect(candidate.persist).not.toHaveBeenCalled();
  });

  it('conecta con la clave guardada sin devolverla ni volver a persistirla', async () => {
    const candidate = flow({ status: 'available', value: 'sk-guardada' }, { remember: true });

    const result = await connectWithTunnelCredential(candidate.options);
    expect(result).toEqual({ connected: true, remembered: true });
    expect(JSON.stringify(result)).not.toContain('sk-guardada');
    expect(candidate.persist).not.toHaveBeenCalled();
  });

  it('admite una clave efímera sin modificar una credencial anterior', async () => {
    const candidate = flow({ status: 'available', value: 'sk-anterior' }, { apiKey: 'sk-efimera', remember: false });

    await expect(connectWithTunnelCredential(candidate.options)).resolves.toEqual({ connected: true, remembered: false });
    expect(candidate.persist).not.toHaveBeenCalled();
  });

  it('mantiene la conexión y devuelve advertencia cuando el guardado falla', async () => {
    const candidate = flow({ status: 'absent' }, { apiKey: 'sk-nueva', remember: true });
    candidate.persist.mockResolvedValueOnce(false);

    await expect(connectWithTunnelCredential(candidate.options)).resolves.toEqual({
      connected: true,
      remembered: false,
      warningCode: 'KEY_STORE_WRITE_FAILED',
    });
    expect(candidate.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'absent' } as const, 'TUNNEL_KEY_REQUIRED'],
    [{ status: 'encryption-unavailable' } as const, 'KEY_STORE_ENCRYPTION_UNAVAILABLE'],
    [{ status: 'unreadable' } as const, 'KEY_STORE_UNREADABLE'],
    [{ status: 'io-error', code: 'KEY_STORE_READ_FAILED' } as const, 'KEY_STORE_READ_FAILED'],
  ])('expone un código estable cuando el estado %s no aporta credencial', async (stored, code) => {
    const candidate = flow(stored, { remember: true });

    await expect(connectWithTunnelCredential(candidate.options)).rejects.toThrow(code);
    expect(candidate.start).not.toHaveBeenCalled();
    expect(candidate.persist).not.toHaveBeenCalled();
  });
});
