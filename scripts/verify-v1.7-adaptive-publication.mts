import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { createWorkspaceBinaryFileFromChunks } from '@localbridge/filesystem';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

const targetBytes = Number(process.env['LOCALBRIDGE_ADAPTIVE_VERIFY_BYTES'] ?? 1024 * 1024 * 1024 + 1);
if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) throw new Error('invalid verification size');
const rootPath = await mkdtemp(path.join(process.cwd(), '.v17-adaptive-publication-'));
const workspace: AuthorizedWorkspace = {
  id: 'ws_v17_adaptive_write',
  name: 'v1.7 adaptive publication verification',
  rootPath,
  enabled: true,
  createdAt: new Date().toISOString(),
  permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
  limits: {
    maxFileBytes: 1024 * 1024,
    maxTreeEntries: 30,
    maxTreeDepth: 2,
    largeArtifacts: {
      mode: 'adaptive',
      reserve: { minimumFreeBytes: 512 * 1024 * 1024, minimumFreePercent: 1 },
      maxConcurrentJobs: 1,
    },
  },
  denyPatterns: ['.env', '*.pem', '*.key'],
  validationProfiles: {},
  processProfiles: {},
  browserProfiles: {},
  automationReviewRequired: false,
};
const chunk = Buffer.alloc(8 * 1024 * 1024, 0x5a);
let authorityChecks = 0;
let authoritySectionChecks = 0;
const startedAt = Date.now();

try {
  const result = await createWorkspaceBinaryFileFromChunks(workspace, 'download.bin', async (writer) => {
    while (writer.size < targetBytes) {
      const remaining = targetBytes - writer.size;
      await writer.write(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining));
    }
  }, {
    adaptive: true,
    reserveFreeBytes: workspace.limits.largeArtifacts.reserve.minimumFreeBytes,
    reserveFreePercent: workspace.limits.largeArtifacts.reserve.minimumFreePercent,
    checkAuthority: async () => { authorityChecks += 1; },
    withAuthorizedEffect: async (effect) => {
      authoritySectionChecks += 1;
      const value = await effect();
      authoritySectionChecks += 1;
      return value;
    },
  });
  const physical = await stat(path.join(rootPath, 'download.bin'));
  if (result.size !== targetBytes || physical.size !== targetBytes) throw new Error('published size mismatch');
  if (authorityChecks < 3 || authoritySectionChecks !== 4) throw new Error('stream authority was not revalidated before final publication');
  process.stdout.write(`${JSON.stringify({
    targetBytes,
    publishedBytes: result.size,
    sha256: result.sha256,
    authorityChecks,
    authoritySectionChecks,
    elapsedMs: Date.now() - startedAt,
    adaptive: true,
    removedAfterVerification: true,
  })}\n`);
} finally {
  await rm(rootPath, { recursive: true, force: true });
}
