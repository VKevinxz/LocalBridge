import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_SETTINGS,
  deriveOnboardingState,
  legacyOnboardingMarkers,
  readOnboardingState,
  restartOnboardingState,
  updateOnboardingState,
  writeOnboardingState,
} from "@localbridge/desktop-core";

let statePath: string;
const now = new Date("2026-08-27T12:00:00.000Z");

beforeEach(() => {
  statePath = path.join(os.tmpdir(), `localbridge-onboarding-${randomUUID()}`, "onboarding-state.json");
});

describe("onboarding state", () => {
  it("deriva una instalación limpia sin tocar desktop-settings", async () => {
    const result = await readOnboardingState(statePath, DEFAULT_DESKTOP_SETTINGS, now);

    expect(result.source).toBe("legacy");
    expect(result.recovered).toBe(false);
    expect(result.state).toMatchObject({ status: "not_started", currentStep: "welcome" });
  });

  it("migra una instalación v1.0.3 completada sin volver a mostrar el asistente", () => {
    const state = deriveOnboardingState(
      { ...DEFAULT_DESKTOP_SETTINGS, onboardingCompleted: true, onboardingStep: 4 },
      now,
    );

    expect(state).toMatchObject({ status: "completed", currentStep: "review", completedAt: now.toISOString() });
    expect(legacyOnboardingMarkers(state)).toEqual({ onboardingStep: 4, onboardingCompleted: true });
  });

  it.each([
    [0, "welcome"],
    [1, "runtime"],
    [2, "connection"],
    [3, "project"],
    [4, "review"],
  ] as const)("migra el paso legacy %i a %s", (legacyStep, expectedStep) => {
    expect(deriveOnboardingState({ ...DEFAULT_DESKTOP_SETTINGS, onboardingStep: legacyStep }, now).currentStep).toBe(expectedStep);
  });

  it("conserva compatibilidad de downgrade mediante marcadores legacy", () => {
    const access = updateOnboardingState(deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS, now), {
      status: "in_progress",
      currentStep: "access",
    });

    expect(legacyOnboardingMarkers(access)).toEqual({ onboardingStep: 3, onboardingCompleted: false });
  });

  it("escribe y relee el estado v2 de forma independiente", async () => {
    const state = updateOnboardingState(deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS, now), {
      status: "in_progress",
      currentStep: "connection",
    }, now);
    await writeOnboardingState(statePath, state);

    await expect(readOnboardingState(statePath, DEFAULT_DESKTOP_SETTINGS, now)).resolves.toEqual({
      state,
      recovered: false,
      source: "file",
    });
  });

  it("falla seguro y recupera desde legacy si el fichero está corrupto", async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{broken", "utf8");

    const result = await readOnboardingState(
      statePath,
      { ...DEFAULT_DESKTOP_SETTINGS, onboardingCompleted: true, onboardingStep: 4 },
      now,
    );
    expect(result.recovered).toBe(true);
    expect(result.state.status).toBe("completed");
  });

  it("reinicia solo el flujo y no incorpora rutas ni secretos", () => {
    const state = restartOnboardingState(DEFAULT_DESKTOP_SETTINGS, now);
    expect(state).toMatchObject({ status: "not_started", currentStep: "welcome" });
    expect(JSON.stringify(state)).not.toMatch(/root|path|key|token|secret/i);
  });

  it("rechaza estado que intente persistir rutas, claves o evidencia volátil", async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        ...deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS, now),
        rootPath: "D:\\private",
        apiKey: "secret",
        runtimeReady: true,
      }),
      "utf8",
    );

    const recovered = await readOnboardingState(statePath, DEFAULT_DESKTOP_SETTINGS, now);
    expect(recovered.recovered).toBe(true);
    expect(JSON.stringify(recovered.state)).not.toContain("private");
    expect(JSON.stringify(recovered.state)).not.toContain("secret");
  });

  it("el estado v2 no altera el fichero legacy y permite volver a v1.0.3", async () => {
    const legacyPath = path.join(path.dirname(statePath), "desktop-settings.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ ...DEFAULT_DESKTOP_SETTINGS, onboardingStep: 3 }), { encoding: "utf8", flag: "wx" });
    await writeOnboardingState(statePath, updateOnboardingState(deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS, now), {
      status: "in_progress",
      currentStep: "access",
    }, now));

    const rawLegacy = JSON.parse(await (await import("node:fs/promises")).readFile(legacyPath, "utf8")) as Record<string, unknown>;
    expect(rawLegacy["onboardingStep"]).toBe(3);
    expect(rawLegacy["schemaVersion"]).toBeUndefined();
  });
});
