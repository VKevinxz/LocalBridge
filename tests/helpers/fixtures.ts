/**
 * Fixtures de filesystem para tests de seguridad e integración.
 *
 * Los tests de symlink/junction se saltan explícitamente con aviso si el
 * entorno no permite crearlos (TEST_PLAN.md §9) — nunca se dan por pasados en
 * silencio: se marcan `skip` y el motivo queda en el nombre del test.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AuthorizedWorkspace, LocalApplication } from '@localbridge/workspace';

export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

export async function createTempWorkspaceDir(): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localbridge-test-'));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Rellena un workspace temporal con una estructura representativa para los tests. */
export async function populateSampleProject(root: string): Promise<void> {
  await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'some-dep'), { recursive: true });
  await mkdir(path.join(root, '.git', 'objects'), { recursive: true });

  await writeFile(path.join(root, 'README.md'), '# sample\n');
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const hello = "world";\n');
  await writeFile(path.join(root, 'src', 'lib', 'util.ts'), 'export const util = 1;\n');
  await writeFile(path.join(root, 'node_modules', 'some-dep', 'index.js'), 'module.exports = {};\n');
  await writeFile(path.join(root, '.git', 'objects', 'pack-info'), 'not a real git object\n');
  await writeFile(path.join(root, '.env'), 'SECRET=abc123\n');
  await writeFile(path.join(root, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
}

const DEFAULT_LIMITS = { maxFileBytes: 1_048_576, maxTreeEntries: 300, maxTreeDepth: 3 };

export function buildWorkspace(overrides: Partial<AuthorizedWorkspace> & { rootPath: string }): AuthorizedWorkspace {
  return {
    id: overrides.id ?? `ws_${randomUUID().slice(0, 8)}`,
    name: overrides.name ?? 'test-workspace',
    rootPath: overrides.rootPath,
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    permissions: overrides.permissions ?? {
      read: true,
      write: false,
      overwrite: false,
      gitRead: false,
      validations: false,
      gitWrite: false,
    },
    limits: overrides.limits ?? DEFAULT_LIMITS,
    denyPatterns: overrides.denyPatterns ?? [
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa',
      'id_ed25519',
      'credentials.json',
      '.npmrc',
      '.netrc',
      '.git/config',
    ],
    validationProfiles: overrides.validationProfiles ?? {},
    processProfiles: overrides.processProfiles ?? {},
    browserProfiles: overrides.browserProfiles ?? {},
    automationReviewRequired: overrides.automationReviewRequired ?? false,
  };
}

/** Escribe un registro de workspaces real en disco, para tests de extremo a extremo. */
export async function writeRegistryFile(configPath: string, workspaces: readonly AuthorizedWorkspace[], applications: readonly LocalApplication[] = []): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 4, workspaces, applications }, null, 2));
}

/**
 * Inicializa un repositorio Git real en `root`, con identidad y config local
 * propias — nunca hereda la global del usuario, para que los tests sean
 * deterministas en cualquier máquina.
 */
export async function initGitRepo(root: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const git = (args: string[]) => run('git', args, { cwd: root });

  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@localbridge.invalid']);
  await git(['config', 'user.name', 'LocalBridge Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.autocrlf', 'false']);
}

/** Repo bare, para usar como remoto real en tests de `git.push` — sin depender de red. */
export async function initBareGitRepo(root: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  await run('git', ['init', '--bare', '--initial-branch=main', root]);
}

export async function addGitRemote(root: string, name: string, remotePath: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  await run('git', ['remote', 'add', name, remotePath], { cwd: root });
}

export async function gitCommitAll(root: string, message: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', message], { cwd: root });
}

export interface SymlinkAttempt {
  created: boolean;
  reason?: string;
}

/**
 * Intenta crear un symlink de archivo. En Windows requiere modo desarrollador
 * u privilegios elevados; si falla, se reporta para que el test se salte con
 * aviso en vez de fallar por un problema del entorno, no del código.
 */
export async function tryCreateFileSymlink(target: string, linkPath: string): Promise<SymlinkAttempt> {
  try {
    await symlink(target, linkPath, 'file');
    return { created: true };
  } catch (error) {
    return { created: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Junction de directorio: no requiere privilegios elevados en Windows, pero el target debe ser absoluto. */
export async function tryCreateDirJunction(target: string, linkPath: string): Promise<SymlinkAttempt> {
  try {
    await symlink(path.resolve(target), linkPath, 'junction');
    return { created: true };
  } catch (error) {
    return { created: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
