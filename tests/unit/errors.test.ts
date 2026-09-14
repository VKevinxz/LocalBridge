import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  LocalBridgeError,
  errorDefinition,
  isLocalBridgeError,
  toErrorPayload,
} from '@localbridge/shared';

describe('modelo de errores', () => {
  it('define todos los códigos de MASTER_SPEC §9', () => {
    // La lista es el contrato: un agente razona sobre estos códigos, así que
    // quitar o renombrar uno rompe a los clientes aunque siga compilando.
    expect(ERROR_CODES).toEqual([
      'WORKSPACE_NOT_FOUND',
      'WORKSPACE_DISABLED',
      'CAPABILITY_DISABLED',
      'PATH_OUTSIDE_WORKSPACE',
      'ABSOLUTE_PATH_FORBIDDEN',
      'SYMLINK_ESCAPE',
      'PATH_DENIED',
      'FILE_NOT_FOUND',
      'FILE_ALREADY_EXISTS',
      'FILE_TOO_LARGE',
      'INSUFFICIENT_DISK_SPACE',
      'NOT_A_FILE',
      'HASH_MISMATCH',
      'GIT_NOT_REPOSITORY',
      'COMMAND_NOT_ALLOWED',
      'TIMEOUT',
      'OUTPUT_TRUNCATED',
      'RATE_LIMITED',
      'INVALID_INPUT',
      'APPROVAL_DECLINED',
      'APPROVAL_INVALID',
      'GIT_PUSH_REJECTED',
      'GIT_PUSH_UNCERTAIN',
      'FEATURE_UNAVAILABLE',
      'PROFILE_NOT_FOUND',
      'PROFILE_SOURCE_MISSING',
      'PROFILE_SOURCE_INVALID',
      'PROFILE_STALE',
      'PROFILE_REVIEW_REQUIRED',
      'PROJECT_NOT_FOUND',
      'PROJECT_REVIEW_REQUIRED',
      'PROJECT_UNAVAILABLE',
      'TERMINAL_NOT_AUTHORIZED',
      'SANDBOX_UNAVAILABLE',
      'TERMINAL_NOT_FOUND',
      'TERMINAL_NOT_RUNNING',
      'TERMINAL_START_FAILED',
      'IDEMPOTENCY_CONFLICT',
      'SETUP_PLAN_STALE',
      'SETUP_TOOLCHAIN_MISSING',
      'SETUP_ALREADY_RUNNING',
      'SETUP_WORKSPACE_BUSY',
      'SETUP_PRIVATE_CONFIG_UNSUPPORTED',
      'SETUP_CANCELLED',
      'SETUP_FAILED',
      'SETUP_INTERRUPTED',
      'TOPOLOGY_REVIEW_REQUIRED',
      'UNSUPPORTED_ECOSYSTEM',
      'APPLICATION_PROFILE_NOT_FOUND',
      'APPLICATION_REVIEW_REQUIRED',
      'APPLICATION_RUN_NOT_FOUND',
      'APPLICATION_START_FAILED',
      'APPLICATION_CLEANUP_FAILED',
      'APPLICATION_SERVICE_MISMATCH',
      'APPLICATION_ORIGIN_CONFLICT',
      'MANAGED_WILDCARD_NOT_APPROVED',
      'LOCALHOST_RESOLUTION_BLOCKED',
      'PROJECT_BROWSER_LISTENER_MISMATCH',
      'PROJECT_BROWSER_ORIGIN_CONFLICT',
      'PROJECT_BROWSER_PRIMARY_UNAVAILABLE',
      'LOCALHOST_ATTESTATION_FAILED',
      'LISTENER_STALE',
      'PROCESS_NOT_FOUND',
      'LISTENER_NOT_FOUND',
      'SESSION_NOT_FOUND',
      'STALE_SNAPSHOT',
      'ELEMENT_NOT_INTERACTABLE',
      'ASSERTION_FAILED',
      'ORIGIN_BLOCKED',
      'SENSITIVE_INPUT_BLOCKED',
      'HUMAN_CONTROL_NOT_ALLOWED',
      'HUMAN_CONTROL_REQUEST_NOT_FOUND',
      'HUMAN_CONTROL_ACTIVE',
      'HUMAN_CONTROL_EXPIRED',
      'HUMAN_CONTROL_DECLINED',
      'HUMAN_CONTROL_BUSY',
      'WEB_SESSION_NOT_FOUND',
      'WEB_TAB_NOT_FOUND',
      'WEB_DESTINATION_BLOCKED',
      'WEB_NAVIGATION_FAILED',
      'WEB_CAPTURE_FAILED',
      'WEB_CAPTURE_TOO_LARGE',
      'WEB_EFFECT_UNCERTAIN',
      'MOTION_CAPTURE_UNAVAILABLE',
      'MOTION_CAPTURE_INTERRUPTED',
      'MOTION_EFFECT_UNCERTAIN',
      'MOTION_LIMIT_EXCEEDED',
      'MOTION_BUNDLE_INVALID',
      'MOTION_BUNDLES_INCOMPATIBLE',
      'WEB_RESOURCE_NOT_FOUND',
      'WEB_DOWNLOAD_BLOCKED',
      'WEB_DOWNLOAD_QUOTA_EXCEEDED',
      'WEB_MEDIA_TYPE_UNSUPPORTED',
      'WEB_MEDIA_TYPE_MISMATCH',
      'WEB_DOWNLOAD_EMPTY',
      'HUMAN_ACTION_REQUIRED',
      'DOCUMENT_UNSUPPORTED',
      'DOCUMENT_NO_TEXT',
      'DOCUMENT_RENDER_FAILED',
      'DOCUMENT_RENDER_TOO_LARGE',
      'IMAGE_UNSUPPORTED',
      'IMAGE_TOO_LARGE',
      'ANALYSIS_JOB_NOT_FOUND',
      'ANALYSIS_QUEUE_FULL',
      'ANALYSIS_CANCELLED',
      'ANALYSIS_INTERRUPTED',
      'ANALYSIS_FAILED',
      'INTERNAL_ERROR',
    ]);
  });

  it('cada código tiene un mensaje no vacío', () => {
    for (const code of ERROR_CODES) {
      expect(errorDefinition(code).message.length).toBeGreaterThan(0);
    }
  });

  it('construye un error con su código y su recuperabilidad', () => {
    const error = new LocalBridgeError('HASH_MISMATCH');

    expect(isLocalBridgeError(error)).toBe(true);
    expect(error.code).toBe('HASH_MISMATCH');
    expect(error.recoverable).toBe(true);
    expect(error).toBeInstanceOf(Error);
  });

  it('serializa un error de dominio a su payload estable', () => {
    const payload = toErrorPayload(new LocalBridgeError('CAPABILITY_DISABLED'));

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('CAPABILITY_DISABLED');
    expect(payload.error.recoverable).toBe(false);
  });

  it('HASH_MISMATCH indica el camino de recuperación', () => {
    // TOOL_CATALOG §7: el error debe decir qué hacer, no sólo qué falló.
    const { message } = errorDefinition('HASH_MISMATCH');

    expect(message.toLowerCase()).toContain('re-read');
    expect(message.toLowerCase()).toContain('retry');
  });

  it('colapsa un error desconocido a INTERNAL_ERROR sin filtrar nada', () => {
    // SECURITY.md amenaza L: ni rutas absolutas, ni stack traces, ni contenido.
    const leaky = new Error('ENOENT: open D:\\Users\\example-user\\.ssh\\id_rsa failed');
    const payload = toErrorPayload(leaky);

    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.error.message).not.toContain('id_rsa');
    expect(payload.error.message).not.toContain('D:\\');
    expect(JSON.stringify(payload)).not.toContain('id_rsa');
  });

  it('no propaga los details al cliente', () => {
    // `details` es para logs y auditoría; no puede cruzar la frontera MCP.
    const error = new LocalBridgeError('PATH_OUTSIDE_WORKSPACE', {
      absolutePath: 'D:\\Proyectos\\secreto\\.env',
    });

    expect(JSON.stringify(toErrorPayload(error))).not.toContain('secreto');
  });

  it('propaga únicamente un causeCode perteneciente al catálogo estable', () => {
    const safe = toErrorPayload(new LocalBridgeError('MOTION_EFFECT_UNCERTAIN', {
      causeCode: 'FILE_TOO_LARGE',
      absolutePath: 'D:\\privado\\frame.png',
    }));
    const unsafe = toErrorPayload(new LocalBridgeError('MOTION_EFFECT_UNCERTAIN', {
      causeCode: 'D:\\privado\\frame.png',
    }));

    expect(safe.error.causeCode).toBe('FILE_TOO_LARGE');
    expect(JSON.stringify(safe)).not.toContain('privado');
    expect(unsafe.error).not.toHaveProperty('causeCode');
  });

  it('expone solo metadata cerrada para recuperar un RATE_LIMITED', () => {
    const safe = toErrorPayload(new LocalBridgeError('RATE_LIMITED', {
      rateLimit: {
        resource: 'local-browser-sessions', scope: 'global', capacity: 4,
        recoveryTool: 'browser.list', action: 'list-and-reuse',
      },
      privatePath: 'D:\\privado\\sesiones.json',
    }));
    const unsafe = toErrorPayload(new LocalBridgeError('RATE_LIMITED', {
      rateLimit: {
        resource: 'D:\\privado', scope: 'global', capacity: 4,
        recoveryTool: 'browser.list', action: 'list-and-reuse',
      },
    }));

    expect(safe.error.rateLimit).toEqual({
      resource: 'local-browser-sessions', scope: 'global', capacity: 4,
      recoveryTool: 'browser.list', action: 'list-and-reuse',
    });
    expect(JSON.stringify(safe)).not.toContain('privado');
    expect(unsafe.error).not.toHaveProperty('rateLimit');
  });

  it('colapsa valores lanzados que no son Error', () => {
    expect(toErrorPayload('boom').error.code).toBe('INTERNAL_ERROR');
    expect(toErrorPayload(undefined).error.code).toBe('INTERNAL_ERROR');
  });
});
