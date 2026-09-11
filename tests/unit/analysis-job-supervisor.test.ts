import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnalysisJobSupervisor, type AnalysisJobExecutor } from '@localbridge/development';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function journalPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `localbridge-analysis-${randomUUID()}-`));
  roots.push(root);
  return path.join(root, 'analysis.sqlite');
}

async function eventually<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout waiting for analysis state');
}

function request(operationId = 'operation-1') {
  return {
    operationKind: 'artifact.inspect' as const,
    operationId,
    workspaceId: 'ws_demo',
    sourcePath: 'large.bin',
    parameters: { depth: 'quick' },
  };
}

function completionSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AnalysisJobSupervisor', () => {
  it('deduplica la misma intención y rechaza el mismo operationId con payload distinto', async () => {
    const execute = vi.fn<AnalysisJobExecutor>(async () => ({
      summary: { format: 'binary' },
      coverage: { status: 'supported', bytesRead: 64, uniqueBytesRead: 64, sourceBytes: 64 },
      items: [{ kind: 'json', value: { ok: true } }],
    }));
    const supervisor = new AnalysisJobSupervisor({
      journalPath: await journalPath(),
      execute,
      concurrencyForWorkspace: async () => 1,
    });
    const first = supervisor.start(request());
    for (let duplicate = 0; duplicate < 10; duplicate += 1) {
      expect(supervisor.start(request()).jobId).toBe(first.jobId);
    }
    expect(() => supervisor.start({ ...request(), parameters: { depth: 'deep' } })).toThrow('operationId');
    await eventually(
      () => supervisor.status('ws_demo', first.jobId, 0, 10),
      (status) => status.job.state === 'completed',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.status('ws_demo', first.jobId, 0, 10)).toMatchObject({
      resultsAvailable: true,
      items: [{ kind: 'json', value: { ok: true } }],
    });
    await supervisor.close();
  });

  it('encola cuando el worker está ocupado y permite cancelar solo el job objetivo', async () => {
    let releaseFirst: (() => void) | undefined;
    const execute: AnalysisJobExecutor = (job, context) => new Promise((resolve, reject) => {
      const finish = () => resolve({
        summary: { operationId: job.operationId },
        coverage: { status: 'supported', bytesRead: 1, uniqueBytesRead: 1 },
        items: [],
      });
      if (job.operationId === 'first') releaseFirst = finish;
      else finish();
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
    });
    const supervisor = new AnalysisJobSupervisor({ journalPath: await journalPath(), execute, concurrencyForWorkspace: async () => 1 });
    const first = supervisor.start(request('first'));
    const second = supervisor.start(request('second'));
    await eventually(() => supervisor.status('ws_demo', first.jobId, 0, 10).job.state, (state) => state === 'running');
    expect(supervisor.status('ws_demo', second.jobId, 0, 10).job.state).toBe('queued');
    expect(supervisor.cancel('ws_demo', second.jobId).state).toBe('cancelled');
    releaseFirst?.();
    await eventually(() => supervisor.status('ws_demo', first.jobId, 0, 10).job.state, (state) => state === 'completed');
    await supervisor.close();
  });

  it('cancela todos los jobs no terminales del workspace retirado sin afectar otro workspace', async () => {
    const supervisor = new AnalysisJobSupervisor({
      journalPath: await journalPath(),
      execute: (job, context) => job.workspaceId === 'ws_demo'
        ? new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(
          Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' }),
        ), { once: true }))
        : Promise.resolve({ summary: {}, coverage: { status: 'supported', bytesRead: 1, uniqueBytesRead: 1 }, items: [] }),
      concurrencyForWorkspace: async () => 1,
    });
    const first = supervisor.start(request('remove-first'));
    const second = supervisor.start(request('remove-second'));
    await eventually(() => supervisor.status('ws_demo', first.jobId, 0, 1).job.state, (state) => state === 'running');
    const other = supervisor.start({ ...request('keep-other'), workspaceId: 'ws_other' });

    expect((await supervisor.cancelWorkspace('ws_demo')).map((job) => job.jobId).toSorted()).toEqual(
      [first.jobId, second.jobId].toSorted(),
    );
    expect(supervisor.status('ws_demo', first.jobId, 0, 1).job.state).toBe('cancelled');
    expect(supervisor.status('ws_demo', second.jobId, 0, 1).job.state).toBe('cancelled');
    await eventually(
      () => supervisor.status('ws_other', other.jobId, 0, 1).job.state,
      (state) => state === 'completed',
    );
    await supervisor.close();
  });

  it('acota la concurrencia global aunque varios workspaces permitan dos jobs', async () => {
    let active = 0;
    let maximumActive = 0;
    let batchStarted = completionSignal();
    const allCompleted = completionSignal();
    const releases: Array<() => void> = [];
    let jobs: Array<ReturnType<AnalysisJobSupervisor['start']>> = [];
    const supervisor = new AnalysisJobSupervisor({
      journalPath: await journalPath(),
      execute: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (active >= 2) batchStarted.resolve();
        });
        active -= 1;
        return { summary: {}, coverage: { status: 'supported', bytesRead: 1, uniqueBytesRead: 1 }, items: [] };
      },
      concurrencyForWorkspace: async () => 2,
      maxGlobalRunningJobs: 2,
      onChange: () => {
        if (jobs.length === 8 && jobs.every((job) => supervisor.status(job.workspaceId, job.jobId, 0, 1).job.state === 'completed')) {
          allCompleted.resolve();
        }
      },
    });
    try {
      jobs = Array.from({ length: 8 }, (_value, index) => supervisor.start({
        ...request(`global-${index}`),
        workspaceId: `ws_${index % 4}`,
      }));
      for (let batch = 0; batch < 4; batch += 1) {
        await batchStarted.promise;
        // Deja que el scheduler intente admitir más trabajo mientras los dos
        // ejecutores permanecen retenidos: un exceso de concurrencia es visible.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const states = jobs.map((job) => supervisor.status(job.workspaceId, job.jobId, 0, 1).job.state);
        expect(states.filter((state) => state === 'running')).toHaveLength(2);
        expect(states.filter((state) => state === 'queued')).toHaveLength(6 - batch * 2);
        expect(active).toBe(2);
        expect(maximumActive).toBe(2);
        batchStarted = completionSignal();
        releases.splice(0).forEach((release) => release());
      }
      await allCompleted.promise;
      expect(jobs.every((job) => supervisor.status(job.workspaceId, job.jobId, 0, 1).job.state === 'completed')).toBe(true);
      expect(active).toBe(0);
      expect(maximumActive).toBe(2);
    } finally {
      releases.splice(0).forEach((release) => release());
      await supervisor.close();
    }
  });

  it('reconcilia como interrupted un estado no terminal guardado antes de reiniciar', async () => {
    const journal = await journalPath();
    let releaseConcurrency: (() => void) | undefined;
    const pendingConcurrency = new Promise<1>((resolve) => { releaseConcurrency = () => resolve(1); });
    const first = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async () => ({ summary: {}, coverage: { status: 'partial', bytesRead: 0, uniqueBytesRead: 0 }, items: [] }),
      concurrencyForWorkspace: () => pendingConcurrency,
    });
    const admitted = first.start(request());
    expect(first.status('ws_demo', admitted.jobId, 0, 10).job.state).toBe('queued');

    const restarted = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async () => ({ summary: {}, coverage: { status: 'partial', bytesRead: 0, uniqueBytesRead: 0 }, items: [] }),
      concurrencyForWorkspace: async () => 1,
    });
    expect(restarted.status('ws_demo', admitted.jobId, 0, 10).job).toMatchObject({
      state: 'interrupted',
      errorCode: 'ANALYSIS_INTERRUPTED',
      resumeCapability: 'restart',
    });
    await restarted.close();
    await first.close();
    releaseConcurrency?.();
  });

  it('recupera recibos sin copiar contenido de solo lectura al almacén privado', async () => {
    const journal = await journalPath();
    const first = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async () => ({
        summary: { format: 'text' },
        coverage: { status: 'partial', bytesRead: 5, uniqueBytesRead: 5, sourceBytes: 12 },
        items: [{ kind: 'text', text: 'hello' }],
      }),
      concurrencyForWorkspace: async () => 1,
    });
    const admitted = first.start({ ...request(), operationKind: 'artifact.text.read' });
    await eventually(() => first.status('ws_demo', admitted.jobId, 0, 10), (status) => status.job.state === 'completed');
    const journalBytes = await readFile(journal);
    const walBytes = await readFile(`${journal}-wal`).catch(() => Buffer.alloc(0));
    expect(Buffer.concat([journalBytes, walBytes]).includes(Buffer.from('hello'))).toBe(false);
    await first.close();

    const restarted = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async () => ({ summary: {}, coverage: { status: 'partial', bytesRead: 0, uniqueBytesRead: 0 }, items: [] }),
      concurrencyForWorkspace: async () => 1,
    });
    expect(restarted.status('ws_demo', admitted.jobId, 0, 10)).toMatchObject({
      job: { state: 'completed', summary: { format: 'text' }, resumeCapability: 'restart' },
      resultsAvailable: false,
      items: [],
    });
    await restarted.close();
  });

  it('persiste la frontera de un efecto y no lo ofrece para replay tras un crash', async () => {
    const journal = await journalPath();
    let effectPersisted: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => { effectPersisted = resolve; });
    const first = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async (_request, context) => {
        context.effectStarted({ destinationPath: 'downloads/file.bin', publication: 'pending' });
        effectPersisted?.();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
        });
        throw new Error('unreachable');
      },
      concurrencyForWorkspace: async () => 1,
    });
    const admitted = first.start({
      ...request('download-effect'),
      operationKind: 'web.download.start',
      sourcePath: 'downloads/file.bin',
    });
    await persisted;

    // Simula otro Desktop leyendo el journal después de una terminación no
    // limpia: el executor no vuelve a arrancar y el efecto se declara incierto.
    const executeAfterRestart = vi.fn<AnalysisJobExecutor>();
    const restarted = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: executeAfterRestart,
      concurrencyForWorkspace: async () => 1,
    });
    expect(restarted.status('ws_demo', admitted.jobId, 0, 10).job).toMatchObject({
      state: 'interrupted',
      effectState: 'uncertain',
      resumeCapability: 'none',
      summary: { destinationPath: 'downloads/file.bin', publication: 'pending' },
    });
    expect(executeAfterRestart).not.toHaveBeenCalled();
    await restarted.close();
    await first.close();
  });

  it('un cierre ordenado tampoco convierte un efecto incierto en reiniciable', async () => {
    const journal = await journalPath();
    let effectPersisted: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => { effectPersisted = resolve; });
    const first = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async (_request, context) => {
        context.effectStarted({ destinationPath: 'downloads/uncertain.bin', publication: 'pending' });
        effectPersisted?.();
        return new Promise<never>(() => undefined);
      },
      concurrencyForWorkspace: async () => 1,
    });
    const admitted = first.start({
      ...request('orderly-close-after-effect'),
      operationKind: 'web.download.start',
      sourcePath: 'downloads/uncertain.bin',
    });
    await persisted;
    await first.close();

    const restarted = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: vi.fn<AnalysisJobExecutor>(),
      concurrencyForWorkspace: async () => 1,
    });
    expect(restarted.status('ws_demo', admitted.jobId, 0, 10).job).toMatchObject({
      state: 'interrupted',
      effectState: 'uncertain',
      resumeCapability: 'none',
      summary: { destinationPath: 'downloads/uncertain.bin', publication: 'pending' },
    });
    await restarted.close();
  });

  it('conserva un recibo aplicado si falla la persistencia final del resultado', async () => {
    const journal = await journalPath();
    const oversized = 'x'.repeat(33 * 1024 * 1024);
    const supervisor = new AnalysisJobSupervisor({
      journalPath: journal,
      execute: async (_request, context) => {
        const receipt = { path: 'downloads/file.bin', sha256: 'a'.repeat(64), size: 12 };
        context.effectStarted({ path: 'downloads/file.bin', publication: 'pending' });
        context.effectApplied(receipt);
        return {
          summary: receipt,
          coverage: { status: 'supported', bytesRead: 12, uniqueBytesRead: 12, sourceBytes: 12 },
          items: [{ kind: 'text', text: oversized }],
          effectState: 'applied',
        };
      },
      concurrencyForWorkspace: async () => 1,
    });
    const admitted = supervisor.start({
      ...request('applied-result-persistence-failure'),
      operationKind: 'web.download.start',
      sourcePath: 'downloads/file.bin',
    });
    const status = await eventually(
      () => supervisor.status('ws_demo', admitted.jobId, 0, 10),
      (value) => value.job.state === 'failed',
    );
    expect(status).toMatchObject({
      job: {
        state: 'failed', effectState: 'applied', resumeCapability: 'result_only',
        summary: { path: 'downloads/file.bin', size: 12 },
      },
      resultsAvailable: false,
    });
    await supervisor.close();
  });
});
