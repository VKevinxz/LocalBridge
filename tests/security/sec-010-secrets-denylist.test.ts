import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-010] SECURITY.md Amenaza E — denylist de secretos, de punta a punta. */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_denylist';

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-denylist-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [buildWorkspace({ id: workspaceId, rootPath: workspace.root })]);

  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('[SEC-010] denylist de secretos', () => {
  it('file.read sobre ".env" -> PATH_DENIED, nunca se sirve el contenido', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: '.env' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_DENIED');
    expect(JSON.stringify(parsed)).not.toContain('SECRET=abc123');
  });

  it('file.read sobre "id_rsa" -> PATH_DENIED', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'id_rsa' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_DENIED');
  });

  it('file.metadata también deniega, aunque solo pida metadatos', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'file.metadata', { workspaceId, path: '.env' });
    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('PATH_DENIED');
  });

  it('workspace.tree omite los archivos denegados: no aparecen en la lista', async () => {
    const { isError, parsed } = await callToolJson(harness.client, 'workspace.tree', { workspaceId, relativePath: '.' });
    expect(isError).toBe(false);

    const entries = parsed['entries'] as Array<{ path: string }>;
    expect(entries.some((entry) => entry.path === '.env')).toBe(false);
    expect(entries.some((entry) => entry.path === 'id_rsa')).toBe(false);
    // El resto del proyecto sí se lista con normalidad.
    expect(entries.some((entry) => entry.path === 'README.md')).toBe(true);
  });
});
