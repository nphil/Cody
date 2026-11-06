import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import { homedir } from "os";
import path from "path";
import { lowPriorityCommand, measureTree, removeTree } from "./disk/walk";
import { getAgentDir } from "./omp/paths";

function timeoutFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Leave one second for process cleanup and promise delivery within the 15-second
 * send budget. Large first snapshots retry in the background, where they cannot
 * delay a message. */
const CHECKPOINT_TIMEOUT_MS = Math.min(
  timeoutFromEnv("CODY_CHECKPOINT_TIMEOUT_MS", 14_000),
  14_000,
);
const WARMUP_TIMEOUT_MS = Math.min(
  timeoutFromEnv("CODY_CHECKPOINT_WARMUP_TIMEOUT_MS", 10 * 60_000),
  10 * 60_000,
);
const BACKOFF_MS = 6 * 60 * 60_000;
const MAX_SNAPSHOT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_LIST = 50;
export const MAX_CHECKPOINT_LABEL = 80;

export interface CheckpointInfo {
  hash: string;
  label: string;
  /** Unix seconds. */
  ts: number;
}

/** Where every workspace's shadow repo lives, in the instance data dir. */
export function checkpointStoreDir(): string {
  return path.join(getAgentDir(), "cody-checkpoints");
}

/** Workspace checkpoints live in a shadow git repository OUTSIDE the workspace
 * (under the omp agent dir), pointed at the workspace via GIT_WORK_TREE. The
 * workspace's own .git is untouched: git always skips entries named .git, so
 * snapshots capture files only — never the project repo's branches or index.
 * .gitignore applies, which keeps ignored files out of snapshots and safe from
 * restore's clean pass. */
export function checkpointGitDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const digest = createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  const name = path.basename(resolved).replace(/[^\w.-]+/gu, "-").slice(0, 40) || "workspace";
  return path.join(checkpointStoreDir(), name + "-" + digest);
}

interface ShadowGitOptions {
  deadline?: number;
  lowPriority?: boolean;
  maxBuffer?: number;
}

interface ShadowQueueTask {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ShadowQueue {
  running: boolean;
  pending: ShadowQueueTask[];
}

class CheckpointTimeoutError extends Error {
  code = "ETIMEDOUT";

  constructor() {
    super("Checkpoint snapshot exceeded its time budget");
    this.name = "CheckpointTimeoutError";
  }
}

function isKilledOrTimedOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const detail = error as { code?: unknown; killed?: unknown; signal?: unknown; name?: unknown };
  return detail.code === "ETIMEDOUT"
    || detail.name === "CheckpointTimeoutError"
    || detail.killed === true
    || detail.signal === "SIGKILL";
}

async function execFileAsync(
  command: string,
  args: string[],
  options: import("child_process").ExecFileOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout: String(stdout) });
      }
    });
  });
}

const sweptShadowDirs = new Set<string>();

async function cleanupShadowGarbage(gitDir: string, removeStaleLock = false): Promise<void> {
  const objectsDir = path.join(gitDir, "objects");
  try {
    const packDir = path.join(objectsDir, "pack");
    for (const entry of await fs.promises.readdir(packDir, { withFileTypes: true })) {
      if (entry.name.startsWith("tmp_pack_")) {
        await fs.promises.rm(path.join(packDir, entry.name), { force: true, recursive: true });
      }
    }
  } catch {
    // The repo may not have been initialized yet.
  }
  try {
    for (const directory of await fs.promises.readdir(objectsDir, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const objectDir = path.join(objectsDir, directory.name);
      for (const entry of await fs.promises.readdir(objectDir, { withFileTypes: true })) {
        if (entry.name.startsWith("tmp_obj_")) {
          await fs.promises.rm(path.join(objectDir, entry.name), { force: true, recursive: true });
        }
      }
    }
  } catch {
    // The repo may not have been initialized yet.
  }
  if (removeStaleLock) {
    const lockPath = path.join(gitDir, "index.lock");
    try {
      const stat = await fs.promises.stat(lockPath);
      if (Date.now() - stat.mtimeMs > CHECKPOINT_TIMEOUT_MS) await fs.promises.unlink(lockPath);
    } catch {
      // No stale index lock to remove.
    }
  }
}

async function sweepFirstTouch(gitDir: string): Promise<void> {
  if (sweptShadowDirs.has(gitDir)) return;
  await cleanupShadowGarbage(gitDir, true);
  sweptShadowDirs.add(gitDir);
}

async function removeUnfinishedIndexLock(gitDir: string, existedBefore: boolean, startedAt: number): Promise<void> {
  if (existedBefore) return;
  const lockPath = path.join(gitDir, "index.lock");
  try {
    const stat = await fs.promises.stat(lockPath);
    // The workspace queue prevents another local shadow-git command from owning
    // this lock. Only remove a lock that appeared during the command we killed.
    if (stat.mtimeMs >= startedAt - 1000) await fs.promises.unlink(lockPath);
  } catch {
    // The git process may already have removed its own lock.
  }
}

async function shadowGit(cwd: string, args: string[], options: ShadowGitOptions = {}): Promise<string> {
  const gitDir = checkpointGitDir(cwd);
  await sweepFirstTouch(gitDir);
  const timeout = options.deadline === undefined
    ? CHECKPOINT_TIMEOUT_MS
    : options.deadline - Date.now();
  if (timeout <= 0) throw new CheckpointTimeoutError();
  const command = options.lowPriority ? lowPriorityCommand("git", args) : { command: "git", args };
  const lockPath = path.join(gitDir, "index.lock");
  let lockExistedBefore = false;
  try {
    await fs.promises.access(lockPath);
    lockExistedBefore = true;
  } catch {
    // No lock existed when this git command started.
  }
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync(command.command, command.args, {
      // Run FROM the work tree so relative pathspecs ("." in checkout/clean)
      // resolve against the workspace, not the server's own cwd.
      cwd: path.resolve(cwd),
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_DIR: gitDir,
        GIT_WORK_TREE: path.resolve(cwd),
        // A stray GIT_INDEX_FILE would corrupt the interplay of the two repos.
        GIT_INDEX_FILE: undefined as unknown as string,
        HOME: process.env.HOME ?? homedir(),
      },
    });
    return stdout;
  } catch (error) {
    // execFile reports only after SIGKILL has reaped its child; only then is it
    // safe to remove half-written pack, loose-object, and index-lock files.
    if (isKilledOrTimedOut(error)) {
      await cleanupShadowGarbage(gitDir);
      await removeUnfinishedIndexLock(gitDir, lockExistedBefore, startedAt);
    }
    throw error;
  }
}

const IDENTITY = ["-c", "user.name=Cody", "-c", "user.email=cody@localhost"];

/** All operations for one cwd share this queue. Warm-ups are inserted before
 * waiting work so restores cannot slip between a timed-out snapshot and retry. */
const workspaceQueues = new Map<string, ShadowQueue>();
const warmups = new Map<string, Promise<void>>();

async function runNext(key: string, queue: ShadowQueue): Promise<void> {
  if (queue.running) return;
  const task = queue.pending.shift();
  if (!task) {
    if (workspaceQueues.get(key) === queue) workspaceQueues.delete(key);
    return;
  }
  queue.running = true;
  try {
    task.resolve(await task.operation());
  } catch (error) {
    task.reject(error);
  } finally {
    queue.running = false;
    if (queue.pending.length) void runNext(key, queue);
    else if (workspaceQueues.get(key) === queue) workspaceQueues.delete(key);
  }
}

function serialize<T>(cwd: string, operation: () => Promise<T>, priority = false): Promise<T> {
  const key = path.resolve(cwd);
  let queue = workspaceQueues.get(key);
  if (!queue) {
    queue = { running: false, pending: [] };
    workspaceQueues.set(key, queue);
  }
  return new Promise<T>((resolve, reject) => {
    const task: ShadowQueueTask = {
      operation: async () => operation(),
      resolve: (value) => resolve(value as T),
      reject,
    };
    if (priority) queue!.pending.unshift(task);
    else queue!.pending.push(task);
    if (!queue!.running) void runNext(key, queue!);
  });
}

/**
 * Directories that must never be snapshotted wholesale. Checkpointing is
 * scoped to a project; pointed at a home directory or a filesystem root it
 * captures caches instead of source — a session that opened `/data/home` as
 * its workspace grew a 3.5 GB shadow repo out of `.npm`, `.gradle` and a
 * node_modules tree, because those roots carry no `.gitignore` to exclude
 * anything. The instance data dir is excluded for a second reason: it holds
 * the shadow repos themselves, so snapshotting it feeds on its own output.
 *
 * Exported for the test; callers go through the checkpoint API.
 */
export function isUncheckpointableRoot(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  if (resolved === path.parse(resolved).root) return true;
  const home = process.env.HOME?.trim() || homedir();
  if (home && resolved === path.resolve(home)) return true;
  const agentDir = path.resolve(getAgentDir());
  // The agent dir itself, its parent (the instance data dir), or anything
  // inside it — all of which are Cody's own state, never a workspace.
  if (resolved === agentDir || resolved === path.dirname(agentDir)) return true;
  const relative = path.relative(agentDir, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function escapeGitIgnoreLiteral(value: string): string {
  let leadingSpaces = 0;
  while (leadingSpaces < value.length && value[leadingSpaces] === " ") leadingSpaces++;
  let trailingStart = value.length;
  while (trailingStart > 0 && value[trailingStart - 1] === " ") trailingStart--;
  let escaped = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\" || character === "*" || character === "?" || character === "[" || character === "]" || character === "!" || character === "#" || (character === " " && (index < leadingSpaces || index >= trailingStart))) {
      escaped += "\\";
    }
    escaped += character;
  }
  return escaped;
}

function baseExcludeLines(cwd: string): string[] {
  const worktree = path.resolve(cwd);
  const excludeLines = [
    "# Written by Cody — do not edit.",
    "node_modules/",
    "target/",
    ".gradle/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".next/",
    ".nuxt/",
    ".svelte-kit/",
    ".vite/",
    ".output/",
    ".turbo/",
    ".cache/",
    "dist/",
    "coverage/",
  ];
  const store = checkpointStoreDir();
  const relativeStore = path.relative(worktree, store);
  if (relativeStore && !relativeStore.startsWith("..") && !path.isAbsolute(relativeStore)) {
    excludeLines.push("/" + escapeGitIgnoreLiteral(relativeStore.split(path.sep).join("/")) + "/");
  }
  const agentRelative = path.relative(worktree, getAgentDir());
  if (agentRelative && !agentRelative.startsWith("..") && !path.isAbsolute(agentRelative)) {
    excludeLines.push("/" + escapeGitIgnoreLiteral(agentRelative.split(path.sep).join("/")) + "/");
  }
  return excludeLines;
}

async function writeExcludeFile(cwd: string, largeFiles: string[]): Promise<void> {
  const gitDir = checkpointGitDir(cwd);
  await fs.promises.mkdir(path.join(gitDir, "info"), { recursive: true });
  const excludeLines = baseExcludeLines(cwd);
  for (const filename of largeFiles) excludeLines.push("/" + escapeGitIgnoreLiteral(filename));
  await fs.promises.writeFile(path.join(gitDir, "info", "exclude"), excludeLines.join("\n") + "\n", "utf8");
}

async function ensureShadowRepo(cwd: string, deadline: number, lowPriority: boolean): Promise<void> {
  const gitDir = checkpointGitDir(cwd);
  const worktree = path.resolve(cwd);
  const options = { deadline, lowPriority };
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    await fs.promises.mkdir(gitDir, { recursive: true });
    await shadowGit(cwd, ["init", "--quiet"], options);
    await shadowGit(cwd, ["config", "core.bare", "false"], options);
  }

  // The workspace's own .git/info/exclude is honored too, so its ignored files
  // are neither captured nor deleted by a restore.
  const workspaceExclude = path.join(worktree, ".git", "info", "exclude");
  if (fs.existsSync(workspaceExclude)) {
    try {
      await shadowGit(cwd, ["config", "core.excludesFile", workspaceExclude], options);
    } catch (error) {
      if (isKilledOrTimedOut(error)) throw error;
      // Older git or unreadable config: fall back to .gitignore only.
    }
  }
  await writeExcludeFile(cwd, []);
}

async function listLargeUntrackedFiles(cwd: string, deadline: number, lowPriority: boolean): Promise<string[]> {
  const output = await shadowGit(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], {
    deadline,
    lowPriority,
    maxBuffer: 256 * 1024 * 1024,
  });
  const worktree = path.resolve(cwd);
  const largeFiles: string[] = [];
  for (const filename of output.split("\0")) {
    if (!filename) continue;
    if (Date.now() >= deadline) throw new CheckpointTimeoutError();
    try {
      const stat = await fs.promises.lstat(path.resolve(worktree, ...filename.split("/")));
      if (stat.isFile() && stat.size > MAX_SNAPSHOT_FILE_BYTES) largeFiles.push(filename);
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") largeFiles.push(filename);
    }
  }
  return largeFiles;
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

/** Snapshot the workspace. Returns its commit hash, or null when no checkpoint
 * can be captured. A complete snapshot has one short or warm-up time budget. */
export function createCheckpoint(cwd: string, label: string): Promise<string | null> {
  const key = path.resolve(cwd);
  if (isUncheckpointableRoot(cwd) || warmups.has(key) || hasActiveBackoff(cwd)) return Promise.resolve(null);
  return serialize(cwd, async () => {
    if (warmups.has(key) || hasActiveBackoff(cwd)) return null;
    return createCheckpointLocked(cwd, label);
  });
}

function backoffMarkerPath(cwd: string): string {
  return path.join(checkpointGitDir(cwd), "cody-backoff.json");
}

function hasActiveBackoff(cwd: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(backoffMarkerPath(cwd), "utf8")) as { until?: unknown };
    return typeof marker.until === "number" && Number.isFinite(marker.until) && marker.until > Date.now();
  } catch {
    return false;
  }
}

async function clearBackoff(cwd: string): Promise<void> {
  try {
    await fs.promises.rm(backoffMarkerPath(cwd), { force: true });
  } catch {
    // A missing marker does not make a successful checkpoint fail.
  }
}

async function writeBackoff(cwd: string, reason: string): Promise<void> {
  try {
    const gitDir = checkpointGitDir(cwd);
    await fs.promises.mkdir(gitDir, { recursive: true });
    await fs.promises.writeFile(backoffMarkerPath(cwd), JSON.stringify({
      until: Date.now() + BACKOFF_MS,
      reason: reason.slice(0, 500),
    }) + "\n", "utf8");
  } catch {
    // Backoff is best effort when the checkpoint store itself is unavailable.
  }
}

function startWarmup(cwd: string, label: string): void {
  const key = path.resolve(cwd);
  if (warmups.has(key) || hasActiveBackoff(cwd)) return;
  const running = serialize(cwd, async () => {
    try {
      const hash = await snapshotWorkspace(cwd, label, WARMUP_TIMEOUT_MS, true);
      if (hash) await clearBackoff(cwd);
      else await writeBackoff(cwd, "Warm-up completed without producing a checkpoint");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await writeBackoff(cwd, reason || "Warm-up failed");
    }
  }, true).finally(() => {
    warmups.delete(key);
  });
  warmups.set(key, running);
  void running.catch(() => undefined);
}

async function createCheckpointLocked(cwd: string, label: string): Promise<string | null> {
  if (hasActiveBackoff(cwd)) return null;
  try {
    return await snapshotWorkspace(cwd, label, CHECKPOINT_TIMEOUT_MS, false);
  } catch (error) {
    if (isKilledOrTimedOut(error)) startWarmup(cwd, label);
    return null;
  }
}

async function snapshotWorkspace(cwd: string, label: string, timeoutMs: number, lowPriority: boolean): Promise<string | null> {
  if (isUncheckpointableRoot(cwd)) return null;
  const deadline = Date.now() + timeoutMs;
  const worktree = path.resolve(cwd);
  const stat = await fs.promises.stat(worktree);
  if (!stat.isDirectory()) return null;
  if (Date.now() >= deadline) throw new CheckpointTimeoutError();
  await ensureShadowRepo(cwd, deadline, lowPriority);

  // Drop last run's per-file rules before listing, so a file that shrank is
  // considered again. Only default/user excludes apply to this listing.
  await writeExcludeFile(cwd, []);
  const largeFiles = await listLargeUntrackedFiles(cwd, deadline, lowPriority);
  if (Date.now() >= deadline) throw new CheckpointTimeoutError();
  await writeExcludeFile(cwd, largeFiles);

  try {
    // --ignore-errors keeps one unreadable or empty nested repo from sinking the
    // whole snapshot; a partial add is still worth committing.
    await shadowGit(cwd, ["add", "-A", "--ignore-errors"], { deadline, lowPriority });
  } catch (error) {
    if (isKilledOrTimedOut(error)) throw error;
    // Everything addable is staged; the commit below captures it.
  }
  try {
    await shadowGit(cwd, [...IDENTITY, "commit", "--quiet", "-m", encodeCheckpointMessage(label)], { deadline, lowPriority });
  } catch (error) {
    if (isKilledOrTimedOut(error)) throw error;
    const parts = error && typeof error === "object"
      ? [String((error as { stdout?: unknown }).stdout ?? ""), String((error as { stderr?: unknown }).stderr ?? ""), String((error as { message?: unknown }).message ?? "")]
      : [String(error)];
    // A tree identical to the last checkpoint is still a successful snapshot.
    if (!/nothing to commit|nothing added to commit|no changes added/i.test(parts.join("\n"))) return null;
  }
  const hash = (await shadowGit(cwd, ["rev-parse", "HEAD"], { deadline, lowPriority })).trim() || null;
  if (hash) await clearBackoff(cwd);
  return hash;
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

/**
 * Retention. Every workspace a chat ever opened gets a shadow repo that nothing
 * else removed: 10 GB of them on the owner's instance, on top of the 21 GB of
 * leaked packs. The janitor (lib/disk/janitor.ts) prunes the store repo by
 * repo, never inside one: a repo goes wholesale or stays whole, because half
 * of an undo history is worse than none.
 */

/** `checkpointGitDir`'s names: the workspace's folder name, a dash, 12 hex digits of the path hash. */
const SHADOW_REPO_NAME = /^[\w.-]+-[0-9a-f]{12}$/;
/** A repo touched this recently may have a snapshot in flight (a chat that just
 *  ended): it is never removed, whatever the caps say. */
const PRUNE_GRACE_MS = 10 * 60_000;

export interface CheckpointPruneOptions {
  /** The whole store may hold this many bytes … */
  maxBytes: number;
  /** … and a repo nobody used for this long is dropped. */
  maxAgeMs: number;
  now?: number;
  /** The workspaces of live chats: their repos are never removed. */
  liveCwds?: Iterable<string>;
  /** Work out what would go and delete nothing. */
  dryRun?: boolean;
}

export interface CheckpointPruneResult {
  removed: Array<{ path: string; bytes: number }>;
  /** What the store holds afterwards. */
  totalBytes: number;
  /** The device the store is on; null when there is no store yet. */
  dev: number | null;
  errors: string[];
}

/** When a shadow repo was last used: the newest of its own directory and the
 *  files every snapshot rewrites (index, HEAD, reflog, branch tips). */
async function repoLastUsedMs(gitDir: string): Promise<number> {
  let newest = (await fs.promises.stat(gitDir)).mtimeMs;
  const touched = ["HEAD", "index", path.join("logs", "HEAD")];
  try {
    for (const branch of await fs.promises.readdir(path.join(gitDir, "refs", "heads"))) {
      touched.push(path.join("refs", "heads", branch));
    }
  } catch {
    // No branch yet.
  }
  for (const name of touched) {
    try {
      newest = Math.max(newest, (await fs.promises.stat(path.join(gitDir, name))).mtimeMs);
    } catch {
      // Not there (yet).
    }
  }
  return newest;
}

/**
 * Drop whole shadow repos nobody has used for `maxAgeMs`, then, while the store
 * still exceeds `maxBytes`, the least recently used ones. The repo of a
 * workspace with a live chat is never removed (nor is one touched in the last
 * few minutes). The repos that stay lose their half-written packs and objects,
 * with the same `cleanupShadowGarbage` the first touch of a repo runs, but
 * only when no one is writing to them. Never throws.
 */
export async function pruneCheckpointStore(options: CheckpointPruneOptions): Promise<CheckpointPruneResult> {
  const now = options.now ?? Date.now();
  const store = checkpointStoreDir();
  const result: CheckpointPruneResult = { removed: [], totalBytes: 0, dev: null, errors: [] };
  let children: fs.Dirent[];
  try {
    children = await fs.promises.readdir(store, { withFileTypes: true });
    result.dev = (await fs.promises.stat(store)).dev;
  } catch {
    return result;
  }
  const live = new Set([...(options.liveCwds ?? [])].map((cwd) => checkpointGitDir(cwd)));
  const repos: Array<{ dir: string; bytes: number; lastUsed: number; removable: boolean }> = [];
  for (const child of children) {
    if (!child.isDirectory() || !SHADOW_REPO_NAME.test(child.name)) continue;
    const dir = path.join(store, child.name);
    try {
      const lastUsed = await repoLastUsedMs(dir);
      const removable = !live.has(dir) && now - lastUsed >= PRUNE_GRACE_MS;
      // What a killed snapshot left behind is garbage in any repo no one is writing right now.
      if (removable && !options.dryRun) await cleanupShadowGarbage(dir);
      repos.push({ dir, bytes: (await measureTree(dir)).bytes, lastUsed, removable });
    } catch (error) {
      result.errors.push(`Could not read the undo snapshots in ${child.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let total = repos.reduce((sum, repo) => sum + repo.bytes, 0);
  const dropped = new Set(repos.filter((repo) => repo.removable && now - repo.lastUsed >= options.maxAgeMs));
  let kept = total;
  for (const repo of dropped) kept -= repo.bytes;
  const leastRecentlyUsed = repos.filter((repo) => repo.removable && !dropped.has(repo)).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const repo of leastRecentlyUsed) {
    if (kept <= options.maxBytes) break;
    dropped.add(repo);
    kept -= repo.bytes;
  }

  for (const repo of dropped) {
    try {
      if (!options.dryRun) {
        await removeTree(repo.dir);
        sweptShadowDirs.delete(repo.dir);
      }
      result.removed.push({ path: repo.dir, bytes: repo.bytes });
      total -= repo.bytes;
    } catch (error) {
      result.errors.push(`Could not remove the undo snapshots in ${path.basename(repo.dir)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  result.totalBytes = total;
  return result;
}
