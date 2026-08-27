import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { runGit } from "@localbridge/git";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

export interface WorkspaceReadinessItem {
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
  readonly severity: "info" | "warning" | "error";
}

export interface WorkspaceReadinessReport {
  readonly workspaceId: string;
  readonly ready: boolean;
  readonly checks: readonly WorkspaceReadinessItem[];
}

export interface WorkspaceReadinessDeps {
  readonly statFn?: typeof stat;
  readonly findExecutableFn?: (command: string) => Promise<boolean>;
  readonly runGitFn?: typeof runGit;
}

async function findExecutable(command: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) return false;
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where.exe" : "which", [command], { windowsHide: true, timeout: 5_000 }, (error) =>
      resolve(error === null),
    );
  });
}

async function rootCheck(workspace: AuthorizedWorkspace, statFn: typeof stat): Promise<WorkspaceReadinessItem> {
  try {
    const metadata = await statFn(workspace.rootPath);
    return metadata.isDirectory()
      ? { ok: true, label: "Carpeta local", detail: "Disponible", severity: "info" }
      : { ok: false, label: "Carpeta local", detail: "La ruta ya no es una carpeta", severity: "error" };
  } catch {
    return { ok: false, label: "Carpeta local", detail: "No existe o no es accesible", severity: "error" };
  }
}

export async function testWorkspaceReadiness(
  workspace: AuthorizedWorkspace,
  deps: WorkspaceReadinessDeps = {},
): Promise<WorkspaceReadinessReport> {
  const statFn = deps.statFn ?? stat;
  const findFn = deps.findExecutableFn ?? findExecutable;
  const runGitFn = deps.runGitFn ?? runGit;
  const root = await rootCheck(workspace, statFn);
  const checks: WorkspaceReadinessItem[] = [root];
  if (!root.ok) return { workspaceId: workspace.id, ready: false, checks };

  const commands = [...new Set(Object.values(workspace.validationProfiles).map((profile) => profile[0]).filter((value): value is string => value !== undefined))];
  const toolchainChecks = await Promise.all(commands.map(async (command): Promise<WorkspaceReadinessItem> => {
    const available = path.isAbsolute(command)
      ? await statFn(command).then((metadata) => metadata.isFile()).catch(() => false)
      : await findFn(command);
    return {
      ok: available,
      label: `Toolchain ${command}`,
      detail: available ? "Disponible" : "No encontrado en este equipo",
      severity: available ? "info" : "error",
    };
  }));
  checks.push(...toolchainChecks);

  if (workspace.permissions.gitRead || workspace.permissions.gitWrite) {
    const repository = await runGitFn(["rev-parse", "--is-inside-work-tree"], { cwd: workspace.rootPath }).catch(() => undefined);
    const repositoryOk = repository?.exitCode === 0 && repository.stdout.trim() === "true";
    checks.push({ ok: repositoryOk, label: "Repositorio Git", detail: repositoryOk ? "Detectado" : "No detectado", severity: repositoryOk ? "info" : "error" });

    if (repositoryOk && workspace.permissions.gitWrite) {
      const remote = await runGitFn(["remote", "get-url", "origin"], { cwd: workspace.rootPath }).catch(() => undefined);
      const helper = await runGitFn(["config", "--get", "credential.helper"], { cwd: workspace.rootPath }).catch(() => undefined);
      const remoteOk = remote?.exitCode === 0 && remote.stdout.trim() !== "";
      const helperOk = helper?.exitCode === 0 && helper.stdout.trim() !== "";
      checks.push({ ok: remoteOk, label: "Remoto Git", detail: remoteOk ? "origin configurado" : "Falta origin", severity: remoteOk ? "info" : "warning" });
      checks.push({ ok: helperOk, label: "Credenciales Git", detail: helperOk ? "Helper configurado; se validará al publicar" : "No se detectó un helper de credenciales", severity: helperOk ? "info" : "warning" });
    }
  }

  return { workspaceId: workspace.id, ready: checks.every((check) => check.ok || check.severity === "warning"), checks };
}
