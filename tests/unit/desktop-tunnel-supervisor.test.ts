import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  TunnelSupervisor,
  MIN_UPTIME_FOR_AUTO_RECONNECT_MS,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  type SpawnFn,
} from '@localbridge/desktop-core';

/** Doble mínimo de `ChildProcess`: mismo contrato de eventos que usa el supervisor. */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4242;
}

const CONNECT_OPTIONS = {
  binaryPath: 'C:\\tunnel-client.exe',
  profile: 'local-stdio',
  profileDir: 'C:\\Users\\example-user\\.config\\tunnel-client',
  cwd: 'D:\\Proyectos\\MCP',
  apiKey: 'sk-test-no-es-real',
  gitApprovalMode: 'mrtr' as const,
};

/**
 * Reloj y temporizadores controlables a mano: `advanceTime` mueve el reloj que
 * lee `nowFn` (para simular cuánto vivió el proceso antes de morir) y
 * `fireScheduledTimers` dispara los callbacks agendados por `setTimeoutFn`
 * (para simular que llegó el momento del reintento) — determinista, sin
 * depender de temporizadores reales ni de `vi.useFakeTimers()`.
 */
function makeSupervisor() {
  const children: FakeChildProcess[] = [];
  const spawnFn = vi.fn<SpawnFn>(() => {
    const child = new FakeChildProcess();
    children.push(child);
    return child as never;
  });
  const killTreeFn = vi.fn();
  const onStatusChange = vi.fn();
  const onLog = vi.fn();

  let currentTime = 0;
  const nowFn = vi.fn(() => currentTime);

  interface ScheduledTimer {
    callback: () => void;
    id: NodeJS.Timeout;
  }
  const timers: ScheduledTimer[] = [];
  const setTimeoutFn = vi.fn((callback: () => void, _ms: number) => {
    const id = {} as NodeJS.Timeout;
    timers.push({ callback, id });
    return id;
  });
  const clearTimeoutFn = vi.fn((id: NodeJS.Timeout) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index !== -1) timers.splice(index, 1);
  });

  const supervisor = new TunnelSupervisor(
    { onStatusChange, onLog },
    { spawnFn, killTreeFn, isWindows: true, nowFn, setTimeoutFn, clearTimeoutFn },
  );

  return {
    supervisor,
    get fakeChild() {
      return children[0]!;
    },
    children,
    spawnFn,
    killTreeFn,
    onStatusChange,
    onLog,
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    /** Dispara todos los timers pendientes (agendados vía `setTimeoutFn`) tal cual están ahora. */
    fireScheduledTimers: () => {
      const due = [...timers];
      timers.length = 0;
      for (const timer of due) timer.callback();
    },
    pendingTimerCount: () => timers.length,
  };
}

/** Lleva un hijo desde spawn hasta "connected" y luego lo mata tras `aliveMs` de vida simulada. */
function connectThenKill(
  ctx: ReturnType<typeof makeSupervisor>,
  child: FakeChildProcess,
  aliveMs: number,
  exitCode: number | null = 1,
): void {
  child.stdout.emit('data', Buffer.from('🟢 tunnel-client started\n'));
  ctx.advanceTime(aliveMs);
  child.emit('exit', exitCode, null);
}

/**
 * Mata un hijo tras `aliveMs` de vida **sin** que llegue a imprimir la línea de
 * arranque — a diferencia de {@linkcode connectThenKill}, esto NO reinicia el
 * contador de reintentos (ese reinicio solo ocurre al alcanzar "connected" de
 * verdad). Simula un reintento que vivió un rato pero nunca llegó a conectar.
 */
function killWithoutConnecting(ctx: ReturnType<typeof makeSupervisor>, child: FakeChildProcess, aliveMs: number, exitCode: number | null = 1): void {
  ctx.advanceTime(aliveMs);
  child.emit('exit', exitCode, null);
}

describe('TunnelSupervisor.connect', () => {
  it('pasa la clave por entorno, nunca en los argumentos del proceso', () => {
    const { supervisor, spawnFn } = makeSupervisor();

    supervisor.connect(CONNECT_OPTIONS);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnFn.mock.calls[0]!;
    expect(binary).toBe(CONNECT_OPTIONS.binaryPath);
    expect(args.join(' ')).not.toContain(CONNECT_OPTIONS.apiKey);
    expect(args).toEqual(['run', '--profile', 'local-stdio', '--profile-dir', CONNECT_OPTIONS.profileDir]);
    expect((options.env as Record<string, string>)['CONTROL_PLANE_API_KEY']).toBe(CONNECT_OPTIONS.apiKey);
    expect((options.env as Record<string, string>)['LOCALBRIDGE_GIT_APPROVAL_MODE']).toBe('mrtr');
    expect(options.cwd).toBe(CONNECT_OPTIONS.cwd);
    expect(options.shell).toBe(false);
  });

  it('filtra secretos ajenos del entorno del proceso padre', () => {
    const previous = process.env['LOCALBRIDGE_TEST_PARENT_SECRET'];
    process.env['LOCALBRIDGE_TEST_PARENT_SECRET'] = 'no-debe-llegar-al-tunel';

    try {
      const { supervisor, spawnFn } = makeSupervisor();
      supervisor.connect(CONNECT_OPTIONS);

      const options = spawnFn.mock.calls[0]![2];
      expect((options.env as NodeJS.ProcessEnv)['LOCALBRIDGE_TEST_PARENT_SECRET']).toBeUndefined();
      expect((options.env as NodeJS.ProcessEnv)['CONTROL_PLANE_API_KEY']).toBe(CONNECT_OPTIONS.apiKey);
    } finally {
      if (previous === undefined) delete process.env['LOCALBRIDGE_TEST_PARENT_SECRET'];
      else process.env['LOCALBRIDGE_TEST_PARENT_SECRET'] = previous;
    }
  });

  it('pasa a "connecting" de inmediato', () => {
    const { supervisor, onStatusChange } = makeSupervisor();

    supervisor.connect(CONNECT_OPTIONS);

    expect(supervisor.getStatus()).toBe('connecting');
    expect(supervisor.getEffectiveGitApprovalMode()).toBe('mrtr');
    expect(onStatusChange).toHaveBeenCalledWith('connecting', undefined);
  });

  it('pasa a "connected" cuando el hijo imprime la línea de arranque de tunnel-client', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);

    ctx.fakeChild.stdout.emit('data', Buffer.from('{"msg":"🟢 tunnel-client started","tunnel_id":"t_1"}\n'));

    expect(ctx.supervisor.getStatus()).toBe('connected');
    expect(ctx.onStatusChange).toHaveBeenCalledWith('connected', undefined);
  });

  it('resuelve la espera acotada únicamente al alcanzar connected', async () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    const connected = ctx.supervisor.waitForConnection();

    ctx.fakeChild.stdout.emit('data', Buffer.from('🟢 tunnel-client started\n'));

    await expect(connected).resolves.toBeUndefined();
    expect(ctx.pendingTimerCount()).toBe(0);
  });

  it('rechaza la espera si el proceso falla antes de conectar', async () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    const connected = ctx.supervisor.waitForConnection();

    ctx.fakeChild.emit('exit', 1, null);

    await expect(connected).rejects.toMatchObject({
      code: 'TUNNEL_CONNECTION_FAILED',
    });
  });

  it('cancela la espera y olvida la clave en memoria al desconectar', async () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    const connected = ctx.supervisor.waitForConnection();

    ctx.supervisor.disconnect();

    await expect(connected).rejects.toMatchObject({
      code: 'TUNNEL_CONNECTION_CANCELLED',
    });
    expect(ctx.supervisor.getEffectiveGitApprovalMode()).toBeUndefined();
  });

  it('expira una espera sin atribuir una conexión no observada', async () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    const connected = ctx.supervisor.waitForConnection(1_000);

    ctx.fireScheduledTimers();

    await expect(connected).rejects.toMatchObject({
      code: 'TUNNEL_CONNECTION_TIMEOUT',
    });
  });

  it('reenvía cada línea de stdout/stderr a onLog', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);

    ctx.fakeChild.stdout.emit('data', Buffer.from('linea uno\nlinea dos\n'));
    ctx.fakeChild.stderr.emit('data', Buffer.from('un error\n'));

    expect(ctx.onLog).toHaveBeenCalledWith('linea uno', 'stdout');
    expect(ctx.onLog).toHaveBeenCalledWith('linea dos', 'stdout');
    expect(ctx.onLog).toHaveBeenCalledWith('un error', 'stderr');
  });

  it('un segundo connect() mientras ya hay uno en curso lanza, no spawnea dos veces', () => {
    const { supervisor, spawnFn } = makeSupervisor();
    supervisor.connect(CONNECT_OPTIONS);

    expect(() => supervisor.connect(CONNECT_OPTIONS)).toThrow();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('un fallo casi inmediato (código roto, no una caída transitoria) pasa a "error" sin reintentar solo', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    ctx.fakeChild.stdout.emit('data', Buffer.from('🟢 tunnel-client started\n'));
    expect(ctx.supervisor.getStatus()).toBe('connected');

    // Sin avanzar el reloj: murió casi al instante de "conectar".
    ctx.fakeChild.emit('exit', 1, null);

    expect(ctx.supervisor.getStatus()).toBe('error');
    expect(ctx.onStatusChange).toHaveBeenCalledWith('error', expect.stringContaining('code=1'));
    expect(ctx.spawnFn).toHaveBeenCalledTimes(1); // nunca reintentó
  });

  it('un fallo al arrancar el binario (evento "error") pasa a estado "error"', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);

    ctx.fakeChild.emit('error', new Error('ENOENT'));

    expect(ctx.supervisor.getStatus()).toBe('error');
  });
});

describe('TunnelSupervisor — reconexión automática', () => {
  it('si el hijo llevaba vivo lo suficiente antes de morir, reintenta solo tras la espera', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    connectThenKill(ctx, ctx.fakeChild, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);

    // Todavía no reintentó: el estado dice que va a reconectar, pero el timer no ha disparado.
    expect(ctx.supervisor.getStatus()).toBe('connecting');
    expect(ctx.onStatusChange).toHaveBeenCalledWith('connecting', expect.stringContaining('reconectando automáticamente'));
    expect(ctx.spawnFn).toHaveBeenCalledTimes(1);

    ctx.fireScheduledTimers();

    expect(ctx.spawnFn).toHaveBeenCalledTimes(2);
    expect(ctx.supervisor.getStatus()).toBe('connecting');
  });

  it('tras reconectar solo, un "tunnel-client started" del nuevo hijo vuelve a dejarlo en "connected"', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    connectThenKill(ctx, ctx.fakeChild, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);
    ctx.fireScheduledTimers();

    expect(ctx.children).toHaveLength(2);
    ctx.children[1]!.stdout.emit('data', Buffer.from('🟢 tunnel-client started\n'));

    expect(ctx.supervisor.getStatus()).toBe('connected');
  });

  it('se rinde tras agotar el máximo de reintentos y queda en "error"', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);

    // Ninguno de los reintentos llega a "connected" de verdad — si lo hicieran,
    // reiniciarían el contador (ver el test de reinicio) y nunca se agotaría.
    for (let attempt = 0; attempt < MAX_AUTO_RECONNECT_ATTEMPTS; attempt += 1) {
      const child = ctx.children[ctx.children.length - 1]!;
      killWithoutConnecting(ctx, child, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);
      expect(ctx.supervisor.getStatus()).toBe('connecting'); // va a reintentar
      ctx.fireScheduledTimers();
    }

    // Se agotaron los reintentos: el último hijo también muere tras vivir lo suficiente,
    // pero ya no queda presupuesto.
    const lastChild = ctx.children[ctx.children.length - 1]!;
    killWithoutConnecting(ctx, lastChild, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);

    expect(ctx.supervisor.getStatus()).toBe('error');
    expect(ctx.onStatusChange).toHaveBeenCalledWith('error', expect.stringContaining('reintento'));
    expect(ctx.spawnFn).toHaveBeenCalledTimes(MAX_AUTO_RECONNECT_ATTEMPTS + 1);
  });

  it('una conexión sostenida (llega a "connected" de verdad) reinicia el contador de reintentos', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);

    // Agota los reintentos, sin que ninguno llegue a "connected" de verdad.
    for (let attempt = 0; attempt < MAX_AUTO_RECONNECT_ATTEMPTS; attempt += 1) {
      const child = ctx.children[ctx.children.length - 1]!;
      killWithoutConnecting(ctx, child, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);
      ctx.fireScheduledTimers();
    }

    // Confirma que el presupuesto realmente se agotó antes de seguir.
    const exhaustedChild = ctx.children[ctx.children.length - 1]!;
    killWithoutConnecting(ctx, exhaustedChild, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);
    expect(ctx.supervisor.getStatus()).toBe('error');

    // El usuario reconecta a mano (como haría al ver "error") y esta vez sí llega a "connected".
    ctx.supervisor.connect(CONNECT_OPTIONS);
    const revivedChild = ctx.children[ctx.children.length - 1]!;
    revivedChild.stdout.emit('data', Buffer.from('🟢 tunnel-client started\n'));
    expect(ctx.supervisor.getStatus()).toBe('connected');

    // Muere de nuevo tras una vida larga: como hubo una conexión sostenida real
    // después de agotar el presupuesto, el contador se reinició — debería poder
    // reintentar de nuevo en vez de rendirse de inmediato.
    ctx.advanceTime(MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);
    revivedChild.emit('exit', 1, null);

    expect(ctx.supervisor.getStatus()).toBe('connecting');
    expect(ctx.onStatusChange).toHaveBeenLastCalledWith('connecting', expect.stringContaining('intento 1/'));
  });

  it('disconnect() durante la espera de un reintento cancela el reintento, nunca reconecta', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    connectThenKill(ctx, ctx.fakeChild, MIN_UPTIME_FOR_AUTO_RECONNECT_MS + 1000);
    expect(ctx.pendingTimerCount()).toBe(1);

    ctx.supervisor.disconnect();

    expect(ctx.pendingTimerCount()).toBe(0);
    expect(ctx.supervisor.getStatus()).toBe('disconnected');

    // Aunque alguien dispare el timer de todas formas (no debería quedar ninguno), no reconecta.
    ctx.fireScheduledTimers();
    expect(ctx.spawnFn).toHaveBeenCalledTimes(1);
    expect(ctx.supervisor.getStatus()).toBe('disconnected');
  });
});

describe('TunnelSupervisor.disconnect', () => {
  it('mata el árbol completo del proceso, no solo el proceso de primer nivel', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    ctx.fakeChild.stdout.emit('data', Buffer.from('🟢 tunnel-client started\n'));

    ctx.supervisor.disconnect();

    expect(ctx.killTreeFn).toHaveBeenCalledWith(ctx.fakeChild, true);
    expect(ctx.supervisor.getStatus()).toBe('disconnected');
  });

  it('un exit tardío del hijo después de disconnect() no revierte a "error"', () => {
    const ctx = makeSupervisor();
    ctx.supervisor.connect(CONNECT_OPTIONS);
    ctx.supervisor.disconnect();

    ctx.fakeChild.emit('exit', null, 'SIGKILL');

    expect(ctx.supervisor.getStatus()).toBe('disconnected');
  });

  it('desconectar sin haber conectado nunca no lanza', () => {
    const { supervisor, killTreeFn } = makeSupervisor();

    expect(() => supervisor.disconnect()).not.toThrow();
    expect(killTreeFn).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toBe('disconnected');
    expect(supervisor.getEffectiveGitApprovalMode()).toBeUndefined();
  });
});
