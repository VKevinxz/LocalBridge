import { randomBytes } from 'node:crypto';

import { McpServer, createRequestStateCodec, type RequestStateCodec } from '@modelcontextprotocol/server';

import type { Logger, ServerConfig } from '@localbridge/shared';
import { DevelopmentBrokerClient } from '@localbridge/development';

import { APPROVAL_TTL_SECONDS, type ApprovalPayload } from './approval.js';
import type { ToolContext } from './tool-context.js';
import { registerFileCreateTool } from './tools/file-create.js';
import {
  registerBrowserEventsTool,
  registerBrowserListTool,
  registerBrowserNavigateTool,
  registerBrowserScreenshotTool,
  registerBrowserSnapshotTool,
  registerBrowserStartTool,
  registerBrowserStopTool,
  registerBrowserViewportTool,
} from './tools/browser-read-tools.js';
import {
  registerBrowserClickTool,
  registerBrowserFillTool,
  registerBrowserPressTool,
} from './tools/browser-interaction-tools.js';
import { registerBrowserHumanRequestTool, registerBrowserHumanStatusTool } from './tools/browser-human-tools.js';
import {
  registerApplicationListTool,
  registerApplicationStartTool,
  registerApplicationStatusTool,
  registerApplicationStopTool,
} from './tools/application-tools.js';
import { registerFileDeleteTool } from './tools/file-delete.js';
import { registerFileMetadataTool } from './tools/file-metadata.js';
import { registerFileMoveTool } from './tools/file-move.js';
import { registerFileReadTool } from './tools/file-read.js';
import { registerFileWriteGuardedTool } from './tools/file-write-guarded.js';
import { registerGitBranchTool, registerGitDiffTool, registerGitLogTool, registerGitStatusTool } from './tools/git-tools.js';
import { registerGitCommitTool, registerGitPushTool, registerGitStageTool } from './tools/git-write-tools.js';
import { registerHealthTool } from './tools/health.js';
import { registerValidationRunTool } from './tools/validation-run.js';
import {
  registerProcessListTool,
  registerProcessListenersTool,
  registerProcessLogsTool,
  registerProcessStartTool,
  registerProcessStopTool,
} from './tools/process-tools.js';
import { registerWorkspaceListTool } from './tools/workspace-list.js';
import { registerWorkspaceSearchTool } from './tools/workspace-search.js';
import { registerWorkspaceTreeTool } from './tools/workspace-tree.js';
import { registerProjectListTool, registerProjectSetupRefreshTool, registerProjectSetupStatusTool } from './tools/project-tools.js';
import {
  registerTerminalReadTool,
  registerTerminalStartTool,
  registerTerminalStatusTool,
  registerTerminalStopTool,
  registerTerminalWriteTool,
} from './tools/terminal-tools.js';

/**
 * Instrucciones que el cliente MCP ve al descubrir el servidor. Describen el
 * modelo de acceso para que un agente no pierda llamadas intentando cosas que
 * el diseño no permite.
 */
function serverInstructions(config: ServerConfig): string {
  const approvalInstruction = config.gitApprovalMode === 'mrtr'
    ? 'git.commit and git.push may return input_required: present that elicitation to the human and wait for inputResponses; never repeat the first round without a human response.'
    : 'git.commit and git.push use the MCP host native approval UI. If the host approved the tool call, invoke it once; LocalBridge will not return a second input_required round.';
  return [
    'LocalBridge MCP exposes structured operations over folders the user authorized, plus terminal sessions only for projects whose local trust level explicitly enables them.',
    'Paths are always relative to a workspace and are addressed by workspaceId; absolute paths and arbitrary roots are rejected.',
    'Call workspace.list first to discover which workspaces exist and what each one permits.',
    'Call project.list to discover assisted project groupings. Each project reports state and scanCoverage: a partial coverage only means the reported structure is incomplete and never blocks work. project.setup.refresh may only refresh a frozen local proposal; it never approves or executes setup. Tell the user to review setup in LocalBridge when project.setup.status reports awaiting-local-review.',
    'Prefer application.list for configured environments. Call application.start once, poll application.status until ready, then call browser.start with its applicationId, runId and primaryWorkspaceId; never reconstruct services, trust stdout URLs, or supply hosts and ports. Use process tools only for diagnostics or standalone profiles.',
    'To verify a responsive layout, call browser.viewport with the width and height you want to test, then take a fresh snapshot or screenshot: the previous snapshot is invalidated because the layout changed.',
    'After the work is complete, call browser.stop and application.stop for the same runId. LocalBridge rolls back partial starts and only stops processes it owns.',
    'If a local step requires the user, and browserHumanControl is granted, call browser.human.request once with an informational fixed reason, tell the user to take and later return control in LocalBridge, then poll browser.human.status. Never request, infer or handle credentials, file paths or file contents, and never use other browser tools while human control is pending or active.',
    approvalInstruction,
    'Projects may expose terminal.* only after the user selects a local trust mode in LocalBridge. Guided mode denies terminal use; project-agent requires a proven OS sandbox; full-host has the authority of the signed-in Windows user. This interface cannot choose or widen that trust, root, shell or environment.',
    'For an enabled project, start terminal sessions, write commands and poll terminal.read/status. Open a web project with browser.start using projectId, the primary terminalSessionId/listenerRef, optional relatedListeners for its other verified web services, and the project workspaceId. Never pass or infer a URL or port. Stop every terminal when work is complete.',
  ].join(' ');
}

/**
 * Tiempo de caché del catálogo de tools. Las descripciones de Git dependen del
 * modo local de aprobación, por lo que el resultado es privado aunque nombres
 * y schemas permanezcan estables (TOOL_CATALOG.md §0.3).
 */
const TOOLS_LIST_CACHE = { ttlMs: 60_000, cacheScope: 'private' as const };

export interface CreateMcpServerOptions {
  config: ServerConfig;
  logger: Logger;
  /** Ruta al registro de workspaces (ADR-0012). */
  workspaceConfigPath: string;
}

/**
 * Construye una instancia del servidor MCP con su catálogo ya registrado.
 *
 * El SDK v2 sirve `server/discover`, `tools/list` y el campo `resultType` por su
 * cuenta a partir de esta configuración: aquí se declara la identidad y las
 * capacidades, y se verifica el resultado en tests/protocol.
 */
export function createMcpServer({ config, logger, workspaceConfigPath }: CreateMcpServerOptions): McpServer {
  // Clave HMAC del motor de aprobaciones (ADR-0016): aleatoria por proceso,
  // nunca persistida ni derivada de nada externo. Válido porque el
  // round-trip completo de una aprobación (pedir -> el humano confirma ->
  // reintento) ocurre dentro de la misma conexión stdio de principio a fin —
  // nunca sobrevive a un reinicio del servidor, y no hace falta que sobreviva.
  const approvalCodec: RequestStateCodec<ApprovalPayload> = createRequestStateCodec({
    key: randomBytes(32),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
  const approvalInstanceId = randomBytes(16).toString('hex');

  const server = new McpServer(
    { name: config.name, version: config.version },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(config),
      cacheHints: { 'tools/list': TOOLS_LIST_CACHE },
      // Integridad de `requestState` (spec MRTR, requisitos 4-5): sin esto,
      // el SDK deja el campo en passthrough — un cliente podría reescribirlo
      // libremente. `approvalCodec.verify` prueba HMAC y caducidad antes de
      // que el handler de la tool se ejecute siquiera.
      requestState: { verify: approvalCodec.verify },
    },
  );

  const developmentClient =
    config.developmentBrokerEndpoint === undefined || config.developmentBrokerToken === undefined
      ? undefined
      : new DevelopmentBrokerClient({
          endpoint: config.developmentBrokerEndpoint,
          token: config.developmentBrokerToken,
        });
  const ctx: ToolContext = {
    config,
    logger,
    workspaceConfigPath,
    approvalCodec,
    approvalInstanceId,
    ...(developmentClient === undefined ? {} : { developmentClient }),
  };

  // El orden de esta lista es el orden de `tools/list`. Mantenerlo estable y
  // alfabético hace el listado determinista, que es lo que la revisión
  // 2026-07-28 pide para poder cachearlo.
  const registrars = [
    registerApplicationListTool,
    registerApplicationStartTool,
    registerApplicationStatusTool,
    registerApplicationStopTool,
    registerBrowserHumanRequestTool,
    registerBrowserHumanStatusTool,
    registerBrowserClickTool,
    registerBrowserEventsTool,
    registerBrowserFillTool,
    registerBrowserListTool,
    registerBrowserNavigateTool,
    registerBrowserPressTool,
    registerBrowserScreenshotTool,
    registerBrowserSnapshotTool,
    registerBrowserStartTool,
    registerBrowserStopTool,
    registerBrowserViewportTool,
    registerFileCreateTool,
    registerFileDeleteTool,
    registerFileMetadataTool,
    registerFileMoveTool,
    registerFileReadTool,
    registerFileWriteGuardedTool,
    registerGitBranchTool,
    registerGitCommitTool,
    registerGitDiffTool,
    registerGitLogTool,
    registerGitPushTool,
    registerGitStageTool,
    registerGitStatusTool,
    registerHealthTool,
    registerProcessListTool,
    registerProcessListenersTool,
    registerProcessLogsTool,
    registerProcessStartTool,
    registerProcessStopTool,
    registerProjectListTool,
    registerProjectSetupRefreshTool,
    registerProjectSetupStatusTool,
    registerTerminalReadTool,
    registerTerminalStartTool,
    registerTerminalStatusTool,
    registerTerminalStopTool,
    registerTerminalWriteTool,
    registerValidationRunTool,
    registerWorkspaceListTool,
    registerWorkspaceSearchTool,
    registerWorkspaceTreeTool,
  ];
  for (const register of registrars) {
    register(server, ctx);
  }

  logger.debug('mcp server built', { toolCount: registrars.length });

  return server;
}
