export interface MutationOptions {
  /** Mantiene autoridad y efecto dentro de la misma sección crítica. */
  readonly withAuthorizedEffect?: <T>(effect: () => Promise<T>) => Promise<T>;
}

export function runAuthorizedEffect<T>(options: MutationOptions, effect: () => Promise<T>): Promise<T> {
  return options.withAuthorizedEffect?.(effect) ?? effect();
}
