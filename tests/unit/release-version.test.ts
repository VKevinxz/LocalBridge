import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SERVER_VERSION } from '@localbridge/shared';

describe('metadatos de release', () => {
  it('mantiene alineadas las versiones públicas y las notas', async () => {
    const manifests = await Promise.all([
      'package.json',
      'apps/desktop/package.json',
      'apps/server/package.json',
    ].map(async (relativePath) => JSON.parse(await readFile(path.join(process.cwd(), relativePath), 'utf8')) as { version: string }));

    expect(new Set(manifests.map((manifest) => manifest.version))).toEqual(new Set([SERVER_VERSION]));
    await expect(readFile(path.join(process.cwd(), 'docs', 'releases', `v${SERVER_VERSION}.md`), 'utf8')).resolves.toContain(`v${SERVER_VERSION}`);
  });
});
