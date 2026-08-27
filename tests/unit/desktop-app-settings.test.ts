import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DESKTOP_SETTINGS, defaultTunnelKeyPath, readDesktopSettings, writeDesktopSettings } from '@localbridge/desktop-core';
import type { DesktopSettings } from '@localbridge/desktop-core';

let settingsPath: string;

beforeEach(() => {
  settingsPath = path.join(os.tmpdir(), `localbridge-desktop-settings-test-${randomUUID()}`, 'desktop-settings.json');
});

describe('readDesktopSettings', () => {
  it('un fichero ausente devuelve los valores por defecto', async () => {
    expect(await readDesktopSettings(settingsPath)).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it('un fichero roto degrada a los valores por defecto en vez de lanzar', async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, 'no es json', 'utf8');

    await expect(readDesktopSettings(settingsPath)).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it('rellena con valores por defecto los campos que falten', async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ tunnelProfile: 'otro-perfil' }), 'utf8');

    const settings = await readDesktopSettings(settingsPath);
    expect(settings.tunnelProfile).toBe('otro-perfil');
    expect(settings.tunnelBinaryPath).toBe(DEFAULT_DESKTOP_SETTINGS.tunnelBinaryPath);
  });

  it('migra el tunnel ID histórico al perfil Personal', async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    await writeFile(settingsPath, JSON.stringify({ tunnelId }), 'utf8');

    const settings = await readDesktopSettings(settingsPath);

    expect(settings.connectionProfiles).toEqual([{ id: 'profile_default0', name: 'Personal', tunnelId }]);
    expect(settings.activeConnectionProfileId).toBe('profile_default0');
  });

  it('aísla las claves nuevas sin mover la clave histórica', () => {
    expect(defaultTunnelKeyPath('profile_default0')).toMatch(/tunnel-key\.enc$/);
    expect(defaultTunnelKeyPath('profile_work0000')).toMatch(/tunnel-keys[\\/]profile_work0000\.enc$/);
  });
});

describe('writeDesktopSettings / readDesktopSettings', () => {
  it('un valor escrito se puede releer tal cual', async () => {
    const settings = {
      onboardingStep: 2,
      onboardingCompleted: false,
      minimizeToTray: true,
      gitApprovalMode: 'host' as const,
      activeConnectionProfileId: 'profile_default0',
      connectionProfiles: [{ id: 'profile_default0', name: 'Personal', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' }],
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      tunnelBinaryPath: 'C:\\tunnel-client.exe',
      tunnelProfile: 'local-stdio',
      tunnelProfileDir: 'C:\\Users\\example-user\\.config\\tunnel-client',
      serverCwd: 'D:\\Proyectos\\MCP',
    };

    await writeDesktopSettings(settingsPath, settings);

    expect(await readDesktopSettings(settingsPath)).toEqual(settings);
  });

  it('migra instalaciones anteriores al modo MRTR estricto', async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ minimizeToTray: false }), 'utf8');

    expect((await readDesktopSettings(settingsPath)).gitApprovalMode).toBe('mrtr');
  });

  it('rechaza una configuración IPC con tipos o campos inesperados', async () => {
    const invalid = {
      ...DEFAULT_DESKTOP_SETTINGS,
      tunnelProfile: '',
      unexpected: 'no permitido',
    } as unknown as DesktopSettings;

    await expect(writeDesktopSettings(settingsPath, invalid)).rejects.toThrow();
  });

  it('rechaza rutas relativas y nombres de perfil que parezcan argumentos', async () => {
    await expect(
      writeDesktopSettings(settingsPath, {
        ...DEFAULT_DESKTOP_SETTINGS,
        tunnelBinaryPath: 'tunnel-client.exe',
      }),
    ).rejects.toThrow();

    await expect(
      writeDesktopSettings(settingsPath, {
        ...DEFAULT_DESKTOP_SETTINGS,
        tunnelProfile: '--help',
      }),
    ).rejects.toThrow();
  });
});
