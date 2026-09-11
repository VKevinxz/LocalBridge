import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAllAuditEvents } from '@localbridge/audit';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import {
  addGitRemote,
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initBareGitRepo,
  initGitRepo,
  tryCreateDirJunction,
  writeRegistryFile,
  type TempWorkspace,
} from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const run = promisify(execFile);
const REAL_GIT_TIMEOUT_MS = 30_000;
const workspaceId = 'ws_nested_git';
const repositoryPath = 'CIP-FRONTEND';

let workspace: TempWorkspace;
let remote: TempWorkspace;
let outside: TempWorkspace;
let repositoryRoot: string;
let configPath: string;
let auditDbPath: string;
let harness: Harness | undefined;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  remote = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
  repositoryRoot = path.join(workspace.root, repositoryPath);
  await mkdir(repositoryRoot, { recursive: true });
  await initGitRepo(repositoryRoot);
  await writeFile(path.join(repositoryRoot, 'README.md'), '# inicial\n');
  await gitCommitAll(repositoryRoot, 'commit inicial');
  await initBareGitRepo(remote.root);
  await addGitRemote(repositoryRoot, 'origin', remote.root);
  await run('git', ['push', '-u', 'origin', 'main'], { cwd: repositoryRoot });

  const configDir = path.join(os.tmpdir(), `localbridge-nested-git-${randomUUID()}`);
  configPath = path.join(configDir, 'workspaces.json');
  auditDbPath = path.join(configDir, 'audit.db');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: false, gitWrite: true },
    }),
  ]);
  harness = await createHarness({
    pinProtocol: TARGET_PROTOCOL_REVISION,
    workspaceConfigPath: configPath,
    auditDbPath,
    gitApprovalMode: 'host',
  });
}, REAL_GIT_TIMEOUT_MS);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await Promise.all([workspace.cleanup(), remote.cleanup(), outside.cleanup()]);
}, REAL_GIT_TIMEOUT_MS);

describe('Git estructurado sobre un repositorio interno', () => {
  it('[SEC-161] status -> stage -> commit -> push opera por repositoryPath sin terminal ni segunda ronda', async () => {
    await writeFile(path.join(repositoryRoot, 'README.md'), '# cambio estructurado\n');

    const status = await callToolJson(harness!.client, 'git.status', { workspaceId, repositoryPath });
    expect(status.isError).toBe(false);
    expect(status.parsed['entries']).toContainEqual(expect.objectContaining({
      path: 'CIP-FRONTEND/README.md',
      unstaged: true,
    }));

    const stage = await callToolJson(harness!.client, 'git.stage', {
      workspaceId,
      repositoryPath,
      paths: ['CIP-FRONTEND/README.md'],
    });
    expect(stage.isError).toBe(false);
    expect(stage.parsed).toEqual({ staged: ['CIP-FRONTEND/README.md'] });

    const commit = await callToolJson(harness!.client, 'git.commit', {
      workspaceId,
      repositoryPath,
      message: 'docs: prueba repositorio interno',
      operationId: 'nested_commit',
    });
    expect(commit.isError).toBe(false);
    const commitHash = commit.parsed['commitHash'] as string;
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);

    const push = await callToolJson(harness!.client, 'git.push', {
      workspaceId,
      repositoryPath,
      operationId: 'nested_push',
    });
    expect(push.isError).toBe(false);
    expect(push.parsed).toMatchObject({
      status: 'pushed',
      commitHash,
      remote: 'origin',
      branch: 'main',
      remoteVerified: true,
    });
    expect((await run('git', ['rev-parse', 'main'], { cwd: remote.root })).stdout.trim()).toBe(commitHash);

    const events = readAllAuditEvents(auditDbPath);
    expect(events.filter((event) => ['git.stage', 'git.commit', 'git.push'].includes(event.action)).map((event) => event.outcome)).toEqual([
      'success',
      'success',
      'success',
    ]);
    expect(events.some((event) => event.action.startsWith('terminal.'))).toBe(false);
  }, REAL_GIT_TIMEOUT_MS);

  it.each([
    ['ruta absoluta', 'C:\\fuera', 'ABSOLUTE_PATH_FORBIDDEN'],
    ['traversal', '../fuera', 'PATH_OUTSIDE_WORKSPACE'],
  ])('[SEC-162] rechaza repositoryPath con %s', async (_name, unsafePath, expectedCode) => {
    const result = await callToolJson(harness!.client, 'git.status', { workspaceId, repositoryPath: unsafePath });
    expect(result.isError).toBe(true);
    expect((result.parsed['error'] as { code: string }).code).toBe(expectedCode);
  });

  it('[SEC-163] rechaza paths de stage que no pertenecen al repositorio seleccionado', async () => {
    await writeFile(path.join(workspace.root, 'fuera-del-repo.txt'), 'no debe entrar\n');
    const result = await callToolJson(harness!.client, 'git.stage', {
      workspaceId,
      repositoryPath,
      paths: ['fuera-del-repo.txt'],
    });
    expect(result.isError).toBe(true);
    expect((result.parsed['error'] as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('[SEC-162] rechaza una junction de repositorio que escapa del workspace', async (context) => {
    await initGitRepo(outside.root);
    const linkPath = path.join(workspace.root, 'repo-link');
    const attempt = await tryCreateDirJunction(outside.root, linkPath);
    if (!attempt.created) {
      context.skip(`junction no disponible: ${attempt.reason ?? 'sin detalle'}`);
      return;
    }

    const result = await callToolJson(harness!.client, 'git.status', {
      workspaceId,
      repositoryPath: 'repo-link',
    });
    expect(result.isError).toBe(true);
    expect((result.parsed['error'] as { code: string }).code).toBe('SYMLINK_ESCAPE');
  });

  it('[SEC-164] no reutiliza un operationId de commit en otro repositorio interno', async () => {
    await writeFile(path.join(repositoryRoot, 'README.md'), '# primer repositorio\n');
    await callToolJson(harness!.client, 'git.stage', {
      workspaceId,
      repositoryPath,
      paths: ['CIP-FRONTEND/README.md'],
    });
    const first = await callToolJson(harness!.client, 'git.commit', {
      workspaceId,
      repositoryPath,
      message: 'mismo mensaje',
      operationId: 'repository_bound_commit',
    });
    expect(first.isError).toBe(false);

    const secondRepositoryPath = 'CIP-BACKEND';
    const secondRepositoryRoot = path.join(workspace.root, secondRepositoryPath);
    await mkdir(secondRepositoryRoot, { recursive: true });
    await initGitRepo(secondRepositoryRoot);
    await writeFile(path.join(secondRepositoryRoot, 'README.md'), '# inicial\n');
    await gitCommitAll(secondRepositoryRoot, 'commit inicial');
    await writeFile(path.join(secondRepositoryRoot, 'README.md'), '# segundo repositorio\n');
    await callToolJson(harness!.client, 'git.stage', {
      workspaceId,
      repositoryPath: secondRepositoryPath,
      paths: ['CIP-BACKEND/README.md'],
    });
    const headBefore = (await run('git', ['rev-parse', 'HEAD'], { cwd: secondRepositoryRoot })).stdout.trim();

    const replay = await callToolJson(harness!.client, 'git.commit', {
      workspaceId,
      repositoryPath: secondRepositoryPath,
      message: 'mismo mensaje',
      operationId: 'repository_bound_commit',
    });
    expect(replay.isError).toBe(true);
    expect((replay.parsed['error'] as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: secondRepositoryRoot })).stdout.trim()).toBe(headBefore);
  });
});
