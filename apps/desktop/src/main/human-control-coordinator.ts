export type HumanControlTarget =
  | { readonly kind: "development"; readonly sessionId: string }
  | { readonly kind: "web"; readonly sessionId: string };

export class HumanControlCoordinatorError extends Error {
  readonly code = "HUMAN_CONTROL_BUSY" as const;

  constructor() {
    super("Ya existe otra intervención humana activa.");
    this.name = "HumanControlCoordinatorError";
  }
}

function sameTarget(left: HumanControlTarget | undefined, right: HumanControlTarget): boolean {
  return left?.kind === right.kind && left.sessionId === right.sessionId;
}

/** Reserva local síncrona. No concede autoridad: cada controlador la revalida. */
export class HumanControlCoordinator {
  private target: HumanControlTarget | undefined;

  current(): HumanControlTarget | undefined {
    return this.target;
  }

  reserve(target: HumanControlTarget): void {
    if (this.target !== undefined && !sameTarget(this.target, target)) {
      throw new HumanControlCoordinatorError();
    }
    this.target = target;
  }

  release(target: HumanControlTarget): void {
    if (sameTarget(this.target, target)) this.target = undefined;
  }
}
