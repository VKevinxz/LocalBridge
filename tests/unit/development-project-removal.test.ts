import { describe, expect, it } from "vitest";

import {
  buildNewApplication,
  buildNewDevelopmentProject,
  migrateDevelopmentProjectsToCatalog,
  planDevelopmentProjectRemoval,
} from "@localbridge/desktop-core";
import { buildWorkspace } from "../helpers/fixtures.js";

const processProfile = {
  command: ["npm", "run", "dev"],
  cwd: ".",
  source: { kind: "package-script" as const, manifestPath: "package.json" as const, script: "dev", definitionSha256: "a".repeat(64) },
  maxRuntimeSeconds: 300,
};

describe("eliminación integral de un desarrollo", () => {
  it("retira workspaces y aplicación exclusivos de LocalBridge", () => {
    const workspace = buildWorkspace({ id: "ws_exclusive", rootPath: "D:\\Proyecto", processProfiles: { dev: processProfile } });
    const application = buildNewApplication({
      name: "Proyecto",
      primaryServiceAlias: "web",
      services: [{ alias: "web", workspaceId: workspace.id, processProfile: "dev", hostMode: "manual-localhost", allowManagedWildcard: false }],
    });
    const project = buildNewDevelopmentProject({ name: "Proyecto", workspaceIds: [workspace.id], applicationId: application.id });
    const registry = { schemaVersion: 5 as const, workspaces: [workspace], applications: [application] };

    const plan = planDevelopmentProjectRemoval({
      projectId: project.id,
      registry,
      developmentProjects: [project],
      catalogProjects: migrateDevelopmentProjectsToCatalog([project], registry),
      setupSessions: [],
    });

    expect(plan).toMatchObject({
      displayName: "Proyecto",
      removableWorkspaceIds: [workspace.id],
      removableApplicationIds: [application.id],
      sharedWorkspaceIds: [],
      sharedApplicationIds: [],
    });
  });

  it("conserva autoridad compartida por otro desarrollo", () => {
    const workspace = buildWorkspace({ id: "ws_shared", rootPath: "D:\\Compartido", processProfiles: { dev: processProfile } });
    const application = buildNewApplication({
      name: "Compartida",
      primaryServiceAlias: "web",
      services: [{ alias: "web", workspaceId: workspace.id, processProfile: "dev", hostMode: "manual-localhost", allowManagedWildcard: false }],
    });
    const target = buildNewDevelopmentProject({ name: "Objetivo", workspaceIds: [workspace.id], applicationId: application.id });
    const survivor = buildNewDevelopmentProject({ name: "Sobrevive", workspaceIds: [workspace.id], applicationId: application.id });
    const registry = { schemaVersion: 5 as const, workspaces: [workspace], applications: [application] };

    const plan = planDevelopmentProjectRemoval({
      projectId: target.id,
      registry,
      developmentProjects: [target, survivor],
      catalogProjects: migrateDevelopmentProjectsToCatalog([target, survivor], registry),
      setupSessions: [],
    });

    expect(plan.removableWorkspaceIds).toEqual([]);
    expect(plan.removableApplicationIds).toEqual([]);
    expect(plan.sharedWorkspaceIds).toEqual([workspace.id]);
    expect(plan.sharedApplicationIds).toEqual([application.id]);
  });

  it("conserva un workspace provisional usado por la preparación de otro desarrollo", () => {
    const workspace = buildWorkspace({ id: "ws_shared_setup", rootPath: "D:\\Preparacion-compartida" });
    const target = buildNewDevelopmentProject({ name: "Objetivo", workspaceIds: [workspace.id] });
    const registry = { schemaVersion: 5 as const, workspaces: [workspace], applications: [] };
    const now = new Date().toISOString();

    const plan = planDevelopmentProjectRemoval({
      projectId: target.id,
      registry,
      developmentProjects: [target],
      catalogProjects: migrateDevelopmentProjectsToCatalog([target], registry),
      setupSessions: [{
        id: "setup_other_project",
        projectId: "project_other",
        provisionalWorkspaceId: workspace.id,
        policy: "compatible",
        initializeGit: false,
        phase: "draft",
        createdAt: now,
        updatedAt: now,
      }],
    });

    expect(plan.removableWorkspaceIds).toEqual([]);
    expect(plan.sharedWorkspaceIds).toEqual([workspace.id]);
  });
});
