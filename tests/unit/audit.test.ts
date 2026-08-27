import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  buildAuditEvent,
  classifyDecision,
  queryPendingApprovals,
  readAllAuditEvents,
  recordAuditEvent,
  recordPendingApproval,
  resolvePendingApproval,
  type AuditEvent,
} from '@localbridge/audit';
import { ERROR_CODES } from '@localbridge/shared';

const run = promisify(execFile);
const AUDIT_WRITER_SCRIPT = fileURLToPath(new URL('../helpers/audit-writer.mjs', import.meta.url));

/**
 * Ruta al CLI de `tsx` resuelta desde disco, no vía `npx`: `npx` es un `.cmd`
 * en Windows y `execFile` no pasa por shell, así que invocarlo directamente
 * falla ahí. `tsx/dist/cli.mjs` no está en el mapa de `exports` del paquete,
 * así que se deriva desde `tsx/package.json` (que sí lo está) en vez de
 * pedirle a Node que resuelva la ruta bloqueada.
 */
const require = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

function tempDbPath(): string {
  return path.join(os.tmpdir(), `localbridge-audit-test-${randomUUID()}`, 'audit.db');
}

describe('classifyDecision', () => {
  it('sin código de error -> allow (la operación tuvo éxito)', () => {
    expect(classifyDecision(undefined)).toBe('allow');
  });

  it('códigos de rechazo de política -> deny', () => {
    for (const code of [
      'WORKSPACE_NOT_FOUND',
      'WORKSPACE_DISABLED',
      'CAPABILITY_DISABLED',
      'PATH_OUTSIDE_WORKSPACE',
      'ABSOLUTE_PATH_FORBIDDEN',
      'SYMLINK_ESCAPE',
      'PATH_DENIED',
      'COMMAND_NOT_ALLOWED',
      'INVALID_INPUT',
      'RATE_LIMITED',
    ] as const) {
      expect(classifyDecision(code)).toBe('deny');
    }
  });

  it('HASH_MISMATCH es allow, no deny: se autorizó el overwrite, falló por el estado del recurso', () => {
    expect(classifyDecision('HASH_MISMATCH')).toBe('allow');
  });

  it('códigos de fallo operativo -> allow (se autorizó, falló por el estado del sistema)', () => {
    for (const code of [
      'FILE_NOT_FOUND',
      'FILE_ALREADY_EXISTS',
      'FILE_TOO_LARGE',
      'NOT_A_FILE',
      'GIT_NOT_REPOSITORY',
      'TIMEOUT',
      'OUTPUT_TRUNCATED',
      'INTERNAL_ERROR',
    ] as const) {
      expect(classifyDecision(code)).toBe('allow');
    }
  });

  it('la clasificación cubre todos los códigos de error existentes (exhaustividad)', () => {
    for (const code of ERROR_CODES) {
      expect(['allow', 'deny']).toContain(classifyDecision(code));
    }
  });
});

describe('buildAuditEvent', () => {
  it('genera id, timestamp y requestId, y conserva el resto de campos', () => {
    const event = buildAuditEvent({
      action: 'file.read',
      riskLevel: 'R1',
      decision: 'allow',
      outcome: 'success',
      durationMs: 12,
    });

    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.id).not.toBe(event.requestId);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(event.action).toBe('file.read');
  });

  it('descarta un resource que sea ruta absoluta (Windows o POSIX) en vez de persistirlo', () => {
    for (const absolute of ['C:\\Users\\example-user\\secreto.txt', '/etc/passwd', '\\\\server\\share\\file']) {
      const event = buildAuditEvent({
        action: 'file.read',
        resource: absolute,
        riskLevel: 'R1',
        decision: 'deny',
        outcome: 'error',
        errorCode: 'ABSOLUTE_PATH_FORBIDDEN',
        durationMs: 1,
      });

      expect(event.resource).toBeUndefined();
    }
  });

  it('conserva un resource que es ruta relativa', () => {
    const event = buildAuditEvent({
      action: 'file.read',
      resource: 'src/index.ts',
      riskLevel: 'R1',
      decision: 'allow',
      outcome: 'success',
      durationMs: 1,
    });

    expect(event.resource).toBe('src/index.ts');
  });
});

describe('recordAuditEvent / readAllAuditEvents', () => {
  it('un evento insertado se puede releer tal cual', () => {
    const dbPath = tempDbPath();
    const event = buildAuditEvent({
      workspaceId: 'ws_a',
      action: 'file.read',
      resource: 'src/index.ts',
      riskLevel: 'R1',
      decision: 'allow',
      outcome: 'success',
      durationMs: 8,
    });

    recordAuditEvent(dbPath, event);

    const [stored] = readAllAuditEvents(dbPath);
    expect(stored).toEqual(event);
  });

  it('un evento de denegación conserva errorCode y decision=deny', () => {
    const dbPath = tempDbPath();
    const event = buildAuditEvent({
      workspaceId: 'ws_a',
      action: 'file.read',
      resource: '.env',
      riskLevel: 'R1',
      decision: 'deny',
      outcome: 'error',
      errorCode: 'PATH_DENIED',
      durationMs: 3,
    });

    recordAuditEvent(dbPath, event);

    const [stored] = readAllAuditEvents(dbPath);
    expect(stored?.decision).toBe('deny');
    expect(stored?.errorCode).toBe('PATH_DENIED');
  });

  it('campos opcionales ausentes no aparecen como null ni como cadena vacía', () => {
    const dbPath = tempDbPath();
    const event = buildAuditEvent({
      action: 'workspace.list',
      riskLevel: 'R1',
      decision: 'allow',
      outcome: 'success',
      durationMs: 1,
    });

    recordAuditEvent(dbPath, event);

    const [stored] = readAllAuditEvents(dbPath);
    expect(stored?.workspaceId).toBeUndefined();
    expect(stored?.resource).toBeUndefined();
    expect(stored?.errorCode).toBeUndefined();
    expect(stored?.operationId).toBeUndefined();
  });

  it('varios eventos se conservan en orden cronológico', () => {
    const dbPath = tempDbPath();
    const events: AuditEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      const event = buildAuditEvent({
        action: `tool.${i}`,
        riskLevel: 'R1',
        decision: 'allow',
        outcome: 'success',
        durationMs: i,
      });
      events.push(event);
      recordAuditEvent(dbPath, event);
    }

    const stored = readAllAuditEvents(dbPath);
    expect(stored.map((e) => e.action)).toEqual(events.map((e) => e.action));
  });

  it('el fichero se crea junto con su directorio si no existe', () => {
    const dbPath = tempDbPath();
    const event = buildAuditEvent({
      action: 'system.health',
      riskLevel: 'R0',
      decision: 'allow',
      outcome: 'success',
      durationMs: 1,
    });

    expect(() => recordAuditEvent(dbPath, event)).not.toThrow();
  });

  it('conserva operationId para correlacionar con reintentos idempotentes', () => {
    const dbPath = tempDbPath();
    const event = buildAuditEvent({
      workspaceId: 'ws_a',
      action: 'file.create',
      resource: 'nuevo.md',
      riskLevel: 'R2',
      decision: 'allow',
      outcome: 'success',
      operationId: 'op-123',
      durationMs: 5,
    });

    recordAuditEvent(dbPath, event);

    const [stored] = readAllAuditEvents(dbPath);
    expect(stored?.operationId).toBe('op-123');
  });
});

describe('recordAuditEvent bajo concurrencia entre procesos', () => {
  it(
    'varios procesos del SO escribiendo al mismo audit.db no pierden eventos ni fallan con "database is locked"',
    async () => {
      const dbPath = tempDbPath();
      const actions = Array.from({ length: 12 }, (_, i) => `concurrent.process.${i}`);

      // Cada escritura corre en un proceso Node aparte (ver audit-writer.mjs):
      // el bloqueo de SQLite que corrige `busy_timeout` sólo aparece entre
      // procesos del SO distintos, no entre promesas del mismo proceso.
      await Promise.all(actions.map((action) => run(process.execPath, [TSX_CLI, AUDIT_WRITER_SCRIPT, dbPath, action])));

      const stored = readAllAuditEvents(dbPath);
      expect(stored.map((e) => e.action).toSorted()).toEqual(actions.toSorted());
    },
    30_000,
  );
});

describe('aprobaciones MRTR pendientes', () => {
  it('deduplica reintentos idénticos y mantiene visible la expiración del token más reciente', () => {
    const dbPath = tempDbPath();
    recordPendingApproval(dbPath, {
      id: 'approval_same',
      requestedAt: '2026-08-23T20:00:00.000Z',
      expiresAt: '2026-08-23T20:05:00.000Z',
      workspaceId: 'ws_a',
      action: 'git.commit',
    });
    recordPendingApproval(dbPath, {
      id: 'approval_same',
      requestedAt: '2026-08-23T20:01:00.000Z',
      expiresAt: '2026-08-23T20:06:00.000Z',
      workspaceId: 'ws_a',
      action: 'git.commit',
    });

    const pending = queryPendingApprovals(dbPath, new Date('2026-08-23T20:02:00.000Z'));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestedAt).toBe('2026-08-23T20:01:00.000Z');
    expect(pending[0]?.expiresAt).toBe('2026-08-23T20:06:00.000Z');
  });

  it('oculta las solicitudes expiradas y permite resolver por ID', () => {
    const dbPath = tempDbPath();
    for (const approval of [
      { id: 'commit', action: 'git.commit' as const },
      { id: 'push', action: 'git.push' as const },
    ]) {
      recordPendingApproval(dbPath, {
        ...approval,
        requestedAt: '2026-08-23T20:00:00.000Z',
        expiresAt: '2026-08-23T20:05:00.000Z',
        workspaceId: 'ws_a',
      });
    }

    resolvePendingApproval(dbPath, {
      id: 'commit', requestedAt: '2026-08-23T20:01:00.000Z', expiresAt: '2026-08-23T20:06:00.000Z', workspaceId: 'ws_a', action: 'git.commit',
    });
    expect(queryPendingApprovals(dbPath, new Date('2026-08-23T20:01:00.000Z')).map((item) => item.id)).toEqual(['push']);

    resolvePendingApproval(dbPath, {
      id: 'push', requestedAt: '2026-08-23T20:01:00.000Z', expiresAt: '2026-08-23T20:06:00.000Z', workspaceId: 'ws_a', action: 'git.push',
    });
    expect(queryPendingApprovals(dbPath, new Date('2026-08-23T20:01:00.000Z'))).toEqual([]);

    recordPendingApproval(dbPath, {
      id: 'expired',
      requestedAt: '2026-08-23T20:00:00.000Z',
      expiresAt: '2026-08-23T20:05:00.000Z',
      workspaceId: 'ws_a',
      action: 'git.commit',
    });
    expect(queryPendingApprovals(dbPath, new Date('2026-08-23T20:05:00.000Z'))).toEqual([]);
  });

  it('un estado resuelto no puede resucitar por una primera ronda concurrente tardía', () => {
    const dbPath = tempDbPath();
    const approval = {
      id: 'race', requestedAt: '2026-08-23T20:00:00.000Z', expiresAt: '2026-08-23T20:05:00.000Z', workspaceId: 'ws_a', action: 'git.commit' as const,
    };
    resolvePendingApproval(dbPath, approval);
    expect(recordPendingApproval(dbPath, { ...approval, requestedAt: '2026-08-23T20:00:01.000Z' })).toBeUndefined();
    expect(queryPendingApprovals(dbPath, new Date('2026-08-23T20:00:02.000Z'))).toEqual([]);
  });

  it('limita a 100 solicitudes pendientes aunque cambie el mensaje aprobado', () => {
    const dbPath = tempDbPath();
    for (let index = 0; index < 120; index += 1) {
      recordPendingApproval(dbPath, {
        id: `pending-${index}`,
        requestedAt: new Date(Date.UTC(2026, 7, 23, 20, 0, index)).toISOString(),
        expiresAt: '2026-08-23T21:00:00.000Z',
        workspaceId: 'ws_a',
        action: 'git.commit',
      });
    }
    expect(queryPendingApprovals(dbPath, new Date('2026-08-23T20:00:00.000Z'))).toHaveLength(100);
  }, 30_000);
});
