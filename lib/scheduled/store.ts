import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { asNumber, asString, isRecord } from "../type-guards";
import { SCHEDULED_LIMITS, type ScheduledMode, type ScheduledSource, type ScheduledStatus } from "./types";

/**
 * Where scheduled messages live between now and when they are sent.
 *
 * One 0600 JSON file in the instance data dir (`cody-scheduled.json`, beside
 * the forge and distill state), replaced atomically — a crash mid-write can
 * never truncate it, and nothing on the box but Cody reads it. A message may be
 * private, so it lives with the other per-instance secrets, never under an
 * engine's own dir.
 *
 * There is no in-memory copy. Every read goes to the file and every change is a
 * synchronous read-modify-write (`transact`), so the two module instances a
 * Next.js server holds (the custom server's, which owns the timer, and the
 * routes') cannot disagree, and a cancel can never interleave with a claim:
 * whichever runs first wins and the other sees what it left.
 *
 * Nothing here grows without bound: a failed message is dropped a week after it
 * failed, and the per-chat/per-account limits cap everything else.
 */

const FILE_NAME = "cody-scheduled.json";
/** A failed message stays this long for the person to retry or dismiss. */
export const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredQuota {
  /** The usage provider id that meters the model ("anthropic"). */
  provider: string;
  modelId: string;
  /** "Claude · Secondary" — brand plus account position; never an email. */
  label: string;
  /** Epoch ms after which a still-blocked message is given up on. */
  giveUpAt: number;
}

export interface StoredItem {
  id: string;
  sessionId: string;
  /** The account whose limit this counts against: the chat's owner, else its creator; "" on an open instance. */
  accountKey: string;
  message: string;
  mode: ScheduledMode;
  /** Epoch ms: when it is due — the chosen time, or the quota reset it waits for. */
  dueAt: number;
  /** Epoch ms: the scheduler does not look at this item before then (a retry's back-off, a quota re-check). */
  notBefore?: number;
  source: ScheduledSource;
  status: ScheduledStatus;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every change, so a decision made over an await can tell the item moved under it. */
  rev: number;
  /** Which `clientMessageId` this item sends under: 0 is the first, and it moves only when the item is re-armed after a final failure or its text changed. */
  deliveryNo: number;
  /** Failed delivery attempts since the item was last armed. */
  attempts: number;
  /** Epoch ms of the first time the item was handed to the delivery path since it was last armed: a retry searches the chat's transcript from here for a copy an earlier attempt left. */
  firstAttemptAt?: number;
  /** Epoch ms the chat took the message but only queued it behind a running reply (set only while `sending`): the scheduler keeps checking the chat's ledger until it starts, is lost, or is taken back. */
  handedAt?: number;
  /** The exact `clientMessageId` that went to the chat, so the ledger is asked about the very send that was made. */
  handedClientMessageId?: string;
  error?: string;
  quota?: StoredQuota;
}

/** What a caller supplies; the store adds identity, status and bookkeeping. */
export interface NewItem {
  sessionId: string;
  accountKey: string;
  message: string;
  mode: ScheduledMode;
  dueAt: number;
  source: ScheduledSource;
  quota?: StoredQuota;
}

export function scheduledStorePath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

/** The id a send is made under: stable for the life of one delivery, so a retry joins it instead of duplicating it. */
export function clientMessageIdFor(item: Pick<StoredItem, "id" | "deliveryNo">): string {
  return item.deliveryNo === 0 ? `sched-${item.id}` : `sched-${item.id}-${item.deliveryNo}`;
}

/** The chat has this message, but only queued behind a running reply: it is still `sending` and still ours to watch. */
export function isHandedOver(item: Pick<StoredItem, "status" | "handedAt">): boolean {
  return item.status === "sending" && item.handedAt !== undefined;
}

const STATUSES: readonly ScheduledStatus[] = ["pending", "sending", "failed"];

function readQuota(value: unknown): StoredQuota | undefined {
  if (!isRecord(value)) return undefined;
  const provider = asString(value.provider);
  const modelId = asString(value.modelId);
  const label = asString(value.label);
  const giveUpAt = asNumber(value.giveUpAt);
  if (!provider || !modelId || label === undefined || giveUpAt === undefined) return undefined;
  return { provider, modelId, label, giveUpAt };
}

/** One stored entry, or null when it cannot be trusted: a hand-edited or half-written entry must never become a message sent to the wrong chat. */
function readStoredItem(value: unknown): StoredItem | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const sessionId = asString(value.sessionId);
  const message = asString(value.message);
  const dueAt = asNumber(value.dueAt);
  const createdAt = asNumber(value.createdAt);
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !sessionId || message === undefined || dueAt === undefined || createdAt === undefined) return null;
  const mode = value.mode === "quota" ? "quota" : value.mode === "at" ? "at" : null;
  const status = STATUSES.find((candidate) => candidate === value.status);
  if (!mode || !status) return null;
  const quota = readQuota(value.quota);
  if (mode === "quota" && !quota) return null;
  const item: StoredItem = {
    id,
    sessionId,
    accountKey: asString(value.accountKey) ?? "",
    message,
    mode,
    dueAt,
    source: value.source === "agent" ? "agent" : "user",
    status,
    createdAt,
    updatedAt: asNumber(value.updatedAt) ?? createdAt,
    rev: asNumber(value.rev) ?? 0,
    deliveryNo: asNumber(value.deliveryNo) ?? 0,
    attempts: asNumber(value.attempts) ?? 0,
  };
  const notBefore = asNumber(value.notBefore);
  if (notBefore !== undefined) item.notBefore = notBefore;
  const firstAttemptAt = asNumber(value.firstAttemptAt);
  if (firstAttemptAt !== undefined) item.firstAttemptAt = firstAttemptAt;
  // Only a sending item can have been handed over; a stray pair on any other status would make a settled message look like it still waits in a chat.
  const handedAt = asNumber(value.handedAt);
  const handedClientMessageId = asString(value.handedClientMessageId);
  if (status === "sending" && handedAt !== undefined && handedClientMessageId) {
    item.handedAt = handedAt;
    item.handedClientMessageId = handedClientMessageId;
  }
  const error = asString(value.error);
  if (error) item.error = error;
  if (quota) item.quota = quota;
  return item;
}

function load(): StoredItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(scheduledStorePath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return [];
  const seen = new Set<string>();
  const items: StoredItem[] = [];
  for (const entry of parsed.items) {
    const item = readStoredItem(entry);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

function save(items: StoredItem[]): void {
  const target = scheduledStorePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function withoutExpired(items: StoredItem[], now: number): StoredItem[] {
  return items.filter((item) => item.status !== "failed" || item.updatedAt + FAILED_RETENTION_MS > now);
}

/**
 * Read, change and write back, with nothing awaited in between. `change` returns
 * the new list to store (or nothing to leave the file alone) and whatever the
 * caller wants back. Expired failures are dropped on the way through.
 */
export function transact<T>(
  change: (items: StoredItem[]) => { items?: StoredItem[]; result: T },
  now: number = Date.now(),
): T {
  const stored = load();
  const live = withoutExpired(stored, now);
  const outcome = change(live);
  if (outcome.items) save(outcome.items);
  else if (live.length !== stored.length) save(live);
  return outcome.result;
}

/** Every stored item, oldest due first. */
export function listItems(now: number = Date.now()): StoredItem[] {
  return withoutExpired(load(), now).sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

export function listItemsForSession(sessionId: string, now: number = Date.now()): StoredItem[] {
  return listItems(now).filter((item) => item.sessionId === sessionId);
}

export function findItem(id: string, now: number = Date.now()): StoredItem | null {
  return withoutExpired(load(), now).find((item) => item.id === id) ?? null;
}

export type InsertResult =
  | { ok: true; item: StoredItem }
  | { ok: false; code: "too_many_for_chat" | "too_many_for_account" };

/** Add one message unless the chat or the account is already at its limit. */
export function insertItem(input: NewItem, now: number = Date.now()): InsertResult {
  return transact<InsertResult>((items) => {
    if (items.filter((item) => item.sessionId === input.sessionId).length >= SCHEDULED_LIMITS.perChat) {
      return { result: { ok: false, code: "too_many_for_chat" } };
    }
    if (items.filter((item) => item.accountKey === input.accountKey).length >= SCHEDULED_LIMITS.perAccount) {
      return { result: { ok: false, code: "too_many_for_account" } };
    }
    let id = `sch_${randomBytes(5).toString("base64url")}`;
    while (items.some((item) => item.id === id)) id = `sch_${randomBytes(5).toString("base64url")}`;
    const item: StoredItem = {
      id,
      sessionId: input.sessionId,
      accountKey: input.accountKey,
      message: input.message,
      mode: input.mode,
      dueAt: input.dueAt,
      source: input.source,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      rev: 0,
      deliveryNo: 0,
      attempts: 0,
      ...(input.quota ? { quota: input.quota } : {}),
    };
    return { items: [...items, item], result: { ok: true, item } };
  }, now);
}

/**
 * Change one item in place. `change` gets the stored item and returns the item to
 * keep (the store stamps `rev` and `updatedAt`), `null` to delete it, or
 * `undefined` to leave it alone. Resolves to what is stored afterwards, `null`
 * when the item is gone (or was never there).
 */
export function mutateItem(
  id: string,
  change: (item: StoredItem) => StoredItem | null | undefined,
  now: number = Date.now(),
): StoredItem | null {
  return transact((items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return { result: null };
    const current = items[index];
    const next = change(current);
    if (next === undefined) return { result: current };
    if (next === null) return { items: items.filter((_, position) => position !== index), result: null };
    const stamped: StoredItem = { ...next, rev: current.rev + 1, updatedAt: now };
    const updated = [...items];
    updated[index] = stamped;
    return { items: updated, result: stamped };
  }, now);
}

/** Drop every message waiting for a chat that no longer exists. */
export function removeSessionItems(sessionId: string): number {
  return transact((items) => {
    const kept = items.filter((item) => item.sessionId !== sessionId);
    return kept.length === items.length ? { result: 0 } : { items: kept, result: items.length - kept.length };
  });
}

/** A chat changed identity (an engine revealed its real id, or omp moved the session): its messages follow it. */
export function moveSessionItems(fromSessionId: string, toSessionId: string): number {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return 0;
  return transact((items) => {
    let moved = 0;
    const next = items.map((item) => {
      if (item.sessionId !== fromSessionId) return item;
      moved += 1;
      return { ...item, sessionId: toSessionId, rev: item.rev + 1 };
    });
    return moved === 0 ? { result: 0 } : { items: next, result: moved };
  });
}
