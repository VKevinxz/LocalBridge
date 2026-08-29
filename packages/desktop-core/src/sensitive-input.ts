/**
 * Clasificación de campos sensibles del navegador controlado (ADR-0041).
 *
 * El agente nunca escribe credenciales: `browser.fill` rechaza el campo antes de
 * teclear nada. La clasificación decide qué es una credencial, así que un fallo
 * en cualquiera de los dos sentidos es un defecto real: bloquear un campo
 * inocente interrumpe el trabajo sin motivo, y dejar pasar uno sensible rompe la
 * garantía del producto.
 *
 * La versión anterior comparaba subcadenas sobre `name`/`id`/`aria-label`
 * concatenados, de modo que `secretaria` contenía `secret` y `wizard` contenía
 * `card`. Aquí se comparan **tokens**: la identidad se parte por separadores y
 * por camelCase antes de comparar, y las comparaciones son de token completo.
 *
 * Un `\b` sobre la cadena entera no habría servido: `_` es carácter de palabra,
 * así que `input_password` no habría coincidido, y `userPassword` tampoco.
 */

/** Tokens que, por sí solos, identifican una credencial. */
const SENSITIVE_TOKENS = new Set([
  "2fa",
  "apikey",
  "card",
  "cards",
  "clave",
  "claves",
  "contrasena",
  "contraseña",
  "contrasenia",
  "credit",
  "csc",
  "cvc",
  "cvn",
  "cvv",
  "mfa",
  "mnemonic",
  "otp",
  "pass",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "passwords",
  "pin",
  "privatekey",
  "pwd",
  "secret",
  "secreto",
  "secretos",
  "secrets",
  "seed",
  "ssn",
  "tarjeta",
  "tarjetas",
  "token",
  "tokens",
  "totp",
]);

/** Pares adyacentes que solo son sensibles juntos. */
const SENSITIVE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["access", "token"],
  ["api", "key"],
  ["clave", "acceso"],
  ["codigo", "seguridad"],
  ["codigo", "verificacion"],
  ["numero", "tarjeta"],
  ["private", "key"],
  ["security", "code"],
];

/**
 * Pares adyacentes que desactivan un token sensible: en español `clave` también
 * significa «término», y `palabra clave` es un buscador, no una credencial.
 */
const BENIGN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["palabra", "clave"],
  ["palabras", "clave"],
  ["word", "card"],
];

const SENSITIVE_AUTOCOMPLETE = /password|one-time-code|cc-|webauthn/;

/**
 * Parte una identidad en tokens comparables. Separa por cualquier carácter no
 * alfanumérico y por camelCase, incluidos los acrónimos (`CVVCode` → `cvv code`).
 */
export function identityTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Los sufijos numéricos son habituales (`txtPassword1`, `pwd2`) y no deben
    // esconder el token: se separan para comparar la parte alfabética.
    .replace(/([a-záéíóúüñ])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-záéíóúüñ])/gi, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúüñ]+/i)
    .filter((token) => token.length > 0);
}

export interface SensitiveInputCandidate {
  /** Atributo `type` del input, ya en minúsculas si existe. */
  readonly inputType?: string | undefined;
  readonly autocomplete?: string | undefined;
  /** `name`, `id`, `aria-label` y `placeholder` concatenados. */
  readonly identity?: string | undefined;
}

function hasPair(tokens: readonly string[], pairs: ReadonlyArray<readonly [string, string]>): boolean {
  return tokens.some((token, index) => pairs.some(([first, second]) => token === first && tokens[index + 1] === second));
}

/**
 * `true` cuando el campo debe rechazarse. Falla cerrado: ante una identidad que
 * contiene un token sensible se bloquea, salvo que forme un par explícitamente
 * benigno.
 */
export function isSensitiveInput(candidate: SensitiveInputCandidate): boolean {
  const inputType = (candidate.inputType ?? "text").toLowerCase();
  if (["password", "file", "hidden"].includes(inputType)) return true;
  if (SENSITIVE_AUTOCOMPLETE.test((candidate.autocomplete ?? "").toLowerCase())) return true;

  const tokens = identityTokens(candidate.identity ?? "");
  if (hasPair(tokens, SENSITIVE_PAIRS)) return true;

  const benign = new Set<number>();
  for (const [index, token] of tokens.entries()) {
    for (const [first, second] of BENIGN_PAIRS) {
      if (token === first && tokens[index + 1] === second) benign.add(index + 1);
    }
  }
  return tokens.some((token, index) => SENSITIVE_TOKENS.has(token) && !benign.has(index));
}
