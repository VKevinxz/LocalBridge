import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  revalidateSetupToolchain,
  type ResolvedSetupToolchain,
} from "@localbridge/desktop-core";
import { buildFilteredEnv } from "@localbridge/shared";
import {
  resolveSafePath,
  type AuthorizedWorkspace,
  type SetupAction,
  type SetupPlan,
} from "@localbridge/workspace";

const MAX_SETUP_LOG_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ACTIVE_SETUPS = 2;
const PRIVATE_PACKAGE_CONFIGS = [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"] as const;

const FIXED_LAUNCHER = String.raw`
const {spawn}=require('node:child_process');
const executable=process.argv[1];
const kind=process.argv[2];
const args=JSON.parse(process.argv[3]);
const child=kind==='node-script'
  ? spawn(process.execPath,[executable,...args],{stdio:'inherit',shell:false,windowsHide:true})
  : spawn(executable,args,{stdio:'inherit',shell:false,windowsHide:true});
child.once('error',()=>{process.exitCode=70;});
child.once('exit',(code)=>{process.exitCode=code===null?70:code;});
`;

export type SetupRunState = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface SetupRunSummary {
  readonly runId: string;
  readonly projectId: string;
  readonly planSha256: string;
  readonly state: SetupRunState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly completedActions: number;
  readonly totalExecutableActions: number;
  readonly errorCode?: string;
  readonly logs: readonly string[];
}

interface MutableSetupRun {
  readonly runId: string;
  readonly projectId: string;
  readonly planSha256: string;
  readonly startedAtMs: number;
  readonly totalExecutableActions: number;
  state: SetupRunState;
  completedActions: number;
  finishedAtMs?: number;
  errorCode?: string;
  logs: string[];
  logBytes: number;
  child: ChildProcessWithoutNullStreams | undefined;
  cancelled: boolean;
}

export interface SetupSupervisorOptions {
  readonly helperPath: string;
  readonly nodeBinaryPath: string;
  readonly parentPid: number;
  readonly loadWorkspace: (workspaceId: string) => Promise<AuthorizedWorkspace | undefined>;
  readonly isWorkspaceBusy?: (workspaceId: string) => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
  readonly onChange?: (summary: SetupRunSummary) => void;
}

function executableActions(plan: SetupPlan): SetupAction[] {
  return plan.actions.filter((action) => action.kind === "node-install" || action.kind === "git-init");
}

function redact(text: string): string {
  return text
    .replace(/(?:npm_[A-Za-z0-9]{20,}|gh[opusr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})/g, "[SECRETO REDACTADO]")
    .replace(/(authorization|password|token)\s*[=:]\s*\S+/gi, "$1=[REDACTADO]");
}

function summarize(entry: MutableSetupRun): SetupRunSummary {
  return {
    runId: entry.runId,
    projectId: entry.projectId,
    planSha256: entry.planSha256,
    state: entry.state,
    startedAt: new Date(entry.startedAtMs).toISOString(),
    ...(entry.finishedAtMs === undefined ? {} : { finishedAt: new Date(entry.finishedAtMs).toISOString() }),
    completedActions: entry.completedActions,
    totalExecutableActions: entry.totalExecutableActions,
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    logs: [...entry.logs],
  };
}

function fixedArgs(action: Extract<SetupAction, { kind: "node-install" | "git-init" }>): readonly string[] {
  if (action.kind === "git-init") return ["init"];
  if (action.manager === "npm") {
    return ["install", ...(action.mode === "restricted" ? ["--ignore-scripts"] : []), "--no-audit", "--no-fund"];
  }
  if (action.manager === "pnpm") {
    return ["install", ...(action.mode === "restricted" ? ["--ignore-scripts"] : []), "--reporter=append-only"];
  }
  return ["install", ...(action.mode === "restricted" ? ["--ignore-scripts"] : [])];
}

export class SetupSupervisor {
  private readonly runs = new Map<string, MutableSetupRun>();
  private readonly activeByProject = new Map<string, string>();

  constructor(private readonly options: SetupSupervisorOptions) {}

  private notify(entry: MutableSetupRun): void {
    this.options.onChange?.(summarize(entry));
  }

  private append(entry: MutableSetupRun, chunk: Buffer): void {
    if (entry.logBytes >= MAX_SETUP_LOG_BYTES) return;
    const text = redact(chunk.toString("utf8")).slice(0, MAX_SETUP_LOG_BYTES - entry.logBytes);
    entry.logBytes += Buffer.byteLength(text);
    entry.logs.push(text);
    while (entry.logs.length > 400) entry.logs.shift();
    this.notify(entry);
  }

  private async workspace(workspaceId: string): Promise<AuthorizedWorkspace> {
    const workspace = await this.options.loadWorkspace(workspaceId);
    if (workspace === undefined || !workspace.enabled) throw new Error("WORKSPACE_NOT_FOUND");
    if (!workspace.permissions.processes) throw new Error("CAPABILITY_DISABLED");
    return workspace;
  }

  private async preflight(
    action: Extract<SetupAction, { kind: "node-install" | "git-init" }>,
  ): Promise<void> {
    const workspace = await this.workspace(action.workspaceId);
    if (await this.options.isWorkspaceBusy?.(workspace.id)) throw new Error("SETUP_WORKSPACE_BUSY");
    if (action.kind === "git-init") {
      if (!workspace.permissions.gitWrite) throw new Error("CAPABILITY_DISABLED");
      return;
    }
    const manifestDirectory = path.posix.dirname(action.manifestPath);
    const roots = new Set([".", manifestDirectory === "." ? "." : manifestDirectory]);
    for (const root of roots) {
      for (const fileName of PRIVATE_PACKAGE_CONFIGS) {
        const relative = root === "." ? fileName : `${root}/${fileName}`;
        const candidate = await resolveSafePath(workspace.rootPath, relative);
        if (candidate.exists) throw new Error("SETUP_PRIVATE_CONFIG_UNSUPPORTED");
      }
    }
  }

  private toolchain(
    action: Extract<SetupAction, { kind: "node-install" | "git-init" }>,
    toolchains: readonly ResolvedSetupToolchain[],
  ): ResolvedSetupToolchain {
    const kind = action.kind === "git-init" ? "git" : action.manager;
    const toolchain = toolchains.find((candidate) => candidate.manager === kind);
    if (toolchain === undefined) throw new Error("SETUP_TOOLCHAIN_MISSING");
    return toolchain;
  }

  private async cwd(action: Extract<SetupAction, { kind: "node-install" | "git-init" }>): Promise<string> {
    const workspace = await this.workspace(action.workspaceId);
    if (action.kind === "git-init") return workspace.rootPath;
    const manifest = await resolveSafePath(workspace.rootPath, action.manifestPath);
    if (!manifest.exists || !(await stat(manifest.realPath)).isFile()) throw new Error("SETUP_PLAN_STALE");
    return path.dirname(manifest.realPath);
  }

  private async execute(
    entry: MutableSetupRun,
    action: Extract<SetupAction, { kind: "node-install" | "git-init" }>,
    toolchain: ResolvedSetupToolchain,
  ): Promise<void> {
    if (!(await revalidateSetupToolchain(toolchain))) throw new Error("SETUP_TOOLCHAIN_CHANGED");
    const cwd = await this.cwd(action);
    const privateHome = await mkdtemp(path.join(os.tmpdir(), "localbridge-setup-"));
    try {
      const restricted = action.kind === "node-install" && action.mode === "restricted";
      const env = buildFilteredEnv({
        HOME: privateHome,
        USERPROFILE: privateHome,
        NPM_CONFIG_USERCONFIG: path.join(privateHome, ".npmrc"),
        npm_config_userconfig: path.join(privateHome, ".npmrc"),
        CI: "true",
        ...(restricted ? {
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          npm_config_ignore_scripts: "true",
          YARN_ENABLE_SCRIPTS: "false",
        } : {}),
      });
      const child = spawn(
        this.options.helperPath,
        ["--parent", String(this.options.parentPid), "--", this.options.nodeBinaryPath, "-e", FIXED_LAUNCHER, toolchain.executablePath, toolchain.executableKind, JSON.stringify(fixedArgs(action))],
        { cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
      ) as ChildProcessWithoutNullStreams;
      entry.child = child;
      const exitCode = await new Promise<number>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error("SETUP_TIMEOUT"));
        }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => this.append(entry, chunk));
        child.stderr.on("data", (chunk: Buffer) => this.append(entry, chunk));
        child.once("error", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("SETUP_START_FAILED"));
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });
      entry.child = undefined;
      if (entry.cancelled) throw new Error("SETUP_CANCELLED");
      if (exitCode !== 0) throw new Error("SETUP_COMMAND_FAILED");
    } finally {
      entry.child = undefined;
      await rm(privateHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async start(plan: SetupPlan, toolchains: readonly ResolvedSetupToolchain[]): Promise<SetupRunSummary> {
    const activeId = this.activeByProject.get(plan.projectId);
    if (activeId !== undefined) return summarize(this.runs.get(activeId)!);
    const actions = executableActions(plan);
    if (this.activeByProject.size >= MAX_ACTIVE_SETUPS) throw new Error("SETUP_ALREADY_RUNNING");
    for (const action of actions) await this.preflight(action as Extract<SetupAction, { kind: "node-install" | "git-init" }>);
    const entry: MutableSetupRun = {
      runId: `setup_run_${randomBytes(12).toString("hex")}`,
      projectId: plan.projectId,
      planSha256: plan.planSha256,
      state: "running",
      startedAtMs: Date.now(),
      completedActions: 0,
      totalExecutableActions: actions.length,
      logs: [],
      logBytes: 0,
      cancelled: false,
      child: undefined,
    };
    this.runs.set(entry.runId, entry);
    this.activeByProject.set(entry.projectId, entry.runId);
    this.notify(entry);
    void (async () => {
      try {
        for (const action of actions) {
          if (entry.cancelled) throw new Error("SETUP_CANCELLED");
          await this.execute(entry, action as Extract<SetupAction, { kind: "node-install" | "git-init" }>, this.toolchain(action as Extract<SetupAction, { kind: "node-install" | "git-init" }>, toolchains));
          entry.completedActions += 1;
          this.notify(entry);
        }
        entry.state = "succeeded";
      } catch (error) {
        const code = error instanceof Error ? error.message.split(":")[0]! : "SETUP_FAILED";
        entry.state = code === "SETUP_CANCELLED" ? "cancelled" : code === "SETUP_TIMEOUT" ? "timed_out" : "failed";
        entry.errorCode = code;
      } finally {
        entry.finishedAtMs = Date.now();
        this.activeByProject.delete(entry.projectId);
        this.notify(entry);
      }
    })();
    return summarize(entry);
  }

  status(runId: string): SetupRunSummary | undefined {
    const entry = this.runs.get(runId);
    return entry === undefined ? undefined : summarize(entry);
  }

  listAll(): SetupRunSummary[] {
    return [...this.runs.values()].map(summarize);
  }

  async cancel(projectId: string): Promise<SetupRunSummary | undefined> {
    const runId = this.activeByProject.get(projectId);
    if (runId === undefined) return undefined;
    const entry = this.runs.get(runId)!;
    entry.cancelled = true;
    entry.child?.kill();
    this.notify(entry);
    const deadline = Date.now() + 5_000;
    while (entry.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (entry.state === "running") {
      entry.state = "cancelled";
      entry.errorCode = "SETUP_CANCELLED";
      entry.finishedAtMs = Date.now();
      this.activeByProject.delete(entry.projectId);
      this.notify(entry);
    }
    return summarize(entry);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.activeByProject.keys()].map((projectId) => this.cancel(projectId)));
  }
}
