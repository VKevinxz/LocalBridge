/** `workspace.tree` (TOOL_CATALOG.md §3). */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, type AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveAllowedPath } from "./guard.js";

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface WorkspaceTreeResult {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
  excluded: string[];
}

/** SECURITY.md amenaza G / SEC-012: cota dura de tiempo, no solo de tamaño. */
const TREE_TIMEOUT_MS = 5000;

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "vendor", "dist", "build", ".cache"]);

export async function buildWorkspaceTree(
  workspace: AuthorizedWorkspace,
  relativePath: string,
  requestedMaxDepth: number | undefined,
  requestedMaxEntries: number | undefined,
): Promise<WorkspaceTreeResult> {
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

  const displayPath = safe.relativePath === "" ? "." : safe.relativePath;

  // Apuntar el árbol a un archivo no es un error: simplemente no tiene hijos.
  if (!rootStats.isDirectory()) {
    return { path: displayPath, entries: [], truncated: false, excluded: [] };
  }

  const maxDepth = clamp(requestedMaxDepth, workspace.limits.maxTreeDepth);
  const maxEntries = clamp(requestedMaxEntries, workspace.limits.maxTreeEntries);

  const entries: TreeEntry[] = [];
  const excluded = new Set<string>();
  let truncated = false;

  async function walk(realDir: string, relDir: string, level: number): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(realDir, { withFileTypes: true });
    } catch {
      throw new LocalBridgeError("INTERNAL_ERROR");
    }

    const sortedDirents = dirents.toSorted((a, b) => a.name.localeCompare(b.name));

    for (const dirent of sortedDirents) {
      if (truncated) return;

      // Nunca se sigue un symlink dentro del árbol: ni se lista ni se desciende
      // por él. `file.read`/`file.metadata` hacen la verificación completa por
      // realpath cuando el agente apunta a una ruta concreta (SECURITY.md §3.3);
      // el árbol es solo un índice y no necesita pagar ese coste en cada nodo.
      if (dirent.isSymbolicLink()) continue;

      const entryRel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      if (isPathDenied(entryRel, workspace.denyPatterns)) continue;

      if (dirent.isDirectory()) {
        if (isExcludedDir(entryRel, dirent.name)) {
          excluded.add(dirent.name);
          continue;
        }
        entries.push({ path: entryRel, type: "dir" });
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (level < maxDepth) {
          // Secuencial a propósito: `truncated` se comprueba entrada a entrada
          // para parar en cuanto se alcanza maxEntries, en vez de listar todo el
          // subárbol antes de descartar el sobrante.
          // eslint-disable-next-line no-await-in-loop
          await walk(path.join(realDir, dirent.name), entryRel, level + 1);
        }
        continue;
      }

      if (dirent.isFile()) {
        let size: number | undefined;
        try {
          // eslint-disable-next-line no-await-in-loop -- ver comentario arriba
          size = (await stat(path.join(realDir, dirent.name))).size;
        } catch {
          continue; // desapareció entre el listado y el stat: se omite sin más
        }
        entries.push({ path: entryRel, type: "file", size });
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
      }
      // sockets, fifos y demás tipos especiales se omiten en silencio
    }
  }

  // `clearTimeout` en el `finally` es obligatorio: sin él, el temporizador del
  // perdedor de la carrera queda vivo hasta que dispara igualmente, aunque
  // `walk` ya haya terminado — un handle colgado por cada llamada.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      walk(safe.realPath, safe.relativePath, 1),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LocalBridgeError("TIMEOUT")), TREE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  return {
    path: displayPath,
    entries,
    truncated,
    excluded: Array.from(excluded).toSorted(),
  };
}

function isExcludedDir(entryRelativePath: string, basename: string): boolean {
  if (EXCLUDED_DIR_NAMES.has(basename)) return true;
  if (basename === "objects") {
    const segments = entryRelativePath.split("/");
    return segments.length >= 2 && segments[segments.length - 2] === ".git";
  }
  return false;
}

function clamp(requested: number | undefined, limit: number): number {
  if (requested === undefined) return limit;
  return Math.min(Math.max(requested, 1), limit);
}
