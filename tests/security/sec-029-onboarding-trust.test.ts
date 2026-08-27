import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-029 — onboarding conserva límites de confianza', () => {
  it('no solicita ni transmite una clave administrativa', async () => {
    const renderer = await source('apps/desktop/src/renderer/src/main.ts');
    const main = await source('apps/desktop/src/main/index.ts');

    expect(renderer).not.toContain('OPENAI_ADMIN_KEY');
    expect(main).not.toContain('OPENAI_ADMIN_KEY');
  });

  it('abre solo URLs fijas validadas en main', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const inputs = await source('packages/desktop-core/src/ipc-inputs.ts');

    expect(inputs).toContain('z.enum(["tunnels", "runtimeKeys", "chatgptConnectors"])');
    expect(main).toContain('externalDestinationSchema.parse(destinationInput)');
    expect(main).toContain('EXTERNAL_URLS[destination]');
  });

  it('mantiene Solo lectura como preset inicial', async () => {
    const renderer = await source('apps/desktop/src/renderer/src/main.ts');

    expect(renderer).toContain("read: true");
    expect(renderer).toContain("write: false");
    expect(renderer).toContain('Solo lectura — recomendado');
  });
});
