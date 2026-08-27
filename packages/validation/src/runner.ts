/**
 * Ejecución de perfiles de validación (SECURITY.md §13/Amenaza F, TOOL_CATALOG.md §9).
 *
 * Invariante del módulo, igual que en `packages/git`: **el modelo nunca aporta
 * el comando.** Solo elige un nombre de perfil; el binario y los argumentos
 * vienen de la configuración del workspace, nunca de la entrada de la tool.
 *
 * Diferencia deliberada con `packages/git/src/runner.ts`, que no se comparte
 * pese al paralelismo: aquí el comando puede ser cualquier cosa que el usuario
 * haya preaprobado (`pnpm test`, un build, …), y esas herramientas suelen
 * generar sus propios procesos hijos (workers de test, compiladores). Matar
 * solo el proceso de primer nivel dejaría huérfanos corriendo indefinidamente
 * tras un timeout — por eso este runner mata el **árbol completo**.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { LocalBridgeError, buildFilteredEnv, killProcessTree } from "@localbridge/shared";

/** Presupuesto de ingeniería para un perfil real (test/build), más generoso que el de Git. */
const VALIDATION_TIMEOUT_MS = 120_000;

/** Mismo techo para stdout y stderr: en una validación, stderr suele ser donde vive el fallo. */
const MAX_OUTPUT_BYTES = 1_048_576;

export interface ValidationRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface RunValidationOptions {
  cwd: string;
}

/**
 * Entorno para herramientas de desarrollo (pnpm/npm/node y similares): el
 * núcleo común más las variables que ese ecosistema necesita para resolver su
 * caché e instalación en Windows.
 */
function buildValidationEnv(): NodeJS.ProcessEnv {
  return buildFilteredEnv({}, ["APPDATA", "LOCALAPPDATA", "PNPM_HOME", "NPM_CONFIG_USERCONFIG"]);
}

/**
 * En Windows, `npm`/`npx`/`pnpm`/`yarn` son ficheros `.cmd`, no ejecutables
 * nativos. Desde el arreglo de Node para CVE-2024-27980 (inyección de
 * comandos vía `.bat`/`.cmd`), `CreateProcess` sin shell los rechaza sin
 * excepción — hace falta `cmd.exe` para lanzarlos. Encontrado en producción:
 * cualquier perfil de validación basado en un gestor de paquetes de Node
 * devolvía `COMMAND_NOT_ALLOWED` (el `ENOENT` del spawn se traduce a ese
 * código) aunque estuviera bien configurado.
 *
 * La detección es **por resolución en PATH**, no "shell siempre en Windows":
 * activar el shell a ciegas reinterpreta también los binarios que ya
 * funcionan bien tal cual (p. ej. `node.exe`, cuya ruta con espacios —
 * `C:\Program Files\nodejs\node.exe` — `cmd.exe` puede trocear mal si no se
 * cita exactamente como Node lo citaría sin shell). Solo se activa el shell
 * para el `.cmd`/`.bat` real que lo necesita; todo lo demás sigue exactamente
 * igual que antes.
 */
function resolvesToWindowsScriptShim(binary: string): boolean {
  const explicitExt = path.extname(binary).toLowerCase();
  if (explicitExt === ".cmd" || explicitExt === ".bat") return true;
  if (explicitExt !== "") return false;

  // Una ruta explícita (con separador) no se busca en PATH — Windows tampoco lo hace.
  if (binary.includes("/") || binary.includes("\\")) return false;

  const pathDirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(path.delimiter);
  return pathDirs.some(
    (dir) => dir !== "" && (existsSync(path.join(dir, `${binary}.cmd`)) || existsSync(path.join(dir, `${binary}.bat`))),
  );
}

export async function runValidationCommand(
  command: readonly string[],
  options: RunValidationOptions,
): Promise<ValidationRunResult> {
  const [binary, ...args] = command;
  if (binary === undefined) {
    // Un perfil con comando vacío no debería existir (el schema del registro
    // ya lo exige no-vacío), pero si llegara, es un fallo de configuración,
    // no una entrada del agente.
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  const startedAt = Date.now();
  const isWindows = process.platform === "win32";

  // Ver `resolvesToWindowsScriptShim`: el shell solo se activa para el
  // `.cmd`/`.bat` concreto que lo necesita, nunca a ciegas para todo Windows.
  // No reabre la Amenaza F — el array de comando es config estática del
  // workspace (ADR-0004), el agente solo elige el *nombre* del perfil, nunca
  // aporta ni un token del comando, así que no hay ninguna cadena de origen
  // no confiable que llegue al intérprete de `cmd.exe`.
  const useShell = isWindows && resolvesToWindowsScriptShim(binary);

  return new Promise<ValidationRunResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      shell: useShell,
      env: buildValidationEnv(),
      windowsHide: true,
      // En POSIX el hijo lidera su propio grupo de procesos, para poder matar
      // el árbol entero con una señal al grupo (PID negativo). En Windows no
      // hay equivalente vía `spawn`; se usa `taskkill /T` más abajo.
      detached: !isWindows,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let killedForTruncation = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      killProcessTree(child, isWindows);
      reject(new LocalBridgeError("TIMEOUT"));
      settled = true;
    }, VALIDATION_TIMEOUT_MS);

    /** Devuelve el nuevo total de bytes acumulados para ese flujo; el llamante lo guarda. */
    function handleChunk(chunk: Buffer, chunks: Buffer[], bytesSoFar: number): number {
      if (bytesSoFar >= MAX_OUTPUT_BYTES) {
        truncated = true;
        // Salida infinita (SEC-019): en vez de esperar los 120 s completos,
        // se corta el árbol en cuanto se confirma que hay más de lo que cabe.
        if (!killedForTruncation) {
          killedForTruncation = true;
          killProcessTree(child, isWindows);
        }
        return bytesSoFar;
      }
      chunks.push(chunk);
      const next = bytesSoFar + chunk.byteLength;
      if (next >= MAX_OUTPUT_BYTES) truncated = true;
      return next;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = handleChunk(chunk, stdoutChunks, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = handleChunk(chunk, stderrChunks, stderrBytes);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(isEnoent(error) ? new LocalBridgeError("COMMAND_NOT_ALLOWED") : new LocalBridgeError("INTERNAL_ERROR"));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "ENOENT";
}
