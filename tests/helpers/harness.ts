import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type ElicitRequest, type ElicitResult, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createLogger, loadConfig, type GitApprovalMode, type LogLevel } from '@localbridge/shared';
import { createMcpServer } from '@localbridge/mcp-server';

/**
 * Ruta que nunca existe: los tests que no fijan `workspaceConfigPath` reciben un
 * registro vacío de forma determinista, sin depender del estado real de la
 * máquina que ejecuta la suite (nunca `~/.localbridge-mcp/workspaces.json`).
 */
export const NO_WORKSPACES_CONFIG_PATH = path.join(os.tmpdir(), '.localbridge-mcp-test-harness', 'workspaces.json');

/**
 * Arnés de pruebas: cliente y servidor reales unidos por transportes en memoria.
 *
 * El servidor se levanta a través de `serveStdio`, no de `McpServer.connect`.
 * Es un detalle con consecuencias: la negociación de era pertenece al *entry
 * point*, así que un servidor conectado directamente sólo habla la era legacy y
 * `server/discover` no existiría. Probar por `serveStdio` es lo que hace que
 * estos tests ejerciten el mismo camino que `apps/server`.
 */

export interface Harness {
  client: Client;
  /** Mensajes JSON-RPC emitidos por el servidor, tal y como van al cable. */
  sentByServer: JSONRPCMessage[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Revisión a fijar en el cliente. `undefined` deja la negociación legacy por defecto. */
  pinProtocol?: string;
  logLevel?: LogLevel;
  /** Por defecto, una ruta que nunca existe (registro vacío, determinista). */
  workspaceConfigPath?: string;
  /**
   * Por defecto, una ruta nueva y única por llamada — nunca `~/.localbridge-mcp/audit.db`
   * del usuario real. Sin esto, la suite completa escribiría auditoría de test
   * sobre el fichero real, y ejecuciones en paralelo competirían por el mismo
   * SQLite (ver el hallazgo de `busy_timeout` documentado en `STATUS.md`).
   */
  auditDbPath?: string;
  /** Sobrescribe el modo fail-closed por defecto sólo para el escenario probado. */
  gitApprovalMode?: GitApprovalMode;
  developmentBrokerEndpoint?: string;
  developmentBrokerToken?: string;
  /**
   * Handler de `elicitation/create` para tests de MRTR (ADR-0016): si se pasa,
   * el cliente declara la capacidad `elicitation` y lo registra antes de
   * conectar, de forma que `client.callTool()` auto-resuelve un
   * `input_required` de aprobación exactamente como lo haría un host real
   * (Claude Code, ChatGPT). Sin esto (el caso por defecto de todos los demás
   * tests), el cliente no declara la capacidad y un `input_required` sin
   * resolver se convierte en un error tipado — el comportamiento correcto
   * para una tool que no debería pedir nunca aprobación.
   */
  elicitHandler?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    auditDbPath: options.auditDbPath ?? path.join(os.tmpdir(), '.localbridge-mcp-test-harness', `audit-${randomUUID()}.db`),
    gitApprovalMode: options.gitApprovalMode ?? baseConfig.gitApprovalMode,
    ...(options.developmentBrokerEndpoint === undefined || options.developmentBrokerToken === undefined
      ? {}
      : {
          developmentBrokerEndpoint: options.developmentBrokerEndpoint,
          developmentBrokerToken: options.developmentBrokerToken,
        }),
  };
  // Los logs de las pruebas se descartan: sólo interesa el comportamiento del
  // protocolo, y stderr limpio hace legible la salida de vitest.
  const logger = createLogger({ level: options.logLevel ?? 'error' });
  const workspaceConfigPath = options.workspaceConfigPath ?? NO_WORKSPACES_CONFIG_PATH;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const sentByServer: JSONRPCMessage[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, sendOptions) => {
    sentByServer.push(message);
    await originalSend(message, sendOptions);
  };

  const handle = serveStdio(() => createMcpServer({ config, logger, workspaceConfigPath }), {
    transport: serverTransport,
  });

  const client = new Client(
    { name: 'localbridge-test-client', version: '0.0.0' },
    {
      ...(options.pinProtocol === undefined ? {} : { versionNegotiation: { mode: { pin: options.pinProtocol } } }),
      ...(options.elicitHandler === undefined ? {} : { capabilities: { elicitation: {} } }),
    },
  );

  if (options.elicitHandler !== undefined) {
    client.setRequestHandler('elicitation/create', async (request) => options.elicitHandler!(request));
  }

  await client.connect(clientTransport);

  return {
    client,
    sentByServer,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

/** Respuestas JSON-RPC con resultado (descarta notificaciones y errores). */
export function resultResponses(messages: JSONRPCMessage[]): Array<Record<string, unknown>> {
  return messages
    .filter((message): message is JSONRPCMessage & { result: Record<string, unknown> } => {
      return typeof message === 'object' && message !== null && 'result' in message;
    })
    .map((message) => message.result);
}
