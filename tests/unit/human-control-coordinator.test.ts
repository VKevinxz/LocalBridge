import { describe, expect, it } from "vitest";

import {
  HumanControlCoordinator,
  HumanControlCoordinatorError,
} from "../../apps/desktop/src/main/human-control-coordinator.js";

describe("coordinador global de control humano", () => {
  it("permite repetir la misma reserva y excluye otra familia", () => {
    const coordinator = new HumanControlCoordinator();
    const web = { kind: "web" as const, sessionId: `websession_${"a".repeat(24)}` };
    coordinator.reserve(web);
    coordinator.reserve(web);
    expect(coordinator.current()).toEqual(web);
    expect(() => coordinator.reserve({
      kind: "development",
      sessionId: `session_${"b".repeat(24)}`,
    })).toThrow(HumanControlCoordinatorError);
  });

  it("una liberación ajena no roba la reserva vigente", () => {
    const coordinator = new HumanControlCoordinator();
    const web = { kind: "web" as const, sessionId: `websession_${"a".repeat(24)}` };
    coordinator.reserve(web);
    coordinator.release({ kind: "development", sessionId: `session_${"b".repeat(24)}` });
    expect(coordinator.current()).toEqual(web);
    coordinator.release(web);
    expect(coordinator.current()).toBeUndefined();
  });
});
