/**
 * Ejecución de Git (SECURITY.md Amenaza F, TOOL_CATALOG.md §8).
 *
 * Invariante del módulo: **el modelo nunca aporta el binario, ni una cadena de
 * comando, ni un flag.** Cada operación de `packages/git` construye su propio
 * array de argumentos literal; lo único que puede venir del agente son valores
 * acotados (una ruta ya validada por el sandbox, un número acotado), y siempre
 * pasan después de `--` para que Git no pueda interpretarlos como opciones.
 *
 * `shell: false` no es negociable: sin intérprete de shell en el camino, los
 * metacaracteres (`;`, `&&`, `$(...)`, backticks) son bytes literales sin
 * significado — es lo que hace que SEC-013 se cumpla por construcción y no por
 * filtrado.
 */

import { spawn } from "node:child_process";

import { LocalBridgeError, buildFilteredEnv, killProcessTreeAndWait } from "@localbridge/shared";

/** Cota dura por operación: un repositorio patológico no puede colgar el servidor. */
const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_TIMEOUT_MS = 5 * 60_000;

/** Techo de salida por operación; el llamante puede pedir menos, nunca más. */
const MAX_OUTPUT_BYTES = 1_048_576;

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface RunGitOptions {
  cwd: string;
  /** Techo de bytes de stdout. Se acota al máximo del módulo. */
  maxBytes?: number;
  /** Presupuesto interno por clase de operación; nunca procede de una tool MCP. */
  timeoutMs?: number;
}

/**
 * Variables propias de Git por encima del núcleo común de `buildFilteredEnv`:
 * sin prompts interactivos que dejarían el proceso colgado hasta el timeout,
 * sin pager, sin locks optativos, salida en un locale predecible para parsear.
 */
function buildGitEnv(): NodeJS.ProcessEnv {
  return buildFilteredEnv({
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  });
}

export async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitRunResult> {
  const maxBytes = Math.min(options.maxBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? GIT_TIMEOUT_MS, MAX_GIT_TIMEOUT_MS));
  // `core.fsmonitor` puede apuntar a un hook/programa definido en la config
  // local del repositorio. Ninguna operación de LocalBridge necesita ese
  // acelerador, así que se desactiva para todos los subcomandos.
  const safeArgs = ["-c", "core.fsmonitor=false", ...args];

  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn("git", safeArgs, {
      cwd: options.cwd,
      shell: false, // ver comentario de cabecera: no negociable
      env: buildGitEnv(),
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let terminationPromise: Promise<void> | undefined;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminationPromise = killProcessTreeAndWait(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) {
        truncated = true;
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
      if (stdoutBytes >= maxBytes) {
        truncated = true;
      }
    });

    // stderr se acota con un techo propio y pequeño: solo interesa para
    // clasificar el error, nunca se devuelve entero al cliente.
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 8192) return;
      stderrBytes += chunk.byteLength;
      stderrChunks.push(chunk);
    });

    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) await terminationPromise;
      reject(timedOut ? new LocalBridgeError("TIMEOUT") : isEnoent(error) ? new LocalBridgeError("COMMAND_NOT_ALLOWED") : new LocalBridgeError("INTERNAL_ERROR"));
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        await terminationPromise;
        reject(new LocalBridgeError("TIMEOUT"));
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks).subarray(0, maxBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? -1,
        truncated,
      });
    });
  });
}

/**
 * Ejecuta Git y traduce un fallo a error de dominio.
 *
 * Un `exitCode` distinto de cero en Git casi siempre significa "no es un
 * repositorio" en el contexto de esta fase (solo lectura, argumentos fijos), y
 * el resto de fallos no deben exponer el stderr crudo al cliente.
 */
export async function runGitChecked(args: readonly string[], options: RunGitOptions): Promise<GitRunResult> {
  const result = await runGit(args, options);

  if (result.exitCode !== 0) {
    if (/not a git repository|no está en un repositorio|unsafe repository/i.test(result.stderr)) {
      throw new LocalBridgeError("GIT_NOT_REPOSITORY");
    }
    throw new LocalBridgeError("INTERNAL_ERROR", { exitCode: result.exitCode });
  }

  return result;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "ENOENT";
}
