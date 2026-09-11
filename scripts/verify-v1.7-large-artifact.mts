import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ArtifactAnalysisRuntime } from '../apps/desktop/src/main/artifact-analysis-runtime.js';
import type { AnalysisJobExecutionContext, AnalysisJobRequest } from '@localbridge/development';
import { createLogger } from '@localbridge/shared';

const requestedPath = process.argv[2] ?? 'D:\\Proyectos\\Analizar-DLSSFG-for-nvidia-rtx-30\\version.dll';
const absolutePath = path.resolve(requestedPath);
const metadata = await stat(absolutePath);
if (!metadata.isFile()) throw new Error('the verification target is not a file');

const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'localbridge-v1.7-physical-'));
const configPath = path.join(privateRoot, 'workspace-registry.json');
const workspaceId = 'ws_v17_physical';
const relativePath = path.basename(absolutePath);
const workspace = {
  id: workspaceId,
  name: 'v1.7 physical verification',
  rootPath: path.dirname(absolutePath),
  enabled: true,
  createdAt: new Date().toISOString(),
  permissions: {
    read: true, write: false, overwrite: false, gitRead: false, validations: false,
    gitWrite: false, processes: false, browserRead: false, browserInteract: false,
    browserHumanControl: false,
  },
  limits: {
    maxFileBytes: 1024 * 1024,
    maxTreeEntries: 100,
    maxTreeDepth: 3,
    largeArtifacts: {
      mode: 'adaptive',
      reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 },
      maxConcurrentJobs: 1,
    },
  },
  denyPatterns: ['.env', '.env.*', '*.pem', '*.key', 'id_rsa', 'id_ed25519', 'credentials.json', '.npmrc', '.netrc', '.git/config'],
  validationProfiles: {}, processProfiles: {}, browserProfiles: {}, automationReviewRequired: false,
};
await writeFile(configPath, JSON.stringify({ schemaVersion: 5, workspaces: [workspace], applications: [] }));

const runtime = new ArtifactAnalysisRuntime({
  workspaceConfigPath: configPath,
  logger: createLogger({ level: 'error' }),
  cursorSigningKey: Buffer.from('physical-verifier-only'),
});
const controller = new AbortController();
const context: AnalysisJobExecutionContext = {
  signal: controller.signal,
  progress: () => undefined,
  effectStarted: () => undefined,
  effectApplied: () => undefined,
  effectNotApplied: () => undefined,
};
const request = (operationKind: AnalysisJobRequest['operationKind'], operationId: string, parameters: Record<string, unknown>): AnalysisJobRequest => ({
  operationKind, operationId, workspaceId, sourcePath: relativePath, parameters,
});

try {
  const inspection = await runtime.execute(request('artifact.inspect', 'physical_inspect', {}), context);
  const hash = await runtime.execute(request('artifact.hash', 'physical_hash', {}), context);
  const binary = await runtime.execute(request('binary.inspect', 'physical_pe', { depth: 'standard' }), context);
  const binaryResult = binary.items.find((item) => item.kind === 'json');
  process.stdout.write(`${JSON.stringify({
    path: relativePath,
    sourceBytes: metadata.size,
    inspection: inspection.summary,
    hash: hash.summary,
    binary: binaryResult?.kind === 'json' ? binaryResult.value : binary.summary,
    executedBinary: false,
  })}\n`);
} finally {
  await rm(privateRoot, { recursive: true, force: true });
}
