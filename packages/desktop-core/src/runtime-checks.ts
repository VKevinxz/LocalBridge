import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildFilteredEnv } from "@localbridge/shared";

import type { BundledRuntimePaths } from "./bundled-runtime.js";

export interface RuntimeCheckItem {
  readonly ok: boolean;
  readonly detail: string;
}

export interface RuntimeReadinessReport {
  readonly node: RuntimeCheckItem;
  readonly tunnel: RuntimeCheckItem;
  readonly connectivity: RuntimeCheckItem;
  readonly server: RuntimeCheckItem;
  readonly ready: boolean;
}

export interface RuntimeCheckDeps {
  readonly execFileFn?: (file: string, args: readonly string[]) => Promise<string>;
  readonly connectivityFn?: () => Promise<RuntimeCheckItem>;
  readonly serverProbeFn?: (paths: BundledRuntimePaths) => Promise<RuntimeCheckItem>;
}

function filteredStringEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(buildFilteredEnv(extra, ["APPDATA", "LOCALAPPDATA"])).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function defaultExecFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr).trim() || error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function checkExecutable(
  file: string,
  args: readonly string[],
  execFileFn: NonNullable<RuntimeCheckDeps["execFileFn"]>,
): Promise<RuntimeCheckItem> {
  try {
    const version = await execFileFn(file, args);
    return { ok: version.length > 0, detail: version || "sin versión" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkControlPlaneConnectivity(): Promise<RuntimeCheckItem> {
  return new Promise((resolve) => {
    const request = https.request(
      "https://api.openai.com/v1/models",
      { method: "HEAD", timeout: 8_000, headers: { "User-Agent": "localbridge-readiness/1.1.0" } },
      (response) => {
        response.resume();
        resolve({ ok: true, detail: `HTTPS ${response.statusCode ?? "respuesta recibida"}` });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout HTTPS")));
    request.on("error", (error) => resolve({ ok: false, detail: error.message }));
    request.end();
  });
}

export async function probeBundledServer(paths: BundledRuntimePaths): Promise<RuntimeCheckItem> {
  const isolatedRoot = path.join(os.tmpdir(), `localbridge-self-test-${randomUUID()}`);
  const transport = new StdioClientTransport({
    command: paths.nodeBinaryPath,
    args: [paths.serverBundlePath],
    env: filteredStringEnv({
      LOCALBRIDGE_LOG_LEVEL: "error",
      LOCALBRIDGE_WORKSPACES_FILE: path.join(isolatedRoot, "workspaces.json"),
      LOCALBRIDGE_AUDIT_DB_FILE: path.join(isolatedRoot, "audit.db"),
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "localbridge-readiness", version: "1.1.0" });
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout iniciando el servidor MCP")), 8_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;

    const result = await client.callTool({ name: "system.health", arguments: {} });
    const structured = result.structuredContent;
    const status =
      typeof structured === "object" && structured !== null && "status" in structured
        ? String(structured.status)
        : "desconocido";
    return { ok: status === "ready", detail: `system.health: ${status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

export async function checkRuntimeReadiness(
  paths: BundledRuntimePaths,
  deps: RuntimeCheckDeps = {},
): Promise<RuntimeReadinessReport> {
  const execFileFn = deps.execFileFn ?? defaultExecFile;
  const [node, tunnel, connectivity, server] = await Promise.all([
    checkExecutable(paths.nodeBinaryPath, ["--version"], execFileFn),
    checkExecutable(paths.tunnelBinaryPath, ["--version"], execFileFn),
    (deps.connectivityFn ?? checkControlPlaneConnectivity)(),
    (deps.serverProbeFn ?? probeBundledServer)(paths),
  ]);

  return { node, tunnel, connectivity, server, ready: node.ok && tunnel.ok && connectivity.ok && server.ok };
}
