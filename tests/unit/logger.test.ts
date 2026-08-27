import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@localbridge/shared';

function captureStream(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger', () => {
  it('emite una línea JSON por entrada', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream, now: () => new Date('2026-08-19T10:00:00.000Z') });

    logger.info('server started', { transport: 'stdio' });

    expect(lines()).toEqual([
      {
        timestamp: '2026-08-19T10:00:00.000Z',
        level: 'info',
        message: 'server started',
        transport: 'stdio',
      },
    ]);
  });

  it('filtra por nivel', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream, level: 'warn' });

    logger.debug('no');
    logger.info('no');
    logger.warn('sí');
    logger.error('sí');

    expect(lines().map((line) => line['level'])).toEqual(['warn', 'error']);
  });

  it('redacta claves sensibles (SECURITY.md §6.1)', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream });

    logger.info('request', {
      authorization: 'Bearer abcdef123456',
      accessToken: 'tok_supersecreto',
      userPassword: 'hunter2',
      apiKey: 'sk-secreto',
      content: 'contenido completo del archivo',
      sessionId: 'sess_123',
      workspaceId: 'ws_7f3a91',
    });

    const [line] = lines();
    const serialized = JSON.stringify(line);

    expect(serialized).not.toContain('abcdef123456');
    expect(serialized).not.toContain('tok_supersecreto');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-secreto');
    expect(serialized).not.toContain('contenido completo');
    expect(serialized).not.toContain('sess_123');

    // Un identificador opaco de workspace no es un secreto y debe sobrevivir:
    // sin él, los logs no sirven para diagnosticar nada.
    expect(line?.['workspaceId']).toBe('ws_7f3a91');
  });

  it('redacta también en objetos anidados', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream });

    logger.info('nested', { request: { headers: { authorization: 'Bearer secreto' } } });

    expect(JSON.stringify(lines()[0])).not.toContain('secreto');
  });

  it('reduce un Error a su nombre, sin stack', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream });
    const error = new Error('ENOENT: D:\\Users\\example-user\\.ssh\\id_rsa');

    logger.error('failed', { error });

    const serialized = JSON.stringify(lines()[0]);
    expect(serialized).not.toContain('id_rsa');
    expect(serialized).not.toContain('at Object');
    expect(serialized).toContain('Error');
  });

  it('trunca valores largos', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream });

    logger.info('big', { payload: 'x'.repeat(5000) });

    const payload = lines()[0]?.['payload'];
    expect(typeof payload).toBe('string');
    expect((payload as string).length).toBeLessThan(600);
    expect(payload as string).toContain('[truncated]');
  });

  it('el logger hijo hereda y añade campos', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({ stream, base: { service: 'localbridge-mcp' } });

    logger.child({ requestId: 'req_1' }).info('handling');

    expect(lines()[0]).toMatchObject({ service: 'localbridge-mcp', requestId: 'req_1' });
  });

  it('un fallo del stream no tumba la operación en curso', () => {
    const broken = new Writable({
      write() {
        throw new Error('stream roto');
      },
    });

    const logger = createLogger({ stream: broken });

    expect(() => logger.info('should not throw')).not.toThrow();
  });
});
