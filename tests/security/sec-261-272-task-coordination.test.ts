import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TASK_BATCH_LIMITS, parseBrokerParams, runtimeResourceKey } from '@localbridge/development';

async function source(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), 'utf8');
}

function pathRequest(sourcePath: string) {
  return {
    workspaceId: 'ws_secure', operationId: 'batch_path',
    children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath, parameters: {} }],
  };
}

describe('SEC-261..272 — coordinación acotada de tareas', () => {
  it('SEC-261 task.runMany usa un catálogo cerrado y rechaza campos desconocidos', () => {
    const base = {
      workspaceId: 'ws_secure', operationId: 'batch_secure', failurePolicy: 'continue',
      children: [{ localId: 'hash', operationKind: 'artifact.hash', sourcePath: 'file.bin', parameters: {}, dependsOn: [] }],
    };
    expect(parseBrokerParams('task.runMany', base)).toMatchObject(base);
    expect(() => parseBrokerParams('task.runMany', { ...base, command: 'rm -rf .' })).toThrow();
    expect(() => parseBrokerParams('task.runMany', { ...base, children: [{ ...base.children[0], parameters: { command: 'whoami' } }] })).toThrow();
  });

  it('SEC-262 las rutas del lote siguen siendo relativas y sin traversal', () => {
    expect(() => parseBrokerParams('task.runMany', pathRequest('C:\\secret.bin'))).toThrow();
    expect(() => parseBrokerParams('task.runMany', pathRequest('../secret.bin'))).toThrow();
    expect(() => parseBrokerParams('task.runMany', pathRequest('/etc/passwd'))).toThrow();
  });

  it('SEC-263 fija presupuestos agregados de admisión, respuesta, espera y retención', () => {
    expect(TASK_BATCH_LIMITS).toEqual(expect.objectContaining({
      maxChildrenPerBatch: 24,
      maxNonTerminalBatches: 32,
      maxNonTerminalChildren: 256,
      maxStatusChildren: 20,
      maxConcurrentWaiters: 32,
      maxWaitMs: 20_000,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxRetainedBatches: 512,
    }));
  });

  it('SEC-264 preflight e idempotencia en vuelo preceden al recibo durable y a los efectos', async () => {
    const task = await source('packages/development/src/task-batch-supervisor.ts');
    const runStart = task.indexOf('async runMany(request: TaskBatchRequest)');
    const preflight = task.indexOf('await this.options.preflightBatch?.(request)', runStart);
    const save = task.indexOf('this.save(batch, false)', runStart);
    const dispatch = task.indexOf('this.schedule()', save);
    expect(task).toContain('private readonly admissions = new Map');
    expect(preflight).toBeGreaterThan(runStart);
    expect(save).toBeGreaterThan(preflight);
    expect(dispatch).toBeGreaterThan(save);
  });

  it('SEC-265 el journal conserva huellas y recibos, no parámetros ni resultados', async () => {
    const task = await source('packages/development/src/task-batch-supervisor.ts');
    expect(task).toContain('parameterFingerprint: digest(child.parameters)');
    expect(task).toContain('JSON.stringify(batch)');
    expect(task).not.toContain('parameters: child.parameters');
    expect(task).not.toContain('JSON.stringify(request)');
    expect(task).not.toContain('stdout: result.stdout');
  });

  it('SEC-266 Desktop revalida referencias web y destinos antes de admitir el lote', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const controller = await source('apps/desktop/src/main/web-controller.ts');
    expect(main).toContain('preflightBatch: async (request) =>');
    expect(main).toContain('resolveWriteTarget(workspace.rootPath, sourcePath');
    expect(main).toContain('webController.preflightDownloadReference(');
    expect(controller).toContain('resource.generation !== tab.generation');
  });

  it('SEC-267 validación coordinada reutiliza autoridad, runner y mutex existentes', async () => {
    const main = await source('apps/desktop/src/main/index.ts');
    const validation = await source('packages/validation/src/run-validation.ts');
    expect(main).toContain('requireAuthorizedWorkspace(registryPath, desktopSecurityLogger, workspaceId, "validations")');
    expect(main).toContain('const result = await runValidation(workspace, profile');
    expect(validation).toContain('withMutationLock(validationLockKey(workspace.id)');
    expect(validation).toContain('onLockAcquired');
    expect(validation).toContain('onLockReleased');
  });

  it('SEC-268 captura motion mantiene exclusión global y recursos independientes no comparten clave', () => {
    expect(runtimeResourceKey('browser.motion.capture', { workspaceId: 'ws_a', sessionId: 'session_a' })).toBe('motion-capture:global');
    expect(runtimeResourceKey('web.motion.capture', { sessionId: 'websession_a', tabId: 'webtab_a' })).toBe('motion-capture:global');
    expect(runtimeResourceKey('browser.click', { workspaceId: 'ws_a', sessionId: 'session_a' }))
      .not.toBe(runtimeResourceKey('browser.click', { workspaceId: 'ws_b', sessionId: 'session_b' }));
  });

  it('SEC-269 control humano y cierre no esperan detrás de la cola ordinaria', async () => {
    const coordinator = await source('packages/development/src/runtime-resource-coordinator.ts');
    const handler = await source('packages/development/src/runtime-handler.ts');
    expect(coordinator).toContain('cancelPending(prefix');
    expect(handler).toContain("case 'browser.human.request'");
    expect(handler).toContain("case 'web.human.request'");
    expect(handler).toContain("case 'browser.stop'");
    expect(handler).toContain("case 'web.stop'");
  });

  it('SEC-270 las herramientas previas de análisis conservan su ruta separada', async () => {
    const handler = await source('packages/development/src/runtime-handler.ts');
    expect(handler).toContain("case 'analysis.start'");
    expect(handler).toContain('return options.analysis.start(params as AnalysisJobRequest)');
    expect(handler).toContain("case 'task.runMany'");
  });

  it('SEC-271 los contratos de lote no aceptan roots, permisos ni nivel de confianza', async () => {
    const protocol = await source('packages/development/src/protocol.ts');
    const taskTools = await source('packages/mcp-server/src/tools/task-tools.ts');
    const taskSection = protocol.slice(protocol.indexOf("'task.runMany'"), protocol.indexOf("'terminal.start'"));
    expect(taskSection).not.toMatch(/rootPath|permissions|trust|approval/i);
    expect(taskTools).toContain('This tool does not add permissions');
    expect(taskTools).not.toContain('allowAlways');
  });

  it('SEC-272 revocar workspace solicita cancelación y espera limpieza acotada', async () => {
    const task = await source('packages/development/src/task-batch-supervisor.ts');
    const cancel = task.slice(task.indexOf('async cancelWorkspace('), task.indexOf('private requireBatch('));
    expect(cancel).toContain('this.cancelMany(');
    expect(cancel).toContain('Date.now() + 5_000');
    expect(cancel).toContain('ANALYSIS_CANCEL_TIMEOUT');
  });
});
