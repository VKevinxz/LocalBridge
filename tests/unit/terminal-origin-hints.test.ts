import { describe, expect, it } from "vitest";

import {
  extractLocalHttpOriginHints,
  selectTerminalBrowserOrigin,
  technicalTerminalOrigin,
} from "@localbridge/development";

describe("pistas de origen de terminal", () => {
  it("conserva un único localhost del mismo puerto y elimina path/query/fragmento", () => {
    const hints = extractLocalHttpOriginHints("Local: http://localhost:5173/app?q=secret#view");
    expect([...hints.get(5173)!]).toEqual(["http://localhost:5173"]);
    expect(selectTerminalBrowserOrigin({
      origin: "http://[::1]:5173", addressFamily: "ipv6", bindScope: "loopback", port: 5173,
    }, hints)).toBe("http://localhost:5173");
  });

  it("ignora destinos externos, HTTPS, credenciales y puertos inválidos", () => {
    const hints = extractLocalHttpOriginHints([
      "https://localhost:5173",
      "http://example.com:5173",
      "http://user:secret@localhost:5173",
      "http://localhost:0",
      "http://localhost:70000",
    ].join(" "));
    expect(hints.size).toBe(0);
  });

  it("ante alias contradictorios conserva el literal técnico", () => {
    const hints = extractLocalHttpOriginHints("http://localhost:5173 http://127.0.0.1:5173");
    expect(selectTerminalBrowserOrigin({
      origin: "http://[::1]:5173", addressFamily: "ipv6", bindScope: "loopback", port: 5173,
    }, hints)).toBe("http://[::1]:5173");
  });

  it("no cruza alias IPv4 e IPv6 aunque compartan puerto", () => {
    expect(selectTerminalBrowserOrigin({
      origin: "http://[::1]:5173", addressFamily: "ipv6", bindScope: "loopback", port: 5173,
    }, extractLocalHttpOriginHints("http://127.0.0.1:5173"))).toBe("http://[::1]:5173");
    expect(selectTerminalBrowserOrigin({
      origin: "http://127.0.0.1:5173", addressFamily: "ipv4", bindScope: "loopback", port: 5173,
    }, extractLocalHttpOriginHints("http://[::1]:5173"))).toBe("http://127.0.0.1:5173");
  });

  it("representa wildcard solo como localhost y conserva evidencia técnica", () => {
    const listener = { origin: "http://localhost:3007", addressFamily: "ipv6" as const, bindScope: "wildcard" as const, port: 3007 };
    expect(selectTerminalBrowserOrigin(listener, new Map())).toBe("http://localhost:3007");
    expect(technicalTerminalOrigin(listener)).toBe("http://[::]:3007");
  });
});
