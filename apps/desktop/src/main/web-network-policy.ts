import net from "node:net";

import type { WebHostRule, WebProfile } from "@localbridge/desktop-core";

const blockedIpv4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4");

const blockedIpv6 = new net.BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

function validDnsHostname(hostname: string): boolean {
  if (hostname.length > 253 || hostname.endsWith(".") || !hostname.includes(".") || net.isIP(hostname) !== 0) return false;
  return hostname.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export function normalizeWebHostname(input: string): string | undefined {
  try {
    const parsed = new URL(`https://${input}`);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/" ||
        parsed.search !== "" || parsed.hash !== "" || !validDnsHostname(hostname)) return undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

export function normalizePublicHttpsUrl(input: string): URL | undefined {
  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.port !== "" && parsed.port !== "443" || !validDnsHostname(hostname)) return undefined;
    parsed.hostname = hostname;
    parsed.port = "";
    parsed.hash = "";
    return parsed;
  } catch {
    return undefined;
  }
}

export function isPublicIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) return !blockedIpv6.check(address, "ipv6");
  return false;
}

export function hostMatchesRule(hostname: string, rule: WebHostRule): boolean {
  return hostname === rule.hostname || rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`);
}

export function isWebNavigationHostAllowed(profile: WebProfile, hostname: string): boolean {
  const normalized = normalizeWebHostname(hostname);
  if (normalized === undefined) return false;
  if (profile.kind === "public-research") return true;
  return profile.destinations.some((rule) => hostMatchesRule(normalized, rule));
}

export function isWebEgressHostAllowed(profile: WebProfile, hostname: string): boolean {
  const normalized = normalizeWebHostname(hostname);
  if (normalized === undefined) return false;
  if (profile.kind === "public-research") return true;
  return [...profile.destinations, ...profile.supportHosts].some((rule) => hostMatchesRule(normalized, rule));
}

export interface ResolvedWebAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Falla cerrado también con respuestas DNS mixtas. La conexión posterior usa
 * exactamente una de estas direcciones numéricas, nunca vuelve a resolver el host.
 */
export function selectPublicResolvedAddress(addresses: readonly ResolvedWebAddress[]): ResolvedWebAddress | undefined {
  if (addresses.length === 0 || addresses.some(({ address, family }) => net.isIP(address) !== family || !isPublicIpAddress(address))) {
    return undefined;
  }
  return addresses[0];
}
