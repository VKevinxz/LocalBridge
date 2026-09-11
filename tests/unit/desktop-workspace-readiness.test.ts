import { describe, expect, it, vi } from 'vitest';

import { testWorkspaceReadiness } from '@localbridge/desktop-core';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

function workspace(overrides: Partial<AuthorizedWorkspace> = {}): AuthorizedWorkspace {
  return {
    id: 'ws_ready',
    name: 'Proyecto',
    rootPath: 'D:\\Proyecto',
    enabled: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    permissions: { read: true, write: false, overwrite: false, gitRead: true, validations: true, gitWrite: true },
    limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 } },
    denyPatterns: ['.env'],
    validationProfiles: { test: ['pnpm', 'test'] },
    ...overrides,
  };
}

describe('readiness de workspace', () => {
  it('detecta carpeta, toolchain, repositorio, remoto y helper sin ejecutar validaciones', async () => {
    const runGitFn = vi.fn(async (args: readonly string[]) => ({
      stdout: args[0] === 'rev-parse' ? 'true\n' : args[0] === 'remote' ? 'git@example/repo.git\n' : 'manager\n',
      stderr: '', exitCode: 0, truncated: false,
    }));
    const report = await testWorkspaceReadiness(workspace(), {
      statFn: vi.fn(async () => ({ isDirectory: () => true, isFile: () => true })) as never,
      findExecutableFn: vi.fn(async () => true),
      runGitFn,
    });

    expect(report.ready).toBe(true);
    expect(report.checks.map((check) => check.label)).toEqual([
      'Carpeta local', 'Toolchain pnpm', 'Repositorio Git', 'Remoto Git', 'Credenciales Git',
    ]);
    expect(runGitFn).not.toHaveBeenCalledWith(expect.arrayContaining(['push']), expect.anything());
  });

  it('se detiene y falla cerrado si la carpeta ya no existe', async () => {
    const runGitFn = vi.fn();
    const report = await testWorkspaceReadiness(workspace(), {
      statFn: vi.fn(async () => Promise.reject(new Error('ENOENT'))) as never,
      findExecutableFn: vi.fn(async () => true),
      runGitFn,
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(runGitFn).not.toHaveBeenCalled();
  });
});
