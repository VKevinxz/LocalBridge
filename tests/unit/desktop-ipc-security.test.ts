import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  authorizedWorkspaceInputSchema,
  auditQuerySchema,
  liveViewerMoveInputSchema,
  liveViewerTargetInputSchema,
  terminalListenerTargetInputSchema,
  terminalSessionTargetInputSchema,
  connectionProfileNameSchema,
  diagnosticTextSchema,
  externalDestinationSchema,
  newWorkspaceInputSchema,
  tunnelApiKeyInputSchema,
  portableImportSessionIdSchema,
  portableWorkspaceRefSchema,
} from '@localbridge/desktop-core';
import { assertTrustedIpcSender } from '../../apps/desktop/src/main/ipc-security.js';

const PERMISSIONS = {
  read: true,
  write: false,
  overwrite: false,
  gitRead: false,
  validations: true,
  gitWrite: false,
};

describe('frontera IPC de Electron', () => {
  it('acepta únicamente el frame principal de la ventana principal', () => {
    const mainFrame = {};
    const trusted = { id: 7, mainFrame };

    expect(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: mainFrame }, trusted)).not.toThrow();
    expect(() => assertTrustedIpcSender({ sender: { id: 8 }, senderFrame: mainFrame }, trusted)).toThrow(
      'Emisor IPC no autorizado',
    );
    expect(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: {} }, trusted)).toThrow(
      'Emisor IPC no autorizado',
    );
    expect(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: mainFrame }, undefined)).toThrow(
      'Emisor IPC no autorizado',
    );
  });

  it('valida alta de workspace y conserva perfiles detectados', () => {
    const parsed = newWorkspaceInputSchema.parse({
      name: 'Proyecto',
      rootPath: path.resolve('proyecto'),
      permissions: PERMISSIONS,
      validationProfiles: { test: ['pnpm', 'test'] },
    });

    expect(parsed.validationProfiles).toEqual({ test: ['pnpm', 'test'] });
  });

  it('rechaza rutas relativas, campos extra y workspaces manipulados', () => {
    expect(() =>
      newWorkspaceInputSchema.parse({
        name: 'Proyecto',
        rootPath: 'ruta-relativa',
        permissions: PERMISSIONS,
        extra: true,
      }),
    ).toThrow();

    expect(() =>
      authorizedWorkspaceInputSchema.parse({
        id: 'ws_demo',
        name: 'Proyecto',
        rootPath: 'ruta-relativa',
        enabled: true,
        createdAt: new Date().toISOString(),
        permissions: PERMISSIONS,
      }),
    ).toThrow();
  });

  it('rechaza claves vacías o desproporcionadas sin registrar su contenido', () => {
    expect(() => tunnelApiKeyInputSchema.parse('   ')).toThrow();
    expect(() => tunnelApiKeyInputSchema.parse('x'.repeat(16_385))).toThrow();
    expect(tunnelApiKeyInputSchema.parse('clave-de-prueba')).toBe('clave-de-prueba');
  });

  it('solo permite enlaces externos predefinidos, nunca una URL del renderer', () => {
    expect(externalDestinationSchema.parse('tunnels')).toBe('tunnels');
    expect(() => externalDestinationSchema.parse('https://evil.example')).toThrow();
  });

  it('limita el tamaño de diagnósticos que cruzan IPC', () => {
    expect(diagnosticTextSchema.parse('diagnóstico')).toBe('diagnóstico');
    expect(() => diagnosticTextSchema.parse('x'.repeat(256 * 1024 + 1))).toThrow();
  });

  it('valida filtros, perfiles y sesiones de portabilidad', () => {
    expect(connectionProfileNameSchema.parse('Trabajo')).toBe('Trabajo');
    expect(() => connectionProfileNameSchema.parse('x'.repeat(81))).toThrow();
    expect(portableImportSessionIdSchema.parse('00000000-0000-4000-8000-000000000000')).toContain('0000');
    expect(portableWorkspaceRefSchema.parse('portable_0123456789abcdef')).toContain('portable_');
    expect(auditQuerySchema.parse({ outcome: 'error', limit: 100 })).toEqual({ outcome: 'error', limit: 100 });
    expect(() => auditQuerySchema.parse({ action: 'file.read; DROP TABLE' })).toThrow();
  });

  it('acepta solo IDs para colocar la ventana en vivo, nunca coordenadas', () => {
    const sessionId = `session_${'a'.repeat(24)}`;
    expect(liveViewerTargetInputSchema.parse({ sessionId, displayId: '-123456' })).toEqual({ sessionId, displayId: '-123456' });
    expect(liveViewerTargetInputSchema.parse({ sessionId })).toEqual({ sessionId });
    expect(liveViewerMoveInputSchema.parse({ sessionId, displayId: '42' })).toEqual({ sessionId, displayId: '42' });
    for (const invalid of [
      { sessionId, displayId: 'monitor-left' },
      { sessionId, displayId: '42', x: 100 },
      { sessionId, displayId: '42', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { sessionId: 'session_invalid', displayId: '42' },
    ]) expect(() => liveViewerMoveInputSchema.parse(invalid)).toThrow();
  });

  it('acepta solo referencias opacas para acciones locales de terminal', () => {
    const projectId = `project_${'a'.repeat(24)}`;
    const terminalSessionId = `terminal_${'b'.repeat(24)}`;
    const listenerRef = `listener_${'c'.repeat(24)}`;
    expect(terminalSessionTargetInputSchema.parse({ projectId, terminalSessionId })).toEqual({ projectId, terminalSessionId });
    expect(terminalListenerTargetInputSchema.parse({ projectId, terminalSessionId, listenerRef })).toEqual({
      projectId, terminalSessionId, listenerRef,
    });
    for (const invalid of [
      { projectId, terminalSessionId, listenerRef, url: 'http://localhost:5173' },
      { projectId, terminalSessionId, listenerRef, port: 5173 },
      { projectId, terminalSessionId: 'terminal_invalid', listenerRef },
      { projectId, terminalSessionId, listenerRef: 'listener_invalid' },
    ]) expect(() => terminalListenerTargetInputSchema.parse(invalid)).toThrow();
  });
});
