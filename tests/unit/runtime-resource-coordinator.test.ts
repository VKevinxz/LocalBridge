import { describe, expect, it } from 'vitest';

import {
  RuntimeResourceCoordinator,
  createDevelopmentRuntimeHandler,
  runtimeResourceKey,
} from '@localbridge/development';

describe('RuntimeResourceCoordinator', () => {
  it('serializa FIFO el mismo recurso y deja progresar recursos independientes', async () => {
    const coordinator = new RuntimeResourceCoordinator();
    const marks: string[] = [];
    let release!: () => void;
    const first = coordinator.run('browser:ws:a', async () => {
      marks.push('first:start');
      await new Promise<void>((resolve) => { release = resolve; });
      marks.push('first:end');
      return 1;
    });
    const second = coordinator.run('browser:ws:a', async () => { marks.push('second'); return 2; });
    const independent = coordinator.run('browser:ws:b', async () => { marks.push('independent'); return 3; });
    await independent;
    expect(marks).toEqual(['first:start', 'independent']);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(marks).toEqual(['first:start', 'independent', 'first:end', 'second']);
  });

  it('el control humano cancela pendientes sin cancelar el efecto ya activo', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const browser = {
      click: async (_workspaceId: string, sessionId: string) => {
        calls.push(`click:${sessionId}`);
        if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
        return { applied: true };
      },
      requestHumanControl: async (_workspaceId: string, sessionId: string) => {
        calls.push(`human:${sessionId}`);
        return { state: 'waiting_for_human' };
      },
    } as never;
    const handler = createDevelopmentRuntimeHandler({ processes: {} as never, browser });
    const clickParams = { workspaceId: 'ws_test', sessionId: 'session_a', snapshotId: 'snapshot_a', elementRef: 'element_a' };
    const active = handler({ method: 'browser.click', params: clickParams });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = handler({ method: 'browser.click', params: clickParams });
    const human = handler({ method: 'browser.human.request', params: {
      workspaceId: 'ws_test', sessionId: 'session_a', reason: 'manual_step', operationId: 'human_1',
    } });
    await expect(human).resolves.toMatchObject({ state: 'waiting_for_human' });
    await expect(queued).rejects.toMatchObject({ code: 'HUMAN_CONTROL_ACTIVE' });
    release();
    await expect(active).resolves.toMatchObject({ applied: true });
    expect(calls).toEqual(['click:session_a', 'human:session_a']);
  });

  it('deriva el recurso de sesión sin depender de URL, selector o contenido', () => {
    expect(runtimeResourceKey('browser.screenshot', { workspaceId: 'ws_a', sessionId: 'session_x' }))
      .toBe('browser:ws_a:session_x');
    expect(runtimeResourceKey('web.click', { sessionId: 'websession_x', tabId: 'tab_a' }))
      .toBe('web:websession_x');
    expect(runtimeResourceKey('browser.motion.capture', { workspaceId: 'ws_a', sessionId: 'session_x' }))
      .toBe('motion-capture:global');
    expect(runtimeResourceKey('web.motion.capture', { sessionId: 'websession_x', tabId: 'tab_a' }))
      .toBe('motion-capture:global');
    expect(runtimeResourceKey('browser.human.request', { workspaceId: 'ws_a', sessionId: 'session_x' }))
      .toBeUndefined();
  });
});
