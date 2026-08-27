import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  resolveSafePath,
  setupPlanSchema,
  type DevelopmentProject,
  type SetupApplicationProposal,
  type SetupPlan,
  type SetupPolicy,
  type SetupProfileProposal,
  type WorkspaceRegistry,
} from "@localbridge/workspace";
import type { ProjectTopology, TopologyCommand } from "./project-topology-detector.js";

export interface SetupToolchainEvidence {
  readonly manager: "npm" | "pnpm" | "yarn" | "git";
  readonly executableSha256: string;
  readonly version: string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicId(seed: string): string {
  return `proposal_${digest(seed).slice(0, 24)}`;
}

function profileBaseName(command: TopologyCommand): string {
  const cwd = command.processProfile.cwd;
  const scope = cwd === "." ? "" : `${cwd.split("/").at(-1) ?? "service"}.`;
  return `${scope}${command.name}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
}

function uniqueProfileNames(commands: readonly TopologyCommand[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const command of commands) {
    const base = profileBaseName(command) || "profile";
    let candidate = base;
    let index = 2;
    while (used.has(candidate.toLocaleLowerCase("en-US"))) {
      const suffix = `-${index}`;
      candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      index += 1;
    }
    used.add(candidate.toLocaleLowerCase("en-US"));
    names.set(command.id, candidate);
  }
  return names;
}

function proposalsForTopology(project: DevelopmentProject, topology: ProjectTopology): SetupProfileProposal[] {
  const names = uniqueProfileNames(topology.commands);
  const workspaceId = project.workspaceIds[0]!;
  return topology.commands.map((command) => {
    const source = command.processProfile.source;
    return {
      id: deterministicId(`${project.id}:${source.manifestPath}:${command.name}:${command.role}`),
      workspaceId,
      name: names.get(command.id)!,
      role: command.role === "server" ? "server" : "validation",
      runner: command.processProfile.command[0] === "pnpm"
        ? "pnpm"
        : command.processProfile.command[0] === "yarn"
          ? "yarn"
          : command.processProfile.command[0] === "composer"
            ? "composer"
            : command.processProfile.command[0] === "make"
              ? "make"
              : "npm",
      sourceKind: source.kind,
      manifestPath: source.manifestPath,
      entry: source.kind === "make-target" ? source.target : source.script,
      definitionSha256: source.definitionSha256,
      cwd: command.processProfile.cwd,
    };
  });
}

function aliasForProposal(proposal: SetupProfileProposal): string {
  const base = proposal.cwd === "." ? proposal.name : proposal.cwd.split("/").at(-1) ?? proposal.name;
  return base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "service";
}

function applicationProposal(project: DevelopmentProject, profiles: readonly SetupProfileProposal[]): SetupApplicationProposal | undefined {
  const servers = profiles.filter((profile) => profile.role === "server").slice(0, 8);
  if (servers.length === 0) return undefined;
  const used = new Set<string>();
  const services = servers.map((profile, startupOrder) => {
    const base = aliasForProposal(profile);
    let alias = base;
    let suffix = 2;
    while (used.has(alias.toLocaleLowerCase("en-US"))) {
      alias = `${base.slice(0, 60)}-${suffix}`;
      suffix += 1;
    }
    used.add(alias.toLocaleLowerCase("en-US"));
    return { profileProposalId: profile.id, alias, startupOrder, hostMode: "manual-localhost" as const, allowManagedWildcard: false };
  });
  const preferred = services.find((service) => /front|web|client/i.test(service.alias)) ?? services[0]!;
  return {
    id: deterministicId(`${project.id}:application`),
    name: project.name,
    primaryProfileProposalId: preferred.profileProposalId,
    services,
  };
}

function managerForManifest(manifestPath: string, topology: ProjectTopology): "npm" | "pnpm" | "yarn" {
  const cwd = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/")) : ".";
  const nearest = topology.lockfiles
    .filter((lockfile) => lockfile.manager !== "bun" && (lockfile.cwd === "." || cwd === lockfile.cwd || cwd.startsWith(`${lockfile.cwd}/`)))
    .toSorted((left, right) => right.cwd.length - left.cwd.length)[0];
  return (nearest?.manager === "pnpm" || nearest?.manager === "yarn") ? nearest.manager : "npm";
}

function toolchainFingerprint(evidence: readonly SetupToolchainEvidence[], policy: SetupPolicy): string {
  if (policy === "manual" && evidence.length === 0) return digest("manual");
  return digest(stableJson({ policy, evidence: evidence.toSorted((left, right) => left.manager.localeCompare(right.manager)) }));
}

export function buildSetupPlan(
  project: DevelopmentProject,
  topology: ProjectTopology,
  policy: SetupPolicy,
  evidence: readonly SetupToolchainEvidence[],
  options: { readonly initializeGit?: boolean } = {},
): SetupPlan {
  if (topology.truncated) throw new Error("TOPOLOGY_REVIEW_REQUIRED");
  if (topology.warnings.includes("UNSUPPORTED_ECOSYSTEM") || topology.lockfiles.some((lockfile) => lockfile.manager === "bun")) {
    throw new Error("UNSUPPORTED_ECOSYSTEM");
  }
  if (topology.manifests.length === 0) throw new Error("SETUP_MANIFEST_MISSING");
  const workspaceId = project.workspaceIds[0]!;
  const profiles = proposalsForTopology(project, topology);
  const proposedApplication = applicationProposal(project, profiles);
  const packageManifests = topology.manifests.filter((manifest) => manifest.kind === "package");
  const installRoots = new Map<string, typeof packageManifests[number]>();
  for (const manifest of packageManifests) {
    const rootLock = topology.lockfiles
      .filter((lockfile) => lockfile.cwd === "." || manifest.cwd === lockfile.cwd || manifest.cwd.startsWith(`${lockfile.cwd}/`))
      .toSorted((left, right) => right.cwd.length - left.cwd.length)[0];
    const key = rootLock?.cwd ?? manifest.cwd;
    if (!installRoots.has(key)) installRoots.set(key, manifest);
  }
  const requiredManagers = new Set([...installRoots.values()].map((manifest) => managerForManifest(manifest.path, topology)));
  if (policy !== "manual") {
    for (const manager of requiredManagers) {
      if (!evidence.some((item) => item.manager === manager)) throw new Error("SETUP_TOOLCHAIN_MISSING");
    }
  }
  if (options.initializeGit === true && !evidence.some((item) => item.manager === "git")) {
    throw new Error("SETUP_TOOLCHAIN_MISSING");
  }
  const actions = [
    ...(policy === "manual" ? [] : [...installRoots.values()].map((manifest) => ({
      kind: "node-install" as const,
      manager: managerForManifest(manifest.path, topology),
      workspaceId,
      manifestPath: manifest.path,
      mode: policy,
    }))),
    ...(options.initializeGit === true ? [{ kind: "git-init" as const, workspaceId }] : []),
    ...(profiles.length > 0 ? [{ kind: "persist-profiles" as const, workspaceId, proposalId: deterministicId(`${project.id}:profiles`) }] : []),
    ...(proposedApplication === undefined ? [] : [{ kind: "persist-application" as const, proposalId: proposedApplication.id }]),
    { kind: "finalize-topology" as const, proposalId: deterministicId(`${project.id}:topology`) },
  ];
  const payload = {
    projectId: project.id,
    topology: topology.topology,
    proposedWorkspaceRoots: topology.topology === "multi-repo" && topology.gitRoots.length > 0
      ? topology.gitRoots
      : ["."],
    manifestRefs: topology.manifests.map((manifest) => ({ workspaceId, path: manifest.path, sha256: manifest.sha256 })),
    lockfileRefs: topology.lockfiles.map((lockfile) => ({ workspaceId, path: lockfile.path, sha256: lockfile.sha256 })),
    packageManagers: [...requiredManagers].toSorted(),
    directDependencyCount: topology.directDependencyCount,
    directDevDependencyCount: topology.directDevDependencyCount,
    toolchainFingerprint: toolchainFingerprint(evidence, policy),
    actions,
    proposedProfiles: profiles,
    ...(proposedApplication === undefined ? {} : { proposedApplication }),
    policy,
  };
  const planSha256 = digest(stableJson(payload));
  return setupPlanSchema.parse({
    id: `plan_${digest(`${project.id}:${planSha256}`).slice(0, 24)}`,
    ...payload,
    planSha256,
    createdAt: new Date().toISOString(),
  });
}

export async function validateSetupPlan(
  plan: SetupPlan,
  registry: WorkspaceRegistry,
  evidence: readonly SetupToolchainEvidence[],
): Promise<{ readonly valid: boolean; readonly code: "READY" | "SETUP_PLAN_STALE" | "SETUP_TOOLCHAIN_MISSING" }> {
  const expectedToolchain = toolchainFingerprint(evidence, plan.policy);
  if (expectedToolchain !== plan.toolchainFingerprint) return { valid: false, code: "SETUP_TOOLCHAIN_MISSING" };
  for (const reference of [...plan.manifestRefs, ...plan.lockfileRefs]) {
    const workspace = registry.workspaces.find((candidate) => candidate.id === reference.workspaceId);
    if (workspace === undefined || !workspace.enabled) return { valid: false, code: "SETUP_PLAN_STALE" };
    try {
      const safe = await resolveSafePath(workspace.rootPath, reference.path);
      if (!safe.exists || !(await stat(safe.realPath)).isFile()) return { valid: false, code: "SETUP_PLAN_STALE" };
      if (digest(await readFile(safe.realPath)) !== reference.sha256) return { valid: false, code: "SETUP_PLAN_STALE" };
    } catch {
      return { valid: false, code: "SETUP_PLAN_STALE" };
    }
  }
  const { id: _id, planSha256: _planSha256, createdAt: _createdAt, ...payload } = plan;
  if (digest(stableJson(payload)) !== plan.planSha256) return { valid: false, code: "SETUP_PLAN_STALE" };
  return { valid: true, code: "READY" };
}
