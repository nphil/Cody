import * as fs from "node:fs";
import * as path from "node:path";
import { mapLimit } from "./walk";

/**
 * Who still cares about a path under a temp root: a running process (it holds
 * the directory as its cwd, an open file or a mapped library, or names it in
 * its command line or environment) or a chat transcript that names it
 * ("sessions reuse venvs, toolchains and build dirs between commands, when no
 * process holds them").
 *
 * Both sources are scanned ONCE per janitor run into a `PathMentions`, which
 * answers "is this path, or anything beneath it, named?" by lookup. The
 * answers lean towards "yes": every doubt keeps a directory.
 */

/** Depth kept per mention. The janitor asks about a root's children and about
 *  a scratch dir one level further down, never deeper. */
const MAX_DEPTH = 4;
/** What a temp dir is usually named with. A path in free text ends at the first
 *  character outside this set, so a name that uses others cannot be read back
 *  out of text and is searched for whole instead. */
const NAME_CHARS = /^[\p{L}\p{N}._@%~-]+$/u;
const PATH_RUN = /[\p{L}\p{N}._@%~/-]*/uy;
const DELETED_SUFFIX = " (deleted)";

export interface MentionRoot {
  /** The directory as processes see it. */
  path: string;
  /** Other ways text writes the same directory, e.g. "~/tmp". */
  spellings?: string[];
}

/** A name that text cannot give back: it is looked up by its full path. */
export function isPlainName(name: string): boolean {
  return NAME_CHARS.test(name);
}

interface RootNeedles {
  path: string;
  /** `"<spelling>/"` for the path itself and each spelling. */
  needles: string[];
  spellings: string[];
}

export class PathMentions {
  private readonly found = new Set<string>();
  private readonly roots: RootNeedles[];
  private readonly searched: Array<{ path: string; needles: string[] }>;

  /** `searched`: paths whose names text cannot give back (see `isPlainName`),
   *  looked up by their whole path in every text. */
  constructor(roots: MentionRoot[], searched: string[] = []) {
    this.roots = roots.map((root) => {
      const spellings = [root.path, ...(root.spellings ?? [])];
      return { path: root.path, spellings, needles: spellings.map((spelling) => `${spelling}/`) };
    });
    this.searched = searched.map((full) => {
      const needles = [full];
      for (const root of this.roots) {
        if (!full.startsWith(`${root.path}/`)) continue;
        const rest = full.slice(root.path.length);
        for (const spelling of root.spellings) needles.push(spelling + rest);
      }
      return { path: full, needles };
    });
  }

  /** `<root>/a/b/c` records `<root>/a`, `<root>/a/b`, `<root>/a/b/c`. */
  private addSegments(root: string, segments: string[]): void {
    let current = root;
    for (const segment of segments.slice(0, MAX_DEPTH)) {
      current += `/${segment}`;
      this.found.add(current);
    }
  }

  /** An exact path (a process's cwd, an open file). */
  addPath(target: string): void {
    const clean = target.endsWith(DELETED_SUFFIX) ? target.slice(0, -DELETED_SUFFIX.length) : target;
    for (const root of this.roots) {
      if (clean.startsWith(`${root.path}/`)) {
        this.addSegments(root.path, clean.slice(root.path.length + 1).split("/").filter(Boolean));
      }
    }
  }

  /** Free text: a command line, an environment block, a transcript. */
  addText(text: string): void {
    for (const root of this.roots) {
      for (const needle of root.needles) {
        let at = text.indexOf(needle);
        while (at !== -1) {
          const start = at + needle.length;
          PATH_RUN.lastIndex = start;
          const run = PATH_RUN.exec(text)?.[0] ?? "";
          const segments = run.split("/").filter(Boolean);
          if (segments.length > 0) {
            this.addSegments(root.path, segments);
            // "see /tmp/foo." names foo, the dot belongs to the sentence.
            const last = segments[segments.length - 1];
            const bare = last.replace(/[.\-_~]+$/, "");
            if (bare !== "" && bare !== last && segments.length <= MAX_DEPTH) {
              this.found.add(`${root.path}/${[...segments.slice(0, -1), bare].join("/")}`);
            }
          }
          at = text.indexOf(needle, start + run.length);
        }
      }
    }
    for (const entry of this.searched) {
      if (!this.found.has(entry.path) && entry.needles.some((needle) => text.includes(needle))) this.found.add(entry.path);
    }
  }

  /** True when `target`, or anything beneath it, is named. */
  has(target: string): boolean {
    return this.found.has(target);
  }
}

const NUMERIC = /^\d+$/;
/** Every `fd/` and `maps` entry is cheap; this many processes at once is not a burden either. */
const PROC_CONCURRENCY = 16;

/** A bound unix socket's path (`/proc/net/unix`: eight columns, the last is the path). */
const SOCKET_PATH = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/;

export interface ProcessScanOptions {
  /** Where the process table is; tests point it at a fake one. */
  procRoot?: string;
  /** The pid that must be readable for the scan to count as trustworthy. */
  selfPid?: number;
}

/**
 * Record, into `mentions`, every path under its roots that a running process
 * uses: working directory, executable, root, open files, mapped files, bound
 * unix sockets (tmux, ssh ControlPath) and every path its command line or
 * environment names. A venv's `bin/python` resolves to /usr/bin, so only
 * argv and environ name the venv.
 *
 * Returns false when the process table cannot be trusted (no /proc, a /proc
 * hidden from us, or our own process unreadable): the caller must then keep
 * everything, because "no process uses it" would be a guess. A process that
 * belongs to someone else and cannot be inspected is simply skipped.
 */
export async function scanProcessUsage(mentions: PathMentions, options: ProcessScanOptions = {}): Promise<boolean> {
  const procRoot = options.procRoot ?? "/proc";
  let pids: string[];
  try {
    pids = (await fs.promises.readdir(procRoot)).filter((name) => NUMERIC.test(name));
  } catch {
    return false;
  }
  const self = String(options.selfPid ?? process.pid);
  let selfSeen = false;

  await mapLimit(pids, PROC_CONCURRENCY, async (pid) => {
    const base = path.join(procRoot, pid);
    for (const name of ["cwd", "exe", "root"]) {
      try {
        mentions.addPath(await fs.promises.readlink(path.join(base, name)));
        if (pid === self && name === "cwd") selfSeen = true;
      } catch {
        // Gone, a kernel thread, or someone else's process.
      }
    }
    try {
      for (const fd of await fs.promises.readdir(path.join(base, "fd"))) {
        try {
          mentions.addPath(await fs.promises.readlink(path.join(base, "fd", fd)));
        } catch {
          // Closed since the listing.
        }
      }
    } catch {
      // Someone else's process.
    }
    for (const name of ["cmdline", "environ", "maps"]) {
      try {
        mentions.addText((await fs.promises.readFile(path.join(base, name))).toString("utf8"));
      } catch {
        // Gone, or someone else's process.
      }
    }
  });
  if (!selfSeen) return false;

  try {
    for (const line of (await fs.promises.readFile(path.join(procRoot, "net", "unix"), "utf8")).split("\n")) {
      const socket = SOCKET_PATH.exec(line)?.[1];
      if (socket) mentions.addPath(socket);
    }
  } catch {
    // No socket table: nothing is bound under a temp dir that this scan could tell us about.
  }
  return true;
}
