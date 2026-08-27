import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  bundledServerCommand,
  checkRuntimeReadiness,
  diagnoseTunnelProfile,
  initializeTunnelProfile,
  quoteTunnelCommandToken,
  resolveBundledRuntimePaths,
  type ProvisionSpawnFn,
} from '@localbridge/desktop-core';

const TUNNEL_ID = 'tunnel_0123456789abcdef0123456789abcdef';

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

function completingSpawn(code: number, stdoutText = '', stderrText = ''): {
  spawnFn: ProvisionSpawnFn;
  calls: CapturedSpawn[];
} {
  const calls: CapturedSpawn[] = [];
  return {
    calls,
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { pid: 1234, stdout, stderr });
      queueMicrotask(() => {
        stdout.end(stdoutText);
        stderr.end(stderrText);
        child.emit('close', code);
      });
      return child;
    },
  };
}

describe('runtime autocontenido', () => {
  it('resuelve todos los componentes bajo resources y userData', () => {
    const paths = resolveBundledRuntimePaths('C:\\App\\resources', 'C:\\Users\\Demo\\AppData\\LocalBridge');

    expect(paths.tunnelBinaryPath).toBe(path.join('C:\\App\\resources', 'vendor', 'tunnel-client', 'tunnel-client.exe'));
    expect(paths.nodeBinaryPath).toBe(path.join('C:\\App\\resources', 'vendor', 'node', 'node.exe'));
    expect(paths.serverBundlePath).toBe(path.join('C:\\App\\resources', 'server', 'index.cjs'));
    expect(paths.profile).toBe('localbridge');
  });

  it('cita espacios, backslashes y apóstrofos para el parser de tunnel-client', () => {
    expect(quoteTunnelCommandToken("C:\\O'Brien Apps\\node.exe")).toBe("'C:\\O'\"'\"'Brien Apps\\node.exe'");
    expect(
      bundledServerCommand({
        tunnelBinaryPath: 'C:\\runtime\\tunnel-client.exe',
        nodeBinaryPath: 'C:\\Program Files\\LocalBridge\\node.exe',
        serverBundlePath: 'C:\\Program Files\\LocalBridge\\server.cjs',
        profileDir: 'C:\\profiles',
        profile: 'localbridge',
      }),
    ).toContain("'C:\\Program Files\\LocalBridge\\node.exe'");
  });

  it('combina componentes, conectividad y system.health en un único readiness', async () => {
    const paths = resolveBundledRuntimePaths('C:\\resources', 'C:\\user-data');
    const report = await checkRuntimeReadiness(paths, {
      execFileFn: async (file) => (file.endsWith('node.exe') ? 'v22.18.0' : 'v0.0.12'),
      connectivityFn: async () => ({ ok: true, detail: 'HTTPS 401' }),
      serverProbeFn: async () => ({ ok: true, detail: 'system.health: ready' }),
    });

    expect(report.ready).toBe(true);
    expect(report.node.detail).toBe('v22.18.0');
    expect(report.server.ok).toBe(true);
  });

  it('falla cerrado cuando cualquier comprobación no pasa', async () => {
    const paths = resolveBundledRuntimePaths('C:\\resources', 'C:\\user-data');
    const report = await checkRuntimeReadiness(paths, {
      execFileFn: async () => 'v1',
      connectivityFn: async () => ({ ok: false, detail: 'sin red' }),
      serverProbeFn: async () => ({ ok: true, detail: 'ready' }),
    });

    expect(report.ready).toBe(false);
    expect(report.connectivity.detail).toBe('sin red');
  });
});

describe('provisión cerrada de tunnel-client', () => {
  const options = {
    binaryPath: 'C:\\runtime\\tunnel-client.exe',
    profileDir: 'C:\\profiles',
    profile: 'localbridge',
    tunnelId: TUNNEL_ID,
    serverCommand: "'C:\\runtime\\node.exe' 'C:\\runtime\\server.cjs'",
  };

  it('crea un perfil reemplazable con argumentos fijos y sin shell', async () => {
    const fake = completingSpawn(0, 'Created profile');

    await initializeTunnelProfile(options, { spawnFn: fake.spawnFn, isWindows: true });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe(options.binaryPath);
    expect(fake.calls[0]?.args).toEqual(expect.arrayContaining(['init', '--force', '--profile', 'localbridge', '--mcp-command', options.serverCommand]));
    expect(fake.calls[0]?.options.shell).toBe(false);
  });

  it('doctor recibe la clave solo por entorno filtrado y devuelve el fallo accionable', async () => {
    const previous = process.env['UNRELATED_SECRET_FOR_P2'];
    process.env['UNRELATED_SECRET_FOR_P2'] = 'no-heredar';
    const fake = completingSpawn(2, '{"checks":[]}', 'auth failed');

    try {
      const result = await diagnoseTunnelProfile(
        { ...options, apiKey: 'runtime-key-test', gitApprovalMode: 'host' },
        { spawnFn: fake.spawnFn, isWindows: true },
      );

      expect(result).toEqual({ ok: false, output: '{"checks":[]}\nauth failed' });
      expect(fake.calls[0]?.options.env?.['CONTROL_PLANE_API_KEY']).toBe('runtime-key-test');
      expect(fake.calls[0]?.options.env?.['LOCALBRIDGE_GIT_APPROVAL_MODE']).toBe('host');
      expect(fake.calls[0]?.options.env?.['UNRELATED_SECRET_FOR_P2']).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['UNRELATED_SECRET_FOR_P2'];
      else process.env['UNRELATED_SECRET_FOR_P2'] = previous;
    }
  });

  it('rechaza tunnel IDs y rutas no válidos antes de lanzar procesos', async () => {
    const fake = completingSpawn(0);

    await expect(initializeTunnelProfile({ ...options, tunnelId: 'tunnel_invalido' }, { spawnFn: fake.spawnFn })).rejects.toThrow();
    await expect(initializeTunnelProfile({ ...options, binaryPath: 'relativo.exe' }, { spawnFn: fake.spawnFn })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});
