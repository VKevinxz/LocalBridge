export type LocalLiveViewerTarget =
  | { readonly kind: "development"; readonly sessionId: string }
  | { readonly kind: "web"; readonly sessionId: string };

export interface LiveViewerCoordinatorOptions {
  readonly hideDevelopment: (sessionId: string) => Promise<void>;
  readonly hideWeb: (sessionId: string) => Promise<void>;
  readonly hasHumanControl: () => boolean;
  readonly onChange?: () => void;
}

export class LiveViewerCoordinatorError extends Error {
  readonly code: "HUMAN_CONTROL_ACTIVE";

  constructor() {
    super("No se puede mostrar una vista pasiva durante una intervención humana.");
    this.name = "LiveViewerCoordinatorError";
    this.code = "HUMAN_CONTROL_ACTIVE";
  }
}

function sameTarget(left: LocalLiveViewerTarget | undefined, right: LocalLiveViewerTarget): boolean {
  return left?.kind === right.kind && left.sessionId === right.sessionId;
}

/**
 * Serializa únicamente presentación local. Los controladores conservan toda la
 * autoridad, estado de sesión y cleanup de sus respectivos navegadores.
 */
export class LiveViewerCoordinator {
  private target: LocalLiveViewerTarget | undefined;
  private pendingTarget: LocalLiveViewerTarget | undefined;
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: LiveViewerCoordinatorOptions) {}

  current(): LocalLiveViewerTarget | undefined {
    return this.target;
  }

  private async hideTarget(target: LocalLiveViewerTarget): Promise<void> {
    if (target.kind === "development") await this.options.hideDevelopment(target.sessionId);
    else await this.options.hideWeb(target.sessionId);
  }

  private clearCurrent(target: LocalLiveViewerTarget): void {
    if (!sameTarget(this.target, target)) return;
    this.target = undefined;
    this.options.onChange?.();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async show(target: LocalLiveViewerTarget, display: () => Promise<void>): Promise<boolean> {
    const revision = ++this.revision;
    this.pendingTarget = target;
    const operation = this.enqueue(async () => {
      if (revision !== this.revision) return false;
      if (this.options.hasHumanControl()) throw new LiveViewerCoordinatorError();

      const previous = this.target;
      if (previous !== undefined && !sameTarget(previous, target)) {
        await this.hideTarget(previous);
        this.clearCurrent(previous);
        if (revision !== this.revision) return false;
      }
      if (this.options.hasHumanControl()) throw new LiveViewerCoordinatorError();

      try {
        await display();
      } catch (error) {
        await this.hideTarget(target).catch(() => undefined);
        this.clearCurrent(target);
        throw error;
      }
      if (revision !== this.revision || this.options.hasHumanControl()) {
        await this.hideTarget(target).catch(() => undefined);
        this.clearCurrent(target);
        if (this.options.hasHumanControl()) throw new LiveViewerCoordinatorError();
        return false;
      }
      this.target = target;
      if (revision === this.revision) this.pendingTarget = undefined;
      this.options.onChange?.();
      return true;
    });
    return operation.finally(() => {
      if (revision === this.revision && sameTarget(this.pendingTarget, target)) this.pendingTarget = undefined;
    });
  }

  async hide(target?: LocalLiveViewerTarget): Promise<void> {
    if (target !== undefined && !sameTarget(this.target, target) && !sameTarget(this.pendingTarget, target)) return;
    const revision = ++this.revision;
    this.pendingTarget = undefined;
    await this.enqueue(async () => {
      const current = this.target;
      if (current === undefined || (target !== undefined && !sameTarget(current, target))) return;
      await this.hideTarget(current);
      if (revision === this.revision) this.clearCurrent(current);
    });
  }

  /** El controlador ya ocultó o destruyó su ventana; solo invalida presentación pendiente. */
  release(target: LocalLiveViewerTarget): void {
    const releasesCurrent = sameTarget(this.target, target);
    const releasesPending = sameTarget(this.pendingTarget, target);
    if (!releasesCurrent && !releasesPending) return;
    if (releasesPending) {
      this.revision += 1;
      this.pendingTarget = undefined;
    }
    if (releasesCurrent) this.target = undefined;
    this.options.onChange?.();
  }
}
