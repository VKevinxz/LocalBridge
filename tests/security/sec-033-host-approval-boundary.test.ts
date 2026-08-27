import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import {
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initGitRepo,
  populateSampleProject,
  writeRegistryFile,
  type TempWorkspace,
} from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const run = promisify(execFile);
const workspaceId = 'ws_sec_host_approval';
let workspace: TempWorkspace | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  await workspace?.cleanup();
  harness = undefined;
  workspace = undefined;
});

async function setup(gitWrite: boolean, mode: 'mrtr' | 'host'): Promise<string> {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await initGitRepo(workspace.root);
  await gitCommitAll(workspace.root, 'inicial');
  const configPath = path.join(os.tmpdir(), `localbridge-sec-host-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: false, gitRead: true, validations: false, gitWrite },
    }),
  ]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath, gitApprovalMode: mode });
  return workspace.root;
}

describe('[SEC-033] límite del modo de aprobación delegado al host', () => {
  it('MRTR predeterminado nunca convierte una primera llamada sin respuesta en aprobación', async () => {
    const root = await setup(true, 'mrtr');
    const before = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await writeFile(path.join(root, 'README.md'), '# pendiente\n');
    await callToolJson(harness!.client, 'git.stage', { workspaceId, paths: ['README.md'] });

    await callToolJson(harness!.client, 'git.commit', { workspaceId, message: 'no autorizado' }).catch(() => undefined);

    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()).toBe(before);
  });

  it('modo host no sustituye el permiso gitWrite del workspace', async () => {
    const root = await setup(false, 'host');
    const before = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

    const result = await callToolJson(harness!.client, 'git.commit', { workspaceId, message: 'sin permiso' });

    expect(result.isError).toBe(true);
    expect((result.parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()).toBe(before);
  });
});
