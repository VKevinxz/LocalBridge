import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

import { buildFilteredEnv, GIT_APPROVAL_MODES, killProcessTree, type GitApprovalMode } from "@localbridge/shared";
import { z } from "zod";

import { absolutePathSchema } from "./ipc-inputs.js";

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export const tunnelIdSchema = z.string().regex(/^tunnel_[0-9a-f]{32}$/, "identificador de túnel no válido");
const profileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const provisionOptionsSchema = z
  .object({
    binaryPath: absolutePathSchema,
    profileDir: absolutePathSchema,
    profile: profileNameSchema,
    tunnelId: tunnelIdSchema,
    serverCommand: z.string().min(1).max(32_768),
  })
  .strict();
const doctorOptionsSchema = provisionOptionsSchema.extend({
  apiKey: z.string().min(1).max(16_384),
  gitApprovalMode: z.enum(GIT_APPROVAL_MODES),
}).strict();

export interface TunnelProvisionOptions {
  readonly binaryPath: string;
  readonly profileDir: string;
  readonly profile: string;
  readonly tunnelId: string;
  readonly serverCommand: string;
}

export interface TunnelDoctorOptions extends TunnelProvisionOptions {
  readonly apiKey: string;
  readonly gitApprovalMode: GitApprovalMode;
}

export interface TunnelDoctorResult {
  readonly ok: boolean;
  readonly output: string;
}

export type ProvisionSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface TunnelProvisionerDeps {
  readonly spawnFn?: ProvisionSpawnFn;
  readonly killTreeFn?: (child: { pid?: number | undefined }, isWindows: boolean) => void;
  readonly isWindows?: boolean;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function appendCapped(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") <= MAX_DIAGNOSTIC_BYTES ? next : next.slice(0, MAX_DIAGNOSTIC_BYTES);
}

async function runClosedCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: TunnelProvisionerDeps,
): Promise<CommandResult> {
  const spawnFn = deps.spawnFn ?? (spawn as ProvisionSpawnFn);
  const isWindows = deps.isWindows ?? process.platform === "win32";
  const killTreeFn = deps.killTreeFn ?? killProcessTree;

  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: path.dirname(command),
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTreeFn(child, isWindows);
      reject(new Error("tunnel-client excedió el tiempo máximo de diagnóstico"));
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function filteredRuntimeEnv(apiKey?: string, gitApprovalMode?: GitApprovalMode): NodeJS.ProcessEnv {
  return buildFilteredEnv({
    ...(apiKey === undefined ? {} : { CONTROL_PLANE_API_KEY: apiKey }),
    ...(gitApprovalMode === undefined ? {} : { LOCALBRIDGE_GIT_APPROVAL_MODE: gitApprovalMode }),
  }, ["APPDATA", "LOCALAPPDATA"]);
}

function diagnosticText(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n");
}

export async function initializeTunnelProfile(
  options: TunnelProvisionOptions,
  deps: TunnelProvisionerDeps = {},
): Promise<void> {
  const parsed = provisionOptionsSchema.parse(options);
  const result = await runClosedCommand(
    parsed.binaryPath,
    [
      "init",
      "--force",
      "--sample",
      "sample_mcp_stdio_local",
      "--profile",
      parsed.profile,
      "--profile-dir",
      parsed.profileDir,
      "--tunnel-id",
      parsed.tunnelId,
      "--mcp-command",
      parsed.serverCommand,
      "--health-listen-addr",
      "127.0.0.1:0",
    ],
    filteredRuntimeEnv(),
    deps,
  );

  if (result.code !== 0) {
    throw new Error(`No se pudo crear el perfil del túnel: ${diagnosticText(result) || `exit ${result.code}`}`);
  }
}

export async function diagnoseTunnelProfile(
  options: TunnelDoctorOptions,
  deps: TunnelProvisionerDeps = {},
): Promise<TunnelDoctorResult> {
  const parsed = doctorOptionsSchema.parse(options);
  const result = await runClosedCommand(
    parsed.binaryPath,
    ["doctor", "--profile", parsed.profile, "--profile-dir", parsed.profileDir, "--explain", "--json"],
    filteredRuntimeEnv(parsed.apiKey, parsed.gitApprovalMode),
    deps,
  );
  return { ok: result.code === 0, output: diagnosticText(result) };
}
