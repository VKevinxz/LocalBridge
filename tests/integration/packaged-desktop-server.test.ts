import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import {
  bundledServerCommand,
  checkRuntimeReadiness,
  diagnoseTunnelProfile,
  initializeTunnelProfile,
  resolveBundledRuntimePaths,
} from '@localbridge/desktop-core';

import { buildWorkspace } from '../helpers/fixtures.js';
import { buildPdfFixture } from '../helpers/pdf-fixture.js';

const packagedResources = process.env['LOCALBRIDGE_PACKAGED_RESOURCES'];

describe.skipIf(packagedResources === undefined)('servidor MCP autocontenido', () => {
  it('responde system.health sin Node ni checkout externos', async () => {
    const isolatedRoot = path.join(os.tmpdir(), `localbridge-packaged-e2e-${process.pid}`);
    const workspaceRoot = path.join(isolatedRoot, 'workspace');
    const registryPath = path.join(isolatedRoot, 'workspaces.json');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'fixture.pdf'), buildPdfFixture({ pages: ['Documento empaquetado LocalBridge 1.5'] }));
    const png = new PNG({ width: 8, height: 6 });
    png.data.fill(0x77);
    await writeFile(path.join(workspaceRoot, 'fixture.png'), PNG.sync.write(png));
    const workspace = buildWorkspace({ id: 'ws_packaged', rootPath: workspaceRoot });
    await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 4, workspaces: [workspace], applications: [] })}\n`, 'utf8');
    const transport = new StdioClientTransport({
      command: path.join(packagedResources!, 'vendor', 'node', 'node.exe'),
      args: [path.join(packagedResources!, 'server', 'index.cjs')],
      env: {
        ...getDefaultEnvironment(),
        LOCALBRIDGE_LOG_LEVEL: 'error',
        LOCALBRIDGE_WORKSPACES_FILE: registryPath,
        LOCALBRIDGE_AUDIT_DB_FILE: path.join(isolatedRoot, 'audit.db'),
        LOCALBRIDGE_DOCUMENT_WORKER_PATH: path.join(packagedResources!, 'server', 'document-worker.cjs'),
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: 'localbridge-packaged-e2e', version: '0.0.0' });

    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Timeout conectando al servidor empaquetado. stderr: ${stderr}`)), 8_000);
        }),
      ]);
      const result = await client.callTool({ name: 'system.health', arguments: {} });
      const productVersion = (JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { version: string }).version;
      const listed = await client.listTools();
      const gitTools = listed.tools.filter((tool) => tool.name.startsWith('git.'));
      const terminalTools = listed.tools.filter((tool) => ['terminal.start', 'terminal.write'].includes(tool.name));
      const webTools = listed.tools.filter((tool) => tool.name.startsWith('web.'));
      const taskTools = listed.tools.filter((tool) => tool.name.startsWith('task.'));

      expect(result.structuredContent).toMatchObject({
        status: 'ready',
        version: productVersion,
      });
      expect(listed.tools).toHaveLength(113);
      expect(webTools).toHaveLength(31);
      expect(taskTools.map((tool) => tool.name).toSorted()).toEqual([
        'task.cancelMany',
        'task.list',
        'task.runMany',
        'task.statusMany',
        'task.waitMany',
      ]);
      expect(listed.tools.some((tool) => tool.name === 'document.read')).toBe(true);
      expect(listed.tools.some((tool) => tool.name === 'document.render')).toBe(true);
      expect(listed.tools.some((tool) => tool.name === 'image.read')).toBe(true);
      expect(gitTools.map((tool) => tool.name).toSorted()).toEqual([
        'git.branch',
        'git.commit',
        'git.status',
        'git.diff',
        'git.log',
        'git.push',
        'git.stage',
      ].toSorted());
      for (const tool of gitTools) {
        expect(tool.inputSchema.properties).toHaveProperty('repositoryPath');
        expect(tool.description).toContain('project.list');
      }
      for (const tool of terminalTools) {
        expect(tool.description).toMatch(/Do not use (?:this tool|terminal tools) for Git operations/);
      }
      const document = await client.callTool({ name: 'document.read', arguments: {
        workspaceId: 'ws_packaged', path: 'fixture.pdf', maxChars: 5_000,
      } });
      expect(document.isError, `${JSON.stringify(document)} stderr: ${stderr}`).not.toBe(true);
      expect(document.structuredContent).toMatchObject({
        path: 'fixture.pdf', pageCount: 1, text: expect.stringContaining('Documento empaquetado LocalBridge 1.5'),
      });
      const rendered = await client.callTool({ name: 'document.render', arguments: {
        workspaceId: 'ws_packaged', path: 'fixture.pdf', pages: [1], detail: 'standard',
      } });
      expect(rendered.isError, `${JSON.stringify(rendered)} stderr: ${stderr}`).not.toBe(true);
      expect(rendered.structuredContent).toMatchObject({
        path: 'fixture.pdf',
        pageCount: 1,
        pages: [{ renderer: 'pdfium', fallbackApplied: false }],
      });
      const renderedImage = rendered.content.find((item) => item.type === 'image');
      expect(renderedImage?.type).toBe('image');
      if (renderedImage?.type === 'image') {
        expect(Buffer.from(renderedImage.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      }
      const localImage = await client.callTool({ name: 'image.read', arguments: {
        workspaceId: 'ws_packaged', path: 'fixture.png', detail: 'standard',
      } });
      expect(localImage.isError, `${JSON.stringify(localImage)} stderr: ${stderr}`).not.toBe(true);
      expect(localImage.content.some((item) => item.type === 'image')).toBe(true);
    } finally {
      await client.close();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('crea y diagnostica un perfil real apuntando al servidor incluido', async () => {
    const isolatedUserData = path.join(os.tmpdir(), `localbridge-packaged-profile-${process.pid}`);
    const paths = resolveBundledRuntimePaths(packagedResources!, isolatedUserData);
    const provision = {
      binaryPath: paths.tunnelBinaryPath,
      profileDir: paths.profileDir,
      profile: paths.profile,
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      serverCommand: bundledServerCommand(paths),
    };

    await initializeTunnelProfile(provision);
    const doctor = await diagnoseTunnelProfile({ ...provision, apiKey: 'test-key-not-valid', gitApprovalMode: 'host' });

    expect(doctor.ok).toBe(true);
    expect(doctor.output).toContain('"id": "mcp_command_executable"');
    expect(doctor.output).toContain('"status": "PASS"');
  }, 20_000);

  it('pasa la comprobación completa usada por el onboarding', async () => {
    const paths = resolveBundledRuntimePaths(packagedResources!, path.join(os.tmpdir(), 'localbridge-readiness-user-data'));
    const report = await checkRuntimeReadiness(paths);

    expect(report).toMatchObject({
      node: { ok: true },
      tunnel: { ok: true },
      connectivity: { ok: true },
      server: { ok: true, detail: 'system.health: ready' },
      ready: true,
    });
  }, 20_000);
});
