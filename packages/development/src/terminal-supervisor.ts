import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import type { ProjectCatalogRecord, ProjectTrustRecord } from "@localbridge/workspace";
import { resolveSafePath } from "@localbridge/workspace";

import { DevelopmentBrokerError } from "./broker.js";
import {
  extractLocalHttpOriginHints,
  mergeLocalHttpOriginHints,
  selectTerminalBrowserOrigin,
  technicalTerminalOrigin,
} from "./terminal-origin.js";

const MAX_ACTIVE_GLOBAL = 16;
const MAX_ACTIVE_PER_PROJECT = 8;

/**
 * Una sesión terminada se conserva para que el agente pueda leer su salida
 * final, pero no para siempre: cada entrada retiene hasta `MAX_OUTPUT_BYTES`
 * (ADR-0043). Se podan por antigüedad y por número.
 */
export const FINISHED_RETENTION_MS = 30 * 60_000;
export const MAX_RETAINED_FINISHED = 24;

export interface RetainedTerminalSession {
  readonly sessionId: string;
  readonly state: TerminalState;
  /** Instante en que dejó de ejecutarse; ausente mientras sigue viva. */
  readonly finishedAtMs?: number | undefined;
}

/**
 * Sesiones terminadas que ya pueden liberarse: las que superaron la ventana de
 * retención y, si aún quedan demasiadas, las más antiguas. Nunca devuelve una
 * sesión en ejecución.
 */
export function expiredTerminalSessions(
  sessions: readonly RetainedTerminalSession[],
  nowMs: number,
  ttlMs: number = FINISHED_RETENTION_MS,
  maxRetained: number = MAX_RETAINED_FINISHED,
): string[] {
  const finished = sessions
    .filter((session) => session.state !== "running" && session.finishedAtMs !== undefined)
    .map((session) => ({ sessionId: session.sessionId, finishedAtMs: session.finishedAtMs! }))
    .toSorted((left, right) => left.finishedAtMs - right.finishedAtMs);
  const expired = new Set(finished.filter((session) => nowMs - session.finishedAtMs >= ttlMs).map((session) => session.sessionId));
  const remaining = finished.filter((session) => !expired.has(session.sessionId));
  for (const session of remaining.slice(0, Math.max(0, remaining.length - maxRetained))) expired.add(session.sessionId);
  return [...expired];
}
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 64 * 1024;
const MAX_CONTROL_BUFFER_BYTES = 16 * 1024;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const LISTENER_STALE_MS = 1_500;
const TERMINAL_SECRET_NAME = /^(?:LOCALBRIDGE_|CONTROL_PLANE_API_KEY$|ELECTRON_|NODE_OPTIONS$)/i;

export type TerminalState = "running" | "exited" | "stopped" | "revoked" | "timed_out";

export interface TerminalSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly state: TerminalState;
  readonly trustMode: "project-agent" | "full-host";
  readonly startedAt: string;
  readonly deadline: string;
  readonly nextCursor: number;
  readonly exitCode?: number;
}

export interface TerminalOutputEntry {
  readonly cursor: number;
  readonly stream: "terminal" | "diagnostic";
  readonly text: string;
}

export interface TerminalListenerSummary {
  readonly listenerRef: string;
  readonly origin: string;
  readonly addressFamily: "ipv4" | "ipv6";
  readonly bindScope: "loopback" | "wildcard";
  readonly exclusive: boolean;
  readonly port: number;
  readonly observedAt: string;
}

export interface ResolvedTerminalListener extends TerminalListenerSummary {
  readonly processId: string;
  readonly profile: string;
  readonly projectId: string;
  readonly trustMode: "project-agent" | "full-host";
  readonly technicalOrigin: string;
  readonly browserOrigin: string;
}

export interface TerminalListenerInput {
  readonly terminalSessionId: string;
  readonly listenerRef: string;
}

interface MutableListener {
  readonly listenerRef: string;
  readonly origin: string;
  readonly addressFamily: "ipv4" | "ipv6";
  readonly bindScope: "loopback" | "wildcard";
  readonly exclusive: boolean;
  readonly port: number;
  observedAtMs: number;
}

interface MutableTerminal {
  readonly sessionId: string;
  readonly projectId: string;
  readonly trustMode: "project-agent" | "full-host";
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly output: TerminalOutputEntry[];
  listeners: Map<string, MutableListener>;
  readonly closePromise: Promise<void>;
  resolveClose(): void;
  readonly readyPromise: Promise<void>;
  resolveReady(): void;
  ready: boolean;
  timer: NodeJS.Timeout;
  /** Instante en que dejó de ejecutarse; habilita la poda por retención. */
  finishedAtMs?: number;
  state: TerminalState;
  outputBytes: number;
  nextCursor: number;
  controlBuffer: string;
  originHintBuffer: string;
  readonly originHints: Map<number, Set<string>>;
  exitCode?: number;
}

export interface TerminalSupervisorOptions {
  readonly helperPath: string;
  readonly parentPid: number;
  readonly deviceBinding: string;
  readonly loadProject: (projectId: string) => Promise<ProjectCatalogRecord | undefined>;
  readonly loadTrust: (projectId: string) => Promise<ProjectTrustRecord | undefined>;
  /** Backend de aislamiento probado. Ausente implica fail-closed para project-agent. */
  readonly projectSandbox?: {
    readonly available: true;
    command(project: ProjectCatalogRecord, shell: string): Promise<readonly string[]>;
  };
  /** Señal local sin rutas ni contenido para reconciliar el grafo tras actividad. */
  readonly onProjectActivity?: (projectId: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

function brokerError(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

function noop(): void {}

function stripTerminalControls(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- elimina OSC delimitado por BEL/ST antes de exponer output.
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    // eslint-disable-next-line no-control-regex -- elimina secuencias CSI de terminal.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex -- elimina controles no imprimibles salvo tab/newline/CR.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "");
}

function terminalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !TERMINAL_SECRET_NAME.test(key)) env[key] = value;
  }
  env["LOCALBRIDGE_TERMINAL"] = "1";
  return env;
}

function defaultShell(platform: NodeJS.Platform): string {
  if (platform !== "win32") return process.env["SHELL"] ?? "/bin/sh";
  const systemRoot = process.env["SystemRoot"] ?? process.env["windir"];
  if (systemRoot === undefined) brokerError("FEATURE_UNAVAILABLE", "Windows no informó SystemRoot.");
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function summary(entry: MutableTerminal): TerminalSummary {
  return {
    sessionId: entry.sessionId,
    projectId: entry.projectId,
    state: entry.state,
    trustMode: entry.trustMode,
    startedAt: new Date(entry.startedAtMs).toISOString(),
    deadline: new Date(entry.deadlineMs).toISOString(),
    nextCursor: entry.nextCursor,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
  };
}

function listenerSummary(listener: MutableListener): TerminalListenerSummary {
  return {
    listenerRef: listener.listenerRef,
    origin: listener.origin,
    addressFamily: listener.addressFamily,
    bindScope: listener.bindScope,
    exclusive: listener.exclusive,
    port: listener.port,
    observedAt: new Date(listener.observedAtMs).toISOString(),
  };
}

export class TerminalSupervisor {
  private readonly entries = new Map<string, MutableTerminal>();
  private readonly operations = new Map<string, string>();
  private readonly writeOperations = new Map<string, { sessionId: string; digest: string; nextCursor: number }>();
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(private readonly options: TerminalSupervisorOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  /**
   * Autoridad para operar sobre una sesión que ya fue autorizada al crearse
   * (ADR-0040). No exige `state === "ready"`: leer o cerrar una sesión viva no
   * amplía autoridad, y negarlo solo deja procesos que el cliente no puede
   * recoger. Iniciar o escribir sí pasan por {@linkcode authority}.
   */
  private async sessionAuthority(projectId: string): Promise<{
    project: ProjectCatalogRecord;
    trust: ProjectTrustRecord & { mode: "project-agent" | "full-host" };
  }> {
    const project = await this.options.loadProject(projectId);
    if (project === undefined) brokerError("PROJECT_NOT_FOUND", "El proyecto no existe.");
    return this.trusted(project);
  }

  private async authority(projectId: string): Promise<{
    project: ProjectCatalogRecord;
    trust: ProjectTrustRecord & { mode: "project-agent" | "full-host" };
  }> {
    const project = await this.options.loadProject(projectId);
    if (project === undefined) brokerError("PROJECT_NOT_FOUND", "El proyecto no existe.");
    if (project.state !== "ready") brokerError("PROJECT_REVIEW_REQUIRED", "El proyecto requiere revisión local.");
    return this.trusted(project);
  }

  private async trusted(project: ProjectCatalogRecord): Promise<{
    project: ProjectCatalogRecord;
    trust: ProjectTrustRecord & { mode: "project-agent" | "full-host" };
  }> {
    const projectId = project.id;
    const trust = await this.options.loadTrust(projectId);
    if (trust === undefined || trust.status !== "active") brokerError("TERMINAL_NOT_AUTHORIZED", "La terminal no está autorizada localmente.");
    if (trust.deviceBinding !== this.options.deviceBinding) brokerError("TERMINAL_NOT_AUTHORIZED", "La confianza pertenece a otro equipo.");
    if (trust.mode === "guided") brokerError("CAPABILITY_DISABLED", "El modo Guiado no permite terminal general.");
    if (trust.mode === "project-agent" && this.options.projectSandbox?.available !== true) {
      brokerError("SANDBOX_UNAVAILABLE", "El aislamiento de proyecto no está disponible; la sesión fue denegada.");
    }
    return { project, trust: trust as ProjectTrustRecord & { mode: "project-agent" | "full-host" } };
  }

  /**
   * Libera sesiones terminadas fuera de la ventana de retención (ADR-0043). Sin
   * esto, cada terminal cerrada conservaba su búfer de salida hasta cerrar la
   * aplicación, y subir el límite de terminales habría multiplicado esa
   * retención.
   */
  private pruneFinished(): void {
    const expired = expiredTerminalSessions([...this.entries.values()], this.now());
    for (const sessionId of expired) {
      this.entries.delete(sessionId);
      for (const [key, value] of this.operations) if (value === sessionId) this.operations.delete(key);
      for (const [key, value] of this.writeOperations) if (value.sessionId === sessionId) this.writeOperations.delete(key);
    }
  }

  private entry(projectId: string, sessionId: string): MutableTerminal {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.projectId !== projectId) brokerError("TERMINAL_NOT_FOUND", "La sesión de terminal no existe.");
    return entry;
  }

  private addOutput(entry: MutableTerminal, stream: TerminalOutputEntry["stream"], chunk: Buffer): void {
    const text = stripTerminalControls(chunk.toString("utf8"));
    if (text.length === 0) return;
    entry.originHintBuffer = `${entry.originHintBuffer}${text}`.slice(-8_192);
    mergeLocalHttpOriginHints(entry.originHints, extractLocalHttpOriginHints(entry.originHintBuffer));
    const bytes = Buffer.byteLength(text);
    entry.output.push({ cursor: entry.nextCursor, stream, text });
    entry.nextCursor += bytes;
    entry.outputBytes += bytes;
    while (entry.outputBytes > MAX_OUTPUT_BYTES && entry.output.length > 1) {
      const removed = entry.output.shift();
      if (removed !== undefined) entry.outputBytes -= Buffer.byteLength(removed.text);
    }
    this.options.onProjectActivity?.(entry.projectId);
  }

  private listenerSnapshot(entry: MutableTerminal, line: string): void {
    if (line === "LBT1 READY") {
      if (!entry.ready) {
        entry.ready = true;
        entry.resolveReady();
      }
      return;
    }
    const parts = line.split(" ");
    if (parts.length < 2 || !["LBP1", "LBP2"].includes(parts[0]!) || !/^\d{1,3}$/.test(parts[1]!)) {
      entry.listeners.clear();
      return;
    }
    const count = Number(parts[1]);
    if (count > 128 || parts.length !== count + 2) {
      entry.listeners.clear();
      return;
    }
    const observedAtMs = this.now();
    const next = new Map<string, MutableListener>();
    for (const token of parts.slice(2)) {
      const legacy = parts[0] === "LBP1";
      const match = legacy ? /^(4|6):([1-9]\d{0,4})$/.exec(token) : /^(4|6)(l|w):([1-9]\d{0,4}):(0|1)$/.exec(token);
      const port = Number(match?.[legacy ? 2 : 3]);
      if (match === null || port > 65_535) {
        entry.listeners.clear();
        return;
      }
      const addressFamily = match[1] === "4" ? "ipv4" : "ipv6";
      const bindScope = legacy || match[2] === "l" ? "loopback" : "wildcard";
      const exclusive = legacy || match[4] === "1";
      const key = `${addressFamily}:${bindScope}:${port}`;
      const previous = entry.listeners.get(key);
      next.set(key, {
        listenerRef: previous?.listenerRef ?? `listener_${randomBytes(12).toString("hex")}`,
        origin: bindScope === "wildcard" ? `http://localhost:${port}` : addressFamily === "ipv4" ? `http://127.0.0.1:${port}` : `http://[::1]:${port}`,
        addressFamily,
        bindScope,
        exclusive,
        port,
        observedAtMs,
      });
    }
    entry.listeners = next;
  }

  private addControl(entry: MutableTerminal, chunk: Buffer): void {
    entry.controlBuffer += chunk.toString("ascii");
    if (Buffer.byteLength(entry.controlBuffer, "ascii") > MAX_CONTROL_BUFFER_BYTES) {
      entry.controlBuffer = "";
      entry.listeners.clear();
      return;
    }
    let newline = entry.controlBuffer.indexOf("\n");
    while (newline !== -1) {
      this.listenerSnapshot(entry, entry.controlBuffer.slice(0, newline).replace(/\r$/, ""));
      entry.controlBuffer = entry.controlBuffer.slice(newline + 1);
      newline = entry.controlBuffer.indexOf("\n");
    }
  }

  async start(projectId: string, operationId?: string): Promise<TerminalSummary> {
    const operationKey = operationId === undefined ? undefined : `${projectId}:${operationId}`;
    const previous = operationKey === undefined ? undefined : this.operations.get(operationKey);
    if (previous !== undefined) return summary(this.entry(projectId, previous));

    const { project, trust } = await this.authority(projectId);
    this.pruneFinished();
    const active = [...this.entries.values()].filter((candidate) => candidate.state === "running");
    if (active.length >= MAX_ACTIVE_GLOBAL || active.filter((candidate) => candidate.projectId === projectId).length >= MAX_ACTIVE_PER_PROJECT) {
      brokerError("RATE_LIMITED", "Se alcanzó el límite de terminales activas.");
    }
    if (this.platform !== "win32") brokerError("FEATURE_UNAVAILABLE", "El runtime de terminal v1 requiere Windows.");
    const root = await resolveSafePath(project.selectedRoot, ".");
    if (!root.exists || !(await stat(root.realPath)).isDirectory()) brokerError("PROJECT_UNAVAILABLE", "La carpeta del proyecto no está disponible.");
    const shell = defaultShell(this.platform);
    const command = trust.mode === "project-agent"
      ? await this.options.projectSandbox!.command(project, shell)
      : [
          shell,
          "-NoLogo",
          "-NoProfile",
          "-NoExit",
          "-Command",
          "$psrl=Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue;if($null -ne $psrl){Set-PSReadLineOption -HistorySaveStyle SaveNothing}",
        ];
    if (command.length === 0) brokerError("SANDBOX_UNAVAILABLE", "El sandbox no produjo un comando válido.");

    const startedAtMs = this.now();
    const sessionId = `terminal_${randomBytes(12).toString("hex")}`;
    const child = spawn(this.options.helperPath, ["--parent", String(this.options.parentPid), "--pty", "--", ...command], {
      cwd: root.realPath,
      env: terminalEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const control = child.stdio[3] as Readable | null;
    if (control === null) {
      child.kill();
      brokerError("FEATURE_UNAVAILABLE", "El canal nativo de control no está disponible.");
    }
    let resolveClose = noop;
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
    let resolveReady = noop;
    const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
    const deadlineMs = startedAtMs + MAX_SESSION_MS;
    const timer = setTimeout(() => { void this.terminate(sessionId, "timed_out"); }, MAX_SESSION_MS);
    const entry: MutableTerminal = {
      sessionId,
      projectId,
      trustMode: trust.mode,
      child,
      startedAtMs,
      deadlineMs,
      output: [],
      listeners: new Map(),
      closePromise,
      resolveClose,
      readyPromise,
      resolveReady,
      ready: false,
      timer,
      state: "running",
      outputBytes: 0,
      nextCursor: 0,
      controlBuffer: "",
      originHintBuffer: "",
      originHints: new Map(),
    };
    this.entries.set(sessionId, entry);
    if (operationKey !== undefined) this.operations.set(operationKey, sessionId);
    child.stdout.on("data", (chunk: Buffer) => this.addOutput(entry, "terminal", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.addOutput(entry, "diagnostic", chunk));
    control.on("data", (chunk: Buffer) => this.addControl(entry, chunk));
    control.on("close", () => entry.listeners.clear());
    child.once("error", () => {
      if (entry.state === "running") entry.state = "exited";
      entry.finishedAtMs ??= this.now();
      entry.exitCode = -1;
      entry.listeners.clear();
      clearTimeout(entry.timer);
      entry.resolveClose();
    });
    child.once("close", (code) => {
      if (entry.state === "running") entry.state = "exited";
      entry.finishedAtMs ??= this.now();
      entry.exitCode = code ?? -1;
      entry.listeners.clear();
      clearTimeout(entry.timer);
      entry.resolveClose();
    });
    const ready = await Promise.race([
      entry.readyPromise.then(() => true),
      entry.closePromise.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!ready) {
      await this.terminate(sessionId, "stopped");
      brokerError("TERMINAL_START_FAILED", "La pseudoconsola no quedó lista.");
    }
    // ConPTY/PowerShell descarta la primera señal de entrada mientras instala su host.
    // Un Enter vacío local sincroniza el canal antes de aceptar escritura MCP.
    await new Promise<void>((resolve, reject) => entry.child.stdin.write("\r", "utf8", (error) => error === null || error === undefined ? resolve() : reject(error)));
    await new Promise((resolve) => setTimeout(resolve, 75));
    return summary(entry);
  }

  async write(projectId: string, sessionId: string, text: string, operationId?: string): Promise<{ session: TerminalSummary; nextCursor: number }> {
    const { trust } = await this.authority(projectId);
    const entry = this.entry(projectId, sessionId);
    if (entry.state !== "running") brokerError("TERMINAL_NOT_RUNNING", "La terminal ya no está activa.");
    if (entry.trustMode !== trust.mode) brokerError("TERMINAL_NOT_AUTHORIZED", "La confianza de la sesión cambió.");
    const bytes = Buffer.byteLength(text);
    if (bytes === 0 || bytes > MAX_WRITE_BYTES) brokerError("INVALID_INPUT", "La entrada de terminal no tiene un tamaño válido.");
    const operationKey = operationId === undefined ? undefined : `${projectId}:${sessionId}:${operationId}`;
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const previous = operationKey === undefined ? undefined : this.writeOperations.get(operationKey);
    if (previous !== undefined) {
      if (previous.sessionId !== sessionId || previous.digest !== digest) brokerError("IDEMPOTENCY_CONFLICT", "El operationId ya fue usado con otra entrada.");
      return { session: summary(entry), nextCursor: previous.nextCursor };
    }
    await new Promise<void>((resolve, reject) => entry.child.stdin.write(text, "utf8", (error) => error === null || error === undefined ? resolve() : reject(error)));
    this.options.onProjectActivity?.(projectId);
    const nextCursor = entry.nextCursor;
    if (operationKey !== undefined) this.writeOperations.set(operationKey, { sessionId, digest, nextCursor });
    return { session: summary(entry), nextCursor };
  }

  async read(projectId: string, sessionId: string, cursor: number, maxBytes: number) {
    await this.sessionAuthority(projectId);
    const entry = this.entry(projectId, sessionId);
    const firstCursor = entry.output[0]?.cursor ?? entry.nextCursor;
    let used = 0;
    const output: TerminalOutputEntry[] = [];
    for (const item of entry.output) {
      const end = item.cursor + Buffer.byteLength(item.text);
      if (end <= cursor) continue;
      const bytes = Buffer.byteLength(item.text);
      if (used + bytes > maxBytes && output.length > 0) break;
      output.push(item);
      used += bytes;
    }
    return {
      session: summary(entry),
      entries: output,
      nextCursor: output.length === 0 ? Math.max(cursor, entry.nextCursor) : output.at(-1)!.cursor + Buffer.byteLength(output.at(-1)!.text),
      truncatedBeforeCursor: cursor < firstCursor,
    };
  }

  async status(projectId: string, sessionId: string): Promise<{ session: TerminalSummary; listeners: readonly TerminalListenerSummary[] }> {
    await this.sessionAuthority(projectId);
    const entry = this.entry(projectId, sessionId);
    const cutoff = this.now() - LISTENER_STALE_MS;
    return { session: summary(entry), listeners: [...entry.listeners.values()].filter((listener) => listener.observedAtMs >= cutoff).map(listenerSummary) };
  }

  async resolveListener(projectId: string, sessionId: string, listenerRef: string, workspaceId?: string): Promise<ResolvedTerminalListener> {
    const { project, trust } = await this.authority(projectId);
    if (workspaceId !== undefined && !project.compatibilityRefs.some((reference) => reference.kind === "workspace" && reference.id === workspaceId)) {
      brokerError("APPLICATION_SERVICE_MISMATCH", "La carpeta no pertenece al proyecto de esta terminal.");
    }
    const entry = this.entry(projectId, sessionId);
    if (entry.state !== "running") brokerError("TERMINAL_NOT_RUNNING", "La terminal ya no está activa.");
    const listener = [...entry.listeners.values()].find((candidate) => candidate.listenerRef === listenerRef);
    if (listener === undefined || listener.observedAtMs < this.now() - LISTENER_STALE_MS) {
      brokerError("LISTENER_STALE", "El puerto ya no pertenece a esta terminal.");
    }
    return {
      ...listenerSummary(listener),
      processId: sessionId,
      profile: "terminal",
      projectId,
      trustMode: trust.mode,
      technicalOrigin: technicalTerminalOrigin(listener),
      browserOrigin: selectTerminalBrowserOrigin(listener, entry.originHints),
    };
  }

  async resolveListeners(
    projectId: string,
    inputs: readonly TerminalListenerInput[],
    workspaceId?: string,
  ): Promise<readonly ResolvedTerminalListener[]> {
    if (inputs.length < 1 || inputs.length > 8) brokerError("INVALID_INPUT", "La colección de listeners no tiene un tamaño válido.");
    const keys = inputs.map((input) => `${input.terminalSessionId}:${input.listenerRef}`);
    if (new Set(keys).size !== keys.length) brokerError("PROJECT_BROWSER_LISTENER_MISMATCH", "Los listeners del proyecto deben ser únicos.");
    return Promise.all(inputs.map((input) => this.resolveListener(
      projectId,
      input.terminalSessionId,
      input.listenerRef,
      workspaceId,
    )));
  }

  async stop(projectId: string, sessionId: string): Promise<TerminalSummary> {
    await this.sessionAuthority(projectId);
    await this.terminate(sessionId, "stopped");
    return summary(this.entry(projectId, sessionId));
  }

  listAll(): readonly TerminalSummary[] {
    return [...this.entries.values()].map(summary);
  }

  async reconcile(): Promise<void> {
    await Promise.all([...this.entries.values()].filter((entry) => entry.state === "running").map(async (entry) => {
      const project = await this.options.loadProject(entry.projectId).catch(() => undefined);
      const trust = await this.options.loadTrust(entry.projectId).catch(() => undefined);
      if (project?.state !== "ready" || trust?.status !== "active" || trust.deviceBinding !== this.options.deviceBinding || trust.mode !== entry.trustMode) {
        await this.terminate(entry.sessionId, "revoked");
      }
    }));
  }

  private async terminate(sessionId: string, state: TerminalState): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.state !== "running") return;
    entry.state = state;
    entry.finishedAtMs ??= this.now();
    entry.listeners.clear();
    entry.child.kill();
    await entry.closePromise;
    // Al cerrar el host, KILL_ON_JOB_CLOSE termina el árbol de forma asíncrona.
    // Esperar brevemente evita devolver control mientras un cwd todavía está bloqueado.
    if (this.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 125));
  }

  async stopProject(projectId: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter((entry) => entry.projectId === projectId && entry.state === "running")
      .map((entry) => this.terminate(entry.sessionId, "revoked")));
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].filter((entry) => entry.state === "running")
      .map((entry) => this.terminate(entry.sessionId, "stopped")));
  }
}
