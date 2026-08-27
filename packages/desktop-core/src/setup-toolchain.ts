import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { SetupToolchainEvidence } from "./setup-plan.js";

export type SetupToolchainKind = SetupToolchainEvidence["manager"];

export interface ResolvedSetupToolchain extends SetupToolchainEvidence {
  /** Solo para Electron/setup-supervisor. Nunca se persiste ni cruza MCP. */
  readonly executablePath: string;
  readonly executableKind: "native" | "node-script";
}

const MANAGER_FILES: Record<SetupToolchainKind, readonly string[]> = {
  npm: ["node_modules/npm/bin/npm-cli.js"],
  pnpm: ["node_modules/pnpm/bin/pnpm.cjs", "pnpm.exe", "pnpm"],
  yarn: ["node_modules/yarn/bin/yarn.js", "yarn.exe", "yarn"],
  git: ["git.exe"],
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function approvedRoots(manager: SetupToolchainKind): string[] {
  if (process.platform !== "win32") {
    return ["/usr/local/bin", "/usr/bin"];
  }
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const appData = process.env["APPDATA"];
  const localAppData = process.env["LOCALAPPDATA"];
  const roots = manager === "git"
    ? [path.join(programFiles, "Git", "cmd"), path.join(programFiles, "Git", "bin")]
    : [path.join(programFiles, "nodejs"), ...(appData === undefined ? [] : [path.join(appData, "npm")]), ...(localAppData === undefined ? [] : [path.join(localAppData, "pnpm")])];
  const pnpmHome = process.env["PNPM_HOME"];
  if (manager === "pnpm" && pnpmHome !== undefined) {
    const allowedParents = [appData, localAppData].filter((value): value is string => value !== undefined).map(canonicalKey);
    const key = canonicalKey(pnpmHome);
    if (allowedParents.some((parent) => key === parent || key.startsWith(`${parent}${path.sep}`))) roots.push(pnpmHome);
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function packageVersion(executablePath: string): Promise<string> {
  const packagePath = path.resolve(path.dirname(executablePath), "..", "package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(parsed.version)) {
    throw new Error("SETUP_TOOLCHAIN_UNSUPPORTED");
  }
  return parsed.version;
}

async function versionOf(executablePath: string, executableKind: ResolvedSetupToolchain["executableKind"]): Promise<string> {
  if (executableKind === "node-script") return packageVersion(executablePath);
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const child = spawn(executablePath, ["--version"], {
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env["PATH"] ?? process.env["Path"] ?? "",
        Path: process.env["Path"] ?? process.env["PATH"] ?? "",
        SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
        COMSPEC: process.env["COMSPEC"] ?? "C:\\Windows\\System32\\cmd.exe",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("SETUP_TOOLCHAIN_TIMEOUT"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) < 4_096) output += chunk.toString("utf8");
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("SETUP_TOOLCHAIN_MISSING"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const version = output.match(/\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9._-]+)?\b/)?.[0] ?? "";
      if (code !== 0 || !/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(version)) {
        reject(new Error("SETUP_TOOLCHAIN_UNSUPPORTED"));
        return;
      }
      resolve(version);
    });
  });
}

export async function resolveSetupToolchain(
  manager: SetupToolchainKind,
  roots: readonly string[] = approvedRoots(manager),
): Promise<ResolvedSetupToolchain> {
  for (const directory of roots) {
    const rootKey = canonicalKey(directory);
    for (const fileName of MANAGER_FILES[manager]) {
      const candidate = path.join(directory, fileName);
      try {
        const link = await lstat(candidate);
        if (!link.isFile() || link.isSymbolicLink()) continue;
        const canonical = await realpath(candidate);
        const canonicalCandidate = canonicalKey(canonical);
        if (canonicalCandidate !== canonicalKey(candidate)) continue;
        if (!(canonicalCandidate === rootKey || canonicalCandidate.startsWith(`${rootKey}${path.sep}`))) continue;
        const canonicalStat = await lstat(canonical);
        if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) continue;
        const bytes = await readFile(canonical);
        const extension = path.extname(canonical).toLocaleLowerCase("en-US");
        const executableKind = extension === ".js" || extension === ".cjs" ? "node-script" : "native";
        return {
          manager,
          executablePath: canonical,
          executableKind,
          executableSha256: sha256(bytes),
          version: await versionOf(canonical, executableKind),
        };
      } catch {
        // La búsqueda es determinista y cerrada: solo se prueban nombres fijos en raíces aprobadas.
      }
    }
  }
  throw new Error(`SETUP_TOOLCHAIN_MISSING:${manager}`);
}

export async function resolveSetupToolchains(managers: readonly SetupToolchainKind[]): Promise<ResolvedSetupToolchain[]> {
  const unique = [...new Set(managers)].toSorted();
  return Promise.all(unique.map((manager) => resolveSetupToolchain(manager)));
}

export async function revalidateSetupToolchain(toolchain: ResolvedSetupToolchain): Promise<boolean> {
  try {
    const canonical = await realpath(toolchain.executablePath);
    if (canonicalKey(canonical) !== canonicalKey(toolchain.executablePath)) return false;
    return sha256(await readFile(canonical)) === toolchain.executableSha256;
  } catch {
    return false;
  }
}
