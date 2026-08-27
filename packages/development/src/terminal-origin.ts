const LOCAL_HTTP_URL = /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}(?:[/?#][^\s"'<>]*)?/gi;

export interface TerminalOriginListener {
  readonly origin: string;
  readonly addressFamily: "ipv4" | "ipv6";
  readonly bindScope: "loopback" | "wildcard";
  readonly port: number;
}

function cleanCandidate(value: string): string | undefined {
  const candidate = value.replace(/[),.;]+$/g, "");
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.port === "") return undefined;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Extrae únicamente alias HTTP loopback. El resultado nunca constituye autoridad. */
export function extractLocalHttpOriginHints(value: string): ReadonlyMap<number, ReadonlySet<string>> {
  const hints = new Map<number, Set<string>>();
  for (const match of value.matchAll(LOCAL_HTTP_URL)) {
    const origin = cleanCandidate(match[0]);
    if (origin === undefined) continue;
    const port = Number(new URL(origin).port);
    const origins = hints.get(port) ?? new Set<string>();
    origins.add(origin);
    hints.set(port, origins);
  }
  return hints;
}

export function mergeLocalHttpOriginHints(
  target: Map<number, Set<string>>,
  incoming: ReadonlyMap<number, ReadonlySet<string>>,
): void {
  for (const [port, origins] of incoming) {
    const current = target.get(port) ?? new Set<string>();
    for (const origin of origins) current.add(origin);
    target.set(port, current);
  }
}

/**
 * Conserva un único alias observado para el puerto ya demostrado. Ante conflicto usa el
 * literal del listener. Wildcard solo es navegable como localhost y se valida después.
 */
export function selectTerminalBrowserOrigin(
  listener: TerminalOriginListener,
  hints: ReadonlyMap<number, ReadonlySet<string>>,
): string {
  if (listener.bindScope === "wildcard") return `http://localhost:${listener.port}`;
  const candidates = hints.get(listener.port);
  if (candidates?.size !== 1) return listener.origin;
  const candidate = [...candidates][0]!;
  const hostname = new URL(candidate).hostname;
  if (hostname === "localhost") return candidate;
  if (listener.addressFamily === "ipv4" && hostname === "127.0.0.1") return candidate;
  if (listener.addressFamily === "ipv6" && hostname === "[::1]") return candidate;
  return listener.origin;
}

export function technicalTerminalOrigin(listener: TerminalOriginListener): string {
  if (listener.bindScope === "loopback") return listener.origin;
  return listener.addressFamily === "ipv4"
    ? `http://0.0.0.0:${listener.port}`
    : `http://[::]:${listener.port}`;
}
