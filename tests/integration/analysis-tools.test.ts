import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AnalysisJobSupervisor,
  DevelopmentBrokerError,
  createDevelopmentRuntimeHandler,
  startDevelopmentBroker,
  type RunningDevelopmentBroker,
} from '@localbridge/development';
import { createLogger, TARGET_PROTOCOL_REVISION } from '@localbridge/shared';
import { ArtifactAnalysisRuntime } from '../../apps/desktop/src/main/artifact-analysis-runtime.js';
import { buildWorkspace, createSparseFile, createTempWorkspaceDir, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';
import { buildPdfFixture } from '../helpers/pdf-fixture.js';

let workspace: TempWorkspace;
let harness: Harness | undefined;
let broker: RunningDevelopmentBroker | undefined;
let supervisor: AnalysisJobSupervisor | undefined;
let analysisPrivateRoot: string | undefined;
let analysisConfigPath: string | undefined;

beforeEach(async () => { workspace = await createTempWorkspaceDir(); });
afterEach(async () => {
  await harness?.close();
  await broker?.close();
  await supervisor?.close();
  harness = undefined;
  broker = undefined;
  supervisor = undefined;
  if (analysisPrivateRoot !== undefined) await rm(analysisPrivateRoot, { recursive: true, force: true });
  analysisPrivateRoot = undefined;
  analysisConfigPath = undefined;
  await workspace.cleanup();
});

async function configure(webDownload?: ConstructorParameters<typeof ArtifactAnalysisRuntime>[0]['webDownload']): Promise<void> {
  const privateRoot = path.join(os.tmpdir(), `localbridge-analysis-tools-${randomUUID()}`);
  const configPath = path.join(privateRoot, 'workspaces.json');
  analysisPrivateRoot = privateRoot;
  analysisConfigPath = configPath;
  await mkdir(privateRoot, { recursive: true });
  await writeRegistryFile(configPath, [buildWorkspace({
    id: 'ws_analysis',
    rootPath: workspace.root,
    permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    limits: {
      maxFileBytes: 1024 * 1024,
      maxTreeEntries: 100,
      maxTreeDepth: 8,
      largeArtifacts: { mode: 'adaptive', reserve: { minimumFreeBytes: 64 * 1024 * 1024, minimumFreePercent: 1 }, maxConcurrentJobs: 1 },
    },
  })]);
  const runtime = new ArtifactAnalysisRuntime({
    workspaceConfigPath: configPath,
    logger: createLogger({ level: 'error' }),
    cursorSigningKey: Buffer.from('integration-cursor-key'),
    documentWorkerPath: path.resolve('packages/mcp-server/src/document-worker.mjs'),
    ...(webDownload === undefined ? {} : { webDownload }),
  });
  supervisor = new AnalysisJobSupervisor({
    journalPath: path.join(privateRoot, 'analysis.sqlite'),
    execute: runtime.execute,
    concurrencyForWorkspace: async () => 1,
  });
  broker = await startDevelopmentBroker({
    handler: createDevelopmentRuntimeHandler({ processes: {} as never, analysis: supervisor }),
  });
  harness = await createHarness({
    pinProtocol: TARGET_PROTOCOL_REVISION,
    workspaceConfigPath: configPath,
    developmentBrokerEndpoint: broker.endpoint,
    developmentBrokerToken: broker.token,
  });
}

async function start(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await harness!.client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

async function completed(job: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const result = await harness!.client.callTool({
      name: 'analysis.status',
      arguments: { workspaceId: 'ws_analysis', jobId: job['jobId'], maxItems: 10 },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const status = result.structuredContent as Record<string, unknown>;
    const current = status['job'] as Record<string, unknown>;
    lastState = String(current['state']);
    if (current['state'] === 'completed') return status;
    if (['failed', 'cancelled', 'source_changed', 'interrupted'].includes(String(current['state']))) {
      throw new Error(`unexpected terminal state: ${JSON.stringify(current)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for analysis job after ${timeoutMs}ms; state=${lastState}`);
}

async function eventually<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout waiting for analysis state');
}

function minimalPe(): Buffer {
  const output = Buffer.alloc(512);
  output.write('MZ', 0, 'ascii');
  output.writeUInt32LE(0x80, 0x3c);
  output.write('PE\0\0', 0x80, 'binary');
  output.writeUInt16LE(0x8664, 0x84);
  output.writeUInt16LE(1, 0x86);
  output.writeUInt32LE(1_700_000_000, 0x88);
  output.writeUInt16LE(240, 0x94);
  output.writeUInt16LE(0x2022, 0x96);
  output.writeUInt16LE(0x20b, 0x98);
  output.writeUInt32LE(0x1000, 0xa8);
  output.writeBigUInt64LE(0x140000000n, 0xb0);
  output.writeUInt16LE(0x4160, 0xde);
  const section = 0x80 + 24 + 240;
  output.write('.text', section, 'ascii');
  output.writeUInt32LE(64, section + 8);
  output.writeUInt32LE(0x1000, section + 12);
  output.writeUInt32LE(64, section + 16);
  output.writeUInt32LE(448, section + 20);
  output.writeUInt32LE(0x60000020, section + 36);
  output.fill(0x90, 448);
  return output;
}

describe('jobs de artefactos grandes vía MCP y broker', () => {
  it('inspecciona, hashea y pagina UTF-8 sin materializar la fuente completa en una respuesta', async () => {
    await writeFile(path.join(workspace.root, 'large.txt'), 'á'.repeat(2_000));
    await configure();

    const inspection = await completed(await start('artifact.inspect', {
      workspaceId: 'ws_analysis', path: 'large.txt', operationId: 'inspect_1',
    }));
    expect((inspection['job'] as Record<string, unknown>)['summary']).toMatchObject({
      detectedType: 'text/plain', size: 4_000, recommendedTool: 'artifact.text.read',
    });

    const first = await completed(await start('artifact.text.read', {
      workspaceId: 'ws_analysis', path: 'large.txt', operationId: 'text_1', maxChars: 1_000,
    }));
    const firstItems = first['items'] as Array<Record<string, unknown>>;
    expect(firstItems.find((item) => item['kind'] === 'text')?.['text']).toBe('á'.repeat(1_000));
    const cursor = ((first['job'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['nextCursor'];
    expect(cursor).toEqual(expect.any(String));

    const second = await completed(await start('artifact.text.read', {
      workspaceId: 'ws_analysis', path: 'large.txt', operationId: 'text_2', maxChars: 1_000, cursor,
    }));
    expect(((second['job'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['truncated']).toBe(false);

    const hashed = await completed(await start('artifact.hash', {
      workspaceId: 'ws_analysis', path: 'large.txt', operationId: 'hash_1',
    }));
    expect(((hashed['job'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['sha256']).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(path.join(workspace.root, 'utf16.txt'), Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Texto visual UTF16 '.repeat(100), 'utf16le'),
    ]));
    const utf16 = await completed(await start('artifact.text.read', {
      workspaceId: 'ws_analysis', path: 'utf16.txt', operationId: 'text_utf16', maxChars: 1_000,
    }));
    expect(((utf16['job'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['encoding']).toBe('utf-16le');
    expect((utf16['items'] as Array<Record<string, unknown>>).find((item) => item['kind'] === 'text')?.['text']).toContain('Texto visual UTF16');
  });

  it('pagina texto desde una fuente sparse de 10 GiB con lectura acotada', async () => {
    await createSparseFile(
      path.join(workspace.root, 'huge-text.txt'),
      10 * 1024 * 1024 * 1024,
      Buffer.from('LocalBridge texto grande '.repeat(4_000), 'utf8'),
    );
    await configure();

    const status = await completed(await start('artifact.text.read', {
      workspaceId: 'ws_analysis', path: 'huge-text.txt', operationId: 'text_10gib', maxChars: 1_000,
    }));
    const job = status['job'] as Record<string, unknown>;
    const coverage = job['coverage'] as Record<string, unknown>;
    expect(job['summary']).toMatchObject({ truncated: true, endByte: expect.any(Number) });
    expect(coverage['sourceBytes']).toBe(10 * 1024 * 1024 * 1024);
    expect(Number(coverage['uniqueBytesRead'])).toBeLessThan(16 * 1024);
    expect((status['items'] as Array<Record<string, unknown>>).find((item) => item['kind'] === 'text')?.['text']).toContain('LocalBridge texto grande');
  });

  it('inspecciona PE de forma estática y procesa PDF visual o textual con cobertura', async () => {
    await writeFile(path.join(workspace.root, 'sample.dll'), minimalPe());
    await writeFile(path.join(workspace.root, 'sample.pdf'), buildPdfFixture({ pages: ['Hello PDF', null] }));
    await configure();

    const pe = await completed(await start('binary.inspect', {
      workspaceId: 'ws_analysis', path: 'sample.dll', operationId: 'pe_1', depth: 'quick',
    }));
    const peJson = (pe['items'] as Array<Record<string, unknown>>).find((item) => item['kind'] === 'json')?.['value'];
    expect(peJson).toMatchObject({
      format: 'PE', architecture: 'x64', sha256State: 'not-requested',
      resources: { present: false },
      authenticode: { present: false, chainTrust: 'not-verified' },
    });

    const text = await completed(await start('document.process', {
      workspaceId: 'ws_analysis', path: 'sample.pdf', operationId: 'pdf_read_1',
      request: { mode: 'read', maxChars: 20_000 },
    }), 20_000); // El worker de lectura tiene un timeout propio de 15 s.
    expect((text['items'] as Array<Record<string, unknown>>).find((item) => item['kind'] === 'text')?.['text']).toContain('Hello PDF');

    const rendered = await completed(await start('document.process', {
      workspaceId: 'ws_analysis', path: 'sample.pdf', operationId: 'pdf_render_1',
      request: { mode: 'render', pages: [2], detail: 'standard' },
    }), 35_000); // El worker de render tiene un timeout propio de 30 s.
    expect((rendered['items'] as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'image', mimeType: expect.stringMatching(/^image\//), encodedBytes: expect.any(Number) }),
    ]));
  }, 65_000);

  it('inicia una descarga observada sin aceptar URL libre y permite redescubrir el job', async () => {
    const calls: unknown[] = [];
    await configure(async (...args) => {
      calls.push(args);
      return { path: 'downloads/file.bin', size: 12, sha256: 'a'.repeat(64), mimeType: 'application/octet-stream', created: true };
    });
    const rejected = await harness!.client.callTool({
      name: 'web.download.start',
      arguments: {
        sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', tabId: 'webtab_bbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRef: 'webresource_cccccccccccccccccccc', workspaceId: 'ws_analysis', path: 'downloads/file.bin',
        operationId: 'web_download_1', url: 'https://example.com/file.bin',
      },
    });
    expect(rejected.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const admitted = await start('web.download.start', {
      sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', tabId: 'webtab_bbbbbbbbbbbbbbbbbbbbbbbb',
      resourceRef: 'webresource_cccccccccccccccccccc', workspaceId: 'ws_analysis', path: 'downloads/file.bin',
      operationId: 'web_download_1',
    });
    const done = await completed(admitted);
    expect((done['job'] as Record<string, unknown>)).toMatchObject({ state: 'completed', effectState: 'applied' });
    expect(calls).toHaveLength(1);

    const listed = await harness!.client.callTool({
      name: 'analysis.list', arguments: { workspaceId: 'ws_analysis' },
    });
    expect(listed.isError).not.toBe(true);
    expect((listed.structuredContent as { jobs: unknown[] }).jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: admitted['jobId'], operationKind: 'web.download.start' }),
    ]));
  });

  it('cancela una descarga activa en menos de dos segundos sin publicar un éxito', async () => {
    let startedDownload: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedDownload = resolve; });
    await configure(async (_sessionId, _tabId, _resourceRef, _workspaceId, _path, _operationId, signal) => {
      startedDownload?.();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
      });
      throw new Error('unreachable');
    });
    const admitted = await start('web.download.start', {
      sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', tabId: 'webtab_bbbbbbbbbbbbbbbbbbbbbbbb',
      resourceRef: 'webresource_cccccccccccccccccccc', workspaceId: 'ws_analysis', path: 'downloads/cancel.bin',
      operationId: 'web_download_cancel',
    });
    await started;
    const beganAt = Date.now();
    const cancelled = await harness!.client.callTool({
      name: 'analysis.cancel',
      arguments: { workspaceId: 'ws_analysis', jobId: admitted['jobId'] },
    });
    expect(cancelled.isError).not.toBe(true);
    const terminal = await eventually(
      () => supervisor!.status('ws_analysis', String(admitted['jobId']), 0, 10),
      (status) => status.job.state === 'cancelled',
    );
    expect(Date.now() - beganAt).toBeLessThan(2_000);
    expect(terminal).toMatchObject({
      job: { state: 'cancelled', effectState: 'not_applied', resumeCapability: 'none' },
      resultsAvailable: false,
    });
  });

  it('conserva WEB_EFFECT_UNCERTAIN y prohíbe replay cuando no hay recibo final', async () => {
    await configure(async () => {
      throw new DevelopmentBrokerError('WEB_EFFECT_UNCERTAIN', 'La publicación requiere reconciliación.');
    });
    const admitted = await start('web.download.start', {
      sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', tabId: 'webtab_bbbbbbbbbbbbbbbbbbbbbbbb',
      resourceRef: 'webresource_cccccccccccccccccccc', workspaceId: 'ws_analysis', path: 'downloads/uncertain.bin',
      operationId: 'web_download_uncertain',
    });
    const terminal = await eventually(
      () => supervisor!.status('ws_analysis', String(admitted['jobId']), 0, 10),
      (status) => status.job.state === 'failed',
    );
    expect(terminal).toMatchObject({
      job: {
        state: 'failed', errorCode: 'WEB_EFFECT_UNCERTAIN', effectState: 'uncertain',
        resumeCapability: 'none', summary: { publication: 'pending' },
      },
      resultsAvailable: false,
    });
  });

  it('permite reconectar otro cliente MCP y redescubrir un job que siguió en Desktop', async () => {
    let releaseDownload: (() => void) | undefined;
    let startedDownload: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedDownload = resolve; });
    const released = new Promise<void>((resolve) => { releaseDownload = resolve; });
    await configure(async () => {
      startedDownload?.();
      await released;
      return { path: 'downloads/reconnected.bin', size: 42, sha256: 'b'.repeat(64), created: true };
    });
    const admitted = await start('web.download.start', {
      sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', tabId: 'webtab_bbbbbbbbbbbbbbbbbbbbbbbb',
      resourceRef: 'webresource_cccccccccccccccccccc', workspaceId: 'ws_analysis', path: 'downloads/reconnected.bin',
      operationId: 'web_download_reconnect',
    });
    await started;
    await harness!.close();
    harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: analysisConfigPath!,
      developmentBrokerEndpoint: broker!.endpoint,
      developmentBrokerToken: broker!.token,
    });
    releaseDownload?.();
    const status = await completed(admitted);
    expect(status['job']).toMatchObject({ state: 'completed', effectState: 'applied' });
  });
});
