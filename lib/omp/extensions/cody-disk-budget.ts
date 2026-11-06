// Loaded by omp itself (Bun), not by Cody's bundler: keep this file free of
// Cody imports so it resolves from any install location. The few constants it
// shares with lib/disk/status.ts (the two free-space lines) and lib/disk/gate.ts
// (the type of the hidden line) are repeated here on purpose, and
// lib/omp/cody-disk-budget.test.mjs pins each pair equal.
//
// What it does, for every agent of a main chat (the main one and its
// subagents):
//  - gives it ONE static rule about scratch space and the disk budget, in the
//    system prompt. The sizes in it are read once per process, so the text never
//    changes under the provider's prompt cache;
//  - tells it when a disk it writes to runs low: one hidden line with a prompt
//    (the main agent only), and a note after a tool call, so an agent in the
//    middle of a long turn hears about it too.
//
// The note after a tool call needs a `tool_result` handler, and omp turns off
// `task.speculativeLaunch` (batch subagents starting while the call is still
// streaming) as long as any extension has one. Cody's own extensions register
// none, so this one adds it only once a disk has actually been seen low, from
// `before_agent_start` or `turn_start`. A healthy disk costs nobody that feature.
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** lib/disk/status.ts DISK_LOW_FREE_FRACTION: below this share free, sessions are told to clean up. */
export const DISK_LOW_FREE_FRACTION = 0.15;
/** lib/disk/status.ts DISK_CRITICAL_FREE_FRACTION: below this share free, Cody refuses new turns. */
export const DISK_CRITICAL_FREE_FRACTION = 0.05;
/** lib/disk/gate.ts DISK_LOW_CUSTOM_TYPE: the type of the hidden line, which the transcript never shows. */
export const DISK_LOW_CUSTOM_TYPE = "cody-disk-low";

/** A disk is looked at no more often than this, however many prompts and tool calls there are. */
export const PROBE_EVERY_MS = 60_000;
/** The least time between two notes to one agent, by how bad it is. Getting worse is announced at once. */
export const NOTICE_EVERY_MS: Record<"low" | "critical", number> = { low: 15 * 60_000, critical: 5 * 60_000 };
/** The walk that measures a scratch folder stops at this many entries, or this long, and says "at least". */
export const SCRATCH_WALK_MAX_ENTRIES = 200_000;
export const SCRATCH_WALK_MAX_MS = 1_500;

const MAX_AREAS = 8;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** What each area is called to a person; an area this file has never heard of is named by its id. */
const AREA_WORDS: Record<string, string> = { tmp: "temp space", data: "data space" };

export type DiskLevel = "ok" | "low" | "critical";

export interface Area {
  id: string;
  path: string;
}

export interface Reading extends Area {
  /** How the area is named in what the agent reads. */
  label: string;
  totalBytes: number;
  availableBytes: number;
  /** availableBytes / totalBytes, 0..1. */
  freeFraction: number;
  level: DiskLevel;
}

export interface FolderSize {
  bytes: number;
  /** The walk stopped before the end: the folder holds at least `bytes`. */
  partial: boolean;
}

type Statfs = (path: string) => { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint };

export interface Deps {
  env: Record<string, string | undefined>;
  statfs: Statfs;
  now: () => number;
  measure: (dir: string) => FolderSize;
}

type Context = { agent?: { kind?: string } };

type HiddenMessage = {
  customType: string;
  content: string;
  display: false;
  details: { level: DiskLevel; areas: Array<{ id: string; freeFraction: number }> };
  attribution: "agent";
};

type BeforeAgentStartResult = { systemPrompt?: string[]; message?: HiddenMessage };

type OmpApi = {
  on(event: "before_agent_start", handler: (event: { systemPrompt?: unknown }, ctx: Context) => BeforeAgentStartResult): void;
  on(event: "turn_start", handler: (event: unknown, ctx: Context) => void): void;
  on(event: "tool_result", handler: (event: unknown, ctx: Context) => { additionalContext: string } | undefined): void;
};

/** lib/disk/status.ts levelForFreeFraction. */
export function levelFor(freeFraction: number): DiskLevel {
  if (freeFraction < DISK_CRITICAL_FREE_FRACTION) return "critical";
  if (freeFraction < DISK_LOW_FREE_FRACTION) return "low";
  return "ok";
}

/** What Cody put in `CODY_DISK_AREAS`: `[{ id, path }]`, the disks this chat's agents write to. Anything else reads as none. */
export function parseAreas(raw: string | undefined): Area[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const areas: Area[] = [];
  for (const entry of parsed.slice(0, MAX_AREAS)) {
    if (typeof entry !== "object" || entry === null || !("id" in entry) || !("path" in entry)) continue;
    if (typeof entry.id === "string" && typeof entry.path === "string" && entry.path !== "") areas.push({ id: entry.id, path: entry.path });
  }
  return areas;
}

/**
 * How full each area is now. An area whose statfs cannot be read is left out:
 * unknown space is not empty space. On a ZFS dataset with a quota, statfs
 * reports the quota as the size, so "total" is the budget.
 */
export function readAreas(areas: readonly Area[], statfs: Statfs): Reading[] {
  const readings: Reading[] = [];
  for (const area of areas) {
    try {
      const stats = statfs(area.path);
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      if (!(totalBytes > 0)) continue;
      // bavail is what an unprivileged process may use; bfree would overstate the room.
      const availableBytes = Math.max(0, Math.min(Number(stats.bavail) * blockSize, totalBytes));
      const freeFraction = availableBytes / totalBytes;
      readings.push({ ...area, label: AREA_WORDS[area.id] ?? `the \`${area.id}\` disk`, totalBytes, availableBytes, freeFraction, level: levelFor(freeFraction) });
    } catch {
      // Unreadable, so unknown.
    }
  }
  return readings;
}

/**
 * How much a folder holds: the size of its files, as `ls -l` shows them, with
 * a hard-linked file counted once. That is how the janitor measures a scratch
 * folder for the Settings card, so the agent and the owner read the same
 * figure; and unlike disk blocks it does not lag behind a file that was just
 * written on a copy-on-write filesystem, which reports no blocks until its
 * transaction group commits. Symlinks are never followed. The walk is bounded
 * in entries and in time: a scratch folder with a million files must not stall
 * the agent it is meant to help, so past either bound the answer is "at least
 * this much".
 */
export function measureFolder(
  dir: string,
  limits: { maxEntries: number; maxMs: number } = { maxEntries: SCRATCH_WALK_MAX_ENTRIES, maxMs: SCRATCH_WALK_MAX_MS },
  now: () => number = Date.now,
): FolderSize {
  const started = now();
  const pending = [dir];
  const linked = new Set<string>();
  let bytes = 0;
  let entries = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let children;
    try {
      children = readdirSync(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      entries += 1;
      if (entries > limits.maxEntries || (entries % 1024 === 0 && now() - started > limits.maxMs)) return { bytes, partial: true };
      const full = join(next, child.name);
      if (child.isDirectory()) {
        pending.push(full);
        continue;
      }
      try {
        const stat = lstatSync(full);
        if (stat.nlink > 1) {
          const key = `${stat.dev}:${stat.ino}`;
          if (linked.has(key)) continue;
          linked.add(key);
        }
        bytes += stat.size;
      } catch {
        // Gone while the walk was under way.
      }
    }
  }
  return { bytes, partial: false };
}

/** "150 GB", "8.4 GB": whole numbers from 10 GB up, one decimal below. */
function gigabytes(bytes: number): string {
  const value = bytes / GIB;
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} GB`;
}

/** "a, b and c". */
function naturalList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A path as it should stand on a command line the agent copies: quoted unless it is plainly safe. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * THE rule. Appended to the system prompt of every agent of a main chat, once.
 * `readings` are the disks as they were when this process loaded the
 * extension, so the figures it states are this process's and never change
 * under the prompt cache.
 */
export function budgetRule(readings: readonly Reading[], env: Record<string, string | undefined>): string {
  const areas: Area[] = readings.length > 0 ? [...readings] : [{ id: "tmp", path: tmpdir() }];
  const tmpPath = areas.find((area) => area.id === "tmp")?.path ?? "/tmp";
  const budgets = readings.length > 0
    ? naturalList(readings.map((reading) => `${reading.label} (\`${reading.path}\`) is ${gigabytes(reading.totalBytes)} in total`))
    : `temp space (\`${tmpPath}\`) and the data folder are each a capped quota`;
  return [
    "Scratch and disk budget (every session and subagent follows this independently):",
    env.CODY_SCRATCH
      ? `- Throwaway files go in your scratch folder, \`$CODY_SCRATCH\` (it is also \`$TMPDIR\`). Cody deletes it once the chat has been idle for a few days. Never put anything bigger than a log file in a bare \`${tmpPath}/<name>\`.`
      : `- Throwaway files go in \`$TMPDIR\`; delete them yourself when you are done. Never put anything bigger than a log file in a bare \`${tmpPath}/<name>\`.`,
    `- The budgets are hard limits shared by every session: ${budgets}. When one is full, every session's builds fail. These figures are current: they override any remembered or older figure about \`/tmp\` or disk sizes.`,
    "- Reuse ONE cargo target directory per repo or worktree. Never create a new `*-target` directory per attempt or per review, and never copy a whole repo or stage tree into `/tmp` more than once.",
    "- When the work is finished, delete build output, staged copies, screenshots, recordings and test temp dirs. Tests must use self-cleaning temp dirs (`tmp_path`, `TempDir`, `mkdtemp` plus cleanup).",
    `- Before a big build or copy, run \`df -h ${areas.map((area) => shellWord(area.path)).join(" ")}\`. If free space is under ${Math.round(DISK_LOW_FREE_FRACTION * 100)}%, clean up first.`,
    "- Toolchains, SDKs and shared virtualenvs go under `$HOME/.cache` or `$HOME/toolchains`, never in scratch.",
  ].join("\n");
}

/**
 * The short note an agent is given when a disk runs low: which disk, how much
 * is free, how big its own scratch folder is, and to clean up. `low` is never
 * empty and is worst first.
 */
export function diskNotice(low: readonly Reading[], scratch: { size: FolderSize } | null): string {
  const disks = naturalList(low.map((reading) => {
    const percent = reading.freeFraction < 0.01 ? "under 1%" : `${Math.floor(reading.freeFraction * 100 + 1e-9)}%`;
    return `${reading.label} (${reading.path}) has ${percent} free (${gigabytes(reading.availableBytes)} of ${gigabytes(reading.totalBytes)})`;
  }));
  const held = scratch && (scratch.size.bytes >= GIB / 2 ? gigabytes(scratch.size.bytes) : `${Math.max(1, Math.round(scratch.size.bytes / MIB))} MB`);
  const own = scratch ? ` Your scratch folder ($CODY_SCRATCH) holds ${scratch.size.partial ? "at least " : ""}${held}.` : "";
  return low[0].level === "critical"
    ? `Disk space is critically low: ${disks}, and Cody has stopped starting new work.${own} Stop large builds and copies and delete what you no longer need now, then tell the user what you removed.`
    : `Disk space is low: ${disks}.${own} Clean up now: delete build output, staged copies, screenshots, recordings and test temp dirs you no longer need.`;
}

/**
 * The extension, over its collaborators (a test hands in a fake disk and a fake
 * clock). The rule is built once per process, by the first agent that loads it;
 * everything else is per agent session.
 */
export function createDiskBudget(deps: Deps): (pi: OmpApi) => void {
  let rule: string | undefined;

  return function codyDiskBudget(pi: OmpApi): void {
    let reading: { at: number; low: Reading[] } | null = null;
    let lastNotice: { at: number; level: DiskLevel } | null = null;
    let toolResultsHooked = false;

    /** The disks that are low right now, worst first. Looked at no more than once a minute. */
    const lowNow = (): Reading[] => {
      const now = deps.now();
      if (!reading || now < reading.at || now - reading.at >= PROBE_EVERY_MS) {
        const readings = readAreas(parseAreas(deps.env.CODY_DISK_AREAS), deps.statfs);
        reading = { at: now, low: readings.filter((area) => area.level !== "ok").sort((a, b) => a.freeFraction - b.freeFraction) };
      }
      return reading.low;
    };

    /** A note is due when none went out yet, the last one is old enough, or things have got worse since. */
    const noticeDue = (level: DiskLevel): boolean => {
      if (level === "ok") return false;
      if (lastNotice === null) return true;
      return deps.now() - lastNotice.at >= NOTICE_EVERY_MS[level] || (level === "critical" && lastNotice.level !== "critical");
    };

    const noteFor = (low: Reading[]): string => {
      lastNotice = { at: deps.now(), level: low[0].level };
      const dir = deps.env.CODY_SCRATCH;
      return diskNotice(low, dir ? { size: deps.measure(dir) } : null);
    };

    /** Added only once a disk has been seen low: see the header for why not at load. */
    const hookToolResults = (): void => {
      if (toolResultsHooked) return;
      toolResultsHooked = true;
      pi.on("tool_result", () => {
        const low = lowNow();
        if (low.length === 0 || !noticeDue(low[0].level)) return undefined;
        return { additionalContext: noteFor(low) };
      });
    };

    pi.on("before_agent_start", (event, ctx) => {
      const result: BeforeAgentStartResult = {};
      // Never replace a prompt this file cannot read: the result REPLACES the system prompt.
      if (Array.isArray(event?.systemPrompt)) {
        const current: string[] = event.systemPrompt;
        rule ??= budgetRule(readAreas(parseAreas(deps.env.CODY_DISK_AREAS), deps.statfs), deps.env);
        result.systemPrompt = current.includes(rule) ? current : [...current, rule];
      }
      const low = lowNow();
      if (low.length > 0) {
        hookToolResults();
        // Subagents are briefed by the agent that spawns them, and a subagent's transcript is rendered separately.
        if (ctx.agent?.kind === "main" && noticeDue(low[0].level)) {
          result.message = {
            customType: DISK_LOW_CUSTOM_TYPE,
            content: noteFor(low),
            display: false,
            details: { level: low[0].level, areas: low.map((area) => ({ id: area.id, freeFraction: area.freeFraction })) },
            attribution: "agent",
          };
        }
      }
      return result;
    });

    // A turn that runs for hours sees no new prompt: this is where a disk that
    // fills in the middle of it is first noticed, at most once a minute.
    pi.on("turn_start", () => {
      if (!toolResultsHooked && lowNow().length > 0) hookToolResults();
    });
  };
}

export default createDiskBudget({ env: process.env, statfs: statfsSync, now: Date.now, measure: (dir) => measureFolder(dir) });
