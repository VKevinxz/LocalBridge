import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-031 — portabilidad y perfiles aislados', () => {
  it('el formato portable omite rootPath, claves y rutas heredadas', async () => {
    const portability = await source('packages/desktop-core/src/portability.ts');

    expect(portability).toContain('.omit({ id: true, rootPath: true, createdAt: true })');
    expect(portability).not.toContain('CONTROL_PLANE_API_KEY');
    expect(portability).not.toContain('tunnel-key.enc');
  });

  it('las rutas importadas solo nacen de diálogos y permanecen en main', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const preload = await source('apps/desktop/src/preload/index.ts');

    expect(main).toContain('session.mappings.set(ref, result.filePaths[0])');
    expect(preload).toContain('mapPortableWorkspace(sessionId: string, ref: string)');
    expect(preload).not.toContain('mapPortableWorkspace(sessionId: string, ref: string, rootPath');
  });

  it('cada perfil no histórico obtiene key y directorio separados', async () => {
    const keys = await source('packages/desktop-core/src/secure-key-store.ts');
    const main = await source('apps/desktop/src/main/index.ts');

    expect(keys).toContain('"tunnel-keys", `${validated}.enc`');
    expect(main).toContain('join(paths.profileDir, connection.id)');
  });
});
