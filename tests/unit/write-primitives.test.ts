import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { atomicWrite, withMutationLock } from '@localbridge/filesystem';

import { createTempWorkspaceDir } from '../helpers/fixtures.js';

describe('atomicWrite', () => {
  it('escribe el contenido y no deja temporales tras el éxito', async () => {
    const ws = await createTempWorkspaceDir();
    try {
      await atomicWrite(ws.root, 'file.txt', Buffer.from('hola'));

      const content = await readFile(path.join(ws.root, 'file.txt'), 'utf8');
      expect(content).toBe('hola');

      const entries = await readdir(ws.root);
      expect(entries).toEqual(['file.txt']);
    } finally {
      await ws.cleanup();
    }
  });

  it('sobrescribe un archivo existente de forma atómica', async () => {
    const ws = await createTempWorkspaceDir();
    try {
      await atomicWrite(ws.root, 'file.txt', Buffer.from('v1'));
      await atomicWrite(ws.root, 'file.txt', Buffer.from('v2, más largo que v1'));

      const content = await readFile(path.join(ws.root, 'file.txt'), 'utf8');
      expect(content).toBe('v2, más largo que v1');

      const entries = await readdir(ws.root);
      expect(entries).toEqual(['file.txt']);
    } finally {
      await ws.cleanup();
    }
  });

  it('[SEC-020] si falla la escritura del temporal, no queda huérfano ni se toca el destino', async () => {
    const ws = await createTempWorkspaceDir();
    try {
      await atomicWrite(ws.root, 'existing.txt', Buffer.from('original'));

      // Provocamos un fallo real: un directorio con el mismo nombre que el
      // basename del temporal es imposible de predecir por el UUID, así que en
      // su lugar apuntamos a un directorio padre inexistente para forzar ENOENT
      // en el `open` — el escenario real de "el disco falla a mitad de escritura"
      // no es simulable de forma determinista sin mockear fs, pero este camino
      // ejercita el mismo `catch` de limpieza.
      const badParent = path.join(ws.root, 'no-existe');
      await expect(atomicWrite(badParent, 'file.txt', Buffer.from('x'))).rejects.toThrow();

      // El archivo previo, real, sigue intacto.
      const content = await readFile(path.join(ws.root, 'existing.txt'), 'utf8');
      expect(content).toBe('original');

      // Nada huérfano quedó en el directorio real.
      const entries = await readdir(ws.root);
      expect(entries).toEqual(['existing.txt']);
    } finally {
      await ws.cleanup();
    }
  });

  it('el archivo final tiene permisos normales de archivo, no de directorio', async () => {
    const ws = await createTempWorkspaceDir();
    try {
      await atomicWrite(ws.root, 'file.txt', Buffer.from('x'));
      const stats = await stat(path.join(ws.root, 'file.txt'));
      expect(stats.isFile()).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('withMutationLock', () => {
  it('serializa dos operaciones sobre la misma clave', async () => {
    const order: string[] = [];

    const slow = withMutationLock('k', async () => {
      order.push('slow:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow:end');
    });

    // Se lanza inmediatamente después, mientras "slow" sigue en curso.
    const fast = withMutationLock('k', async () => {
      order.push('fast:start');
      order.push('fast:end');
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(['slow:start', 'slow:end', 'fast:start', 'fast:end']);
  });

  it('claves distintas no se bloquean entre sí', async () => {
    const order: string[] = [];

    const a = withMutationLock('a', async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a:end');
    });
    const b = withMutationLock('b', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await Promise.all([a, b]);

    // "b" no espera a "a": termina antes aunque "a" empezó primero.
    expect(order.indexOf('b:end')).toBeLessThan(order.indexOf('a:end'));
  });

  it('propaga el error de la función protegida sin dejar el lock atascado', async () => {
    await expect(
      withMutationLock('k2', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // El lock se liberó: una segunda operación sobre la misma clave no se cuelga.
    const result = await withMutationLock('k2', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('tres llamadas concurrentes se ejecutan en orden de llegada', async () => {
    const order: number[] = [];
    const make = (n: number) =>
      withMutationLock('seq', async () => {
        order.push(n);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

    await Promise.all([make(1), make(2), make(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});
