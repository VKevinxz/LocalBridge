import { describe, expect, it, vi } from 'vitest';

import {
  createDevelopmentRuntimeHandler,
  type ProcessSupervisor,
  type ResolvedTerminalListener,
  type TerminalSupervisor,
} from '@localbridge/development';

const resolved = (processId: string, listenerRef: string, port: number): ResolvedTerminalListener => ({
  processId,
  listenerRef,
  profile: 'terminal',
  projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
  trustMode: 'full-host',
  technicalOrigin: port === 3007 ? 'http://[::]:3007' : 'http://[::1]:5173',
  browserOrigin: `http://localhost:${port}`,
  origin: port === 3007 ? 'http://[::]:3007' : 'http://[::1]:5173',
  addressFamily: 'ipv6',
  bindScope: port === 3007 ? 'wildcard' : 'loopback',
  exclusive: true,
  port,
  observedAt: '2026-08-26T00:00:00.000Z',
});

describe('adaptador runtime del navegador project-first', () => {
  it('resuelve y conserva el orden de principal y listeners relacionados', async () => {
    const listeners = [
      resolved('terminal_frontend', 'listener_frontend', 5173),
      resolved('terminal_api', 'listener_api', 3007),
    ];
    const resolveListeners = vi.fn().mockResolvedValue(listeners);
    const startProjectFromTerminals = vi.fn().mockResolvedValue({ sessionId: 'browser_test' });
    const handler = createDevelopmentRuntimeHandler({
      processes: {} as ProcessSupervisor,
      terminals: { resolveListeners } as unknown as TerminalSupervisor,
      browser: { startProjectFromTerminals } as never,
    });

    await expect(handler({
      method: 'browser.start',
      params: {
        workspaceId: 'ws_aaaaaaaa',
        projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
        terminalSessionId: 'terminal_frontend',
        listenerRef: 'listener_frontend',
        relatedListeners: [{ terminalSessionId: 'terminal_api', listenerRef: 'listener_api' }],
        operationId: 'operation-1',
      },
    })).resolves.toEqual({ sessionId: 'browser_test' });

    expect(resolveListeners).toHaveBeenCalledWith(
      'project_aaaaaaaaaaaaaaaaaaaaaaaa',
      [
        { terminalSessionId: 'terminal_frontend', listenerRef: 'listener_frontend' },
        { terminalSessionId: 'terminal_api', listenerRef: 'listener_api' },
      ],
      'ws_aaaaaaaa',
    );
    expect(startProjectFromTerminals).toHaveBeenCalledWith(
      'ws_aaaaaaaa',
      'project_aaaaaaaaaaaaaaaaaaaaaaaa',
      listeners,
      'operation-1',
    );
  });
});
