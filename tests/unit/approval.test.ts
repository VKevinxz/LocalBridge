import { randomBytes } from 'node:crypto';
import { createRequestStateCodec, isInputRequiredResult, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { approvalRequestId, hashApprovalContent, resolveApproval, type ApprovalPayload } from '../../packages/mcp-server/src/approval.js';
import { isLocalBridgeError } from '@localbridge/shared';

function fakeCtx(overrides: Partial<{ inputResponses: Record<string, unknown>; requestState: unknown }>): ServerContext {
  const requestStateValue = overrides.requestState;
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      inputResponses: overrides.inputResponses,
      requestState: (<T = unknown>() => requestStateValue as T | undefined) as ServerContext['mcpReq']['requestState'],
      signal: new AbortController().signal,
      send: (() => {
        throw new Error('not implemented in test fake');
      }) as unknown as ServerContext['mcpReq']['send'],
      notify: async () => {},
      log: async () => {},
      elicitInput: (() => {
        throw new Error('not implemented in test fake');
      }) as unknown as ServerContext['mcpReq']['elicitInput'],
      requestSampling: (() => {
        throw new Error('not implemented in test fake');
      }) as unknown as ServerContext['mcpReq']['requestSampling'],
    },
  } as ServerContext;
}

function newCodec(overrides: Partial<{ ttlSeconds: number }> = {}): RequestStateCodec<ApprovalPayload> {
  return createRequestStateCodec<ApprovalPayload>({ key: randomBytes(32), ttlSeconds: overrides.ttlSeconds ?? 300 });
}

const BASE_REQUEST = {
  action: 'git.commit',
  workspaceId: 'ws_abc123',
  contentHash: hashApprovalContent('mensaje del commit', 'archivo-a.ts\0archivo-b.ts'),
  message: 'Se va a crear el commit "mensaje del commit" con 2 archivos.',
};

describe('hashApprovalContent', () => {
  it('es determinista para las mismas partes', () => {
    expect(hashApprovalContent('a', 'b')).toBe(hashApprovalContent('a', 'b'));
  });

  it('usa NUL como separador: "a b","c" no colisiona con "a","b c"', () => {
    expect(hashApprovalContent('a b', 'c')).not.toBe(hashApprovalContent('a', 'b c'));
  });

  it('produce un hash distinto si cambia cualquier parte', () => {
    expect(hashApprovalContent('mensaje 1', 'x.ts')).not.toBe(hashApprovalContent('mensaje 2', 'x.ts'));
  });
});

describe('approvalRequestId', () => {
  it('deduplica dentro de una instancia y separa procesos MCP concurrentes', () => {
    const contentHash = hashApprovalContent('mensaje', 'tree');
    expect(approvalRequestId('instance-a', 'git.commit', 'ws_a', contentHash)).toBe(
      approvalRequestId('instance-a', 'git.commit', 'ws_a', contentHash),
    );
    expect(approvalRequestId('instance-a', 'git.commit', 'ws_a', contentHash)).not.toBe(
      approvalRequestId('instance-b', 'git.commit', 'ws_a', contentHash),
    );
  });
});

describe('resolveApproval — primera ronda (sin aprobación todavía)', () => {
  it('devuelve un InputRequiredResult real pidiendo confirmación', async () => {
    const codec = newCodec();
    const ctx = fakeCtx({});

    const result = await resolveApproval(ctx, codec, BASE_REQUEST);

    expect(result.approved).toBe(false);
    if (result.approved) throw new Error('unreachable');
    expect(isInputRequiredResult(result.ask)).toBe(true);
    expect(typeof result.ask.requestState).toBe('string');
    expect(result.ask.inputRequests?.confirm).toBeDefined();
  });

  it('el requestState minted es verificable por el mismo codec y contiene el payload correcto', async () => {
    const codec = newCodec();
    const ctx = fakeCtx({});

    const result = await resolveApproval(ctx, codec, BASE_REQUEST);
    if (result.approved) throw new Error('unreachable');

    const verifyCtx = fakeCtx({});
    const payload = await codec.verify(result.ask.requestState as string, verifyCtx);

    expect(payload).toEqual({
      action: BASE_REQUEST.action,
      workspaceId: BASE_REQUEST.workspaceId,
      contentHash: BASE_REQUEST.contentHash,
    });
  });
});

describe('resolveApproval — segunda ronda, aprobación completa (round-trip real)', () => {
  async function mintThenEcho(codec: RequestStateCodec<ApprovalPayload>, confirm: boolean) {
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');

    const verifiedPayload = await codec.verify(first.ask.requestState as string, fakeCtx({}));
    return fakeCtx({
      inputResponses: { confirm: { action: 'accept', content: { confirm } } },
      requestState: verifiedPayload,
    });
  }

  it('confirm:true con la misma operación exacta → approved:true', async () => {
    const codec = newCodec();
    const echoedCtx = await mintThenEcho(codec, true);

    const second = await resolveApproval(echoedCtx, codec, BASE_REQUEST);

    expect(second).toEqual({ approved: true });
  });

  it('confirm:false → lanza APPROVAL_DECLINED, no ejecuta nada', async () => {
    const codec = newCodec();
    const echoedCtx = await mintThenEcho(codec, false);

    try {
      await resolveApproval(echoedCtx, codec, BASE_REQUEST);
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('APPROVAL_DECLINED');
    }
  });
});

describe('resolveApproval — un token no puede reutilizarse para otra operación (gate de ADR-0016)', () => {
  it('un token válido minted para un commit no aprueba un commit con distinto mensaje/contenido', async () => {
    const codec = newCodec();
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');
    const verifiedPayload = await codec.verify(first.ask.requestState as string, fakeCtx({}));

    const echoedCtx = fakeCtx({
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: verifiedPayload,
    });

    const differentRequest = {
      ...BASE_REQUEST,
      contentHash: hashApprovalContent('un mensaje totalmente distinto', 'otro-archivo.ts'),
    };

    try {
      await resolveApproval(echoedCtx, codec, differentRequest);
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('APPROVAL_INVALID');
    }
  });

  it('un token válido para git.commit no aprueba un git.push del mismo workspace', async () => {
    const codec = newCodec();
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');
    const verifiedPayload = await codec.verify(first.ask.requestState as string, fakeCtx({}));

    const echoedCtx = fakeCtx({
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: verifiedPayload,
    });

    const pushRequest = { ...BASE_REQUEST, action: 'git.push' };

    try {
      await resolveApproval(echoedCtx, codec, pushRequest);
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('APPROVAL_INVALID');
    }
  });

  it('un token válido de un workspace no aprueba la misma operación en otro workspace', async () => {
    const codec = newCodec();
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');
    const verifiedPayload = await codec.verify(first.ask.requestState as string, fakeCtx({}));

    const echoedCtx = fakeCtx({
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: verifiedPayload,
    });

    const otherWorkspaceRequest = { ...BASE_REQUEST, workspaceId: 'ws_other999' };

    try {
      await resolveApproval(echoedCtx, codec, otherWorkspaceRequest);
      expect.unreachable();
    } catch (error) {
      expect(isLocalBridgeError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('APPROVAL_INVALID');
    }
  });
});

describe('resolveApproval — expiración y manipulación se rechazan en el propio codec (antes de que el handler decida nada)', () => {
  it('un requestState expirado no verifica: el SDK lo rechazaría con -32602 antes del handler', async () => {
    const codec = newCodec({ ttlSeconds: -1 });
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');

    await expect(codec.verify(first.ask.requestState as string, fakeCtx({}))).rejects.toThrow();
  });

  it('un requestState con la firma alterada no verifica (tamper-detection)', async () => {
    const codec = newCodec();
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');

    const original = first.ask.requestState as string;
    const tampered = original.slice(0, -4) + (original.endsWith('AAAA') ? 'BBBB' : 'AAAA');

    await expect(codec.verify(tampered, fakeCtx({}))).rejects.toThrow();
  });

  it('un requestState firmado por OTRO proceso (otra clave) no verifica', async () => {
    const codecA = newCodec();
    const codecB = newCodec();

    const first = await resolveApproval(fakeCtx({}), codecA, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');

    await expect(codecB.verify(first.ask.requestState as string, fakeCtx({}))).rejects.toThrow();
  });

  it('un requestState con contenido decodificable pero corrupto (JSON roto tras editar el body) no verifica', async () => {
    const codec = newCodec();
    const first = await resolveApproval(fakeCtx({}), codec, BASE_REQUEST);
    if (first.approved) throw new Error('unreachable');

    const original = first.ask.requestState as string;
    const [prefix, body, mac] = original.split('.');
    expect([prefix, body, mac].every((part) => part !== undefined)).toBe(true);
    // Corrompe el cuerpo (payload) sin tocar la MAC: debe fallar por MAC inválida.
    const corruptedBody = `${body!.slice(0, -2)}zz`;
    const tampered = [prefix, corruptedBody, mac].join('.');

    await expect(codec.verify(tampered, fakeCtx({}))).rejects.toThrow();
  });
});
