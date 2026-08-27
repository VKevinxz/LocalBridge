import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildAuditEvent, recordAuditEvent, recordPendingApproval } from '@localbridge/audit';
import { listAuditEvents, listPendingApprovals } from '@localbridge/desktop-core';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

describe('visor de auditoría', () => {
  it('filtra con parámetros cerrados y devuelve primero lo más reciente', () => {
    const root = path.join(os.tmpdir(), `localbridge-audit-view-${randomUUID()}`);
    roots.push(root);
    const dbPath = path.join(root, 'audit.db');
    recordAuditEvent(dbPath, buildAuditEvent({ action: 'file.read', workspaceId: 'ws_one', riskLevel: 'R1', decision: 'allow', outcome: 'success', durationMs: 2 }));
    recordAuditEvent(dbPath, buildAuditEvent({ action: 'file.delete', workspaceId: 'ws_two', riskLevel: 'R3', decision: 'deny', outcome: 'error', errorCode: 'CAPABILITY_DISABLED', durationMs: 1 }));

    const denied = listAuditEvents(dbPath, { workspaceId: 'ws_two', outcome: 'error', limit: 10 });

    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ action: 'file.delete', decision: 'deny' });
  });

  it('lista únicamente aprobaciones todavía vigentes', () => {
    const root = path.join(os.tmpdir(), `localbridge-approval-view-${randomUUID()}`);
    roots.push(root);
    const dbPath = path.join(root, 'audit.db');
    recordPendingApproval(dbPath, {
      id: 'pending_1',
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      workspaceId: 'ws_one',
      action: 'git.push',
    });

    expect(listPendingApprovals(dbPath)).toMatchObject([{ id: 'pending_1', workspaceId: 'ws_one', action: 'git.push' }]);
  });
});
