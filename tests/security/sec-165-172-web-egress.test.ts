import net from "node:net";

import { describe, expect, it } from "vitest";

import { buildPublicResearchProfile, webProfileRevision } from "@localbridge/desktop-core";
import { parseConnectAuthority, sameIpAddress, startWebEgressProxy } from "../../apps/desktop/src/main/web-egress-proxy.js";
import {
  isPublicIpAddress,
  isWebEgressHostAllowed,
  isWebNavigationHostAllowed,
  normalizePublicHttpsUrl,
  selectPublicResolvedAddress,
} from "../../apps/desktop/src/main/web-network-policy.js";

function enabledPublicProfile() {
  return { ...buildPublicResearchProfile(), enabled: true };
}

function proxyOptions(profile: ReturnType<typeof enabledPublicProfile>) {
  return { profileId: profile.id, expectedProfileRevision: webProfileRevision(profile) };
}

function request(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

describe("SEC-165..172 — frontera de salida web", () => {
  it("SEC-165 normaliza solo HTTPS público con nombre DNS y sin credenciales", () => {
    expect(normalizePublicHttpsUrl("https://Example.com/a#secret")?.href).toBe("https://example.com/a");
    for (const value of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "file:///etc/passwd",
      "https://example.com:8443",
      "https://2130706433",
      "https://0x7f000001",
    ]) expect(normalizePublicHttpsUrl(value)).toBeUndefined();
  });

  it("SEC-166 bloquea rangos privados, metadata, documentación y equivalentes IPv6", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "192.168.1.1", "198.18.0.1", "192.0.2.1", "224.0.0.1",
      "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
    ]) expect(isPublicIpAddress(address), address).toBe(false);
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("SEC-167 rechaza DNS vacío, inválido, privado o mixto", () => {
    expect(selectPublicResolvedAddress([])).toBeUndefined();
    expect(selectPublicResolvedAddress([{ address: "127.0.0.1", family: 4 }])).toBeUndefined();
    expect(selectPublicResolvedAddress([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ])).toBeUndefined();
    expect(selectPublicResolvedAddress([{ address: "93.184.216.34", family: 4 }])).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("SEC-168 separa destinos navegables de hosts auxiliares en perfiles con cuenta", () => {
    const base = enabledPublicProfile();
    const account = {
      ...base,
      kind: "site-account" as const,
      destinations: [{ hostname: "example.com", includeSubdomains: true }],
      supportHosts: [{ hostname: "static.examplecdn.com", includeSubdomains: false }],
      permissions: { ...base.permissions, humanControl: true },
    };
    expect(isWebNavigationHostAllowed(account, "app.example.com")).toBe(true);
    expect(isWebNavigationHostAllowed(account, "static.examplecdn.com")).toBe(false);
    expect(isWebEgressHostAllowed(account, "static.examplecdn.com")).toBe(true);
    expect(isWebEgressHostAllowed(account, "evil-example.com")).toBe(false);
  });

  it("SEC-169 acepta únicamente CONNECT DNS al puerto 443", () => {
    expect(parseConnectAuthority("CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toEqual({ hostname: "example.com", port: 443 });
    for (const value of [
      "GET https://example.com/ HTTP/1.1\r\n\r\n",
      "CONNECT example.com:80 HTTP/1.1\r\n\r\n",
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
      "CONNECT example.com:443 HTTP/2\r\n\r\n",
    ]) expect(parseConnectAuthority(value)).toBeUndefined();
  });

  it("SEC-170 el proxy deniega HTTP plano sin resolver ni conectar", async () => {
    let resolved = false;
    const profile = enabledPublicProfile();
    const proxy = await startWebEgressProxy({
      ...proxyOptions(profile),
      loadProfile: async () => profile,
      resolveHost: async () => { resolved = true; return []; },
    });
    try {
      expect(await request(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).toContain("405 Method Not Allowed");
      expect(resolved).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("SEC-171 relee autoridad y deniega un perfil revocado antes de DNS", async () => {
    const profile = enabledPublicProfile();
    let resolved = false;
    const proxy = await startWebEgressProxy({
      ...proxyOptions(profile),
      loadProfile: async () => ({ ...profile, enabled: false }),
      resolveHost: async () => { resolved = true; return [{ address: "93.184.216.34", family: 4 }]; },
    });
    try {
      expect(await request(proxy.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")).toContain("403 Forbidden");
      expect(resolved).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("SEC-172 deniega una resolución privada antes de abrir el upstream", async () => {
    const profile = enabledPublicProfile();
    let connected = false;
    const proxy = await startWebEgressProxy({
      ...proxyOptions(profile),
      loadProfile: async () => profile,
      resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
      connect: () => { connected = true; throw new Error("no debe conectar"); },
    });
    try {
      expect(await request(proxy.port, "CONNECT metadata.example:443 HTTP/1.1\r\n\r\n")).toContain("403 Forbidden");
      expect(connected).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("SEC-172 reduce una sesión pública a un hostname exacto antes de DNS", async () => {
    const profile = enabledPublicProfile();
    let resolved = false;
    const proxy = await startWebEgressProxy({
      ...proxyOptions(profile),
      loadProfile: async () => profile,
      resolveHost: async () => { resolved = true; return [{ address: "93.184.216.34", family: 4 }]; },
    });
    try {
      proxy.restrictToHosts(["account.example"]);
      expect(await request(proxy.port, "CONNECT other.example:443 HTTP/1.1\r\n\r\n")).toContain("403 Forbidden");
      expect(await request(proxy.port, "CONNECT sub.account.example:443 HTTP/1.1\r\n\r\n")).toContain("403 Forbidden");
      expect(resolved).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it("SEC-172 fija la conexión a la misma IP pública ya validada", () => {
    expect(sameIpAddress("93.184.216.34", "93.184.216.34")).toBe(true);
    expect(sameIpAddress("93.184.216.35", "93.184.216.34")).toBe(false);
    expect(sameIpAddress("2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111")).toBe(true);
    expect(sameIpAddress("::ffff:127.0.0.1", "127.0.0.1")).toBe(false);
  });
});
