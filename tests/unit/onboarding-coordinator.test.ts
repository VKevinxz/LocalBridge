import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_SETTINGS,
  FolderSelectionVault,
  advanceOnboarding,
  backOnboarding,
  buildOnboardingSnapshot,
  completeOnboarding,
  deriveOnboardingState,
  onboardingPermissionPreset,
  updateOnboardingState,
  type OnboardingEvidence,
} from "@localbridge/desktop-core";

const none: OnboardingEvidence = {
  runtimeReady: false,
  connectionReady: false,
  selectionReady: false,
  accessReady: false,
  projectReady: false,
  trustReady: false,
};

describe("onboarding coordinator", () => {
  it("define presets exactos sin conceder Git de escritura por accidente", () => {
    expect(onboardingPermissionPreset("guided", "review")).toMatchObject({
      read: true, gitRead: true, write: false, overwrite: false, gitWrite: false, processes: false,
    });
    expect(onboardingPermissionPreset("guided", "develop")).toMatchObject({
      read: true, write: true, overwrite: true, validations: true, processes: true, gitWrite: false,
    });
    expect(onboardingPermissionPreset("guided", "complete")).toMatchObject({ gitWrite: true });
    expect(Object.values(onboardingPermissionPreset("full-host", "review")).every(Boolean)).toBe(true);
  });

  it("no permite saltar una precondición ni confiar en el renderer", () => {
    const state = updateOnboardingState(deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS), {
      status: "in_progress",
      currentStep: "review",
    });
    const snapshot = buildOnboardingSnapshot(state, none);

    expect(snapshot.effectiveStep).toBe("runtime");
    expect(snapshot.redirected).toBe(true);
    expect(() => advanceOnboarding(state, none)).toThrow(/verifica/i);
  });

  it("avanza solo con evidencia revalidada", () => {
    const welcome = deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS);
    const runtime = advanceOnboarding(welcome, none);
    const connection = advanceOnboarding(runtime, { ...none, runtimeReady: true });

    expect(runtime.currentStep).toBe("runtime");
    expect(connection.currentStep).toBe("connection");
  });

  it("permite volver sin completar ni borrar datos", () => {
    const project = updateOnboardingState(deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS), {
      status: "in_progress",
      currentStep: "project",
    });
    expect(backOnboarding(project)).toMatchObject({ status: "in_progress", currentStep: "connection" });
  });

  it("solo completa con runtime, conexión, proyecto y confianza", () => {
    const review = updateOnboardingState(deriveOnboardingState(DEFAULT_DESKTOP_SETTINGS), {
      status: "in_progress",
      currentStep: "review",
    });
    const ready: OnboardingEvidence = {
      runtimeReady: true,
      connectionReady: true,
      selectionReady: true,
      accessReady: true,
      projectReady: true,
      trustReady: true,
    };
    const completed = completeOnboarding(review, ready, "project_0123456789abcdef01234567");

    expect(completed).toMatchObject({ status: "completed", currentStep: "review" });
    expect(() => completeOnboarding(review, { ...ready, trustReady: false }, "project_0123456789abcdef01234567")).toThrow();
  });
});

describe("FolderSelectionVault", () => {
  it("emite un identificador opaco y no expone la ruta en él", () => {
    const vault = new FolderSelectionVault<{ topology: string }>();
    const selection = vault.create("window-1", "D:\\private\\project", { topology: "repo" });

    expect(selection.id).toMatch(/^folder_[a-f0-9]{32}$/);
    expect(selection.id).not.toContain("private");
    expect(vault.get(selection.id, "window-1").rootPath).toBe("D:\\private\\project");
  });

  it("aísla la selección por ventana y la consume una sola vez", () => {
    const vault = new FolderSelectionVault<Record<string, never>>();
    const selection = vault.create("window-1", "D:\\project", {});

    expect(() => vault.get(selection.id, "window-2")).toThrow(/otra ventana/i);
    expect(vault.consume(selection.id, "window-1").id).toBe(selection.id);
    expect(() => vault.get(selection.id, "window-1")).toThrow(/expiró/i);
  });

  it("expira y revoca selecciones sin persistirlas", () => {
    let current = 10;
    const vault = new FolderSelectionVault<Record<string, never>>(100, () => current);
    const expired = vault.create("window-1", "D:\\one", {});
    current = 111;
    expect(() => vault.get(expired.id, "window-1")).toThrow();

    const active = vault.create("window-1", "D:\\two", {});
    vault.revokeOwner("window-1");
    expect(() => vault.get(active.id, "window-1")).toThrow();
  });
});
