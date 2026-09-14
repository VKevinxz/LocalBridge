export { getFileMetadata, type FileMetadataResult } from "./metadata.js";
export { readWorkspaceFile, type FileReadOptions, type FileReadResult } from "./read.js";
export { readWorkspaceBinaryFile, type WorkspaceBinaryReadResult } from "./read-binary.js";
export {
  MAX_BINARY_RANGE_BYTES,
  openWorkspaceBinaryRangeReader,
  type WorkspaceBinaryRangeOptions,
  type WorkspaceBinaryRangeReader,
} from "./read-binary-range.js";
export { hashResolvedFile, MAX_MANAGED_ASSET_BYTES } from './hash-file.js';
export {
  openWorkspaceArtifactSource,
  type ArtifactSourceCounters,
  type ArtifactSourceIdentity,
  type WorkspaceArtifactSource,
  type WorkspaceArtifactSourceOptions,
} from './artifact-source.js';
export { buildWorkspaceTree, type TreeEntry, type WorkspaceTreeResult } from "./tree.js";
export { searchWorkspace, type SearchMatch, type WorkspaceSearchOptions, type WorkspaceSearchResult } from "./search.js";

export { atomicWrite } from "./atomic-write.js";
export { createExclusiveFile } from "./create-exclusive.js";
export { withMutationLock, mutationLockKey } from "./mutex.js";
export type { MutationOptions } from "./mutation-options.js";

export { createWorkspaceFile, type FileCreateResult } from "./create.js";
export {
  createWorkspaceBinaryFile,
  createWorkspaceBinaryFileFromChunks,
  preflightWorkspaceBinaryFileCreate,
  type WorkspaceBinaryCreateOptions,
  type WorkspaceBinaryCreateResult,
  type WorkspaceBinaryStreamWriter,
} from "./create-binary.js";
export {
  cleanupWorkspaceArtifactStaging,
  createWorkspaceArtifactDirectory,
  type ArtifactStagingCleanupResult,
  type ArtifactDirectoryOptions,
  type ArtifactFileReceipt,
  type WorkspaceArtifactDirectoryResult,
  type WorkspaceArtifactWriter,
} from "./artifact-directory.js";
export { transformGuardedWorkspaceFile, writeGuardedWorkspaceFile, type FileWriteGuardedResult } from "./write-guarded.js";
export {
  patchGuardedWorkspaceFile,
  type FilePatchGuardedResult,
  type GuardedTextEdit,
} from "./patch-guarded.js";
export { deleteWorkspaceFile, type FileDeleteResult } from "./delete.js";
export { moveWorkspaceFile, type FileMoveResult } from "./move.js";
