/**
 * Configuración del proceso. Las tools nunca leen variables de entorno
 * directamente: todo pasa por aquí una sola vez (ADR-0012).
 */

import os from 'node:os';
import path from 'node:path';

import { LOG_LEVELS, type LogLevel } from './logger.js';

/**
 * Debe coincidir con la versión de `package.json`; hay un test que lo comprueba
 * para que no se separen silenciosamente.
 */
export const SERVER_VERSION = '1.1.0';

export const SERVER_NAME = 'localbridge-mcp';

export const GIT_APPROVAL_MODES = ['mrtr', 'host'] as const;
export type GitApprovalMode = (typeof GIT_APPROVAL_MODES)[number];

/**
 * Revisión del protocolo MCP a la que apunta el proyecto (ADR-0002).
 *
 * Se declara aquí a propósito. El SDK v2 exporta `LATEST_PROTOCOL_VERSION`,
 * pero su valor es `2025-11-25`: la última revisión de la era **legacy**. Las
 * constantes de la era moderna (`FIRST_MODERN_PROTOCOL_VERSION`) son internas
 * al SDK y no están exportadas, así que usar la exportada aquí haría que el
 * servidor anunciara una revisión que no es la que negocia.
 *
 * Hay un test de protocolo que comprueba contra `server/discover` que el
 * servidor ofrece realmente esta revisión, de modo que la constante no puede
 * separarse del comportamiento.
 */
export const TARGET_PROTOCOL_REVISION = '2026-07-28';

export interface ServerConfig {
  readonly name: string;
  readonly version: string;
  readonly logLevel: LogLevel;
  readonly workspaceConfigPath: string;
  readonly auditDbPath: string;
  /**
   * `mrtr` exige la confirmación firmada por el servidor. `host` delega la
   * interacción al cuadro nativo del host MCP (por ejemplo, ChatGPT).
   */
  readonly gitApprovalMode: GitApprovalMode;
  /** Broker privado creado por Electron; ambos deben existir para habilitar runtime V0.3. */
  readonly developmentBrokerEndpoint?: string;
  readonly developmentBrokerToken?: string;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return 'info';
  const candidate = raw.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(candidate) ? (candidate as LogLevel) : 'info';
}

function parseGitApprovalMode(raw: string | undefined): GitApprovalMode {
  if (raw === undefined) return 'mrtr';
  return (GIT_APPROVAL_MODES as readonly string[]).includes(raw) ? (raw as GitApprovalMode) : 'mrtr';
}

/**
 * Ruta por defecto del registro de workspaces (ADR-0012).
 *
 * Se calcula con `os.homedir()`, no con variables de entorno como `%APPDATA%`
 * o `XDG_CONFIG_HOME`: la Fase 1b tropezó justo con eso — el mismo binario de
 * `tunnel-client` resolvía dos directorios de configuración distintos según si
 * lo invocaba Git Bash o PowerShell, porque ambos exponen esas variables de
 * forma distinta. `os.homedir()` usa una API del sistema operativo, no el
 * entorno del shell, así que da el mismo resultado sin importar qué terminal
 * arranque el proceso.
 */
export function defaultWorkspaceConfigPath(): string {
  return path.join(os.homedir(), '.localbridge-mcp', 'workspaces.json');
}

/** Junto a `workspaces.json`, nunca dentro de un workspace autorizado (ADR-0009, ADR-0014). */
export function defaultAuditDbPath(): string {
  return path.join(os.homedir(), '.localbridge-mcp', 'audit.db');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const developmentBrokerEndpoint = env['LOCALBRIDGE_DEVELOPMENT_BROKER_ENDPOINT'];
  const developmentBrokerToken = env['LOCALBRIDGE_DEVELOPMENT_BROKER_TOKEN'];
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    logLevel: parseLogLevel(env['LOCALBRIDGE_LOG_LEVEL']),
    workspaceConfigPath: env['LOCALBRIDGE_WORKSPACES_FILE'] ?? defaultWorkspaceConfigPath(),
    auditDbPath: env['LOCALBRIDGE_AUDIT_DB_FILE'] ?? defaultAuditDbPath(),
    gitApprovalMode: parseGitApprovalMode(env['LOCALBRIDGE_GIT_APPROVAL_MODE']),
    ...(developmentBrokerEndpoint === undefined || developmentBrokerToken === undefined
      ? {}
      : { developmentBrokerEndpoint, developmentBrokerToken }),
  };
}
