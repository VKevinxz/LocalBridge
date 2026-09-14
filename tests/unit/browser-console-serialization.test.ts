import { describe, expect, it } from 'vitest';

import { serializeBrowserConsoleArguments } from '../../apps/desktop/src/main/browser-console-serialization.js';

describe('serialización acotada de consola del navegador', () => {
  it('conserva estructura, ciclos, BigInt y accessors sin ejecutar getters', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const descriptors = new Map<string, unknown>([
      ['root', { result: [
        { name: 'nested', isOwn: true, value: { type: 'object', objectId: 'child', className: 'Object', description: 'Object' } },
        { name: 'danger', isOwn: true, get: { type: 'function', objectId: 'getter', description: 'get danger()' } },
        { name: 'huge', isOwn: true, value: { type: 'bigint', unserializableValue: '9007199254740993n' } },
      ] }],
      ['child', { result: [
        { name: 'parent', isOwn: true, value: { type: 'object', objectId: 'root_alias', className: 'Object', description: 'Object' } },
      ] }],
    ]);
    const result = await serializeBrowserConsoleArguments([
      { type: 'object', objectId: 'root', className: 'Proxy', description: 'Proxy(Object)' },
      { type: 'object', subtype: 'error', objectId: 'error', className: 'Error', description: 'Error: fixture' },
    ], async (method, params) => {
      calls.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: params?.['objectId'] === 'root' && (params?.['arguments'] as Array<{ objectId?: string }> | undefined)?.[0]?.objectId === 'root_alias' } };
      }
      if (method === 'Runtime.getProperties') return descriptors.get(String(params?.['objectId'])) ?? { result: [] };
      return {};
    });

    expect(result.arguments[0]).toMatchObject({
      kind: 'object', className: 'Proxy',
      properties: [
        { name: 'nested', kind: 'value', value: { kind: 'object', properties: [{ name: 'parent', value: { kind: 'reference', ref: 'object_1' } }] } },
        { name: 'danger', kind: 'accessor' },
        { name: 'huge', kind: 'value', value: { kind: 'primitive', type: 'bigint', value: '9007199254740993n' } },
      ],
    });
    expect(result.arguments[1]).toMatchObject({ kind: 'object', subtype: 'error', className: 'Error', description: 'Error: fixture' });
    expect(calls.filter((call) => call.method === 'Runtime.getProperties').map((call) => call.params?.['objectId'])).toEqual(['root', 'child', 'error']);
    expect(calls.some((call) => call.params?.['objectId'] === 'getter')).toBe(false);
    expect(calls.every((call) => ['Runtime.getProperties', 'Runtime.callFunctionOn', 'Runtime.releaseObject'].includes(call.method))).toBe(true);
  });

  it('declara truncamiento por cantidad y tamaño sin materializar argumentos ilimitados', async () => {
    const result = await serializeBrowserConsoleArguments(
      Array.from({ length: 20 }, (_, index) => ({ type: 'string', value: `${index}:${'x'.repeat(4_000)}` })),
      async () => ({}),
    );
    expect(result.truncated).toBe(true);
    expect(result.arguments.length).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32 * 1024);
    expect(result.arguments[0]).toMatchObject({ kind: 'primitive', type: 'string', truncated: true });
  });
});
