import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_VERSION, TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { createHarness, resultResponses, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('protocolo MCP 2026-07-28', () => {
  it('server/discover anuncia la revisión moderna, la identidad y las capacidades', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const discovered = await harness.client.discover();

    // Este es el test que ata la constante TARGET_PROTOCOL_REVISION al
    // comportamiento real: si el SDK dejara de ofrecer 2026-07-28, falla aquí
    // en vez de que el servidor mienta en system.health.
    expect(discovered.supportedVersions).toContain(TARGET_PROTOCOL_REVISION);
    expect(discovered.capabilities?.tools).toBeDefined();
    expect(discovered._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });

  it('tools/list devuelve el catálogo en orden determinista', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const first = await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    const second = await harness.client.listTools(undefined, { cacheMode: 'bypass' });

    // La revisión 2026-07-28 pide orden determinista para poder cachear el
    // listado. El orden es alfabético (server.ts) y fija el contrato completo.
    expect(first.tools.map((tool) => tool.name)).toEqual([
      'application.list',
      'application.start',
      'application.status',
      'application.stop',
      'browser.human.request',
      'browser.human.status',
      'browser.click',
      'browser.events',
      'browser.fill',
      'browser.list',
      'browser.navigate',
      'browser.press',
      'browser.screenshot',
      'browser.snapshot',
      'browser.start',
      'browser.stop',
      'browser.viewport',
      'file.create',
      'file.delete',
      'file.metadata',
      'file.move',
      'file.read',
      'file.write_guarded',
      'git.branch',
      'git.commit',
      'git.diff',
      'git.log',
      'git.push',
      'git.stage',
      'git.status',
      'system.health',
      'process.list',
      'process.listeners',
      'process.logs',
      'process.start',
      'process.stop',
      'project.list',
      'project.setup.refresh',
      'project.setup.status',
      'terminal.read',
      'terminal.start',
      'terminal.status',
      'terminal.stop',
      'terminal.write',
      'validation.run',
      'workspace.list',
      'workspace.search',
      'workspace.tree',
    ]);
    expect(second.tools.map((tool) => tool.name)).toEqual(first.tools.map((tool) => tool.name));
  });

  it('tools/list viaja con los campos de caché de CacheableResult', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const result = await harness.client.listTools(undefined, { cacheMode: 'bypass' });

    expect(result.ttlMs).toBe(60_000);
    // Las descripciones de commit/push reflejan el modo de aprobación activo,
    // por lo que el catálogo no puede compartirse entre configuraciones.
    expect(result.cacheScope).toBe('private');
  });

  it('todos los resultados llevan resultType "complete" en el cable', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    await harness.client.callTool({ name: 'system.health', arguments: {} });

    const results = resultResponses(harness.sentByServer);

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result['resultType']).toBe('complete');
    }
  });

  it('system.health responde el estado, la versión y la revisión', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const result = await harness.client.callTool({ name: 'system.health', arguments: {} });

    expect(result.structuredContent).toEqual({
      status: 'ready',
      version: SERVER_VERSION,
      protocolRevision: TARGET_PROTOCOL_REVISION,
      gitApprovalMode: 'mrtr',
    });
  });

  it('describe de forma inequívoca el modo host y marca push como efecto externo', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, gitApprovalMode: 'host' });

    const result = await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    const commit = result.tools.find((tool) => tool.name === 'git.commit');
    const push = result.tools.find((tool) => tool.name === 'git.push');

    expect(commit?.description).toContain('native approval UI');
    expect(commit?.description).not.toContain('first call returns an input_required');
    expect(push?.annotations?.openWorldHint).toBe(true);
  });

  it('system.health no filtra información del host ni del filesystem', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const result = await harness.client.callTool({ name: 'system.health', arguments: {} });
    const serialized = JSON.stringify(result);

    // TOOL_CATALOG §1: es la primera tool alcanzable, su salida es el mínimo.
    expect(serialized).not.toMatch(/[A-Za-z]:\\/);
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('workspace');
  });

  it('rechaza una tool inexistente', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    await expect(harness.client.callTool({ name: 'shell.execute', arguments: {} })).rejects.toThrow();
  });

  it('sigue sirviendo clientes de la era legacy', async () => {
    // apps/server declara `legacy: 'serve'` a propósito: rechazar la era 2025
    // dejaría fuera a hosts MCP que aún no han migrado (ADR-0007, spike 1b).
    harness = await createHarness();

    const result = await harness.client.callTool({ name: 'system.health', arguments: {} });

    expect(result.structuredContent).toMatchObject({ status: 'ready' });
  });
});
