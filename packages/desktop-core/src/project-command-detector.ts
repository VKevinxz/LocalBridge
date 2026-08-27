/**
 * Detección de comandos declarados en un proyecto, para asistir al humano al
 * configurar `validationProfiles` desde la UI (ADR-0015, adenda).
 *
 * Principio deliberado: solo se ofrecen comandos que el propio proyecto **ya
 * declara por su nombre** en un manifiesto estándar (`scripts` de
 * `package.json`/`composer.json`, objetivos de un `Makefile`) — nunca comandos
 * inventados o adivinados para ecosistemas sin una lista declarada (Cargo,
 * pyproject.toml sueltos, etc.). Es solo una ayuda para rellenar el formulario;
 * el humano sigue siendo quien decide qué queda autorizado al guardar — esto
 * no cambia en nada la regla de que el modelo nunca aporta comandos en
 * tiempo real, solo hace menos tedioso el paso de configuración previa.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ProcessProfile } from "@localbridge/workspace";

export interface DetectedCommand {
  readonly name: string;
  readonly command: readonly string[];
  readonly source: string;
  readonly processProfile: ProcessProfile;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function scriptsFromManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const scripts = manifest["scripts"];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
  return scripts as Record<string, unknown>;
}

async function detectPackageManager(rootPath: string): Promise<string> {
  if (await fileExists(path.join(rootPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(rootPath, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(rootPath, "bun.lockb"))) return "bun";
  return "npm";
}

async function detectPackageJsonScripts(rootPath: string): Promise<DetectedCommand[]> {
  const manifest = await readJsonIfExists(path.join(rootPath, "package.json"));
  if (manifest === undefined) return [];

  const pm = await detectPackageManager(rootPath);
  const scripts = scriptsFromManifest(manifest);
  return Object.entries(scripts).map(([name, definition]) => {
    const command = [pm, "run", name] as const;
    return {
      name,
      command,
      source: `package.json (${pm})`,
      processProfile: {
        command,
        cwd: ".",
        source: {
          kind: "package-script" as const,
          manifestPath: "package.json" as const,
          script: name,
          definitionSha256: sha256(JSON.stringify(definition)),
        },
        maxRuntimeSeconds: 4 * 60 * 60,
      },
    };
  });
}

async function detectComposerScripts(rootPath: string): Promise<DetectedCommand[]> {
  const manifest = await readJsonIfExists(path.join(rootPath, "composer.json"));
  if (manifest === undefined) return [];

  const scripts = scriptsFromManifest(manifest);
  return Object.entries(scripts).map(([name, definition]) => {
    const command = ["composer", "run", name] as const;
    return {
      name,
      command,
      source: "composer.json",
      processProfile: {
        command,
        cwd: ".",
        source: {
          kind: "composer-script" as const,
          manifestPath: "composer.json" as const,
          script: name,
          definitionSha256: sha256(JSON.stringify(definition)),
        },
        maxRuntimeSeconds: 4 * 60 * 60,
      },
    };
  });
}

const MAKEFILE_TARGET_RE = /^([A-Za-z0-9_.-]+)\s*:(?!=)/;

/** Objetivos especiales de `make` (directivas, no comandos reales que ejecutar). */
const SPECIAL_TARGETS = new Set([
  ".PHONY",
  ".DEFAULT",
  ".SUFFIXES",
  ".PRECIOUS",
  ".INTERMEDIATE",
  ".SECONDARY",
  ".DELETE_ON_ERROR",
  ".IGNORE",
  ".SILENT",
  ".EXPORT_ALL_VARIABLES",
  ".NOTPARALLEL",
  ".ONESHELL",
  ".POSIX",
]);

async function detectMakefileTargets(rootPath: string): Promise<DetectedCommand[]> {
  let raw: string | undefined;
  let manifestPath: "Makefile" | "makefile" | "GNUmakefile" | undefined;
  for (const candidate of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      // Secuencial a propósito: se detiene en el primero que exista, no tiene sentido
      // paralelizar tres lecturas cuando a lo sumo una de ellas va a existir de verdad.
      // eslint-disable-next-line no-await-in-loop
      raw = await readFile(path.join(rootPath, candidate), "utf8");
      manifestPath = candidate as "Makefile" | "makefile" | "GNUmakefile";
      break;
    } catch {
      continue;
    }
  }
  if (raw === undefined || manifestPath === undefined) return [];

  const seen = new Set<string>();
  const results: DetectedCommand[] = [];

  for (const line of raw.split("\n")) {
    // Las líneas de receta empiezan con tab; no son declaraciones de objetivo.
    if (line.startsWith("\t") || line.trimStart().startsWith("#")) continue;

    const match = MAKEFILE_TARGET_RE.exec(line);
    const target = match?.[1];
    if (target === undefined || target.startsWith(".") || SPECIAL_TARGETS.has(target) || seen.has(target)) continue;

    seen.add(target);
    const command = ["make", target] as const;
    results.push({
      name: target,
      command,
      source: manifestPath,
      processProfile: {
        command,
        cwd: ".",
        source: {
          kind: "make-target",
          manifestPath,
          target,
          definitionSha256: sha256(raw),
        },
        maxRuntimeSeconds: 4 * 60 * 60,
      },
    });
  }

  return results;
}

/**
 * Nunca lanza: cada detector individual ya degrada a `[]` si el manifiesto no
 * existe o no se puede leer/parsear. Un proyecto sin ninguno de los tres
 * formatos reconocidos simplemente devuelve una lista vacía.
 */
export async function detectProjectCommands(rootPath: string): Promise<DetectedCommand[]> {
  const [pkgCommands, composerCommands, makeCommands] = await Promise.all([
    detectPackageJsonScripts(rootPath),
    detectComposerScripts(rootPath),
    detectMakefileTargets(rootPath),
  ]);

  return [...pkgCommands, ...composerCommands, ...makeCommands];
}
