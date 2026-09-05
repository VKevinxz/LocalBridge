import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/server';
import { queryPendingApprovals, readAllAuditEvents } from '@localbridge/audit';
import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import {
  addGitRemote,
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initBareGitRepo,
  initGitRepo,
  populateSampleProject,
  writeRegistryFile,
  type TempWorkspace,
} from '../helpers/fixtures.js';
import { createHarness } from '../helpers/harness.js';

const run = promisify(execFile);
const REAL_GIT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Prueba de extremo a extremo de ADR-0016: cliente y servidor reales,
 * conectados por un transporte en memoria (igual que el resto de
 * `tests/protocol` y `tests/security`), ejerciendo el round-trip MRTR
 * completo — no solo `resolveApproval` en aislamiento (eso ya está cubierto
 * en `tests/unit/approval.test.ts`), sino la tool real pidiendo la
 * aprobación, el "humano" (el handler de `elicitation/create` registrado en
 * el cliente) viendo el mensaje real, y el reintento aplicando la mutación.
 */

let workspace: TempWorkspace;
let configPath: string;
let auditDbPath: string;
const workspaceId = 'ws_git_write_mrtr';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await initGitRepo(workspace.root);
  await gitCommitAll(workspace.root, 'commit inicial');

  const configDir = path.join(os.tmpdir(), `localbridge-git-write-mrtr-${randomUUID()}`);
  configPath = path.join(configDir, 'workspaces.json');
  auditDbPath = path.join(configDir, 'audit.db');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: true, overwrite: false, gitRead: true, validations: false, gitWrite: true },
    }),
  ]);
}, REAL_GIT_HOOK_TIMEOUT_MS);

afterEach(async () => {
  await workspace.cleanup();
}, REAL_GIT_HOOK_TIMEOUT_MS);

function acceptHandler(seen: ElicitRequest[]): (request: ElicitRequest) => ElicitResult {
  return (request) => {
    seen.push(request);
    return { action: 'accept', content: { confirm: true } };
  };
}

function declineHandler(seen: ElicitRequest[]): (request: ElicitRequest) => ElicitResult {
  return (request) => {
    seen.push(request);
    return { action: 'decline' };
  };
}

async function headHash(root: string): Promise<string> {
  const result = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
  return result.stdout.trim();
}

describe('git.commit — round-trip MRTR real', () => {
  it('expone la espera mientras el humano decide y la limpia al aprobar', async () => {
    let notifyElicitation: (() => void) | undefined;
    let resolveDecision: ((result: ElicitResult) => void) | undefined;
    const elicitationReached = new Promise<void>((resolve) => {
      notifyElicitation = resolve;
    });
    const decision = new Promise<ElicitResult>((resolve) => {
      resolveDecision = resolve;
    });
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: async () => {
        notifyElicitation?.();
        return decision;
      },
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# esperando aprobación\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });
      const commitPromise = callToolJson(harness.client, 'git.commit', { workspaceId, message: 'espera visible' });

      await elicitationReached;
      const [pending] = queryPendingApprovals(auditDbPath);
      expect(pending?.workspaceId).toBe(workspaceId);
      expect(pending?.action).toBe('git.commit');
      const serializedPending = JSON.stringify(pending);
      expect(serializedPending).not.toContain(workspace.root);
      expect(serializedPending).not.toContain('espera visible');
      expect(serializedPending).not.toContain('README.md');

      resolveDecision?.({ action: 'accept', content: { confirm: true } });
      const commit = await commitPromise;
      expect(commit.isError).toBe(false);
      expect(queryPendingApprovals(auditDbPath)).toEqual([]);
    } finally {
      resolveDecision?.({ action: 'decline' });
      await harness.close();
    }
  });

  it('aprobar crea el commit real con el hash devuelto, y el humano ve mensaje/archivos/diff reales', async () => {
    const seen: ElicitRequest[] = [];
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: acceptHandler(seen),
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# cambiado de verdad\n');
      const stage = await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });
      expect(stage.isError).toBe(false);

      const commit = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'actualiza README vía MRTR' });

      expect(commit.isError).toBe(false);
      const commitHash = commit.parsed['commitHash'] as string;
      expect(commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(await headHash(workspace.root)).toBe(commitHash);

      expect(seen).toHaveLength(1);
      const message = (seen[0]?.params as { message?: string } | undefined)?.message ?? '';
      expect(message).toContain('actualiza README vía MRTR');
      expect(message).toContain('README.md');
      expect(message).toContain('# cambiado de verdad');

      const events = readAllAuditEvents(auditDbPath);
      const commitEvent = events.find((event) => event.action === 'git.commit' && event.outcome === 'success');
      expect(commitEvent?.decision).toBe('allow');
      expect(commitEvent?.resource).toBe(commitHash);

      // El diff real y el mensaje del commit viajan al cliente para que el
      // humano vea contenido real (ADR-0016 §5), pero SEC-026 exige que nada
      // de eso — ni la ruta absoluta del workspace — quede persistido en
      // audit.db: sólo el hash del commit resultante.
      const serializedEvents = JSON.stringify(events);
      expect(serializedEvents).not.toContain(workspace.root);
      expect(serializedEvents).not.toContain('# cambiado de verdad');
      expect(serializedEvents).not.toContain('actualiza README vía MRTR');
    } finally {
      await harness.close();
    }
  });

  it('declinar no crea ningún commit y audita APPROVAL_DECLINED con decision:deny', async () => {
    const seen: ElicitRequest[] = [];
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: declineHandler(seen),
    });

    try {
      const headBefore = await headHash(workspace.root);
      await writeFile(path.join(workspace.root, 'README.md'), '# intento rechazado\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });

      const commit = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'no debería aplicarse' });

      expect(commit.isError).toBe(true);
      expect((commit.parsed['error'] as { code: string }).code).toBe('APPROVAL_DECLINED');
      expect(await headHash(workspace.root)).toBe(headBefore);
      expect(seen).toHaveLength(1);

      const events = readAllAuditEvents(auditDbPath);
      const declined = events.find((event) => event.action === 'git.commit' && event.errorCode === 'APPROVAL_DECLINED');
      expect(declined?.decision).toBe('deny');
      expect(declined?.outcome).toBe('error');
      expect(queryPendingApprovals(auditDbPath)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('si cambia el staged durante la aprobación falla cerrado y retira la espera obsoleta', async () => {
    const headBefore = await headHash(workspace.root);
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: async () => {
        await writeFile(path.join(workspace.root, 'src', 'index.ts'), 'export const changedDuringApproval = true;\n');
        await run('git', ['add', '--', 'src/index.ts'], { cwd: workspace.root });
        return { action: 'accept', content: { confirm: true } };
      },
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# estado inicial\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });
      const commit = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'estado que cambió' });

      expect(commit.isError).toBe(true);
      expect((commit.parsed['error'] as { code: string }).code).toBe('APPROVAL_INVALID');
      expect(await headHash(workspace.root)).toBe(headBefore);
      expect(queryPendingApprovals(auditDbPath)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('sin nada staged -> INVALID_INPUT sin pedir aprobación (el handler nunca se invoca)', async () => {
    const seen: ElicitRequest[] = [];
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: acceptHandler(seen),
    });

    try {
      const commit = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'nada que commitear' });

      expect(commit.isError).toBe(true);
      expect((commit.parsed['error'] as { code: string }).code).toBe('INVALID_INPUT');
      expect(seen).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('operationId: reintentar tras aprobar devuelve el mismo resultado sin crear un segundo commit ni pedir aprobación otra vez', async () => {
    const seen: ElicitRequest[] = [];
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: acceptHandler(seen),
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# idempotente\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });

      const operationId = 'op_commit_idempotente';
      const first = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'commit idempotente', operationId });
      expect(first.isError).toBe(false);
      expect(seen).toHaveLength(1);

      const headAfterFirst = await headHash(workspace.root);

      const second = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'commit idempotente', operationId });
      expect(second.isError).toBe(false);
      expect(second.parsed).toEqual(first.parsed);
      // Ningún segundo intento de aprobación: el caché de idempotencia
      // responde antes de siquiera construir el mensaje de aprobación.
      expect(seen).toHaveLength(1);
      expect(await headHash(workspace.root)).toBe(headAfterFirst);
    } finally {
      await harness.close();
    }
  });
});

describe('git.push — round-trip MRTR real, contra un remoto real', () => {
  let remoteRoot: string;

  beforeEach(async () => {
    const remoteWorkspace = await createTempWorkspaceDir();
    remoteRoot = remoteWorkspace.root;
    await initBareGitRepo(remoteRoot);
    await addGitRemote(workspace.root, 'origin', remoteRoot);
    await run('git', ['push', '-u', 'origin', 'main'], { cwd: workspace.root });
  }, REAL_GIT_HOOK_TIMEOUT_MS);

  it('aprobar publica el commit en el remoto real, y el humano ve qué commits se publicarían', async () => {
    const seen: ElicitRequest[] = [];
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: acceptHandler(seen),
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# para publicar\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });
      const commit = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'commit a publicar' });
      expect(commit.isError).toBe(false);
      const commitHash = commit.parsed['commitHash'] as string;
      expect(seen).toHaveLength(1); // la del commit

      const push = await callToolJson(harness.client, 'git.push', { workspaceId });
      expect(push.isError).toBe(false);
      expect(seen).toHaveLength(2); // la del commit + la del push

      const remoteHead = await run('git', ['rev-parse', 'main'], { cwd: remoteRoot });
      expect(remoteHead.stdout.trim()).toBe(commitHash);

      const pushMessage = (seen[1]?.params as { message?: string } | undefined)?.message ?? '';
      expect(pushMessage).toContain('commit a publicar');
    } finally {
      await harness.close();
    }
  });

  it('aprobar el commit NO aprueba automáticamente el push (son aprobaciones separadas)', async () => {
    const seen: ElicitRequest[] = [];
    let pushCalls = 0;
    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      elicitHandler: (request) => {
        seen.push(request);
        // Decide según lo que se está aprobando: el commit se aprueba, el
        // push se declina — si aprobar el commit "contagiara" al push, este
        // handler nunca se invocaría para el push.
        const message = (request.params as { message?: string }).message ?? '';
        if (message.startsWith('Push to')) {
          pushCalls += 1;
          return { action: 'decline' };
        }
        return { action: 'accept', content: { confirm: true } };
      },
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# commit ok, push no\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });
      const commit = await callToolJson(harness.client, 'git.commit', { workspaceId, message: 'este commit sí se aprueba' });
      expect(commit.isError).toBe(false);

      const remoteHeadBefore = await run('git', ['rev-parse', 'main'], { cwd: remoteRoot });

      const push = await callToolJson(harness.client, 'git.push', { workspaceId });
      expect(push.isError).toBe(true);
      expect((push.parsed['error'] as { code: string }).code).toBe('APPROVAL_DECLINED');
      expect(pushCalls).toBe(1);

      const remoteHeadAfter = await run('git', ['rev-parse', 'main'], { cwd: remoteRoot });
      expect(remoteHeadAfter.stdout).toBe(remoteHeadBefore.stdout);
    } finally {
      await harness.close();
    }
  });
});

describe('Git write — aprobación nativa delegada al host', () => {
  it('commit y push se ejecutan en una sola llamada cada uno, sin segunda ronda MRTR', async () => {
    const remoteWorkspace = await createTempWorkspaceDir();
    await initBareGitRepo(remoteWorkspace.root);
    await addGitRemote(workspace.root, 'origin', remoteWorkspace.root);
    await run('git', ['push', '-u', 'origin', 'main'], { cwd: workspace.root });

    const harness = await createHarness({
      pinProtocol: TARGET_PROTOCOL_REVISION,
      workspaceConfigPath: configPath,
      auditDbPath,
      gitApprovalMode: 'host',
      // Deliberadamente sin elicitHandler: cualquier segunda ronda MRTR hace
      // fallar el test en lugar de aprobarse accidentalmente.
    });

    try {
      await writeFile(path.join(workspace.root, 'README.md'), '# aprobación nativa\n');
      await callToolJson(harness.client, 'git.stage', { workspaceId, paths: ['README.md'] });

      const commit = await callToolJson(harness.client, 'git.commit', {
        workspaceId,
        message: 'prueba aprobación nativa',
      });
      expect(commit.isError).toBe(false);
      const commitHash = commit.parsed['commitHash'] as string;
      expect(commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(queryPendingApprovals(auditDbPath)).toEqual([]);

      const push = await callToolJson(harness.client, 'git.push', { workspaceId });
      expect(push.isError).toBe(false);
      expect(push.parsed).toMatchObject({
        status: 'pushed',
        commitHash,
        remote: 'origin',
        branch: 'main',
        remoteVerified: true,
        localTrackingSynchronized: true,
      });
      const remoteHead = await run('git', ['rev-parse', 'main'], { cwd: remoteWorkspace.root });
      expect(remoteHead.stdout.trim()).toBe(commitHash);
    } finally {
      await harness.close();
      await remoteWorkspace.cleanup();
    }
  });
});
