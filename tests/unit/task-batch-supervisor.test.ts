import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AnalysisJobSupervisor,
  DevelopmentBrokerError,
  TaskBatchSupervisor,
  type AnalysisJobExecutionContext,
  type AnalysisJobExecutionResult,
  type AnalysisJobRequest,
  type TaskBatchRequest,
  type TaskValidationContext,
  type TaskValidationResult,
} from '@localbridge/development';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localbridge-task-batch-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  readonly analysis: AnalysisJobSupervisor;
  readonly tasks: TaskBatchSupervisor;
  readonly starts: string[];
  readonly releases: Map<string, () => void>;
  readonly validationStarts: string[];
  close(): Promise<void>;
}

async function harness(options: { analysisConcurrency?: 1 | 2; blockAnalysis?: boolean; blockValidation?: boolean } = {}): Promise<Harness> {
  const root = await tempRoot();
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  const validationStarts: string[] = [];
  const analysis = new AnalysisJobSupervisor({
    journalPath: path.join(root, 'analysis.sqlite'),
    concurrencyForWorkspace: async () => options.analysisConcurrency ?? 2,
    execute: async (request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> => {
      starts.push(request.sourcePath ?? request.operationKind);
      context.progress({ stage: 'reading', completed: 1, total: 2, unit: 'items' });
      if (options.blockAnalysis === true) {
        await new Promise<void>((resolve, reject) => {
          releases.set(request.sourcePath ?? request.operationId, resolve);
          context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
        });
      }
      return {
        summary: { receipt: request.operationKind },
        coverage: { status: 'supported', bytesRead: 1, uniqueBytesRead: 1 },
        items: [{ kind: 'json', value: { ok: true } }],
        effectState: 'not_applied',
      };
    },
  });
  const tasks = new TaskBatchSupervisor({
    journalPath: path.join(root, 'tasks.sqlite'),
    analysis,
    revalidateRead: async () => undefined,
    runValidation: async (_workspaceId: string, profile: string, context: TaskValidationContext): Promise<TaskValidationResult> => {
      context.lockAcquired();
      context.started();
      validationStarts.push(profile);
      if (options.blockValidation === true) {
        await new Promise<void>((resolve, reject) => {
          releases.set(`validation:${profile}`, resolve);
          context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
        });
      }
      context.lockReleased();
      return { profile, exitCode: profile === 'fail' ? 2 : 0, stdout: 'ok', stderr: '', truncated: false, durationMs: 1, timedOut: false };
    },
  });
  return { analysis, tasks, starts, releases, validationStarts, close: async () => { await tasks.close(); await analysis.close(); } };
}

function batch(children: TaskBatchRequest['children'], operationId = 'batch_operation'): TaskBatchRequest {
  return { workspaceId: 'ws_batch', operationId, children, failurePolicy: 'continue' };
}

describe('TaskBatchSupervisor', () => {
  it('superpone hijos independientes y ordena dependencias sin duplicar el supervisor', async () => {
    const state = await harness({ analysisConcurrency: 2, blockAnalysis: true });
    const receipt = await state.tasks.runMany(batch([
      { localId: 'first', operationKind: 'artifact.hash', sourcePath: 'a.bin', parameters: {} },
      { localId: 'second', operationKind: 'artifact.hash', sourcePath: 'b.bin', parameters: {} },
      { localId: 'after', operationKind: 'artifact.inspect', sourcePath: 'c.bin', parameters: {}, dependsOn: ['first'] },
    ]));

    await waitUntil(() => state.starts.length === 2);
    expect(new Set(state.starts)).toEqual(new Set(['a.bin', 'b.bin']));
    let view = state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20);
    expect(view.children.find((child) => child.localId === 'after')?.state).toBe('waiting_dependency');

    state.releases.get('a.bin')?.();
    await waitUntil(() => state.starts.includes('c.bin'));
    state.releases.get('b.bin')?.();
    state.releases.get('c.bin')?.();
    await waitUntil(() => state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch.state === 'completed');
    view = state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20);
    expect(view.batch.counts.completed).toBe(3);
    expect(view.children.every((child) => child.analysisJobId?.startsWith('job_'))).toBe(true);
    expect(view.children[2]?.timing.dependencyWaitMs).toBeGreaterThan(0);
    await state.close();
  });

  it('deduplica intención concurrente y rechaza ciclos, IDs repetidos y destinos equivalentes', async () => {
    const state = await harness();
    const request = batch([{ localId: 'one', operationKind: 'artifact.hash', sourcePath: 'a.bin', parameters: {} }], 'same_intent');
    const [first, duplicate] = await Promise.all([state.tasks.runMany(request), state.tasks.runMany(request)]);
    expect(duplicate.batchId).toBe(first.batchId);
    await expect(state.tasks.runMany({ ...request, children: [{ ...request.children[0]!, sourcePath: 'b.bin' }] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(state.tasks.runMany(batch([
      { localId: 'a', operationKind: 'artifact.hash', sourcePath: 'a', parameters: {}, dependsOn: ['b'] },
      { localId: 'b', operationKind: 'artifact.hash', sourcePath: 'b', parameters: {}, dependsOn: ['a'] },
    ], 'cycle'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(state.tasks.runMany(batch([
      { localId: 'a', operationKind: 'web.download.start', sourcePath: 'OUT/file.zip', parameters: { sessionId: 's', tabId: 't', resourceRef: 'r' } },
      { localId: 'b', operationKind: 'web.download.start', sourcePath: 'out\\FILE.zip', parameters: { sessionId: 's', tabId: 't', resourceRef: 'r2' } },
    ], 'destinations'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await state.close();
  });

  it('entrega progreso parcial, espera por revisión y separa clientWaitMs de capacityWaitMs', async () => {
    const state = await harness({ analysisConcurrency: 1, blockAnalysis: true });
    const receipt = await state.tasks.runMany(batch([
      { localId: 'first', operationKind: 'artifact.hash', sourcePath: 'a.bin', parameters: {} },
      { localId: 'second', operationKind: 'artifact.hash', sourcePath: 'b.bin', parameters: {} },
    ], 'wait_case'));
    await waitUntil(() => state.starts.length === 1);
    const revision = state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch.revision;
    const pending = state.tasks.waitMany('ws_batch', receipt.batchId, revision, 'changed', 1_000);
    state.releases.get('a.bin')?.();
    const changed = await pending;
    expect(changed.deadlineReached).toBe(false);
    expect(changed.clientWaitMs).toBeGreaterThanOrEqual(0);
    await waitUntil(() => state.starts.includes('b.bin'));
    const second = state.tasks.statusMany('ws_batch', receipt.batchId, ['second'], 0, 20).children[0]!;
    expect(second.timing.capacityWaitMs).toBeGreaterThan(0);
    expect(second.timing.clientWaitMs).toBe(0);
    state.releases.get('b.bin')?.();
    await state.close();
  });

  it('cancela solo hijos propios, conserva resultados y valida la intención de cancelación', async () => {
    const state = await harness({ analysisConcurrency: 2, blockAnalysis: true });
    const receipt = await state.tasks.runMany(batch([
      { localId: 'keep', operationKind: 'artifact.hash', sourcePath: 'keep.bin', parameters: {} },
      { localId: 'cancel', operationKind: 'artifact.hash', sourcePath: 'cancel.bin', parameters: {} },
    ], 'cancel_case'));
    await waitUntil(() => state.starts.length === 2);
    state.tasks.cancelMany('ws_batch', receipt.batchId, ['cancel'], 'cancel_one');
    expect(() => state.tasks.cancelMany('ws_batch', receipt.batchId, ['keep'], 'cancel_one'))
      .toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    state.releases.get('keep.bin')?.();
    await waitUntil(() => ['partial', 'completed'].includes(state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch.state));
    const view = state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20);
    expect(view.children.find((child) => child.localId === 'keep')?.state).toBe('completed');
    expect(view.children.find((child) => child.localId === 'cancel')?.state).toBe('cancelled');
    await state.close();
  });

  it('ejecuta validaciones finitas, conserva exit code y cancela su árbol mediante signal', async () => {
    const state = await harness({ blockValidation: true });
    const receipt = await state.tasks.runMany(batch([
      { localId: 'lint', operationKind: 'validation.run', parameters: { profile: 'lint' } },
      { localId: 'tests', operationKind: 'validation.run', parameters: { profile: 'fail' } },
    ], 'validation_case'));
    await waitUntil(() => state.validationStarts.length === 2);
    state.releases.get('validation:lint')?.();
    state.releases.get('validation:fail')?.();
    await waitUntil(() => ['partial', 'failed'].includes(state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch.state));
    const view = state.tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20);
    expect(view.children.find((child) => child.localId === 'lint')).toMatchObject({ state: 'completed', result: { exitCode: 0 } });
    expect(view.children.find((child) => child.localId === 'tests')).toMatchObject({ state: 'failed', errorCode: 'VALIDATION_FAILED', result: { exitCode: 2 } });

    const cancelReceipt = await state.tasks.runMany(batch([
      { localId: 'build', operationKind: 'validation.run', parameters: { profile: 'build' } },
    ], 'validation_cancel'));
    await waitUntil(() => state.validationStarts.includes('build'));
    state.tasks.cancelMany('ws_batch', cancelReceipt.batchId, undefined, 'cancel_build');
    await waitUntil(() => state.tasks.statusMany('ws_batch', cancelReceipt.batchId, undefined, 0, 20).batch.state === 'cancelled');
    await state.close();
  });

  it('reconcilia recibos sin payloads ni replay tras reinicio', async () => {
    const root = await tempRoot();
    const analysis = new AnalysisJobSupervisor({
      journalPath: path.join(root, 'analysis.sqlite'), concurrencyForWorkspace: async () => 1,
      execute: async (_request, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
      }),
    });
    const journalPath = path.join(root, 'tasks.sqlite');
    const first = new TaskBatchSupervisor({
      journalPath, analysis, revalidateRead: async () => undefined,
      runValidation: async () => ({ profile: 'lint', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false }),
    });
    const receipt = await first.runMany(batch([{ localId: 'secret', operationKind: 'artifact.text.read', sourcePath: 'notes.txt', parameters: { maxChars: 1000, cursor: 'sensitive-cursor' } }], 'restart_case'));
    await waitUntil(() => first.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch.state === 'running');
    await first.close();
    await analysis.close();

    const bytes = await readFile(journalPath);
    expect(bytes.includes(Buffer.from('sensitive-cursor'))).toBe(false);
    const secondAnalysis = new AnalysisJobSupervisor({
      journalPath: path.join(root, 'analysis.sqlite'), concurrencyForWorkspace: async () => 1,
      execute: async () => { throw new Error('must not replay'); },
    });
    const second = new TaskBatchSupervisor({
      journalPath, analysis: secondAnalysis, revalidateRead: async () => undefined,
      runValidation: async () => { throw new Error('must not replay'); },
    });
    const restored = second.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch;
    expect(restored.state).toBe('interrupted');
    expect(restored.children[0]).toMatchObject({ state: 'interrupted', resultAvailable: false, resultExpired: true });
    await second.close();
    await secondAnalysis.close();
  });

  it('reserva el último presupuesto de admisión de forma indivisible antes de cualquier efecto', async () => {
    const root = await tempRoot();
    const starts: string[] = [];
    const analysis = new AnalysisJobSupervisor({
      journalPath: path.join(root, 'analysis.sqlite'), concurrencyForWorkspace: async () => 1,
      execute: async (request, context) => {
        starts.push(request.operationId);
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true }));
        throw new Error('unreachable');
      },
    });
    const tasks = new TaskBatchSupervisor({
      journalPath: path.join(root, 'tasks.sqlite'), analysis,
      limits: { maxNonTerminalBatches: 1, maxNonTerminalChildren: 1 },
      revalidateRead: async () => undefined,
      runValidation: async () => ({ profile: 'lint', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false }),
    });
    await tasks.runMany(batch([{ localId: 'one', operationKind: 'artifact.hash', sourcePath: 'one', parameters: {} }], 'capacity_one'));
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => tasks.runMany(batch([{ localId: 'two', operationKind: 'artifact.hash', sourcePath: 'two', parameters: {} }], 'capacity_two'))),
      Promise.resolve().then(() => tasks.runMany(batch([{ localId: 'three', operationKind: 'artifact.hash', sourcePath: 'three', parameters: {} }], 'capacity_three'))),
    ]);
    expect(attempts.every((attempt) => attempt.status === 'rejected')).toBe(true);
    await waitUntil(() => starts.length === 1);
    expect(starts).toHaveLength(1);
    await tasks.close();
    await analysis.close();
  });

  it('prevalida el lote completo una sola vez y no admite ni inicia efectos si una referencia falla', async () => {
    const root = await tempRoot();
    const starts: string[] = [];
    let preflights = 0;
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const analysis = new AnalysisJobSupervisor({
      journalPath: path.join(root, 'analysis.sqlite'), concurrencyForWorkspace: async () => 2,
      execute: async (request) => {
        starts.push(request.operationId);
        return { summary: {}, coverage: { status: 'supported', bytesRead: 0, uniqueBytesRead: 0 }, items: [] };
      },
    });
    const tasks = new TaskBatchSupervisor({
      journalPath: path.join(root, 'tasks.sqlite'), analysis,
      revalidateRead: async () => undefined,
      runValidation: async () => ({ profile: 'lint', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false }),
      preflightBatch: async (request) => {
        preflights += 1;
        await preflightGate;
        if (request.operationId === 'invalid_reference') {
          throw new DevelopmentBrokerError('WEB_RESOURCE_NOT_FOUND', 'stale');
        }
      },
    });
    const request = batch([{ localId: 'one', operationKind: 'artifact.hash', sourcePath: 'one', parameters: {} }], 'same_preflight');
    const first = tasks.runMany(request);
    const second = tasks.runMany(request);
    await waitUntil(() => preflights === 1);
    releasePreflight();
    const [left, right] = await Promise.all([first, second]);
    expect(right.batchId).toBe(left.batchId);
    expect(preflights).toBe(1);
    const startedBeforeRejectedBatch = starts.length;

    await expect(tasks.runMany(batch([
      { localId: 'safe', operationKind: 'artifact.hash', sourcePath: 'safe', parameters: {} },
      { localId: 'stale', operationKind: 'web.download.start', sourcePath: 'out.bin', parameters: { sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', tabId: 'webtab_aaaaaaaaaaaaaaaaaaaaaaaa', resourceRef: 'webresource_aaaaaaaaaaaaaaaaaaaa' } },
    ], 'invalid_reference'))).rejects.toMatchObject({ code: 'WEB_RESOURCE_NOT_FOUND' });
    expect(tasks.list('ws_batch', 0, 50).batches.some((entry) => entry.operationId === 'invalid_reference')).toBe(false);
    expect(starts).toHaveLength(startedBeforeRejectedBatch);
    await tasks.close();
    await analysis.close();
  });

  it('acota la metadata retenida y descarta primero los lotes terminales más antiguos', async () => {
    const root = await tempRoot();
    const analysis = new AnalysisJobSupervisor({
      journalPath: path.join(root, 'analysis.sqlite'),
      concurrencyForWorkspace: async () => 1,
      execute: async () => ({
        summary: {},
        coverage: { status: 'supported', bytesRead: 0, uniqueBytesRead: 0 },
        items: [],
      }),
    });
    const tasks = new TaskBatchSupervisor({
      journalPath: path.join(root, 'tasks.sqlite'),
      analysis,
      limits: { maxRetainedBatches: 2 },
      revalidateRead: async () => undefined,
      runValidation: async () => ({ profile: 'lint', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, timedOut: false }),
    });
    const receipts: Array<{ readonly batchId: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      const receipt = await tasks.runMany(batch([
        { localId: `hash_${index}`, operationKind: 'artifact.hash', sourcePath: `${index}.bin`, parameters: {} },
      ], `retention_${index}`));
      receipts.push(receipt);
      await waitUntil(() => tasks.statusMany('ws_batch', receipt.batchId, undefined, 0, 20).batch.state === 'completed');
    }
    expect(tasks.list('ws_batch', 0, 20).batches).toHaveLength(2);
    expect(() => tasks.statusMany('ws_batch', receipts[0]!.batchId, undefined, 0, 20))
      .toThrowError(expect.objectContaining({ code: 'ANALYSIS_JOB_NOT_FOUND' }));
    await tasks.close();
    await analysis.close();
  });
});
