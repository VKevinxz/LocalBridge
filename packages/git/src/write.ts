/**
 * Git de escritura (ADR-0016): `git.stage`, `git.commit`, `git.push`.
 *
 * `git.stage` no exige aprobación — es local y reversible con `git reset`, sin
 * ningún efecto fuera del repo. `git.commit` y `git.push` sí (la aprobación
 * vive en `packages/mcp-server`, específica del protocolo MRTR; este módulo
 * solo ejecuta Git una vez que la tool ya decidió que está autorizado).
 *
 * Prohibido para siempre, no como opción desactivable: `--force`,
 * `--force-with-lease`, `reset --hard`, `clean` destructivo. No hay ningún
 * parámetro en ninguna función de este módulo que pueda producir esos
 * argumentos — igual que `shell: false` en `packages/git/src/runner.ts`, es
 * una ausencia en el código, no una validación en tiempo de ejecución.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalBridgeError } from "@localbridge/shared";
import { isPathDenied, resolveSafePath, type AuthorizedWorkspace } from "@localbridge/workspace";

import { resolveGitContext, toGitPathspec } from "./context.js";
import { runGit, runGitChecked } from "./runner.js";

export interface StageResult {
  readonly staged: readonly string[];
}

/**
 * Valida cada ruta contra el mismo sandbox que `file.read` (existe, dentro del
 * workspace, sin symlink de escape) y contra la denylist de secretos, antes de
 * pasarla a Git como pathspec literal. Sin esto, `git add` podría escapar del
 * workspace autorizado o meter en el índice un archivo que el resto del
 * sistema trata como secreto (`.env`, claves, etc.).
 */
export async function stageFiles(workspace: AuthorizedWorkspace, paths: readonly string[]): Promise<StageResult> {
  if (paths.length === 0) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "empty paths" });
  }

  await Promise.all(paths.map(async (relativePath) => {
    if (isPathDenied(relativePath, workspace.denyPatterns)) {
      throw new LocalBridgeError("PATH_DENIED", { path: relativePath });
    }
    const safe = await resolveSafePath(workspace.rootPath, relativePath);
    if (!safe.exists) {
      throw new LocalBridgeError("FILE_NOT_FOUND", { path: relativePath });
    }
    const stats = await stat(safe.realPath);
    if (!stats.isFile()) throw new LocalBridgeError("NOT_A_FILE", { path: relativePath });
    if (stats.size > workspace.limits.maxFileBytes) throw new LocalBridgeError("FILE_TOO_LARGE", { path: relativePath });
  }));

  const context = await resolveGitContext(workspace);
  await Promise.all(paths.map(async (relativePath) => {
    // Un clean filter puede ejecutar un programa durante `git add`. Se rechaza
    // cualquier path con atributo `filter`; LocalBridge nunca ejecuta filtros
    // definidos por el repositorio de forma implícita.
    const attribute = await runGitChecked(["check-attr", "-z", "filter", "--", relativePath], { cwd: context.cwd });
    const [, , value = ""] = attribute.stdout.split("\0");
    if (value !== "" && value !== "unspecified" && value !== "unset") {
      throw new LocalBridgeError("INVALID_INPUT", { reason: "git clean filters are not allowed" });
    }
  }));
  const pathspecs = paths.map(toGitPathspec);
  await runGitChecked(["add", "--", ...pathspecs], { cwd: context.cwd });

  return { staged: [...paths] };
}

export interface CommitResult {
  readonly commitHash: string;
}

export interface CommitSnapshot {
  readonly treeHash: string;
  readonly parentHash: string;
  readonly branchRef: string;
}

/**
 * Captura todo el estado que define el commit aprobado. Los commits solo se
 * permiten cuando el workspace coincide con la raíz del repositorio: el índice
 * es global al repo y, desde un subdirectorio autorizado, podría contener
 * cambios staged de carpetas que quedan fuera de ese workspace.
 */
export async function getCommitSnapshot(workspace: AuthorizedWorkspace): Promise<CommitSnapshot> {
  const context = await resolveGitContext(workspace);
  requireRepositoryRoot(context.prefix);
  await ensureStagedPathsAllowed(workspace, context.cwd);

  const [tree, parent, branch] = await Promise.all([
    runGitChecked(["write-tree"], { cwd: context.cwd }),
    runGitChecked(["rev-parse", "HEAD"], { cwd: context.cwd }),
    runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: context.cwd }),
  ]);
  if (branch.exitCode !== 0) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "detached HEAD" });
  }

  const snapshot = {
    treeHash: tree.stdout.trim(),
    parentHash: parent.stdout.trim(),
    branchRef: branch.stdout.trim(),
  };
  if (!isObjectId(snapshot.treeHash) || !isObjectId(snapshot.parentHash) || !snapshot.branchRef.startsWith("refs/heads/")) {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }
  return snapshot;
}

/**
 * Crea exactamente el objeto aprobado y mueve la rama con compare-and-swap.
 * `commit-tree` no ejecuta hooks de commit ni firma GPG; `update-ref` exige que
 * la rama todavía apunte al padre aprobado. Si cambió, se falla cerrado.
 */
export async function commitStaged(
  workspace: AuthorizedWorkspace,
  message: string,
  snapshot: CommitSnapshot,
): Promise<CommitResult> {
  const context = await resolveGitContext(workspace);
  requireRepositoryRoot(context.prefix);
  await validateCommitSnapshot(context.cwd, snapshot);

  const commit = await runGitChecked(
    ["-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`, "-c", "commit.gpgSign=false", "commit-tree", snapshot.treeHash, "-p", snapshot.parentHash, "-m", message],
    { cwd: context.cwd },
  );
  const commitHash = commit.stdout.trim();
  if (!isObjectId(commitHash)) {
    throw new LocalBridgeError("INTERNAL_ERROR");
  }

  const update = await runGit(
    ["-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`, "update-ref", snapshot.branchRef, commitHash, snapshot.parentHash],
    { cwd: context.cwd },
  );
  if (update.exitCode !== 0) {
    throw new LocalBridgeError("APPROVAL_INVALID", { reason: "branch changed after approval" });
  }

  return { commitHash };
}

export interface PushResult {
  readonly status: "pushed" | "up_to_date";
  readonly commitHash: string;
  readonly remote: string;
  readonly branch: string;
  /** Confirmación independiente de que la rama remota apunta al hash solicitado. */
  readonly remoteVerified: boolean;
  /** `true` si la referencia local `origin/rama` quedó alineada o ya lo estaba. */
  readonly localTrackingSynchronized: boolean;
}

export interface PushPreviewEntry {
  readonly hash: string;
  readonly subject: string;
}

export interface PushPreview {
  /** `false` cuando no se pudo resolver una rama remota de referencia (primer push, sin upstream configurado). */
  readonly available: boolean;
  readonly commits: readonly PushPreviewEntry[];
  readonly truncated: boolean;
}

export interface PushSnapshot {
  readonly headHash: string;
  readonly remote: string;
  readonly branch: string;
  /** URL exacta aprobada; nunca se muestra ni se persiste. */
  readonly remoteUrl: string;
  /** Referencia tracking local capturada, solo si corresponde al destino exacto. */
  readonly trackingRef?: string;
  /** Valor esperado para actualizar `trackingRef` mediante compare-and-swap. */
  readonly trackingHash?: string;
}

const PUSH_PREVIEW_MAX_COMMITS = 20;
const PREVIEW_FIELD_SEPARATOR = String.fromCharCode(31);
const PREVIEW_RECORD_SEPARATOR = String.fromCharCode(30);

/**
 * Qué commits publicaría un `git push`, para que la aprobación humana (ADR-0016
 * §5) muestre contenido real en vez de una pregunta genérica. No lanza si no
 * puede resolver la referencia remota (primer push de una rama nueva, o sin
 * upstream configurado y sin remote/branch explícitos): `available: false` deja
 * que quien construye el mensaje de aprobación lo explique en texto plano en
 * vez de fallar la operación por algo que no es un error del propio push.
 */
export async function previewPushCommits(workspace: AuthorizedWorkspace, snapshot: PushSnapshot): Promise<PushPreview> {
  const context = await resolveGitContext(workspace);
  requireRepositoryRoot(context.prefix);

  const targetRef = `${snapshot.remote}/${snapshot.branch}`;
  const verify = await runGit(["rev-parse", "--verify", "--quiet", targetRef], { cwd: context.cwd });
  if (verify.exitCode !== 0) {
    return { available: false, commits: [], truncated: false };
  }

  const log = await runGit(
    [
      "log",
      "--no-color",
      `--max-count=${PUSH_PREVIEW_MAX_COMMITS}`,
      `--format=%h${PREVIEW_FIELD_SEPARATOR}%s${PREVIEW_RECORD_SEPARATOR}`,
      `${targetRef}..HEAD`,
    ],
    { cwd: context.cwd },
  );
  if (log.exitCode !== 0) {
    return { available: false, commits: [], truncated: false };
  }

  const commits = log.stdout
    .split(PREVIEW_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash = "", subject = ""] = record.split(PREVIEW_FIELD_SEPARATOR);
      return { hash, subject };
    });

  return { available: true, commits, truncated: log.truncated || commits.length >= PUSH_PREVIEW_MAX_COMMITS };
}

/**
 * Resuelve el destino exacto que se aprobará. Se toma una sola URL y se
 * rechazan protocolos/helper remotos arbitrarios. La URL se conserva solo en
 * memoria para que un cambio posterior en `.git/config` no cambie el destino.
 */
export async function getPushSnapshot(
  workspace: AuthorizedWorkspace,
  remote: string | undefined,
  branch: string | undefined,
): Promise<PushSnapshot> {
  const context = await resolveGitContext(workspace);
  requireRepositoryRoot(context.prefix);
  if ((remote === undefined) !== (branch === undefined)) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "remote and branch must be provided together" });
  }

  const head = await runGitChecked(["rev-parse", "HEAD"], { cwd: context.cwd });
  const headHash = head.stdout.trim();
  if (!isObjectId(headHash)) throw new LocalBridgeError("INTERNAL_ERROR");

  let resolvedRemote = remote;
  let resolvedBranch = branch;
  let currentBranch: string | undefined;
  if (resolvedRemote === undefined || resolvedBranch === undefined) {
    const current = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: context.cwd });
    if (current.exitCode !== 0) throw new LocalBridgeError("INVALID_INPUT", { reason: "detached HEAD" });
    currentBranch = current.stdout.trim();
    await validateBranch(context.cwd, currentBranch);

    const configuredRemote = await readSingleConfig(context.cwd, `branch.${currentBranch}.remote`);
    const configuredMerge = await readSingleConfig(context.cwd, `branch.${currentBranch}.merge`);
    if (configuredRemote === undefined || configuredMerge === undefined || !configuredMerge.startsWith("refs/heads/")) {
      throw new LocalBridgeError("INVALID_INPUT", { reason: "upstream not configured" });
    }
    resolvedRemote = configuredRemote;
    resolvedBranch = configuredMerge.slice("refs/heads/".length);
  } else {
    const current = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: context.cwd });
    if (current.exitCode === 0) {
      currentBranch = current.stdout.trim();
      await validateBranch(context.cwd, currentBranch);
    }
  }

  validateRemoteName(resolvedRemote);
  await validateBranch(context.cwd, resolvedBranch);
  await rejectLocalUrlRewrites(context.cwd);
  const remoteUrl = await resolveSingleRemoteUrl(context.cwd, resolvedRemote);
  validateRemoteUrl(remoteUrl);
  const tracking = currentBranch === undefined
    ? {}
    : await getTrackingSnapshot(context.cwd, currentBranch, resolvedRemote, resolvedBranch);

  return { headHash, remote: resolvedRemote, branch: resolvedBranch, remoteUrl, ...tracking };
}

/**
 * Nunca fuerza: no hay parámetro `force` en esta función ni forma de que uno
 * llegue a `runGit`. Un rechazo del remoto (no fast-forward, rama protegida,
 * etc.) es `GIT_PUSH_REJECTED` — un resultado operativo esperado, no un fallo
 * interno — nunca se reintenta con `--force` automáticamente.
 */
export async function pushCommits(workspace: AuthorizedWorkspace, snapshot: PushSnapshot): Promise<PushResult> {
  const context = await resolveGitContext(workspace);
  requireRepositoryRoot(context.prefix);
  validateRemoteName(snapshot.remote);
  await validateBranch(context.cwd, snapshot.branch);
  if (!isObjectId(snapshot.headHash)) throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid approved commit" });
  validateRemoteUrl(snapshot.remoteUrl);
  validateTrackingSnapshot(snapshot);

  const helpers = await trustedCredentialHelpers(context.cwd);
  const remoteConfigArgs = [
    "-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`,
    "-c", "core.askPass=",
    "-c", "core.sshCommand=ssh",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=always",
    "-c", "protocol.file.allow=always",
    "-c", "protocol.ext.allow=never",
    "-c", "credential.helper=",
    ...helpers.flatMap((helper) => ["-c", `credential.helper=${helper}`]),
  ];
  const remoteBefore = await readRemoteHead(context.cwd, remoteConfigArgs, snapshot);
  const alreadyUpToDate = remoteBefore.reachable && remoteBefore.hash === snapshot.headHash;

  if (!alreadyUpToDate) {
    const result = await runGit(
      [...remoteConfigArgs, "push", "--no-verify", snapshot.remoteUrl, `${snapshot.headHash}:refs/heads/${snapshot.branch}`],
      { cwd: context.cwd },
    );

    if (result.exitCode !== 0) {
      if (/not a git repository|no está en un repositorio|unsafe repository/i.test(result.stderr)) {
        throw new LocalBridgeError("GIT_NOT_REPOSITORY");
      }
      throw new LocalBridgeError("GIT_PUSH_REJECTED", { exitCode: result.exitCode });
    }
  }

  // `git push <URL>` preserva el destino exacto aprobado, pero Git no refresca
  // `refs/remotes/origin/*`. Se verifica por read-back y solo entonces se
  // sincroniza la referencia local mediante CAS; una carrera nunca se pisa.
  const remoteAfter = alreadyUpToDate ? remoteBefore : await readRemoteHead(context.cwd, remoteConfigArgs, snapshot);
  const remoteVerified = remoteAfter.reachable && remoteAfter.hash === snapshot.headHash;
  const localTrackingSynchronized = remoteVerified
    ? await synchronizeLocalTrackingRef(context.cwd, snapshot)
    : false;

  return {
    status: alreadyUpToDate ? "up_to_date" : "pushed",
    commitHash: snapshot.headHash,
    remote: snapshot.remote,
    branch: snapshot.branch,
    remoteVerified,
    localTrackingSynchronized,
  };
}

const DISABLED_HOOKS_PATH = path.join(os.tmpdir(), `localbridge-disabled-hooks-${randomUUID()}`);
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireRepositoryRoot(prefix: string): void {
  if (prefix !== "") {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "git write requires repository root workspace" });
  }
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

interface TrackingSnapshot {
  readonly trackingRef?: string;
  readonly trackingHash?: string;
}

async function getTrackingSnapshot(cwd: string, currentBranch: string, remote: string, branch: string): Promise<TrackingSnapshot> {
  const [configuredRemote, configuredMerge] = await Promise.all([
    readSingleConfig(cwd, `branch.${currentBranch}.remote`),
    readSingleConfig(cwd, `branch.${currentBranch}.merge`),
  ]);
  if (configuredRemote !== remote || configuredMerge !== `refs/heads/${branch}`) return {};

  // Se limita deliberadamente al mapping convencional. Un refspec fetch
  // personalizado sigue siendo válido para Git, pero LocalBridge no adivina
  // qué referencia local debería modificar.
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const symbolic = await runGit(["for-each-ref", "--format=%(upstream)", `refs/heads/${currentBranch}`], { cwd });
  if (symbolic.exitCode !== 0 || symbolic.stdout.trim() !== trackingRef) return {};

  const current = await runGit(["rev-parse", "--verify", "--quiet", trackingRef], { cwd });
  if (current.exitCode !== 0) return { trackingRef };
  const trackingHash = current.stdout.trim();
  if (!isObjectId(trackingHash)) return {};
  return { trackingRef, trackingHash };
}

function validateTrackingSnapshot(snapshot: PushSnapshot): void {
  if (snapshot.trackingRef !== undefined && snapshot.trackingRef !== `refs/remotes/${snapshot.remote}/${snapshot.branch}`) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid tracking ref" });
  }
  if (snapshot.trackingHash !== undefined && !isObjectId(snapshot.trackingHash)) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid tracking hash" });
  }
}

interface RemoteHeadResult {
  readonly reachable: boolean;
  readonly hash?: string;
}

async function readRemoteHead(
  cwd: string,
  remoteConfigArgs: readonly string[],
  snapshot: PushSnapshot,
): Promise<RemoteHeadResult> {
  const expectedRef = `refs/heads/${snapshot.branch}`;
  let result: Awaited<ReturnType<typeof runGit>>;
  try {
    result = await runGit([...remoteConfigArgs, "ls-remote", snapshot.remoteUrl, expectedRef], { cwd });
  } catch {
    // El read-back es evidencia adicional. Si falla antes del push se intenta
    // la operación normal; si falla después, no se convierte un push ya
    // aceptado por el remoto en un error reintentable que podría duplicarse.
    return { reachable: false };
  }
  if (result.exitCode !== 0 || result.truncated) return { reachable: false };

  const records = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
  if (records.length === 0) return { reachable: true };
  if (records.length !== 1) return { reachable: false };

  const [hash, ref] = records[0] ?? [];
  if (hash === undefined || ref !== expectedRef || !isObjectId(hash)) return { reachable: false };
  return { reachable: true, hash };
}

async function synchronizeLocalTrackingRef(cwd: string, snapshot: PushSnapshot): Promise<boolean> {
  if (snapshot.trackingRef === undefined) return false;

  try {
    const current = await runGit(["rev-parse", "--verify", "--quiet", snapshot.trackingRef], { cwd });
    if (current.exitCode === 0 && current.stdout.trim() === snapshot.headHash) return true;

    const expectedOld = snapshot.trackingHash ?? "0".repeat(snapshot.headHash.length);
    const update = await runGit(
      ["-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`, "update-ref", "--no-deref", snapshot.trackingRef, snapshot.headHash, expectedOld],
      { cwd },
    );
    if (update.exitCode === 0) return true;

    // Otro proceso pudo sincronizar la misma referencia entre ambas llamadas.
    const afterRace = await runGit(["rev-parse", "--verify", "--quiet", snapshot.trackingRef], { cwd });
    return afterRace.exitCode === 0 && afterRace.stdout.trim() === snapshot.headHash;
  } catch {
    // El remoto ya aceptó el push. Un fallo de bookkeeping local no puede
    // transformar ese efecto consumado en un error que invite a reintentarlo.
    return false;
  }
}

async function validateCommitSnapshot(cwd: string, snapshot: CommitSnapshot): Promise<void> {
  if (!isObjectId(snapshot.treeHash) || !isObjectId(snapshot.parentHash) || !snapshot.branchRef.startsWith("refs/heads/")) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid commit snapshot" });
  }
  await validateBranch(cwd, snapshot.branchRef.slice("refs/heads/".length));
}

async function ensureStagedPathsAllowed(workspace: AuthorizedWorkspace, cwd: string): Promise<void> {
  const staged = await runGitChecked(["diff", "--cached", "--name-only", "-z", "--no-renames", "--", "."], { cwd });
  for (const stagedPath of staged.stdout.split("\0")) {
    if (stagedPath.length > 0 && isPathDenied(stagedPath, workspace.denyPatterns)) {
      throw new LocalBridgeError("PATH_DENIED", { path: stagedPath });
    }
  }
}

function validateRemoteName(remote: string): void {
  if (!REMOTE_NAME_PATTERN.test(remote)) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid remote name" });
  }
}

async function validateBranch(cwd: string, branch: string): Promise<void> {
  if (branch.startsWith("-") || hasControlCharacters(branch)) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid branch" });
  }
  const result = await runGit(["check-ref-format", "--branch", branch], { cwd });
  if (result.exitCode !== 0) throw new LocalBridgeError("INVALID_INPUT", { reason: "invalid branch" });
}

async function readConfigValues(cwd: string, scope: "--local" | "--global" | "--system", key: string): Promise<string[]> {
  const result = await runGit(["config", scope, "--get-all", key], { cwd });
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw new LocalBridgeError("INTERNAL_ERROR");
  return result.stdout.split(/\r?\n/).filter((value) => value.length > 0);
}

async function readSingleConfig(cwd: string, key: string): Promise<string | undefined> {
  const values = await readConfigValues(cwd, "--local", key);
  if (values.length > 1) throw new LocalBridgeError("INVALID_INPUT", { reason: "ambiguous git config" });
  return values[0];
}

async function rejectLocalUrlRewrites(cwd: string): Promise<void> {
  const result = await runGit(["config", "--local", "--get-regexp", "^url\\..*\\.(insteadOf|pushInsteadOf)$"], { cwd });
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "repository URL rewrites are not allowed" });
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new LocalBridgeError("INTERNAL_ERROR");
}

async function resolveSingleRemoteUrl(cwd: string, remote: string): Promise<string> {
  const pushUrls = await readConfigValues(cwd, "--local", `remote.${remote}.pushurl`);
  const urls = pushUrls.length > 0 ? pushUrls : await readConfigValues(cwd, "--local", `remote.${remote}.url`);
  if (urls.length !== 1) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: urls.length === 0 ? "remote URL missing" : "multiple push URLs" });
  }
  return urls[0] ?? "";
}

function validateRemoteUrl(remoteUrl: string): void {
  if (remoteUrl.length === 0 || remoteUrl.length > 4096 || hasControlCharacters(remoteUrl) || remoteUrl.includes("::")) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "unsafe remote URL" });
  }

  const isHttps = remoteUrl.startsWith("https://");
  const isSsh = remoteUrl.startsWith("ssh://");
  const isFile = remoteUrl.startsWith("file://");
  const isAbsoluteWindowsPath = /^[A-Za-z]:[\\/]/.test(remoteUrl);
  const isAbsolutePosixPath = remoteUrl.startsWith("/");
  const isScpLike = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^\s]+$/.test(remoteUrl) && !isAbsoluteWindowsPath;
  if (!isHttps && !isSsh && !isFile && !isAbsoluteWindowsPath && !isAbsolutePosixPath && !isScpLike) {
    throw new LocalBridgeError("INVALID_INPUT", { reason: "unsupported remote protocol" });
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

async function trustedCredentialHelpers(cwd: string): Promise<string[]> {
  const [system, global] = await Promise.all([
    readConfigValues(cwd, "--system", "credential.helper"),
    readConfigValues(cwd, "--global", "credential.helper"),
  ]);
  return [...system, ...global];
}
