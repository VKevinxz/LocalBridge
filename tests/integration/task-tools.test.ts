import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AnalysisJobSupervisor,
  TaskBatchSupervisor,
  createDevelopmentRuntimeHandler,
  startDevelopmentBroker,
  type RunningDevelopmentBroker,
} from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { createLogger, TARGET_PROTOCOL_REVISION } from '@localbridge/shared';
import { runValidation } from '@localbridge/validation';
import { ArtifactAnalysisRuntime } from '../../apps/desktop/src/main/artifact-analysis-runtime.js';
import { buildWorkspace, createTempWorkspaceDir, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let workspace: TempWorkspace;
let privateRoot: string;
let configPath: string;
let broker: RunningDevelopmentBroker | undefined;
let analysis: AnalysisJobSupervisor | undefined;
let tasks: TaskBatchSupervisor | undefined;
const harnesses: Harness[] = [];
const logger = createLogger({ level: 'error' });

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  privateRoot = path.join(os.tmpdir(), `localbridge-task-tools-${randomUUID()}`);
  configPath = path.join(privateRoot, 'workspaces.json');
  await mkdir(privateRoot, { recursive: true });
  await writeFile(path.join(workspace.root, 'a.txt'), 'alpha'.repeat(10_000));
  await writeFile(path.join(workspace.root, 'b.txt'), 'beta'.repeat(10_000));
  await writeRegistryFile(configPath, [buildWorkspace({
    id: 'ws_tasks',
    rootPath: workspace.root,
    permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: true, gitWrite: false },
    validationProfiles: {
      ok: [process.execPath, '-e', 'process.stdout.write("validation-ok")'],
      fail: [process.execPath, '-e', 'process.stderr.write("validation-failed");process.exit(3)'],
    },
    limits: {
      maxFileBytes: 1024 * 1024,
      maxTreeEntries: 100,
      maxTreeDepth: 8,
      largeArtifacts: { mode: 'adaptive', reserve: { minimumFreeBytes: 64 * 1024 * 1024, minimumFreePercent: 1 }, maxConcurrentJobs: 2 },
    },
  })]);
  const runtime = new ArtifactAnalysisRuntime({
    workspaceConfigPath: configPath,
    logger,
    cursorSigningKey: Buffer.from('task-tools-cursor-key'),
    documentWorkerPath: path.resolve('packages/mcp-server/src/document-worker.mjs'),
  });
  analysis = new AnalysisJobSupervisor({
    journalPath: path.join(privateRoot, 'analysis.sqlite'), execute: runtime.execute,
    concurrencyForWorkspace: async () => 2,
  });
  tasks = new TaskBatchSupervisor({
    journalPath: path.join(privateRoot, 'tasks.sqlite'),
    analysis,
    revalidateRead: async (workspaceId) => { await requireAuthorizedWorkspace(configPath, logger, workspaceId, 'read'); },
    runValidation: async (workspaceId, profile, context) => {
      const authorized = await requireAuthorizedWorkspace(configPath, logger, workspaceId, 'validations');
      return runValidation(authorized, profile, {
        signal: context.signal,
        onStarted: context.started,
        onLockAcquired: context.lockAcquired,
        onLockReleased: context.lockReleased,
      });
    },
  });
  broker = await startDevelopmentBroker({ handler: createDevelopmentRuntimeHandler({ processes: {} as never, analysis, tasks }) });
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((item) => item.close()));
  await broker?.close();
  await tasks?.close();
  await analysis?.close();
  await rm(privateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await workspace.cleanup();
});

async function connect(): Promise<Harness> {
  const harness = await createHarness({
    pinProtocol: TARGET_PROTOCOL_REVISION,
    workspaceConfigPath: configPath,
    developmentBrokerEndpoint: broker!.endpoint,
    developmentBrokerToken: broker!.token,
  });
  harnesses.push(harness);
  return harness;
}

async function call(harness: Harness, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await harness.client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

describe('task.* vía MCP y broker', () => {
  it('ejecuta análisis y validación con progreso parcial, dependencias y resultados equivalentes', async () => {
    const harness = await connect();
    const receipt = await call(harness, 'task.runMany', {
      workspaceId: 'ws_tasks', operationId: 'mcp_batch_1', failurePolicy: 'continue',
      children: [
        { localId: 'hash_a', operationKind: 'artifact.hash', sourcePath: 'a.txt', parameters: {}, dependsOn: [] },
        { localId: 'hash_b', operationKind: 'artifact.hash', sourcePath: 'b.txt', parameters: {}, dependsOn: [] },
        { localId: 'validation', operationKind: 'validation.run', parameters: { profile: 'ok' }, dependsOn: ['hash_a'] },
      ],
    });
    const batchId = String(receipt['batchId']);
    let batch = receipt;
    const deadline = Date.now() + 5_000;
    while (!['completed', 'partial', 'failed'].includes(String(batch['state'])) && Date.now() < deadline) {
      const waited = await call(harness, 'task.waitMany', {
        workspaceId: 'ws_tasks', batchId, afterRevision: batch['revision'], condition: 'changed', waitMs: 1_000,
      });
      expect(Number(waited['clientWaitMs'])).toBeGreaterThanOrEqual(0);
      batch = waited['batch'] as Record<string, unknown>;
    }
    expect(batch['state']).toBe('completed');
    const status = await call(harness, 'task.statusMany', { workspaceId: 'ws_tasks', batchId, cursor: 0, limit: 20 });
    const children = status['children'] as Array<Record<string, unknown>>;
    expect(children).toHaveLength(3);
    expect(children.find((child) => child['localId'] === 'validation')?.['result']).toMatchObject({
      exitCode: 0, stdout: 'validation-ok', timedOut: false,
    });
    const hashChild = children.find((child) => child['localId'] === 'hash_a')!;
    const analysisStatus = await call(harness, 'analysis.status', {
      workspaceId: 'ws_tasks', jobId: hashChild['analysisJobId'], cursor: 0, maxItems: 10,
    });
    expect(((analysisStatus['job'] as Record<string, unknown>)['summary'] as Record<string, unknown>)['sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('recupera la misma intención entre dos clientes y rechaza rutas negadas antes de admitir efectos', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    const args = {
      workspaceId: 'ws_tasks', operationId: 'shared_batch',
      children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath: 'a.txt', parameters: {}, dependsOn: [] }],
    };
    const [left, right] = await Promise.all([call(first, 'task.runMany', args), call(second, 'task.runMany', args)]);
    expect(right['batchId']).toBe(left['batchId']);

    const denied = await first.client.callTool({
      name: 'task.runMany',
      arguments: {
        workspaceId: 'ws_tasks', operationId: 'denied_batch',
        children: [{ localId: 'secret', operationKind: 'artifact.hash', sourcePath: '.env', parameters: {}, dependsOn: [] }],
      },
    });
    expect(denied.isError).toBe(true);
    const listed = await call(first, 'task.list', { workspaceId: 'ws_tasks', cursor: 0, limit: 20 });
    expect((listed['batches'] as Array<Record<string, unknown>>).some((item) => item['operationId'] === 'denied_batch')).toBe(false);
  });

  it('informa exit code fallido como hijo final y cancela con intención estable', async () => {
    const harness = await connect();
    const receipt = await call(harness, 'task.runMany', {
      workspaceId: 'ws_tasks', operationId: 'failed_validation',
      children: [{ localId: 'fail', operationKind: 'validation.run', parameters: { profile: 'fail' }, dependsOn: [] }],
    });
    const batchId = String(receipt['batchId']);
    let view = await call(harness, 'task.statusMany', { workspaceId: 'ws_tasks', batchId, cursor: 0, limit: 20 });
    const deadline = Date.now() + 5_000;
    while ((view['batch'] as Record<string, unknown>)['state'] !== 'failed' && Date.now() < deadline) {
      view = await call(harness, 'task.statusMany', { workspaceId: 'ws_tasks', batchId, cursor: 0, limit: 20 });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((view['children'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'failed', errorCode: 'VALIDATION_FAILED', result: { exitCode: 3, stderr: 'validation-failed' },
    });
    const cancelled = await call(harness, 'task.cancelMany', {
      workspaceId: 'ws_tasks', batchId, localIds: ['fail'], operationId: 'cancel_finished',
    });
    expect(cancelled['state']).toBe('failed');
  });
});
