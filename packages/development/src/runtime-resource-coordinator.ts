import { DevelopmentBrokerError } from './broker.js';

export const MAX_RUNTIME_RESOURCE_WAITERS = 64;

interface QueuedOperation<T = unknown> {
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Cola FIFO acotada por recurso del runtime Desktop. No concede autoridad ni
 * ejecuta efectos: ordena llamadas que ya pasaron el protocolo y deja que el
 * controlador vuelva a validar inmediatamente antes de actuar.
 */
export class RuntimeResourceCoordinator {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, QueuedOperation[]>();
  private waiterCount = 0;

  run<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.waiterCount >= MAX_RUNTIME_RESOURCE_WAITERS) {
      return Promise.reject(new DevelopmentBrokerError('RATE_LIMITED', 'La cola coordinada de recursos está llena.'));
    }
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(resourceId) ?? [];
      queue.push({ run: operation, resolve, reject } as QueuedOperation);
      this.queues.set(resourceId, queue);
      this.waiterCount += 1;
      this.drain(resourceId);
    });
  }

  /** Cancela solo trabajo aún no iniciado; el controlador decide sobre el activo. */
  cancelPending(prefix: string, code: 'HUMAN_CONTROL_ACTIVE' | 'SESSION_NOT_FOUND'): number {
    let cancelled = 0;
    for (const [resourceId, queue] of this.queues) {
      if (!resourceId.startsWith(prefix)) continue;
      const keepActive = this.active.has(resourceId) ? queue.splice(1) : queue.splice(0);
      for (const item of keepActive) {
        this.waiterCount -= 1;
        item.reject(new DevelopmentBrokerError(code, code === 'HUMAN_CONTROL_ACTIVE'
          ? 'La operación en espera cedió prioridad al control humano.'
          : 'La sesión se cerró antes de iniciar la operación en espera.'));
        cancelled += 1;
      }
      if (queue.length === 0) this.queues.delete(resourceId);
    }
    return cancelled;
  }

  private drain(resourceId: string): void {
    if (this.active.has(resourceId)) return;
    const queue = this.queues.get(resourceId);
    const item = queue?.[0];
    if (queue === undefined || item === undefined) {
      this.queues.delete(resourceId);
      return;
    }
    this.active.add(resourceId);
    void item.run().then(item.resolve, item.reject).finally(() => {
      this.active.delete(resourceId);
      const current = this.queues.get(resourceId);
      if (current?.[0] === item) current.shift();
      this.waiterCount = Math.max(0, this.waiterCount - 1);
      if (current?.length === 0) this.queues.delete(resourceId);
      this.drain(resourceId);
    });
  }
}

export function runtimeResourceKey(method: string, input: Readonly<Record<string, unknown>>): string | undefined {
  // La captura temporal comparte el presupuesto nativo/PNG global conservado
  // por 1.8.0; original y candidato se capturan en orden y se alinean después.
  if (method === 'browser.motion.capture' || method === 'web.motion.capture') {
    return 'motion-capture:global';
  }
  if (method.startsWith('browser.') && typeof input['sessionId'] === 'string' &&
      !['browser.human.request', 'browser.human.status', 'browser.stop'].includes(method)) {
    return `browser:${String(input['workspaceId'])}:${input['sessionId']}`;
  }
  if (method.startsWith('web.') && typeof input['sessionId'] === 'string' &&
      !['web.human.request', 'web.human.status', 'web.stop', 'web.tabs'].includes(method)) {
    // La partición/cookies pertenecen a la sesión completa; por eso dos
    // pestañas del mismo perfil se ordenan, aunque sesiones distintas avanzan.
    return `web:${input['sessionId']}`;
  }
  return undefined;
}
