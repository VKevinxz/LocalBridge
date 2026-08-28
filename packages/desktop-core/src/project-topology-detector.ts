import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  isPathDenied,
  resolveSafePath,
  type AuthorizedWorkspace,
  type ProcessProfile,
} from "@localbridge/workspace";

/**
 * Directorios que nunca se recorren. Además de artefactos de build, incluye
 * ubicaciones habituales de datos y cachés (ADR-0040): antes agotaban el
 * presupuesto del recorrido y dejaban sin explorar el código real. La omisión
 * es por nombre de directorio, igual que ya ocurría con `build` o `dist`, así
 * que un manifest dentro de una de estas carpetas deja de detectarse.
 */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".pytest_cache",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "data",
  "dist",
  "logs",
  "node_modules",
  "out",
  "pgdata",
  "storage",
  "target",
  "temp",
  "tmp",
  "var",
  "vendor",
  "venv",
]);
const MANIFEST_NAMES = new Set(["package.json", "composer.json", "Makefile", "makefile", "GNUmakefile"]);
const UNSUPPORTED_MANIFEST_NAMES = new Set(["Cargo.toml", "pyproject.toml", "go.mod", "Gemfile"]);
const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const SERVER_SCRIPT_NAMES = new Set(["dev", "start", "serve", "server", "preview"]);
const VALIDATION_SCRIPT_NAMES = new Set(["test", "lint", "typecheck", "check", "build"]);
const MAKEFILE_TARGET_RE = /^([A-Za-z0-9_.-]+)\s*:(?!=)/;
const SPECIAL_MAKE_TARGETS = new Set([".PHONY", ".DEFAULT", ".SUFFIXES", ".PRECIOUS", ".INTERMEDIATE", ".SECONDARY", ".DELETE_ON_ERROR", ".IGNORE", ".SILENT", ".EXPORT_ALL_VARIABLES", ".NOTPARALLEL", ".ONESHELL", ".POSIX"]);

export interface TopologyDetectorLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  /**
   * Cota por directorio. Impide que una sola carpeta enorme consuma el
   * presupuesto global y deje sus hermanas sin explorar (ADR-0040).
   */
  readonly maxEntriesPerDirectory: number;
  readonly maxManifests: number;
  readonly maxManifestBytes: number;
}

export interface TopologyManifest {
  readonly kind: "package" | "composer" | "make";
  readonly path: string;
  readonly cwd: string;
  readonly sha256: string;
}

export interface TopologyLockfile {
  readonly path: string;
  readonly cwd: string;
  readonly manager: "npm" | "pnpm" | "yarn" | "bun";
  readonly sha256: string;
}

export interface TopologyCommand {
  readonly id: string;
  readonly name: string;
  readonly role: "server" | "validation" | "unknown";
  readonly source: string;
  readonly processProfile: ProcessProfile;
}

export interface ProjectTopology {
  readonly topology: "single" | "monorepo" | "multi-repo";
  readonly manifests: readonly TopologyManifest[];
  readonly lockfiles: readonly TopologyLockfile[];
  readonly gitRoots: readonly string[];
  readonly commands: readonly TopologyCommand[];
  readonly directDependencyCount: number;
  readonly directDevDependencyCount: number;
  readonly warnings: readonly string[];
  readonly truncated: boolean;
  readonly scannedEntries: number;
}

function dependencyCounts(files: readonly DiscoveredFile[]): { production: number; development: number } {
  let production = 0;
  let development = 0;
  for (const file of files) {
    if (file.name !== "package.json" && file.name !== "composer.json") continue;
    try {
      const parsed = JSON.parse(file.raw) as Record<string, unknown>;
      const productionField = file.name === "package.json" ? parsed["dependencies"] : parsed["require"];
      const developmentField = file.name === "package.json" ? parsed["devDependencies"] : parsed["require-dev"];
      if (productionField !== null && typeof productionField === "object" && !Array.isArray(productionField)) production += Object.keys(productionField).length;
      if (developmentField !== null && typeof developmentField === "object" && !Array.isArray(developmentField)) development += Object.keys(developmentField).length;
    } catch {
      // El parser específico ya registra el warning; el resumen queda en cero para ese manifest.
    }
  }
  return { production, development };
}

interface DiscoveredFile {
  readonly relativePath: string;
  readonly cwd: string;
  readonly name: string;
  readonly raw: string;
  readonly sha256: string;
}

export const DEFAULT_TOPOLOGY_LIMITS: TopologyDetectorLimits = {
  maxDepth: 6,
  maxEntries: 2_000,
  maxEntriesPerDirectory: 400,
  maxManifests: 64,
  maxManifestBytes: 1_048_576,
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeRelative(value: string): string {
  const normalized = value.split(path.sep).join("/");
  return normalized === "" ? "." : normalized;
}

function parentRelative(relativePath: string): string {
  const parent = path.posix.dirname(relativePath);
  return parent === "" ? "." : parent;
}

function commandRole(name: string): TopologyCommand["role"] {
  const normalized = name.toLocaleLowerCase("en-US");
  if (SERVER_SCRIPT_NAMES.has(normalized)) return "server";
  if (VALIDATION_SCRIPT_NAMES.has(normalized)) return "validation";
  return "unknown";
}

function managerForLockfile(name: string): TopologyLockfile["manager"] {
  if (name.startsWith("pnpm-")) return "pnpm";
  if (name === "yarn.lock") return "yarn";
  if (name.startsWith("bun.")) return "bun";
  return "npm";
}

function nearestManager(cwd: string, lockfiles: readonly TopologyLockfile[], packageManagerField: unknown): "npm" | "pnpm" | "yarn" | undefined {
  if (typeof packageManagerField === "string") {
    const manager = packageManagerField.split("@")[0];
    if (manager === "npm" || manager === "pnpm" || manager === "yarn") return manager;
  }
  const candidates = lockfiles
    .filter((lockfile) => lockfile.manager !== "bun" && (cwd === lockfile.cwd || cwd.startsWith(`${lockfile.cwd === "." ? "" : `${lockfile.cwd}/`}`)))
    .toSorted((left, right) => right.cwd.length - left.cwd.length);
  return candidates[0]?.manager as "npm" | "pnpm" | "yarn" | undefined;
}

async function readBoundedFile(workspace: AuthorizedWorkspace, relativePath: string, limit: number): Promise<DiscoveredFile | undefined> {
  const safe = await resolveSafePath(workspace.rootPath, relativePath);
  if (!safe.exists || isPathDenied(safe.relativePath, workspace.denyPatterns)) return undefined;
  const metadata = await stat(safe.realPath);
  if (!metadata.isFile() || metadata.size > limit) return undefined;
  const raw = await readFile(safe.realPath, "utf8");
  return {
    relativePath: safe.relativePath,
    cwd: parentRelative(safe.relativePath),
    name: path.posix.basename(safe.relativePath),
    raw,
    sha256: digest(raw),
  };
}

async function walkWorkspace(
  workspace: AuthorizedWorkspace,
  limits: TopologyDetectorLimits,
): Promise<{ files: DiscoveredFile[]; gitRoots: string[]; warnings: string[]; truncated: boolean; scannedEntries: number }> {
  const files: DiscoveredFile[] = [];
  const gitRoots = new Set<string>();
  const warnings: string[] = [];
  const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: ".", depth: 0 }];
  let scannedEntries = 0;
  let truncated = false;

  while (queue.length > 0 && scannedEntries < limits.maxEntries && files.length < limits.maxManifests * 2) {
    const current = queue.shift()!;
    const safeDirectory = await resolveSafePath(workspace.rootPath, current.relativePath);
    if (!safeDirectory.exists) continue;
    let entries;
    try {
      entries = await readdir(safeDirectory.realPath, { withFileTypes: true });
    } catch {
      warnings.push("DIRECTORY_UNREADABLE");
      continue;
    }
    let directoryEntries = 0;
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = normalizeRelative(path.join(current.relativePath === "." ? "" : current.relativePath, entry.name));
      // El presupuesto se cobra después de la denylist (ADR-0040): denegar una
      // ruta debe liberar presupuesto, no solo evitar descender por ella.
      if (isPathDenied(relativePath, workspace.denyPatterns)) continue;
      scannedEntries += 1;
      directoryEntries += 1;
      if (scannedEntries > limits.maxEntries) {
        truncated = true;
        break;
      }
      if (directoryEntries > limits.maxEntriesPerDirectory) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) {
        // No seguimos enlaces aunque apunten dentro: la topología debe depender de
        // raíces físicas revisables y no cambiar si el link se retargetea después.
        warnings.push("PATH_SKIPPED");
        continue;
      }
      if (entry.name === ".git" && (entry.isDirectory() || entry.isFile())) {
        gitRoots.add(current.relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || current.depth >= limits.maxDepth) {
          if (current.depth >= limits.maxDepth && !IGNORED_DIRECTORIES.has(entry.name)) truncated = true;
          continue;
        }
        try {
          const safeChild = await resolveSafePath(workspace.rootPath, relativePath);
          const childMetadata = await lstat(safeChild.realPath);
          if (childMetadata.isSymbolicLink()) {
            warnings.push("LINK_SKIPPED");
            continue;
          }
          queue.push({ relativePath: safeChild.relativePath, depth: current.depth + 1 });
        } catch {
          warnings.push("PATH_SKIPPED");
        }
        continue;
      }
      if (!entry.isFile() || (!MANIFEST_NAMES.has(entry.name) && !LOCKFILE_NAMES.has(entry.name) && !UNSUPPORTED_MANIFEST_NAMES.has(entry.name))) continue;
      if (files.length >= limits.maxManifests * 2) {
        truncated = true;
        break;
      }
      const file = await readBoundedFile(workspace, relativePath, Math.min(limits.maxManifestBytes, workspace.limits.maxFileBytes));
      if (file === undefined) warnings.push("MANIFEST_UNREADABLE_OR_TOO_LARGE");
      else files.push(file);
    }
  }
  if (queue.length > 0) truncated = true;
  return { files, gitRoots: [...gitRoots].toSorted(), warnings: [...new Set(warnings)], truncated, scannedEntries };
}

function packageCommands(file: DiscoveredFile, lockfiles: readonly TopologyLockfile[], warnings: string[]): TopologyCommand[] {
  let manifest: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    manifest = JSON.parse(file.raw) as typeof manifest;
  } catch {
    warnings.push("PACKAGE_MANIFEST_INVALID");
    return [];
  }
  const scripts = manifest.scripts;
  if (scripts === undefined || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const manager = nearestManager(file.cwd, lockfiles, manifest.packageManager) ?? "npm";
  return Object.entries(scripts).flatMap(([name, definition]) => {
    if (typeof definition !== "string") return [];
    const command = [manager, "run", name];
    return [{
      id: `command_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name,
      role: commandRole(name),
      source: `${file.relativePath} (${manager})`,
      processProfile: {
        command,
        cwd: file.cwd,
        source: { kind: "package-script", manifestPath: file.relativePath, script: name, definitionSha256: digest(JSON.stringify(definition)) },
        maxRuntimeSeconds: 4 * 60 * 60,
      },
    }];
  });
}

function composerCommands(file: DiscoveredFile, warnings: string[]): TopologyCommand[] {
  let manifest: { scripts?: Record<string, unknown> };
  try {
    manifest = JSON.parse(file.raw) as typeof manifest;
  } catch {
    warnings.push("COMPOSER_MANIFEST_INVALID");
    return [];
  }
  if (manifest.scripts === undefined || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) return [];
  return Object.entries(manifest.scripts).map(([name, definition]) => ({
    id: `command_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    name,
    role: commandRole(name),
    source: file.relativePath,
    processProfile: {
      command: ["composer", "run", name],
      cwd: file.cwd,
      source: { kind: "composer-script" as const, manifestPath: file.relativePath, script: name, definitionSha256: digest(JSON.stringify(definition)) },
      maxRuntimeSeconds: 4 * 60 * 60,
    },
  }));
}

function makeCommands(file: DiscoveredFile): TopologyCommand[] {
  const seen = new Set<string>();
  const commands: TopologyCommand[] = [];
  for (const line of file.raw.split("\n")) {
    if (line.startsWith("\t") || line.trimStart().startsWith("#")) continue;
    const target = MAKEFILE_TARGET_RE.exec(line)?.[1];
    if (target === undefined || target.startsWith(".") || SPECIAL_MAKE_TARGETS.has(target) || seen.has(target)) continue;
    seen.add(target);
    commands.push({
      id: `command_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name: target,
      role: commandRole(target),
      source: file.relativePath,
      processProfile: {
        command: ["make", target],
        cwd: file.cwd,
        source: { kind: "make-target", manifestPath: file.relativePath, target, definitionSha256: file.sha256 },
        maxRuntimeSeconds: 4 * 60 * 60,
      },
    });
  }
  return commands;
}

export async function detectProjectTopology(
  workspace: AuthorizedWorkspace,
  overrides: Partial<TopologyDetectorLimits> = {},
): Promise<ProjectTopology> {
  const limits = { ...DEFAULT_TOPOLOGY_LIMITS, ...overrides };
  const walked = await walkWorkspace(workspace, limits);
  const warnings = [...walked.warnings];
  if (walked.files.some((file) => UNSUPPORTED_MANIFEST_NAMES.has(file.name))) warnings.push("UNSUPPORTED_ECOSYSTEM");
  const lockfiles: TopologyLockfile[] = walked.files
    .filter((file) => LOCKFILE_NAMES.has(file.name))
    .map((file) => ({ path: file.relativePath, cwd: file.cwd, manager: managerForLockfile(file.name), sha256: file.sha256 }));
  const manifestFiles = walked.files.filter((file) => MANIFEST_NAMES.has(file.name)).slice(0, limits.maxManifests);
  const manifests: TopologyManifest[] = manifestFiles.map((file) => ({
    kind: file.name === "package.json" ? "package" : file.name === "composer.json" ? "composer" : "make",
    path: file.relativePath,
    cwd: file.cwd,
    sha256: file.sha256,
  }));
  const commands = manifestFiles.flatMap((file) =>
    file.name === "package.json" ? packageCommands(file, lockfiles, warnings)
      : file.name === "composer.json" ? composerCommands(file, warnings)
        : makeCommands(file));
  const dependencies = dependencyCounts(manifestFiles);
  // Una raíz Git que contiene submódulos/repositorios anidados sigue siendo una
  // sola frontera autorizada. Solo dividimos cuando la carpeta elegida es un
  // contenedor y todos los repositorios detectados son hijos independientes.
  const splitGitRoots = walked.gitRoots.filter((root) => root !== ".");
  const topology = walked.gitRoots.length > 1 && !walked.gitRoots.includes(".") && splitGitRoots.length > 1
    ? "multi-repo"
    : manifests.length > 1
      ? "monorepo"
      : "single";
  return {
    topology,
    manifests,
    lockfiles,
    gitRoots: walked.gitRoots,
    commands,
    directDependencyCount: dependencies.production,
    directDevDependencyCount: dependencies.development,
    warnings: [...new Set(warnings)],
    truncated: walked.truncated || walked.files.filter((file) => MANIFEST_NAMES.has(file.name)).length > limits.maxManifests,
    scannedEntries: walked.scannedEntries,
  };
}
