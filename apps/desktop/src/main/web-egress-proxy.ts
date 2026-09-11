import dns from "node:dns/promises";
import net, { type Server, type Socket } from "node:net";

import { webProfileRevision, type WebProfile } from "@localbridge/desktop-core";

import {
  isPublicIpAddress,
  isWebEgressHostAllowed,
  normalizeWebHostname,
  selectPublicResolvedAddress,
  type ResolvedWebAddress,
} from "./web-network-policy.js";

const MAX_HEADER_BYTES = 16 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

export interface WebEgressProxyOptions {
  readonly profileId: string;
  readonly expectedProfileRevision: string;
  readonly loadProfile: (profileId: string) => Promise<WebProfile | undefined>;
  readonly resolveHost?: (hostname: string) => Promise<readonly ResolvedWebAddress[]>;
  readonly connect?: (address: ResolvedWebAddress) => Socket;
}

export interface RunningWebEgressProxy {
  readonly port: number;
  readonly proxyRules: string;
  restrictToHosts(hostnames?: readonly string[]): void;
  close(): Promise<void>;
}

function deny(socket: Socket, status: 400 | 403 | 405 | 429 | 502): void {
  if (socket.destroyed) return;
  const reason = status === 403 ? "Forbidden" : status === 405 ? "Method Not Allowed" :
    status === 429 ? "Too Many Requests" : status === 502 ? "Bad Gateway" : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function parseConnectAuthority(header: string): { hostname: string; port: 443 } | undefined {
  const firstLine = header.split("\r\n", 1)[0];
  const matched = /^CONNECT ([^\s/:]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(firstLine ?? "");
  if (matched === null || matched[2] !== "443") return undefined;
  const hostname = normalizeWebHostname(matched[1] ?? "");
  return hostname === undefined ? undefined : { hostname, port: 443 };
}

async function defaultResolveHost(hostname: string): Promise<readonly ResolvedWebAddress[]> {
  const values = await dns.lookup(hostname, { all: true, verbatim: true });
  return values.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function defaultConnect(address: ResolvedWebAddress): Socket {
  return net.connect({ host: address.address, port: 443, family: address.family });
}

function normalizeIpv6(value: string): string {
  return new URL(`http://[${value}]/`).hostname.toLowerCase();
}

export function sameIpAddress(left: string, right: string): boolean {
  const leftFamily = net.isIP(left);
  const rightFamily = net.isIP(right);
  if (leftFamily === 0 || rightFamily === 0 || leftFamily !== rightFamily) return false;
  if (leftFamily === 4) return left === right;
  try {
    return normalizeIpv6(left) === normalizeIpv6(right);
  } catch {
    return false;
  }
}

export async function startWebEgressProxy(options: WebEgressProxyOptions): Promise<RunningWebEgressProxy> {
  const sockets = new Set<Socket>();
  const upstreams = new Set<Socket>();
  let restrictedHostnames: ReadonlySet<string> | undefined;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const connect = options.connect ?? defaultConnect;
  const restrictionAllows = (hostname: string): boolean => restrictedHostnames?.has(hostname) ?? true;

  const server: Server = net.createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      deny(socket, 429);
      return;
    }
    sockets.add(socket);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    let handled = false;

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      if (buffered.length + chunk.length > MAX_HEADER_BYTES) {
        handled = true;
        deny(socket, 400);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      handled = true;
      const header = buffered.subarray(0, end + 4).toString("latin1");
      const remainder = buffered.subarray(end + 4);
      void (async () => {
        const authority = parseConnectAuthority(header);
        if (authority === undefined) {
          deny(socket, header.startsWith("CONNECT ") ? 403 : 405);
          return;
        }
        if (!restrictionAllows(authority.hostname)) {
          deny(socket, 403);
          return;
        }
        const profile = await options.loadProfile(options.profileId).catch(() => undefined);
        if (profile === undefined || profile.id !== options.profileId || !profile.enabled || profile.reviewRequired ||
            !profile.permissions.read || webProfileRevision(profile) !== options.expectedProfileRevision ||
            !isWebEgressHostAllowed(profile, authority.hostname)) {
          deny(socket, 403);
          return;
        }
        const selected = selectPublicResolvedAddress(await resolveHost(authority.hostname));
        if (selected === undefined || !restrictionAllows(authority.hostname)) {
          deny(socket, 403);
          return;
        }

        const upstream = connect(selected);
        upstreams.add(upstream);
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
        upstream.once("connect", () => {
          const remoteAddress = upstream.remoteAddress;
          if (remoteAddress === undefined || !isPublicIpAddress(remoteAddress) ||
              !sameIpAddress(remoteAddress, selected.address) || !restrictionAllows(authority.hostname)) {
            upstream.destroy();
            deny(socket, 403);
            return;
          }
          socket.setTimeout(0);
          upstream.setTimeout(0);
          socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: LocalBridge\r\n\r\n");
          if (remainder.length > 0) upstream.write(remainder);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.once("error", () => deny(socket, 502));
        upstream.once("close", () => upstreams.delete(upstream));
      })().catch(() => deny(socket, 502));
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("No se pudo iniciar el proxy web.");
  }
  const proxyRules = `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`;
  return {
    port: address.port,
    proxyRules,
    restrictToHosts: (hostnames) => {
      if (hostnames === undefined) restrictedHostnames = undefined;
      else {
        const normalized = hostnames.map((hostname) => normalizeWebHostname(hostname));
        if (normalized.some((hostname) => hostname === undefined)) throw new Error("invalid web proxy host restriction");
        restrictedHostnames = new Set(normalized as string[]);
      }
      for (const socket of sockets) socket.destroy();
      for (const upstream of upstreams) upstream.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const upstream of upstreams) upstream.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  };
}
