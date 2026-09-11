import type {
  DevelopmentProject,
  ProjectCatalogRecord,
  ProjectSetupSession,
  WorkspaceRegistry,
} from "@localbridge/workspace";

export interface DevelopmentProjectRemovalPlan {
  readonly projectId: string;
  readonly displayName: string;
  readonly selectedRoot?: string;
  readonly workspaceIds: readonly string[];
  readonly applicationIds: readonly string[];
  readonly removableWorkspaceIds: readonly string[];
  readonly removableApplicationIds: readonly string[];
  readonly sharedWorkspaceIds: readonly string[];
  readonly sharedApplicationIds: readonly string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}

function workspaceReferences(project: ProjectCatalogRecord): string[] {
  return [
    ...project.compatibilityRefs.filter((reference) => reference.kind === "workspace").map((reference) => reference.id),
    ...project.nodes.flatMap((node) => node.workspaceId === undefined ? [] : [node.workspaceId]),
  ];
}

function applicationReferences(project: ProjectCatalogRecord): string[] {
  return project.compatibilityRefs.filter((reference) => reference.kind === "application").map((reference) => reference.id);
}

/**
 * Calcula qué autoridad pertenece únicamente a una ficha. Los workspaces y
 * aplicaciones compartidos quedan fuera del borrado para no romper otros
 * desarrollos que continúan autorizados.
 */
export function planDevelopmentProjectRemoval(input: {
  readonly projectId: string;
  readonly registry: WorkspaceRegistry;
  readonly developmentProjects: readonly DevelopmentProject[];
  readonly catalogProjects: readonly ProjectCatalogRecord[];
  readonly setupSessions: readonly ProjectSetupSession[];
}): DevelopmentProjectRemovalPlan {
  const targetDevelopment = input.developmentProjects.find((project) => project.id === input.projectId);
  const targetCatalog = input.catalogProjects.find((project) => project.id === input.projectId);
  if (targetDevelopment === undefined && targetCatalog === undefined) throw new Error("El desarrollo no existe.");

  const workspaceIds = sorted([
    ...(targetDevelopment?.workspaceIds ?? []),
    ...(targetCatalog === undefined ? [] : workspaceReferences(targetCatalog)),
    ...input.setupSessions.filter((session) => session.projectId === input.projectId).map((session) => session.provisionalWorkspaceId),
  ]);
  const applicationIds = sorted([
    ...(targetDevelopment?.applicationId === undefined ? [] : [targetDevelopment.applicationId]),
    ...(targetCatalog === undefined ? [] : applicationReferences(targetCatalog)),
  ]);

  const otherDevelopment = input.developmentProjects.filter((project) => project.id !== input.projectId);
  const otherCatalog = input.catalogProjects.filter((project) => project.id !== input.projectId);
  const referencedWorkspaces = new Set([
    ...otherDevelopment.flatMap((project) => project.workspaceIds),
    ...otherCatalog.flatMap(workspaceReferences),
    ...input.setupSessions
      .filter((session) => session.projectId !== input.projectId)
      .map((session) => session.provisionalWorkspaceId),
  ]);
  const referencedApplications = new Set([
    ...otherDevelopment.flatMap((project) => project.applicationId === undefined ? [] : [project.applicationId]),
    ...otherCatalog.flatMap(applicationReferences),
  ]);

  const removableApplicationIds = applicationIds.filter((applicationId) =>
    input.registry.applications.some((application) => application.id === applicationId) && !referencedApplications.has(applicationId));
  const removableApplicationSet = new Set(removableApplicationIds);
  const retainedApplicationWorkspaces = new Set(input.registry.applications
    .filter((application) => !removableApplicationSet.has(application.id))
    .flatMap((application) => application.services.map((service) => service.workspaceId)));
  const removableWorkspaceIds = workspaceIds.filter((workspaceId) =>
    input.registry.workspaces.some((workspace) => workspace.id === workspaceId)
      && !referencedWorkspaces.has(workspaceId)
      && !retainedApplicationWorkspaces.has(workspaceId));

  return {
    projectId: input.projectId,
    displayName: targetCatalog?.displayName ?? targetDevelopment!.name,
    ...(targetCatalog?.selectedRoot === undefined ? {} : { selectedRoot: targetCatalog.selectedRoot }),
    workspaceIds,
    applicationIds,
    removableWorkspaceIds,
    removableApplicationIds,
    sharedWorkspaceIds: workspaceIds.filter((workspaceId) => !removableWorkspaceIds.includes(workspaceId)),
    sharedApplicationIds: applicationIds.filter((applicationId) => !removableApplicationIds.includes(applicationId)),
  };
}
