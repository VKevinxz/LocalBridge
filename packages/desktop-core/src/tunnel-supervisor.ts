/**
 * Ciclo de vida de `tunnel-client` desde la UI de escritorio (ADR-0015, UI-3).
 *
 * Mismo patrón que `packages/validation`: la clave (`CONTROL_PLANE_API_KEY`) se
 * pasa como variable de entorno al proceso hijo, nunca se escribe a disco ni se
 * registra — igual que ya se hacía a mano por PowerShell. `disconnect()` mata el
 * **árbol completo**, no solo `tunnel-client`: ese binario arranca nuestro propio
 * servidor autocontenido (Node privado + bundle CommonJS) como hijo, y un `kill` de un solo
 * nivel dejaría ese proceso huérfano corriendo indefinidamente.
 *
 * El E2E real de la Fase 6 mostró que `tunnel-client` puede morir en silencio
 * (ventana cerrada, equipo dormido) sin ningún error visible — por eso este
 * módulo escucha el evento `exit` del hijo en vez de asumir que sigue vivo hasta
 * que alguien pulse "Desconectar": el estado que reporta siempre refleja lo que
 * de verdad está corriendo, no lo que se pidió que corriera.
 *
 * **Reconexión automática (19/08/2026):** en uso real, `tunnel-client` (binario
 * de terceros, actualmente fijado en v0.0.12) puede morir solo tras varios minutos de trabajo normal
 * — sin que el servidor local ni nuestro código tengan nada que ver, verificado
 * contra la auditoría real (`audit.db`) en una sesión real con Codex. Antes de
 * este cambio, el único remedio era que un humano notara el estado "error" y
 * pulsara "Conectar" a mano. Ahora, si el hijo llevaba vivo al menos
 * {@linkcode MIN_UPTIME_FOR_AUTO_RECONNECT_MS} antes de morir (señal de que sí
 * llegó a funcionar, no que la configuración está rota), se reintenta solo,
 * hasta {@linkcode MAX_AUTO_RECONNECT_ATTEMPTS} veces con una espera fija entre
 * intentos. Un fallo casi inmediato (binario mal configurado, perfil
 * inexistente) **nunca** se reintenta solo — reintentar eso en bucle no
 * arreglaría nada y ocultaría el error real. El contador de intentos se
 * reinicia en cuanto se alcanza `"connected"` de verdad, para que una caída
 * mucho más tarde tenga su propio presupuesto de reintentos completo.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { buildFilteredEnv, killProcessTree, type GitApprovalMode } from "@localbridge/shared";

export type TunnelStatus = "disconnected" | "connecting" | "connected" | "error";

export type TunnelConnectionWaitCode =
  | "TUNNEL_CONNECTION_FAILED"
  | "TUNNEL_CONNECTION_CANCELLED"
  | "TUNNEL_CONNECTION_TIMEOUT";

export class TunnelConnectionWaitError extends Error {
  constructor(readonly code: TunnelConnectionWaitCode) {
    super(code);
    this.name = "TunnelConnectionWaitError";
  }
}

/** Tiempo mínimo vivo para tratar una muerte como caída transitoria en vez de configuración rota. */
export const MIN_UPTIME_FOR_AUTO_RECONNECT_MS = 10_000;
/** Reintentos automáticos antes de rendirse y dejar el estado en "error". */
export const MAX_AUTO_RECONNECT_ATTEMPTS = 5;
/** Espera fija entre un intento y el siguiente. */
export const AUTO_RECONNECT_DELAY_MS = 5_000;

export interface TunnelConnectOptions {
  /** Ruta absoluta al ejecutable de `tunnel-client`. */
  readonly binaryPath: string;
  readonly profile: string;
  readonly profileDir: string;
  /** `cwd` del hijo; el perfil administrado usa rutas absolutas a sus recursos incluidos. */
  readonly cwd: string;
  /** Nunca se persiste ni se registra; solo vive en el entorno del proceso hijo. */
  readonly apiKey: string;
  /** Se reenvía sólo al servidor LocalBridge hijo; no concede permisos de workspace. */
  readonly gitApprovalMode: GitApprovalMode;
  /** Credenciales efímeras del broker privado; nunca se persisten ni registran. */
  readonly developmentBrokerEndpoint?: string;
  readonly developmentBrokerToken?: string;
  /** Worker PDF empaquetado; solo el proceso local decide esta ruta. */
  readonly documentWorkerPath?: string;
}

export interface TunnelSupervisorCallbacks {
  readonly onStatusChange?: (status: TunnelStatus, detail?: string) => void;
  readonly onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

/** Inyectable para tests — evita spawnear un `tunnel-client.exe` real. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const CONNECTED_MARKER = "tunnel-client started";

export interface TunnelSupervisorDeps {
  readonly spawnFn?: SpawnFn;
  readonly killTreeFn?: (child: { pid?: number | undefined }, isWindows: boolean) => void;
  readonly isWindows?: boolean;
  /** Inyectables para tests deterministas de la reconexión automática. */
  readonly nowFn?: () => number;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimeoutFn?: (timer: NodeJS.Timeout) => void;
}

export class TunnelSupervisor {
  private child: ChildProcess | undefined;
  private status: TunnelStatus = "disconnected";
  private readonly spawnFn: SpawnFn;
  private readonly killTreeFn: (child: { pid?: number | undefined }, isWindows: boolean) => void;
  private readonly isWindows: boolean;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (timer: NodeJS.Timeout) => void;

  /** Últimas opciones usadas — hacen falta para poder reintentar sin que el llamante las repita. */
  private lastConnectOptions: TunnelConnectOptions | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly connectionWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: TunnelConnectionWaitError) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly callbacks: TunnelSupervisorCallbacks = {},
    deps: TunnelSupervisorDeps = {},
  ) {
    this.spawnFn = deps.spawnFn ?? (spawn as SpawnFn);
    this.killTreeFn = deps.killTreeFn ?? killProcessTree;
    this.isWindows = deps.isWindows ?? process.platform === "win32";
    this.nowFn = deps.nowFn ?? Date.now;
    this.setTimeoutFn = deps.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  }

  getStatus(): TunnelStatus {
    return this.status;
  }

  getEffectiveGitApprovalMode(): GitApprovalMode | undefined {
    return this.status === "connecting" || this.status === "connected"
      ? this.lastConnectOptions?.gitApprovalMode
      : undefined;
  }

  waitForConnection(timeoutMs = 45_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("timeout de conexión fuera de rango");
    }
    if (this.status === "connected") return Promise.resolve();
    if (this.status === "error") return Promise.reject(new TunnelConnectionWaitError("TUNNEL_CONNECTION_FAILED"));
    if (this.status !== "connecting") return Promise.reject(new TunnelConnectionWaitError("TUNNEL_CONNECTION_CANCELLED"));

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: this.setTimeoutFn(() => {
          this.connectionWaiters.delete(waiter);
          reject(new TunnelConnectionWaitError("TUNNEL_CONNECTION_TIMEOUT"));
        }, timeoutMs),
      };
      this.connectionWaiters.add(waiter);
    });
  }

  connect(options: TunnelConnectOptions): void {
    if (this.status === "connecting" || this.status === "connected") {
      throw new Error(`ya hay una conexión en curso (estado: ${this.status})`);
    }

    this.lastConnectOptions = options;
    this.reconnectAttempt = 0;
    this.startProcess(options);
  }

  /** No-op si ya está desconectado — desconectar dos veces no es un error. */
  disconnect(): void {
    if (this.reconnectTimer !== undefined) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.child === undefined) {
      this.lastConnectOptions = undefined;
      this.setStatus("disconnected");
      return;
    }

    this.killTreeFn(this.child, this.isWindows);
    this.child = undefined;
    this.lastConnectOptions = undefined;
    this.setStatus("disconnected");
  }

  private startProcess(options: TunnelConnectOptions): void {
    this.setStatus("connecting");
    const startedAt = this.nowFn();

    const child = this.spawnFn(
      options.binaryPath,
      ["run", "--profile", options.profile, "--profile-dir", options.profileDir],
      {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        // Igual que en el runner de validaciones: en POSIX el hijo lidera su
        // propio grupo de procesos para poder matar el árbol entero al
        // desconectar; en Windows no hace falta (se usa `taskkill /T`).
        detached: !this.isWindows,
        env: buildFilteredEnv(
          {
            CONTROL_PLANE_API_KEY: options.apiKey,
            LOCALBRIDGE_GIT_APPROVAL_MODE: options.gitApprovalMode,
            ...(options.documentWorkerPath === undefined
              ? {}
              : { LOCALBRIDGE_DOCUMENT_WORKER_PATH: options.documentWorkerPath }),
            ...(options.developmentBrokerEndpoint === undefined || options.developmentBrokerToken === undefined
              ? {}
              : {
                  LOCALBRIDGE_DEVELOPMENT_BROKER_ENDPOINT: options.developmentBrokerEndpoint,
                  LOCALBRIDGE_DEVELOPMENT_BROKER_TOKEN: options.developmentBrokerToken,
                }),
          },
          // Directorios convencionales que el binario de túnel y Cloudflare
          // pueden consultar; ninguna credencial ajena se hereda por defecto.
          ["APPDATA", "LOCALAPPDATA"],
        ),
      },
    );
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.handleOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => this.handleOutput(chunk, "stderr"));

    child.on("error", (error) => {
      this.child = undefined;
      this.lastConnectOptions = undefined;
      this.setStatus("error", error.message);
    });

    child.on("exit", (code, signal) => {
      this.child = undefined;
      // Un cierre pedido explícitamente (`disconnect()`) ya puso el estado en
      // "disconnected" antes de matar el árbol; si llegamos aquí desde
      // "connecting"/"connected" es que el proceso murió por su cuenta.
      if (this.status !== "connecting" && this.status !== "connected") return;

      const aliveMs = this.nowFn() - startedAt;
      const canRetry = aliveMs >= MIN_UPTIME_FOR_AUTO_RECONNECT_MS && this.reconnectAttempt < MAX_AUTO_RECONNECT_ATTEMPTS;

      if (canRetry) {
        this.reconnectAttempt += 1;
        this.setStatus(
          "connecting",
          `tunnel-client se cayó (code=${code ?? "null"}, signal=${signal ?? "null"}); reconectando automáticamente (intento ${this.reconnectAttempt}/${MAX_AUTO_RECONNECT_ATTEMPTS})…`,
        );
        this.reconnectTimer = this.setTimeoutFn(() => {
          this.reconnectTimer = undefined;
          if (this.lastConnectOptions !== undefined) this.startProcess(this.lastConnectOptions);
        }, AUTO_RECONNECT_DELAY_MS);
        return;
      }

      const reason =
        aliveMs < MIN_UPTIME_FOR_AUTO_RECONNECT_MS
          ? `tunnel-client terminó inesperadamente (code=${code ?? "null"}, signal=${signal ?? "null"})`
          : `tunnel-client terminó inesperadamente tras ${this.reconnectAttempt} reintento(s) automático(s) fallido(s) (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.lastConnectOptions = undefined;
      this.setStatus("error", reason);
    });
  }

  private handleOutput(chunk: Buffer, stream: "stdout" | "stderr"): void {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.callbacks.onLog?.(trimmed, stream);
      if (this.status === "connecting" && trimmed.includes(CONNECTED_MARKER)) {
        this.setStatus("connected");
        // Conexión sostenida de verdad: una caída futura merece su propio
        // presupuesto de reintentos completo, no lo que quedara de antes.
        this.reconnectAttempt = 0;
      }
    }
  }

  private setStatus(status: TunnelStatus, detail?: string): void {
    this.status = status;
    if (status === "connected" || status === "error" || status === "disconnected") {
      const waiters = [...this.connectionWaiters];
      this.connectionWaiters.clear();
      for (const waiter of waiters) {
        this.clearTimeoutFn(waiter.timer);
        if (status === "connected") waiter.resolve();
        else waiter.reject(new TunnelConnectionWaitError(
          status === "error" ? "TUNNEL_CONNECTION_FAILED" : "TUNNEL_CONNECTION_CANCELLED",
        ));
      }
    }
    this.callbacks.onStatusChange?.(status, detail);
  }
}
