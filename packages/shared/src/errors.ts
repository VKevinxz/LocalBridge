/**
 * Modelo de errores estable (MASTER_SPEC.md §9).
 *
 * Dos reglas gobiernan este módulo:
 *
 * 1. Los códigos son estables. Un agente puede razonar sobre ellos, así que
 *    renombrarlos rompe el contrato aunque el tipo siga compilando.
 * 2. Nada que salga de aquí puede filtrar rutas absolutas, stack traces ni
 *    contenido de archivos (SECURITY.md, amenaza L). Por eso el mensaje que
 *    viaja al cliente es siempre el de la tabla, nunca el de la excepción
 *    original.
 */

export const ERROR_CODES = [
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorDefinition {
  /**
   * Mensaje orientado a la recuperación: dice qué hacer, no solo qué falló.
   * Es el único texto que llega al cliente.
   */
  readonly message: string;
  /** Si tiene sentido que el agente reintente tras corregir su entrada o su estado. */
  readonly recoverable: boolean;
}

const ERROR_DEFINITIONS: Readonly<Record<ErrorCode, ErrorDefinition>> = {
  WORKSPACE_NOT_FOUND: {
    message: 'The workspace does not exist or is not authorized. Call workspace.list to see the available workspaces.',
    recoverable: true,
  },
  WORKSPACE_DISABLED: {
    message: 'The workspace is currently disabled. The user must re-enable it before it can be used.',
    recoverable: false,
  },
  CAPABILITY_DISABLED: {
    message: 'The workspace does not grant the capability this operation requires. Do not retry; the user must grant it.',
    recoverable: false,
  },
  PATH_OUTSIDE_WORKSPACE: {
    message: 'The path resolves outside the workspace. Use a path relative to the workspace root.',
    recoverable: true,
  },
  ABSOLUTE_PATH_FORBIDDEN: {
    message: 'Absolute paths are not accepted. Use a path relative to the workspace root.',
    recoverable: true,
  },
  SYMLINK_ESCAPE: {
    message: 'The path resolves outside the workspace through a link. Use a path that stays inside the workspace.',
    recoverable: true,
  },
  PATH_DENIED: {
    message: 'This path is excluded by the workspace policy. Do not retry.',
    recoverable: false,
  },
  FILE_NOT_FOUND: {
    message: 'The file does not exist. Check the path with workspace.tree or file.metadata.',
    recoverable: true,
  },
  FILE_ALREADY_EXISTS: {
    message: 'The file already exists. Use file.write_guarded with the current hash to replace it.',
    recoverable: true,
  },
  FILE_TOO_LARGE: {
    message: 'The file exceeds the size limit of this workspace. Read it in bounded chunks with maxBytes.',
    recoverable: true,
  },
  INSUFFICIENT_DISK_SPACE: {
    message: 'The workspace disk does not have enough free space for this download and its safety reserve. Free space or choose another authorized workspace.',
    recoverable: true,
  },
  NOT_A_FILE: {
    message: 'The path is not a regular file.',
    recoverable: true,
  },
  HASH_MISMATCH: {
    message: 'The target changed after it was read. Re-read the file, reapply your change and retry.',
    recoverable: true,
  },
  GIT_NOT_REPOSITORY: {
    message: 'The workspace is not a Git repository.',
    recoverable: false,
  },
  COMMAND_NOT_ALLOWED: {
    message: 'That validation profile is not configured for this workspace. Only preapproved profiles can run.',
    recoverable: false,
  },
  TIMEOUT: {
    message: 'The operation exceeded its time limit and was cancelled.',
    recoverable: true,
  },
  OUTPUT_TRUNCATED: {
    message: 'The output exceeded the size limit and was truncated.',
    recoverable: true,
  },
  RATE_LIMITED: {
    message: 'Too many requests. Slow down and retry later.',
    recoverable: true,
  },
  INVALID_INPUT: {
    message: 'The arguments do not match the tool schema. Check the tool definition and retry.',
    recoverable: true,
  },
  APPROVAL_DECLINED: {
    message: 'The user declined this operation. Do not retry with the same content.',
    recoverable: false,
  },
  APPROVAL_INVALID: {
    message: 'The approval no longer matches what is being requested (content changed, or it was issued for a different operation). Request approval again.',
    recoverable: true,
  },
  GIT_PUSH_REJECTED: {
    message: 'The remote rejected the push (for example, it is not a fast-forward). Pull or rebase, then retry — this tool never force-pushes.',
    recoverable: true,
  },
  GIT_PUSH_UNCERTAIN: {
    message: 'The push outcome could not be verified after the connection or process was interrupted. Inspect the remote branch before retrying.',
    recoverable: true,
  },
  FEATURE_UNAVAILABLE: {
    message: 'This capability is unavailable in the current LocalBridge desktop session.',
    recoverable: true,
  },
  PROFILE_NOT_FOUND: {
    message: 'The approved process profile does not exist. Call workspace.list and choose a configured profile.',
    recoverable: true,
  },
  PROFILE_SOURCE_MISSING: {
    message: 'The manifest that defines this process profile is missing. Review and save the project configuration locally.',
    recoverable: true,
  },
  PROFILE_SOURCE_INVALID: {
    message: 'The process profile source cannot be read or parsed. Review and save the project configuration locally.',
    recoverable: true,
  },
  PROFILE_STALE: {
    message: 'The approved profile changed on disk. Ask the user to review and save it again in LocalBridge.',
    recoverable: false,
  },
  PROFILE_REVIEW_REQUIRED: {
    message: 'This imported profile requires local review in LocalBridge before it can run.',
    recoverable: false,
  },
  PROJECT_NOT_FOUND: {
    message: 'The assisted project does not exist or is not available. Call project.list to refresh the visible projects.',
    recoverable: true,
  },
  PROJECT_REVIEW_REQUIRED: {
    message: 'The setup proposal requires local review in LocalBridge. ChatGPT cannot approve or execute it.',
    recoverable: false,
  },
  PROJECT_UNAVAILABLE: {
    message: 'The project folder is unavailable. Reconnect the drive or review the project locally.',
    recoverable: true,
  },
  TERMINAL_NOT_AUTHORIZED: {
    message: 'This project does not have an active local terminal trust decision. The user must review it in LocalBridge.',
    recoverable: false,
  },
  SANDBOX_UNAVAILABLE: {
    message: 'Project-isolated execution is unavailable on this device. LocalBridge denied the session instead of running without isolation.',
    recoverable: false,
  },
  TERMINAL_NOT_FOUND: {
    message: 'The terminal session does not exist in this LocalBridge instance. Start a new session.',
    recoverable: true,
  },
  TERMINAL_NOT_RUNNING: {
    message: 'The terminal session is no longer running. Read its final output or start a new session.',
    recoverable: true,
  },
  TERMINAL_START_FAILED: {
    message: 'The local terminal could not become ready. Review LocalBridge diagnostics and try again.',
    recoverable: true,
  },
  IDEMPOTENCY_CONFLICT: {
    message: 'The operationId was already used with different input. Generate a new operationId.',
    recoverable: true,
  },
  SETUP_PLAN_STALE: {
    message: 'The frozen setup proposal no longer matches the project or toolchain. Refresh it and review the new proposal locally.',
    recoverable: true,
  },
  SETUP_TOOLCHAIN_MISSING: {
    message: 'An approved package manager or Git installation was not found. Install it in a standard location and refresh the proposal.',
    recoverable: true,
  },
  SETUP_ALREADY_RUNNING: {
    message: 'The local setup concurrency limit was reached. Wait for another setup to finish or cancel it in LocalBridge.',
    recoverable: true,
  },
  SETUP_WORKSPACE_BUSY: {
    message: 'This workspace already has a managed process running. Stop it locally before preparing the project.',
    recoverable: true,
  },
  SETUP_PRIVATE_CONFIG_UNSUPPORTED: {
    message: 'A project-level package-manager configuration was found. Use manual setup so registry credentials and private configuration stay outside LocalBridge.',
    recoverable: false,
  },
  SETUP_CANCELLED: {
    message: 'The user cancelled local project preparation. Refresh the project before trying again.',
    recoverable: true,
  },
  SETUP_FAILED: {
    message: 'Local project preparation failed. Review the local diagnostic, fix the cause and refresh the proposal.',
    recoverable: true,
  },
  SETUP_INTERRUPTED: {
    message: 'Local project preparation was interrupted. Refresh the proposal and review it again.',
    recoverable: true,
  },
  TOPOLOGY_REVIEW_REQUIRED: {
    message: 'The detected project topology requires local review before profiles or applications can be finalized.',
    recoverable: false,
  },
  UNSUPPORTED_ECOSYSTEM: {
    message: 'The project ecosystem is not supported by assisted setup. Configure it manually with fixed LocalBridge profiles.',
    recoverable: false,
  },
  APPLICATION_PROFILE_NOT_FOUND: {
    message: 'The reviewed local application does not exist. Call workspace.list and choose a configured application.',
    recoverable: true,
  },
  APPLICATION_REVIEW_REQUIRED: {
    message: 'This application needs local review before it can run. Open Applications in LocalBridge and complete its verification.',
    recoverable: false,
  },
  APPLICATION_RUN_NOT_FOUND: {
    message: 'The application run does not exist or no longer belongs to this LocalBridge session. Call application.status or start it again.',
    recoverable: true,
  },
  APPLICATION_START_FAILED: {
    message: 'One application service failed to become ready. LocalBridge stopped every service started by that run.',
    recoverable: true,
  },
  APPLICATION_CLEANUP_FAILED: {
    message: 'LocalBridge could not verify complete cleanup of an application run. Open Activity and use Stop all before continuing.',
    recoverable: false,
  },
  APPLICATION_SERVICE_MISMATCH: {
    message: 'The supplied listener references do not exactly match the services in the reviewed local application.',
    recoverable: true,
  },
  APPLICATION_ORIGIN_CONFLICT: {
    message: 'Two reviewed services resolve to the same local origin. Review the application configuration locally.',
    recoverable: false,
  },
  MANAGED_WILDCARD_NOT_APPROVED: {
    message: 'A managed wildcard listener requires explicit local approval for this application service.',
    recoverable: false,
  },
  LOCALHOST_RESOLUTION_BLOCKED: {
    message: 'Localhost did not resolve exclusively to loopback addresses in the isolated browser session.',
    recoverable: false,
  },
  PROJECT_BROWSER_LISTENER_MISMATCH: {
    message: 'One or more listener references do not belong to the selected project terminals. Refresh terminal.status and retry with current references.',
    recoverable: true,
  },
  PROJECT_BROWSER_ORIGIN_CONFLICT: {
    message: 'Two selected project services resolve to the same or an ambiguous local origin. Stop the conflicting service and retry.',
    recoverable: true,
  },
  PROJECT_BROWSER_PRIMARY_UNAVAILABLE: {
    message: 'The primary project listener is no longer available. Refresh terminal.status and choose a live frontend listener.',
    recoverable: true,
  },
  LOCALHOST_ATTESTATION_FAILED: {
    message: 'Localhost could not be proven to resolve only to listeners owned by the selected project. Review the active services and retry.',
    recoverable: true,
  },
  LISTENER_STALE: {
    message: 'The listener reference expired or changed ownership. Call terminal.status or process.listeners and retry with a current reference.',
    recoverable: true,
  },
  PROCESS_NOT_FOUND: {
    message: 'The process does not exist in this LocalBridge session. Call process.list to refresh state.',
    recoverable: true,
  },
  LISTENER_NOT_FOUND: {
    message: 'The verified listener is no longer owned by that managed process. Call process.listeners to refresh state.',
    recoverable: true,
  },
  SESSION_NOT_FOUND: {
    message: 'The browser session does not exist. Call browser.list or start a new approved session.',
    recoverable: true,
  },
  STALE_SNAPSHOT: {
    message: 'The page changed after the snapshot. Take a new browser snapshot before interacting.',
    recoverable: true,
  },
  ELEMENT_NOT_INTERACTABLE: {
    message: 'The referenced element is hidden, disabled, covered or otherwise cannot receive the requested interaction.',
    recoverable: true,
  },
  ASSERTION_FAILED: {
    message: 'The browser condition was not satisfied. Take a fresh snapshot or inspect browser events before retrying.',
    recoverable: true,
  },
  ORIGIN_BLOCKED: {
    message: 'The requested browser destination is outside the approved loopback origins.',
    recoverable: false,
  },
  SENSITIVE_INPUT_BLOCKED: {
    message: 'LocalBridge does not interact with password, file or other sensitive input fields.',
    recoverable: false,
  },
  HUMAN_CONTROL_NOT_ALLOWED: {
    message: 'This workspace does not allow exclusive human browser control. The user must enable it locally.',
    recoverable: false,
  },
  HUMAN_CONTROL_REQUEST_NOT_FOUND: {
    message: 'There is no human-control request for this browser session. Request it first.',
    recoverable: true,
  },
  HUMAN_CONTROL_ACTIVE: {
    message: 'The browser is reserved for or under exclusive human control. Wait and call browser.human.status; do not inspect or interact with it.',
    recoverable: true,
  },
  HUMAN_CONTROL_EXPIRED: {
    message: 'The human-control request or post-handoff authority expired and the isolated browser was destroyed. Start a new browser session.',
    recoverable: true,
  },
  HUMAN_CONTROL_DECLINED: {
    message: 'The user declined human browser control. Do not retry unless the user asks you to.',
    recoverable: false,
  },
  HUMAN_CONTROL_BUSY: {
    message: 'Another isolated browser is already under human control. Wait for it to finish or ask the user to cancel it.',
    recoverable: true,
  },
  WEB_SESSION_NOT_FOUND: {
    message: 'The web session does not exist or lost its local authorization. Call web.list or start a new enabled profile.',
    recoverable: true,
  },
  WEB_TAB_NOT_FOUND: {
    message: 'The web tab does not exist in that session. Call web.tabs to refresh the available tabs.',
    recoverable: true,
  },
  WEB_DESTINATION_BLOCKED: {
    message: 'The destination is outside the enabled web profile or is not a public HTTPS host.',
    recoverable: false,
  },
  WEB_NAVIGATION_FAILED: {
    message: 'The isolated web tab could not prove that navigation completed. Inspect the current tab before deciding whether to retry.',
    recoverable: true,
  },
  WEB_CAPTURE_FAILED: {
    message: 'The isolated web tab could not produce a valid screenshot. Observe the tab state before retrying once.',
    recoverable: true,
  },
  WEB_CAPTURE_TOO_LARGE: {
    message: 'The web screenshot exceeded the safe transport budget even after bounded fallback compression. Use a smaller viewport and retry.',
    recoverable: true,
  },
  WEB_EFFECT_UNCERTAIN: {
    message: 'The web action may have taken effect before the connection failed. Observe the current page and do not repeat it automatically.',
    recoverable: true,
  },
  MOTION_CAPTURE_UNAVAILABLE: {
    message: 'The requested temporal capture backend is unavailable in this browser session. Use auto or stepped capture.',
    recoverable: true,
  },
  MOTION_CAPTURE_INTERRUPTED: {
    message: 'The page, session or authority changed during temporal capture. Inspect the current state before starting a new operation.',
    recoverable: true,
  },
  MOTION_EFFECT_UNCERTAIN: {
    message: 'Temporal capture started moving the page before it failed. Inspect the page and use a new operationId only when a new capture is intended.',
    recoverable: true,
  },
  MOTION_LIMIT_EXCEEDED: {
    message: 'Another temporal capture is active or the motion artifact exceeded its bounded limits. Wait or reduce the capture size.',
    recoverable: true,
  },
  MOTION_BUNDLE_INVALID: {
    message: 'The motion bundle is malformed, incomplete, or does not match its declared hashes. Capture it again to a new destination.',
    recoverable: true,
  },
  MOTION_BUNDLES_INCOMPATIBLE: {
    message: 'The motion bundles have different viewport, progress, direction, format, or frame dimensions and cannot be compared.',
    recoverable: true,
  },
  WEB_RESOURCE_NOT_FOUND: {
    message: 'The observed web resource reference is stale or does not belong to this tab. Extract the page again to obtain current references.',
    recoverable: true,
  },
  WEB_DOWNLOAD_BLOCKED: {
    message: 'The web profile, resource type, size or destination does not allow this download.',
    recoverable: false,
  },
  WEB_DOWNLOAD_QUOTA_EXCEEDED: {
    message: 'The download exceeds the locally configured asset or session quota. Reduce the asset set or change the web profile limit locally before retrying.',
    recoverable: true,
  },
  WEB_MEDIA_TYPE_UNSUPPORTED: {
    message: 'The observed resource is not a supported passive document or media format. Re-enumerate assets and choose a supported resource.',
    recoverable: true,
  },
  WEB_MEDIA_TYPE_MISMATCH: {
    message: 'The resource MIME, extension and file signature do not identify the same passive format. Re-enumerate assets or use the normalized path returned by LocalBridge.',
    recoverable: true,
  },
  WEB_DOWNLOAD_EMPTY: {
    message: 'The server returned an empty download. Re-enumerate the page assets and retry only if the resource changed.',
    recoverable: true,
  },
  HUMAN_ACTION_REQUIRED: {
    message: 'This web action requires private local human control. Request or take control, complete the step, and explicitly return control.',
    recoverable: true,
  },
  DOCUMENT_UNSUPPORTED: {
    message: 'The PDF is encrypted, malformed, or otherwise outside the supported passive document contract.',
    recoverable: false,
  },
  DOCUMENT_NO_TEXT: {
    message: 'No useful text was found in the requested PDF pages. Use document.render to inspect them visually.',
    recoverable: true,
  },
  DOCUMENT_RENDER_FAILED: {
    message: 'The PDF page could not be rendered safely. Reduce the page batch and retry once; report the page if it still fails.',
    recoverable: true,
  },
  DOCUMENT_RENDER_TOO_LARGE: {
    message: 'The rendered PDF page exceeded the visual transport budget. Retry with standard detail or a smaller page batch.',
    recoverable: true,
  },
  IMAGE_UNSUPPORTED: {
    message: 'The file is not a supported passive PNG, JPEG, or WebP image, or its signature does not match its format.',
    recoverable: false,
  },
  IMAGE_TOO_LARGE: {
    message: 'The image exceeds the safe source, pixel, memory, or visual transport budget.',
    recoverable: false,
  },
  ANALYSIS_JOB_NOT_FOUND: {
    message: 'The analysis job does not exist in this workspace or its retention period expired. Call analysis.list to discover available jobs.',
    recoverable: true,
  },
  ANALYSIS_QUEUE_FULL: {
    message: 'The managed analysis queue is full. No job or effect was started; wait for an existing job to finish and retry later.',
    recoverable: true,
  },
  ANALYSIS_CANCELLED: {
    message: 'The managed analysis was cancelled and will not deliver further content.',
    recoverable: false,
  },
  ANALYSIS_INTERRUPTED: {
    message: 'The managed analysis was interrupted before a terminal receipt was recorded. Inspect its status before starting a new attempt.',
    recoverable: true,
  },
  ANALYSIS_FAILED: {
    message: 'The managed analysis failed. Inspect analysis.status for its stage and coverage before choosing another supported method.',
    recoverable: true,
  },
  INTERNAL_ERROR: {
    message: 'The operation failed for an internal reason.',
    recoverable: false,
  },
};

/** Payload de error tal y como viaja al cliente MCP. */
export interface ErrorPayload {
  readonly ok: false;
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly recoverable: boolean;
    readonly causeCode?: ErrorCode;
    readonly rateLimit?: {
      readonly resource: 'local-browser-sessions' | 'internet-browser-sessions' | 'internet-browser-tabs' |
        'terminal-sessions' | 'terminal-output-waits' | 'managed-processes' | 'analysis-jobs' |
        'visual-comparisons' | 'idempotent-operations';
      readonly scope: 'global' | 'project' | 'session' | 'profile';
      readonly capacity?: number;
      readonly recoveryTool: 'browser.list' | 'web.list' | 'web.tabs' | 'terminal.list' | 'terminal.read' |
        'process.list' | 'analysis.list';
      readonly action: 'list-and-reuse' | 'immediate-read' | 'wait-and-retry';
    };
  };
}

const RATE_LIMIT_RESOURCES = new Set([
  'local-browser-sessions', 'internet-browser-sessions', 'internet-browser-tabs', 'terminal-sessions',
  'terminal-output-waits', 'managed-processes', 'analysis-jobs', 'visual-comparisons', 'idempotent-operations',
]);
const RATE_LIMIT_SCOPES = new Set(['global', 'project', 'session', 'profile']);
const RATE_LIMIT_RECOVERY_TOOLS = new Set([
  'browser.list', 'web.list', 'web.tabs', 'terminal.list', 'terminal.read', 'process.list', 'analysis.list',
]);
const RATE_LIMIT_ACTIONS = new Set(['list-and-reuse', 'immediate-read', 'wait-and-retry']);

function safeRateLimitDetails(value: unknown): NonNullable<ErrorPayload['error']['rateLimit']> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input['resource'] !== 'string' || !RATE_LIMIT_RESOURCES.has(input['resource']) ||
      typeof input['scope'] !== 'string' || !RATE_LIMIT_SCOPES.has(input['scope']) ||
      typeof input['recoveryTool'] !== 'string' || !RATE_LIMIT_RECOVERY_TOOLS.has(input['recoveryTool']) ||
      typeof input['action'] !== 'string' || !RATE_LIMIT_ACTIONS.has(input['action'])) return undefined;
  const capacity = input['capacity'];
  if (capacity !== undefined && (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)) return undefined;
  return {
    resource: input['resource'] as NonNullable<ErrorPayload['error']['rateLimit']>['resource'],
    scope: input['scope'] as NonNullable<ErrorPayload['error']['rateLimit']>['scope'],
    ...(capacity === undefined ? {} : { capacity }),
    recoveryTool: input['recoveryTool'] as NonNullable<ErrorPayload['error']['rateLimit']>['recoveryTool'],
    action: input['action'] as NonNullable<ErrorPayload['error']['rateLimit']>['action'],
  };
}

/**
 * Error de dominio. `details` queda del lado del servidor (logs y auditoría) y
 * nunca se serializa hacia el cliente.
 */
export class LocalBridgeError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, details?: Record<string, unknown>) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'LocalBridgeError';
    this.code = code;
    this.recoverable = definition.recoverable;
    this.details = details;
  }
}

export function isLocalBridgeError(value: unknown): value is LocalBridgeError {
  return value instanceof LocalBridgeError;
}

/**
 * Convierte cualquier valor lanzado en un payload seguro.
 *
 * Un error desconocido se colapsa a INTERNAL_ERROR: preferimos perder detalle
 * antes que filtrar una ruta absoluta o un stack trace por un `throw` que no
 * habíamos previsto. Es la aplicación concreta del principio de fallo cerrado.
 */
export function toErrorPayload(value: unknown): ErrorPayload {
  const code: ErrorCode = isLocalBridgeError(value) ? value.code : 'INTERNAL_ERROR';
  const definition = ERROR_DEFINITIONS[code];
  const rawCause = isLocalBridgeError(value) ? value.details?.['causeCode'] : undefined;
  const causeCode = typeof rawCause === 'string' && (ERROR_CODES as readonly string[]).includes(rawCause)
    ? rawCause as ErrorCode
    : undefined;
  const rateLimit = code === 'RATE_LIMITED' && isLocalBridgeError(value)
    ? safeRateLimitDetails(value.details?.['rateLimit'])
    : undefined;

  return {
    ok: false,
    error: {
      code,
      message: definition.message,
      recoverable: definition.recoverable,
      ...(causeCode === undefined ? {} : { causeCode }),
      ...(rateLimit === undefined ? {} : { rateLimit }),
    },
  };
}

/** Solo para tests y diagnóstico: la definición estable de un código. */
export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_DEFINITIONS[code];
}
