import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEVELOPMENT_BROKER_PROTOCOL, parseBrokerParams } from '@localbridge/development';

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), 'utf8');
}

const browserSessionId = `session_${'a'.repeat(24)}`;
const webSessionId = `websession_${'b'.repeat(24)}`;
const webTabId = `webtab_${'c'.repeat(24)}`;
const trajectory = { axis: 'y' as const, startY: 0, distancePx: 900, durationMs: 1_000, sampleCount: 6 };

describe('SEC-221..234 — análisis temporal y fidelidad del visor', () => {
  it('SEC-221 no intercambia IDs de sesiones browser y web', () => {
    expect(() => parseBrokerParams('browser.motion.inspect', {
      workspaceId: 'ws_motion', sessionId: webSessionId, maxAnimations: 10,
    })).toThrow();
    expect(() => parseBrokerParams('web.motion.inspect', {
      sessionId: browserSessionId, tabId: webTabId, maxAnimations: 10,
    })).toThrow();
  });

  it('SEC-222 rechaza JS, selectores, URL, roots, rutas absolutas y traversal', () => {
    const valid = {
      workspaceId: 'ws_motion', sessionId: browserSessionId, path: 'evidence/reference.lbmotion',
      operationId: 'capture_1', trajectory, settleBeforeMs: 500, captureMode: 'auto',
    };
    for (const injected of [
      { script: 'document.cookie' }, { selector: 'body' }, { xpath: '//*' },
      { url: 'https://example.com' }, { root: 'D:\\secret' }, { path: 'D:\\secret\\trace.lbmotion' },
      { path: '../trace.lbmotion' },
    ]) expect(() => parseBrokerParams('browser.motion.capture', { ...valid, ...injected })).toThrow();
  });

  it('SEC-223 comprueba control humano antes y durante toda captura', async () => {
    const browser = await source('apps/desktop/src/main/browser-controller.ts');
    const web = await source('apps/desktop/src/main/web-controller.ts');
    expect(browser).toContain("['waiting_for_human', 'human_control', 'returning_to_agent'].includes(entry.controlState)");
    expect(web).toContain('["waiting_for_human", "human_control", "returning_to_agent"].includes(entry.controlState)');
    expect(browser).toContain("fail('HUMAN_CONTROL_ACTIVE'");
    expect(web).toContain('fail("HUMAN_CONTROL_ACTIVE"');
    expect(browser).toContain('assertCurrent: () =>');
    expect(web).toContain('assertCurrent: () =>');
  });

  it('SEC-224 reevalúa perfil y workspace y evita publicar tras revocación', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const web = await source('apps/desktop/src/main/web-controller.ts');
    expect(main).toContain('withAuthorizedWebProfileEffect(');
    expect(main).toContain('withAuthorizedWorkspaceEffect(');
    expect(main).toContain('createWorkspaceArtifactDirectory(');
    expect(web).toContain('profileRevision(current) !== entry.profileRevision');
  });

  it('SEC-225 publica directorios de evidencia atómicos y falla cerrado ante carreras o symlinks', async () => {
    const artifact = await source('packages/filesystem/src/artifact-directory.ts');
    expect(artifact).toContain('.lbtmp-${randomUUID()}');
    expect(artifact).toContain("STAGING_MARKER_NAME = '.localbridge-artifact-staging-v1'");
    expect(artifact).toContain('marker === STAGING_MARKER_CONTENT');
    expect(artifact).toContain("throw new LocalBridgeError('FILE_ALREADY_EXISTS')");
    expect(artifact).toContain("throw new LocalBridgeError('SYMLINK_ESCAPE')");
    expect(artifact).toContain('await rename(');
    expect(artifact).toContain('await rm(stagingPath, { recursive: true, force: true })');
  });

  it('SEC-226 limita duración, muestras, bytes, archivos, deadline y concurrencia global', async () => {
    const protocol = await source('packages/development/src/protocol.ts');
    const engine = await source('apps/desktop/src/main/motion-capture-engine.ts');
    const artifact = await source('packages/filesystem/src/artifact-directory.ts');
    expect(protocol).toContain('durationMs: z.number().int().min(250).max(10_000)');
    expect(protocol).toContain('sampleCount: z.number().int().min(3).max(24)');
    expect(engine).toContain('CAPTURE_DEADLINE_MS = 60_000');
    expect(engine).toContain('if (activeCapture)');
    expect(artifact).toContain('MAX_TRUSTED_ARTIFACT_FILE_BYTES = 1024 * 1024 * 1024');
    expect(artifact).toContain('if (totalSize + requiredBytes > maximumTotal)');
    expect(engine).toContain('await context.writer.ensureCapacity(worstTotal)');
    expect(artifact).toContain('MAX_ARTIFACT_FILES = 64');
  });

  it('SEC-227 confirma cada screencast frame y conserva solo la secuencia más reciente', async () => {
    const engine = await source('apps/desktop/src/main/motion-capture-engine.ts');
    expect(engine).toContain("sendCommand('Page.screencastFrameAck'");
    expect(engine).toContain('let latestSequence: number | undefined');
    expect(engine).not.toMatch(/(?:frames|queue)\.push\([^)]*data/i);
  });

  it('SEC-228 no cruza PNG o base64 por broker ni los incluye en el contrato MCP', async () => {
    const runtime = await source('packages/development/src/runtime-handler.ts');
    const tools = await source('packages/mcp-server/src/tools/motion-tools.ts');
    const server = await source('packages/mcp-server/src/server.ts');
    expect(tools).not.toMatch(/dataBase64|base64|pngBytes/);
    expect(runtime).not.toMatch(/motion[\s\S]{0,160}(?:dataBase64|pngBytes)/);
    expect(server).toContain('No motion frame bytes cross MCP');
  });

  it('SEC-229 navegación, detach y cierre invalidan generaciones y listeners', async () => {
    const browser = await source('apps/desktop/src/main/browser-controller.ts');
    const web = await source('apps/desktop/src/main/web-controller.ts');
    const engine = await source('apps/desktop/src/main/motion-capture-engine.ts');
    expect(browser).toContain('generation += 1');
    expect(web).toContain('tab.generation += 1');
    expect(web).toContain('contents.on("did-navigate", () => this.invalidate(tab))');
    expect(engine).toContain("debugger.off('message', onMessage)");
    expect(engine).toContain("sendCommand('Page.stopScreencast')");
  });

  it('SEC-230 no repite automáticamente un scroll cuyo efecto quedó incierto', async () => {
    const browser = await source('apps/desktop/src/main/browser-controller.ts');
    const web = await source('apps/desktop/src/main/web-controller.ts');
    for (const controller of [browser, web]) {
      expect(controller).toContain("previous.state !== 'complete'");
      expect(controller).toContain("fail('MOTION_EFFECT_UNCERTAIN'");
      expect(controller).toContain("state: 'pending'");
    }
  });

  it('SEC-231 conserva la política HTTPS/SSRF web existente', async () => {
    const web = await source('apps/desktop/src/main/web-controller.ts');
    const policy = await source('apps/desktop/src/main/web-network-policy.ts');
    const motion = await source('apps/desktop/src/main/motion-capture-engine.ts');
    expect(web).toContain('normalizePublicHttpsUrl');
    expect(web).toContain('isWebEgressHostAllowed');
    expect(policy).toContain('parsed.protocol !== "https:"');
    expect(policy).toContain('isPublicIpAddress');
    expect(motion).not.toMatch(/\bfetch\s*\(|https?:\/\//);
  });

  it('SEC-232 valida manifiestos, rutas, dimensiones y hashes antes de comparar', async () => {
    const tools = await source('packages/mcp-server/src/tools/motion-tools.ts');
    expect(tools).toContain('manifestSchema.safeParse');
    expect(tools).toContain('validateManifest(result.data)');
    expect(tools).toContain('file.sha256 !== sample.sha256');
    expect(tools).toContain("throw new LocalBridgeError('MOTION_BUNDLE_INVALID')");
    expect(tools).toContain("throw new LocalBridgeError('MOTION_BUNDLES_INCOMPATIBLE')");
  });

  it('SEC-233 lee ambas entradas y escribe la salida bajo una autoridad común', async () => {
    const tools = await source('packages/mcp-server/src/tools/motion-tools.ts');
    expect(tools).toContain("requireAuthorizedWorkspace(ctx.workspaceConfigPath, ctx.logger, input.workspaceId, 'read')");
    expect(tools).toContain("['read', 'write']");
    expect(tools).toContain('withAuthorizedWorkspaceCapabilitiesEffect(');
    expect(tools).toContain('Promise.all([\n    readManifest(workspace, input.referenceManifestPath)');
  });

  it('SEC-234 conserva el catálogo histórico tras las extensiones aditivas de v1.7.0', async () => {
    const protocolTest = await source('tests/protocol/server.test.ts');
    const packagedTest = await source('tests/integration/packaged-desktop-server.test.ts');
    expect(DEVELOPMENT_BROKER_PROTOCOL).toBe(22);
    for (const name of ['web.motion.inspect', 'browser.motion.inspect', 'web.motion.capture', 'browser.motion.capture', 'visual.motion.compare']) {
      expect(protocolTest).toContain(`'${name}'`);
    }
    expect(packagedTest).toContain('toHaveLength(113)');
  });
});
