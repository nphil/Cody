import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { getAgentDir } from "./omp/paths";

const execFileAsync = promisify(execFile);

/** Snapshots must never make sending a message feel broken: first snapshots of
 * big trees can be slow, so they get a generous-but-bounded budget and every
 * caller treats failure as "no checkpoint", not as an error. */
const CHECKPOINT_TIMEOUT_MS = 15_000;
const MAX_LIST = 50;
export const MAX_CHECKPOINT_LABEL = 80;

export interface CheckpointInfo {
  hash: string;
  label: string;
  /** Unix seconds. */
  ts: number;
}

/** Workspace checkpoints live in a shadow git repository OUTSIDE the workspace
 * (under the omp agent dir), pointed at the workspace via GIT_WORK_TREE. The
 * workspace's own .git is untouched: git always skips entries named .git, so
 * snapshots capture files only — never the project repo's branches or index.
 * .gitignore applies, which keeps node_modules and friends out of snapshots
 * and safe from restore's clean pass. */
export function checkpointGitDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const digest = createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  const name = path.basename(resolved).replace(/[^\w.-]+/gu, "-").slice(0, 40) || "workspace";
  return path.join(getAgentDir(), "cody-checkpoints", `${name}-${digest}`);
}

async function shadowGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    // Run FROM the work tree so relative pathspecs ("." in checkout/clean)
    // resolve against the workspace, not the server's own cwd.
    cwd: path.resolve(cwd),
    timeout: CHECKPOINT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_DIR: checkpointGitDir(cwd),
      GIT_WORK_TREE: path.resolve(cwd),
      // A stray GIT_INDEX_FILE would corrupt the interplay of the two repos.
      GIT_INDEX_FILE: undefined as unknown as string,
      HOME: process.env.HOME ?? homedir(),
    },
  });
  return stdout;
}

const IDENTITY = ["-c", "user.name=Cody", "-c", "user.email=cody@localhost"];

/** One shadow repo per workspace means one index per workspace, and git takes
 * no lock across our multi-step restore. A snapshot landing between restore's
 * read-tree and its clean would delete files the user still has. Every
 * operation for a cwd therefore queues behind the previous one. */
const workspaceQueues = new Map<string, Promise<unknown>>();

function serialize<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(cwd);
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // Keep the chain alive but never let a rejection poison the next caller.
  workspaceQueues.set(key, next.catch(() => undefined));
  return next;
}

async function ensureShadowRepo(cwd: string): Promise<void> {
  const gitDir = checkpointGitDir(cwd);
  const worktree = path.resolve(cwd);
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    await fs.promises.mkdir(gitDir, { recursive: true });
    await shadowGit(cwd, ["init", "--quiet"]);
    await shadowGit(cwd, ["config", "core.bare", "false"]);
  }

  // A workspace that CONTAINS the agent dir (cwd = $HOME is the realistic
  // case) would otherwise snapshot the checkpoint store into itself: every
  // snapshot swallows all previous ones, growth compounds, and a restore
  // rewrites the store mid-read. Excluding the store breaks that recursion.
  // The workspace's own .git/info/exclude is honored too, so files the user
  // excluded locally are neither captured nor deleted by a restore.
  const excludeLines = ["# Written by Cody — do not edit."];
  const store = path.join(getAgentDir(), "cody-checkpoints");
  const relativeStore = path.relative(worktree, store);
  if (relativeStore && !relativeStore.startsWith("..") && !path.isAbsolute(relativeStore)) {
    excludeLines.push(`/${relativeStore.split(path.sep).join("/")}/`);
  }
  const agentRelative = path.relative(worktree, getAgentDir());
  if (agentRelative && !agentRelative.startsWith("..") && !path.isAbsolute(agentRelative)) {
    excludeLines.push(`/${agentRelative.split(path.sep).join("/")}/`);
  }
  try {
    await fs.promises.mkdir(path.join(gitDir, "info"), { recursive: true });
    await fs.promises.writeFile(path.join(gitDir, "info", "exclude"), `${excludeLines.join("\n")}\n`, "utf8");
  } catch {
    // Best effort: a snapshot that captures too much still beats no snapshot.
  }
  const workspaceExclude = path.join(worktree, ".git", "info", "exclude");
  if (fs.existsSync(workspaceExclude)) {
    try {
      await shadowGit(cwd, ["config", "core.excludesFile", workspaceExclude]);
    } catch {
      // Older git or unreadable config: fall back to .gitignore only.
    }
  }
}

/** One-line JSON commit subject; parseCheckpointMessage is its inverse. */
export function encodeCheckpointMessage(label: string): string {
  return JSON.stringify({ label: label.replace(/\s+/gu, " ").trim().slice(0, MAX_CHECKPOINT_LABEL) });
}

export function parseCheckpointMessage(subject: string): string {
  try {
    const parsed = JSON.parse(subject) as { label?: unknown };
    if (typeof parsed.label === "string" && parsed.label) return parsed.label;
  } catch {
    // Pre-JSON or hand-made commits: the raw subject is the best label there is.
  }
  return subject;
}

/** Snapshot the workspace. Returns the checkpoint hash, or null when nothing
 * could be captured (not a directory, git missing, timeout). A workspace with
 * no changes since the last checkpoint returns the existing checkpoint hash
 * rather than minting an identical new one. */
export function createCheckpoint(cwd: string, label: string): Promise<string | null> {
  return serialize(cwd, () => createCheckpointLocked(cwd, label));
}

async function createCheckpointLocked(cwd: string, label: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) return null;
    await ensureShadowRepo(cwd);
    try {
      // --ignore-errors so one unreadable or commit-less path cannot sink the
      // whole snapshot: a nested repo with no commits makes plain `add -A`
      // exit "fatal: adding files failed", which silently disabled every
      // checkpoint for that workspace forever. It still exits non-zero after
      // skipping such paths, so a partial add is a success here.
      await shadowGit(cwd, ["add", "-A", "--ignore-errors"]);
    } catch {
      // Everything addable is staged; the commit below captures it.
    }
    try {
      await shadowGit(cwd, [...IDENTITY, "commit", "--quiet", "-m", encodeCheckpointMessage(label)]);
    } catch (error) {
      // "nothing to commit" lands on stdout, not stderr, so gather every
      // channel execFile attaches before deciding this was a real failure.
      const parts = error && typeof error === "object"
        ? [String((error as { stdout?: unknown }).stdout ?? ""), String((error as { stderr?: unknown }).stderr ?? ""), String((error as { message?: unknown }).message ?? "")]
        : [String(error)];
      // The tree being identical to the last checkpoint is a success case.
      if (!/nothing to commit|nothing added to commit|no changes added/i.test(parts.join("\n"))) return null;
    }
    return (await shadowGit(cwd, ["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export async function listCheckpoints(cwd: string): Promise<CheckpointInfo[]> {
  try {
    if (!fs.existsSync(path.join(checkpointGitDir(cwd), "HEAD"))) return [];
    const output = await shadowGit(cwd, [
      "log", `-n${MAX_LIST}`, "--format=%H%x1f%ct%x1f%s%x1e",
    ]);
    return output.split("\x1e").flatMap((record) => {
      const [hash, ts, subject] = record.trim().split("\x1f");
      if (!hash || !/^[0-9a-f]{40}$/.test(hash)) return [];
      return [{ hash, ts: Number.parseInt(ts, 10) || 0, label: parseCheckpointMessage(subject ?? "") }];
    });
  } catch {
    return [];
  }
}

export interface RestoreResult {
  ok: boolean;
  /** The safety snapshot taken just before restoring, so a restore is itself
   * undoable. Null when the pre-restore state had nothing new to capture. */
  safetyHash?: string | null;
  error?: string;
}

export function restoreCheckpoint(cwd: string, hash: string, safetyLabel: string): Promise<RestoreResult> {
  return serialize(cwd, () => restoreCheckpointLocked(cwd, hash, safetyLabel));
}

async function restoreCheckpointLocked(cwd: string, hash: string, safetyLabel: string): Promise<RestoreResult> {
  if (!/^[0-9a-f]{6,40}$/i.test(hash)) return { ok: false, error: "Invalid checkpoint id" };
  try {
    await shadowGit(cwd, ["cat-file", "-e", `${hash}^{commit}`]);
  } catch {
    return { ok: false, error: "Checkpoint not found" };
  }
  // The restore itself must be undoable, and that is the ONLY reason this
  // destructive sequence is safe to offer. If the safety snapshot fails there
  // is no way back, so refuse rather than wipe the working tree on a promise
  // we cannot keep.
  const safetyHash = await createCheckpointLocked(cwd, safetyLabel);
  if (safetyHash === null) {
    return {
      ok: false,
      safetyHash: null,
      error: "Could not snapshot the current state before restoring, so the restore was cancelled. Nothing was changed.",
    };
  }
  try {
    // read-tree makes the shadow index EXACTLY the snapshot (the safety
    // commit's add -A would otherwise leave later files tracked and shielded
    // from clean); checkout-index materializes it over the working tree; clean
    // then removes everything not in the snapshot, still honoring .gitignore
    // so ignored trees like node_modules survive untouched.
    await shadowGit(cwd, ["read-tree", hash]);
    await shadowGit(cwd, ["checkout-index", "-a", "-f"]);
    await shadowGit(cwd, ["clean", "-fd"]);
    return { ok: true, safetyHash };
  } catch (error) {
    return { ok: false, safetyHash, error: error instanceof Error ? error.message : String(error) };
  }
}
