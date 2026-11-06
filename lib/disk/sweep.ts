import * as fs from "node:fs";
import * as path from "node:path";
import type { JanitorRemoval } from "./janitor";
import { isPlainName, type PathMentions } from "./mentions";
import { errorCode, findRecentChange, mapLimit, measureTree, removeTree } from "./walk";

/**
 * The flat sweep: the top-level entries of the system temp dir (and the
 * directories of `$HOME/tmp`) that nothing owns any more. These are the
 * leftovers a session's own scratch dir does not catch: the pile that existed
 * before scratch dirs did, and whatever an agent writes to `/tmp/<name>`
 * regardless of `TMPDIR`.
 *
 * An entry is removed only when EVERY one of these holds (each was learned
 * the hard way, on 2026-11-04 when a sweep like this had to be done by hand):
 *
 * 1. it is a plain file or directory (not a dot-entry such as `.X11-unix`, not
 *    a socket, pipe, device or link, not a mount point, and not a file in
 *    `$HOME/tmp`, where helper scripts and tokens live);
 * 2. nothing inside it was modified (or had its status changed) within its
 *    idle window; atime is off on these file systems, so that is the only
 *    file-level signal there is;
 * 3. no running process uses it (cwd, executable, open files, mappings, bound
 *    sockets, or a path in its command line or environment);
 * 4. no recently-active chat names it near the end of its transcript;
 * 5. it is exactly what the listing saw once the checks are done (nothing was
 *    written or replaced in between).
 *
 * What processes and chats name is read again after the checks and before the
 * first removal: the checks of a big sweep take minutes, and a command that
 * started in that time may be using an entry the first look did not see.
 *
 * A check that cannot be completed (a timeout, an unreadable directory, a
 * truncated walk) keeps the entry.
 */

export interface SweepRoot {
  path: string;
  idleMs: number;
  reason: "tmp-idle" | "home-tmp-idle";
  /** Files are left alone (`$HOME/tmp` holds helper scripts and tokens). */
  directoriesOnly: boolean;
}

export interface SweepCandidate {
  root: SweepRoot;
  name: string;
  path: string;
  stat: fs.Stats;
}

/** What the cheap listing found: the entries old enough to examine, and the
 *  paths among them whose names text cannot give back (see `isPlainName`). */
export interface SweepPlan {
  candidates: SweepCandidate[];
  searched: string[];
}

export interface SweptEntry {
  removal: JanitorRemoval;
  /** The device the entry was on, so the budget pass knows which disk it relieved. */
  dev: number;
}

/** What the running processes and the recent chats name, as two lookups. */
export interface SweepReferences {
  processes: PathMentions;
  transcripts: PathMentions;
}

export interface SweepContext extends SweepReferences {
  now: number;
  dryRun: boolean;
  /** An absolute `Date.now()` after which the rest is left for the next run. */
  deadline: number;
  /** Read what processes and chats name again, just before anything is removed.
   *  Null means it could not be read: nothing is removed. Without it the first
   *  reading stands. */
  refresh?: () => Promise<SweepReferences | null>;
}

/** Entries whose names text cannot give back are looked up by their whole path;
 *  that costs a scan per entry, so only this many are examined per run. */
const MAX_UNSEARCHABLE = 200;
const LIST_CONCURRENCY = 32;
const SWEEP_CONCURRENCY = 4;

/**
 * The entries of `roots` old enough to be looked at, oldest first, and the
 * paths of those whose names transcripts and process text can only be searched
 * for whole. Cheap: one readdir and one lstat per entry.
 */
export async function collectSweepCandidates(
  roots: readonly SweepRoot[],
  options: { now: number; protectedPaths: readonly string[] },
): Promise<SweepPlan> {
  const candidates: SweepCandidate[] = [];
  const searched: string[] = [];
  for (const root of roots) {
    let rootDev: number;
    let children: fs.Dirent[];
    try {
      rootDev = (await fs.promises.lstat(root.path)).dev;
      children = await fs.promises.readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    await mapLimit(children, LIST_CONCURRENCY, async (child) => {
      if (child.name.startsWith(".")) return;
      if (!child.isDirectory() && !(child.isFile() && !root.directoriesOnly)) return;
      const full = path.join(root.path, child.name);
      if (options.protectedPaths.some((kept) => kept === full || kept.startsWith(`${full}/`))) return;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(full);
      } catch {
        return;
      }
      if (stat.dev !== rootDev) return;
      if (options.now - Math.max(stat.mtimeMs, stat.ctimeMs) < root.idleMs) return;
      candidates.push({ root, name: child.name, path: full, stat });
    });
  }
  candidates.sort((a, b) => Math.max(a.stat.mtimeMs, a.stat.ctimeMs) - Math.max(b.stat.mtimeMs, b.stat.ctimeMs));
  const kept: SweepCandidate[] = [];
  for (const candidate of candidates) {
    if (isPlainName(candidate.name)) kept.push(candidate);
    else if (searched.length < MAX_UNSEARCHABLE) {
      searched.push(candidate.path);
      kept.push(candidate);
    }
  }
  return { candidates: kept, searched };
}

/** Run the checks on each candidate, look at what processes and chats name once
 *  more, and remove the ones that still pass. Never throws. */
export async function sweepCandidates(
  candidates: readonly SweepCandidate[],
  context: SweepContext,
): Promise<{ swept: SweptEntry[]; errors: string[] }> {
  const swept: SweptEntry[] = [];
  const errors: string[] = [];
  const fail = (target: string, error: unknown): void => {
    if (errorCode(error) !== "ENOENT") errors.push(`Could not remove ${target}: ${error instanceof Error ? error.message : String(error)}`);
  };

  const quiet: Array<{ candidate: SweepCandidate; bytes: number }> = [];
  await mapLimit(candidates, SWEEP_CONCURRENCY, async (candidate) => {
    if (Date.now() > context.deadline) return;
    if (context.processes.has(candidate.path) || context.transcripts.has(candidate.path)) return;
    try {
      const since = context.now - candidate.root.idleMs;
      const quick = await findRecentChange(candidate.path, since);
      if (quick === "recent" || quick === "unknown") return;
      // The walk certifies what `find` only suggested, and sizes what goes.
      const tree = await measureTree(candidate.path, { stopWhenNewerThanMs: since, deadline: context.deadline });
      if (!tree.complete || tree.crossedDevice || tree.newestMs > since) return;
      quiet.push({ candidate, bytes: tree.bytes });
    } catch (error) {
      fail(candidate.path, error);
    }
  });
  if (quiet.length === 0) return { swept, errors };

  const latest = context.refresh ? await context.refresh().catch(() => null) : context;
  if (latest === null) return { swept, errors };
  await mapLimit(quiet, SWEEP_CONCURRENCY, async ({ candidate, bytes }) => {
    if (latest.processes.has(candidate.path) || latest.transcripts.has(candidate.path)) return;
    try {
      const again = await fs.promises.lstat(candidate.path);
      const before = candidate.stat;
      if (again.dev !== before.dev || again.ino !== before.ino || again.mtimeMs !== before.mtimeMs || again.ctimeMs !== before.ctimeMs) return;
      if (!context.dryRun) await removeTree(candidate.path);
      swept.push({ removal: { path: candidate.path, bytes, reason: candidate.root.reason }, dev: before.dev });
    } catch (error) {
      fail(candidate.path, error);
    }
  });
  return { swept, errors };
}
