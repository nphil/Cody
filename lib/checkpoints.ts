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

async function ensureShadowRepo(cwd: string): Promise<void> {
  const gitDir = checkpointGitDir(cwd);
  if (fs.existsSync(path.join(gitDir, "HEAD"))) return;
  await fs.promises.mkdir(gitDir, { recursive: true });
  await shadowGit(cwd, ["init", "--quiet"]);
  await shadowGit(cwd, ["config", "core.bare", "false"]);
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
export async function createCheckpoint(cwd: string, label: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) return null;
    await ensureShadowRepo(cwd);
    await shadowGit(cwd, ["add", "-A"]);
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

export async function restoreCheckpoint(cwd: string, hash: string, safetyLabel: string): Promise<RestoreResult> {
  if (!/^[0-9a-f]{6,40}$/i.test(hash)) return { ok: false, error: "Invalid checkpoint id" };
  try {
    await shadowGit(cwd, ["cat-file", "-e", `${hash}^{commit}`]);
  } catch {
    return { ok: false, error: "Checkpoint not found" };
  }
  // The restore itself must be undoable: capture the current state first.
  const safetyHash = await createCheckpoint(cwd, safetyLabel);
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
