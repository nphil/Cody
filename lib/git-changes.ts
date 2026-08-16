import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitBranchInfo,
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

/** Branch, upstream and ahead/behind counts for the checked-out HEAD. Every
 * sub-probe degrades independently: a detached HEAD still reports its short
 * hash, and a branch without an upstream reports zero ahead/behind. */
async function getGitBranchInfo(repositoryRoot: string): Promise<GitBranchInfo> {
  const info: GitBranchInfo = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false };
  try {
    info.branch = (await git(repositoryRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).trim() || null;
  } catch {
    info.detached = true;
    try {
      info.branch = (await git(repositoryRoot, ["rev-parse", "--short", "HEAD"])).trim() || null;
    } catch {
      // Unborn branch (fresh repo without commits): symbolic-ref -q exits 0
      // with the name, so this path is a repo with no HEAD at all.
    }
  }
  if (!info.detached && info.branch) {
    try {
      info.upstream = (await git(repositoryRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim() || null;
    } catch {
      return info;
    }
    try {
      // left-right over upstream...HEAD: left = only-upstream (behind), right = only-HEAD (ahead)
      const counts = (await git(repositoryRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).trim();
      const [behind, ahead] = counts.split(/\s+/).map((value) => Number.parseInt(value, 10));
      if (Number.isFinite(behind)) info.behind = behind;
      if (Number.isFinite(ahead)) info.ahead = ahead;
    } catch {
      // Upstream ref exists but is unreachable (e.g. pruned remote): keep 0/0.
    }
  }
  return info;
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, repositoryRoot: null, files: [] };
  }

  const [statusOutput, branchInfo] = await Promise.all([
    git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    getGitBranchInfo(repositoryRoot),
  ]);
  const entries = parseGitPorcelainV1(statusOutput);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(cwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });

  return { isGitRepository: true, repositoryRoot, files, branchInfo };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot || !isWithinPath(repositoryRoot, filePath)) return { supported: false };

  const resolvedFilePath = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}

/** Actions the UI may request against the working tree / index. All of them
 * operate on one path except commit, which commits whatever is staged. */
export type GitMutationAction = "stage" | "unstage" | "discard" | "commit";

export interface GitMutationResult {
  ok: boolean;
  error?: string;
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr.split("\n").slice(-3).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

/** Resolve + authorize a target path for mutation: inside the repo, and its
 * status entry (when required) so discard can distinguish untracked files. */
async function repoRelative(repositoryRoot: string, filePath: string): Promise<string | null> {
  const resolved = path.resolve(filePath);
  if (!isWithinPath(repositoryRoot, resolved)) return null;
  return toGitPath(path.relative(repositoryRoot, resolved));
}

export async function mutateGit(
  cwd: string,
  action: GitMutationAction,
  filePath?: string,
  message?: string,
): Promise<GitMutationResult> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return { ok: false, error: "Not a git repository" };

  try {
    if (action === "commit") {
      const trimmed = message?.trim();
      if (!trimmed) return { ok: false, error: "Commit message is required" };
      // --no-verify is NOT passed: the user's hooks are part of their repo
      // contract. Identity may be unset in fresh environments; fall back to a
      // local one-off identity rather than failing the commit.
      try {
        await git(repositoryRoot, ["commit", "-m", trimmed]);
      } catch (error) {
        const text = errorText(error);
        if (/user\.(name|email)|empty ident|tell me who you are/i.test(text)) {
          await git(repositoryRoot, [
            "-c", "user.name=Cody",
            "-c", "user.email=cody@localhost",
            "commit", "-m", trimmed,
          ]);
        } else {
          throw error;
        }
      }
      return { ok: true };
    }

    if (!filePath) return { ok: false, error: "path is required" };
    const relative = await repoRelative(repositoryRoot, filePath);
    if (relative === null) return { ok: false, error: "Path is outside the repository" };

    if (action === "stage") {
      // -A so a deleted file's removal can be staged the same way.
      await git(repositoryRoot, ["add", "-A", "--", relative]);
      return { ok: true };
    }

    if (action === "unstage") {
      try {
        await git(repositoryRoot, ["restore", "--staged", "--", relative]);
      } catch (error) {
        // A repo with no commits has no HEAD for restore to read; dropping the
        // path from the index is the equivalent operation there.
        if (/HEAD|unborn|unknown revision/i.test(errorText(error))) {
          await git(repositoryRoot, ["rm", "--cached", "--force", "-r", "--", relative]);
        } else {
          throw error;
        }
      }
      return { ok: true };
    }

    // discard: untracked files are deleted outright; tracked files return to
    // HEAD in both the index and the working tree. The UI confirms first.
    const entries = await readStatusEntries(repositoryRoot);
    const entry = entries.find((candidate) => candidate.path === relative);
    if (!entry) return { ok: false, error: "File has no pending changes" };
    if (entry.indexStatus === "?" && entry.worktreeStatus === "?") {
      const absolute = path.resolve(repositoryRoot, relative);
      await fs.promises.rm(absolute, { force: true });
      return { ok: true };
    }
    await git(repositoryRoot, ["checkout", "HEAD", "--", relative]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}
