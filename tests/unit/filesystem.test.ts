import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkspaceBinaryFile,
  createWorkspaceBinaryFileFromChunks,
  getFileMetadata,
  readWorkspaceFile,
  buildWorkspaceTree,
  searchWorkspace,
} from '@localbridge/filesystem';
import { isLocalBridgeError } from '@localbridge/shared';

import { buildWorkspace, createTempWorkspaceDir, populateSampleProject, type TempWorkspace } from '../helpers/fixtures.js';

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
  await populateSampleProject(workspace.root);
});

afterEach(async () => {
  await workspace.cleanup();
});

describe('createWorkspaceBinaryFile — autoridad de cuota binaria', () => {
  it('mantiene maxFileBytes por defecto y acepta una cuota web local acotada', async () => {
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 16, maxTreeEntries: 300, maxTreeDepth: 3 },
    });
    const bytes = Buffer.alloc(32, 0x61);

    await expect(createWorkspaceBinaryFile(ws, 'downloads/default.bin', bytes))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(createWorkspaceBinaryFile(ws, 'downloads/web.bin', bytes, { maximumBytes: 64 }))
      .resolves.toMatchObject({ path: 'downloads/web.bin', size: 32, created: true });
  });

  it('rechaza límites internos por encima de 1 GiB o reservas inválidas', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(createWorkspaceBinaryFile(ws, 'downloads/ceiling.bin', Buffer.from('x'), {
      maximumBytes: 1024 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createWorkspaceBinaryFile(ws, 'downloads/reserve.bin', Buffer.from('x'), {
      reserveFreeBytes: -1,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('publica un flujo por staging y elimina parciales si el productor falla', async () => {
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 4, maxTreeEntries: 300, maxTreeDepth: 3 },
    });
    const saved = await createWorkspaceBinaryFileFromChunks(ws, 'downloads/stream.bin', async (writer) => {
      await writer.write(Buffer.from('stream-'));
      await writer.write(Buffer.from('content'));
      expect(writer.size).toBe(14);
    }, { maximumBytes: 32 });
    expect(saved).toMatchObject({ path: 'downloads/stream.bin', size: 14, created: true });
    expect(await readFile(path.join(workspace.root, 'downloads', 'stream.bin'), 'utf8')).toBe('stream-content');

    await expect(createWorkspaceBinaryFileFromChunks(ws, 'downloads/fail.bin', async (writer) => {
      await writer.write(Buffer.from('partial'));
      throw new Error('validation failed');
    }, { maximumBytes: 32 })).rejects.toThrow('validation failed');
    expect((await readdir(path.join(workspace.root, 'downloads'))).some((name) => name.includes('fail.bin'))).toBe(false);
  });

  it('escribe un stream sintético grande reutilizando chunks acotados', async () => {
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    const chunkCount = 512;
    const expected = createHash('sha256');
    for (let index = 0; index < chunkCount; index += 1) expected.update(chunk);

    const saved = await createWorkspaceBinaryFileFromChunks(ws, 'downloads/large-stream.bin', async (writer) => {
      for (let index = 0; index < chunkCount; index += 1) await writer.write(chunk);
    }, { maximumBytes: 64 * 1024 * 1024 });

    expect(saved).toMatchObject({
      size: chunk.byteLength * chunkCount,
      sha256: expected.digest('hex'),
      created: true,
    });
    expect((await getFileMetadata(ws, 'downloads/large-stream.bin')).size).toBe(chunk.byteLength * chunkCount);
  });

  it('acepta en streaming una política local superior a 1 GiB sin materializar ese tamaño', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(createWorkspaceBinaryFileFromChunks(ws, 'downloads/custom-limit.bin', async (writer) => {
      await writer.write(Buffer.from('bounded'));
    }, { maximumBytes: 2 * 1024 * 1024 * 1024 }))
      .resolves.toMatchObject({ path: 'downloads/custom-limit.bin', size: 7, created: true });
  });

  it('revalida autoridad durante un stream largo y elimina el staging al revocarse', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    let authorized = true;
    let protectedEffects = 0;
    const operation = createWorkspaceBinaryFileFromChunks(ws, 'downloads/revoked.bin', async (writer) => {
      await writer.write(Buffer.from('first'));
      authorized = false;
      await writer.write(Buffer.from('second'));
    }, {
      adaptive: true,
      checkAuthority: async () => {
        if (!authorized) throw Object.assign(new Error('revoked'), { code: 'CAPABILITY_DISABLED' });
      },
      withAuthorizedEffect: async (effect) => {
        protectedEffects += 1;
        return effect();
      },
    });

    await expect(operation).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    expect(protectedEffects).toBe(1);
    expect((await readdir(path.join(workspace.root, 'downloads'))).some((name) => name.includes('revoked.bin'))).toBe(false);
  });
});

describe('readWorkspaceFile — file.read', () => {
  it('lee el contenido y calcula el sha256 del archivo completo', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await readWorkspaceFile(ws, 'src/index.ts', undefined);

    const expectedHash = createHash('sha256').update('export const hello = "world";\n').digest('hex');
    expect(result.content).toBe('export const hello = "world";\n');
    expect(result.sha256).toBe(expectedHash);
    expect(result.truncated).toBe(false);
  });

  it('trunca el contenido devuelto por maxBytes pero el hash sigue siendo del archivo completo', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const full = await readWorkspaceFile(ws, 'src/index.ts', undefined);
    const partial = await readWorkspaceFile(ws, 'src/index.ts', 5);

    expect(partial.content).toBe('expor');
    expect(partial.truncated).toBe(true);
    expect(partial.sha256).toBe(full.sha256);
  });

  it('lee un rango de líneas acotado sin cambiar el hash del archivo completo', async () => {
    await writeFile(path.join(workspace.root, 'src', 'ranged.ts'), 'uno\ndos\ntres\ncuatro\n');
    const ws = buildWorkspace({ rootPath: workspace.root });
    const full = await readWorkspaceFile(ws, 'src/ranged.ts', undefined);
    const ranged = await readWorkspaceFile(ws, 'src/ranged.ts', undefined, { startLine: 2, endLine: 3 });

    expect(ranged.content).toBe('dos\ntres\n');
    expect(ranged.sha256).toBe(full.sha256);
    expect(ranged.size).toBe(full.size);
    expect(ranged.truncated).toBe(false);
    expect(ranged.lineRange).toEqual({
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
  });

  it('rechaza rangos que empiezan después del final del archivo', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(readWorkspaceFile(ws, 'src/index.ts', undefined, { startLine: 99 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('[SEC-011] un archivo mayor que el límite del workspace se rechaza sin leerlo', async () => {
    await writeFile(path.join(workspace.root, 'big.bin'), Buffer.alloc(2048, 'x'));
    const ws = buildWorkspace({ rootPath: workspace.root, limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 } });

    try {
      await readWorkspaceFile(ws, 'big.bin', undefined);
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('FILE_TOO_LARGE');
    }
  });

  it('archivo inexistente -> FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(readWorkspaceFile(ws, 'no-existe.ts', undefined)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('un directorio -> NOT_A_FILE', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(readWorkspaceFile(ws, 'src', undefined)).rejects.toMatchObject({ code: 'NOT_A_FILE' });
  });

  it('[SEC-010] un archivo denegado -> PATH_DENIED, nunca se lee', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(readWorkspaceFile(ws, '.env', undefined)).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });
});

describe('getFileMetadata — file.metadata', () => {
  it('archivo existente: type=file, tamaño y hash coinciden con file.read', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const meta = await getFileMetadata(ws, 'src/index.ts');
    const read = await readWorkspaceFile(ws, 'src/index.ts', undefined);

    expect(meta.exists).toBe(true);
    expect(meta.type).toBe('file');
    expect(meta.sha256).toBe(read.sha256);
    expect(meta.size).toBe(read.size);
  });

  it('hashea por streaming un asset administrado mayor que la cuota de texto', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    await writeFile(path.join(workspace.root, 'large-asset.bin'), bytes);
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });

    const meta = await getFileMetadata(ws, 'large-asset.bin');

    expect(meta).toMatchObject({
      exists: true,
      type: 'file',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('archivo inexistente: exists=false, sin lanzar', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const meta = await getFileMetadata(ws, 'no-existe.ts');
    expect(meta).toEqual({ path: 'no-existe.ts', exists: false });
  });

  it('un directorio: exists=true, type=dir, sin size ni hash', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const meta = await getFileMetadata(ws, 'src');
    expect(meta.exists).toBe(true);
    expect(meta.type).toBe('dir');
    expect(meta.size).toBeUndefined();
    expect(meta.sha256).toBeUndefined();
  });

  it('una ruta denegada -> PATH_DENIED aunque exista', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(getFileMetadata(ws, 'id_rsa')).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });
});

describe('buildWorkspaceTree — workspace.tree', () => {
  it('lista entradas de primer nivel con maxDepth=1', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await buildWorkspaceTree(ws, '.', 1, 300);

    const names = result.entries.map((entry) => entry.path).toSorted();
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    expect(result.entries.find((entry) => entry.path === 'src')?.type).toBe('dir');
  });

  it('desciende hasta maxDepth niveles', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await buildWorkspaceTree(ws, '.', 3, 300);

    expect(result.entries.map((entry) => entry.path)).toContain('src/lib/util.ts');
  });

  it('[SEC-012] node_modules y .git/objects se excluyen y no se listan', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await buildWorkspaceTree(ws, '.', 3, 300);

    expect(result.entries.some((entry) => entry.path.startsWith('node_modules'))).toBe(false);
    expect(result.entries.some((entry) => entry.path.startsWith('.git/objects'))).toBe(false);
    expect(result.excluded).toContain('node_modules');
    expect(result.excluded).toContain('objects');
  });

  it('[SEC-010] los archivos denegados no aparecen en el árbol', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await buildWorkspaceTree(ws, '.', 1, 300);

    expect(result.entries.some((entry) => entry.path === '.env')).toBe(false);
    expect(result.entries.some((entry) => entry.path === 'id_rsa')).toBe(false);
  });

  it('[SEC-012] maxEntries acota el resultado y marca truncated', async () => {
    await mkdir(path.join(workspace.root, 'many'), { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      await writeFile(path.join(workspace.root, 'many', `f${i}.txt`), 'x');
    }
    const ws = buildWorkspace({ rootPath: workspace.root, limits: { maxFileBytes: 1_048_576, maxTreeEntries: 5, maxTreeDepth: 3 } });

    const result = await buildWorkspaceTree(ws, 'many', 1, undefined);
    expect(result.entries.length).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it('apuntar el árbol a un archivo devuelve entradas vacías, no un error', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await buildWorkspaceTree(ws, 'README.md', 1, 300);
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('directorio inexistente -> FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(buildWorkspaceTree(ws, 'no-existe', 1, 300)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('el orden de las entradas es determinista', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const first = await buildWorkspaceTree(ws, '.', 1, 300);
    const second = await buildWorkspaceTree(ws, '.', 1, 300);
    expect(first.entries.map((entry) => entry.path)).toEqual(second.entries.map((entry) => entry.path));
  });
});

describe('searchWorkspace — workspace.search', () => {
  it('encuentra una coincidencia literal con su línea y ruta correctas', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'export const hello', false, undefined);

    expect(result.matches).toContainEqual({ path: 'src/index.ts', line: 1, text: 'export const hello = "world";' });
  });

  it('es literal, no regex: un patrón con metacaracteres no coincide con nada especial', async () => {
    await writeFile(path.join(workspace.root, 'literal.txt'), 'precio: 10.99 (a.b)\n');
    const ws = buildWorkspace({ rootPath: workspace.root });

    // Si esto se tratara como regex, "a.b" también matchearía "axb" — no debe.
    await writeFile(path.join(workspace.root, 'no-deberia.txt'), 'axb\n');
    const result = await searchWorkspace(ws, '.', 'a.b', false, undefined);

    expect(result.matches.map((m) => m.path)).toContain('literal.txt');
    expect(result.matches.map((m) => m.path)).not.toContain('no-deberia.txt');
  });

  it('caseSensitive=false (por defecto) ignora mayúsculas/minúsculas', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'EXPORT CONST HELLO', false, undefined);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('caseSensitive=true respeta mayúsculas/minúsculas', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'EXPORT CONST HELLO', true, undefined);
    expect(result.matches).toEqual([]);
  });

  it('[SEC-012] node_modules y .git/objects no se buscan', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'module.exports', false, undefined);
    expect(result.matches).toEqual([]);
  });

  it('[SEC-010] un archivo denegado (.env) nunca se busca ni aparece en resultados', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'SECRET', false, undefined);
    expect(result.matches).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0); // otros archivos sí se escanearon
  });

  it('un archivo binario (con byte NUL) se salta, no se busca en su contenido', async () => {
    await writeFile(path.join(workspace.root, 'datos.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x61, 0x62, 0x63]));
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'abc', false, undefined);
    expect(result.matches.some((m) => m.path === 'datos.bin')).toBe(false);
  });

  it('[SEC-011] un archivo mayor que el límite del workspace se salta sin leerlo', async () => {
    await writeFile(path.join(workspace.root, 'grande.txt'), `${'x'.repeat(2000)}\naguja\n`);
    const ws = buildWorkspace({ rootPath: workspace.root, limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 } });

    const result = await searchWorkspace(ws, '.', 'aguja', false, undefined);
    expect(result.matches.some((m) => m.path === 'grande.txt')).toBe(false);
  });

  it('en adaptive busca por streaming por encima de maxFileBytes y entre chunks', async () => {
    const prefix = 'x'.repeat(1024 * 1024 - 3);
    await writeFile(path.join(workspace.root, 'grande-adaptive.txt'), `${prefix}aguja-cruzada\nsegunda\n`);
    const base = buildWorkspace({ rootPath: workspace.root });
    const ws = buildWorkspace({
      rootPath: workspace.root,
      limits: {
        ...base.limits,
        maxFileBytes: 1024,
        largeArtifacts: { mode: 'adaptive', reserve: { minimumFreeBytes: 0, minimumFreePercent: 0 }, maxConcurrentJobs: 1 },
      },
    });
    const result = await searchWorkspace(ws, 'grande-adaptive.txt', 'aguja-cruzada', true, undefined);
    expect(result.matches).toEqual([{ path: 'grande-adaptive.txt', line: 1, text: 'x'.repeat(2000) }]);
    expect(result.filesScanned).toBe(1);
  });

  it('busca texto UTF-16 con BOM sin clasificar sus NUL como binario', async () => {
    const body = Buffer.from('primera\r\nAguja UTF16\r\n', 'utf16le');
    await writeFile(path.join(workspace.root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, 'utf16.txt', 'aguja utf16', false, undefined);
    expect(result.matches).toEqual([{ path: 'utf16.txt', line: 2, text: 'Aguja UTF16\r' }]);
  });

  it('maxResults acota el resultado y marca truncated', async () => {
    await mkdir(path.join(workspace.root, 'many'), { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(path.join(workspace.root, 'many', `f${i}.txt`), 'aguja\n');
    }
    const ws = buildWorkspace({ rootPath: workspace.root });

    const result = await searchWorkspace(ws, 'many', 'aguja', false, 5);
    expect(result.matches.length).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it('relativePath puede apuntar a un único archivo, no solo a un directorio', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, 'src/lib/util.ts', 'util', false, undefined);
    expect(result.matches.every((m) => m.path === 'src/lib/util.ts')).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('query vacía -> INVALID_INPUT', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(searchWorkspace(ws, '.', '', false, undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('relativePath inexistente -> FILE_NOT_FOUND', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(searchWorkspace(ws, 'no-existe', 'x', false, undefined)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('sin coincidencias -> matches vacío, no un error', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    const result = await searchWorkspace(ws, '.', 'esta-cadena-no-existe-en-ningun-lado', false, undefined);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('TIMEOUT detiene el recorrido dentro de la propia operación', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root });
    await expect(searchWorkspace(ws, '.', 'hello', false, undefined, { timeoutMs: 0, now: () => 100 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
