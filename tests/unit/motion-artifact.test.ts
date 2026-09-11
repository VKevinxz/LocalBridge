import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupWorkspaceArtifactStaging, createWorkspaceArtifactDirectory } from '@localbridge/filesystem';

import { buildWorkspace, createTempWorkspaceDir, tryCreateDirJunction, type TempWorkspace } from '../helpers/fixtures.js';

let temporary: TempWorkspace;

beforeEach(async () => {
  temporary = await createTempWorkspaceDir();
});

afterEach(async () => {
  await temporary.cleanup();
});

describe('createWorkspaceArtifactDirectory', () => {
  it('publica todos los archivos juntos y devuelve hashes relativos', async () => {
    const workspace = buildWorkspace({
      rootPath: temporary.root,
      permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 },
    });

    const result = await createWorkspaceArtifactDirectory(workspace, 'research/demo.lbmotion', async (writer) => {
      expect(writer.maxFileBytes).toBe(1024);
      expect(writer.maxTotalBytes).toBe(64 * 1024 * 1024);
      const frame = await writer.write('frames/frame-000.png', Buffer.from('png'));
      const manifest = await writer.write('manifest.json', Buffer.from('{"formatVersion":1}'));
      return { frame, manifest };
    });

    expect(result.path).toBe('research/demo.lbmotion');
    expect(result.created).toBe(true);
    expect(result.fileCount).toBe(2);
    expect(result.totalSize).toBe(22);
    expect(result.value.frame.path).toBe('frames/frame-000.png');
    expect(await readFile(path.join(temporary.root, 'research', 'demo.lbmotion', 'manifest.json'), 'utf8'))
      .toBe('{"formatVersion":1}');
    await expect(stat(path.join(temporary.root, 'research', 'demo.lbmotion', '.localbridge-artifact-staging-v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hace rollback completo si el productor falla', async () => {
    const workspace = buildWorkspace({ rootPath: temporary.root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } });

    await expect(createWorkspaceArtifactDirectory(workspace, 'research/fail.lbmotion', async (writer) => {
      await writer.write('frames/frame-000.png', Buffer.from('partial'));
      throw new Error('capture failed');
    })).rejects.toThrow('capture failed');

    await expect(stat(path.join(temporary.root, 'research', 'fail.lbmotion'))).rejects.toMatchObject({ code: 'ENOENT' });
    const research = await import('node:fs/promises').then(({ readdir }) => readdir(path.join(temporary.root, 'research')));
    expect(research.some((name) => name.includes('.lbtmp-'))).toBe(false);
  });

  it('rechaza reemplazo, traversal, ruta absoluta, duplicados y cuota total', async () => {
    const workspace = buildWorkspace({
      rootPath: temporary.root,
      permissions: { read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false },
      limits: { maxFileBytes: 8, maxTreeEntries: 300, maxTreeDepth: 3 },
    });
    await mkdir(path.join(temporary.root, 'research', 'existing.lbmotion'), { recursive: true });

    await expect(createWorkspaceArtifactDirectory(workspace, 'research/existing.lbmotion', async () => undefined))
      .rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' });
    await expect(createWorkspaceArtifactDirectory(workspace, '../escape.lbmotion', async () => undefined))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(createWorkspaceArtifactDirectory(workspace, path.join(temporary.root, 'absolute.lbmotion'), async () => undefined))
      .rejects.toMatchObject({ code: 'ABSOLUTE_PATH_FORBIDDEN' });
    await expect(createWorkspaceArtifactDirectory(workspace, 'research/duplicate.lbmotion', async (writer) => {
      await writer.write('same.bin', Buffer.from('one'));
      await writer.write('same.bin', Buffer.from('two'));
    })).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' });
    await expect(createWorkspaceArtifactDirectory(workspace, 'research/large.lbmotion', async (writer) => {
      await writer.write('a.bin', Buffer.alloc(8));
      await writer.write('b.bin', Buffer.alloc(8));
    }, { maxTotalBytes: 12 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rechaza archivos denegados y junctions durante el staging', async (context) => {
    const workspace = buildWorkspace({ rootPath: temporary.root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } });
    await expect(createWorkspaceArtifactDirectory(workspace, 'research/denied.lbmotion', async (writer) => {
      await writer.write('.env', Buffer.from('secret'));
    })).rejects.toMatchObject({ code: 'PATH_DENIED' });

    const outside = path.join(temporary.root, 'junction-target');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'foreign.txt'), 'foreign');
    const junction = path.join(temporary.root, 'linked');
    const attempt = await tryCreateDirJunction(outside, junction);
    if (!attempt.created) {
      context.skip(`junction unavailable: ${attempt.reason}`);
      return;
    }
    await expect(createWorkspaceArtifactDirectory(workspace, 'linked/escape.lbmotion', async () => undefined))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('mantiene la comprobación de autoridad alrededor de toda la producción', async () => {
    const workspace = buildWorkspace({ rootPath: temporary.root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } });
    const transitions: string[] = [];
    const result = await createWorkspaceArtifactDirectory(workspace, 'research/authority.lbmotion', async (writer) => {
      transitions.push('produce');
      await writer.write('manifest.json', Buffer.from('{}'));
      return true;
    }, {
      withAuthorizedEffect: async (effect) => {
        transitions.push('authorize');
        const value = await effect();
        transitions.push('release');
        return value;
      },
    });
    expect(result.value).toBe(true);
    expect(transitions).toEqual(['authorize', 'produce', 'release']);
  });

  it('separa el presupuesto visual del límite de texto sin aceptar valores sin techo', async () => {
    const workspace = buildWorkspace({ rootPath: temporary.root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    }, limits: { maxFileBytes: 1024, maxTreeEntries: 300, maxTreeDepth: 3 } });
    const result = await createWorkspaceArtifactDirectory(workspace, 'research/managed.lbmotion', async (writer) => {
      expect(writer.maxFileBytes).toBe(2 * 1024 * 1024);
      await writer.write('frame.bin', Buffer.alloc(2048));
      return true;
    }, { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
    expect(result.totalSize).toBe(2048);
    await expect(createWorkspaceArtifactDirectory(workspace, 'research/unbounded.lbmotion', async () => true, {
      maxTotalBytes: 1024 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('recupera staging anidado abandonado sin ampliar permisos', async () => {
    const workspace = buildWorkspace({ rootPath: temporary.root, permissions: {
      read: true, write: true, overwrite: false, gitRead: false, validations: false, gitWrite: false,
    } });
    const abandoned = path.join(temporary.root, 'research', '.trace.lbmotion.lbtmp-12345678-1234-4123-8123-123456789abc');
    await mkdir(abandoned, { recursive: true });
    await writeFile(path.join(abandoned, '.localbridge-artifact-staging-v1'), 'localbridge-artifact-staging-v1\n');
    await writeFile(path.join(abandoned, 'partial.bin'), 'partial');
    const result = await cleanupWorkspaceArtifactStaging(workspace);
    expect(result).toMatchObject({ removed: 1, truncated: false });
    await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });

    const matchingButUnmarked = path.join(temporary.root, 'research', '.user.lbmotion.lbtmp-abcdefab-1234-4123-8123-123456789abc');
    await mkdir(matchingButUnmarked, { recursive: true });
    await writeFile(path.join(matchingButUnmarked, 'keep.bin'), 'user data');
    const second = await cleanupWorkspaceArtifactStaging(workspace);
    expect(second.removed).toBe(0);
    expect(await readFile(path.join(matchingButUnmarked, 'keep.bin'), 'utf8')).toBe('user data');

    await mkdir(path.join(temporary.root, 'research', '.keep-lbmotion'), { recursive: true });
    const denied = { ...workspace, permissions: { ...workspace.permissions, write: false } };
    await expect(cleanupWorkspaceArtifactStaging(denied)).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
  });
});
