import path from "node:path";

export const MANAGED_TUNNEL_PROFILE = "localbridge";

export interface BundledRuntimePaths {
  readonly tunnelBinaryPath: string;
  readonly nodeBinaryPath: string;
  readonly serverBundlePath: string;
  readonly profileDir: string;
  readonly profile: string;
}

/** Resuelve únicamente rutas internas controladas por la aplicación (ADR-0019). */
export function resolveBundledRuntimePaths(resourcesRoot: string, userDataRoot: string): BundledRuntimePaths {
  return {
    tunnelBinaryPath: path.join(resourcesRoot, "vendor", "tunnel-client", "tunnel-client.exe"),
    nodeBinaryPath: path.join(resourcesRoot, "vendor", "node", "node.exe"),
    serverBundlePath: path.join(resourcesRoot, "server", "index.cjs"),
    profileDir: path.join(userDataRoot, "tunnel-client"),
    profile: MANAGED_TUNNEL_PROFILE,
  };
}

/**
 * tunnel-client usa tokenización estilo shell incluso en Windows. Las comillas
 * simples preservan espacios y backslashes; la secuencia intermedia representa
 * un apóstrofo sin abrir una superficie de shell (el proceso se lanza con shell:false).
 */
export function quoteTunnelCommandToken(token: string): string {
  return `'${token.replaceAll("'", `'"'"'`)}'`;
}

export function bundledServerCommand(paths: BundledRuntimePaths): string {
  return `${quoteTunnelCommandToken(paths.nodeBinaryPath)} ${quoteTunnelCommandToken(paths.serverBundlePath)}`;
}
