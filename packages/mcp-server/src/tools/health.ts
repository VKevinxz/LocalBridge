import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { TARGET_PROTOCOL_REVISION } from '@localbridge/shared';

import type { ToolContext } from '../tool-context.js';

/**
 * `system.health` — riesgo R0, sin permisos (TOOL_CATALOG.md §1).
 *
 * Deliberadamente no revela número de workspaces, rutas ni información del
 * host: es la primera tool que un cliente no autenticado puede alcanzar, así
 * que su salida es lo mínimo necesario para saber que el servidor responde.
 */

const inputSchema = z.object({});

const outputSchema = z.object({
  status: z.literal('ready'),
  version: z.string(),
  protocolRevision: z.string(),
  gitApprovalMode: z.enum(['mrtr', 'host']),
});

const DESCRIPTION = [
  'Liveness check for the LocalBridge MCP server.',
  'Returns only server status, version, the MCP protocol revision and the active Git approval mode.',
  'It reveals nothing about the host, the authorized workspaces or the filesystem.',
  'Requires no permissions and never modifies state.',
].join(' ');

export function registerHealthTool(server: McpServer, { config }: ToolContext): void {
  server.registerTool(
    'system.health',
    {
      title: 'Server health',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    () => {
      const result = {
        status: 'ready' as const,
        version: config.version,
        protocolRevision: TARGET_PROTOCOL_REVISION,
        gitApprovalMode: config.gitApprovalMode,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
