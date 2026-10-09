import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { asNumber, asString, isRecord } from "../type-guards";

/**
 * Which chats had a run in flight, written down so a restart can find them.
 *
 * One 0600 JSON file in the instance data dir (`cody-run-journal.json`, beside
 * the schedule and the engine index), replaced atomically: a crash mid-write
 * can never truncate it. An entry exists exactly while a chat's run is in
 * flight (agent_start to its terminal agent_end) — a run that ends, or that
 * the person stops, takes its entry with it. What is left behind, then, is
 * the list of runs that were cut off, which is the only thing boot resume
 * (supervisor.ts) ever reads.
 *
 * There is no in-memory copy. Every read goes to the file and every change is
 * one synchronous read-modify-write (`transact`), so the custom server's
 * module instance and the routes' can never disagree.
 *
 * Nothing here grows without bound: an entry nobody touched for a day is
 * dropped on every write, at most 200 are kept, and an entry remembers only
 * its latest few recoveries.
 *
 * The recoveries also outlive the run they belong to (`history`): the cap is a
 * chat's restarts in twelve hours, not one run's. Without that, a chat whose
 * recovered runs keep ending and then wedging again would start counting from
 * zero every time, and the cap would never stop it.
 */

const FILE_NAME = "cody-run-journal.json";
/** An entry nobody has touched for this long is not a run worth resuming. */
export const JOURNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const JOURNAL_MAX_ENTRIES = 200;
/** The cap on recoveries is 3 per 12 hours, so a handful is all the history it can ever read. */
const MAX_RECOVERIES_KEPT = 10;
const MAX_ID_CHARS = 512;
const MAX_REASON_CHARS = 600;

export interface RunRecovery {
  /** When Cody restarted the chat's engine (or tried to). */
  at: number;
  /** One line, in words a person would use: what was wrong. */
  reason: string;
}

export interface RunEntry {
  sessionId: string;
  /** When the first run of this entry began; a recovered run keeps it. */
  startedAt: number;
  /** The last time a frame proved the run was alive (refreshed at most once a minute). */
  updatedAt: number;
  recoveries: RunRecovery[];
}

/** The recent recoveries of a chat whose run has ended: read back when its next run begins. */
interface RecoveryHistory {
  sessionId: string;
  recoveries: RunRecovery[];
}

interface JournalState {
  runs: RunEntry[];
  history: RecoveryHistory[];
}

export function runJournalPath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

function readRecovery(value: unknown): RunRecovery | null {
  if (!isRecord(value)) return null;
  const at = asNumber(value.at);
  const reason = asString(value.reason);
  if (at === undefined || reason === undefined) return null;
  return { at, reason: reason.slice(0, MAX_REASON_CHARS) };
}

/** One stored entry, or null when it cannot be trusted: a hand-edited or half-written entry must never send a prompt to the wrong chat. */
function readEntry(value: unknown): RunEntry | null {
  if (!isRecord(value)) return null;
  const sessionId = asString(value.sessionId);
  const startedAt = asNumber(value.startedAt);
  const updatedAt = asNumber(value.updatedAt);
  if (!sessionId || sessionId.length > MAX_ID_CHARS || startedAt === undefined || updatedAt === undefined) return null;
  const recoveries = Array.isArray(value.recoveries)
    ? value.recoveries.flatMap((item) => readRecovery(item) ?? []).slice(-MAX_RECOVERIES_KEPT)
    : [];
  return { sessionId, startedAt, updatedAt, recoveries };
}

function readHistory(value: unknown): RecoveryHistory | null {
  if (!isRecord(value)) return null;
  const sessionId = asString(value.sessionId);
  if (!sessionId || sessionId.length > MAX_ID_CHARS || !Array.isArray(value.recoveries)) return null;
  const recoveries = value.recoveries.flatMap((item) => readRecovery(item) ?? []).slice(-MAX_RECOVERIES_KEPT);
  return recoveries.length > 0 ? { sessionId, recoveries } : null;
}

function load(): JournalState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(runJournalPath(), "utf8"));
  } catch {
    return { runs: [], history: [] };
  }
  if (!isRecord(parsed)) return { runs: [], history: [] };
  const seen = new Set<string>();
  const runs: RunEntry[] = [];
  for (const value of Array.isArray(parsed.runs) ? parsed.runs : []) {
    const entry = readEntry(value);
    if (entry && !seen.has(entry.sessionId)) {
      seen.add(entry.sessionId);
      runs.push(entry);
    }
  }
  const history = (Array.isArray(parsed.history) ? parsed.history : []).flatMap((value) => readHistory(value) ?? []);
  return { runs, history };
}

function save(state: JournalState): void {
  const target = runJournalPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, runs: state.runs, history: state.history }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Nothing older than a day, and the most recently alive 200 of the rest; the same for the history of ended runs. */
function pruned(state: JournalState, now: number): JournalState {
  const fresh = state.runs.filter((entry) => entry.updatedAt > now - JOURNAL_MAX_AGE_MS);
  const runs = fresh.length <= JOURNAL_MAX_ENTRIES ? fresh : [...fresh].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, JOURNAL_MAX_ENTRIES);
  const history = state.history
    .map((record) => ({ ...record, recoveries: record.recoveries.filter((recovery) => recovery.at > now - JOURNAL_MAX_AGE_MS) }))
    .filter((record) => record.recoveries.length > 0)
    .slice(-JOURNAL_MAX_ENTRIES);
  return { runs, history };
}

/**
 * Read, change and write back, with nothing awaited in between. `change`
 * returns the new state to store (or none to leave the file alone) and what
 * the caller wants back. Stale entries are dropped on the way through, and the
 * cap holds for what is written, so the entry just added counts toward it.
 */
function transact<T>(now: number, change: (state: JournalState) => { state?: JournalState; result: T }): T {
  const stored = load();
  const live = pruned(stored, now);
  const outcome = change(live);
  if (outcome.state) save(pruned(outcome.state, now));
  else if (live.runs.length !== stored.runs.length || live.history.length !== stored.history.length) save(live);
  return outcome.result;
}

/** Every entry, most recently alive first. A read never prunes: boot resume wants to SEE what is old, so it can say so. */
export function listRuns(): RunEntry[] {
  return load().runs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findRun(sessionId: string): RunEntry | null {
  return load().runs.find((entry) => entry.sessionId === sessionId) ?? null;
}

/**
 * Make the entry for `sessionId` say it was alive at `now`, creating it when
 * there is none. A recovered run's entry keeps its start and its recoveries;
 * a new run takes back the recoveries its chat's earlier runs left in the
 * history.
 */
function upsert(state: JournalState, sessionId: string, now: number): { state: JournalState; entry: RunEntry } {
  const existing = state.runs.find((entry) => entry.sessionId === sessionId);
  if (existing) {
    const entry: RunEntry = { ...existing, updatedAt: now };
    return { state: { ...state, runs: state.runs.map((item) => (item === existing ? entry : item)) }, entry };
  }
  const earlier = state.history.find((record) => record.sessionId === sessionId);
  const entry: RunEntry = { sessionId, startedAt: now, updatedAt: now, recoveries: earlier?.recoveries ?? [] };
  return {
    state: { runs: [...state.runs, entry], history: earlier ? state.history.filter((record) => record !== earlier) : state.history },
    entry,
  };
}

/** A run began in this chat (agent_start). */
export function beginRun(sessionId: string, now: number): RunEntry {
  return transact(now, (state) => {
    const next = upsert(state, sessionId, now);
    return { state: next.state, result: next.entry };
  });
}

/** A frame proved the run alive: the entry's "last activity". The caller keeps this to once a minute. */
export function touchRun(sessionId: string, now: number): void {
  beginRun(sessionId, now);
}

/**
 * The run ended, or the person stopped it, or its chat is gone: forget it. Its
 * recoveries stay behind in the history, for the cap. True when there was an
 * entry.
 */
export function endRun(sessionId: string, now: number): boolean {
  return transact(now, (state) => {
    const ending = state.runs.find((entry) => entry.sessionId === sessionId);
    if (!ending) return { result: false };
    const runs = state.runs.filter((entry) => entry !== ending);
    const history = ending.recoveries.length > 0
      ? [...state.history.filter((record) => record.sessionId !== sessionId), { sessionId, recoveries: ending.recoveries }]
      : state.history;
    return { state: { runs, history }, result: true };
  });
}

/**
 * The chat's session id changed under a run in flight (omp moved the session
 * to a new file, or the engine revealed its real id): the entry follows it, so
 * a later resume addresses the chat the person can still open.
 */
export function rekeyRun(fromId: string, toId: string, now: number): void {
  if (fromId === toId) return;
  transact(now, (state) => {
    const entries = state.runs;
    const moving = entries.find((entry) => entry.sessionId === fromId);
    if (!moving) return { result: undefined };
    const clash = entries.find((entry) => entry.sessionId === toId);
    const recoveries = [...(clash?.recoveries ?? []), ...moving.recoveries].sort((a, b) => a.at - b.at).slice(-MAX_RECOVERIES_KEPT);
    const moved: RunEntry = {
      sessionId: toId,
      startedAt: Math.min(moving.startedAt, clash?.startedAt ?? moving.startedAt),
      updatedAt: Math.max(moving.updatedAt, clash?.updatedAt ?? 0),
      recoveries,
    };
    return { state: { ...state, runs: [...entries.filter((entry) => entry !== moving && entry !== clash), moved] }, result: undefined };
  });
}

/** Cody restarted (or tried to restart) this chat's engine: remembered, because the cap on recoveries reads it. */
export function addRecovery(sessionId: string, recovery: RunRecovery, now: number): RunEntry {
  return transact(now, (state) => {
    const next = upsert(state, sessionId, now);
    const entry: RunEntry = {
      ...next.entry,
      recoveries: [...next.entry.recoveries, { at: recovery.at, reason: recovery.reason.slice(0, MAX_REASON_CHARS) }].slice(-MAX_RECOVERIES_KEPT),
    };
    return { state: { ...next.state, runs: next.state.runs.map((item) => (item === next.entry ? entry : item)) }, result: entry };
  });
}

/** The recoveries inside the window the cap counts over. */
export function recentRecoveries(entry: RunEntry | null, now: number, windowMs: number): RunRecovery[] {
  return entry ? entry.recoveries.filter((recovery) => recovery.at > now - windowMs) : [];
}
