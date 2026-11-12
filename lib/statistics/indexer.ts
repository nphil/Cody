/**
 * The indexing pass: finds every transcript, reads only the bytes it has not
 * read before, and files their usage into the store.
 *
 * Pure of globals. It is handed directories and a store, so tests and the
 * acceptance script run it over a copy; `./service` is the one place that points
 * it at the live install.
 *
 * Layout it walks (omp's, shared by Cody's sidebar chats):
 *   <root>/<slug>/<ts>_<id>.jsonl                      a chat
 *   <root>/<slug>/<ts>_<id>/<name>.jsonl               its subagents (and a fork it made)
 *   <root>/<slug>/<ts>_<id>/__advisor.jsonl            its advisor
 *   <root>/<slug>/<ts>_<id>/<dir>/<name>.jsonl         nested subagents
 * A symlink is never followed: only real files and directories count, so a link
 * planted in an artifacts dir cannot pull a file from elsewhere into the totals.
 */

import fs from "node:fs";
import path from "node:path";
import { addDays, daysBetween, intToDay, makeDayOf } from "./days";
import { jobLogMonth, parseJobLogLine } from "./joblog";
import { scanChunk, type UsageRecord } from "./scan";
import { RETAIN_DAYS, StatsStore } from "./store";
import { WORKER_BACKGROUND, WORKER_BACKGROUND_PREFIX, type FileEntry, type IndexProgress, type SourceKind } from "./types";

/** Bytes read per window. A line longer than this grows the window until it fits. */
const WINDOW_BYTES = 4 * 1024 * 1024;
/** A single transcript line past this is stepped over rather than read (a pasted binary, say). */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** Artifacts directories nest subagents inside subagents; this bounds the walk. */
const MAX_NESTING = 4;
/** Files between event-loop yields while walking and statting. */
const YIELD_EVERY_FILES = 64;
const DEFAULT_CHECKPOINT_MS = 30_000;
const ADVISOR_FILE = "__advisor.jsonl";
/** Job logs older than retention plus this many days are deleted. */
const LOG_GRACE_DAYS = 62;

export interface IndexConfig {
  /** omp session roots: `<root>/<slug>/*.jsonl`. */
  sessionRoots: readonly string[];
  /** Cody sidebar chat roots, same layout. */
  sidebarRoots: readonly string[];
  /** Where the background-job logs live (the statistics dir). */
  logsDir: string;
  now: number;
  /** Minimum ms between checkpoint saves during a long pass. */
  checkpointMs?: number;
  /** Updated as the pass advances, so a request can show how far a first index is. */
  progress?: IndexProgress;
}

export interface PassResult {
  /** Transcripts found on disk. */
  files: number;
  /** Of those, how many had new bytes. */
  changed: number;
  /** Bytes read. */
  bytes: number;
  /** Usage records filed. */
  records: number;
}

interface Found {
  path: string;
  kind: SourceKind;
  slug: string;
  /** The chat file this transcript belongs to (its directory minus the nesting), or '' for a chat itself. */
  ownerPath: string;
  /** File name without `.jsonl`. */
  stem: string;
}

function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** `2026-11-06T22-43-58-672Z_01a1b308-....jsonl` -> `01a1b308-...`: the chat id its name carries. */
export function chatIdFromName(stem: string): string {
  const cut = stem.indexOf("_");
  return cut === -1 ? stem : stem.slice(cut + 1);
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkArtifacts(dir: string, depth: number, slug: string, ownerPath: string, out: Found[]): void {
  for (const entry of readDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_NESTING) walkArtifacts(full, depth + 1, slug, ownerPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push({
        path: full,
        kind: entry.name === ADVISOR_FILE ? "advisor" : "subagent",
        slug,
        ownerPath,
        stem: entry.name.slice(0, -".jsonl".length),
      });
    }
  }
}

function discoverRoot(root: string, kind: "main" | "sidebar", out: Found[]): void {
  for (const slugDir of readDir(root)) {
    // omp names every per-cwd directory with a leading dash. The sidebar root also
    // holds an engine `agent/` directory of config and blobs, which has no chats.
    if (!slugDir.isDirectory() || !slugDir.name.startsWith("-")) continue;
    const slugPath = path.join(root, slugDir.name);
    for (const entry of readDir(slugPath)) {
      const full = path.join(slugPath, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push({ path: full, kind, slug: slugDir.name, ownerPath: "", stem: entry.name.slice(0, -".jsonl".length) });
      } else if (entry.isDirectory()) {
        // An artifacts directory is named after its chat file minus `.jsonl`.
        walkArtifacts(full, 1, slugDir.name, `${full}.jsonl`, out);
      }
    }
  }
}

/** Every transcript under the roots, chats first so a subagent can find its chat's id. */
export function discoverTranscripts(config: Pick<IndexConfig, "sessionRoots" | "sidebarRoots">): Found[] {
  const found: Found[] = [];
  for (const root of config.sessionRoots) discoverRoot(root, "main", found);
  for (const root of config.sidebarRoots) discoverRoot(root, "sidebar", found);
  return found.sort((a, b) => Number(a.ownerPath !== "") - Number(b.ownerPath !== ""));
}

/**
 * Finds the end of a line too long to read: the offset just past its newline,
 * or -1 when the file ends first (the line is still being written).
 */
function skipLine(fd: number, from: number, size: number): number {
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let pos = from;
  while (pos < size) {
    const got = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (got <= 0) return -1;
    const newline = buf.subarray(0, got).indexOf(0x0a);
    if (newline !== -1) return pos + newline + 1;
    pos += got;
  }
  return -1;
}

/** Folds `file`'s bytes from its offset up to `size` into the store. Returns the bytes read. */
async function readNewBytes(store: StatsStore, file: FileEntry, size: number): Promise<{ bytes: number; records: number }> {
  let fd: number;
  try {
    fd = fs.openSync(file.path, "r");
  } catch {
    return { bytes: 0, records: 0 };
  }
  let records = 0;
  const emit = (record: UsageRecord): void => {
    store.addRecord(file, record);
    records += 1;
  };
  const started = file.offset;
  try {
    let pos = file.offset;
    let window = WINDOW_BYTES;
    let buf = Buffer.allocUnsafe(window);
    while (pos < size) {
      const want = Math.min(window, size - pos);
      if (buf.length < want) buf = Buffer.allocUnsafe(want);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      const consumed = scanChunk(buf.subarray(0, got), file, emit);
      if (consumed > 0) {
        pos += consumed;
        file.offset = pos;
        window = WINDOW_BYTES;
        store.dirty = true;
        await yieldToEventLoop();
        continue;
      }
      // No complete line in the window. Either the last line is unfinished (wait
      // for the writer), or one line is longer than the window.
      if (pos + got >= size) break;
      if (window < MAX_LINE_BYTES) {
        window = Math.min(window * 2, MAX_LINE_BYTES);
        continue;
      }
      const next = skipLine(fd, pos, size);
      if (next < 0) break;
      pos = next;
      file.offset = pos;
      store.dirty = true;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes: file.offset - started, records };
}

/** Reads the new bytes of every job log into the store. Returns the records filed. */
function ingestJobLogs(store: StatsStore, dir: string): number {
  let filed = 0;
  for (const entry of readDir(dir)) {
    if (!entry.isFile() || jobLogMonth(entry.name) === null) continue;
    const logPath = path.join(dir, entry.name);
    let size: number;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      continue;
    }
    // A log shorter than what was read was emptied or replaced, so none of its
    // current lines were counted.
    let offset = store.logs[entry.name] ?? 0;
    if (size < offset) offset = 0;
    if (size === offset) {
      store.logs[entry.name] = offset;
      continue;
    }
    let fd: number;
    try {
      fd = fs.openSync(logPath, "r");
    } catch {
      continue;
    }
    try {
      const buf = Buffer.allocUnsafe(size - offset);
      const got = fs.readSync(fd, buf, 0, buf.length, offset);
      const text = buf.toString("utf8", 0, got);
      const complete = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(0, complete).split("\n")) {
        const logged = line ? parseJobLogLine(line) : null;
        if (!logged) continue;
        const file = store.fileFor(`oneshot:${logged.chat}`, { kind: "oneshot", chat: logged.chat });
        store.addRecord(file, {
          ts: logged.ts,
          id: "",
          provider: logged.provider,
          model: logged.model,
          worker: logged.purpose ? `${WORKER_BACKGROUND_PREFIX}${logged.purpose}` : WORKER_BACKGROUND,
          usage: logged.usage,
          turn: false,
          estimate: false,
        });
        filed += 1;
      }
      store.logs[entry.name] = offset + Buffer.byteLength(text.slice(0, complete), "utf8");
      store.dirty = true;
    } finally {
      fs.closeSync(fd);
    }
  }
  return filed;
}

/** Deletes job logs whose whole month is past retention, and forgets their offsets. */
function pruneJobLogs(store: StatsStore, dir: string, today: string): void {
  for (const entry of readDir(dir)) {
    const month = entry.isFile() ? jobLogMonth(entry.name) : null;
    if (month === null || daysBetween(month, today) <= RETAIN_DAYS + LOG_GRACE_DAYS) continue;
    fs.rmSync(path.join(dir, entry.name), { force: true });
    delete store.logs[entry.name];
    store.dirty = true;
  }
}

/**
 * One pass over every transcript and job log. Reads only what is new since the
 * last pass: a transcript that grew is read from its saved offset, a smaller or
 * replaced one from the start, an untouched one not at all.
 */
export async function runIndexPass(store: StatsStore, config: IndexConfig): Promise<PassResult> {
  const checkpointMs = config.checkpointMs ?? DEFAULT_CHECKPOINT_MS;
  const found = discoverTranscripts(config);
  const result: PassResult = { files: found.length, changed: 0, bytes: 0, records: 0 };
  if (config.progress) {
    config.progress.done = 0;
    config.progress.total = found.length;
  }
  store.markGone(new Set(found.map((f) => f.path)));
  let lastSave = Date.now();
  for (const [index, item] of found.entries()) {
    if (config.progress) config.progress.done = index;
    if (index % YIELD_EVERY_FILES === YIELD_EVERY_FILES - 1) await yieldToEventLoop();
    let stat: fs.Stats;
    try {
      stat = fs.statSync(item.path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ownerChat = item.ownerPath ? (store.byPath.get(item.ownerPath)?.chat ?? chatIdFromName(path.basename(item.ownerPath, ".jsonl"))) : chatIdFromName(item.stem);
    const file = store.fileFor(item.path, { kind: item.kind, chat: ownerChat, slug: item.slug, name: item.ownerPath ? item.stem : "" });
    file.kind = item.kind;
    file.slug = item.slug;
    if (item.ownerPath) file.chat = ownerChat;
    file.gone = false;
    const replaced = file.ino !== 0 && stat.ino !== 0 && file.ino !== stat.ino;
    if (stat.size < file.offset || replaced) store.resetFile(file);
    if (stat.size === file.size && stat.mtimeMs === file.mtimeMs && !replaced) continue;
    const read = await readNewBytes(store, file, stat.size);
    file.size = stat.size;
    file.mtimeMs = stat.mtimeMs;
    file.ino = stat.ino;
    store.dirty = true;
    if (read.bytes > 0) result.changed += 1;
    result.bytes += read.bytes;
    result.records += read.records;
    if (store.dirty && Date.now() - lastSave > checkpointMs) {
      store.save();
      lastSave = Date.now();
    }
  }
  result.records += ingestJobLogs(store, config.logsDir);
  const today = intToDay(makeDayOf(store.zone)(config.now));
  pruneJobLogs(store, config.logsDir, today);
  store.prune(Number(today.replaceAll("-", "")));
  store.indexedAt = config.now;
  if (config.progress) config.progress.done = found.length;
  store.save();
  return result;
}

/** The first day retained usage can start on, for callers that explain the cut-off. */
export function retentionStart(today: string): string {
  return addDays(today, -RETAIN_DAYS);
}
