import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWrite } from "@localbridge/filesystem";
import { isEnoent } from "@localbridge/shared";
import { z } from "zod";

import type { DesktopSettings } from "./app-settings.js";

export const ONBOARDING_STEPS = ["welcome", "runtime", "connection", "project", "access", "review"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const onboardingStateSchema = z
  .object({
    schemaVersion: z.literal(2),
    flowVersion: z.literal(1),
    status: z.enum(["not_started", "in_progress", "completed"]),
    currentStep: z.enum(ONBOARDING_STEPS),
    selectedConnectionProfileId: z.string().regex(/^profile_[a-z0-9]{8,32}$/).optional(),
    selectedProjectId: z.string().regex(/^project_[a-f0-9]{24}$/).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.status === "completed" && state.completedAt === undefined) {
      context.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt es obligatorio al completar" });
    }
    if (state.status !== "completed" && state.completedAt !== undefined) {
      context.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt solo corresponde al estado completado" });
    }
  });

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export interface OnboardingStateReadResult {
  readonly state: OnboardingState;
  readonly recovered: boolean;
  readonly source: "file" | "legacy";
}

function isoNow(now: Date): string {
  return now.toISOString();
}

function legacyStep(step: number): OnboardingStep {
  if (step <= 0) return "welcome";
  if (step === 1) return "runtime";
  if (step === 2) return "connection";
  if (step === 3) return "project";
  return "review";
}

export function deriveOnboardingState(settings: DesktopSettings, now = new Date()): OnboardingState {
  const timestamp = isoNow(now);
  if (settings.onboardingCompleted) {
    return onboardingStateSchema.parse({
      schemaVersion: 2,
      flowVersion: 1,
      status: "completed",
      currentStep: "review",
      selectedConnectionProfileId: settings.activeConnectionProfileId,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const currentStep = legacyStep(settings.onboardingStep);
  return onboardingStateSchema.parse({
    schemaVersion: 2,
    flowVersion: 1,
    status: currentStep === "welcome" ? "not_started" : "in_progress",
    currentStep,
    selectedConnectionProfileId: settings.activeConnectionProfileId,
    updatedAt: timestamp,
  });
}

export function defaultOnboardingStatePath(): string {
  return path.join(os.homedir(), ".localbridge-mcp", "onboarding-state.json");
}

export async function readOnboardingState(
  statePath: string,
  legacySettings: DesktopSettings,
  now = new Date(),
): Promise<OnboardingStateReadResult> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      return { state: deriveOnboardingState(legacySettings, now), recovered: true, source: "legacy" };
    }
    return { state: deriveOnboardingState(legacySettings, now), recovered: false, source: "legacy" };
  }

  try {
    return { state: onboardingStateSchema.parse(JSON.parse(raw)), recovered: false, source: "file" };
  } catch {
    return { state: deriveOnboardingState(legacySettings, now), recovered: true, source: "legacy" };
  }
}

export async function writeOnboardingState(statePath: string, state: OnboardingState): Promise<void> {
  const validated = onboardingStateSchema.parse(state);
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true });
  await atomicWrite(directory, path.basename(statePath), Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8"));
}

export function updateOnboardingState(
  state: OnboardingState,
  patch: Partial<Pick<OnboardingState, "status" | "currentStep" | "selectedConnectionProfileId" | "selectedProjectId">>,
  now = new Date(),
): OnboardingState {
  const completedAt = patch.status === "completed" ? state.completedAt ?? isoNow(now) : undefined;
  return onboardingStateSchema.parse({
    ...state,
    ...patch,
    completedAt,
    updatedAt: isoNow(now),
  });
}

export function restartOnboardingState(settings: DesktopSettings, now = new Date()): OnboardingState {
  return onboardingStateSchema.parse({
    schemaVersion: 2,
    flowVersion: 1,
    status: "not_started",
    currentStep: "welcome",
    selectedConnectionProfileId: settings.activeConnectionProfileId,
    updatedAt: isoNow(now),
  });
}

export function legacyOnboardingMarkers(state: OnboardingState): Pick<DesktopSettings, "onboardingStep" | "onboardingCompleted"> {
  const legacyByStep: Record<OnboardingStep, number> = {
    welcome: 0,
    runtime: 1,
    connection: 2,
    project: 3,
    access: 3,
    review: 4,
  };
  return {
    onboardingStep: legacyByStep[state.currentStep],
    onboardingCompleted: state.status === "completed",
  };
}
