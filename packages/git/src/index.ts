export { getGitStatus, type GitStatusEntry, type GitStatusResult } from "./status.js";
export { getGitDiff, type GitDiffResult } from "./diff.js";
export { getGitLog, type GitLogEntry, type GitLogResult } from "./log.js";
export { getGitBranches, type GitBranchResult } from "./branch.js";

export { resolveGitContext, toGitPathspec, toWorkspacePath, type GitContext } from "./context.js";
export { runGit, runGitChecked, type GitRunResult } from "./runner.js";

export {
  stageFiles,
  commitStaged,
  pushCommits,
  previewPushCommits,
  getCommitSnapshot,
  getPushSnapshot,
  type StageResult,
  type GitMutationOptions,
  type CommitResult,
  type CommitSnapshot,
  type PushResult,
  type PushSnapshot,
  type PushPreview,
  type PushPreviewEntry,
} from "./write.js";
