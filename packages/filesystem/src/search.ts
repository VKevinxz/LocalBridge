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

import { readdir, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, type AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";
import { openWorkspaceArtifactSource } from "./artifact-source.js";

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

export interface WorkspaceSearchOptions {
  /** Solo para presupuestos internos y tests; nunca procede de la entrada MCP. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
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

class TextDecodingError extends Error {}

function decodeText(decoder: TextDecoder, bytes?: Buffer): string {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
  } catch (error) {
    // TextDecoder usa TypeError para bytes inválidos. Se transforma aquí para
    // no confundirlo con un TypeError de I/O, del gateway o de la búsqueda.
    throw new TextDecodingError('invalid text encoding', { cause: error });
  }
}

export async function searchWorkspace(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  query: string,
  caseSensitive: boolean,
  requestedMaxResults: number | undefined,
  options: WorkspaceSearchOptions = {},
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
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const requireTime = (): void => {
    if (now() >= deadline) throw new LocalBridgeError("TIMEOUT");
  };

  async function scanFile(relFilePath: string): Promise<void> {
    requireTime();
    const safeFile = await resolveAllowedPath(workspace, relFilePath);
    if (!safeFile.exists) return;
    let stats;
    try {
      stats = await stat(safeFile.realPath);
    } catch {
      return;
    }
    requireTime();
    if (!stats.isFile()) return;
    const policy = workspace.limits.largeArtifacts;
    if (stats.size > workspace.limits.maxFileBytes &&
        (policy.mode === "standard" || (policy.mode === "custom" && stats.size > policy.customSourceBytes))) return;

    // El gateway vuelve a resolver la ruta, abre un handle estable, aplica la
    // política local y comprueba identidad durante el recorrido.
    const source = await openWorkspaceArtifactSource(workspace, relFilePath, {
      standardLimitBytes: workspace.limits.maxFileBytes,
    });
    let decoder: TextDecoder | undefined;
    let firstChunk = true;
    let lineNumber = 1;
    let preview = "";
    let normalizedTail = "";
    let lineMatched = false;
    const tailLength = Math.max(0, needle.length - 1);
    const consume = (fragment: string): void => {
      if (preview.length < MAX_LINE_LENGTH) preview += fragment.slice(0, MAX_LINE_LENGTH - preview.length);
      const normalized = caseSensitive ? fragment : fragment.toLowerCase();
      const searchable = normalizedTail + normalized;
      if (searchable.includes(needle)) lineMatched = true;
      normalizedTail = tailLength === 0 ? "" : searchable.slice(-tailLength);
    };
    const finishLine = (): void => {
      if (lineMatched) {
        matches.push({ path: relFilePath, line: lineNumber, text: preview });
        if (matches.length >= maxResults) truncated = true;
      }
      lineNumber += 1;
      preview = "";
      normalizedTail = "";
      lineMatched = false;
    };
    const consumeText = (text: string): void => {
      let start = 0;
      while (true) {
        const newline = text.indexOf("\n", start);
        if (newline === -1) {
          consume(text.slice(start));
          return;
        }
        consume(text.slice(start, newline));
        finishLine();
        if (truncated) return;
        start = newline + 1;
      }
    };
    try {
      for await (const rawChunk of source.readSequential()) {
        requireTime();
        let chunk = rawChunk;
        if (firstChunk) {
          firstChunk = false;
          if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
            decoder = new TextDecoder("utf-16le", { fatal: true });
            chunk = chunk.subarray(2);
          } else if (chunk.length >= 2 && chunk[0] === 0xfe && chunk[1] === 0xff) {
            decoder = new TextDecoder("utf-16be", { fatal: true });
            chunk = chunk.subarray(2);
          } else {
            if (looksBinary(chunk)) return;
            decoder = new TextDecoder("utf-8", { fatal: true });
            if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) chunk = chunk.subarray(3);
          }
          filesScanned += 1;
        }
        const activeDecoder = decoder;
        if (activeDecoder === undefined) throw new LocalBridgeError('INTERNAL_ERROR');
        consumeText(decodeText(activeDecoder, chunk));
        if (truncated) return;
      }
      if (decoder === undefined) {
        filesScanned += 1;
      } else {
        consumeText(decodeText(decoder));
      }
      if (!truncated && (preview.length > 0 || normalizedTail.length > 0 || lineMatched)) finishLine();
      await source.assertStable();
    } catch (error) {
      if (error instanceof TextDecodingError) return; // codificación declarada inválida: se trata como binario
      throw error;
    } finally {
      await source.close();
    }
  }

  async function walk(relDir: string): Promise<void> {
    requireTime();
    const safeDir = await resolveAllowedPath(workspace, relDir === "" ? "." : relDir);
    if (!safeDir.exists) return;
    let dirents;
    try {
      dirents = await readdir(safeDir.realPath, { withFileTypes: true });
    } catch {
      return;
    }
    requireTime();

    const sortedDirents = dirents.toSorted((a, b) => a.name.localeCompare(b.name));

    for (const dirent of sortedDirents) {
      requireTime();
      if (truncated) return;

      // Mismo posicionamiento que workspace.tree: nunca se sigue un symlink.
      if (dirent.isSymbolicLink()) continue;

      const entryRel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      if (isPathDenied(entryRel, workspace.denyPatterns)) continue;

      if (dirent.isDirectory()) {
        if (isExcludedDir(entryRel, dirent.name)) continue;
        // eslint-disable-next-line no-await-in-loop -- secuencial a propósito, ver workspace.tree
        await walk(entryRel);
        continue;
      }

      if (dirent.isFile()) {
        // eslint-disable-next-line no-await-in-loop -- secuencial a propósito, ver workspace.tree
        await scanFile(entryRel);
      }
    }
  }

  const displayPath = safe.relativePath === "" ? "." : safe.relativePath;

  requireTime();
  try {
    await (rootStats.isDirectory() ? walk(safe.relativePath) : scanFile(displayPath));
  } catch (error) {
    if (error instanceof LocalBridgeError && error.code === "TIMEOUT" && filesScanned > 0) {
      truncated = true;
    } else {
      throw error;
    }
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
