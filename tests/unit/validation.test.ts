import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLocalBridgeError } from '@localbridge/shared';
import { runValidation, runValidationCommand } from '@localbridge/validation';

import { buildWorkspace, createTempWorkspaceDir, type TempWorkspace } from '../helpers/fixtures.js';

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await createTempWorkspaceDir();
});

afterEach(async () => {
  await workspace.cleanup();
});

/** Comando neutral entre plataformas: Node siempre está disponible porque ejecuta los tests. */
function nodeCommand(script: string): string[] {
  return [process.execPath, '-e', script];
}

describe('runValidationCommand — proceso real', () => {
  it('captura stdout, stderr y exitCode de un proceso real', async () => {
    const result = await runValidationCommand(nodeCommand('console.log("hola"); console.error("aviso"); process.exit(3);'), {
      cwd: workspace.root,
    });

    expect(result.stdout.trim()).toBe('hola');
    expect(result.stderr.trim()).toBe('aviso');
    expect(result.exitCode).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('un exitCode distinto de 0 no lanza: es un resultado válido', async () => {
    const result = await runValidationCommand(nodeCommand('process.exit(1);'), { cwd: workspace.root });
    expect(result.exitCode).toBe(1);
  });

  it('[SEC-019] una salida que crece sin fin se trunca en vez de esperar el timeout completo', async () => {
    const start = Date.now();
    const result = await runValidationCommand(
      nodeCommand('while (true) { process.stdout.write("x".repeat(65536)); }'),
      { cwd: workspace.root },
    );
    const elapsedMs = Date.now() - start;

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
    // Se corta muy por debajo del timeout de 120s: prueba que se mata el
    // árbol al detectar el exceso, no que se espera el timeout completo.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);

  it('un comando inexistente -> COMMAND_NOT_ALLOWED, no un crash', async () => {
    try {
      await runValidationCommand(['este-binario-no-existe-jamas'], { cwd: workspace.root });
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('COMMAND_NOT_ALLOWED');
    }
  });

  it('el cwd del proceso es el que se pide', async () => {
    await mkdir(path.join(workspace.root, 'sub'), { recursive: true });
    await writeFile(path.join(workspace.root, 'sub', 'marker.txt'), 'aqui');

    const result = await runValidationCommand(nodeCommand('console.log(require("fs").readdirSync(".").join(","))'), {
      cwd: path.join(workspace.root, 'sub'),
    });

    expect(result.stdout).toContain('marker.txt');
  });

  it('cancela el árbol finito administrado sin esperar el timeout global', async () => {
    const controller = new AbortController();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const pending = runValidationCommand(
      nodeCommand('setInterval(() => process.stdout.write("alive\\n"), 50);'),
      { cwd: workspace.root, signal: controller.signal, onStarted: signalStarted },
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
  });
});

describe('runValidationCommand — envoltorios .cmd de Windows (regresión)', () => {
  /**
   * `npm`/`npx`/`pnpm`/`yarn` son ficheros `.cmd` en Windows. Desde el arreglo
   * de Node para CVE-2024-27980, `spawn(..., { shell: false })` no puede
   * lanzarlos — falla con `ENOENT`, que este módulo traducía a
   * `COMMAND_NOT_ALLOWED`. Encontrado en producción: cualquier perfil de
   * validación basado en un gestor de paquetes de Node fallaba siempre,
   * aunque estuviera bien configurado. Ver `resolvesToWindowsScriptShim` en
   * `runner.ts`. Específico de Windows — no aplica a POSIX, donde estos
   * mismos binarios ya son ejecutables reales.
   */
  it('un .cmd real (ruta explícita) se ejecuta correctamente', async () => {
    if (process.platform !== 'win32') {
      console.warn('[skip] específico de Windows: resolución de envoltorios .cmd/.bat');
      return;
    }

    const scriptPath = path.join(workspace.root, 'fake-tool.cmd');
    await writeFile(scriptPath, '@echo off\r\necho hola desde cmd\r\nexit /b 7\r\n');

    const result = await runValidationCommand([scriptPath], { cwd: workspace.root });

    expect(result.stdout).toContain('hola desde cmd');
    expect(result.exitCode).toBe(7);
  });

  it('un .cmd resuelto por nombre vía PATH (como npm/npx reales) se ejecuta correctamente', async () => {
    if (process.platform !== 'win32') {
      console.warn('[skip] específico de Windows: resolución de envoltorios .cmd/.bat');
      return;
    }

    const binDir = path.join(workspace.root, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'mi-herramienta.cmd'), '@echo off\r\necho resuelto por PATH\r\n');

    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const result = await runValidationCommand(['mi-herramienta'], { cwd: workspace.root });
      expect(result.stdout).toContain('resuelto por PATH');
      expect(result.exitCode).toBe(0);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('un binario sin extensión que no existe en PATH sigue dando COMMAND_NOT_ALLOWED, no se lanza un shell a ciegas', async () => {
    if (process.platform !== 'win32') {
      console.warn('[skip] específico de Windows: resolución de envoltorios .cmd/.bat');
      return;
    }

    try {
      await runValidationCommand(['este-binario-no-existe-jamas'], { cwd: workspace.root });
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('COMMAND_NOT_ALLOWED');
    }
  });
});

describe('runValidation — resolución de perfil', () => {
  it('un perfil no configurado -> COMMAND_NOT_ALLOWED', async () => {
    const ws = buildWorkspace({ rootPath: workspace.root, validationProfiles: {} });

    try {
      await runValidation(ws, 'test');
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('COMMAND_NOT_ALLOWED');
    }
  });

  it('un perfil configurado ejecuta exactamente ese comando, no lo que pida el "profile"', async () => {
    const ws = buildWorkspace({
      rootPath: workspace.root,
      validationProfiles: { test: nodeCommand('console.log("perfil test ejecutado")') },
    });

    const result = await runValidation(ws, 'test');

    expect(result.profile).toBe('test');
    expect(result.stdout).toContain('perfil test ejecutado');
    expect(result.timedOut).toBe(false);
  });

  it('dos perfiles en el mismo workspace no corren a la vez: se serializan', async () => {
    const marks: string[] = [];
    const ws = buildWorkspace({
      rootPath: workspace.root,
      validationProfiles: {
        lento: nodeCommand('setTimeout(() => { console.log("lento"); }, 200);'),
        rapido: nodeCommand('console.log("rapido");'),
      },
    });

    const [a] = await Promise.all([
      runValidation(ws, 'lento').then((r) => marks.push(r.stdout.trim())),
      runValidation(ws, 'rapido').then((r) => marks.push(r.stdout.trim())),
    ]);
    void a;

    expect(marks).toEqual(['lento', 'rapido']);
  });

  it('expone adquisición/liberación del lock y permite avanzar a workspaces independientes', async () => {
    let activeLocks = 0;
    let maximumActiveLocks = 0;
    const command = nodeCommand('setTimeout(() => process.exit(0), 150);');
    const first = buildWorkspace({ id: 'ws_validation_a', rootPath: workspace.root, validationProfiles: { qa: command } });
    const otherRoot = path.join(workspace.root, 'other');
    await mkdir(otherRoot);
    const second = buildWorkspace({ id: 'ws_validation_b', rootPath: otherRoot, validationProfiles: { qa: command } });
    const lifecycle = () => ({
      onLockAcquired: () => {
        activeLocks += 1;
        maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks);
      },
      onLockReleased: () => { activeLocks -= 1; },
    });

    await Promise.all([runValidation(first, 'qa', lifecycle()), runValidation(second, 'qa', lifecycle())]);

    expect(maximumActiveLocks).toBe(2);
    expect(activeLocks).toBe(0);
  });
});
