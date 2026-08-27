import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_VERSION, TARGET_PROTOCOL_REVISION, loadConfig } from '@localbridge/shared';

describe('config', () => {
  it('SERVER_VERSION no se separa de package.json', () => {
    // La versión se anuncia en `server/discover` y en system.health. Si deriva
    // de package.json, el servidor miente sobre sí mismo sin que nada falle.
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };

    expect(SERVER_VERSION).toBe(packageJson.version);
  });

  it('apunta a la revisión moderna del protocolo', () => {
    expect(TARGET_PROTOCOL_REVISION).toBe('2026-07-28');
  });

  it('usa info como nivel de log por defecto', () => {
    expect(loadConfig({}).logLevel).toBe('info');
    expect(loadConfig({}).gitApprovalMode).toBe('mrtr');
  });

  it('activa la delegación al host sólo con un valor explícito válido', () => {
    expect(loadConfig({ LOCALBRIDGE_GIT_APPROVAL_MODE: 'host' }).gitApprovalMode).toBe('host');
    expect(loadConfig({ LOCALBRIDGE_GIT_APPROVAL_MODE: 'HOST' }).gitApprovalMode).toBe('mrtr');
    expect(loadConfig({ LOCALBRIDGE_GIT_APPROVAL_MODE: 'inseguro' }).gitApprovalMode).toBe('mrtr');
  });

  it('acepta un nivel de log válido del entorno', () => {
    expect(loadConfig({ LOCALBRIDGE_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(loadConfig({ LOCALBRIDGE_LOG_LEVEL: 'ERROR' }).logLevel).toBe('error');
  });

  it('cae a info ante un nivel inválido en lugar de fallar', () => {
    // Un valor mal escrito en el entorno no debe impedir arrancar el servidor,
    // pero tampoco puede silenciar los logs: 'info' es el punto medio seguro.
    expect(loadConfig({ LOCALBRIDGE_LOG_LEVEL: 'verboso' }).logLevel).toBe('info');
  });

  it('expone la identidad del servidor', () => {
    expect(loadConfig({}).name).toBe(SERVER_NAME);
    expect(loadConfig({}).version).toBe(SERVER_VERSION);
  });
});
