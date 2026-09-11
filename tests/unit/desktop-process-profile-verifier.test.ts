import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { verifyProcessProfile } from '@localbridge/desktop-core';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

let rootPath: string;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function workspace(definitionHash: string, review = false): AuthorizedWorkspace {
  return {
    id: 'ws_profile',
    name: 'Perfil',
    rootPath,
    enabled: true,
    createdAt: new Date().toISOString(),
    permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false, processes: true },
    limits: { maxFileBytes: 1024, maxTreeEntries: 30, maxTreeDepth: 2, largeArtifacts: { mode: 'standard', reserve: { minimumFreeBytes: 1024 * 1024 * 1024, minimumFreePercent: 10 }, maxConcurrentJobs: 1 } },
    denyPatterns: ['.env'],
    validationProfiles: {},
    processProfiles: {
      dev: {
        command: ['npm', 'run', 'dev'],
        cwd: '.',
        source: { kind: 'package-script', manifestPath: 'package.json', script: 'dev', definitionSha256: definitionHash },
        maxRuntimeSeconds: 14_400,
      },
    },
    browserProfiles: {},
    automationReviewRequired: review,
  };
}

beforeEach(async () => {
  rootPath = path.join(os.tmpdir(), `localbridge-profile-${randomUUID()}`);
  await mkdir(rootPath, { recursive: true });
});

describe('verifyProcessProfile', () => {
  it('acepta una definición idéntica y detecta cualquier cambio posterior', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const configured = workspace(hash(JSON.stringify('vite')));
    await expect(verifyProcessProfile(configured, 'dev')).resolves.toMatchObject({ ok: true, code: 'READY' });

    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --host 0.0.0.0' } }));
    await expect(verifyProcessProfile(configured, 'dev')).resolves.toEqual({ ok: false, code: 'PROFILE_STALE' });
  });

  it('falla cerrado mientras una importación requiere revisión', async () => {
    await writeFile(path.join(rootPath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    await expect(verifyProcessProfile(workspace(hash(JSON.stringify('vite')), true), 'dev')).resolves.toEqual({
      ok: false,
      code: 'PROFILE_REVIEW_REQUIRED',
    });
  });
});
