/**
 * Esquemas de la frontera IPC de Electron.
 *
 * El renderer no es una autoridad: aunque hoy solo carga contenido local, toda
 * entrada que cruza `contextBridge` se considera no confiable y se valida antes
 * de tocar disco, configuración o procesos.
 */

import path from "node:path";

import { z } from "zod";

import {
  developmentProjectSchema,
  localApplicationSchema,
  localApplicationServiceSchema,
  projectTrustModeSchema,
  setupPolicySchema,
  workspaceSchema,
} from "@localbridge/workspace";

export const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "se requiere una ruta absoluta");

export const workspaceIdInputSchema = workspaceSchema.shape.id;
export const applicationIdInputSchema = localApplicationSchema.shape.id;
export const browserSessionIdInputSchema = z.string().regex(/^session_[a-f0-9]{24}$/);
export const displayIdInputSchema = z.string().regex(/^-?\d{1,20}$/);
export const liveViewerTargetInputSchema = z.object({
  sessionId: browserSessionIdInputSchema,
  displayId: displayIdInputSchema.optional(),
}).strict();
export const liveViewerMoveInputSchema = z.object({
  sessionId: browserSessionIdInputSchema,
  displayId: displayIdInputSchema,
}).strict();

export const newWorkspaceInputSchema = z
  .object({
    name: workspaceSchema.shape.name,
    rootPath: absolutePathSchema,
    permissions: workspaceSchema.shape.permissions,
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
