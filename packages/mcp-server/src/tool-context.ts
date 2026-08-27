import type { RequestStateCodec } from "@modelcontextprotocol/server";

import type { Logger, ServerConfig } from "@localbridge/shared";
import type { DevelopmentBrokerClient } from "@localbridge/development";

import type { ApprovalPayload } from "./approval.js";

/** Dependencias que necesita cualquier tool: identidad del servidor, logging y dónde vive el registro de workspaces (ADR-0012). */
export interface ToolContext {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly workspaceConfigPath: string;
  /** Motor de aprobaciones MRTR (ADR-0016) — compartido por todas las tools que lo necesiten, no específico de Git. */
  readonly approvalCodec: RequestStateCodec<ApprovalPayload>;
  /** Separa estados pendientes de procesos MCP concurrentes sin exponer el ID en el protocolo. */
  readonly approvalInstanceId: string;
  readonly developmentClient?: DevelopmentBrokerClient;
}
