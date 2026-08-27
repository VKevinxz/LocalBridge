import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import { callToolJson } from '../helpers/call.js';
import {
  buildWorkspace,
  createTempWorkspaceDir,
  gitCommitAll,
  initGitRepo,
  populateSampleProject,
  writeRegistryFile,
  type TempWorkspace,
} from '../helpers/fixtures.js';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * Integración de Fase 5 y cierre del escenario E2E de TEST_PLAN.md §7:
 * "Lee el proyecto, cambia hello.ts, ejecuta los tests y muéstrame el diff" —
 * ahora con las seis tools de lectura/escritura/Git/validación encadenadas,
 * sin ningún shell genérico.
 */

let harness: Harness;
let workspace: TempWorkspace;
const workspaceId = 'ws_int_phase5';

function nodeCommand(script: string): string[] {
  return [process.execPath, '-e', script];
}

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
  await initGitRepo(workspace.root);
  await gitCommitAll(workspace.root, 'commit inicial');
});

afterEach(async () => {
  await harness.close();
  await workspace.cleanup();
});

describe('validation.run', () => {
  it('ejecuta el perfil elegido y devuelve stdout/stderr/exitCode reales', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-integration5-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: true, gitWrite: false },
        validationProfiles: {
          test: nodeCommand('console.log("3 passed"); process.exitCode = 0;'),
        },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const result = await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'test' });

    expect(result.isError).toBe(false);
    expect(result.parsed['exitCode']).toBe(0);
    expect(result.parsed['stdout']).toContain('3 passed');
  });
});

describe('escenario E2E completo (TEST_PLAN.md §7)', () => {
  it('tree -> read -> write_guarded -> validation.run -> git.diff, sin shell genérico', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-integration5-e2e-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: true, validations: true, gitWrite: false },
        validationProfiles: {
          test: nodeCommand(
            'const fs = require("fs"); const c = fs.readFileSync("src/index.ts", "utf8"); process.exit(c.includes("hola") ? 0 : 1);',
          ),
        },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    // 1. Descubre el proyecto.
    const tree = await callToolJson(harness.client, 'workspace.tree', { workspaceId, relativePath: 'src' });
    expect(tree.isError).toBe(false);

    // 2. Lee el archivo a modificar.
    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    expect(read.isError).toBe(false);

    // 3. Lo modifica de forma guardada por hash.
    const write = await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'export function hello(name: string) {\n  return `hola ${name}`;\n}\n',
    });
    expect(write.isError).toBe(false);

    // 4. Ejecuta los tests preaprobados — sin shell, sin comando libre.
    const test = await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'test' });
    expect(test.isError).toBe(false);
    expect(test.parsed['exitCode']).toBe(0);

    // 5. Enseña el diff del cambio.
    const diff = await callToolJson(harness.client, 'git.diff', { workspaceId, filePath: 'src/index.ts' });
    expect(diff.isError).toBe(false);
    expect(diff.parsed['diff']).toContain('hola');
  });

  it('si el cambio rompe la validación, el agente lo ve en el exitCode, no como error de tool', async () => {
    const configPath = path.join(os.tmpdir(), `localbridge-integration5-fail-${randomUUID()}`, 'workspaces.json');
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: workspaceId,
        rootPath: workspace.root,
        permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: true, gitWrite: false },
        validationProfiles: {
          test: nodeCommand(
            'const fs = require("fs"); const c = fs.readFileSync("src/index.ts", "utf8"); process.exit(c.includes("hola") ? 0 : 1);',
          ),
        },
      }),
    ]);
    harness = await createHarness({ pinProtocol: TARGET_PROTOCOL_REVISION, workspaceConfigPath: configPath });

    const read = await callToolJson(harness.client, 'file.read', { workspaceId, path: 'src/index.ts' });
    await callToolJson(harness.client, 'file.write_guarded', {
      workspaceId,
      path: 'src/index.ts',
      expectedSha256: read.parsed['sha256'],
      content: 'export const sinLaPalabraClave = true;\n',
    });

    const test = await callToolJson(harness.client, 'validation.run', { workspaceId, profile: 'test' });

    expect(test.isError).toBe(false); // la tool no falla...
    expect(test.parsed['exitCode']).toBe(1); // ...el comando sí.
  });
});
