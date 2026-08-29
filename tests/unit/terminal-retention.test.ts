import { describe, expect, it } from "vitest";

import {
  FINISHED_RETENTION_MS,
  MAX_RETAINED_FINISHED,
  expiredTerminalSessions,
  type RetainedTerminalSession,
} from "@localbridge/development";

const NOW = 1_800_000_000_000;

function finished(sessionId: string, agoMs: number): RetainedTerminalSession {
  return { sessionId, state: "exited", finishedAtMs: NOW - agoMs };
}

describe("retención de terminales terminadas", () => {
  it("nunca libera una sesión en ejecución", () => {
    const sessions: RetainedTerminalSession[] = [
      { sessionId: "viva", state: "running" },
      finished("muerta", FINISHED_RETENTION_MS + 1),
    ];
    expect(expiredTerminalSessions(sessions, NOW)).toEqual(["muerta"]);
  });

  it("conserva la salida final dentro de la ventana de retención", () => {
    const sessions = [finished("reciente", 60_000)];
    expect(expiredTerminalSessions(sessions, NOW)).toEqual([]);
  });

  it("libera las que superan la ventana", () => {
    const sessions = [
      finished("justo-dentro", FINISHED_RETENTION_MS - 1),
      finished("justo-fuera", FINISHED_RETENTION_MS),
    ];
    expect(expiredTerminalSessions(sessions, NOW)).toEqual(["justo-fuera"]);
  });

  it("acota el número retenido liberando las más antiguas primero", () => {
    const sessions = Array.from({ length: MAX_RETAINED_FINISHED + 3 }, (_, index) =>
      finished(`s${index}`, (MAX_RETAINED_FINISHED + 3 - index) * 1_000));
    const expired = expiredTerminalSessions(sessions, NOW);
    expect(expired).toHaveLength(3);
    // Las más antiguas son las primeras del arreglo.
    expect(expired.toSorted()).toEqual(["s0", "s1", "s2"]);
  });

  it("una sesión terminada sin marca de tiempo no se libera a ciegas", () => {
    const sessions: RetainedTerminalSession[] = [{ sessionId: "sin-marca", state: "stopped" }];
    expect(expiredTerminalSessions(sessions, NOW)).toEqual([]);
  });
});
