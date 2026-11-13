import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "../type-guards";
import type { BurnCompaction, BurnEvent, BurnRequest } from "./burn-detect";

/**
 * Reading what an agent did from its transcript, for the burn guard.
 *
 * An omp chat writes one JSON line per entry to its session file, and each of
 * its helpers writes its own beside it: `<session>.jsonl`, then
 * `<session>/<Helper>.jsonl` and `<session>/<Helper>/<Helper>.<Child>.jsonl`.
 * The engine's event stream says nothing about a helper's compactions, and
 * these files do, for the main agent and every helper alike.
 *
 * Only the END of a file is read, and all of it again on each look. omp
 * rewrites the whole file after a compaction (to stamp how much it freed), so
 * a remembered offset would point into moved text; the last few megabytes are
 * the last half hour, which is all the rules look at.
 */

/** Enough of a file's identity to skip one that has not changed. */
export interface TrailStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

/** One helper's transcript. */
export interface HelperTrail {
  file: string;
  /** The helper's id: its file name, which is what omp's `cancel_subagent` takes. */
  id: string;
  /** The top-level helper it runs under (itself, when it is one). */
  root: string;
  stamp: TrailStamp;
}

const TRANSCRIPT = ".jsonl";
/** How far into a line its role is spelled; a tool result can be megabytes and is never parsed. */
const HEAD_CHARS = 600;
/** Helpers of helpers of helpers: deeper than omp nests them. */
const MAX_DEPTH = 3;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stampOf(entry: Record<string, unknown>): number | null {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

function readCompaction(entry: Record<string, unknown>): BurnCompaction | null {
  const at = stampOf(entry);
  if (at === null) return null;
  const tokens = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return { kind: "compaction", at, before: tokens(entry.tokensBefore), after: tokens(entry.tokensAfter), warned: typeof entry.warning === "string" && entry.warning !== "" };
}

function readRequest(entry: Record<string, unknown>): BurnRequest | null {
  const message = entry.message;
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return null;
  const input = count(message.usage.input);
  const cacheRead = count(message.usage.cacheRead);
  const cacheWrite = count(message.usage.cacheWrite);
  // A request that was aborted before the provider answered has no usage: it cost nothing.
  if (input + cacheRead + cacheWrite === 0) return null;
  const at = stampOf(entry);
  return at === null ? null : { kind: "request", at, fresh: input + cacheWrite, cached: cacheRead > 0 };
}

/** The request or compaction one transcript line records, or null for every other line (and for a half-written one). */
export function parseTrailLine(line: string): BurnEvent | null {
  const head = line.slice(0, HEAD_CHARS);
  const compaction = head.includes('"type":"compaction"');
  if (!compaction) {
    if (!head.includes('"type":"message"')) return null;
    // A user turn or a tool result says so at once; only an assistant line is worth parsing.
    if (head.includes('"role":"') && !head.includes('"role":"assistant"')) return null;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry)) return null;
  if (entry.type === "compaction") return readCompaction(entry);
  return entry.type === "message" ? readRequest(entry) : null;
}

/** Every request and compaction in a piece of transcript, in file order. */
export function parseTrail(text: string): BurnEvent[] {
  const events: BurnEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const event = parseTrailLine(line);
    if (event) events.push(event);
  }
  return events;
}

export async function statTrail(file: string): Promise<TrailStamp | null> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

/** The requests and compactions in the last `maxBytes` of a transcript. A file that is gone reads as empty. */
export async function readTrail(file: string, maxBytes: number): Promise<BurnEvent[]> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.allocUnsafe(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const text = buffer.toString("utf8", 0, filled);
    // Started mid-file: the first line is a fragment.
    return parseTrail(start > 0 ? text.slice(text.indexOf("\n") + 1) : text);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Every helper transcript of the chat whose own transcript is `sessionFile`.
 * `local/` holds the chat's shared files and `__…` its advisor, neither a
 * helper that can be stopped.
 */
export async function listHelperTrails(sessionFile: string): Promise<HelperTrail[]> {
  if (!sessionFile.endsWith(TRANSCRIPT)) return [];
  const trails: HelperTrail[] = [];
  const walk = async (dir: string, root: string | null, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("__") || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !(root === null && entry.name === "local")) await walk(full, root ?? entry.name, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(TRANSCRIPT)) {
        const stamp = await statTrail(full);
        const id = entry.name.slice(0, -TRANSCRIPT.length);
        if (stamp) trails.push({ file: full, id, root: root ?? id, stamp });
      }
    }
  };
  await walk(sessionFile.slice(0, -TRANSCRIPT.length), null, 1);
  return trails;
}
