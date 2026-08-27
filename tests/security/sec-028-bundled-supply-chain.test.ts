import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-028 — cadena de suministro de la distribución', () => {
  it('fija versión, URL HTTPS y checksum del túnel oficial', async () => {
    const script = await source('scripts/prepare-tunnel-client.ps1');

    expect(script).toContain("$version = 'v0.0.12'");
    expect(script).toContain('https://github.com/openai/tunnel-client/releases/download/');
    expect(script).toContain('2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356');
    expect(script).toContain('a485021fe13a947c013943065e58f85462262741542e81f15de51e7ff1509812');
    expect(script).toContain('SHA256SUMS.txt');
    expect(script).toContain('Test-VerifiedDirectory');
  });

  it('fija Node oficial y extrae solo una allowlist con hashes', async () => {
    const script = await source('scripts/prepare-node-runtime.ps1');

    expect(script).toContain("$version = 'v22.18.0'");
    expect(script).toContain('https://nodejs.org/dist/');
    expect(script).toContain('c95d8a7e1c99e669cc08c9f1176e068c1f50847c37908fcb8c35b62482366511');
    expect(script).toContain("'node.exe' = 'c22d1c59");
    expect(script).toContain('ExtractToFile');
    expect(script).not.toContain('Expand-Archive');
  });

  it('incluye runtime, servidor y avisos como recursos externos', async () => {
    const builder = await source('apps/desktop/electron-builder.yml');

    expect(builder).toContain('from: vendor/tunnel-client');
    expect(builder).toContain('from: vendor/node');
    expect(builder).toContain('from: out/server');
  });
});
