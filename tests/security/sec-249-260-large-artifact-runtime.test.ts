import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEVELOPMENT_BROKER_PROTOCOL, parseBrokerParams } from '@localbridge/development';
import { webProfileRevision, type WebProfile } from '@localbridge/desktop-core';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';
import { createHarness, type Harness } from '../helpers/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('SEC-249..260 — runtime de artefactos grandes v1.7.0', () => {
  it('SEC-249 mantiene las 100 tools de v1.7.0 y agrega trece tools cerradas de v1.8.0', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });
    const tools = (await harness.client.listTools(undefined, { cacheMode: 'bypass' })).tools;
    const names = tools.map((tool) => tool.name);
    const v18Names = new Set([
      'browser.inspect', 'browser.keyboard.sequence', 'browser.action.capture', 'browser.reload',
      'web.inspect', 'web.keyboard.sequence', 'web.action.capture', 'web.reload',
      'task.runMany', 'task.list', 'task.statusMany', 'task.waitMany', 'task.cancelMany',
    ]);
    const v17Names = names.filter((name) => !v18Names.has(name));
    expect(tools).toHaveLength(113);
    expect(new Set(names).size).toBe(113);
    expect(v17Names).toHaveLength(100);
    expect(v17Names.slice(91)).toEqual([
      'analysis.list', 'analysis.status', 'analysis.cancel', 'artifact.inspect',
      'artifact.hash', 'artifact.text.read', 'binary.inspect', 'document.process',
      'web.download.start',
    ]);
    expect(new Set(names.filter((name) => v18Names.has(name)))).toEqual(v18Names);
  });

  it('SEC-250 conserva schemas estrictos de artefactos bajo broker 22', () => {
    expect(DEVELOPMENT_BROKER_PROTOCOL).toBe(22);
    expect(() => parseBrokerParams('analysis.list', {
      workspaceId: 'ws_demo', cursor: 0, limit: 20, rootPath: 'C:\\private',
    })).toThrow();
    expect(() => parseBrokerParams('analysis.start', {
      operationKind: 'artifact.inspect', workspaceId: 'ws_demo', sourcePath: 'C:\\private\\file.bin',
      operationId: 'inspect_1', parameters: {},
    })).toThrow();
    expect(() => parseBrokerParams('analysis.start', {
      operationKind: 'artifact.inspect', workspaceId: 'ws_demo', sourcePath: '../private/file.bin',
      operationId: 'inspect_2', parameters: {},
    })).toThrow();
  });

  it('SEC-251 web.download.start solo acepta referencias observadas y ninguna URL', () => {
    expect(() => parseBrokerParams('analysis.start', {
      operationKind: 'web.download.start', workspaceId: 'ws_demo', sourcePath: 'downloads/file.bin',
      operationId: 'download_1',
      parameters: {
        sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa',
        tabId: 'webtab_bbbbbbbbbbbbbbbbbbbbbbbb',
        resourceRef: 'webresource_cccccccccccccccccccc',
        url: 'https://example.com/private.bin',
      },
    })).toThrow();
  });

  it('SEC-252 el inspector PE permanece pasivo y no inicia procesos ni módulos nativos', async () => {
    const source = await readFile(path.join(process.cwd(), 'apps/desktop/src/main/artifact-analysis-runtime.ts'), 'utf8');
    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(|\bexecFile\s*\(|process\.dlopen|ffi-napi/);
    expect(source).toContain("format: 'PE'");
  });

  it('SEC-253 cambiar cuotas web no cambia autoridad ni cierra la sesión por revisión', () => {
    const profile: WebProfile = {
      id: 'webprofile_aaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Público',
      kind: 'public-research',
      enabled: true,
      reviewRequired: false,
      destinations: [],
      supportHosts: [],
      permissions: { read: true, interact: true, download: true, humanControl: false },
      limits: {
        maxSessions: 2, maxTabsPerSession: 8, maxExtractedChars: 50_000,
        maxDownloadBytes: 1024 * 1024, maxTotalDownloadBytes: 10 * 1024 * 1024,
        transferPolicy: { mode: 'fixed' },
      },
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const adaptive: WebProfile = {
      ...profile,
      updatedAt: '2026-09-09T00:01:00.000Z',
      limits: {
        ...profile.limits,
        maxDownloadBytes: 1024 * 1024 * 1024,
        maxTotalDownloadBytes: 2 * 1024 * 1024 * 1024,
        transferPolicy: { mode: 'adaptive' },
      },
    };
    expect(webProfileRevision(adaptive)).toBe(webProfileRevision(profile));
    expect(webProfileRevision({ ...adaptive, permissions: { ...adaptive.permissions, download: false } }))
      .not.toBe(webProfileRevision(profile));
  });

  it('SEC-254 el diario no persiste resultados ni payloads de archivos', async () => {
    const source = await readFile(path.join(process.cwd(), 'packages/development/src/analysis-job-supervisor.ts'), 'utf8');
    expect(source).toContain('DELETE FROM analysis_job_results');
    expect(source).not.toMatch(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+analysis_job_results/i);
    expect(source).toContain('MAX_TOTAL_IN_MEMORY_RESULT_BYTES');
  });

  it('SEC-255 la configuración adaptativa queda fuera de cualquier entrada MCP nueva', async () => {
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION });
    const tools = (await harness.client.listTools(undefined, { cacheMode: 'bypass' })).tools.slice(91);
    const inputSchemas = JSON.stringify(tools.map((tool) => tool.inputSchema));
    for (const forbidden of ['rootPath', 'largeArtifacts', 'transferPolicy', 'trustLevel', 'userApproved']) {
      expect(inputSchemas).not.toContain(`"${forbidden}"`);
    }
  });

  it('SEC-256 una transferencia larga revalida autoridad y publica bajo el lock final', async () => {
    const filesystem = await readFile(path.join(process.cwd(), 'packages/filesystem/src/create-binary.ts'), 'utf8');
    const desktop = await readFile(path.join(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(filesystem).toContain('await options.checkAuthority?.();');
    expect(filesystem).toContain('return await runAuthorizedEffect(publicationOptions');
    expect(desktop).toContain('requireCurrentWebProfileAuthority(');
    expect(desktop).toContain('requireCurrentWorkspaceAuthority(');
    expect(desktop).toContain('withCurrentWorkspaceAuthorityEffect(');
  });

  it('SEC-257 un efecto web incierto no se reclasifica como no aplicado ni reiniciable', async () => {
    const runtime = await readFile(path.join(process.cwd(), 'apps/desktop/src/main/artifact-analysis-runtime.ts'), 'utf8');
    const supervisor = await readFile(path.join(process.cwd(), 'packages/development/src/analysis-job-supervisor.ts'), 'utf8');
    expect(runtime).toContain("if (errorCode !== 'WEB_EFFECT_UNCERTAIN')");
    expect(supervisor).toContain("job.effectState === 'uncertain'");
    expect(supervisor).toContain("? 'none'");
  });
});
