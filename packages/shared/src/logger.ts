/**
 * Logging operativo: JSON estructurado a stderr.
 *
 * Escribe a **stderr**, no a stdout, por dos motivos independientes:
 *
 * 1. En el transporte stdio, stdout es el canal del protocolo MCP. Un solo
 *    `console.log` corrompería el stream y rompería la conexión.
 * 2. La feature Logging de MCP quedó deprecada en la revisión 2026-07-28 y su
 *    migración recomendada es exactamente esto (ADR-0002).
 *
 * El logging operativo es efímero y sirve para depurar. La auditoría —evidencia
 * de qué hizo el agente— es un sistema separado que llegará en su fase.
 */

import type { Writable } from 'node:stream';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Claves cuyo valor nunca debe aparecer en un log (SECURITY.md §6.1).
 *
 * La comparación es por subcadena en minúsculas, de modo que `authToken`,
 * `AUTHORIZATION` y `user_password` quedan cubiertos por la misma entrada. Es
 * una red de seguridad, no una licencia para pasar secretos al logger: el
 * llamante sigue siendo responsable de no hacerlo.
 */
const REDACTED_KEY_PATTERNS = [
  'authorization',
  'content',
  'credential',
  'cookie',
  'key',
  'passphrase',
  'password',
  'secret',
  'session',
  'signature',
  'token',
] as const;

const REDACTED = '[REDACTED]';

/** Un valor de log largo se trunca: evita volcar payloads enteros a stderr. */
const MAX_VALUE_LENGTH = 512;
const MAX_DEPTH = 4;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Deriva un logger que añade `fields` a cada línea (por ejemplo `requestId`). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Destino. Por defecto `process.stderr`; los tests inyectan el suyo. */
  stream?: Writable;
  /** Campos presentes en todas las líneas. */
  base?: LogFields;
  /** Reloj inyectable para hacer deterministas los tests. */
  now?: () => Date;
}

function shouldRedact(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return REDACTED_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  // Un Error serializado con JSON.stringify pierde el mensaje y podría arrastrar
  // un stack: nos quedamos solo con el nombre.
  if (value instanceof Error) return { name: value.name };

  if (depth >= MAX_DEPTH) return '[depth-limit]';

  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    return sanitizeFields(value as LogFields, depth + 1);
  }

  // Funciones, símbolos y cualquier otra cosa no tienen sitio en un log.
  return '[unloggable]';
}

function sanitizeFields(fields: LogFields, depth = 0): LogFields {
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = shouldRedact(key) ? REDACTED : sanitizeValue(value, depth);
  }
  return output;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const stream = options.stream ?? process.stderr;
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_ORDER[level];

  function write(entryLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;

    const entry = {
      timestamp: now().toISOString(),
      level: entryLevel,
      message,
      ...sanitizeFields({ ...base, ...fields }),
    };

    // Un fallo del logger nunca puede tumbar una operación en curso.
    try {
      stream.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* ignorado deliberadamente */
    }
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childFields) =>
      createLogger({
        level,
        stream,
        base: { ...base, ...childFields },
        now,
      }),
  };
}
