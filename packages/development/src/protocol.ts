import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export const DEVELOPMENT_BROKER_PROTOCOL = 22 as const;
export const MAX_BROKER_FRAME_BYTES = 4 * 1024 * 1024;
export const BROKER_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const BROKER_ID_PATTERN = /^[a-f0-9]{32}$/;

const opaqueIdSchema = z.string().regex(/^[a-z]+_[a-f0-9]{16,32}$/);
const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,128}$/);
const profileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{16,32}$/);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{16,32}$/);
const operationIdSchema = z.string().min(1).max(128).optional();
const cursorSchema = z.number().int().nonnegative().default(0);
const humanReasonSchema = z.enum(['sign_in', 'file_selection', 'manual_step']);
const projectIdSchema = z.string().regex(/^project_[a-f0-9]{24}$/);
const terminalIdSchema = z.string().regex(/^terminal_[a-f0-9]{24}$/);
const webProfileIdSchema = z.string().regex(/^webprofile_[a-f0-9]{24}$/);
const webSessionIdSchema = z.string().regex(/^websession_[a-f0-9]{24}$/);
const webTabIdSchema = z.string().regex(/^webtab_[a-f0-9]{24}$/);
const webSnapshotIdSchema = z.string().regex(/^websnapshot_[a-f0-9]{20}$/);
const webElementRefSchema = z.string().regex(/^webelement_[a-f0-9]{20}$/);
const webResourceRefSchema = z.string().regex(/^webresource_[a-f0-9]{20}$/);
const browserSessionIdSchema = z.string().regex(/^session_[a-f0-9]{24}$/);
const analysisJobIdSchema = z.string().regex(/^job_[a-f0-9]{24}$/);
const analysisOperationIdSchema = z.string().min(1).max(128);
const taskBatchIdSchema = z.string().regex(/^batch_[a-f0-9]{24}$/);
const taskLocalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const BROWSER_INSPECTABLE_CSS_PROPERTIES = [
  'background-color', 'border-bottom-color', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-bottom-width', 'border-left-color', 'border-left-width', 'border-right-color', 'border-right-width',
  'border-top-color', 'border-top-left-radius', 'border-top-right-radius', 'border-top-width', 'box-shadow',
  'color', 'display', 'font-family', 'font-size', 'font-style', 'font-weight', 'height', 'letter-spacing',
  'line-height', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'opacity', 'padding-bottom',
  'padding-left', 'padding-right', 'padding-top', 'position', 'text-align', 'text-decoration-line',
  'text-transform', 'transform', 'transition-delay', 'transition-duration', 'transition-property',
  'visibility', 'width', 'z-index',
] as const;
export const BROWSER_KEY_ALLOWLIST = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
const relativePathSchema = z.string().min(1).max(4096).refine((value) =>
  !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), "se requiere una ruta relativa").refine((value) =>
  !value.split(/[\\/]/).includes('..'), 'no se permite traversal');
const publicHttpsUrlSchema = z.string().min(1).max(4096).url().refine((value) => value.startsWith('https://'), 'se requiere HTTPS');
const terminalListenerSchema = z.object({
  terminalSessionId: terminalIdSchema,
  listenerRef: opaqueIdSchema,
}).strict();

const analysisStartParamsSchema = z.discriminatedUnion('operationKind', [
  z.object({
    operationKind: z.literal('artifact.inspect'), workspaceId: workspaceIdSchema,
    sourcePath: relativePathSchema, operationId: analysisOperationIdSchema, parameters: z.object({}).strict(),
  }).strict(),
  z.object({
    operationKind: z.literal('artifact.hash'), workspaceId: workspaceIdSchema,
    sourcePath: relativePathSchema, operationId: analysisOperationIdSchema, parameters: z.object({}).strict(),
  }).strict(),
  z.object({
    operationKind: z.literal('artifact.text.read'), workspaceId: workspaceIdSchema,
    sourcePath: relativePathSchema, operationId: analysisOperationIdSchema,
    parameters: z.object({ cursor: z.string().max(512).optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict(),
  }).strict(),
  z.object({
    operationKind: z.literal('binary.inspect'), workspaceId: workspaceIdSchema,
    sourcePath: relativePathSchema, operationId: analysisOperationIdSchema,
    parameters: z.object({ depth: z.enum(['quick', 'standard', 'deep']).default('standard') }).strict(),
  }).strict(),
  z.object({
    operationKind: z.literal('document.process'), workspaceId: workspaceIdSchema,
    sourcePath: relativePathSchema, operationId: analysisOperationIdSchema,
    parameters: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('read'), startPage: z.number().int().min(1).optional(), endPage: z.number().int().min(1).optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict(),
      z.object({ mode: z.literal('render'), pages: z.array(z.number().int().min(1)).min(1).max(4), detail: z.enum(['standard', 'high']).default('standard') }).strict(),
    ]),
  }).strict(),
  z.object({
    operationKind: z.literal('web.download.start'), workspaceId: workspaceIdSchema,
    sourcePath: relativePathSchema, operationId: analysisOperationIdSchema,
    parameters: z.object({ sessionId: webSessionIdSchema, tabId: webTabIdSchema, resourceRef: webResourceRefSchema }).strict(),
  }).strict(),
]);

const taskChildDependencyFields = {
  localId: taskLocalIdSchema,
  dependsOn: z.array(taskLocalIdSchema).max(24).default([]),
} as const;
const taskChildSchema = z.discriminatedUnion('operationKind', [
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('artifact.inspect'), sourcePath: relativePathSchema, parameters: z.object({}).strict() }).strict(),
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('artifact.hash'), sourcePath: relativePathSchema, parameters: z.object({}).strict() }).strict(),
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('artifact.text.read'), sourcePath: relativePathSchema,
    parameters: z.object({ cursor: z.string().max(512).optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict() }).strict(),
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('binary.inspect'), sourcePath: relativePathSchema,
    parameters: z.object({ depth: z.enum(['quick', 'standard', 'deep']).default('standard') }).strict() }).strict(),
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('document.process'), sourcePath: relativePathSchema,
    parameters: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('read'), startPage: z.number().int().min(1).optional(), endPage: z.number().int().min(1).optional(), maxChars: z.number().int().min(1_000).max(200_000).default(50_000) }).strict(),
      z.object({ mode: z.literal('render'), pages: z.array(z.number().int().min(1)).min(1).max(4), detail: z.enum(['standard', 'high']).default('standard') }).strict(),
    ]) }).strict(),
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('web.download.start'), sourcePath: relativePathSchema,
    parameters: z.object({ sessionId: webSessionIdSchema, tabId: webTabIdSchema, resourceRef: webResourceRefSchema }).strict() }).strict(),
  z.object({ ...taskChildDependencyFields, operationKind: z.literal('validation.run'),
    parameters: z.object({ profile: profileNameSchema }).strict() }).strict(),
]);

const workspaceParams = z.object({ workspaceId: workspaceIdSchema }).strict();
const processIdParams = workspaceParams.extend({ processId: opaqueIdSchema }).strict();
const sessionIdParams = workspaceParams.extend({ sessionId: opaqueIdSchema }).strict();
const snapshotElementParams = sessionIdParams.extend({ snapshotId: opaqueIdSchema, elementRef: opaqueIdSchema }).strict();
const inspectionFields = {
  target: z.enum(['element', 'active']).default('element'),
  snapshotId: opaqueIdSchema.optional(),
  elementRef: opaqueIdSchema.optional(),
  cssProperties: z.array(z.enum(BROWSER_INSPECTABLE_CSS_PROPERTIES)).max(32)
    .default(['color', 'background-color', 'font-family', 'font-size', 'font-weight']),
  cssVariables: z.array(z.string().regex(/^--[A-Za-z0-9_-]{1,126}$/)).max(16).default([]),
} as const;
const browserAssertionConditionSchemas = [
  z.object({ kind: z.literal('path'), value: z.string().min(1).max(2048), operator: z.enum(['equals', 'contains']).default('equals') }).strict(),
  z.object({ kind: z.literal('title'), value: z.string().min(1).max(256), operator: z.enum(['equals', 'contains']).default('equals') }).strict(),
  z.object({ kind: z.literal('text'), value: z.string().min(1).max(512), state: z.enum(['present', 'absent']).default('present') }).strict(),
  z.object({ kind: z.literal('element'), snapshotId: opaqueIdSchema, elementRef: opaqueIdSchema, state: z.enum(['attached', 'visible', 'enabled', 'checked', 'selected']), expected: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('response'), path: z.string().min(1).max(2048).regex(/^\/(?!\/)/), status: z.number().int().min(100).max(599).optional(), afterCursor: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ kind: z.literal('no-console-errors'), afterCursor: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ kind: z.literal('dialog'), state: z.enum(['open', 'closed']) }).strict(),
] as const;
const browserAssertionConditionSchema = z.discriminatedUnion('kind', browserAssertionConditionSchemas);
const browserWaitConditionSchema = z.discriminatedUnion('kind', [
  ...browserAssertionConditionSchemas,
  z.object({ kind: z.literal('stable'), snapshotId: opaqueIdSchema, elementRef: opaqueIdSchema,
    intervalMs: z.number().int().min(100).max(2_000).default(300), tolerancePx: z.number().min(0).max(5).default(0.5) }).strict(),
]);
const actionCaptureWaitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delay'), settleMs: z.number().int().min(0).max(5_000).default(300) }).strict(),
  z.object({ kind: z.literal('stable'), intervalMs: z.number().int().min(100).max(2_000).default(300),
    tolerancePx: z.number().min(0).max(5).default(0.5), timeoutMs: z.number().int().min(100).max(5_000).default(2_000),
    allowUnstable: z.boolean().default(false) }).strict(),
]);
const browserActionCaptureOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline') }).strict(),
  z.object({ kind: z.literal('save'), workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
]);
const browserStartParams = z.union([
  workspaceParams.extend({ profile: profileNameSchema, operationId: operationIdSchema }).strict(),
  processIdParams.extend({ listenerRef: opaqueIdSchema, operationId: operationIdSchema }).strict(),
  workspaceParams.extend({
    application: profileNameSchema,
    listeners: z.array(z.object({
      service: profileNameSchema,
      processId: opaqueIdSchema,
      listenerRef: opaqueIdSchema,
    }).strict()).min(1).max(8),
    operationId: operationIdSchema,
  }).strict(),
  workspaceParams.extend({
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    operationId: operationIdSchema,
  }).strict(),
  workspaceParams.extend({
    projectId: projectIdSchema,
    terminalSessionId: terminalIdSchema,
    listenerRef: opaqueIdSchema,
    relatedListeners: z.array(terminalListenerSchema).min(1).max(7).optional(),
    operationId: operationIdSchema,
  }).strict(),
]);

const webSessionParams = z.object({ sessionId: webSessionIdSchema }).strict();
const webTabParams = webSessionParams.extend({ tabId: webTabIdSchema }).strict();
const webElementParams = webTabParams.extend({ snapshotId: webSnapshotIdSchema, elementRef: webElementRefSchema }).strict();
const webWaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('load') }).strict(),
  z.object({ kind: z.literal('url'), value: z.string().min(1).max(4096), operator: z.enum(['equals', 'contains']).default('equals') }).strict(),
  z.object({ kind: z.literal('title'), value: z.string().min(1).max(256), operator: z.enum(['equals', 'contains']).default('contains') }).strict(),
  z.object({ kind: z.literal('text'), value: z.string().min(1).max(512), state: z.enum(['present', 'absent']).default('present') }).strict(),
  z.object({ kind: z.literal('stable'), snapshotId: webSnapshotIdSchema, elementRef: webElementRefSchema,
    intervalMs: z.number().int().min(100).max(2_000).default(300), tolerancePx: z.number().min(0).max(5).default(0.5) }).strict(),
]);
const motionTrajectorySchema = z.object({
  axis: z.literal('y'),
  startY: z.number().int().min(0).max(10_000_000),
  distancePx: z.number().int().min(-20_000).max(20_000).refine((value) => value !== 0, 'distancePx debe ser distinto de cero'),
  durationMs: z.number().int().min(250).max(10_000),
  sampleCount: z.number().int().min(3).max(24).default(12),
}).strict();
const motionCaptureFields = {
  path: relativePathSchema.refine((value) => value.toLowerCase().endsWith('.lbmotion'), 'se requiere un destino .lbmotion'),
  operationId: z.string().min(1).max(128),
  trajectory: motionTrajectorySchema,
  settleBeforeMs: z.number().int().min(0).max(3_000).default(500),
  captureMode: z.enum(['auto', 'stepped', 'screencast']).default('auto'),
} as const;

const webViewportSummarySchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
  mobile: z.boolean(),
}).strict();
/**
 * Contrato único para las respuestas de pestañas web. El escritorio y el
 * servidor MCP comparten este esquema para que agregar estado del visor o de
 * motion no convierta una operación válida en INTERNAL_ERROR.
 */
export const webTabSummarySchema = z.object({
  tabId: webTabIdSchema,
  title: z.string().max(256),
  url: z.string().max(4096),
  state: z.enum(['ready', 'loading', 'failed', 'closed']),
  openedAt: z.iso.datetime(),
  viewport: webViewportSummarySchema,
  blockedNativeDownloads: z.number().int().nonnegative(),
  blockedFileChoosers: z.number().int().nonnegative(),
  blockedDialogs: z.number().int().nonnegative(),
  motionCapture: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    mode: z.enum(['auto', 'stepped', 'screencast']),
  }).strict().optional(),
  lastMotionCapture: z.object({
    path: relativePathSchema,
    frameCount: z.number().int().positive(),
    totalSize: z.number().int().positive(),
    captureMode: z.enum(['stepped', 'screencast']),
    warnings: z.array(z.string().max(512)).max(24).readonly(),
  }).strict().optional(),
  viewerPresentation: z.object({
    mode: z.enum(['fit', 'actual']),
    renderWidth: z.number().int().positive(),
    renderHeight: z.number().int().positive(),
    viewWidth: z.number().int().positive(),
    viewHeight: z.number().int().positive(),
    scale: z.number().positive().max(16),
    panX: z.number().int(),
    panY: z.number().int(),
  }).strict().optional(),
}).strict();

export type WebTabSummary = z.infer<typeof webTabSummarySchema>;

export const brokerMethodSchemas = {
  'broker.ping': z.object({}).strict(),
  'project.list': z.object({}).strict(),
  'project.setup.status': z.object({ projectId: projectIdSchema }).strict(),
  'project.setup.refresh': z.object({ projectId: projectIdSchema }).strict(),
  'analysis.start': analysisStartParamsSchema,
  'analysis.list': z.object({ workspaceId: workspaceIdSchema, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  'analysis.status': z.object({ workspaceId: workspaceIdSchema, jobId: analysisJobIdSchema, cursor: z.number().int().nonnegative().default(0), maxItems: z.number().int().min(1).max(20).default(10) }).strict(),
  'analysis.cancel': z.object({ workspaceId: workspaceIdSchema, jobId: analysisJobIdSchema }).strict(),
  'task.runMany': z.object({
    workspaceId: workspaceIdSchema,
    operationId: analysisOperationIdSchema,
    children: z.array(taskChildSchema).min(1).max(24),
    failurePolicy: z.enum(['continue', 'cancel_remaining']).default('continue'),
  }).strict(),
  'task.list': z.object({ workspaceId: workspaceIdSchema, cursor: cursorSchema, limit: z.number().int().min(1).max(50).default(20) }).strict(),
  'task.statusMany': z.object({ workspaceId: workspaceIdSchema, batchId: taskBatchIdSchema,
    localIds: z.array(taskLocalIdSchema).min(1).max(24).optional(), cursor: cursorSchema,
    limit: z.number().int().min(1).max(20).default(20) }).strict(),
  'task.waitMany': z.object({ workspaceId: workspaceIdSchema, batchId: taskBatchIdSchema,
    afterRevision: z.number().int().nonnegative(), condition: z.enum(['changed', 'all_finished']).default('changed'),
    waitMs: z.number().int().min(0).max(20_000).default(10_000) }).strict(),
  'task.cancelMany': z.object({ workspaceId: workspaceIdSchema, batchId: taskBatchIdSchema,
    localIds: z.array(taskLocalIdSchema).min(1).max(24).optional(), operationId: analysisOperationIdSchema }).strict(),
  'terminal.start': z.object({ projectId: projectIdSchema, operationId: operationIdSchema }).strict(),
  'terminal.list': z.object({ projectId: projectIdSchema }).strict(),
  'terminal.write': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema, text: z.string().min(1).max(65_536), operationId: operationIdSchema }).strict(),
  'terminal.read': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema, cursor: cursorSchema, maxBytes: z.number().int().min(1).max(65_536).default(65_536), waitMs: z.number().int().min(0).max(20_000).default(0) }).strict(),
  'terminal.status': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema }).strict(),
  'terminal.stop': z.object({ projectId: projectIdSchema, sessionId: terminalIdSchema, operationId: operationIdSchema }).strict(),
  'application.start': z.object({ applicationId: applicationIdSchema, operationId: operationIdSchema }).strict(),
  'application.status': z.object({ runId: runIdSchema }).strict(),
  'application.stop': z.object({ runId: runIdSchema, operationId: operationIdSchema }).strict(),
  'process.start': workspaceParams.extend({ profile: profileNameSchema, operationId: operationIdSchema }).strict(),
  'process.list': workspaceParams,
  'process.listeners': processIdParams,
  'process.logs': processIdParams.extend({ cursor: cursorSchema, maxBytes: z.number().int().min(1).max(65_536).default(65_536) }).strict(),
  'process.stop': processIdParams.extend({ operationId: operationIdSchema }).strict(),
  'browser.start': browserStartParams,
  'browser.list': workspaceParams,
  'browser.navigate': sessionIdParams.extend({ path: z.string().min(1).max(2048), operationId: operationIdSchema }).strict(),
  'browser.reload': sessionIdParams.extend({ mode: z.enum(['normal', 'ignore-cache']).default('normal'), operationId: z.string().min(1).max(128) }).strict(),
  'browser.snapshot': sessionIdParams.extend({ maxDepth: z.number().int().min(1).max(20).default(12), maxElements: z.number().int().min(1).max(1000).default(500) }).strict(),
  'browser.screenshot': sessionIdParams.extend({ settleMs: z.number().int().min(0).max(3_000).default(0) }).strict(),
  'browser.screenshot.save': sessionIdParams.extend({ path: relativePathSchema, settleMs: z.number().int().min(0).max(3_000).default(0), operationId: z.string().min(1).max(128) }).strict(),
  'browser.motion.inspect': workspaceParams.extend({ sessionId: browserSessionIdSchema, maxAnimations: z.number().int().min(1).max(100).default(100) }).strict(),
  'browser.motion.capture': workspaceParams.extend({ sessionId: browserSessionIdSchema, ...motionCaptureFields }).strict(),
  // Emulación de viewport para probar diseño responsive (ADR-0042). Dimensiones
  // acotadas; no acepta escala, agente de usuario, URL ni selectores.
  'browser.viewport': sessionIdParams.extend({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(320).max(2160),
    mobile: z.boolean().default(false),
    operationId: operationIdSchema,
  }).strict(),
  'browser.events': sessionIdParams.extend({ cursor: cursorSchema, maxBytes: z.number().int().min(1).max(65_536).default(65_536), scope: z.enum(['history', 'current-navigation']).default('history') }).strict(),
  'browser.inspect': sessionIdParams.extend(inspectionFields).strict().superRefine((value, context) => {
    if (value.target === 'element' && (value.snapshotId === undefined || value.elementRef === undefined)) {
      context.addIssue({ code: 'custom', message: 'snapshotId and elementRef are required for target element' });
    }
  }),
  'browser.assert': sessionIdParams.extend({ condition: browserAssertionConditionSchema }).strict(),
  'browser.wait': sessionIdParams.extend({ condition: browserWaitConditionSchema, timeoutMs: z.number().int().min(100).max(30_000).default(5_000) }).strict(),
  'browser.click': snapshotElementParams.extend({ operationId: operationIdSchema }).strict(),
  'browser.fill': snapshotElementParams.extend({ text: z.string().max(8192), operationId: operationIdSchema }).strict(),
  'browser.hover': snapshotElementParams.extend({ operationId: operationIdSchema }).strict(),
  'browser.press': snapshotElementParams.extend({ key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']), operationId: operationIdSchema }).strict(),
  'browser.keyboard.sequence': snapshotElementParams.extend({
    keys: z.array(z.enum(BROWSER_KEY_ALLOWLIST)).min(1).max(16),
    operationId: z.string().min(1).max(128),
  }).strict(),
  'browser.action.capture': snapshotElementParams.extend({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('click') }).strict(),
      z.object({ kind: z.literal('hover') }).strict(),
      z.object({ kind: z.literal('key'), key: z.enum(BROWSER_KEY_ALLOWLIST) }).strict(),
    ]),
    wait: actionCaptureWaitSchema,
    output: browserActionCaptureOutputSchema,
    operationId: z.string().min(1).max(128),
  }).strict(),
  'browser.scroll': sessionIdParams.extend({ direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(5000), operationId: operationIdSchema }).strict(),
  'browser.select': snapshotElementParams.extend({ value: z.string().max(1024), operationId: operationIdSchema }).strict(),
  'browser.drag': snapshotElementParams.extend({ targetElementRef: opaqueIdSchema, operationId: operationIdSchema }).strict(),
  'browser.dialog': sessionIdParams.extend({ action: z.enum(['accept', 'dismiss']), operationId: operationIdSchema }).strict(),
  'browser.human.request': sessionIdParams.extend({ reason: humanReasonSchema, operationId: z.string().min(1).max(128) }).strict(),
  'browser.human.status': sessionIdParams,
  'browser.stop': sessionIdParams.extend({ operationId: operationIdSchema }).strict(),
  'web.profiles': z.object({}).strict(),
  'web.start': z.object({ webProfileId: webProfileIdSchema, operationId: operationIdSchema }).strict(),
  'web.list': z.object({}).strict(),
  'web.stop': webSessionParams.extend({ operationId: operationIdSchema }).strict(),
  'web.tabs': webSessionParams,
  'web.open': webSessionParams.extend({ url: publicHttpsUrlSchema, operationId: operationIdSchema }).strict(),
  'web.close': webTabParams.extend({ operationId: operationIdSchema }).strict(),
  'web.navigate': webTabParams.extend({ url: publicHttpsUrlSchema, operationId: operationIdSchema }).strict(),
  'web.reload': webTabParams.extend({ mode: z.enum(['normal', 'ignore-cache']).default('normal'), operationId: z.string().min(1).max(128) }).strict(),
  'web.back': webTabParams.extend({ operationId: operationIdSchema }).strict(),
  'web.snapshot': webTabParams.extend({ maxDepth: z.number().int().min(1).max(20).default(12), maxElements: z.number().int().min(1).max(1000).default(500) }).strict(),
  'web.inspect': webTabParams.extend(inspectionFields).strict().superRefine((value, context) => {
    if (value.target === 'element' && (value.snapshotId === undefined || value.elementRef === undefined)) {
      context.addIssue({ code: 'custom', message: 'snapshotId and elementRef are required for target element' });
    }
  }),
  'web.screenshot': webTabParams.extend({ settleMs: z.number().int().min(0).max(3_000).default(0) }).strict(),
  'web.screenshot.save': webTabParams.extend({
    workspaceId: workspaceIdSchema,
    path: relativePathSchema,
    settleMs: z.number().int().min(0).max(3_000).default(0),
    operationId: z.string().min(1).max(128),
  }).strict(),
  'web.motion.inspect': webTabParams.extend({ maxAnimations: z.number().int().min(1).max(100).default(100) }).strict(),
  'web.motion.capture': webTabParams.extend({ workspaceId: workspaceIdSchema, ...motionCaptureFields }).strict(),
  'web.extract': webTabParams.extend({ maxChars: z.number().int().min(1000).max(200_000).default(50_000) }).strict(),
  'web.assets': webTabParams.extend({ maxAssets: z.number().int().min(1).max(500).default(200) }).strict(),
  'web.viewport': webTabParams.extend({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(320).max(2160),
    mobile: z.boolean().default(false),
    operationId: operationIdSchema,
  }).strict(),
  'web.download': webTabParams.extend({
    resourceRef: webResourceRefSchema,
    workspaceId: workspaceIdSchema,
    path: relativePathSchema,
    operationId: z.string().min(1).max(128),
  }).strict(),
  'web.click': webElementParams.extend({ operationId: operationIdSchema }).strict(),
  'web.fill': webElementParams.extend({ text: z.string().max(8192), operationId: operationIdSchema }).strict(),
  'web.select': webElementParams.extend({ value: z.string().max(1024), operationId: operationIdSchema }).strict(),
  'web.scroll': webTabParams.extend({ direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(5000), operationId: operationIdSchema }).strict(),
  'web.press': webElementParams.extend({ key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']), operationId: operationIdSchema }).strict(),
  'web.keyboard.sequence': webElementParams.extend({
    keys: z.array(z.enum(BROWSER_KEY_ALLOWLIST)).min(1).max(16),
    operationId: z.string().min(1).max(128),
  }).strict(),
  'web.action.capture': webElementParams.extend({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('click') }).strict(),
      z.object({ kind: z.literal('key'), key: z.enum(BROWSER_KEY_ALLOWLIST) }).strict(),
    ]),
    wait: actionCaptureWaitSchema,
    output: browserActionCaptureOutputSchema,
    operationId: z.string().min(1).max(128),
  }).strict(),
  'web.wait': webTabParams.extend({ condition: webWaitConditionSchema, timeoutMs: z.number().int().min(100).max(30_000).default(5_000) }).strict(),
  'web.human.request': webSessionParams.extend({ reason: humanReasonSchema, operationId: z.string().min(1).max(128) }).strict(),
  'web.human.status': webSessionParams,
} as const;

export type BrokerMethod = keyof typeof brokerMethodSchemas;

export const brokerRequestEnvelopeSchema = z
  .object({
    version: z.literal(DEVELOPMENT_BROKER_PROTOCOL),
    id: z.string().regex(BROKER_ID_PATTERN),
    token: z.string().regex(BROKER_TOKEN_PATTERN),
    method: z.enum(Object.keys(brokerMethodSchemas) as [BrokerMethod, ...BrokerMethod[]]),
    params: z.unknown(),
  })
  .strict();

export const brokerSuccessEnvelopeSchema = z
  .object({
    version: z.literal(DEVELOPMENT_BROKER_PROTOCOL),
    id: z.string().regex(BROKER_ID_PATTERN),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const brokerFailureEnvelopeSchema = z
  .object({
    version: z.literal(DEVELOPMENT_BROKER_PROTOCOL),
    id: z.string().regex(BROKER_ID_PATTERN),
    ok: z.literal(false),
    error: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      message: z.string().max(512),
      causeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
    }).strict(),
  })
  .strict();

export const brokerResponseEnvelopeSchema = z.union([brokerSuccessEnvelopeSchema, brokerFailureEnvelopeSchema]);
export type BrokerRequestEnvelope = z.infer<typeof brokerRequestEnvelopeSchema>;
export type BrokerResponseEnvelope = z.infer<typeof brokerResponseEnvelopeSchema>;

export function parseBrokerParams<M extends BrokerMethod>(method: M, params: unknown): z.infer<(typeof brokerMethodSchemas)[M]> {
  return brokerMethodSchemas[method].parse(params) as z.infer<(typeof brokerMethodSchemas)[M]>;
}

export function brokerTokenMatches(expected: string, actual: string): boolean {
  if (!BROKER_TOKEN_PATTERN.test(expected) || !BROKER_TOKEN_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function createBrokerEndpoint(id: string, platform: NodeJS.Platform = process.platform): string {
  if (!BROKER_ID_PATTERN.test(id)) throw new Error('invalid broker endpoint id');
  return platform === 'win32'
    ? `\\\\.\\pipe\\LOCAL\\localbridge-development-${id}`
    : path.join(os.tmpdir(), `localbridge-development-${id}.sock`);
}

export function validateBrokerEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): string {
  const valid = platform === 'win32'
    ? /^\\\\\.\\pipe\\LOCAL\\localbridge-development-[a-f0-9]{32}$/.test(endpoint)
    : endpoint.startsWith(`${os.tmpdir()}${path.sep}localbridge-development-`) && endpoint.endsWith('.sock');
  if (!valid) throw new Error('invalid broker endpoint');
  return endpoint;
}

export function encodeBrokerFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_BROKER_FRAME_BYTES) throw new Error('broker frame exceeds limit');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class BrokerFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    if (this.buffered.length + chunk.length > MAX_BROKER_FRAME_BYTES + 4) {
      throw new Error('broker frame buffer exceeds limit');
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const values: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_BROKER_FRAME_BYTES) throw new Error('broker frame exceeds limit');
      if (this.buffered.length < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      values.push(JSON.parse(payload.toString('utf8')) as unknown);
    }
    return values;
  }
}
