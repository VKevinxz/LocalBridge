import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, writeRegistryFile, type TempWorkspace } from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/** [SEC-019] y [SEC-023] — `validation.run`, de punta a punta (TOOL_CATALOG.md §9). */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_sec_validation';

function nodeCommand(script: string): string[] {
  return [process.execPath, '-e', script];
}

async function setUp(validationProfiles: Record<string, string[]>): Promise<void> {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);

  const configPath = path.join(os.tmpdir(), `localbridge-sec-validation-${randomUUID()}`, 'workspaces.json');
  await writeRegistryFile(configPath, [
    buildWorkspace({
      id: workspaceId,
      rootPath: workspace.root,
      permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: true, gitWrite: false },
      validationProfiles,
    }),
  ]);
  harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });
}

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('[SEC-023] perfil no configurado', () => {
  it('COMMAND_NOT_ALLOWED, no ejecuta nada', async () => {
    await setUp({ test: nodeCommand('console.log("no debería verse")') });

    const { isError, parsed } = await callToolJson(harness.client, 'validation.run', {
      workspaceId,
      profile: 'deploy-a-produccion',
    });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('un workspace sin ningún perfil configurado deniega cualquier nombre', async () => {
    await setUp({});

    const { isError, parsed } = await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'test' });

    expect(isError).toBe(true);
    expect((parsed['error'] as { code: string }).code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('el modelo no puede pasar un comando: el schema no acepta más que "profile"', async () => {
    await setUp({ test: nodeCommand('console.log("ok")') });

    const tools = await harness.client.listTools(undefined, { cacheMode: 'bypass' });
    const tool = tools.tools.find((t) => t.name === 'validation.run');
    const properties = Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {});

    expect(properties.toSorted()).toEqual(['profile', 'workspaceId']);
  });
});

describe('[SEC-019] salida infinita', () => {
  it('se trunca en vez de colgar la llamada', async () => {
    await setUp({
      ruidoso: nodeCommand('while (true) { process.stdout.write("x".repeat(65536)); }'),
    });

    const start = Date.now();
    const { isError, parsed } = await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'ruidoso' });
    const elapsedMs = Date.now() - start;

    expect(isError).toBe(false);
    expect(parsed['truncated']).toBe(true);
    expect((parsed['stdout'] as string).length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);
});

describe('validation.run — resultado normal', () => {
  it('un exitCode distinto de 0 es un resultado exitoso de la tool, no un error', async () => {
    await setUp({ test: nodeCommand('console.log("fallo simulado"); process.exit(1);') });

    const { isError, parsed } = await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'test' });

    expect(isError).toBe(false);
    expect(parsed['exitCode']).toBe(1);
    expect(parsed['stdout']).toContain('fallo simulado');
    expect(parsed['timedOut']).toBe(false);
  });

  it('el permiso validations=false deniega la tool', async () => {
    await setUp({ test: nodeCommand('console.log("no debería ejecutarse")') });

    const configPath = path.join(os.tmpdir(), `localbridge-sec-validation-noperm-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_no_val',
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
        validationProfiles: { test: nodeCommand('console.log("no")') },
      }),
    ]);
    const restricted = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    try {
      const { isError, parsed } = await callToolJson(restricted.client, 'validation.run', {
        workspaceId: 'ws_no_val',
        profile: 'test',
      });
      expect(isError).toBe(true);
      expect((parsed['error'] as { code: string }).code).toBe('CAPABILITY_DISABLED');
    } finally {
      await restricted.close();
    }
  });
});
