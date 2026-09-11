import { stat } from "node:fs/promises";

import {
  resolveSafePath,
  type AuthorizedWorkspace,
  type DevelopmentProject,
  type ProcessProfile,
  type SetupPlan,
  type SetupProfileProposal,
  type WorkspaceRegistry,
} from "@localbridge/workspace";
import { buildNewApplication, buildNewWorkspace, replaceRegistry } from "./registry-store.js";
import { upsertDevelopmentProject } from "./development-project-store.js";

export interface FinalizeSetupOptions {
  readonly registryPath: string;
  readonly projectStorePath: string;
  readonly registry: WorkspaceRegistry;
  readonly project: DevelopmentProject;
  readonly plan: SetupPlan;
}

export interface FinalizeSetupResult {
  readonly project: DevelopmentProject;
  readonly workspaces: readonly AuthorizedWorkspace[];
  readonly applicationId?: string;
}

function relativeFromRoot(value: string, root: string): string {
  if (root === ".") return value;
  if (value === root) return ".";
  if (!value.startsWith(`${root}/`)) throw new Error("SETUP_TOPOLOGY_MISMATCH");
  return value.slice(root.length + 1) || ".";
}

function rootForProposal(proposal: SetupProfileProposal, roots: readonly string[]): string {
  return roots
    .filter((root) => root === "." || proposal.cwd === root || proposal.cwd.startsWith(`${root}/`))
    .toSorted((left, right) => right.length - left.length)[0] ?? ".";
}

function commandFor(proposal: SetupProfileProposal): readonly string[] {
  if (proposal.runner === "composer") return ["composer", "run-script", proposal.entry];
  if (proposal.runner === "make") return ["make", proposal.entry];
  return [proposal.runner, "run", proposal.entry];
}

function profileFor(proposal: SetupProfileProposal, root: string): ProcessProfile {
  const manifestPath = relativeFromRoot(proposal.manifestPath, root);
  const common = {
    command: commandFor(proposal),
    cwd: relativeFromRoot(proposal.cwd, root),
    maxRuntimeSeconds: proposal.role === "server" ? 7_200 : 600,
  };
  if (proposal.sourceKind === "make-target") {
    return { ...common, source: { kind: "make-target", manifestPath, target: proposal.entry, definitionSha256: proposal.definitionSha256 } };
  }
  if (proposal.sourceKind === "composer-script") {
    return { ...common, source: { kind: "composer-script", manifestPath, script: proposal.entry, definitionSha256: proposal.definitionSha256 } };
  }
  return { ...common, source: { kind: "package-script", manifestPath, script: proposal.entry, definitionSha256: proposal.definitionSha256 } };
}

function uniqueWorkspaceName(base: string, used: Set<string>): string {
  let candidate = base.slice(0, 80) || "Servicio";
  let index = 2;
  while (used.has(candidate.toLocaleLowerCase("en-US"))) {
    const suffix = ` ${index}`;
    candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    index += 1;
  }
  used.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

export async function finalizeSetupPlan(options: FinalizeSetupOptions): Promise<FinalizeSetupResult> {
  const provisional = options.registry.workspaces.find((workspace) => workspace.id === options.project.workspaceIds[0]);
  if (provisional === undefined || !provisional.enabled) throw new Error("SETUP_WORKSPACE_MISSING");
  if (options.plan.projectId !== options.project.id) throw new Error("SETUP_PLAN_PROJECT_MISMATCH");

  const roots = options.plan.proposedWorkspaceRoots;
  const usedNames = new Set(options.registry.workspaces.map((workspace) => workspace.name.toLocaleLowerCase("en-US")));
  const workspaceByRoot = new Map<string, AuthorizedWorkspace>();
  if (roots.length === 1 && roots[0] === ".") {
    workspaceByRoot.set(".", provisional);
  } else {
    for (const root of roots) {
      if (root === ".") throw new Error("SETUP_TOPOLOGY_MISMATCH");
      const safe = await resolveSafePath(provisional.rootPath, root);
      if (!safe.exists || !(await stat(safe.realPath)).isDirectory()) throw new Error("SETUP_TOPOLOGY_MISMATCH");
      const leaf = root.split("/").at(-1) ?? "Servicio";
      const child = buildNewWorkspace({
        name: uniqueWorkspaceName(`${options.project.name} — ${leaf}`, usedNames),
        rootPath: safe.realPath,
        permissions: provisional.permissions,
        validationProfiles: {},
        processProfiles: {},
        browserProfiles: {},
      });
      workspaceByRoot.set(root, child);
    }
  }

  const profileLocations = new Map<string, { workspaceId: string; profileName: string }>();
  const updatedById = new Map<string, AuthorizedWorkspace>();
  for (const [root, base] of workspaceByRoot) {
    const proposals = options.plan.proposedProfiles.filter((proposal) => rootForProposal(proposal, roots) === root);
    const processProfiles = { ...base.processProfiles };
    const validationProfiles = { ...base.validationProfiles };
    for (const proposal of proposals) {
      const profile = profileFor(proposal, root);
      if (proposal.role === "server") processProfiles[proposal.name] = profile;
      else validationProfiles[proposal.name] = [...profile.command];
      profileLocations.set(proposal.id, { workspaceId: base.id, profileName: proposal.name });
    }
    updatedById.set(base.id, { ...base, processProfiles, validationProfiles, automationReviewRequired: false });
  }

  let application = undefined;
  if (options.plan.proposedApplication !== undefined) {
    const proposal = options.plan.proposedApplication;
    const services = proposal.services.map((service) => {
      const location = profileLocations.get(service.profileProposalId);
      if (location === undefined) throw new Error("SETUP_APPLICATION_MISMATCH");
      return {
        alias: service.alias,
        workspaceId: location.workspaceId,
        processProfile: location.profileName,
        hostMode: service.hostMode,
        allowManagedWildcard: service.allowManagedWildcard,
      };
    });
    const primaryProposal = proposal.services.find((service) => service.profileProposalId === proposal.primaryProfileProposalId);
    if (primaryProposal === undefined) throw new Error("SETUP_APPLICATION_MISMATCH");
    application = buildNewApplication({
      name: proposal.name,
      primaryServiceAlias: primaryProposal.alias,
      services,
      reviewState: "needs-review",
    });
  }

  const isSplit = !(roots.length === 1 && roots[0] === ".");
  const nextWorkspaces = options.registry.workspaces.map((workspace) => {
    if (workspace.id === provisional.id && isSplit) return { ...workspace, enabled: false };
    return updatedById.get(workspace.id) ?? workspace;
  });
  if (isSplit) nextWorkspaces.push(...updatedById.values());
  const nextRegistry: WorkspaceRegistry = {
    schemaVersion: 5,
    workspaces: nextWorkspaces,
    applications: application === undefined ? options.registry.applications : [...options.registry.applications, application],
  };
  const now = new Date().toISOString();
  const nextProject: DevelopmentProject = {
    ...options.project,
    workspaceIds: [...updatedById.keys()],
    ...(application === undefined ? {} : { applicationId: application.id }),
    setupStatus: application === undefined ? "ready" : "review-required",
    updatedAt: now,
  };

  // Publicamos primero una referencia deliberadamente interrumpida. Si el proceso termina
  // antes de reemplazar el registro, el workspace provisional continúa intacto; si termina
  // justo después, las nuevas entidades existen pero el proyecto no se declara listo.
  // Solo el último write promueve el estado final.
  const pendingProject: DevelopmentProject = { ...nextProject, setupStatus: "interrupted" };
  await upsertDevelopmentProject(options.projectStorePath, nextRegistry, pendingProject);
  let registryPublished = false;
  try {
    await replaceRegistry(options.registryPath, nextRegistry);
    registryPublished = true;
    await upsertDevelopmentProject(options.projectStorePath, nextRegistry, nextProject);
  } catch (error) {
    // Una falla ordinaria se compensa restaurando el proyecto anterior contra el
    // registro anterior. Si el rollback del registro no fuera posible, conservamos la
    // referencia interrupted: nunca declaramos listo un estado cuya atomicidad no pudimos
    // demostrar.
    let registryRestored = !registryPublished;
    if (registryPublished) {
      try {
        await replaceRegistry(options.registryPath, options.registry);
        registryRestored = true;
      } catch {
        registryRestored = false;
      }
    }
    if (registryRestored) {
      await upsertDevelopmentProject(options.projectStorePath, options.registry, options.project);
    }
    throw error;
  }
  return {
    project: nextProject,
    workspaces: [...updatedById.values()],
    ...(application === undefined ? {} : { applicationId: application.id }),
  };
}
