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
    // listado. El orden estable por familias (server.ts) fija el contrato completo.
    expect(first.tools.map((tool) => tool.name)).toEqual([
      'application.list',
      'application.start',
      'application.status',
      'application.stop',
      'browser.assert',
      'browser.action.capture',
      'browser.click',
      'browser.dialog',
      'browser.drag',
      'browser.events',
      'browser.fill',
      'browser.hover',
      'browser.human.request',
      'browser.human.status',
      'browser.inspect',
      'browser.keyboard.sequence',
      'browser.list',
      'browser.motion.capture',
      'browser.motion.inspect',
      'browser.navigate',
      'browser.reload',
      'browser.press',
      'browser.scroll',
      'browser.select',
      'browser.screenshot',
      'browser.screenshot.save',
      'browser.snapshot',
      'browser.start',
      'browser.stop',
      'browser.viewport',
      'browser.wait',
      'document.read',
      'document.render',
      'image.read',
      'file.create',
      'file.delete',
      'file.metadata',
      'file.move',
      'file.patch_guarded',
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
      'terminal.list',
      'terminal.read',
      'terminal.start',
      'terminal.status',
      'terminal.stop',
      'terminal.write',
      'validation.run',
      'visual.compare',
      'visual.motion.compare',
      'web.profiles',
      'web.start',
      'web.list',
      'web.stop',
      'web.tabs',
      'web.open',
      'web.close',
      'web.navigate',
      'web.reload',
      'web.back',
      'web.snapshot',
      'web.screenshot',
      'web.screenshot.save',
      'web.extract',
      'web.assets',
      'web.viewport',
      'web.download',
      'web.click',
      'web.fill',
      'web.select',
      'web.scroll',
      'web.press',
      'web.keyboard.sequence',
      'web.action.capture',
      'web.wait',
      'web.human.request',
      'web.human.status',
      'web.motion.capture',
      'web.motion.inspect',
      'web.inspect',
      'workspace.list',
      'workspace.search',
      'workspace.tree',
      'analysis.list',
      'analysis.status',
      'analysis.cancel',
      'artifact.inspect',
      'artifact.hash',
      'artifact.text.read',
      'binary.inspect',
      'document.process',
      'web.download.start',
      'task.runMany',
      'task.list',
      'task.statusMany',
      'task.waitMany',
      'task.cancelMany',
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

  it('todos los esquemas de entrada rechazan propiedades desconocidas', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const result = await harness.client.listTools(undefined, { cacheMode: 'bypass' });

    for (const tool of result.tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('rechaza en protocolo un campo desconocido aunque la entrada restante sea válida', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });

    const result = await harness.client.callTool({ name: 'system.health', arguments: { unexpected: true } });

    expect(result.isError).toBe(true);
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

    expect(commit?.description).toContain('explicit user request may authorize');
    expect(commit?.description).not.toContain('first call returns an input_required');
    expect(push?.annotations?.openWorldHint).toBe(true);
  });

  it('dirige Git multi-repo por repositoryPath y reserva la terminal para operaciones sin tool', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, gitApprovalMode: 'host' });

    const result = await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    const gitTools = result.tools.filter((tool) => tool.name.startsWith('git.'));
    const terminalStart = result.tools.find((tool) => tool.name === 'terminal.start');
    const terminalWrite = result.tools.find((tool) => tool.name === 'terminal.write');

    for (const tool of gitTools) {
      expect((tool.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty('repositoryPath');
      expect(tool.description).toContain('project.list');
    }
    expect(terminalStart?.description).toContain('Do not use terminal tools for Git operations supported by git.*');
    expect(terminalWrite?.description).toContain('Do not use terminal tools for Git operations supported by git.*');
  });

  it('separa navegación web, navegador de proyecto y autoridad de descarga', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });
    const result = await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    const webStart = result.tools.find((tool) => tool.name === 'web.start');
    const download = result.tools.find((tool) => tool.name === 'web.download');
    const documentRead = result.tools.find((tool) => tool.name === 'document.read');
    const documentRender = result.tools.find((tool) => tool.name === 'document.render');
    const imageRead = result.tools.find((tool) => tool.name === 'image.read');

    expect(webStart?.description).toContain('use browser.start for a project');
    expect(download?.description).toContain('accepts no URL');
    expect(download?.annotations?.openWorldHint).toBe(true);
    expect(download?.annotations?.idempotentHint).toBe(true);
    const downloadProperties = (download?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    expect(downloadProperties).not.toHaveProperty('url');
    expect(documentRead?.description).toContain('document.render');
    expect(documentRead?.annotations?.openWorldHint).toBe(false);
    expect(documentRender?.description).toContain('Never use terminal conversion');
    expect(documentRender?.annotations?.openWorldHint).toBe(false);
    expect(imageRead?.description).toContain('never accepts URLs');
    expect(imageRead?.annotations?.openWorldHint).toBe(false);
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
