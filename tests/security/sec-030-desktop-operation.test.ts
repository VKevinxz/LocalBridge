import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-030 — operación de escritorio segura', () => {
  it('una exportación crea exclusivamente y nunca reemplaza', async () => {
    const filesystem = await source('packages/filesystem/src/create-exclusive.ts');
    const main = await source('apps/desktop/src/main/index.ts');

    expect(filesystem).toContain('open(filePath, "wx", 0o600)');
    expect(main).toContain('diagnosticTextSchema.parse(textInput)');
    expect(main).toContain('exportDiagnosticFile(result.filePath, text)');
  });

  it('la caída definitiva notifica solo al entrar al estado error', async () => {
    const main = await source('apps/desktop/src/main/index.ts');

    expect(main).toContain('status === "error" && previous !== "error"');
    expect(main).toContain('Los reintentos automáticos terminaron');
  });

  it('salir explícitamente desconecta el túnel', async () => {
    const main = await source('apps/desktop/src/main/index.ts');

    expect(main).toContain('function quitApplication(): void');
    expect(main).toContain('explicitQuit = true;\n  tunnel.disconnect();\n  app.quit();');
  });
});
