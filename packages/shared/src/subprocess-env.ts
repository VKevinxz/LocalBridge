/**
 * Entorno filtrado para subprocesos (SECURITY.md Amenaza F).
 *
 * Nunca se hereda `process.env` completo: evita que variables del servidor
 * (incluidas credenciales) lleguen a un proceso hijo, y hace determinista el
 * comportamiento del comando ejecutado. El llamante decide qué claves
 * adicionales necesita (p. ej. `GIT_TERMINAL_PROMPT` para Git) por encima de
 * este núcleo común.
 */

/** Mínimo para que un binario se resuelva y arranque en Windows, macOS y Linux. */
const CORE_ALLOWED_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
] as const;

export function buildFilteredEnv(extra: Readonly<Record<string, string>> = {}, additionalKeys: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };

  for (const key of [...CORE_ALLOWED_KEYS, ...additionalKeys]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
