/**
 * Mutex en memoria por clave (ADR-0013). Serializa operaciones sobre la misma
 * clave dentro de este proceso — no persiste, no se comparte entre procesos
 * (eso es trabajo de los *claims* de la v2, ADR-0010).
 *
 * Genérico a propósito: lo usan tanto la escritura de archivos
 * (`packages/filesystem`, clave `workspaceId:relativePath`) como las
 * validaciones (`packages/validation`, clave por workspace) — la mecánica de
 * "encolar detrás del anterior" es idéntica en ambos casos, solo cambia qué
 * significa la clave para cada llamante.
 */

const locks = new Map<string, Promise<void>>();

export async function withMutationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();

  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  locks.set(key, current);

  await previous;

  try {
    return await fn();
  } finally {
    releaseCurrent();
    // Si nadie más encadenó detrás de nosotros mientras corríamos, liberamos la
    // entrada — si no, dejarla es responsabilidad de quien la reemplazó.
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

export function mutationLockKey(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath}`;
}
