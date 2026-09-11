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
  it('aísla la ausencia del journal de análisis de procesos y terminales', async () => {
    const listProcesses = vi.fn().mockResolvedValue([{ processId: 'process_alive' }]);
    const listTerminals = vi.fn().mockResolvedValue([{ sessionId: 'terminal_alive' }]);
    const handler = createDevelopmentRuntimeHandler({
      processes: { list: listProcesses } as unknown as ProcessSupervisor,
      terminals: { list: listTerminals } as unknown as TerminalSupervisor,
      // `analysis` se omite como ocurre cuando no abre su journal.
    });

    await expect(handler({
      method: 'analysis.list',
      params: { workspaceId: 'ws_aaaaaaaa', cursor: 0, limit: 20 },
    })).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
    await expect(handler({
      method: 'process.list',
      params: { workspaceId: 'ws_aaaaaaaa' },
    })).resolves.toEqual([{ processId: 'process_alive' }]);
    await expect(handler({
      method: 'terminal.list',
      params: { projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa' },
    })).resolves.toEqual([{ sessionId: 'terminal_alive' }]);
  });

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

  it('mantiene web y desarrollo como ámbitos independientes y simultáneos', async () => {
    const listBrowser = vi.fn().mockResolvedValue([{ sessionId: 'session_development' }]);
    const stopWeb = vi.fn().mockResolvedValue({ sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', state: 'stopped' });
    const handler = createDevelopmentRuntimeHandler({
      processes: {} as ProcessSupervisor,
      browser: { list: listBrowser } as never,
      web: { stop: stopWeb } as never,
    });

    await expect(handler({
      method: 'web.stop',
      params: { sessionId: 'websession_aaaaaaaaaaaaaaaaaaaaaaaa', operationId: 'stop_web_1' },
    })).resolves.toMatchObject({ state: 'stopped' });
    await expect(handler({
      method: 'browser.list',
      params: { workspaceId: 'ws_aaaaaaaa' },
    })).resolves.toEqual([{ sessionId: 'session_development' }]);

    expect(stopWeb).toHaveBeenCalledWith('websession_aaaaaaaaaaaaaaaaaaaaaaaa', 'stop_web_1');
    expect(listBrowser).toHaveBeenCalledWith('ws_aaaaaaaa');
  });
});
