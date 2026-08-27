import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearEncryptedKey, loadEncryptedKey, saveEncryptedKey, type SecureKeyStoreDeps } from '@localbridge/desktop-core';

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

    expect(await loadEncryptedKey(keyPath, fakeDeps())).toBe('sk-super-secreta');
  });

  it('el fichero en disco nunca contiene la clave en texto plano', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    const raw = await readFile(keyPath, 'utf8');
    expect(raw).not.toContain('sk-super-secreta');
  });

  it('sin fichero, devuelve undefined en vez de lanzar', async () => {
    expect(await loadEncryptedKey(keyPath, fakeDeps())).toBeUndefined();
  });

  it('si el cifrado no está disponible al guardar, lanza en vez de escribir en claro', async () => {
    await expect(saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps(false))).rejects.toThrow();
    await expect(readFile(keyPath)).rejects.toThrow();
  });

  it('si el cifrado no está disponible al leer, devuelve undefined en vez de fallar', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    expect(await loadEncryptedKey(keyPath, fakeDeps(false))).toBeUndefined();
  });

  it('un fichero corrupto o cifrado con otra clave del SO degrada a undefined, no lanza', async () => {
    const deps: SecureKeyStoreDeps = {
      ...fakeDeps(),
      decrypt: () => {
        throw new Error('no se pudo descifrar');
      },
    };
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    expect(await loadEncryptedKey(keyPath, deps)).toBeUndefined();
  });

  it('la escritura es atómica: no deja temporales huérfanos', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.dirname(keyPath));
    expect(entries.some((name) => /\.tmp-/.test(name))).toBe(false);
  });
});

describe('clearEncryptedKey', () => {
  it('borra una clave guardada', async () => {
    await saveEncryptedKey(keyPath, 'sk-super-secreta', fakeDeps());

    await clearEncryptedKey(keyPath);

    expect(await loadEncryptedKey(keyPath, fakeDeps())).toBeUndefined();
  });

  it('borrar cuando no existe no lanza', async () => {
    await expect(clearEncryptedKey(keyPath)).resolves.not.toThrow();
  });
});
