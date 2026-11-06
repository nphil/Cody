import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The file-system plumbing the disk janitor (and the checkpoint prune) share:
 * measure a tree without following a link, ask `find` whether anything in a
 * tree changed lately, run a scan at the lowest priority, delete a tree that
 * refuses to be deleted.
 *
 * Everything here is read-only except `removeTree`, never follows a symbolic
 * link, and never throws on a file that vanished mid-walk: a busy temp dir
 * loses entries while it is being read.
 */

const DEFAULT_MAX_ENTRIES = 2_000_000;
/** lstat calls in flight per directory: enough to keep the libuv pool busy, few enough not to starve the rest of the server. */
const BATCH = 64;
/** `find` over a huge tree is quick; one that takes this long is stuck on something. */
const FIND_TIMEOUT_MS = 120_000;
/** Deleting a big tree is slow at the lowest priority; one that takes this long is stuck. */
const REMOVE_TIMEOUT_MS = 30 * 60_000;

/** The errno name (`ENOENT`, `EACCES`) of a failed fs call, when it has one. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The executable `name` on PATH, read at call time (installs and tests change PATH). */
export function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

/** `command` behind `nice` and `ionice` when they exist, so a background scan
 *  never competes with the chats it serves. Both replace themselves with the
 *  command (same pid), so a timeout kill still reaches it. */
export function lowPriorityCommand(command: string, args: string[]): { command: string; args: string[] } {
  const nice = findExecutable("nice");
  const ionice = findExecutable("ionice");
  if (nice && ionice) return { command: nice, args: ["-n", "19", ionice, "-c", "3", command, ...args] };
  if (nice) return { command: nice, args: ["-n", "19", command, ...args] };
  if (ionice) return { command: ionice, args: ["-c", "3", command, ...args] };
  return { command, args };
}

/** Run `fn` over `items`, at most `limit` at a time. `fn` must not throw. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface TreeStats {
  /** Bytes in every regular file and link beneath the path (apparent size, as
   *  `ls -l` shows it; a file with several hard links counts once). */
  bytes: number;
  /** Everything looked at, the path itself included. */
  entries: number;
  /** The newest modification or status-change time seen, in ms; 0 when nothing was read.
   *  Status change counts because it cannot be back-dated: a tree restored
   *  with `tar` or `cp -a` keeps its old modification times but is brand new. */
  newestMs: number;
  /** The newest modification time alone, for callers that judge by what a
   *  person's tools wrote rather than by what restored or copied the tree. */
  newestModifiedMs: number;
  /** False when a limit, an unreadable directory or an early stop cut the walk
   *  short: `bytes` is then a lower bound and `newestMs` may miss newer files. */
  complete: boolean;
  /** Something beneath lives on another file system (a mount): deleting the
   *  tree would reach into it. */
  crossedDevice: boolean;
  /** The device the path itself is on; null when it could not be read. */
  dev: number | null;
}

export interface MeasureOptions {
  /** Stop after this many entries (the answer is then incomplete). */
  maxEntries?: number;
  /** An absolute `Date.now()` cut-off (the answer is then incomplete). */
  deadline?: number;
  /** Stop at the first entry newer than this: the caller only wanted to know
   *  whether the tree is quiet. */
  stopWhenNewerThanMs?: number;
}

/** Size and newest change of everything under `root`, by lstat: a link is
 *  counted as a link and never entered, so the walk cannot leave the tree or
 *  loop. A directory on another device is not entered either. */
export async function measureTree(root: string, options: MeasureOptions = {}): Promise<TreeStats> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const stats: TreeStats = { bytes: 0, entries: 0, newestMs: 0, newestModifiedMs: 0, complete: true, crossedDevice: false, dev: null };
  const multiplyLinked = new Set<string>();

  let top: fs.Stats;
  try {
    top = await fs.promises.lstat(root);
  } catch (error) {
    if (!isMissing(error)) stats.complete = false;
    return stats;
  }
  stats.dev = top.dev;

  const account = (entry: fs.Stats): void => {
    stats.entries += 1;
    const changed = Math.max(entry.mtimeMs, entry.ctimeMs);
    if (changed > stats.newestMs) stats.newestMs = changed;
    if (entry.mtimeMs > stats.newestModifiedMs) stats.newestModifiedMs = entry.mtimeMs;
    if (entry.dev !== top.dev) stats.crossedDevice = true;
    if (entry.isDirectory()) return;
    if (entry.nlink > 1) {
      const key = `${entry.dev}:${entry.ino}`;
      if (multiplyLinked.has(key)) return;
      multiplyLinked.add(key);
    }
    stats.bytes += entry.size;
  };

  const shouldStop = (): boolean => {
    if (stats.crossedDevice || stats.entries >= maxEntries) return true;
    if (options.stopWhenNewerThanMs !== undefined && stats.newestMs > options.stopWhenNewerThanMs) return true;
    return options.deadline !== undefined && Date.now() > options.deadline;
  };

  account(top);
  if (!top.isDirectory()) return stats;

  const pending = [root];
  const visit = async (dir: string, names: string[]): Promise<void> => {
    const results = await Promise.all(names.map(async (name) => {
      const full = path.join(dir, name);
      try {
        return { full, entry: await fs.promises.lstat(full) };
      } catch (error) {
        if (!isMissing(error)) stats.complete = false;
        return null;
      }
    }));
    for (const result of results) {
      if (!result) continue;
      account(result.entry);
      if (result.entry.isDirectory() && result.entry.dev === top.dev) pending.push(result.full);
    }
  };

  while (pending.length > 0) {
    if (shouldStop()) {
      stats.complete = false;
      return stats;
    }
    const dir = pending.pop()!;
    let handle: fs.Dir;
    try {
      handle = await fs.promises.opendir(dir);
    } catch (error) {
      if (!isMissing(error)) stats.complete = false;
      continue;
    }
    try {
      let names: string[] = [];
      for await (const child of handle) {
        names.push(child.name);
        if (names.length < BATCH) continue;
        await visit(dir, names);
        names = [];
        if (shouldStop()) break;
      }
      if (names.length > 0) await visit(dir, names);
    } catch (error) {
      if (!isMissing(error)) stats.complete = false;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return stats;
}

/** What `find` says about a tree. `unsupported`: this machine's `find` cannot
 *  be asked (no `find`, or one without `-newermt`), so use `measureTree`. */
export type RecentChange = "recent" | "quiet" | "unknown" | "unsupported";

let findProbe: Promise<boolean> | undefined;

function runFind(target: string, sinceMs: number, timeoutMs: number): Promise<{ stdout: string; ok: boolean }> {
  const stamp = `@${Math.max(0, Math.floor(sinceMs / 1000))}`;
  const command = lowPriorityCommand("find", [target, "(", "-newermt", stamp, "-o", "-newerct", stamp, ")", "-print", "-quit"]);
  const { promise, resolve } = Promise.withResolvers<{ stdout: string; ok: boolean }>();
  execFile(
    command.command,
    command.args,
    { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" },
    (error, stdout) => resolve({ stdout: stdout || "", ok: !error }),
  );
  return promise;
}

/** Whether `find` can answer "anything newer than T?": asked once, of the node
 *  binary itself, which is newer than the epoch on every machine. */
function findIsUsable(): Promise<boolean> {
  findProbe ??= runFind(process.execPath, 0, 10_000).then((result) => result.stdout.trim() !== "");
  return findProbe;
}

/**
 * Did anything under `target` change (content or status) after `sinceMs`?
 * Asked of `find` at the lowest priority, which stops at the first hit and
 * walks a big tree far faster than Node. `recent` (even when `find` hit an
 * error afterwards) means keep; `unknown` is a timeout or an error and must be
 * treated as keep too.
 */
export async function findRecentChange(target: string, sinceMs: number, timeoutMs: number = FIND_TIMEOUT_MS): Promise<RecentChange> {
  if (!(await findIsUsable())) return "unsupported";
  const result = await runFind(target, sinceMs, timeoutMs);
  if (result.stdout.trim() !== "") return "recent";
  return result.ok ? "quiet" : "unknown";
}

/** Directories that refuse to give up their entries (Go's module cache, Nix
 *  stores are read-only): open every one up. Directories only, never following
 *  a link. */
async function makeTreeWritable(root: string): Promise<void> {
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    await fs.promises.chmod(dir, 0o700).catch(() => undefined);
    const children = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isDirectory()) pending.push(path.join(dir, child.name));
    }
  }
}

/** Deleting a tree is quicker in `rm` and, more to the point, does not stall
 *  the server: Node's recursive rm queues tens of thousands of unlinks on the
 *  four libuv threads every other file read, DNS lookup and zlib call of every
 *  chat shares (measured: 100,000 files, DNS and stat probes waited 2.4 s;
 *  with a separate `rm` the worst wait was 13 ms). */
async function removeWithRm(target: string): Promise<boolean> {
  const command = lowPriorityCommand("rm", ["-rf", "--", target]);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile(command.command, command.args, { timeout: REMOVE_TIMEOUT_MS, killSignal: "SIGKILL" }, (error) => resolve(!error));
  return promise;
}

/** `rm -rf`, run as a low-priority process of its own where there is an `rm`:
 *  a link inside is unlinked, never entered. A tree that is read-only is opened
 *  up and tried once more; with no `rm`, Node does it. */
export async function removeTree(target: string): Promise<void> {
  const external = findExecutable("rm") !== null;
  if (external && (await removeWithRm(target))) return;
  await makeTreeWritable(target);
  if (external && (await removeWithRm(target))) return;
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
}
