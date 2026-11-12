import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readEngineCrashNotice, type EngineCrashNotice } from "./engine-crash";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

/**
 * The persistent line a crash leaves in a chat. omp's own transcript is the
 * engine's file and the engine is the thing that just died, so the notices
 * are kept beside it: one small JSON file, a few per chat, and the session
 * route (app/api/sessions/[id]) merges them into the transcript by time.
 *
 * Reads and writes never throw: a disk too full to write this is the same
 * disk the crash may have been about, and the pop-up and the push still go.
 */

const FILE_NAME = "cody-engine-crashes.json";
/** Per chat: a crash loop must not turn the transcript into a wall. */
const MAX_PER_CHAT = 5;
const MAX_CHATS = 300;
const MAX_ID_CHARS = 200;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function engineCrashLogPath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

type Store = Record<string, EngineCrashNotice[]>;

function readStore(): Store {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(engineCrashLogPath(), "utf8"));
    const chats = isRecord(parsed) && isRecord(parsed.chats) ? parsed.chats : {};
    const store: Store = {};
    for (const [id, list] of Object.entries(chats)) {
      if (!id || id.length > MAX_ID_CHARS || !Array.isArray(list)) continue;
      const notices = list.map(readEngineCrashNotice).filter((notice): notice is EngineCrashNotice => notice !== null);
      if (notices.length > 0) store[id] = notices;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const target = engineCrashLogPath();
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, chats: store })}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}

/** Remember that `sessionId`'s engine stopped. Oldest notices fall off; so do whole chats nobody has hit in a month. */
export function recordEngineCrash(sessionId: string, notice: EngineCrashNotice, now: number = Date.now()): void {
  if (!sessionId || sessionId.length > MAX_ID_CHARS) return;
  const store = readStore();
  const next: Store = {};
  for (const [id, list] of Object.entries(store)) {
    const fresh = list.filter((entry) => now - entry.at < KEEP_MS);
    if (fresh.length > 0) next[id] = fresh;
  }
  next[sessionId] = [...(next[sessionId] ?? []), notice].slice(-MAX_PER_CHAT);
  const ids = Object.keys(next);
  if (ids.length > MAX_CHATS) {
    ids.sort((a, b) => (next[b].at(-1)?.at ?? 0) - (next[a].at(-1)?.at ?? 0));
    for (const id of ids.slice(MAX_CHATS)) delete next[id];
  }
  writeStore(next);
}

/** The notices filed under `sessionId`, oldest first. */
export function readEngineCrashes(sessionId: string): EngineCrashNotice[] {
  return readStore()[sessionId] ?? [];
}

/** A chat that carries on under a new id (omp moved its session file) keeps its notices; the old id keeps its own, as its file does. */
export function copyEngineCrashes(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId || toId.length > MAX_ID_CHARS) return;
  const store = readStore();
  const copying = store[fromId];
  if (!copying) return;
  const kept = (store[toId] ?? []).filter((entry) => !copying.some((other) => other.at === entry.at));
  store[toId] = [...kept, ...copying].sort((a, b) => a.at - b.at).slice(-MAX_PER_CHAT);
  writeStore(store);
}
