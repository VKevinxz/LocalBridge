import { randomBytes } from "node:crypto";

import { z } from "zod";
import type { WorkspacePermissions } from "@localbridge/workspace";

import {
  ONBOARDING_STEPS,
  onboardingStateSchema,
  updateOnboardingState,
  type OnboardingState,
  type OnboardingStep,
} from "./onboarding-store.js";

export interface OnboardingEvidence {
  readonly runtimeReady: boolean;
  readonly connectionReady: boolean;
  readonly selectionReady: boolean;
  readonly accessReady: boolean;
  readonly projectReady: boolean;
  readonly trustReady: boolean;
}

export type OnboardingGuidedPreset = "review" | "develop" | "complete";

export function onboardingPermissionPreset(
  trustMode: "guided" | "full-host",
  preset: OnboardingGuidedPreset,
): WorkspacePermissions {
  if (trustMode === "full-host") {
    return {
      read: true, write: true, overwrite: true, gitRead: true, gitWrite: true, validations: true,
      processes: true, browserRead: true, browserInteract: true, browserHumanControl: true,
    };
  }
  if (preset === "review") {
    return {
      read: true, write: false, overwrite: false, gitRead: true, gitWrite: false, validations: false,
      processes: false, browserRead: false, browserInteract: false, browserHumanControl: false,
    };
  }
  return {
    read: true, write: true, overwrite: true, gitRead: true, gitWrite: preset === "complete", validations: true,
    processes: true, browserRead: true, browserInteract: true, browserHumanControl: true,
  };
}

export interface OnboardingRequirement {
  readonly id: "runtime" | "connection" | "selection" | "access" | "project" | "trust";
  readonly ready: boolean;
}

export interface OnboardingSnapshot {
  readonly state: OnboardingState;
  readonly effectiveStep: OnboardingStep;
  readonly redirected: boolean;
  readonly canContinue: boolean;
  readonly canComplete: boolean;
  readonly requirements: readonly OnboardingRequirement[];
}

export class OnboardingGuardError extends Error {
  readonly code = "ONBOARDING_GUARD_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "OnboardingGuardError";
  }
}

function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

function requirementsFor(step: OnboardingStep, evidence: OnboardingEvidence): readonly OnboardingRequirement[] {
  const requirements: OnboardingRequirement[] = [];
  if (stepIndex(step) >= stepIndex("connection")) requirements.push({ id: "runtime", ready: evidence.runtimeReady });
  if (stepIndex(step) >= stepIndex("project")) requirements.push({ id: "connection", ready: evidence.connectionReady });
  if (stepIndex(step) >= stepIndex("access")) {
    requirements.push({ id: "selection", ready: evidence.selectionReady || evidence.projectReady });
  }
  if (stepIndex(step) >= stepIndex("review")) requirements.push({ id: "access", ready: evidence.accessReady });
  return requirements;
}

function firstUnmetStep(state: OnboardingState, evidence: OnboardingEvidence): OnboardingStep | undefined {
  if (state.status === "completed") return undefined;
  if (stepIndex(state.currentStep) >= stepIndex("connection") && !evidence.runtimeReady) return "runtime";
  if (stepIndex(state.currentStep) >= stepIndex("project") && !evidence.connectionReady) return "connection";
  if (stepIndex(state.currentStep) >= stepIndex("access") && !evidence.selectionReady && !evidence.projectReady) return "project";
  if (stepIndex(state.currentStep) >= stepIndex("review") && !evidence.accessReady) return "access";
  return undefined;
}

export function buildOnboardingSnapshot(stateInput: OnboardingState, evidence: OnboardingEvidence): OnboardingSnapshot {
  const state = onboardingStateSchema.parse(stateInput);
  const missingStep = firstUnmetStep(state, evidence);
  const effectiveStep = missingStep ?? state.currentStep;
  const currentRequirements = requirementsFor(effectiveStep, evidence);
  const stepReady = currentRequirements.every((requirement) => requirement.ready);
  const canContinue =
    state.status !== "completed" &&
    (effectiveStep === "welcome" ||
      (effectiveStep === "runtime" && evidence.runtimeReady) ||
      (effectiveStep === "connection" && evidence.connectionReady) ||
      (effectiveStep === "project" && (evidence.selectionReady || evidence.projectReady)) ||
      (effectiveStep === "access" && evidence.accessReady) ||
      (effectiveStep === "review" && stepReady));
  const canComplete =
    state.status !== "completed" &&
    evidence.runtimeReady &&
    evidence.connectionReady &&
    evidence.projectReady &&
    evidence.trustReady;

  return {
    state,
    effectiveStep,
    redirected: effectiveStep !== state.currentStep,
    canContinue,
    canComplete,
    requirements: currentRequirements,
  };
}

export function advanceOnboarding(state: OnboardingState, evidence: OnboardingEvidence, now = new Date()): OnboardingState {
  const snapshot = buildOnboardingSnapshot(state, evidence);
  if (!snapshot.canContinue) throw new OnboardingGuardError("Completa y verifica este paso antes de continuar.");
  if (snapshot.effectiveStep !== state.currentStep) {
    return updateOnboardingState(state, { status: "in_progress", currentStep: snapshot.effectiveStep }, now);
  }
  const index = stepIndex(state.currentStep);
  if (index >= ONBOARDING_STEPS.length - 1) return state;
  return updateOnboardingState(state, { status: "in_progress", currentStep: ONBOARDING_STEPS[index + 1]! }, now);
}

export function backOnboarding(state: OnboardingState, now = new Date()): OnboardingState {
  if (state.status === "completed") throw new OnboardingGuardError("Reinicia la configuración para volver a recorrerla.");
  const index = stepIndex(state.currentStep);
  return updateOnboardingState(
    state,
    { status: index <= 1 ? "not_started" : "in_progress", currentStep: ONBOARDING_STEPS[Math.max(0, index - 1)]! },
    now,
  );
}

export function completeOnboarding(state: OnboardingState, evidence: OnboardingEvidence, projectId: string, now = new Date()): OnboardingState {
  const snapshot = buildOnboardingSnapshot(state, evidence);
  if (!snapshot.canComplete) throw new OnboardingGuardError("La configuración aún no tiene evidencia suficiente para completarse.");
  return updateOnboardingState(
    state,
    { status: "completed", currentStep: "review", selectedProjectId: projectId },
    now,
  );
}

export const folderSelectionIdSchema = z.string().regex(/^folder_[a-f0-9]{32}$/);

export interface FolderSelection<TSummary> {
  readonly id: string;
  readonly ownerId: string;
  readonly rootPath: string;
  readonly summary: TSummary;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class FolderSelectionVault<TSummary> {
  readonly #entries = new Map<string, FolderSelection<TSummary>>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(ownerId: string, rootPath: string, summary: TSummary): FolderSelection<TSummary> {
    this.pruneExpired();
    const createdAt = this.now();
    const selection: FolderSelection<TSummary> = {
      id: `folder_${randomBytes(16).toString("hex")}`,
      ownerId,
      rootPath,
      summary,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.#entries.set(selection.id, selection);
    return selection;
  }

  get(idInput: string, ownerId: string): FolderSelection<TSummary> {
    const id = folderSelectionIdSchema.parse(idInput);
    this.pruneExpired();
    const selection = this.#entries.get(id);
    if (selection === undefined || selection.ownerId !== ownerId) {
      throw new OnboardingGuardError("La selección de carpeta expiró o pertenece a otra ventana.");
    }
    return selection;
  }

  consume(idInput: string, ownerId: string): FolderSelection<TSummary> {
    const selection = this.get(idInput, ownerId);
    this.#entries.delete(selection.id);
    return selection;
  }

  revokeOwner(ownerId: string): void {
    for (const [id, selection] of this.#entries) {
      if (selection.ownerId === ownerId) this.#entries.delete(id);
    }
  }

  pruneExpired(): void {
    const current = this.now();
    for (const [id, selection] of this.#entries) {
      if (selection.expiresAt <= current) this.#entries.delete(id);
    }
  }
}
