import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLocalBridgeError } from '@localbridge/shared';
import { createWorkspaceFile, writeGuardedWorkspaceFile, patchGuardedWorkspaceFile, deleteWorkspaceFile, moveWorkspaceFile } from '@localbridge/filesystem';

import {
  buildWorkspace,
  createTempWorkspaceDir,
  populateSampleProject,
  tryCreateFileSymlink,
  type TempWorkspace,
} from '../helpers/fixtures.js';

let workspace: TempWorkspace;
let outside: TempWorkspace;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  outside = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
});

afterEach(async () => {
  await workspace.cleanup();
  await outside.cleanup();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`esperaba que lanzara ${code}`);
  } catch (error) {
    expect(isLocalBridgeError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
  }
}

describe('createWorkspaceFile — file.create', () => {
  it('crea un archivo nuevo con hash y tamaño correctos', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false } });
    const result = await createWorkspaceFile(ws, 'docs/new.md', 'contenido nuevo');

    expect(result.created).toBe(true);
    expect(result.size).toBe(Buffer.byteLength('contenido nuevo'));
    expect(result.sha256).toBe(createHash('sha256').update('contenido nuevo').digest('hex'));

    const onDisk = await readFile(path.join(workspace.root, 'docs', 'new.md'), 'utf8');
    expect(onDisk).toBe('contenido nuevo');
  });

  it('crea directorios intermedios que no existían', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await createWorkspaceFile(ws, 'a/b/c/deep.md', 'x');

    const onDisk = await readFile(path.join(workspace.root, 'a', 'b', 'c', 'deep.md'), 'utf8');
    expect(onDisk).toBe('x');
  });

  it('[SEC-006/SEC-007 relacionado] no convierte una creación en sobrescritura', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(createWorkspaceFile(ws, 'README.md', 'pisando el original'), 'FILE_ALREADY_EXISTS');

    const onDisk = await readFile(path.join(workspace.root, 'README.md'), 'utf8');
    expect(onDisk).toBe('# sample\n'); // intacto
  });

  it('[SEC-011] contenido mayor que el límite del workspace se rechaza sin escribir nada', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, limits: { maxFileBytes: 10, maxTreeEntries: 300, maxTreeDepth: 3 } });
    await expectCode(createWorkspaceFile(ws, 'big.txt', 'esto es mucho más largo que 10 bytes'), 'FILE_TOO_LARGE');
  });

  it('[SEC-010] una ruta denegada por la denylist se rechaza', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(createWorkspaceFile(ws, '.env', 'SECRET=x'), 'PATH_DENIED');
  });

  it('[SEC-003/004 escritura] un symlink existente en el target -> SYMLINK_ESCAPE, nada se escribe', async () => {
    await writeFile(path.join(outside.root, 'target.txt'), 'externo');
    const attempt = await tryCreateFileSymlink(path.join(outside.root, 'target.txt'), path.join(workspace.root, 'link.md'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados: ${attempt.reason}`);
      return;
    }
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(createWorkspaceFile(ws, 'link.md', 'pwned'), 'SYMLINK_ESCAPE');

    const externalContent = await readFile(path.join(outside.root, 'target.txt'), 'utf8');
    expect(externalContent).toBe('externo'); // el externo no se tocó
  });

  it('un symlink COLGANTE en el target -> SYMLINK_ESCAPE, no se crea nada externamente', async () => {
    const externalTarget = path.join(outside.root, 'creado-por-el-ataque.txt');
    const attempt = await tryCreateFileSymlink(externalTarget, path.join(workspace.root, 'dangling.md'));
    if (!attempt.created) {
      console.warn(`[skip] symlinks no soportados: ${attempt.reason}`);
      return;
    }
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(createWorkspaceFile(ws, 'dangling.md', 'pwned'), 'SYMLINK_ESCAPE');

    // El archivo externo NUNCA debió crearse.
    await expect(readFile(externalTarget, 'utf8')).rejects.toThrow();
  });

  it('dos creaciones concurrentes en un directorio nuevo compartido no chocan entre sí', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const [a, b] = await Promise.all([
      createWorkspaceFile(ws, 'shared-new-dir/a.txt', 'A'),
      createWorkspaceFile(ws, 'shared-new-dir/b.txt', 'B'),
    ]);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(await readFile(path.join(workspace.root, 'shared-new-dir', 'a.txt'), 'utf8')).toBe('A');
    expect(await readFile(path.join(workspace.root, 'shared-new-dir', 'b.txt'), 'utf8')).toBe('B');
  });
});

describe('writeGuardedWorkspaceFile — file.write_guarded', () => {
  it('con el hash correcto, reemplaza el contenido de forma atómica', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false } });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const originalHash = createHash('sha256').update(original).digest('hex');

    const result = await writeGuardedWorkspaceFile(ws, 'src/index.ts', originalHash, 'export const bye = "world";\n');

    expect(result.previousSha256).toBe(originalHash);
    expect(result.sha256).toBe(createHash('sha256').update('export const bye = "world";\n').digest('hex'));

    const onDisk = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(onDisk).toBe('export const bye = "world";\n');
  });

  it('[SEC-008] hash incorrecto -> HASH_MISMATCH, el archivo queda intacto', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');

    await expectCode(
      writeGuardedWorkspaceFile(ws, 'src/index.ts', 'hash-completamente-incorrecto', 'nuevo contenido'),
      'HASH_MISMATCH',
    );

    const onDisk = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(onDisk).toBe(original);
  });

  it('[SEC-009] el archivo cambia entre la lectura del agente y la escritura -> HASH_MISMATCH', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const staleHash = createHash('sha256').update(original).digest('hex');

    // Alguien más (el usuario, en su editor) modifica el archivo por fuera.
    await writeFile(path.join(workspace.root, 'src', 'index.ts'), 'cambiado por fuera\n');

    await expectCode(writeGuardedWorkspaceFile(ws, 'src/index.ts', staleHash, 'el agente pisa esto'), 'HASH_MISMATCH');

    const onDisk = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(onDisk).toBe('cambiado por fuera\n'); // se conserva el cambio externo, no el del agente
  });

  it('archivo inexistente -> FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(writeGuardedWorkspaceFile(ws, 'no-existe.ts', 'x'.repeat(64), 'y'), 'FILE_NOT_FOUND');
  });

  it('un directorio como target -> NOT_A_FILE', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(writeGuardedWorkspaceFile(ws, 'src', 'x'.repeat(64), 'y'), 'NOT_A_FILE');
  });

  it('una ruta denegada -> PATH_DENIED, ni siquiera intenta comparar el hash', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(writeGuardedWorkspaceFile(ws, 'id_rsa', 'cualquier-hash', 'y'), 'PATH_DENIED');
  });

  it('[SEC-020] si algo fallara a mitad de la escritura, el archivo original no queda corrupto', async () => {
    // Ejercita el mismo camino atómico que file.create: no se puede simular un
    // fallo de disco real sin mockear fs, pero la propia atomicWrite ya está
    // cubierta por sus propios tests (write-primitives.test.ts). Aquí
    // verificamos que una escritura exitosa deja el archivo completo, sin
    // fragmentos de la versión anterior mezclados.
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    const longContent = 'x'.repeat(50_000);
    await writeGuardedWorkspaceFile(ws, 'src/index.ts', hash, longContent);

    const onDisk = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(onDisk).toBe(longContent);
    expect(onDisk.length).toBe(50_000);
  });

  it('dos escrituras concurrentes sobre el mismo archivo: solo una gana, la otra ve HASH_MISMATCH', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const originalHash = createHash('sha256').update(original).digest('hex');

    const results = await Promise.allSettled([
      writeGuardedWorkspaceFile(ws, 'src/index.ts', originalHash, 'versión A'),
      writeGuardedWorkspaceFile(ws, 'src/index.ts', originalHash, 'versión B'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // El mutex serializa: la primera en tomar el lock gana con el hash
    // original; la segunda, al recalcular dentro del mutex, ve que el hash ya
    // cambió y falla con HASH_MISMATCH. Nunca las dos ganan.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe('patchGuardedWorkspaceFile — file.patch_guarded', () => {
  it('aplica ediciones ordenadas por contexto sin transmitir el archivo completo', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    const result = await patchGuardedWorkspaceFile(ws, 'src/index.ts', hash, [
      { oldText: 'hello', newText: 'greeting' },
      { oldText: 'world', newText: 'LocalBridge' },
    ]);

    expect(result).toMatchObject({ previousSha256: hash, appliedEdits: 2, replacements: 2 });
    expect(await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8'))
      .toBe('export const greeting = "LocalBridge";\n');
  });

  it('falla sin escribir cuando el contexto es ambiguo', async () => {
    const target = path.join(workspace.root, 'src', 'index.ts');
    await writeFile(target, 'same same\n');
    const original = await readFile(target, 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    await expectCode(
      patchGuardedWorkspaceFile(buildWorkspace({ rootPath: workspace.root }), 'src/index.ts', hash, [
        { oldText: 'same', newText: 'changed' },
      ]),
      'INVALID_INPUT',
    );
    expect(await readFile(target, 'utf8')).toBe(original);
  });

  it('identifica de forma segura el índice de la edición inválida', async () => {
    const target = path.join(workspace.root, 'src', 'index.ts');
    const original = await readFile(target, 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    await expect(patchGuardedWorkspaceFile(buildWorkspace({ rootPath: workspace.root }), 'src/index.ts', hash, [
      { oldText: 'hello', newText: 'greeting' },
      { oldText: 'contexto inexistente', newText: 'x' },
    ])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'patch context occurrence mismatch', editIndex: 1 },
    });
    expect(await readFile(target, 'utf8')).toBe(original);
  });

  it('falla sin escribir cuando el archivo cambió desde la lectura', async () => {
    const target = path.join(workspace.root, 'src', 'index.ts');
    const stale = createHash('sha256').update(await readFile(target)).digest('hex');
    await writeFile(target, 'cambio externo\n');

    await expectCode(
      patchGuardedWorkspaceFile(buildWorkspace({ rootPath: workspace.root }), 'src/index.ts', stale, [
        { oldText: 'hello', newText: 'bye' },
      ]),
      'HASH_MISMATCH',
    );
    expect(await readFile(target, 'utf8')).toBe('cambio externo\n');
  });

  it('rechaza una expansión mayor que maxFileBytes antes de construirla', async () => {
    const target = path.join(workspace.root, 'src', 'index.ts');
    const original = 'a'.repeat(512);
    await writeFile(target, original);
    const hash = createHash('sha256').update(original).digest('hex');
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });

    await expectCode(
      patchGuardedWorkspaceFile(ws, 'src/index.ts', hash, [
        { oldText: 'a', newText: 'x'.repeat(1024), expectedOccurrences: 512 },
      ]),
      'FILE_TOO_LARGE',
    );
    expect(await readFile(target, 'utf8')).toBe(original);
  });

  it('rechaza UTF-8 inválido sin normalizar ni alterar bytes', async () => {
    const target = path.join(workspace.root, 'src', 'index.ts');
    const original = Buffer.from([0x61, 0x80, 0x62]);
    await writeFile(target, original);
    const hash = createHash('sha256').update(original).digest('hex');

    await expectCode(
      patchGuardedWorkspaceFile(buildWorkspace({ rootPath: workspace.root }), 'src/index.ts', hash, [
        { oldText: 'a', newText: 'z' },
      ]),
      'INVALID_INPUT',
    );
    expect(await readFile(target)).toEqual(original);
  });

  it('preserva el BOM UTF-8 situado fuera del contexto editado', async () => {
    const target = path.join(workspace.root, 'src', 'index.ts');
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha beta\n')]);
    await writeFile(target, original);
    const hash = createHash('sha256').update(original).digest('hex');

    await patchGuardedWorkspaceFile(buildWorkspace({ rootPath: workspace.root }), 'src/index.ts', hash, [
      { oldText: 'beta', newText: 'gamma' },
    ]);

    expect(await readFile(target)).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha gamma\n')]),
    );
  });
});

describe('deleteWorkspaceFile — file.delete', () => {
  it('con el hash correcto, borra el archivo', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false } });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    const result = await deleteWorkspaceFile(ws, 'src/index.ts', hash);

    expect(result).toEqual({ path: 'src/index.ts', deleted: true });
    await expect(readFile(path.join(workspace.root, 'src', 'index.ts'))).rejects.toThrow();
  });

  it('borra por hash streaming un asset mayor que la cuota de texto', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x34);
    await writeFile(path.join(workspace.root, 'large-delete.bin'), bytes);
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });
    const hash = createHash('sha256').update(bytes).digest('hex');

    await expect(deleteWorkspaceFile(ws, 'large-delete.bin', hash)).resolves.toEqual({ path: 'large-delete.bin', deleted: true });
    await expect(readFile(path.join(workspace.root, 'large-delete.bin'))).rejects.toThrow();
  });

  it('[SEC-008] hash incorrecto -> HASH_MISMATCH, el archivo no se borra', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });

    await expectCode(deleteWorkspaceFile(ws, 'src/index.ts', 'hash-completamente-incorrecto'.padEnd(64, '0')), 'HASH_MISMATCH');

    const onDisk = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(onDisk).toBe('export const hello = "world";\n');
  });

  it('archivo inexistente -> FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(deleteWorkspaceFile(ws, 'no-existe.ts', 'x'.repeat(64)), 'FILE_NOT_FOUND');
  });

  it('un directorio como target -> NOT_A_FILE, no intenta borrar el árbol', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(deleteWorkspaceFile(ws, 'src', 'x'.repeat(64)), 'NOT_A_FILE');

    const stillThere = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(stillThere).toBe('export const hello = "world";\n');
  });

  it('una ruta denegada -> PATH_DENIED, ni siquiera intenta comparar el hash', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(deleteWorkspaceFile(ws, 'id_rsa', 'cualquier-hash'.padEnd(64, '0')), 'PATH_DENIED');
  });

  it('un symlink en la posición final -> SYMLINK_ESCAPE, nunca se sigue', async () => {
    const target = path.join(outside.root, 'real.txt');
    await writeFile(target, 'contenido real');
    const linkPath = path.join(workspace.root, 'enlace.txt');
    const attempt = await tryCreateFileSymlink(target, linkPath);
    if (!attempt.created) {
      // Entorno sin symlinks (Windows sin modo desarrollador): se salta con aviso, TEST_PLAN.md §9.
      return;
    }

    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(deleteWorkspaceFile(ws, 'enlace.txt', 'x'.repeat(64)), 'SYMLINK_ESCAPE');
    // El archivo real, fuera del workspace, sigue intacto.
    const stillThere = await readFile(target, 'utf8');
    expect(stillThere).toBe('contenido real');
  });

  it('dos borrados concurrentes del mismo archivo: solo uno gana, el otro ve FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    const results = await Promise.allSettled([deleteWorkspaceFile(ws, 'src/index.ts', hash), deleteWorkspaceFile(ws, 'src/index.ts', hash)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe('moveWorkspaceFile — file.move', () => {
  it('con el hash correcto, mueve el archivo y su contenido llega intacto', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false } });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    const result = await moveWorkspaceFile(ws, 'src/index.ts', 'src/renombrado.ts', hash);

    expect(result).toEqual({ sourcePath: 'src/index.ts', destPath: 'src/renombrado.ts', sha256: hash, size: Buffer.byteLength(original) });
    await expect(readFile(path.join(workspace.root, 'src', 'index.ts'))).rejects.toThrow();
    const atDest = await readFile(path.join(workspace.root, 'src', 'renombrado.ts'), 'utf8');
    expect(atDest).toBe(original);
  });

  it('mueve por hash streaming un asset mayor que la cuota de texto', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x78);
    await writeFile(path.join(workspace.root, 'large-source.bin'), bytes);
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });
    const hash = createHash('sha256').update(bytes).digest('hex');

    await expect(moveWorkspaceFile(ws, 'large-source.bin', 'assets/large-destination.bin', hash)).resolves.toMatchObject({
      sourcePath: 'large-source.bin',
      destPath: 'assets/large-destination.bin',
      size: bytes.byteLength,
      sha256: hash,
    });
    expect(await readFile(path.join(workspace.root, 'assets', 'large-destination.bin'))).toEqual(bytes);
  }, 30_000);

  it('crea los directorios intermedios del destino que falten', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, permissions: { read: true, write: false, overwrite: true, gitRead: false, validations: false, gitWrite: false } });
    const original = await readFile(path.join(workspace.root, 'README.md'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    await moveWorkspaceFile(ws, 'README.md', 'docs/nuevo/README.md', hash);

    const atDest = await readFile(path.join(workspace.root, 'docs', 'nuevo', 'README.md'), 'utf8');
    expect(atDest).toBe(original);
  });

  it('[SEC-008] hash incorrecto -> HASH_MISMATCH, nada se mueve', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(moveWorkspaceFile(ws, 'src/index.ts', 'src/otro.ts', 'x'.repeat(64)), 'HASH_MISMATCH');

    const stillAtSource = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(stillAtSource).toBe('export const hello = "world";\n');
  });

  it('destino ya existente -> FILE_ALREADY_EXISTS, nunca lo sobrescribe', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');
    const destOriginal = await readFile(path.join(workspace.root, 'src', 'lib', 'util.ts'), 'utf8');

    await expectCode(moveWorkspaceFile(ws, 'src/index.ts', 'src/lib/util.ts', hash), 'FILE_ALREADY_EXISTS');

    const destStill = await readFile(path.join(workspace.root, 'src', 'lib', 'util.ts'), 'utf8');
    expect(destStill).toBe(destOriginal);
    const sourceStill = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(sourceStill).toBe(original);
  });

  it('origen y destino iguales -> INVALID_INPUT, no interbloquea', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    await expectCode(moveWorkspaceFile(ws, 'src/index.ts', 'src/index.ts', hash), 'INVALID_INPUT');
  });

  it('origen inexistente -> FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(moveWorkspaceFile(ws, 'no-existe.ts', 'destino.ts', 'x'.repeat(64)), 'FILE_NOT_FOUND');
  });

  it('un directorio como origen -> NOT_A_FILE', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(moveWorkspaceFile(ws, 'src', 'destino.ts', 'x'.repeat(64)), 'NOT_A_FILE');
  });

  it('origen denegado -> PATH_DENIED', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expectCode(moveWorkspaceFile(ws, 'id_rsa', 'destino.ts', 'x'.repeat(64)), 'PATH_DENIED');
  });

  it('destino denegado -> PATH_DENIED, el origen no se toca', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const original = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    const hash = createHash('sha256').update(original).digest('hex');

    await expectCode(moveWorkspaceFile(ws, 'src/index.ts', '.env', hash), 'PATH_DENIED');

    const stillAtSource = await readFile(path.join(workspace.root, 'src', 'index.ts'), 'utf8');
    expect(stillAtSource).toBe(original);
  });

  it('dos movimientos concurrentes con origen y destino intercambiados no interbloquean', async () => {
    // A↔B a la vez: si el orden de adquisición de locks no fuera canónico,
    // esto se interbloquearía en vez de resolverse (una gana, la otra falla).
    await writeFile(path.join(workspace.root, 'a.txt'), 'contenido A');
    await writeFile(path.join(workspace.root, 'b.txt'), 'contenido B');
    const hashA = createHash('sha256').update('contenido A').digest('hex');
    const hashB = createHash('sha256').update('contenido B').digest('hex');
    const ws = buildWorkspace({ rootPath: workspace.root });

    // La aserción real es que esta llamada resuelve dentro del timeout del
    // test en absoluto: con un orden de locks no canónico, se quedaría
    // colgada para siempre en vez de resolverse.
    const results = await Promise.allSettled([
      moveWorkspaceFile(ws, 'a.txt', 'b.txt', hashA),
      moveWorkspaceFile(ws, 'b.txt', 'a.txt', hashB),
    ]);

    expect(results).toHaveLength(2);
  });
});
