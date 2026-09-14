import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
  AnalysisJobSupervisor,
  RuntimeResourceCoordinator,
  TaskBatchSupervisor,
  type TaskBatchRequest,
  type TaskBatchSnapshot,
} from '@localbridge/development';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { createLogger } from '@localbridge/shared';
import { runValidation } from '@localbridge/validation';
import { resolveSafePath } from '@localbridge/workspace';

import { ArtifactAnalysisRuntime } from '../apps/desktop/src/main/artifact-analysis-runtime.js';
import { buildPdfFixture } from '../tests/helpers/pdf-fixture.js';
import { buildWorkspace, writeRegistryFile } from '../tests/helpers/fixtures.js';

const REPETITIONS = 3;
const HASH_BYTES = 16 * 1024 * 1024;
const TERMINAL = new Set(['cancelled', 'completed', 'partial', 'failed', 'interrupted']);

interface Sample {
  readonly scenario: string;
  readonly mode: 'serial' | 'concurrent';
  readonly repetition: number;
  readonly cache: 'first-pass' | 'warm';
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
  readonly childProcessesExpected: number;
  readonly result: string;
  readonly childTimingMs?: Readonly<Record<'admission' | 'dependencyWait' | 'capacityWait' | 'lockWait' | 'lockHold' | 'execution' | 'persistence' | 'deliveryAssembly', number>>;
}

function batchMeasurement(batches: readonly TaskBatchSnapshot[]): Pick<Sample, 'result' | 'childTimingMs'> {
  const children = batches.flatMap((batch) => batch.children);
  const sum = (field: keyof TaskBatchSnapshot['children'][number]['timing']) =>
    children.reduce((total, child) => total + Number(child.timing[field]), 0);
  return {
    result: batches.map((batch) => batch.state).join(','),
    childTimingMs: {
      admission: sum('admissionMs'),
      dependencyWait: sum('dependencyWaitMs'),
      capacityWait: sum('capacityWaitMs'),
      lockWait: sum('lockWaitMs'),
      lockHold: sum('lockHoldMs'),
      execution: sum('executionMs'),
      persistence: sum('persistenceMs'),
      deliveryAssembly: batches.reduce((total, batch) => total + batch.deliveryMs, 0),
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

async function measure(
  scenario: string,
  mode: Sample['mode'],
  repetition: number,
  childProcessesExpected: number,
  operation: () => Promise<string | TaskBatchSnapshot | readonly TaskBatchSnapshot[]>,
): Promise<Sample> {
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const result = await operation();
  const measured = typeof result === 'string'
    ? { result }
    : batchMeasurement(Array.isArray(result) ? result : [result as TaskBatchSnapshot]);
  return {
    scenario,
    mode,
    repetition,
    cache: repetition === 1 ? 'first-pass' : 'warm',
    elapsedMs: Math.max(0, performance.now() - started),
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    childProcessesExpected,
    ...measured,
  };
}

async function waitBatch(tasks: TaskBatchSupervisor, receipt: TaskBatchSnapshot): Promise<TaskBatchSnapshot> {
  let current = receipt;
  const deadline = Date.now() + 30_000;
  while (!TERMINAL.has(current.state)) {
    if (Date.now() >= deadline) throw new Error(`benchmark batch timeout: ${current.operationId}`);
    const waited = await tasks.waitMany(current.workspaceId, current.batchId, current.revision, 'changed', 2_000);
    current = waited.batch;
  }
  if (current.state !== 'completed') throw new Error(`benchmark batch failed: ${current.operationId}:${current.state}`);
  return current;
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localbridge-v1.8-benchmark-'));
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const privateRoot = path.join(root, 'private');
  const registryPath = path.join(privateRoot, 'workspaces.json');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB), mkdir(privateRoot)]);

  const firstBytes = randomBytes(HASH_BYTES);
  const secondBytes = randomBytes(HASH_BYTES);
  const pdf = buildPdfFixture({ pages: ['LocalBridge benchmark page one', 'LocalBridge benchmark page two'] });
  await Promise.all([
    writeFile(path.join(workspaceA, 'first.bin'), firstBytes),
    writeFile(path.join(workspaceA, 'second.bin'), secondBytes),
    writeFile(path.join(workspaceA, 'document-a.pdf'), pdf),
    writeFile(path.join(workspaceA, 'document-b.pdf'), pdf),
    writeFile(path.join(workspaceB, 'first.bin'), firstBytes),
  ]);

  const permissions = { read: true, write: true, overwrite: false, gitRead: false, validations: true, gitWrite: false };
  const limits = {
    maxFileBytes: 1024 * 1024,
    maxTreeEntries: 100,
    maxTreeDepth: 8,
    largeArtifacts: { mode: 'adaptive' as const, reserve: { minimumFreeBytes: 64 * 1024 * 1024, minimumFreePercent: 1 }, maxConcurrentJobs: 2 as const },
  };
  const validationProfiles = {
    first: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 180)'],
    second: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 180)'],
  };
  await writeRegistryFile(registryPath, [
    buildWorkspace({ id: 'ws_benchmark_a', rootPath: workspaceA, permissions, limits, validationProfiles }),
    buildWorkspace({ id: 'ws_benchmark_b', rootPath: workspaceB, permissions, limits, validationProfiles }),
  ]);

  const logger = createLogger({ level: 'error', stream: new Writable({ write: (_chunk, _encoding, callback) => callback() }) });
  const runtime = new ArtifactAnalysisRuntime({
    workspaceConfigPath: registryPath,
    logger,
    cursorSigningKey: Buffer.from('localbridge-v1.8-benchmark-cursor'),
    documentWorkerPath: path.resolve('packages/mcp-server/src/document-worker.mjs'),
  });
  const analysis = new AnalysisJobSupervisor({
    journalPath: path.join(privateRoot, 'analysis.sqlite'),
    execute: runtime.execute,
    maxGlobalRunningJobs: 4,
    concurrencyForWorkspace: async () => 2,
  });
  const tasks = new TaskBatchSupervisor({
    journalPath: path.join(privateRoot, 'tasks.sqlite'),
    analysis,
    preflightBatch: async (request) => {
      const workspace = await requireAuthorizedWorkspace(registryPath, logger, request.workspaceId, 'read');
      for (const child of request.children) {
        if (child.operationKind === 'validation.run') {
          if (workspace.validationProfiles[String(child.parameters['profile'])] === undefined) throw new Error('profile missing');
        } else {
          const source = await resolveSafePath(workspace.rootPath, child.sourcePath!);
          if (!source.exists) throw new Error('source missing');
        }
      }
    },
    revalidateRead: async (workspaceId) => { await requireAuthorizedWorkspace(registryPath, logger, workspaceId, 'read'); },
    runValidation: async (workspaceId, profile, context) => {
      const workspace = await requireAuthorizedWorkspace(registryPath, logger, workspaceId, 'validations');
      return runValidation(workspace, profile, {
        signal: context.signal,
        onStarted: context.started,
        onLockAcquired: context.lockAcquired,
        onLockReleased: context.lockReleased,
      });
    },
  });
  const samples: Sample[] = [];
  const run = async (request: TaskBatchRequest) => waitBatch(tasks, await tasks.runMany(request));
  try {
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      const hashDocumentChildren: TaskBatchRequest['children'] = [
        { localId: 'hash-first', operationKind: 'artifact.hash', sourcePath: 'first.bin', parameters: {} },
        { localId: 'hash-second', operationKind: 'artifact.hash', sourcePath: 'second.bin', parameters: {} },
        { localId: 'doc-first', operationKind: 'document.process', sourcePath: 'document-a.pdf', parameters: { mode: 'read', maxChars: 50_000 } },
        { localId: 'doc-second', operationKind: 'document.process', sourcePath: 'document-b.pdf', parameters: { mode: 'read', maxChars: 50_000 } },
      ];
      samples.push(await measure('hashes-and-documents', 'serial', repetition, 2, async () => {
        let previous: string | undefined;
        const children = hashDocumentChildren.map((child) => {
          const value = { ...child, ...(previous === undefined ? {} : { dependsOn: [previous] }) };
          previous = child.localId;
          return value;
        });
        return run({ workspaceId: 'ws_benchmark_a', operationId: `hash_doc_serial_${repetition}`, children, failurePolicy: 'continue' });
      }));
      samples.push(await measure('hashes-and-documents', 'concurrent', repetition, 2, async () =>
        run({ workspaceId: 'ws_benchmark_a', operationId: `hash_doc_concurrent_${repetition}`, children: hashDocumentChildren, failurePolicy: 'continue' })));

      const validations: TaskBatchRequest['children'] = [
        { localId: 'first', operationKind: 'validation.run', parameters: { profile: 'first' } },
        { localId: 'second', operationKind: 'validation.run', parameters: { profile: 'second' } },
      ];
      samples.push(await measure('validations-same-workspace', 'serial', repetition, 2, async () =>
        run({ workspaceId: 'ws_benchmark_a', operationId: `validation_serial_${repetition}`, children: [validations[0]!, { ...validations[1]!, dependsOn: ['first'] }], failurePolicy: 'continue' })));
      samples.push(await measure('validations-same-workspace', 'concurrent', repetition, 2, async () =>
        run({ workspaceId: 'ws_benchmark_a', operationId: `validation_concurrent_${repetition}`, children: validations, failurePolicy: 'continue' })));

      samples.push(await measure('hashes-two-workspaces', 'serial', repetition, 0, async () => {
        const first = await run({ workspaceId: 'ws_benchmark_a', operationId: `two_ws_a_serial_${repetition}`, children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath: 'first.bin', parameters: {} }], failurePolicy: 'continue' });
        const second = await run({ workspaceId: 'ws_benchmark_b', operationId: `two_ws_b_serial_${repetition}`, children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath: 'first.bin', parameters: {} }], failurePolicy: 'continue' });
        return [first, second];
      }));
      samples.push(await measure('hashes-two-workspaces', 'concurrent', repetition, 0, async () => {
        return Promise.all([
          run({ workspaceId: 'ws_benchmark_a', operationId: `two_ws_a_concurrent_${repetition}`, children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath: 'first.bin', parameters: {} }], failurePolicy: 'continue' }),
          run({ workspaceId: 'ws_benchmark_b', operationId: `two_ws_b_concurrent_${repetition}`, children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath: 'first.bin', parameters: {} }], failurePolicy: 'continue' }),
        ]);
      }));

      const coordinator = new RuntimeResourceCoordinator();
      const qaStep = (key: string) => coordinator.run(key, () => new Promise<string>((resolve) => setTimeout(() => resolve('observed'), 120)));
      samples.push(await measure('original-local-coordinator', 'serial', repetition, 0, async () => {
        await qaStep('web:websession_reference');
        await qaStep('browser:ws_benchmark_a:session_candidate');
        return 'observed';
      }));
      samples.push(await measure('original-local-coordinator', 'concurrent', repetition, 0, async () => {
        await Promise.all([qaStep('web:websession_reference'), qaStep('browser:ws_benchmark_a:session_candidate')]);
        return 'observed';
      }));
    }
  } finally {
    await tasks.close();
    await analysis.close();
  }

  const groups = [...new Set(samples.map((sample) => sample.scenario))].map((scenario) => {
    const serial = samples.filter((sample) => sample.scenario === scenario && sample.mode === 'serial').map((sample) => sample.elapsedMs);
    const concurrent = samples.filter((sample) => sample.scenario === scenario && sample.mode === 'concurrent').map((sample) => sample.elapsedMs);
    const serialMedian = percentile(serial, 0.5);
    const concurrentMedian = percentile(concurrent, 0.5);
    return {
      scenario,
      serialMedianMs: serialMedian,
      concurrentMedianMs: concurrentMedian,
      speedup: concurrentMedian === 0 ? 0 : serialMedian / concurrentMedian,
      serialP95Ms: percentile(serial, 0.95),
      concurrentP95Ms: percentile(concurrent, 0.95),
    };
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productVersion: '1.8.0-candidate',
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? 'unknown', totalMemoryBytes: os.totalmem() },
    methodology: {
      repetitions: REPETITIONS,
      cachePolicy: 'The first pass is labelled first-pass; operating-system caches are not forcibly flushed. Later passes are warm.',
      clientTiming: 'Each elapsedMs spans one benchmark client submission through terminal batch status. Child timing separately reports admission, dependency, capacity, lock, execution, persistence and response assembly.',
      originalLocalScope: 'Coordinator-only synthetic observation delay on two independent browser resource identities; no Chromium rendering or fidelity claim.',
      configurationIsolation: 'Temporary registry, journals and workspaces only; active LocalBridge user configuration is never read or modified.',
    },
    fixtures: {
      hashBytesPerFile: HASH_BYTES,
      firstSha256: sha256(firstBytes),
      secondSha256: sha256(secondBytes),
      pdfBytes: pdf.byteLength,
      pdfSha256: sha256(pdf),
    },
    groups,
    samples,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const output = process.argv[2];
  if (output === undefined) process.stdout.write(json);
  else await writeFile(path.resolve(output), json, { encoding: 'utf8', flag: 'w' });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

await main();
