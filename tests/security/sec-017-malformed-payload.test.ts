import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { createLogger, loadConfig } from '@localbridge/shared';
import { createMcpServer } from '@localbridge/mcp-server';

import { NO_WORKSPACES_CONFIG_PATH } from '../helpers/harness.js';

/**
 * [SEC-017] Payload MCP malformado.
 *
 * Un cliente hostil —o simplemente roto— puede escribir basura en el canal. Lo
 * que se comprueba aquí no es que el servidor entienda la basura, sino que:
 *
 *   1. no filtra rutas absolutas ni stack traces en lo que devuelve;
 *   2. no se muere: una petición válida posterior sigue siendo atendida.
 *
 * El segundo punto es el que convierte un fallo de parseo en un incidente de
 * disponibilidad si se implementa mal.
 */

interface Fixture {
  stdin: PassThrough;
  handle: StdioServerHandle;
  transportErrors: Error[];
  stdoutText(): string;
  stdoutMessages(): Array<Record<string, unknown>>;
}

let fixture: Fixture | undefined;

function createStdioFixture(): Fixture {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

  const transportErrors: Error[] = [];
  // Nunca el ~/.localbridge-mcp/audit.db real (ver harness.ts).
  const config = { ...loadConfig(), auditDbPath: path.join(os.tmpdir(), '.localbridge-mcp-test-harness', `audit-${randomUUID()}.db`) };
  const logger = createLogger({ level: 'error' });

  const handle = serveStdio(() => createMcpServer({ config, logger, workspaceConfigPath: NO_WORKSPACES_CONFIG_PATH }), {
    transport: new StdioServerTransport(stdin, stdout),
    onerror: (error) => transportErrors.push(error),
  });

  const stdoutText = (): string => chunks.join('');

  return {
    stdin,
    handle,
    transportErrors,
    stdoutText,
    stdoutMessages: () =>
      stdoutText()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Da tiempo al transporte a procesar lo escrito en stdin. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/**
 * `_meta` de una petición de la era moderna. Va dentro de `params`, no en la
 * raíz del mensaje: sin él la conexión se sirve como era legacy y métodos como
 * `server/discover` no existen.
 */
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'localbridge-security-test', version: '0.0.0' },
};

afterEach(async () => {
  await fixture?.handle.close();
  fixture = undefined;
});

describe('[SEC-017] payload MCP malformado', () => {
  it('no filtra rutas absolutas ni stack traces ante JSON inválido', async () => {
    fixture = createStdioFixture();

    fixture.stdin.write('esto no es json\n');
    fixture.stdin.write('{"jsonrpc": "2.0", "id": 1, \n');
    fixture.stdin.write('[]\n');
    await settle();

    const output = fixture.stdoutText();

    expect(output).not.toMatch(/[A-Za-z]:\\/);
    expect(output).not.toContain('/home/');
    expect(output).not.toContain('node_modules');
    expect(output).not.toMatch(/\bat\s+\w+\s+\(/);
    expect(output).not.toContain('.ts:');
  });

  it('no contesta nada a un texto que no es JSON', async () => {
    fixture = createStdioFixture();

    fixture.stdin.write('esto no es json\n');
    await settle();

    // Contestar a basura no aportaría nada a un emisor legítimo y le daría a
    // uno hostil una señal gratuita.
    expect(fixture.stdoutText()).toBe('');
    expect(fixture.transportErrors).toEqual([]);
  });

  it('un JSON válido que no es un mensaje JSON-RPC se reporta fuera de banda', async () => {
    fixture = createStdioFixture();

    fixture.stdin.write('[]\n');
    await settle();

    // Comportamiento real del SDK: el fallo de validación llega por `onerror`,
    // no al cliente. Es la separación correcta —el emisor no recibe detalle
    // interno— y es lo que hace que el logger, que reduce los Error a su
    // nombre, sea la última barrera contra la filtración.
    expect(fixture.stdoutText()).toBe('');
    expect(fixture.transportErrors.length).toBeGreaterThan(0);
    expect(fixture.stdoutText()).not.toContain('ZodError');
  });

  it('sigue atendiendo peticiones válidas después de la basura', async () => {
    fixture = createStdioFixture();

    fixture.stdin.write('basura total\n');
    fixture.stdin.write('{"jsonrpc": "2.0", "id": 1, \n');
    await settle();

    fixture.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'probe-1',
        method: 'server/discover',
        params: { _meta: MODERN_META },
      })}\n`,
    );
    await settle();

    const discover = fixture.stdoutMessages().find((message) => message['id'] === 'probe-1');

    // Un fallo de parseo no puede convertirse en una caída de disponibilidad.
    expect(discover).toBeDefined();
    expect(discover?.['result']).toBeDefined();
  });

  it('responde con un error JSON-RPC limpio a un método desconocido', async () => {
    fixture = createStdioFixture();

    fixture.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'probe-2',
        method: 'workspace.destroyEverything',
        params: { _meta: MODERN_META },
      })}\n`,
    );
    await settle();

    const response = fixture.stdoutMessages().find((message) => message['id'] === 'probe-2');
    const error = response?.['error'] as { code?: number; message?: string } | undefined;

    expect(error).toBeDefined();
    expect(error?.code).toBe(-32601);
    expect(error?.message ?? '').not.toMatch(/[A-Za-z]:\\/);
    expect(JSON.stringify(response)).not.toMatch(/\bat\s+\w+\s+\(/);
  });
});
