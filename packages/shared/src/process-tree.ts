/**
 * Muerte de árbol de procesos, compartida entre `packages/validation` (matar un
 * perfil colgado o con salida infinita) y `packages/desktop-core` (desconectar
 * `tunnel-client`). Extraído aquí tras el segundo caso de uso genuino, mismo
 * criterio ya aplicado con el mutex y `buildFilteredEnv` en la Fase 5.
 *
 * Sin equivalente directo entre plataformas: en Windows, `taskkill /T` mata el
 * árbol como proceso aparte (no hay señal de "grupo" en `spawn`); en POSIX, el
 * hijo debe arrancar en su propio grupo (`detached: true`) para poder matarlo
 * con una señal al PID negativo.
 */

import { spawn } from "node:child_process";

export function killProcessTree(child: { pid?: number | undefined }, isWindows: boolean = process.platform === "win32"): void {
  if (child.pid === undefined) return;

  if (isWindows) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* ya había terminado */
    }
  }
}
