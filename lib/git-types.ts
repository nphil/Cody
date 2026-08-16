export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitBranchInfo {
  /** Branch name, or the short commit hash when detached. */
  branch: string | null;
  /** Upstream ref name ("origin/main"), null when none is configured. */
  upstream: string | null;
  /** Commits on HEAD that the upstream does not have. */
  ahead: number;
  /** Commits on the upstream that HEAD does not have. */
  behind: number;
  detached: boolean;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  /** Populated for git repositories; absent in older cached responses. */
  branchInfo?: GitBranchInfo;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}
