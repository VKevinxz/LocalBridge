import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { verifyProcessProfile } from '@localbridge/desktop-core';
import { buildFilteredEnv } from '@localbridge/shared';
import { resolveSafePath, type AuthorizedWorkspace } from '@localbridge/workspace';

import { DevelopmentBrokerError } from './broker.js';

const MAX_RUNNING_GLOBAL = 16;
const MAX_RUNNING_PER_WORKSPACE = 8;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_CONTROL_BUFFER_BYTES = 16 * 1024;
const LISTENER_STALE_MS = 1_500;
const noop = (): void => {};

const WINDOWS_PROFILE_LAUNCHER = String.raw`
const {spawn}=require('node:child_process');
const {existsSync}=require('node:fs');
const path=require('node:path');
const command=JSON.parse(process.argv[1]);
const binary=command[0];
const explicit=path.extname(binary).toLowerCase();
const dirs=(process.env.PATH||process.env.Path||'').split(path.delimiter);
const shim=explicit==='.cmd'||explicit==='.bat'||(explicit===''&&!/[\\/]/.test(binary)&&dirs.some((dir)=>dir&&(existsSync(path.join(dir,binary+'.cmd'))||existsSync(path.join(dir,binary+'.bat')))));
const child=spawn(binary,command.slice(1),{stdio:'inherit',shell:shim,windowsHide:true});
child.once('error',()=>{process.exitCode=70;});
child.once('exit',(code)=>{process.exitCode=code===null?70:code;});
`;

export type ProcessState = 'running' | 'exited' | 'stopped' | 'timed_out';

export interface ProcessSummary {
  readonly processId: string;
  readonly profile: string;
  readonly state: ProcessState;
  readonly startedAt: string;
  readonly deadline: string;
  readonly exitCode?: number | undefined;
}

export interface ProcessLogEntry {
  readonly cursor: number;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface ProcessListenerSummary {
  readonly listenerRef: string;
  readonly origin: string;
  readonly addressFamily: 'ipv4' | 'ipv6';
  readonly bindScope: 'loopback' | 'wildcard';
  /** Ningún listener loopback/wildcard compatible del mismo puerto pertenece a otro proceso. */
  readonly exclusive: boolean;
  readonly port: number;
  readonly observedAt: string;
}

export interface ResolvedProcessListener extends ProcessListenerSummary {
  readonly processId: string;
  readonly profile: string;
}

interface MutableProcessListener {
  readonly listenerRef: string;
  readonly origin: string;
  readonly addressFamily: 'ipv4' | 'ipv6';
  readonly bindScope: 'loopback' | 'wildcard';
  readonly exclusive: boolean;
  readonly port: number;
  observedAtMs: number;
}

interface MutableProcess {
  readonly processId: string;
  readonly workspaceId: string;
  readonly profile: string;
  readonly profileFingerprint: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly logs: ProcessLogEntry[];
  readonly closePromise: Promise<void>;
  resolveClose(): void;
  timer: NodeJS.Timeout;
  state: ProcessState;
  exitCode?: number | undefined;
  logBytes: number;
  nextCursor: number;
  controlBuffer: string;
  listeners: Map<string, MutableProcessListener>;
}

export interface ProcessSupervisorOptions {
  readonly helperPath: string;
  /** Node autocontenido controlado por Electron; nunca `process.execPath` en producción. */
  readonly nodeBinaryPath: string;
  readonly parentPid: number;
  readonly loadWorkspace: (workspaceId: string) => Promise<AuthorizedWorkspace | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly reconciliationIntervalMs?: number;
}

function brokerError(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

function summary(entry: MutableProcess): ProcessSummary {
  return {
    processId: entry.processId,
    profile: entry.profile,
    state: entry.state,
    startedAt: new Date(entry.startedAtMs).toISOString(),
    deadline: new Date(entry.deadlineMs).toISOString(),
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
  };
}

function listenerSummary(listener: MutableProcessListener): ProcessListenerSummary {
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

export class ProcessSupervisor {
  private readonly entries = new Map<string, MutableProcess>();
  private readonly operations = new Map<string, { processId: string; profile: string }>();
  private readonly startTails = new Map<string, Promise<void>>();
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly reconciliationTimer: NodeJS.Timeout;

  constructor(private readonly options: ProcessSupervisorOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.reconciliationTimer = setInterval(() => { void this.reconcile(); }, options.reconciliationIntervalMs ?? 2_000);
    this.reconciliationTimer.unref();
  }

  private async requireWorkspace(workspaceId: string): Promise<AuthorizedWorkspace> {
    const workspace = await this.options.loadWorkspace(workspaceId);
    if (workspace === undefined) brokerError('WORKSPACE_NOT_FOUND', 'El workspace no existe o no está autorizado.');
    if (!workspace.enabled) brokerError('WORKSPACE_DISABLED', 'El workspace está deshabilitado.');
    if (workspace.permissions.processes !== true) brokerError('CAPABILITY_DISABLED', 'El permiso de procesos está deshabilitado.');
    return workspace;
  }

  private async withStartLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.startTails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.startTails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.startTails.get(key) === tail) this.startTails.delete(key);
    }
  }

  private addLog(entry: MutableProcess, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = chunk.toString('utf8');
    const bytes = Buffer.byteLength(text);
    const cursor = entry.nextCursor;
    entry.nextCursor += bytes;
    entry.logs.push({ cursor, stream, text });
    entry.logBytes += bytes;
    while (entry.logBytes > MAX_LOG_BYTES && entry.logs.length > 1) {
      const removed = entry.logs.shift();
      if (removed !== undefined) entry.logBytes -= Buffer.byteLength(removed.text);
    }
  }

  private applyListenerSnapshot(entry: MutableProcess, line: string): void {
    const parts = line.split(' ');
    if (parts.length < 2 || !['LBP1', 'LBP2'].includes(parts[0]!) || !/^\d{1,3}$/.test(parts[1]!)) {
      entry.listeners.clear();
      return;
    }
    const declared = Number(parts[1]);
    if (declared > 128 || parts.length !== declared + 2) {
      entry.listeners.clear();
      return;
    }

    const next = new Map<string, MutableProcessListener>();
    const observedAtMs = this.now();
    for (const token of parts.slice(2)) {
      const legacy = parts[0] === 'LBP1';
      const match = legacy
        ? /^(4|6):([1-9]\d{0,4})$/.exec(token)
        : /^(4|6)(l|w):([1-9]\d{0,4}):(0|1)$/.exec(token);
      const port = Number(match?.[legacy ? 2 : 3]);
      if (match === null || port > 65_535) {
        entry.listeners.clear();
        return;
      }
      const addressFamily = match[1] === '4' ? 'ipv4' : 'ipv6';
      const bindScope = legacy || match[2] === 'l' ? 'loopback' : 'wildcard';
      const exclusive = legacy || match[4] === '1';
      const origin = bindScope === 'wildcard'
        ? `http://localhost:${port}`
        : addressFamily === 'ipv4'
          ? `http://127.0.0.1:${port}`
          : `http://[::1]:${port}`;
      const listenerKey = `${addressFamily}:${bindScope}:${port}`;
      if (next.has(listenerKey)) {
        entry.listeners.clear();
        return;
      }
      const previous = entry.listeners.get(listenerKey);
      next.set(listenerKey, {
        listenerRef: previous?.listenerRef ?? `listener_${randomBytes(12).toString('hex')}`,
        origin,
        addressFamily,
        bindScope,
        exclusive,
        port,
        observedAtMs,
      });
    }
    entry.listeners = next;
  }

  private addControlData(entry: MutableProcess, chunk: Buffer): void {
    entry.controlBuffer += chunk.toString('ascii');
    if (Buffer.byteLength(entry.controlBuffer, 'ascii') > MAX_CONTROL_BUFFER_BYTES) {
      entry.controlBuffer = '';
      entry.listeners.clear();
      return;
    }
    let newline = entry.controlBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = entry.controlBuffer.slice(0, newline).replace(/\r$/, '');
      entry.controlBuffer = entry.controlBuffer.slice(newline + 1);
      this.applyListenerSnapshot(entry, line);
      newline = entry.controlBuffer.indexOf('\n');
    }
  }

  async start(workspaceId: string, profileName: string, operationId?: string): Promise<ProcessSummary> {
    const operationKey = operationId === undefined ? undefined : `${workspaceId}:${operationId}`;
    const workspace = await this.requireWorkspace(workspaceId);
    const verification = await verifyProcessProfile(workspace, profileName);
    if (!verification.ok || verification.profile === undefined) {
      brokerError(verification.code, 'El perfil no está disponible o su definición cambió.');
    }
    const profile = verification.profile;
    const profileFingerprint = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    return this.withStartLock(`${workspaceId}:${profileName}`, async () => {
    const previousRecord = operationKey === undefined ? undefined : this.operations.get(operationKey);
    if (previousRecord !== undefined) {
      if (previousRecord.profile !== profileName) brokerError('IDEMPOTENCY_CONFLICT', 'El operationId ya fue usado con otro perfil.');
      const previous = this.entries.get(previousRecord.processId);
      if (previous !== undefined && previous.workspaceId === workspaceId) return summary(previous);
    }
    // ApplicationSupervisor owns and stops the processes it launches, so it
    // must not adopt a standalone process implicitly. Direct process.start
    // calls can safely rediscover the same managed profile across chats.
    const compatible = operationId?.startsWith('application:') === true ? undefined : [...this.entries.values()].find((entry) =>
      entry.workspaceId === workspaceId && entry.profile === profileName && entry.state === 'running' &&
      entry.profileFingerprint === profileFingerprint);
    if (compatible !== undefined) {
      if (operationKey !== undefined) this.operations.set(operationKey, { processId: compatible.processId, profile: profileName });
      return summary(compatible);
    }
    const running = [...this.entries.values()].filter((entry) => entry.state === 'running');
    if (running.length >= MAX_RUNNING_GLOBAL || running.filter((entry) => entry.workspaceId === workspaceId).length >= MAX_RUNNING_PER_WORKSPACE) {
      brokerError('RATE_LIMITED', 'Se alcanzó el límite de procesos activos.');
    }
    if (this.platform !== 'win32') brokerError('FEATURE_UNAVAILABLE', 'El supervisor persistente requiere Windows.');

    const safeCwd = await resolveSafePath(workspace.rootPath, profile.cwd);
    if (!safeCwd.exists || !(await stat(safeCwd.realPath)).isDirectory()) {
      brokerError('PROFILE_SOURCE_INVALID', 'El directorio de trabajo aprobado no está disponible.');
    }
    const nodeStat = await stat(this.options.nodeBinaryPath).catch(() => undefined);
    if (nodeStat === undefined || !nodeStat.isFile()) {
      brokerError('FEATURE_UNAVAILABLE', 'El runtime Node autocontenido no está disponible.');
    }

    const startedAtMs = this.now();
    const deadlineMs = startedAtMs + profile.maxRuntimeSeconds * 1000;
    const processId = `process_${randomBytes(12).toString('hex')}`;
    const child = spawn(
      this.options.helperPath,
      ['--parent', String(this.options.parentPid), '--', this.options.nodeBinaryPath, '-e', WINDOWS_PROFILE_LAUNCHER, JSON.stringify(profile.command)],
      {
        cwd: safeCwd.realPath,
        env: buildFilteredEnv({}, ['APPDATA', 'LOCALAPPDATA', 'PNPM_HOME', 'NPM_CONFIG_USERCONFIG']),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;
    const control = child.stdio[3] as Readable | null;
    if (control === null) {
      child.kill();
      brokerError('FEATURE_UNAVAILABLE', 'El canal nativo de listeners no está disponible.');
    }
    let resolveClose: () => void = noop;
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
    const timer = setTimeout(() => {
      const current = this.entries.get(processId);
      if (current === undefined || current.state !== 'running') return;
      current.state = 'timed_out';
      current.child.kill();
    }, profile.maxRuntimeSeconds * 1000);
    const entry: MutableProcess = {
      processId,
      workspaceId,
      profile: profileName,
      profileFingerprint,
      child,
      startedAtMs,
      deadlineMs,
      logs: [],
      closePromise,
      resolveClose,
      timer,
      state: 'running',
      logBytes: 0,
      nextCursor: 0,
      controlBuffer: '',
      listeners: new Map(),
    };
    this.entries.set(processId, entry);
    if (operationKey !== undefined) this.operations.set(operationKey, { processId, profile: profileName });

    child.stdout.on('data', (chunk: Buffer) => this.addLog(entry, 'stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.addLog(entry, 'stderr', chunk));
    control.on('data', (chunk: Buffer) => this.addControlData(entry, chunk));
    control.on('close', () => entry.listeners.clear());
    child.once('error', () => {
      if (entry.state === 'running') entry.state = 'exited';
      entry.exitCode = -1;
      entry.listeners.clear();
      clearTimeout(entry.timer);
      entry.resolveClose();
    });
    child.once('close', (code) => {
      if (entry.state === 'running') entry.state = 'exited';
      entry.exitCode = code ?? -1;
      entry.listeners.clear();
      clearTimeout(entry.timer);
      entry.resolveClose();
    });
    return summary(entry);
    });
  }

  async list(workspaceId: string): Promise<readonly ProcessSummary[]> {
    await this.requireWorkspace(workspaceId);
    return [...this.entries.values()].filter((entry) => entry.workspaceId === workspaceId).map(summary);
  }

  async listeners(workspaceId: string, processId: string): Promise<{
    readonly process: ProcessSummary;
    readonly listeners: readonly ProcessListenerSummary[];
  }> {
    await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(processId);
    if (entry === undefined || entry.workspaceId !== workspaceId) brokerError('PROCESS_NOT_FOUND', 'El proceso no existe.');
    const cutoff = this.now() - LISTENER_STALE_MS;
    return {
      process: summary(entry),
      listeners: [...entry.listeners.values()]
        .filter((listener) => listener.observedAtMs >= cutoff)
        .map(listenerSummary),
    };
  }

  async resolveListener(
    workspaceId: string,
    processId: string,
    listenerRef: string,
  ): Promise<ResolvedProcessListener> {
    await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(processId);
    if (entry === undefined || entry.workspaceId !== workspaceId || entry.state !== 'running') {
      brokerError('PROCESS_NOT_FOUND', 'El proceso no existe o ya terminó.');
    }
    const listener = [...entry.listeners.values()].find((candidate) => candidate.listenerRef === listenerRef);
    if (listener === undefined || listener.observedAtMs < this.now() - LISTENER_STALE_MS) {
      brokerError('LISTENER_NOT_FOUND', 'El listener ya no pertenece al proceso administrado.');
    }
    return { ...listenerSummary(listener), processId, profile: entry.profile };
  }

  /** Vista local de Electron; no cruza MCP y tampoco expone PID, comando o rutas. */
  listAll(): ReadonlyArray<ProcessSummary & { workspaceId: string; listeners: readonly ProcessListenerSummary[] }> {
    const cutoff = this.now() - LISTENER_STALE_MS;
    return [...this.entries.values()].map((entry) => ({
      workspaceId: entry.workspaceId,
      ...summary(entry),
      listeners: [...entry.listeners.values()]
        .filter((listener) => listener.observedAtMs >= cutoff)
        .map(listenerSummary),
    }));
  }

  async logs(workspaceId: string, processId: string, cursor: number, maxBytes: number) {
    await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(processId);
    if (entry === undefined || entry.workspaceId !== workspaceId) brokerError('PROCESS_NOT_FOUND', 'El proceso no existe.');
    const firstCursor = entry.logs[0]?.cursor ?? entry.nextCursor;
    let used = 0;
    const output: ProcessLogEntry[] = [];
    for (const item of entry.logs) {
      const end = item.cursor + Buffer.byteLength(item.text);
      if (end <= cursor) continue;
      const bytes = Buffer.byteLength(item.text);
      if (used + bytes > maxBytes && output.length > 0) break;
      output.push(item);
      used += bytes;
    }
    return {
      process: summary(entry),
      entries: output,
      nextCursor: output.length === 0
        ? Math.max(cursor, entry.nextCursor)
        : output.at(-1)!.cursor + Buffer.byteLength(output.at(-1)!.text),
      truncatedBeforeCursor: cursor < firstCursor,
    };
  }

  async stop(workspaceId: string, processId: string): Promise<ProcessSummary> {
    await this.requireWorkspace(workspaceId);
    const entry = this.entries.get(processId);
    if (entry === undefined || entry.workspaceId !== workspaceId) brokerError('PROCESS_NOT_FOUND', 'El proceso no existe.');
    await this.terminate(entry, 'stopped');
    return summary(entry);
  }

  /** Cierre interno del orquestador; no cruza MCP y no depende de permisos ya revocados. */
  async stopManaged(processId: string): Promise<ProcessSummary | undefined> {
    const entry = this.entries.get(processId);
    if (entry === undefined) return undefined;
    await this.terminate(entry, 'stopped');
    return summary(entry);
  }

  private async terminate(entry: MutableProcess, state: ProcessState): Promise<void> {
    if (entry.state !== 'running') return;
    entry.state = state;
    entry.listeners.clear();
    entry.child.kill();
    await entry.closePromise;
  }

  /** Cierra sesiones activas cuando el registro revoca su autorización. */
  async reconcile(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.state === 'running');
    await Promise.all(running.map(async (entry) => {
      const workspace = await this.options.loadWorkspace(entry.workspaceId).catch(() => undefined);
      if (workspace === undefined || !workspace.enabled || workspace.permissions.processes !== true) {
        await this.terminate(entry, 'stopped');
        return;
      }
      const verification = await verifyProcessProfile(workspace, entry.profile).catch(() => ({ ok: false as const }));
      if (!verification.ok || verification.profile === undefined ||
          createHash('sha256').update(JSON.stringify(verification.profile)).digest('hex') !== entry.profileFingerprint) {
        await this.terminate(entry, 'stopped');
      }
    }));
  }

  async stopAll(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.state === 'running');
    await Promise.all(running.map((entry) => this.terminate(entry, 'stopped')));
  }

  async close(): Promise<void> {
    clearInterval(this.reconciliationTimer);
    await this.stopAll();
  }
}
