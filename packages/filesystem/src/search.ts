/**
 * `workspace.search` (TOOL_CATALOG.md §3-bis, v2.3).
 *
 * Búsqueda de subcadena **literal**, no de expresión regular. Decisión
 * deliberada, no una limitación temporal: una regex arbitraria aportada por
 * el agente puede exhibir backtracking catastrófico (ReDoS) sobre una sola
 * línea corta, y a diferencia de `walk()` (que puede cederle el control al
 * `Promise.race` del timeout entre `await`), una llamada síncrona a
 * `RegExp.test` bloquea el bucle de eventos hasta que termina — el timeout de
 * esta misma función no podría interrumpirla. Igual que `toGitPathspec` evita
 * la magia de pathspec con `:(literal)`, aquí se evita la clase de
 * vulnerabilidad entera en vez de intentar acotarla con límites de longitud
 * (que no protegen: un ReDoS clásico cuelga con una entrada de ~30
 * caracteres).
 */

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, type AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceSearchResult {
  matches: SearchMatch[];
  filesScanned: number;
  truncated: boolean;
}

/** SECURITY.md amenaza G: cota dura de tiempo, igual que `workspace.tree`. */
const SEARCH_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESULTS = 200;
const MAX_RESULTS_CEILING = 1000;
/** Las líneas coincidentes se truncan en el resultado; no afecta a qué cuenta como match. */
const MAX_LINE_LENGTH = 2000;
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "vendor", "dist", "build", ".cache"]);
/** Mismo umbral de sniffing que usan `git`/`grep`: un NUL en los primeros bytes basta para tratar el archivo como binario. */
const BINARY_SNIFF_BYTES = 8000;

export async function searchWorkspace(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  query: string,
  caseSensitive: boolean,
  requestedMaxResults: number | undefined,
): Promise<WorkspaceSearchResult> {
  if (query.length === 0) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "empty query" });
  }

  const safe = await resolveAllowedPath(workspace, relativePath);
  if (!safe.exists) {
    throw new LocalBridgeError("FILE_NOT_FOUND");
  }

  let rootStats;
  try {
    rootStats = await stat(safe.realPath);
  } catch {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  const maxResults = clamp(requestedMaxResults, MAX_RESULTS_CEILING, DEFAULT_MAX_RESULTS);
  const needle = caseSensitive ? query : query.toLowerCase();

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  async function scanFile(realFilePath: string, relFilePath: string): Promise<void> {
    let stats;
    try {
      stats = await stat(realFilePath);
    } catch {
      return;
    }
    // Mismo invariante que file.read/file.metadata: nunca se carga en memoria
    // un archivo que excede el techo del workspace.
    if (!stats.isFile() || stats.size > workspace.limits.maxFileBytes) return;

    let buffer: Buffer;
    try {
      buffer = await readFile(realFilePath);
    } catch {
      return;
    }
    if (looksBinary(buffer)) return;

    filesScanned += 1;
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (truncated) return;
      const line = lines[index] ?? "";
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (haystack.includes(needle)) {
        matches.push({
          path: relFilePath,
          line: index + 1,
          text: line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line,
        });
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
      }
    }
  }

  async function walk(realDir: string, relDir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(realDir, { withFileTypes: true });
    } catch {
      return;
    }

    const sortedDirents = dirents.toSorted((a, b) => a.name.localeCompare(b.name));

    for (const dirent of sortedDirents) {
      if (truncated) return;

      // Mismo posicionamiento que workspace.tree: nunca se sigue un symlink.
      if (dirent.isSymbolicLink()) continue;

      const entryRel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      if (isPathDenied(entryRel, workspace.denyPatterns)) continue;

      if (dirent.isDirectory()) {
        if (isExcludedDir(entryRel, dirent.name)) continue;
        // eslint-disable-next-line no-await-in-loop -- secuencial a propósito, ver workspace.tree
        await walk(path.join(realDir, dirent.name), entryRel);
        continue;
      }

      if (dirent.isFile()) {
        // eslint-disable-next-line no-await-in-loop -- secuencial a propósito, ver workspace.tree
        await scanFile(path.join(realDir, dirent.name), entryRel);
      }
    }
  }

  const displayPath = safe.relativePath === "" ? "." : safe.relativePath;

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      rootStats.isDirectory() ? walk(safe.realPath, safe.relativePath) : scanFile(safe.realPath, displayPath),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LocalBridgeError("TIMEOUT")), SEARCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  return { matches, filesScanned, truncated };
}

function looksBinary(buffer: Buffer): boolean {
  const sniffLength = Math.min(buffer.byteLength, BINARY_SNIFF_BYTES);
  for (let index = 0; index < sniffLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function isExcludedDir(entryRelativePath: string, basename: string): boolean {
  if (EXCLUDED_DIR_NAMES.has(basename)) return true;
  if (basename === "objects") {
    const segments = entryRelativePath.split("/");
    return segments.length >= 2 && segments[segments.length - 2] === ".git";
  }
  return false;
}

function clamp(requested: number | undefined, ceiling: number, fallback: number): number {
  if (requested === undefined) return fallback;
  return Math.min(Math.max(requested, 1), ceiling);
}
