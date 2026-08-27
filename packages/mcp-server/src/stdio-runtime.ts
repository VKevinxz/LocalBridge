import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createLogger, loadConfig } from "@localbridge/shared";

import { createMcpServer } from "./server.js";

/**
 * Arranca LocalBridge sobre stdio dentro del proceso actual.
 *
 * Es la entrada compartida por el binario de desarrollo y por el modo servidor
 * cerrado del ejecutable Electron empaquetado (ADR-0019). stdout queda reservado
 * exclusivamente para MCP; toda observabilidad usa el logger en stderr.
 */
export function runLocalBridgeStdio(): void {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("SQLite is an experimental feature")) return;
    // @ts-expect-error -- reenvía la firma real, más amplia que la sobrecarga inferida aquí.
    originalEmitWarning(warning, ...args);
  }) as typeof process.emitWarning;

  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    base: { service: config.name, version: config.version },
  });

  logger.debug("workspace registry path", { workspaceConfigPath: config.workspaceConfigPath });

  const handle = serveStdio(
    () => createMcpServer({ config, logger, workspaceConfigPath: config.workspaceConfigPath }),
    {
      legacy: "serve",
      onerror: (error) => {
        logger.error("transport error", { error });
      },
    },
  );

  logger.info("server started", { transport: "stdio" });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("shutting down", { signal });
    try {
      await handle.close();
    } catch (error) {
      logger.error("shutdown failed", { error });
      process.exitCode = 1;
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { reason });
    process.exit(1);
  });
}
