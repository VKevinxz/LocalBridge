import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('SEC-027 — frontera privilegiada de Electron', () => {
  it('cada handler IPC valida el frame emisor antes de operar', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const handlerCount = main.match(/ipcMain\.handle\(/g)?.length ?? 0;
    const validationCount = main.match(/assertTrustedSender\(event\)/g)?.length ?? 0;

    expect(handlerCount).toBeGreaterThan(0);
    expect(validationCount).toBe(handlerCount);
  });

  it('bloquea navegación, ventanas nuevas y permisos del renderer', async () => {
    const main = await source('apps/desktop/src/main/index.ts');

    expect(main).toContain('webContents.on("will-navigate", (event) => event.preventDefault())');
    expect(main).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(main).toContain('setPermissionCheckHandler(() => false)');
    expect(main).toContain('callback(false)');
    expect(main).toContain('app.enableSandbox()');
    expect(main).toContain('externalDestinationSchema.parse(destinationInput)');
    expect(main).toContain('shell.openExternal(EXTERNAL_URLS[destination])');
  });

  it('resuelve recursos empaquetados como ESM y mantiene una única instancia', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const vite = await source('apps/desktop/electron.vite.config.ts');

    expect(main).toContain('fileURLToPath(import.meta.url)');
    expect(main).not.toContain('__dirname');
    expect(main).toContain('join(moduleDirectory, "../preload/index.cjs")');
    expect(vite).toContain("entryFileNames: 'index.cjs'");
    expect(vite).toContain("format: 'cjs'");
    expect(main).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain('app.exit(0)');
    expect(main).toContain('app.on("second-instance", showMainWindow)');
  });

  it('la release exige una ventana empaquetada real y una única instancia', async () => {
    const workflow = await source('.github/workflows/release.yml');
    const smoke = await source('scripts/smoke-packaged-desktop.ps1');

    expect(workflow).toContain('./scripts/smoke-packaged-desktop.ps1');
    expect(smoke).toContain('MainWindowHandle -ne 0');
    expect(smoke).toContain("MainWindowTitle -notmatch '^LocalBridge MCP . Escritorio$'");
    expect(smoke).toContain("throw 'A second launch created another desktop instance.'");
    expect(smoke).toContain('Uncaught TypeError|Unable to load preload script');
    expect(smoke).toContain('Refusing to reuse or stop');
    expect(smoke).toContain('$env:USERPROFILE = $userProfilePath');
    expect(smoke).toContain('verify-packaged-first-run.mjs');
    expect(smoke).toContain('did not exit through app:quit');
  });

  it('no hereda el entorno completo al proceso de túnel', async () => {
    const supervisor = await source('packages/desktop-core/src/tunnel-supervisor.ts');

    expect(supervisor).toContain('buildFilteredEnv(');
    expect(supervisor).not.toContain('env: { ...process.env');
  });

  it('fija fuses de producción e integridad de ASAR', async () => {
    const builder = await source('apps/desktop/electron-builder.yml');

    expect(builder).toContain('runAsNode: false');
    expect(builder).toContain('enableNodeOptionsEnvironmentVariable: false');
    expect(builder).toContain('enableNodeCliInspectArguments: false');
    expect(builder).toContain('enableEmbeddedAsarIntegrityValidation: true');
    expect(builder).toContain('onlyLoadAppFromAsar: true');
  });

  it('mantiene el servidor fuera del proceso Electron y sin RunAsNode', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const builder = await source('apps/desktop/electron-builder.yml');

    expect(main).not.toContain('runLocalBridgeStdio()');
    expect(main).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(builder).toContain('from: out/server');
    expect(builder).toContain('from: vendor/node');
    expect(builder).toContain('!node_modules/@localbridge/**/*');
  });

  it('mantiene una CSP cerrada para scripts, objetos y frames', async () => {
    const html = await source('apps/desktop/src/renderer/index.html');

    expect(html).toContain("script-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("frame-src 'none'");
  });
});
