import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, isLocalBridgeError } from '@localbridge/shared';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';

import { buildWorkspace, writeRegistryFile } from '../helpers/fixtures.js';

const logger = createLogger({ level: 'error' });

function tempConfigPath(): string {
  return path.join(os.tmpdir(), `localbridge-perm-test-${randomUUID()}`, 'workspaces.json');
}

let configPath: string;

afterEach(() => {
  configPath = '';
});

describe('requireAuthorizedWorkspace — deny-by-default (ADR-0004)', () => {
  it('[SEC-005] workspaceId inexistente -> WORKSPACE_NOT_FOUND', async () => {
    configPath = tempConfigPath();
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_real', rootPath: 'C:\\anything' })]);

    await expect(requireAuthorizedWorkspace(configPath, logger, 'ws_inventado', 'read')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it('workspace deshabilitado -> WORKSPACE_DISABLED, incluso con el permiso concedido', async () => {
    configPath = tempConfigPath();
    await writeRegistryFile(configPath, [
      buildWorkspace({ id: 'ws_off', rootPath: 'C:\\anything', enabled: false, permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: false } }),
    ]);

    await expect(requireAuthorizedWorkspace(configPath, logger, 'ws_off', 'read')).rejects.toMatchObject({
      code: 'WORKSPACE_DISABLED',
    });
  });

  it('capacidad no concedida -> CAPABILITY_DISABLED', async () => {
    configPath = tempConfigPath();
    await writeRegistryFile(configPath, [
      buildWorkspace({ id: 'ws_readonly', rootPath: 'C:\\anything', permissions: { read: false, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false } }),
    ]);

    await expect(requireAuthorizedWorkspace(configPath, logger, 'ws_readonly', 'read')).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
  });

  it('capacidad concedida y workspace habilitado -> devuelve el workspace', async () => {
    configPath = tempConfigPath();
    await writeRegistryFile(configPath, [buildWorkspace({ id: 'ws_ok', rootPath: 'C:\\anything' })]);

    const workspace = await requireAuthorizedWorkspace(configPath, logger, 'ws_ok', 'read');
    expect(workspace.id).toBe('ws_ok');
  });

  it('un permiso no implica otro: write=true no concede overwrite', async () => {
    configPath = tempConfigPath();
    await writeRegistryFile(configPath, [
      buildWorkspace({
        id: 'ws_write_only',
        rootPath: 'C:\\anything',
        permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      }),
    ]);

    await expect(requireAuthorizedWorkspace(configPath, logger, 'ws_write_only', 'overwrite')).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
    const workspace = await requireAuthorizedWorkspace(configPath, logger, 'ws_write_only', 'write');
    expect(workspace.id).toBe('ws_write_only');
  });

  it('los errores son instancias reconocibles de LocalBridgeError', async () => {
    configPath = tempConfigPath();
    await writeRegistryFile(configPath, []);

    try {
      await requireAuthorizedWorkspace(configPath, logger, 'ws_ninguno', 'read');
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
    }
  });
});

describe('[SEC-025] cambio de permisos en runtime', () => {
  it('deshabilitar el workspace surte efecto en la siguiente llamada, sin reiniciar', async () => {
    configPath = tempConfigPath();
    const workspace = buildWorkspace({ id: 'ws_toggle', rootPath: 'C:\\anything' });
    await writeRegistryFile(configPath, [workspace]);

    // Primera llamada: habilitado, pasa.
    await expect(requireAuthorizedWorkspace(configPath, logger, 'ws_toggle', 'read')).resolves.toBeDefined();

    // Se deshabilita reescribiendo el fichero — sin caché, sin reinicio.
    await writeRegistryFile(configPath, [{ ...workspace, enabled: false }]);

    await expect(requireAuthorizedWorkspace(configPath, logger, 'ws_toggle', 'read')).rejects.toMatchObject({
      code: 'WORKSPACE_DISABLED',
    });
  });
});
