/**
 * Esquemas de la frontera IPC de Electron.
 *
 * El renderer no es una autoridad: aunque hoy solo carga contenido local, toda
 * entrada que cruza `contextBridge` se considera no confiable y se valida antes
 * de tocar disco, configuración o procesos.
 */

import path from "node:path";
import net from "node:net";

import { z } from "zod";

import {
  developmentProjectSchema,
  localApplicationSchema,
  localApplicationServiceSchema,
  projectTrustModeSchema,
  setupPolicySchema,
  workspaceSchema,
} from "@localbridge/workspace";
import { webProfileIdSchema, webProfileSchema } from "./web-profile-store.js";

export const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "se requiere una ruta absoluta");

export const workspaceIdInputSchema = workspaceSchema.shape.id;
export const analysisJobTargetInputSchema = z.object({
  workspaceId: workspaceIdInputSchema,
  jobId: z.string().regex(/^job_[a-f0-9]{24}$/),
}).strict();
export const applicationIdInputSchema = localApplicationSchema.shape.id;
export const browserSessionIdInputSchema = z.string().regex(/^session_[a-f0-9]{24}$/);
export const displayIdInputSchema = z.string().regex(/^-?\d{1,20}$/);
export const viewerPresentationModeSchema = z.enum(["fit", "actual"]);
export const liveViewerTargetInputSchema = z.object({
  sessionId: browserSessionIdInputSchema,
  displayId: displayIdInputSchema.optional(),
  presentationMode: viewerPresentationModeSchema.optional(),
}).strict();
export const liveViewerMoveInputSchema = z.object({
  sessionId: browserSessionIdInputSchema,
  displayId: displayIdInputSchema,
}).strict();
export const liveViewerPresentationInputSchema = z.object({
  sessionId: browserSessionIdInputSchema,
  mode: viewerPresentationModeSchema,
  panX: z.number().int().min(0).max(3840).default(0),
  panY: z.number().int().min(0).max(2160).default(0),
}).strict();
export const browserMotionCancelInputSchema = z.object({ sessionId: browserSessionIdInputSchema }).strict();
export const browserViewportInputSchema = z.object({
  workspaceId: workspaceIdInputSchema,
  sessionId: browserSessionIdInputSchema,
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
  mobile: z.boolean(),
}).strict();

export const newWorkspaceInputSchema = z
  .object({
    name: workspaceSchema.shape.name,
    rootPath: absolutePathSchema,
    permissions: workspaceSchema.shape.permissions,
    maxFileBytes: z.number().int().min(1_048_576).max(25 * 1024 * 1024).optional(),
    largeArtifacts: workspaceSchema.shape.limits.unwrap().shape.largeArtifacts.optional(),
    validationProfiles: workspaceSchema.shape.validationProfiles.optional(),
    processProfiles: workspaceSchema.shape.processProfiles.optional(),
    browserProfiles: workspaceSchema.shape.browserProfiles.optional(),
    automationReviewRequired: workspaceSchema.shape.automationReviewRequired.optional(),
  })
  .strict();

export const authorizedWorkspaceInputSchema = workspaceSchema
  .safeExtend({
    rootPath: absolutePathSchema,
  })
  .strict();

const newApplicationServiceInputSchema = z.object({
  alias: localApplicationServiceSchema.shape.alias,
  workspaceId: localApplicationServiceSchema.shape.workspaceId,
  processProfile: localApplicationServiceSchema.shape.processProfile,
  hostMode: localApplicationServiceSchema.shape.hostMode,
  allowManagedWildcard: localApplicationServiceSchema.shape.allowManagedWildcard,
}).strict();
export const newApplicationInputSchema = z.object({
  name: localApplicationSchema.shape.name,
  description: localApplicationSchema.shape.description.optional(),
  primaryServiceAlias: newApplicationServiceInputSchema.shape.alias,
  services: z.array(newApplicationServiceInputSchema).min(1).max(8),
  viewport: localApplicationSchema.shape.viewport.optional(),
  reviewState: localApplicationSchema.shape.reviewState.optional(),
}).strict();
export const localApplicationInputSchema = localApplicationSchema;

export const developmentProjectIdInputSchema = developmentProjectSchema.shape.id;
export const onboardingGuidedPresetSchema = z.enum(["review", "develop", "complete"]);
export const onboardingAccessInputSchema = z
  .object({
    trustMode: projectTrustModeSchema,
    guidedPreset: onboardingGuidedPresetSchema,
  })
  .strict();
export const onboardingCompletionInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selection"),
      folderSelectionId: z.string().regex(/^folder_[a-f0-9]{32}$/),
      name: developmentProjectSchema.shape.name,
      description: developmentProjectSchema.shape.description.optional(),
      trustMode: projectTrustModeSchema,
      guidedPreset: onboardingGuidedPresetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing"),
      projectId: developmentProjectSchema.shape.id,
      trustMode: projectTrustModeSchema,
      guidedPreset: onboardingGuidedPresetSchema,
    })
    .strict(),
]);
export const terminalSessionIdInputSchema = z.string().regex(/^terminal_[a-f0-9]{24}$/);
export const listenerRefInputSchema = z.string().regex(/^listener_[a-f0-9]{24}$/);
export const terminalSessionTargetInputSchema = z.object({
  projectId: developmentProjectIdInputSchema,
  terminalSessionId: terminalSessionIdInputSchema,
}).strict();
export const terminalListenerTargetInputSchema = terminalSessionTargetInputSchema.extend({
  listenerRef: listenerRefInputSchema,
}).strict();
export const newAssistedProjectInputSchema = z.object({
  name: developmentProjectSchema.shape.name,
  description: developmentProjectSchema.shape.description.optional(),
  rootPath: absolutePathSchema,
  permissions: workspaceSchema.shape.permissions,
  policy: setupPolicySchema,
  initializeGit: z.boolean().default(false),
}).strict();
export const setupReviewInputSchema = z.object({
  projectId: developmentProjectIdInputSchema,
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const setupPolicyInputSchema = z.object({
  projectId: developmentProjectIdInputSchema,
  policy: setupPolicySchema,
}).strict();
export const adoptDevelopmentProjectInputSchema = z.object({
  name: developmentProjectSchema.shape.name,
  description: developmentProjectSchema.shape.description.optional(),
  workspaceIds: z.array(workspaceIdInputSchema).min(1).max(16),
  applicationId: applicationIdInputSchema.optional(),
}).strict();

export const tunnelApiKeyInputSchema = z
  .string()
  .max(16_384)
  .refine((value) => value.trim().length > 0, "la clave no puede estar vacía");

export const externalDestinationSchema = z.enum(["tunnels", "runtimeKeys", "chatgptConnectors"]);
export type ExternalDestination = z.infer<typeof externalDestinationSchema>;

export const diagnosticTextSchema = z.string().max(256 * 1024);

export const connectionProfileNameSchema = z.string().trim().min(1).max(80);
export const portableImportSessionIdSchema = z.string().uuid();
export const portableWorkspaceRefSchema = z.string().regex(/^portable_[a-f0-9]{16}$/);
export const auditQuerySchema = z
  .object({
    workspaceId: workspaceIdInputSchema.optional(),
    action: z.string().regex(/^[a-z]+(?:[._][a-z]+)*$/).optional(),
    outcome: z.enum(["success", "error"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const nullableSha256Schema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const webHostnameInputSchema = z.string().trim().toLowerCase().max(253).refine((value) =>
  value.includes(".") && net.isIP(value) === 0 && !value.endsWith(".") && value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
"se requiere un hostname DNS");

export const webProfileCreateInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public-research"), name: z.string().trim().min(1).max(80).default("Investigación pública") }).strict(),
  z.object({
    kind: z.literal("site-account"),
    name: z.string().trim().min(1).max(80),
    destinations: z.array(webHostnameInputSchema).min(1).max(100),
    supportHosts: z.array(webHostnameInputSchema).max(200).default([]),
  }).strict(),
]);
export const webProfileUpdateInputSchema = z.object({
  expectedSha256: nullableSha256Schema,
  profile: webProfileSchema,
}).strict();
export const webProfileRemoveInputSchema = z.object({
  expectedSha256: nullableSha256Schema,
  webProfileId: webProfileIdSchema,
}).strict();
export const webProfileResetInputSchema = z.object({ expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const webProfileEnableInternetInputSchema = z.object({
  expectedSha256: nullableSha256Schema,
  download: z.boolean().default(false),
}).strict();
export const webHumanSessionInputSchema = z.string().regex(/^websession_[a-f0-9]{24}$/);
export const webSessionIdInputSchema = webHumanSessionInputSchema;
export const webTabIdInputSchema = z.string().regex(/^webtab_[a-f0-9]{24}$/);
export const webHumanTakeInputSchema = z.object({
  sessionId: webSessionIdInputSchema,
  tabId: webTabIdInputSchema.optional(),
}).strict();
export const webHumanCycleInputSchema = z.object({
  sessionId: webSessionIdInputSchema,
  direction: z.enum(["previous", "next"]),
}).strict();
export const webViewerStateInputSchema = z.object({}).strict();
export const webTabsInputSchema = z.object({ sessionId: webSessionIdInputSchema }).strict();
export const webLiveViewerShowInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("follow"),
    sessionId: webSessionIdInputSchema,
    displayId: displayIdInputSchema.optional(),
    presentationMode: viewerPresentationModeSchema.optional(),
  }).strict(),
  z.object({
    mode: z.literal("pinned"),
    sessionId: webSessionIdInputSchema,
    tabId: webTabIdInputSchema,
    displayId: displayIdInputSchema.optional(),
    presentationMode: viewerPresentationModeSchema.optional(),
  }).strict(),
]);
export const webLiveViewerHideInputSchema = z.object({ sessionId: webSessionIdInputSchema }).strict();
export const webLiveViewerMoveInputSchema = z.object({
  sessionId: webSessionIdInputSchema,
  displayId: displayIdInputSchema,
}).strict();
export const webLiveViewerPresentationInputSchema = z.object({
  sessionId: webSessionIdInputSchema,
  mode: viewerPresentationModeSchema,
  panX: z.number().int().min(0).max(3840).default(0),
  panY: z.number().int().min(0).max(2160).default(0),
}).strict();
export const webMotionCancelInputSchema = z.object({
  sessionId: webSessionIdInputSchema,
  tabId: webTabIdInputSchema,
}).strict();
export const webViewportInputSchema = z.object({
  sessionId: webSessionIdInputSchema,
  tabId: webTabIdInputSchema,
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
  mobile: z.boolean(),
}).strict();
