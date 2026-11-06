import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { readEnv } from "../env";
import { asNumber, isRecord } from "../type-guards";
import { removeTree } from "./walk";

/**
 * One scratch directory per chat: the one place everything an agent throws
 * away goes. Its engine child runs with `TMPDIR`/`TMP`/`TEMP` pointed here, so
 * `mktemp`, Python's `tempfile`, pytest's `tmp_path`, Node's `os.tmpdir()`,
 * Chromium and every build tool that honours `TMPDIR` land inside it.
 *
 * Why it exists: every session used to share the server's /tmp, so nothing
 * owned what a session left behind. One shared quota then filled up with
 * 208 GB of leftovers (2026-11-04) and the server stopped answering. With a
 * directory per chat Cody can measure it, tell the agent how big it is, and
 * delete it when the chat is deleted or has been idle for days
 * (lib/disk/janitor.ts) — and it is the only cleanup there is.
 *
 * - **Short paths.** `<root>/<12 hex>` is 20 characters under /tmp. Unix
 *   sockets made under `TMPDIR` (tmux, ssh ControlPath, Chromium) are limited
 *   to 108 bytes, so a UUID under a long prefix would break them.
 * - **The dir belongs to the chat, not to the engine process.** An engine that
 *   exits, idles out or restarts keeps its scratch: chats are resumed after
 *   restarts and reboots, and would lose a venv or build dir they still
 *   reference. It is removed only on delete (`removeSessionScratch`) or by the
 *   janitor (`removeScratchDir`).
 * - **The index remembers every id a chat has had** (`cody-scratch.json` in the
 *   instance data dir, 0600, replaced atomically). A chat starts under a
 *   temporary id and gets its real one a moment later, and omp can move a live
 *   chat to a new id, so a resume finds the same dir under any of them.
 *   Nothing stored there can name a path outside the root: an entry holds only
 *   the 12-character dir name.
 * - **Never in the way.** Every failure here answers "no scratch" or does
 *   nothing, because a chat must start whether or not a temp dir could be made.
 *
 * `CODY_SCRATCH_ROOT` moves the root. It must be a directory only Cody uses:
 * every directory directly inside it is treated as a chat's scratch, which is
 * why a root that is the system temp dir, the home dir, the data dir or a
 * filesystem root is refused outright.
 */

const INDEX_FILE_NAME = "cody-scratch.json";

/** 12 lowercase hex characters: 48 random bits, and short enough for sockets. */
const SCRATCH_DIR_NAME = /^[0-9a-f]{12}$/;

/** Ids one chat can collect (every `/new` in the same engine process adds one)
 *  before the oldest are forgotten. Far above anything real. */
const MAX_ALIASES = 64;
const MAX_NAME_ATTEMPTS = 8;
/** How long an entry outlives its dir. A tmpfs emptied by a reboot takes every
 *  dir with it while the chats stay resumable, and a resumed chat gets its old
 *  path back; an entry nobody came back for in a month is just dead weight in
 *  the index. */
const MISSING_DIR_ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ScratchEntry {
  /** Absolute path, always a direct child of `scratchRoot()`. */
  dir: string;
  /** Every id the chat has been known by; empty for a dir the index never heard of. */
  sessionIds: string[];
  createdAt: number;
  lastUsedAt: number;
}

interface StoredEntry {
  /** The dir's name under the root, never a path. */
  id: string;
  sessionIds: string[];
  createdAt: number;
  lastUsedAt: number;
}

export function scratchRoot(): string {
  const configured = readEnv("SCRATCH_ROOT")?.trim();
  return path.resolve(configured || path.join(os.tmpdir(), "cs"));
}

export function getScratchIndexPath(): string {
  return path.join(getAgentDir(), INDEX_FILE_NAME);
}

/** The root, unless it would make unrelated directories look like scratch. */
function usableRoot(): string | null {
  const root = scratchRoot();
  const unrelated = [os.tmpdir(), os.homedir(), getAgentDir(), path.parse(root).root];
  return unrelated.some((dir) => path.resolve(dir) === root) ? null : root;
}

function readIndex(): StoredEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getScratchIndexPath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
  const now = Date.now();
  const known = new Set<string>();
  const entries: StoredEntry[] = [];
  for (const raw of parsed.entries) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !SCRATCH_DIR_NAME.test(raw.id) || known.has(raw.id)) continue;
    known.add(raw.id);
    // A damaged timestamp reads as "just now": the idle clock restarts, it
    // never makes a chat's dir look old enough to delete.
    entries.push({
      id: raw.id,
      sessionIds: Array.isArray(raw.sessionIds) ? raw.sessionIds.filter((id): id is string => typeof id === "string" && id !== "") : [],
      createdAt: asNumber(raw.createdAt) ?? now,
      lastUsedAt: asNumber(raw.lastUsedAt) ?? now,
    });
  }
  return entries;
}

/** Atomic replace, 0600: a crash mid-write can never leave a half-written index. */
function writeIndex(entries: StoredEntry[]): void {
  const file = getScratchIndexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function isRealDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Create the root (0700) and check it is a directory this process owns, so a
 *  root another user planted in a shared temp dir is never trusted. */
function prepareRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = fs.statSync(root);
  if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("The scratch root is not a directory this process owns.");
  }
}

/** A new dir (0700) under a fresh random name. */
function mintDir(root: string): string {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const id = randomBytes(6).toString("hex");
    try {
      fs.mkdirSync(path.join(root, id), { mode: 0o700 });
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("No free scratch dir name was found.");
}

/** Make sure a known dir exists again (a tmpfs cleared by a reboot, a hand
 *  delete). False when something that is not a directory sits in its place. */
function restoreDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return isRealDirectory(dir);
}

/**
 * This chat's scratch dir, created on first use. Found by ANY id the chat has
 * had; the same dir comes back on every call, and after a reboot that emptied
 * the root it is made again under the same name. Returns null when it cannot
 * be created: the engine must then start without scratch, never fail.
 */
export function ensureSessionScratch(sessionId: string): string | null {
  const root = usableRoot();
  if (!sessionId || !root) return null;
  try {
    prepareRoot(root);
    const entries = readIndex();
    const now = Date.now();
    let entry = entries.find((candidate) => candidate.sessionIds.includes(sessionId));
    if (entry && !restoreDir(path.join(root, entry.id))) {
      // Something that is not a directory took its name: start over under a new one.
      entry.id = mintDir(root);
    } else if (!entry) {
      entry = { id: mintDir(root), sessionIds: [sessionId], createdAt: now, lastUsedAt: now };
      entries.push(entry);
    }
    entry.lastUsedAt = now;
    try {
      writeIndex(entries);
    } catch {
      // Out of space, most likely. The chat still gets its dir; the janitor
      // finds it as an unlisted dir and sizes it by its modification time.
    }
    return path.join(root, entry.id);
  } catch {
    return null;
  }
}

/**
 * The chat the engine process is running as is now also known as `to`: its
 * temporary id became the real one, omp moved it to a new id, or a command
 * (`/new`, fork, switch) continued it under another. The same engine keeps
 * the same TMPDIR, so both ids lead to the same dir. An id that already has a
 * dir of its own is left alone: one chat's files are never given to another.
 */
export function noteScratchAlias(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  try {
    const entries = readIndex();
    const entry = entries.find((candidate) => candidate.sessionIds.includes(fromSessionId));
    if (!entry || entries.some((candidate) => candidate.sessionIds.includes(toSessionId))) return;
    entry.sessionIds.push(toSessionId);
    if (entry.sessionIds.length > MAX_ALIASES) entry.sessionIds.splice(0, entry.sessionIds.length - MAX_ALIASES);
    writeIndex(entries);
  } catch {
    // A resume then gets a fresh dir; nothing worse.
  }
}

/** The chat did something just now, so the janitor must not call it idle. */
export function touchSessionScratch(sessionId: string): void {
  if (!sessionId) return;
  try {
    const entries = readIndex();
    const entry = entries.find((candidate) => candidate.sessionIds.includes(sessionId));
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    writeIndex(entries);
  } catch {
    // The chat is still running; a missed touch only matters after days of silence.
  }
}

/** Every scratch dir that exists: the indexed ones, then directories under the
 *  root the index never heard of (an index that was lost or could not be
 *  written), dated by their own modification time. Links and files are not
 *  scratch dirs and are never listed. Index entries whose dir has been gone
 *  for a month are forgotten here, the one place that visits them all. */
export function listSessionScratch(): ScratchEntry[] {
  const root = usableRoot();
  if (!root) return [];
  const listed: ScratchEntry[] = [];
  const entries = readIndex();
  const now = Date.now();
  const kept: StoredEntry[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.id);
    if (isRealDirectory(dir)) {
      listed.push({ dir, sessionIds: [...entry.sessionIds], createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt });
      kept.push(entry);
    } else if (now - entry.lastUsedAt < MISSING_DIR_ENTRY_TTL_MS) {
      kept.push(entry);
    }
  }
  if (kept.length !== entries.length) {
    try {
      writeIndex(kept);
    } catch {
      // Tried again at the next listing.
    }
  }
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return listed;
  }
  const indexed = new Set(entries.map((entry) => entry.id));
  for (const child of children) {
    if (!child.isDirectory() || indexed.has(child.name)) continue;
    const dir = path.join(root, child.name);
    try {
      const modified = fs.statSync(dir).mtimeMs;
      listed.push({ dir, sessionIds: [], createdAt: modified, lastUsedAt: modified });
    } catch {
      // Removed while listing.
    }
  }
  return listed;
}

/**
 * Delete one scratch dir and forget it. Refuses (false) unless `dir` is a
 * DIRECT child of the scratch root and a real directory: a path outside the
 * root, a link, or a plain file is never touched, whoever asks. The caller
 * decides whether the chat is idle: a running chat's dir is never passed here.
 * True when the dir is gone afterwards, including when it already was.
 *
 * The tree goes through lib/disk/walk.ts `removeTree`: a low-priority `rm -rf`
 * of its own (never following a link, opening up read-only trees such as Go's
 * module cache), because Node's recursive rm on a 100,000-file build dir
 * stalled every other file read and DNS lookup on the shared libuv threads.
 */
export async function removeScratchDir(dir: string): Promise<boolean> {
  const root = usableRoot();
  if (!root || typeof dir !== "string" || dir === "") return false;
  const target = path.resolve(dir);
  if (path.dirname(target) !== root) return false;
  let exists = true;
  try {
    // lstat, so a link is seen as a link and refused, not followed.
    if (!(await fs.promises.lstat(target)).isDirectory()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    exists = false;
  }
  // Forgotten first, so a chat resumed while a huge tree is being deleted is
  // given a new dir, not this one.
  try {
    const entries = readIndex();
    const kept = entries.filter((entry) => entry.id !== path.basename(target));
    if (kept.length !== entries.length) writeIndex(kept);
  } catch {
    // An index that cannot be written leaves a stale entry for a dir that is gone: harmless.
  }
  if (!exists) return true;
  try {
    await removeTree(target);
    return true;
  } catch {
    return false;
  }
}

/** The chat was deleted: remove its scratch. False when it had none or the
 *  removal failed. */
export async function removeSessionScratch(sessionId: string): Promise<boolean> {
  const root = usableRoot();
  if (!root || !sessionId) return false;
  const entry = readIndex().find((candidate) => candidate.sessionIds.includes(sessionId));
  return entry ? removeScratchDir(path.join(root, entry.id)) : false;
}

/** The variables that point an engine's temp files at `dir`. */
export function scratchEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TMP: dir, TEMP: dir, CODY_SCRATCH: dir };
}
