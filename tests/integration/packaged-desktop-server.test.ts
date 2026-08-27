import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

import {
  bundledServerCommand,
  checkRuntimeReadiness,
  diagnoseTunnelProfile,
  initializeTunnelProfile,
  resolveBundledRuntimePaths,
} from '@localbridge/desktop-core';

const packagedResources = process.env['LOCALBRIDGE_PACKAGED_RESOURCES'];

describe.skipIf(packagedResources === undefined)('servidor MCP autocontenido', () => {
  it('responde system.health sin Node ni checkout externos', async () => {
    const isolatedRoot = path.join(os.tmpdir(), `localbridge-packaged-e2e-${process.pid}`);
    const transport = new StdioClientTransport({
      command: path.join(packagedResources!, 'vendor', 'node', 'node.exe'),
      args: [path.join(packagedResources!, 'server', 'index.cjs')],
      env: {
        ...getDefaultEnvironment(),
        LOCALBRIDGE_LOG_LEVEL: 'error',
        LOCALBRIDGE_WORKSPACES_FILE: path.join(isolatedRoot, 'workspaces.json'),
        LOCALBRIDGE_AUDIT_DB_FILE: path.join(isolatedRoot, 'audit.db'),
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

      expect(result.structuredContent).toMatchObject({
        status: 'ready',
        version: '1.1.0',
      });
    } finally {
      await client.close();
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
