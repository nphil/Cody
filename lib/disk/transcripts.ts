import * as fs from "node:fs";
import * as path from "node:path";
import type { PathMentions } from "./mentions";
import { mapLimit } from "./walk";

/**
 * The chat transcripts (`<sessions dir>/<project>/<stamp>_<id>.jsonl`, with each
 * chat's subagents beneath `<stamp>_<id>/`) as the janitor needs them:
 *
 * - which chat was last active when (a chat's scratch dir is idle only when the
 *   chat is);
 * - which temp paths the recent end of a transcript names (a venv, a toolchain
 *   or a build dir that no process holds right now, but the chat will use
 *   again).
 *
 * Read-only, and bounded: only the tail of each recently-active file is read,
 * and the total is capped however many chats are busy.
 */

const MAX_DEPTH = 8;
const MAX_FILES = 200_000;
const TRANSCRIPT_EXTENSION = ".jsonl";
/** The recent end of one transcript: what "last 2 MiB" of a long chat covers. */
export const TAIL_MAX_BYTES = 2 * 1024 * 1024;
const TAIL_MIN_BYTES = 64 * 1024;
/** All tails of one run together. */
export const TAIL_BUDGET_BYTES = 128 * 1024 * 1024;
const READ_CONCURRENCY = 8;

export interface SessionFile {
  path: string;
  mtimeMs: number;
  size: number;
  /** The chat this file belongs to (a subagent's file belongs to its parent); null when the name does not say. */
  sessionId: string | null;
}

/** `<project>/<stamp>_<id>.jsonl` and `<project>/<stamp>_<id>/…/<name>.jsonl` both belong to chat `<id>`. */
function sessionIdOf(relative: string): string | null {
  const parts = relative.split(path.sep);
  const owner = parts.length >= 2 ? parts[1] : parts[0];
  const stem = owner.endsWith(TRANSCRIPT_EXTENSION) ? owner.slice(0, -TRANSCRIPT_EXTENSION.length) : owner;
  const cut = stem.indexOf("_");
  const id = cut >= 0 ? stem.slice(cut + 1) : stem;
  return id === "" ? null : id;
}

/** Every `.jsonl` beneath `sessionsDir`, links not followed. A missing dir is an empty answer. */
export async function indexSessionFiles(sessionsDir: string): Promise<SessionFile[]> {
  const found: Array<{ full: string; relative: string }> = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir: sessionsDir, depth: 0 }];
  while (pending.length > 0 && found.length < MAX_FILES) {
    const { dir, depth } = pending.pop()!;
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (depth < MAX_DEPTH) pending.push({ dir: full, depth: depth + 1 });
      } else if (child.isFile() && child.name.endsWith(TRANSCRIPT_EXTENSION)) {
        found.push({ full, relative: path.relative(sessionsDir, full) });
      }
    }
  }
  const files: SessionFile[] = [];
  await mapLimit(found, READ_CONCURRENCY * 2, async ({ full, relative }) => {
    try {
      const stat = await fs.promises.lstat(full);
      files.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size, sessionId: sessionIdOf(relative) });
    } catch {
      // Removed since the listing.
    }
  });
  return files;
}

/** The newest write to any of a chat's files (its subagents' included), by chat id. */
export function lastActivityBySession(files: readonly SessionFile[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const file of files) {
    if (file.sessionId !== null && file.mtimeMs > (latest.get(file.sessionId) ?? 0)) latest.set(file.sessionId, file.mtimeMs);
  }
  return latest;
}

/**
 * How many bytes to read from the end of each file so the total stays inside
 * `budget`: files smaller than their fair share are read whole and what they
 * leave over goes to the bigger ones (water-filling), each capped at `maxTail`.
 * Same order as `sizes`.
 */
export function planTails(sizes: readonly number[], budget: number, maxTail: number, minTail: number): number[] {
  const order = sizes.map((_, index) => index).sort((a, b) => sizes[a] - sizes[b]);
  let remaining = budget;
  let cap = maxTail;
  for (let rank = 0; rank < order.length; rank++) {
    const share = remaining / (order.length - rank);
    const wanted = Math.min(sizes[order[rank]], maxTail);
    if (wanted > share) {
      cap = Math.min(maxTail, Math.max(minTail, Math.floor(share)));
      break;
    }
    remaining -= wanted;
  }
  return sizes.map((size) => Math.min(size, cap));
}

export interface TailReadOptions {
  now: number;
  /** Only files written within this long are read. */
  windowMs: number;
  budgetBytes?: number;
  maxTailBytes?: number;
  minTailBytes?: number;
}

/**
 * Feed the recent end of every recently-written transcript into `mentions`,
 * newest first. When there are too many to read `minTailBytes` of each inside
 * the budget, the least recently written are left out.
 */
export async function readTranscriptMentions(
  files: readonly SessionFile[],
  mentions: PathMentions,
  options: TailReadOptions,
): Promise<{ files: number; bytes: number }> {
  const budget = options.budgetBytes ?? TAIL_BUDGET_BYTES;
  const maxTail = options.maxTailBytes ?? TAIL_MAX_BYTES;
  const minTail = options.minTailBytes ?? TAIL_MIN_BYTES;
  const recent = files
    .filter((file) => options.now - file.mtimeMs <= options.windowMs && file.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.floor(budget / minTail)));
  const tails = planTails(recent.map((file) => file.size), budget, maxTail, minTail);
  let bytes = 0;
  let read = 0;
  await mapLimit(recent.map((file, index) => ({ file, length: tails[index] })), READ_CONCURRENCY, async ({ file, length }) => {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(file.path, "r");
      const { size } = await handle.stat();
      const wanted = Math.min(length, size);
      const buffer = Buffer.alloc(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, size - wanted);
      mentions.addText(buffer.toString("utf8", 0, bytesRead));
      bytes += bytesRead;
      read += 1;
    } catch {
      // Removed or unreadable: it names nothing.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  });
  return { files: read, bytes };
}
