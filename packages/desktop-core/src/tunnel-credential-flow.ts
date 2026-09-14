import type { SecureKeyLoadResult } from "./secure-key-store.js";

export interface TunnelCredentialRequest {
  readonly apiKey?: string | undefined;
  readonly remember: boolean;
}

export interface TunnelCredentialConnectResult {
  readonly connected: true;
  readonly remembered: boolean;
  readonly warningCode?: "KEY_STORE_WRITE_FAILED";
}

export interface TunnelCredentialFlowOptions {
  readonly request: TunnelCredentialRequest;
  readonly stored: SecureKeyLoadResult;
  readonly validate: (apiKey: string) => void;
  readonly start: (apiKey: string) => void | Promise<void>;
  readonly waitUntilConnected: () => Promise<void>;
  readonly disconnect: () => void;
  readonly persist: (apiKey: string) => Promise<boolean>;
}

function missingCredentialCode(stored: SecureKeyLoadResult): string {
  if (stored.status === "encryption-unavailable") return "KEY_STORE_ENCRYPTION_UNAVAILABLE";
  if (stored.status === "unreadable") return "KEY_STORE_UNREADABLE";
  if (stored.status === "io-error") return "KEY_STORE_READ_FAILED";
  return "TUNNEL_KEY_REQUIRED";
}

/**
 * Orden transaccional del botón Conectar: resolver en `main`, validar, esperar una
 * conexión comprobada y recién entonces persistir. El perfil y la ruta quedan
 * capturados por los callbacks creados por el llamante antes de iniciar el túnel.
 */
export async function connectWithTunnelCredential(
  options: TunnelCredentialFlowOptions,
): Promise<TunnelCredentialConnectResult> {
  const usesStored = options.request.apiKey === undefined && options.stored.status === "available";
  const apiKey = options.request.apiKey ?? (options.stored.status === "available" ? options.stored.value : undefined);
  if (apiKey === undefined) throw new Error(missingCredentialCode(options.stored));

  options.validate(apiKey);
  try {
    await options.start(apiKey);
  } catch (error) {
    options.disconnect();
    throw error;
  }
  try {
    await options.waitUntilConnected();
  } catch (error) {
    options.disconnect();
    throw error;
  }

  if (!options.request.remember) return { connected: true, remembered: usesStored };
  if (usesStored) return { connected: true, remembered: true };

  const remembered = await options.persist(apiKey);
  return {
    connected: true,
    remembered,
    ...(remembered ? {} : { warningCode: "KEY_STORE_WRITE_FAILED" as const }),
  };
}
