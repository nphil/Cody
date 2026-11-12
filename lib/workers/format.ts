import type { MachineReason, WorkerProblem } from "../machines/types";

/**
 * Words for the agent: durations, sizes, counts, and what went wrong with a
 * worker. The agent reads these as text in a tool result, so they are plain
 * English with numbers it can compare.
 */

/** `0.4 s`, `12 s`, `1 min 12 s`, `2 h 05 min`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms);
  if (total < 10_000) return `${(total / 1000).toFixed(1)} s`;
  const seconds = Math.round(total / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** `812 B`, `4.1 KB`, `45 MB`, `1.2 GB` (powers of 1024, one decimal under 10). */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const text = unit === 0 || scaled >= 10 ? Math.round(scaled).toString() : scaled.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** `1 file`, `1,234 files`. */
export function formatCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

const REASON_WORDS: Record<MachineReason | WorkerProblem, string> = {
  starting: "the connection is still being set up",
  no_ssh: "this server has no ssh program",
  auth: "ssh login was refused (no accepted key)",
  host_key: "ssh does not trust the machine's host key",
  unknown_host: "the machine's name could not be resolved",
  refused: "the machine refused the connection",
  unreachable: "the machine did not answer",
  dropped: "the connection dropped",
  failed: "ssh failed",
  not_linux: "the machine is not Linux",
  read_failed: "the machine's answer could not be read",
  not_a_worker: "the machine has no /etc/cody-worker.json",
  bad_facts: "its /etc/cody-worker.json is not valid",
  no_work_root: "its work directory /srv/cody-work is missing or not writable",
};

/** A worker problem in a sentence fragment, with ssh's or the file's own line when there is one. */
export function describeReason(reason: MachineReason | WorkerProblem, detail: string = ""): string {
  const words = REASON_WORDS[reason] ?? "something went wrong";
  const line = detail.trim();
  return line ? `${words} (${line})` : words;
}

export interface LastLines {
  text: string;
  /** How many of the given lines are in `text`. */
  shown: number;
}

/** The last lines that fit in `maxBytes`, as one text (the newest line is always kept, cut if it alone is too big). */
export function lastLines(lines: readonly string[], maxBytes: number): LastLines {
  const kept: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (kept.length > 0 && size + bytes > maxBytes) break;
    kept.push(lines[index]);
    size += bytes;
  }
  kept.reverse();
  if (kept.length === 1 && size - 1 > maxBytes) return { text: kept[0].slice(-maxBytes), shown: 1 };
  return { text: kept.join("\n"), shown: kept.length };
}
