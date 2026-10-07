// Side questions (omp 18.7 `/btw`): the pure model behind the panel and its route.
//
// A side question is asked WHILE the main reply keeps going and never enters
// the transcript. omp keeps every topic in a sidecar next to the session file
// (shared with its own terminal UI) and streams two frames over the same event
// stream as the chat: `btw_delta {recordId, delta}` — text appended to the
// answer being written — and `btw_record {record}` — the whole topic, on every
// lifecycle change (started, finished, cancelled, failed).
//
// Browser-safe and engine-free: no imports beyond the shared guards, so the
// panel, the hook and the tests all read the same rules.
//
// WHY THE MERGE RULES ARE NOT "LAST WRITE WINS"
// Three sources describe the same topic and they race each other:
//   - the live frames (the freshest, in order);
//   - the answer to the `btw` command, which is written AFTER the first
//     `btw_record` frame and can reach the browser after the first deltas;
//   - a history read (page load, reconnect), which can be older than a frame
//     that arrived while it was in flight.
// A frame is authoritative (it is the engine speaking now). A command answer
// or a history read is a SNAPSHOT: it only replaces what the page has when it
// is at least as far along (`isAtLeastAsFar`), so a slow response can never
// wipe an answer that has already started streaming.

import { asNumber, asString, isRecord } from "./type-guards";

export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

/** One question and its answer. The first turn of a topic is the record's own fields. */
export interface BtwTurn {
  question: string;
  answer: string;
  status: BtwStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** A topic: its first turn's fields plus an id and the follow-up turns. */
export interface BtwRecord extends BtwTurn {
  id: string;
  /** The chat's leaf entry the question was asked at (null: before any message). */
  leafId: string | null;
  followUps?: BtwTurn[];
}

const STATUSES: Record<string, true> = { running: true, complete: true, cancelled: true, error: true, interrupted: true };

/** omp's own record-id rule: it names the file the topic lives in. */
export const BTW_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/* ───────────────────────────── the typed command ───────────────────────────── */

/** The slash command's name, with no leading slash. */
export const BTW_COMMAND_NAME = "btw";

const BTW_COMMAND = /^\/btw(?:\s+([\s\S]*))?$/i;

/**
 * `/btw <question>` as typed in the composer, or null for anything else.
 * `/btw` alone is a command with an empty question (it opens the panel);
 * `/btwx` and `/btw:` are not the command. Surrounding whitespace is ignored.
 *
 * omp's own `/btw` is a terminal-UI command: sent over the RPC `prompt` path
 * it would reach the model as literal text. So the composer must intercept it
 * on every path that turns text into a prompt, and this is the one rule for it.
 */
export function parseSideQuestionCommand(text: string): { question: string } | null {
  const match = BTW_COMMAND.exec(text.trim());
  return match ? { question: (match[1] ?? "").trim() } : null;
}

/* ───────────────────────────────── reading ───────────────────────────────── */

function parseTurn(value: unknown): BtwTurn | null {
  if (!isRecord(value)) return null;
  const question = asString(value.question);
  const answer = asString(value.answer);
  const status = asString(value.status);
  const createdAt = asNumber(value.createdAt);
  const updatedAt = asNumber(value.updatedAt);
  if (question === undefined || answer === undefined || status === undefined || STATUSES[status] !== true) return null;
  if (createdAt === undefined || updatedAt === undefined) return null;
  const error = asString(value.error);
  return { question, answer, status: status as BtwStatus, createdAt, updatedAt, ...(error ? { error } : {}) };
}

/**
 * One topic from untrusted JSON (a frame, a route answer, a sidecar file), or
 * null when it is not one. Extra fields are ignored, so a newer omp adding one
 * cannot hide its topics; a malformed topic or turn is dropped whole rather
 * than half-shown, because a missing turn would change which one is "latest".
 */
export function parseBtwRecord(value: unknown): BtwRecord | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id || !BTW_ID_PATTERN.test(id)) return null;
  const first = parseTurn(value);
  if (!first) return null;
  const leafId = value.leafId === null ? null : asString(value.leafId);
  if (leafId === undefined) return null;
  let followUps: BtwTurn[] | undefined;
  if (value.followUps !== undefined) {
    if (!Array.isArray(value.followUps)) return null;
    followUps = [];
    for (const raw of value.followUps) {
      const turn = parseTurn(raw);
      if (!turn) return null;
      followUps.push(turn);
    }
  }
  return { id, leafId, ...first, ...(followUps?.length ? { followUps } : {}) };
}

/** Every parseable topic in `value` (an array), newest first. Never throws. */
export function parseBtwRecords(value: unknown): BtwRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const records: BtwRecord[] = [];
  for (const raw of value) {
    const record = parseBtwRecord(raw);
    if (record && !seen.has(record.id)) {
      seen.add(record.id);
      records.push(record);
    }
  }
  return sortBtwRecords(records);
}

/* ───────────────────────────────── a topic ───────────────────────────────── */

/** The turn being written, or last written: the last follow-up, else the record itself. */
export function latestBtwTurn(record: BtwRecord): BtwTurn {
  return record.followUps?.at(-1) ?? record;
}

/** Every turn, oldest first. The first is the record's own fields. */
export function btwTurns(record: BtwRecord): BtwTurn[] {
  const { id: _id, leafId: _leafId, followUps, ...first } = record;
  return [first, ...(followUps ?? [])];
}

export function isBtwRunning(record: BtwRecord): boolean {
  return latestBtwTurn(record).status === "running";
}

/** True when any topic is being answered. omp runs one at a time. */
export function hasRunningBtw(records: readonly BtwRecord[]): boolean {
  return records.some(isBtwRunning);
}

/**
 * A follow-up continues a topic whose last answer finished. omp's own terminal
 * UI offers it on nothing else: after a cancelled, failed or interrupted turn
 * the thread has no answer to follow up on, so a new question starts a new topic.
 */
export function canFollowUpBtw(record: BtwRecord): boolean {
  return latestBtwTurn(record).status === "complete";
}

/** The most recent non-blank answer, whitespace untouched; undefined when there is none. */
export function btwCopyText(record: BtwRecord): string | undefined {
  const turns = btwTurns(record);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const answer = turns[index].answer;
    if (answer.trim()) return answer;
  }
  return undefined;
}

/** Newest topic first, the order omp lists them in: creation time, then id. */
export function sortBtwRecords(records: readonly BtwRecord[]): BtwRecord[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function withLatestTurn(record: BtwRecord, patch: Partial<BtwTurn>): BtwRecord {
  const followUps = record.followUps;
  if (followUps?.length) {
    return { ...record, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1], ...patch }] };
  }
  return { ...record, ...patch };
}

/* ───────────────────────────────── merging ───────────────────────────────── */

/** True when `candidate` describes the topic at least as far along as `current`. */
function isAtLeastAsFar(candidate: BtwRecord, current: BtwRecord): boolean {
  // A follow-up exists only once its question was accepted: more turns is later.
  const turnDelta = (candidate.followUps?.length ?? 0) - (current.followUps?.length ?? 0);
  if (turnDelta !== 0) return turnDelta > 0;
  const a = latestBtwTurn(candidate);
  const b = latestBtwTurn(current);
  const aRunning = a.status === "running";
  const bRunning = b.status === "running";
  // Finished beats running: a stale "still answering" read cannot undo an end,
  // and an "interrupted" read (the engine died) correctly ends a stale running one.
  if (aRunning !== bRunning) return !aRunning;
  // Both still running: the page keeps what the frames built. A snapshot is a
  // moment in time and the deltas it already contains may still be on their
  // way as frames; letting it grow the answer would append them a second time.
  // The topic's last record carries the whole answer, so nothing is lost for good.
  if (aRunning) return false;
  return a.updatedAt >= b.updatedAt;
}

function upsert(records: readonly BtwRecord[], record: BtwRecord): BtwRecord[] {
  return sortBtwRecords([...records.filter((existing) => existing.id !== record.id), record]);
}

/**
 * Fold a SNAPSHOT of topics (the `btw` command's answer, or a history read)
 * into the page's. A topic the page has not seen is added; one it has is
 * replaced only when the snapshot is at least as far along. Topics missing
 * from the snapshot are kept — it may predate them — and none is ever removed.
 */
export function mergeBtwSnapshot(records: readonly BtwRecord[], snapshot: readonly BtwRecord[]): readonly BtwRecord[] {
  let next = records;
  for (const incoming of snapshot) {
    const current = next.find((record) => record.id === incoming.id);
    if (!current || isAtLeastAsFar(incoming, current)) next = upsert(next, incoming);
  }
  return next;
}

/**
 * Apply one live frame. Anything that is not a well-formed `btw_delta` or
 * `btw_record` leaves the list as it was (same array), so a caller can compare
 * by identity to skip a render.
 *
 * - `btw_delta` appends to the topic's running turn. A delta for a topic the
 *   page has not heard of (a reconnect missed its first frame) or one that is
 *   no longer running is dropped: the topic's next `btw_record` carries the
 *   whole answer, so nothing is lost for good.
 * - `btw_record` replaces the topic outright: it is the engine's own account,
 *   and the last one for a turn carries its complete answer.
 */
export function applyBtwFrame(records: readonly BtwRecord[], frame: unknown): readonly BtwRecord[] {
  if (!isRecord(frame)) return records;
  if (frame.type === "btw_delta") {
    const recordId = asString(frame.recordId);
    const delta = asString(frame.delta);
    if (!recordId || !delta) return records;
    const index = records.findIndex((record) => record.id === recordId);
    if (index < 0) return records;
    const record = records[index];
    const latest = latestBtwTurn(record);
    if (latest.status !== "running") return records;
    const next = [...records];
    next[index] = withLatestTurn(record, { answer: latest.answer + delta });
    return next;
  }
  if (frame.type === "btw_record") {
    const record = parseBtwRecord(frame.record);
    return record ? upsert(records, record) : records;
  }
  return records;
}

/* ───────────────────────────────── errors ───────────────────────────────── */

export type BtwErrorKind =
  | "busy" | "no_model" | "cancelled_early" | "unknown_topic" | "empty"
  | "save_failed" | "unsupported" | "timeout" | "other";

/** What went wrong, as an i18n key plus the engine's own words for the keys that carry them. */
export interface BtwErrorDescription {
  kind: BtwErrorKind;
  key: string;
  /** The engine's text, for `{message}` in the keys that show it. */
  detail: string;
}

const ERROR_KEYS: Record<BtwErrorKind, string> = {
  busy: "btw.errorBusy",
  no_model: "btw.errorNoModel",
  cancelled_early: "btw.errorCancelledEarly",
  unknown_topic: "btw.errorUnknownTopic",
  empty: "btw.errorEmpty",
  save_failed: "btw.errorSaveFailed",
  unsupported: "btw.errorUnsupported",
  timeout: "btw.errorTimeout",
  other: "btw.errorOther",
};

/**
 * Plain words for a failed side question. omp answers with plain English text
 * (rpc-btw.ts), so the match is on that text; anything unrecognised keeps the
 * engine's own message under a generic heading instead of being hidden.
 */
export function describeBtwError(error: unknown): BtwErrorDescription {
  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").trim();
  const code = isRecord(error) ? asString(error.code) : undefined;
  let kind: BtwErrorKind = "other";
  if (code === "unsupported" || /Unknown command/i.test(message) || /not supported by this engine/i.test(message)) kind = "unsupported";
  else if (code === "btw_ack_timeout") kind = "timeout";
  else if (/still running; cancel it first/i.test(message)) kind = "busy";
  else if (/No active model/i.test(message)) kind = "no_model";
  else if (/cancelled before it started/i.test(message)) kind = "cancelled_early";
  else if (/Unknown \/btw topic/i.test(message)) kind = "unknown_topic";
  else if (/non-empty question/i.test(message)) kind = "empty";
  else if (/Could not save \/btw history|history could not be saved|answer .* was not saved/i.test(message)) kind = "save_failed";
  // omp words a save failure as "<what failed>: <why>"; the why is the part worth showing under our own sentence.
  const detail = kind === "save_failed" && message.includes(": ") ? message.slice(message.indexOf(": ") + 2) : message;
  return { kind, key: kind === "other" && !detail ? "btw.errorOtherNoDetail" : ERROR_KEYS[kind], detail };
}

/** The first omp release that has `/btw` (the `btw`, `btw_cancel` and `get_btw_history` commands). */
export const BTW_MIN_OMP_VERSION: readonly [number, number, number] = [18, 7, 0];

/**
 * Whether an installed omp version can answer side questions. A version that
 * is unknown or unreadable is allowed: the engine's own answer to the first
 * command decides, and guessing "no" would hide the feature on a build that has it.
 */
export function ompVersionHasBtw(version: string | null | undefined): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return true;
  for (let index = 0; index < 3; index += 1) {
    const part = Number(match[index + 1]);
    if (part !== BTW_MIN_OMP_VERSION[index]) return part > BTW_MIN_OMP_VERSION[index];
  }
  return true;
}
