// Side-question history as omp leaves it on disk (server-only; pure Node).
//
// omp keeps every /btw topic in a sidecar next to the session file:
//   <session .jsonl path minus ".jsonl">/btw-history/entry-<id>.json
// one topic per file. It writes a file when a turn STARTS and when it reaches a
// terminal state (never per delta), and maps an on-disk `running` to
// `interrupted` itself when it reopens the session (the writer died).
//
// This is the read path for a chat with no live engine (opening a cold chat
// must never spawn one) and the fallback when a live engine is too slow to
// answer `get_btw_history`. The files are untrusted input: a stranger could
// have dropped a symlink or a gigabyte of JSON there, so the read is bounded
// and every defect skips the one file instead of failing the request.

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BTW_ID_PATTERN, parseBtwRecord, sortBtwRecords, type BtwRecord, type BtwTurn } from "./btw";

/** Newest files read, at most. Ids are time-ordered, so the highest names win. */
export const BTW_HISTORY_MAX_FILES = 200;
/** A single topic file larger than this is skipped unread. */
export const BTW_HISTORY_MAX_FILE_BYTES = 1024 * 1024;
/** Total bytes read across one call. */
export const BTW_HISTORY_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const ENTRY_FILE = /^entry-(.+)\.json$/;
const SESSION_SUFFIX = ".jsonl";

/** The sidecar directory for a session file, or null when the path is not a `.jsonl`. */
export function btwHistoryDir(sessionFile: string): string | null {
  if (!sessionFile.endsWith(SESSION_SUFFIX) || sessionFile.length === SESSION_SUFFIX.length) return null;
  return join(sessionFile.slice(0, -SESSION_SUFFIX.length), "btw-history");
}

function interruptTurn<T extends BtwTurn>(turn: T): T {
  return turn.status === "running" ? { ...turn, status: "interrupted" } : turn;
}

/** A writer that died mid-answer left `running` behind: nothing is writing it any more. */
function interruptRunning(record: BtwRecord): BtwRecord {
  const next = interruptTurn(record);
  return record.followUps ? { ...next, followUps: record.followUps.map(interruptTurn) } : next;
}

/** Bytes of a regular file up to `limit`, or null when it is not one / too big / unreadable. */
async function readBounded(path: string, limit: number): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > limit) return null;
    // O_NOFOLLOW closes the window between the lstat and the open.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(Math.min(info.size, limit));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.toString("utf8", 0, filled);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Every topic stored beside `sessionFile`, newest first. `recoverRunning`
 * rewrites a `running` turn to `interrupted` (use it when no engine is alive
 * to finish it); false returns the files as written. Never throws: a missing
 * directory, an unreadable or malformed file is simply absent from the result.
 */
export async function readBtwHistoryFromDisk(
  sessionFile: string,
  options: { recoverRunning: boolean },
): Promise<BtwRecord[]> {
  const dir = btwHistoryDir(sessionFile);
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates: { name: string; id: string }[] = [];
  for (const name of names) {
    const id = ENTRY_FILE.exec(name)?.[1];
    if (id && BTW_ID_PATTERN.test(id)) candidates.push({ name, id });
  }
  candidates.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

  const records: BtwRecord[] = [];
  let total = 0;
  for (const { name, id } of candidates.slice(0, BTW_HISTORY_MAX_FILES)) {
    const remaining = BTW_HISTORY_MAX_TOTAL_BYTES - total;
    if (remaining <= 0) break;
    const text = await readBounded(join(dir, name), Math.min(BTW_HISTORY_MAX_FILE_BYTES, remaining));
    if (text === null) continue;
    total += Buffer.byteLength(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const record = parseBtwRecord(parsed);
    // omp itself refuses a file whose name and id disagree.
    if (!record || record.id !== id) continue;
    records.push(options.recoverRunning ? interruptRunning(record) : record);
  }
  return sortBtwRecords(records);
}
