export { getFileMetadata, type FileMetadataResult } from "./metadata.js";
export { readWorkspaceFile, type FileReadResult } from "./read.js";
export { buildWorkspaceTree, type TreeEntry, type WorkspaceTreeResult } from "./tree.js";
export { searchWorkspace, type SearchMatch, type WorkspaceSearchResult } from "./search.js";

export { atomicWrite } from "./atomic-write.js";
export { createExclusiveFile } from "./create-exclusive.js";
export { withMutationLock, mutationLockKey } from "./mutex.js";

export { createWorkspaceFile, type FileCreateResult } from "./create.js";
export { writeGuardedWorkspaceFile, type FileWriteGuardedResult } from "./write-guarded.js";
export { deleteWorkspaceFile, type FileDeleteResult } from "./delete.js";
export { moveWorkspaceFile, type FileMoveResult } from "./move.js";
