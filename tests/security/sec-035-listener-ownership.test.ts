import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('SEC-035 — listener ligado al Job Object', () => {
  it('usa el Node autocontenido y nunca el ejecutable de Electron como lanzador', async () => {
    const [supervisor, main] = await Promise.all([
      readFile(path.resolve('packages/development/src/process-supervisor.ts'), 'utf8'),
      readFile(path.resolve('apps/desktop/src/main/index.ts'), 'utf8'),
    ]);
    expect(supervisor).toContain('this.options.nodeBinaryPath');
    expect(supervisor).not.toContain("'--', process.execPath, '-e', WINDOWS_PROFILE_LAUNCHER");
    expect(main).toContain('nodeBinaryPath: runtimePaths.nodeBinaryPath');
  });

  it.skipIf(process.platform !== 'win32')('rechaza puertos ajenos y clasifica wildcard administrado sin confiar en canales falsificables', async () => {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const verifier = path.resolve('scripts/verify-process-supervisor.mts');
    const { stdout } = await execFileAsync(process.execPath, [tsxCli, verifier], {
      cwd: process.cwd(),
      timeout: 15_000,
      windowsHide: true,
    });
    const evidence = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as Record<string, unknown>;
    expect(evidence).toMatchObject({
      verifiedLoopbackListener: true,
      foreignListenerRejected: true,
      verifiedManagedWildcard: true,
      forgedStdoutRejected: true,
      controlPipeNotInherited: true,
      staleListenerRejected: true,
      revocationImmediate: true,
    });
  }, 20_000);
});
