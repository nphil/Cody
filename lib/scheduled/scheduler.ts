import type { UsageSnapshot } from "../usage/types";
import { notifyScheduledOutcome, type ScheduledOutcome } from "./notify";
import { judgeQuota, readUsageNow } from "./quota";
import { clientMessageIdFor, isHandedOver, listItems, mutateItem, transact, type StoredItem } from "./store";
import { QUOTA_GIVE_UP_MS, SCHEDULED_LIMITS, type HandedOverCheck, type ScheduledHandOver } from "./types";

/**
 * The one timer that sends scheduled messages.
 *
 * `startScheduledSender()` runs from bin/cody-server.js beside the quota watch,
 * and everything it does is reached through `runDue`, which a test drives with
 * a fake clock. The timer is armed for the NEXT thing that can happen (an
 * item's time, a retry's back-off, a quota re-check), never on a fixed
 * cadence, and it is unref'd: it cannot keep the process alive. With nothing
 * waiting there is no timer at all; a route that adds or moves an item calls
 * `wakeScheduledSender()`.
 *
 * The longest sleep is one minute. Node's timers do not count time the machine
 * spent suspended, so a long sleep after a laptop lid closes would fire hours
 * late; re-reading the wall clock every minute bounds that to a minute.
 *
 * What it promises:
 *  - A message due while the server was down is sent on boot.
 *  - One send per message: a message is claimed (pending to sending) in one
 *    synchronous store write, so a cancel and a claim cannot both win.
 *  - A failed send is retried on a back-off while it is worth it, then left as
 *    `failed` for the person; either way the owner is told (lib/notifications).
 *  - "When quota resets" waits for the reset time, then for a fresh usage read
 *    that says the model is usable, re-checking every few minutes, and gives up
 *    24 hours after the reset it waited for.
 *  - A message is only done once the chat has STARTED it. A chat that is
 *    mid-turn merely queues a follow-up (in the wrapper's memory, or omp's own
 *    queue), and an engine loss or a server restart loses that queue. So a
 *    queued message stays `sending`, remembered with the exact id it went out
 *    under, and every round asks the chat's ledger about it: started — remove
 *    and tell the owner; still queued — keep waiting (the timer stays armed);
 *    lost — back to pending as a retry, which first looks for a copy in the
 *    transcript; taken back by the person — removed, quietly.
 */

/** Between attempts at a message that could not be handed over: after the 1st, 2nd … failure. */
export const RETRY_DELAYS_MS = [15_000, 60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];
/** Attempts in all: the first, plus one per entry above. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** How often a quota message re-reads usage while the model is still spent (or unreadable). */
export const QUOTA_RECHECK_MS = 3 * 60_000;
/** A quota message with a later reset to wait for sleeps until it, but never longer than this between reads. */
export const QUOTA_MAX_SLEEP_MS = 60 * 60_000;
/** How long one delivery may take to be accepted before it is treated as not having been. */
export const SEND_TIMEOUT_MS = 90_000;
export const MIN_SLEEP_MS = 1_000;
export const MAX_SLEEP_MS = 60_000;
/** After boot: long enough for the server to start listening. */
export const BOOT_DELAY_MS = 3_000;
/** Chats delivered to at once. One chat's messages always go in order. */
export const MAX_PARALLEL_CHATS = 3;

export interface SchedulerDeps {
  now: () => number;
  /** Hand the message to its chat. Resolves once the chat has it, saying whether it started or is only queued behind a running turn (nothing: it started); rejects (with `retryable`) if not. */
  deliver: (item: StoredItem) => Promise<ScheduledHandOver | void>;
  /** Where a message the chat only queued stands now. Never starts a session. */
  checkHandedOver: (item: StoredItem) => Promise<HandedOverCheck>;
  /** A fresh usage read. */
  readUsage: () => Promise<UsageSnapshot>;
  notify: (outcome: ScheduledOutcome) => Promise<void> | void;
}

/** The real collaborators. */
export function liveSchedulerDeps(): SchedulerDeps {
  return {
    now: Date.now,
    deliver: async (item) => {
      // Dynamic on purpose: delivery imports the session manager, which imports the scheduling tools, which import this module's store — a static import here would close that loop.
      const { deliverScheduledMessage } = await import("./delivery");
      return deliverScheduledMessage(item);
    },
    // Dynamic for the same reason as above.
    checkHandedOver: async (item) => {
      const { checkHandedOver } = await import("./delivery");
      return checkHandedOver(item);
    },
    readUsage: readUsageNow,
    notify: (outcome) => notifyScheduledOutcome(outcome),
  };
}

/** The earliest moment the scheduler may look at an item. */
export function readyAt(item: StoredItem): number {
  return Math.max(item.dueAt, item.notBefore ?? 0);
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 300) || "The message could not be sent.";
}

function isFinal(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error && error.retryable === false;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The chat did not accept the message in time.")), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Firing one message
// ---------------------------------------------------------------------------

export interface FireOptions {
  /** A person pressed Send now: they are looking, so no notification, and no retry in the background — a failure is theirs to see. */
  manual?: boolean;
}

export type FireResult = "sent" | "queued" | "retry" | "failed" | "skipped";

/** Claim a pending item, once, and only if it is still the one the caller decided about. */
function claim(id: string, rev: number | null, now: number): StoredItem | null {
  let claimed = false;
  const stored = mutateItem(id, (item) => {
    if (item.status !== "pending" || (rev !== null && item.rev !== rev)) return undefined;
    claimed = true;
    const next: StoredItem = { ...item, status: "sending", firstAttemptAt: item.firstAttemptAt ?? now };
    delete next.notBefore;
    return next;
  }, now);
  return claimed ? stored : null;
}

/** Take a message out of the schedule for good. True only for the call that removed it, so whatever follows (a notice) happens once. */
function removeOnce(id: string, stillMine: (item: StoredItem) => boolean, now: number): boolean {
  let removed = false;
  mutateItem(id, (item) => {
    if (!stillMine(item)) return undefined;
    removed = true;
    return null;
  }, now);
  return removed;
}

/**
 * Send one pending message now. `rev` is the revision the caller looked at: if
 * the item was edited, moved or cancelled since, nothing is sent and the next
 * round decides again.
 *
 * A chat that only QUEUED the message behind a running reply has not
 * delivered it: the item stays `sending`, remembered with the id it went out
 * under, and `checkHandedItem` settles it once the chat says what became of it.
 */
export async function fireItem(id: string, rev: number | null, deps: SchedulerDeps, options: FireOptions = {}): Promise<FireResult> {
  const claimed = claim(id, rev, deps.now());
  if (!claimed) return "skipped";
  let handOver: ScheduledHandOver | void;
  try {
    handOver = await withTimeout(deps.deliver(claimed), SEND_TIMEOUT_MS);
  } catch (error) {
    return settleFailure(claimed, error, deps, options);
  }
  if (handOver === "queued") {
    const now = deps.now();
    mutateItem(id, (item) => (item.status === "sending"
      ? { ...item, handedAt: now, handedClientMessageId: clientMessageIdFor(item) }
      : undefined), now);
    return "queued";
  }
  mutateItem(id, () => null, deps.now());
  if (!options.manual) await deps.notify({ kind: "sent", item: claimed });
  return "sent";
}

/**
 * `freshId`: the chat's ledger still remembers the failed id's outcome, so the
 * retry goes out under the next id; the old one could only rejoin the lost send.
 */
async function settleFailure(claimed: StoredItem, error: unknown, deps: SchedulerDeps, options: FireOptions, freshId = false): Promise<FireResult> {
  const now = deps.now();
  const reason = reasonOf(error);
  const attempts = claimed.attempts + 1;
  if (!options.manual && !isFinal(error) && attempts < MAX_ATTEMPTS) {
    mutateItem(claimed.id, (item) => {
      if (item.status !== "sending") return undefined;
      const waiting: StoredItem = {
        ...item,
        status: "pending",
        attempts,
        deliveryNo: freshId ? item.deliveryNo + 1 : item.deliveryNo,
        notBefore: now + RETRY_DELAYS_MS[attempts - 1],
        error: reason,
      };
      delete waiting.handedAt;
      delete waiting.handedClientMessageId;
      return waiting;
    }, now);
    return "retry";
  }
  const stored = mutateItem(claimed.id, (item) => {
    if (item.status !== "sending") return undefined;
    const failed: StoredItem = { ...item, status: "failed", attempts, error: reason };
    delete failed.notBefore;
    delete failed.handedAt;
    delete failed.handedClientMessageId;
    return failed;
  }, now);
  if (stored && stored.status === "failed" && !options.manual) await deps.notify({ kind: "failed", item: stored, reason });
  return "failed";
}

/**
 * One round's look at a message the chat only queued. A lost one is a retry
 * attempt like any other failure: the same back-off, and the retry's own
 * transcript check keeps a copy that got through from being sent twice.
 */
async function checkHandedItem(item: StoredItem, deps: SchedulerDeps): Promise<void> {
  let check: HandedOverCheck;
  try {
    check = await deps.checkHandedOver(item);
  } catch (error) {
    // Not knowing is not losing: ask again next round rather than send a second copy.
    console.warn("[scheduled] could not check a queued scheduled message:", reasonOf(error));
    return;
  }
  const stillHanded = (current: StoredItem) => current.rev === item.rev && isHandedOver(current);
  if (check.state === "waiting") return;
  if (check.state === "lost") {
    await settleFailure(item, new Error(check.reason), deps, {}, check.freshId);
    return;
  }
  const removed = removeOnce(item.id, stillHanded, deps.now());
  if (removed && check.state === "done") await deps.notify({ kind: "sent", item });
}

// ---------------------------------------------------------------------------
// Quota mode
// ---------------------------------------------------------------------------

type QuotaDecision =
  | { action: "send" }
  | { action: "wait"; notBefore: number; dueAt?: number }
  | { action: "fail"; reason: string };

function decideQuota(item: StoredItem, snapshot: UsageSnapshot | null, now: number): QuotaDecision {
  const quota = item.quota;
  if (!quota) return { action: "send" };
  const verdict = judgeQuota(snapshot, quota.provider, quota.modelId);
  if (verdict.state === "usable") return { action: "send" };
  if (now >= quota.giveUpAt) {
    return {
      action: "fail",
      reason: verdict.state === "exhausted"
        ? "The quota had not refilled 24 hours after it was due to."
        : "Cody could not read the quota for 24 hours, so it could not tell that it had refilled.",
    };
  }
  if (verdict.state === "unreadable" || verdict.resetsAt === null || verdict.resetsAt <= now) {
    return { action: "wait", notBefore: now + QUOTA_RECHECK_MS };
  }
  // The provider names a later reset: nothing can change before it, so sleep until then (re-reading at least hourly).
  const notBefore = Math.min(Math.max(verdict.resetsAt + 1_000, now + QUOTA_RECHECK_MS), now + QUOTA_MAX_SLEEP_MS);
  const horizon = item.createdAt + SCHEDULED_LIMITS.maxDays * 24 * 60 * 60 * 1000;
  return { action: "wait", notBefore, ...(verdict.resetsAt > item.dueAt && verdict.resetsAt <= horizon ? { dueAt: verdict.resetsAt } : {}) };
}

/** Put a quota message that is still blocked back to sleep, and show the reset it now waits for. */
function deferQuotaItem(id: string, rev: number, decision: Extract<QuotaDecision, { action: "wait" }>, now: number): void {
  mutateItem(id, (item) => {
    if (item.status !== "pending" || item.rev !== rev) return undefined;
    const next: StoredItem = { ...item, notBefore: decision.notBefore };
    if (decision.dueAt !== undefined && next.quota) {
      next.dueAt = decision.dueAt;
      next.quota = { ...next.quota, giveUpAt: Math.max(next.quota.giveUpAt, decision.dueAt + QUOTA_GIVE_UP_MS) };
    }
    return next;
  }, now);
}

async function failQuotaItem(item: StoredItem, reason: string, deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const stored = mutateItem(item.id, (current) => {
    if (current.status !== "pending" || current.rev !== item.rev) return undefined;
    const failed: StoredItem = { ...current, status: "failed", error: reason };
    delete failed.notBefore;
    return failed;
  }, now);
  if (stored?.status === "failed") await deps.notify({ kind: "failed", item: stored, reason });
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

async function processItem(item: StoredItem, usage: () => Promise<UsageSnapshot | null>, deps: SchedulerDeps): Promise<void> {
  if (item.mode === "quota") {
    const now = deps.now();
    const decision = decideQuota(item, await usage(), now);
    if (decision.action === "wait") return deferQuotaItem(item.id, item.rev, decision, now);
    if (decision.action === "fail") return failQuotaItem(item, decision.reason, deps);
  }
  await fireItem(item.id, item.rev, deps);
}

/** Run `work` over `groups`, at most `limit` at a time. */
async function inParallel<T>(groups: T[][], limit: number, work: (group: T[]) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next];
      next += 1;
      await work(group);
    }
  });
  await Promise.all(lanes);
}

/**
 * Send everything that is due, and look at everything the chat only queued.
 * Messages for one chat go in the order they were due (what it already holds
 * is settled first); different chats run side by side (a few at a time). One
 * item's failure never stops the others.
 */
export async function runDue(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const items = listItems(now);
  const handed = items.filter(isHandedOver);
  const ready = items.filter((item) => item.status === "pending" && readyAt(item) <= now);
  if (handed.length === 0 && ready.length === 0) return;
  // One usage read serves every quota message this round.
  let reading: Promise<UsageSnapshot | null> | null = null;
  const usage = () => (reading ??= deps.readUsage().catch(() => null));
  const chats = new Map<string, StoredItem[]>();
  for (const item of [...handed, ...ready]) chats.set(item.sessionId, [...(chats.get(item.sessionId) ?? []), item]);
  await inParallel([...chats.values()], MAX_PARALLEL_CHATS, async (group) => {
    for (const item of group) {
      try {
        if (isHandedOver(item)) await checkHandedItem(item, deps);
        else await processItem(item, usage, deps);
      } catch (error) {
        console.warn("[scheduled] could not process a scheduled message:", reasonOf(error));
      }
    }
  });
}

/**
 * A message found `sending` at boot was interrupted: the process died with it
 * in flight — or with it only queued in a chat, whose queue died too. It goes
 * back to waiting, counted as an attempt so the retry first looks for a copy
 * the interrupted one may have left in the transcript.
 */
export function recoverInterruptedItems(now: number): number {
  return transact((items) => {
    let recovered = 0;
    const next = items.map((item) => {
      if (item.status !== "sending") return item;
      recovered += 1;
      const waiting: StoredItem = { ...item, status: "pending", attempts: item.attempts + 1, rev: item.rev + 1, updatedAt: now };
      delete waiting.notBefore;
      delete waiting.handedAt;
      delete waiting.handedClientMessageId;
      return waiting;
    });
    return recovered === 0 ? { result: 0 } : { items: next, result: recovered };
  }, now);
}

/** How often a queued message is asked about while it waits for the reply ahead of it to end. Well inside the longest sleep. */
export const HANDED_CHECK_MS = 30_000;

/** How long until something can happen, or null when nothing is waiting. */
export function nextWakeDelay(now: number): number | null {
  let soonest = Number.POSITIVE_INFINITY;
  for (const item of listItems(now)) {
    if (item.status === "pending") soonest = Math.min(soonest, readyAt(item));
    // A message queued in a chat is never forgotten: it is asked about on a short cadence until it starts, is lost, or is taken back.
    else if (isHandedOver(item)) soonest = Math.min(soonest, now + HANDED_CHECK_MS);
  }
  if (!Number.isFinite(soonest)) return null;
  return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, soonest - now));
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

interface SenderState {
  started: boolean;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | null;
  /** Something changed while a round was running: run again as soon as it ends. */
  again: boolean;
  deps: SchedulerDeps;
}

declare global {
  var __codyScheduledSender: SenderState | undefined;
}

function senderState(): SenderState {
  if (!globalThis.__codyScheduledSender) {
    globalThis.__codyScheduledSender = { started: false, timer: undefined, running: null, again: false, deps: liveSchedulerDeps() };
  }
  return globalThis.__codyScheduledSender;
}

function arm(state: SenderState, delay: number): void {
  clearTimeout(state.timer);
  const timer = setTimeout(() => {
    state.timer = undefined;
    void round(state);
  }, delay);
  timer.unref?.();
  state.timer = timer;
}

async function round(state: SenderState): Promise<void> {
  if (!state.started) return;
  if (state.running) {
    state.again = true;
    return;
  }
  const running = runDue(state.deps).catch((error: unknown) => {
    console.warn("[scheduled] a round failed:", reasonOf(error));
  });
  state.running = running;
  await running;
  state.running = null;
  if (!state.started) return;
  const delay = state.again ? 0 : nextWakeDelay(state.deps.now());
  state.again = false;
  if (delay !== null) arm(state, delay);
}

/** Begin sending. Idempotent. `deps` replaces the collaborators (a test seam). */
export function startScheduledSender(deps: Partial<SchedulerDeps> = {}): void {
  const state = senderState();
  if (state.started) return;
  state.started = true;
  state.deps = { ...liveSchedulerDeps(), ...deps };
  try {
    recoverInterruptedItems(state.deps.now());
  } catch (error) {
    console.warn("[scheduled] could not read the schedule:", reasonOf(error));
  }
  arm(state, BOOT_DELAY_MS);
}

/** Stop sending and drop the timer. Idempotent. A delivery already in flight finishes on its own. */
export function stopScheduledSender(): void {
  const state = senderState();
  clearTimeout(state.timer);
  state.timer = undefined;
  state.started = false;
  state.again = false;
}

/** Something was added, moved or sent for: look again now. A no-op until the sender is started. */
export function wakeScheduledSender(): void {
  const state = globalThis.__codyScheduledSender;
  if (!state?.started) return;
  if (state.running) {
    state.again = true;
    return;
  }
  arm(state, 0);
}
