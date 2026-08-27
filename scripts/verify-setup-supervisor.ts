import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildNewDevelopmentProject, buildSetupPlan, detectProjectTopology, resolveSetupToolchains } from "@localbridge/desktop-core";
import { SetupSupervisor, type SetupRunSummary } from "@localbridge/development";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const helperPath = path.join(workspaceRoot, "apps", "desktop", "vendor", "process-host", "localbridge-process-host.exe");
const nodeBinaryPath = path.join(workspaceRoot, "apps", "desktop", "vendor", "node", "node.exe");

function workspace(id: string, rootPath: string): AuthorizedWorkspace {
  return {
    id, name: id, rootPath, enabled: true, createdAt: new Date().toISOString(),
    permissions: { read: true, write: true, overwrite: true, gitRead: true, validations: true, gitWrite: true, processes: true, browserRead: false, browserInteract: false, browserHumanControl: false },
    limits: { maxFileBytes: 1_048_576, maxTreeEntries: 300, maxTreeDepth: 6 },
    denyPatterns: [".env", "node_modules"], validationProfiles: {}, processProfiles: {}, browserProfiles: {},
  };
}

async function wait(supervisor: SetupSupervisor, initial: SetupRunSummary, timeoutMs = 20_000): Promise<SetupRunSummary> {
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  while (current.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = supervisor.status(initial.runId) ?? current;
  }
  if (current.state === "running") throw new Error("setup verifier timeout");
  return current;
}

async function planFor(target: AuthorizedWorkspace, policy: "restricted" | "compatible") {
  const project = buildNewDevelopmentProject({ name: target.name, workspaceIds: [target.id] });
  const topology = await detectProjectTopology(target);
  const toolchains = await resolveSetupToolchains(["npm"]);
  return { plan: buildSetupPlan(project, topology, policy, toolchains), toolchains };
}

function marker(target: string): string {
  return path.join(target, "lifecycle-marker.txt");
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("setup verifier requires Windows");
  await Promise.all([access(helperPath), access(nodeBinaryPath)]);
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-setup-e2e-"));
  const restrictedRoot = path.join(root, "restricted");
  const compatibleRoot = path.join(root, "compatible");
  const failureRoot = path.join(root, "failure");
  const cancelRoot = path.join(root, "cancel");
  const timeoutRoot = path.join(root, "timeout");
  const limitRoots = ["limit-a", "limit-b", "limit-c"].map((name) => path.join(root, name));
  const workspaces = new Map<string, AuthorizedWorkspace>();
  try {
    for (const [id, target, script] of [
      ["ws_restricted", restrictedRoot, "require('node:fs').writeFileSync('lifecycle-marker.txt','restricted-ran')"],
      ["ws_compatible", compatibleRoot, "console.log('token=synthetic_setup_secret_1234567890');require('node:fs').writeFileSync('lifecycle-marker.txt','compatible-ran')"],
      ["ws_failure", failureRoot, "process.exit(9)"],
      ["ws_cancel", cancelRoot, "require('node:fs').writeFileSync('lifecycle-marker.txt','started');setTimeout(()=>{},30000)"],
      ["ws_timeout", timeoutRoot, "require('node:fs').writeFileSync('lifecycle-marker.txt','started');setTimeout(()=>{},30000)"],
      ["ws_limit_a", limitRoots[0], "setTimeout(()=>{},30000)"],
      ["ws_limit_b", limitRoots[1], "setTimeout(()=>{},30000)"],
      ["ws_limit_c", limitRoots[2], "setTimeout(()=>{},30000)"],
    ] as const) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }));
      await writeFile(path.join(target, "package.json"), JSON.stringify({ name: id, version: "1.0.0", scripts: { preinstall: `node -e ${JSON.stringify(script)}` } }));
      const value = workspace(id, target);
      workspaces.set(id, value);
    }
    const supervisor = new SetupSupervisor({
      helperPath, nodeBinaryPath, parentPid: process.pid,
      loadWorkspace: async (id) => workspaces.get(id), timeoutMs: 20_000,
    });
    try {
      const restricted = await planFor(workspaces.get("ws_restricted")!, "restricted");
      const restrictedRun = await wait(supervisor, await supervisor.start(restricted.plan, restricted.toolchains));
      if (restrictedRun.state !== "succeeded") throw new Error(`restricted setup failed: ${restrictedRun.errorCode}`);
      let restrictedMarker = true;
      try { await access(marker(restrictedRoot)); } catch { restrictedMarker = false; }
      if (restrictedMarker) throw new Error("restricted setup executed a lifecycle script");

      const compatible = await planFor(workspaces.get("ws_compatible")!, "compatible");
      const compatibleRun = await wait(supervisor, await supervisor.start(compatible.plan, compatible.toolchains));
      if (compatibleRun.state !== "succeeded" || (await readFile(marker(compatibleRoot), "utf8")) !== "compatible-ran") {
        throw new Error(`compatible setup did not execute its approved lifecycle: ${compatibleRun.errorCode}`);
      }
      const compatibleLogs = compatibleRun.logs.join("");
      if (compatibleLogs.includes("synthetic_setup_secret_1234567890") || !compatibleLogs.includes("token=[REDACTADO]")) {
        throw new Error("setup logs did not redact the synthetic secret");
      }

      const failure = await planFor(workspaces.get("ws_failure")!, "compatible");
      const failedRun = await wait(supervisor, await supervisor.start(failure.plan, failure.toolchains));
      if (failedRun.state !== "failed" || failedRun.errorCode !== "SETUP_COMMAND_FAILED" || failedRun.completedActions !== 0) {
        throw new Error(`non-zero setup did not fail closed: ${JSON.stringify(failedRun)}`);
      }

      const cancellable = await planFor(workspaces.get("ws_cancel")!, "compatible");
      const started = await supervisor.start(cancellable.plan, cancellable.toolchains);
      if (started.state !== "running") throw new Error(`cancellable setup did not start: ${started.state}`);
      const idempotent = await supervisor.start(cancellable.plan, cancellable.toolchains);
      if (idempotent.runId !== started.runId) throw new Error("a repeated setup started twice");
      const markerDeadline = Date.now() + 8_000;
      while (Date.now() < markerDeadline) {
        try { await access(marker(cancelRoot)); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      const cancelled = await supervisor.cancel(cancellable.plan.projectId);
      if (cancelled?.state !== "cancelled") throw new Error(`cancel did not converge: ${cancelled?.state}`);
      await supervisor.stopAll();

      const timeoutTarget = await planFor(workspaces.get("ws_timeout")!, "compatible");
      const timeoutSupervisor = new SetupSupervisor({
        helperPath, nodeBinaryPath, parentPid: process.pid,
        loadWorkspace: async (id) => workspaces.get(id), timeoutMs: 500,
      });
      const timedOut = await wait(timeoutSupervisor, await timeoutSupervisor.start(timeoutTarget.plan, timeoutTarget.toolchains), 5_000);
      if (timedOut.state !== "timed_out") throw new Error(`timeout did not converge: ${timedOut.state}`);
      await timeoutSupervisor.stopAll();

      const limitTargets = await Promise.all(limitRoots.map((_, index) => planFor(workspaces.get(`ws_limit_${String.fromCharCode(97 + index)}`)!, "compatible")));
      const limitSupervisor = new SetupSupervisor({
        helperPath, nodeBinaryPath, parentPid: process.pid,
        loadWorkspace: async (id) => workspaces.get(id), timeoutMs: 20_000,
      });
      await limitSupervisor.start(limitTargets[0]!.plan, limitTargets[0]!.toolchains);
      await limitSupervisor.start(limitTargets[1]!.plan, limitTargets[1]!.toolchains);
      let globalLimitClosed = false;
      try {
        await limitSupervisor.start(limitTargets[2]!.plan, limitTargets[2]!.toolchains);
      } catch (error) {
        globalLimitClosed = error instanceof Error && error.message === "SETUP_ALREADY_RUNNING";
      }
      if (!globalLimitClosed) throw new Error("global setup concurrency limit did not fail closed");
      await limitSupervisor.stopAll();

      process.stdout.write(`${JSON.stringify({
        restrictedLifecycleBlocked: true,
        compatibleLifecycleApproved: true,
        nonZeroExitFailsClosed: true,
        setupLogsRedacted: true,
        repeatedStartIdempotent: true,
        cancellationClean: true,
        timeoutClean: timedOut.state === "timed_out" && timeoutSupervisor.listAll().every((run) => run.state !== "running"),
        globalConcurrencyBounded: globalLimitClosed && limitSupervisor.listAll().every((run) => run.state !== "running"),
        noWorkspaceProcessesRemain: supervisor.listAll().every((run) => run.state !== "running"),
      })}\n`);
    } finally {
      await supervisor.stopAll();
    }
  } finally {
    // Windows puede mantener el cwd ocupado durante unos milisegundos después de que
    // el Job Object confirme el cierre. El reintento es solo para retirar la fixture.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
