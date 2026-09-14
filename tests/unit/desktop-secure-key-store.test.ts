import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearEncryptedKey,
  loadEncryptedKey,
  migrateLegacyEncryptedKey,
  publicStoredTunnelKeyState,
  saveAndVerifyEncryptedKey,
  saveEncryptedKey,
  type SecureKeyStoreDeps,
} from '@localbridge/desktop-core';

let keyPath: string;

/**
 * Doble determinista: no es cifrado real (eso lo prueba `safeStorage` de
 * Electron, no esta suite), pero al menos no deja la cadena original intacta
 * en el buffer — suficiente para probar que el módulo persiste lo que
 * `encrypt()` devuelve, no el texto plano que recibió.
 */
function fakeDeps(available = true): SecureKeyStoreDeps {
  return {
    encrypt: (plainText) => Buffer.from(Buffer.from(plainText, 'utf8').toString('base64'), 'utf8'),
    decrypt: (encrypted) => Buffer.from(encrypted.toString('utf8'), 'base64').toString('utf8'),
    isAvailable: () => available,
  };
}

beforeEach(() => {
  keyPath = path.join(os.tmpdir(), `localbridge-desktop-key-test-${randomUUID()}`, 'tunnel-key.enc');
});

describe('saveEncryptedKey / loadEncryptedKey', () => {
  it('una clave guardada se puede recuperar tal cual', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-super-secreta' });
  });

  it('el fichero en disco nunca contiene la clave en texto plano', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    const raw = await readFile(keyPath, 'utf8');
    expect(raw).not.toContain('sk-super-secreta');
  });

  it('sin fichero, devuelve un estado ausente en vez de lanzar', async () => {
    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'absent' });
  });

  it('si el cifrado no está disponible al guardar, lanza en vez de escribir en claro', async () => {
    await expect(saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps(false))).rejects.toThrow();
    await expect(readFile(keyPath)).rejects.toThrow();
  });

  it('si el cifrado no está disponible al leer, devuelve un estado explícito', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    expect(await loadEncryptedKey(keyPath, fakeDeps(false))).toEqual({ status: 'encryption-unavailable' });
  });

  it('un fichero corrupto o cifrado con otra clave del SO degrada a ilegible, no lanza', async () => {
    const deps: SecureKeyStoreDeps = {
      ...fakeDeps(),
      decrypt: () => {
        throw new Error('no se pudo descifrar');
      },
    };
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    expect(await loadEncryptedKey(keyPath, deps)).toEqual({ status: 'unreadable' });
  });

  it('distingue un error de E/S de la ausencia del fichero sin filtrar la excepción', async () => {
    await mkdir(keyPath, { recursive: true });

    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'io-error', code: 'KEY_STORE_READ_FAILED' });
  });

  it('proyecta solo estado y nunca devuelve la clave al renderer', async () => {
    const state = publicStoredTunnelKeyState({ status: 'available', value: 'sk-super-secreta' });

    expect(state).toEqual({ status: 'available' });
    expect(JSON.stringify(state)).not.toContain('sk-super-secreta');
  });

  it('la escritura es atómica: no deja temporales huérfanos', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.dirname(keyPath));
    expect(entries.some((name) => /\.tmp-/.test(name))).toBe(false);
  });

  it('sustituye y verifica una credencial válida', async () => {
    await saveEncryptedKey(keyPath, 'sk-anterior', fakeDeps());

    await expect(saveAndVerifyEncryptedKey(keyPath, 'sk-nueva', fakeDeps())).resolves.toBe(true);
    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-nueva' });
  });

  it('restaura el blob anterior cuando la verificación de la candidata falla', async () => {
    await saveEncryptedKey(keyPath, 'sk-anterior', fakeDeps());
    const deps: SecureKeyStoreDeps = { ...fakeDeps(), decrypt: () => 'sk-distinta' };

    await expect(saveAndVerifyEncryptedKey(keyPath, 'sk-nueva', deps)).resolves.toBe(false);
    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-anterior' });
  });

  it('vuelve a ausencia si una credencial nueva no puede verificarse', async () => {
    const deps: SecureKeyStoreDeps = { ...fakeDeps(), decrypt: () => 'sk-distinta' };

    await expect(saveAndVerifyEncryptedKey(keyPath, 'sk-nueva', deps)).resolves.toBe(false);
    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'absent' });
  });
});

describe('clearEncryptedKey', () => {
  it('borra una clave guardada', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    await clearEncryptedKey(keyPath);

    expect(await loadEncryptedKey(keyPath, fakeDeps())).toEqual({ status: 'absent' });
  });

  it('borrar cuando no existe no lanza', async () => {
    await expect(clearEncryptedKey(keyPath)).resolves.not.toThrow();
  });
});

describe('migrateLegacyEncryptedKey', () => {
  const profileId = 'profile_work0000';

  function paths() {
    const root = path.join(os.tmpdir(), `localbridge-key-migration-${randomUUID()}`);
    return {
      legacyPath: path.join(root, 'tunnel-key.enc'),
      targetPath: path.join(root, 'tunnel-keys', `${profileId}.enc`),
    };
  }

  it('migra una sola vez una clave histórica de propietario inequívoco', async () => {
    const candidate = paths();
    await saveEncryptedKey(candidate.legacyPath, 'sk-historica', fakeDeps());

    await expect(migrateLegacyEncryptedKey({ profileIds: [profileId], activeProfileId: profileId, ...candidate }, fakeDeps()))
      .resolves.toEqual({ status: 'migrated' });
    expect(await loadEncryptedKey(candidate.targetPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-historica' });
    expect(await loadEncryptedKey(candidate.legacyPath, fakeDeps())).toEqual({ status: 'absent' });
    await expect(migrateLegacyEncryptedKey({ profileIds: [profileId], activeProfileId: profileId, ...candidate }, fakeDeps()))
      .resolves.toEqual({ status: 'not-needed' });
  });

  it('nunca sobrescribe un destino existente', async () => {
    const candidate = paths();
    await saveEncryptedKey(candidate.legacyPath, 'sk-historica', fakeDeps());
    await saveEncryptedKey(candidate.targetPath, 'sk-destino', fakeDeps());

    await expect(migrateLegacyEncryptedKey({ profileIds: [profileId], activeProfileId: profileId, ...candidate }, fakeDeps()))
      .resolves.toEqual({ status: 'not-needed' });
    expect(await loadEncryptedKey(candidate.targetPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-destino' });
    expect(await loadEncryptedKey(candidate.legacyPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-historica' });
  });

  it('no adivina el propietario cuando existen varios perfiles', async () => {
    const candidate = paths();
    await saveEncryptedKey(candidate.legacyPath, 'sk-historica', fakeDeps());

    await expect(migrateLegacyEncryptedKey({
      profileIds: ['profile_default0', profileId],
      activeProfileId: profileId,
      ...candidate,
    }, fakeDeps())).resolves.toEqual({ status: 'ambiguous' });
    expect(await loadEncryptedKey(candidate.targetPath, fakeDeps())).toEqual({ status: 'absent' });
  });

  it('conserva el origen cuando DPAPI no está disponible', async () => {
    const candidate = paths();
    await saveEncryptedKey(candidate.legacyPath, 'sk-historica', fakeDeps());

    await expect(migrateLegacyEncryptedKey({ profileIds: [profileId], activeProfileId: profileId, ...candidate }, fakeDeps(false)))
      .resolves.toEqual({ status: 'encryption-unavailable' });
    expect(await readFile(candidate.legacyPath)).toBeDefined();
  });

  it('conserva el origen y elimina el destino si la verificación posterior falla', async () => {
    const candidate = paths();
    await saveEncryptedKey(candidate.legacyPath, 'sk-historica', fakeDeps());
    let decryptions = 0;
    const deps: SecureKeyStoreDeps = {
      ...fakeDeps(),
      decrypt: (encrypted) => {
        decryptions += 1;
        if (decryptions === 2) return 'sk-distinta';
        return Buffer.from(encrypted.toString('utf8'), 'base64').toString('utf8');
      },
    };

    await expect(migrateLegacyEncryptedKey({ profileIds: [profileId], activeProfileId: profileId, ...candidate }, deps))
      .resolves.toEqual({ status: 'failed', code: 'KEY_MIGRATION_FAILED' });
    expect(await loadEncryptedKey(candidate.targetPath, fakeDeps())).toEqual({ status: 'absent' });
    expect(await loadEncryptedKey(candidate.legacyPath, fakeDeps())).toEqual({ status: 'available', value: 'sk-historica' });
  });

  it('trata un origen inválido como ilegible y no lo publica', async () => {
    const candidate = paths();
    await mkdir(path.dirname(candidate.legacyPath), { recursive: true });
    await writeFile(candidate.legacyPath, Buffer.from(Buffer.from('   ', 'utf8').toString('base64'), 'utf8'));

    await expect(migrateLegacyEncryptedKey({ profileIds: [profileId], activeProfileId: profileId, ...candidate }, fakeDeps()))
      .resolves.toEqual({ status: 'source-unreadable' });
    expect(await loadEncryptedKey(candidate.targetPath, fakeDeps())).toEqual({ status: 'absent' });
  });
});
