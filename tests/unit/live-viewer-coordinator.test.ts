import { describe, expect, it, vi } from "vitest";

import {
  LiveViewerCoordinator,
  LiveViewerCoordinatorError,
} from "../../apps/desktop/src/main/live-viewer-coordinator.js";

describe("coordinador local de vistas en vivo", () => {
  it("alterna presentación sin detener ninguna sesión", async () => {
    const hideDevelopment = vi.fn(async () => undefined);
    const hideWeb = vi.fn(async () => undefined);
    const coordinator = new LiveViewerCoordinator({ hideDevelopment, hideWeb, hasHumanControl: () => false });

    await expect(coordinator.show({ kind: "development", sessionId: "session_1" }, async () => undefined)).resolves.toBe(true);
    await expect(coordinator.show({ kind: "web", sessionId: "websession_1" }, async () => undefined)).resolves.toBe(true);

    expect(hideDevelopment).toHaveBeenCalledWith("session_1");
    expect(hideWeb).not.toHaveBeenCalled();
    expect(coordinator.current()).toEqual({ kind: "web", sessionId: "websession_1" });
  });

  it("bloquea apertura durante control humano y no adopta una respuesta obsoleta", async () => {
    let humanControl = true;
    const hideWeb = vi.fn(async () => undefined);
    const coordinator = new LiveViewerCoordinator({
      hideDevelopment: async () => undefined,
      hideWeb,
      hasHumanControl: () => humanControl,
    });
    await expect(coordinator.show({ kind: "web", sessionId: "websession_private" }, async () => undefined))
      .rejects.toBeInstanceOf(LiveViewerCoordinatorError);

    humanControl = false;
    let releaseDisplay!: () => void;
    const displayBlocked = new Promise<void>((resolve) => { releaseDisplay = resolve; });
    const pending = coordinator.show({ kind: "web", sessionId: "websession_old" }, () => displayBlocked);
    await Promise.resolve();
    coordinator.release({ kind: "web", sessionId: "websession_old" });
    releaseDisplay();
    await expect(pending).resolves.toBe(false);
    expect(hideWeb).toHaveBeenCalledWith("websession_old");
    expect(coordinator.current()).toBeUndefined();
  });

  it("liberar el destino visible anterior no cancela otro destino pendiente", async () => {
    const coordinator = new LiveViewerCoordinator({
      hideDevelopment: async () => undefined,
      hideWeb: async () => undefined,
      hasHumanControl: () => false,
    });
    const development = { kind: "development" as const, sessionId: "session_old" };
    const web = { kind: "web" as const, sessionId: "websession_new" };
    await coordinator.show(development, async () => undefined);
    const pending = coordinator.show(web, async () => undefined);
    coordinator.release(development);
    await expect(pending).resolves.toBe(true);
    expect(coordinator.current()).toEqual(web);
  });

  it("no conserva como actual un destino oculto si falla la nueva apertura", async () => {
    const hideDevelopment = vi.fn(async () => undefined);
    const hideWeb = vi.fn(async () => undefined);
    const coordinator = new LiveViewerCoordinator({ hideDevelopment, hideWeb, hasHumanControl: () => false });
    await coordinator.show({ kind: "development", sessionId: "session_old" }, async () => undefined);

    await expect(coordinator.show(
      { kind: "web", sessionId: "websession_failed" },
      async () => { throw new Error("display failed"); },
    )).rejects.toThrow("display failed");

    expect(hideDevelopment).toHaveBeenCalledWith("session_old");
    expect(hideWeb).toHaveBeenCalledWith("websession_failed");
    expect(coordinator.current()).toBeUndefined();
  });

  it("limpia el destino si comienza control humano al terminar de mostrar", async () => {
    let humanControl = false;
    const hideWeb = vi.fn(async () => undefined);
    const target = { kind: "web" as const, sessionId: "websession_race" };
    const coordinator = new LiveViewerCoordinator({
      hideDevelopment: async () => undefined,
      hideWeb,
      hasHumanControl: () => humanControl,
    });
    await coordinator.show(target, async () => undefined);

    await expect(coordinator.show(target, async () => { humanControl = true; }))
      .rejects.toBeInstanceOf(LiveViewerCoordinatorError);

    expect(hideWeb).toHaveBeenCalledWith("websession_race");
    expect(coordinator.current()).toBeUndefined();
  });
});
