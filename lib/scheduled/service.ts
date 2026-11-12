import { getSessionOwner } from "../auth/session-owners";
import type { UserRecord } from "../auth/users";
import { getHarness } from "../harness";
import { isRecord } from "../type-guards";
import { ScheduledError } from "./errors";
import { planQuotaForChat, readModelRef } from "./quota";
import { fireItem, liveSchedulerDeps, wakeScheduledSender, type SchedulerDeps } from "./scheduler";
import { findItem, insertItem, isHandedOver, listItemsForSession, mutateItem, type StoredItem } from "./store";
import { parseInstant } from "./time";
import {
  QUOTA_GIVE_UP_MS,
  QUOTA_UNKNOWN_RESET_GIVE_UP_MS,
  SCHEDULED_LIMITS,
  scheduledMessageBytes,
  type ScheduledItemView,
  type ScheduledModelChoice,
  type ScheduledSource,
} from "./types";

/**
 * Making, changing, cancelling and sending scheduled messages — the one place
 * the routes, the omp host tools and the ACP bridge all go through, so a
 * message scheduled by the agent and one scheduled from the composer are the
 * same thing with the same rules.
 *
 * Nothing here decides who may act: the caller has already established that the
 * person (or the agent acting for them) may use this chat, because that is a
 * different question for a request (the account behind the cookie) and for a
 * tool call (the chat's owner). What IS enforced here is everything about the
 * message itself: its size, its time, the limits, the quota it waits for.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A clock that runs a little fast or slow must not turn "in a minute" into a refusal. */
const PAST_GRACE_MS = 60_000;

/** One English sentence per refusal: what an agent's tool result says, and what a route's `error` carries. */
const MESSAGES = {
  message_required: "Write the message to send.",
  message_too_long: `That message is too long to schedule (the limit is ${SCHEDULED_LIMITS.maxMessageBytes / 1024} KB).`,
  invalid_time: "That time could not be read. Use an ISO 8601 date and time such as 2026-10-06T09:00.",
  time_in_past: "That time is already in the past.",
  time_too_far: `Scheduled times must be within ${SCHEDULED_LIMITS.maxDays} days.`,
  choose_one_time: "Give exactly one of a time and whenQuotaResets.",
  no_model: "Cody cannot tell which model this chat uses, so it cannot follow that model's quota.",
  no_quota_reset: "Cody cannot read this model's quota right now (its provider offers no usage reading), so it cannot wait for the quota to refill.",
  invalid_model: "That model could not be read. Give its provider and its id (and, optionally, one of its reasoning levels).",
  too_many_for_chat: `This chat already has ${SCHEDULED_LIMITS.perChat} scheduled messages. Cancel one first.`,
  too_many_for_account: `This account already has ${SCHEDULED_LIMITS.perAccount} scheduled messages. Cancel some first.`,
  item_not_found: "That scheduled message does not exist.",
  already_sending: "That message is being sent right now.",
} as const;

export function viewOf(item: StoredItem): ScheduledItemView {
  return {
    id: item.id,
    sessionId: item.sessionId,
    message: item.message,
    mode: item.mode,
    at: new Date(item.dueAt).toISOString(),
    source: item.source,
    status: item.status,
    createdAt: new Date(item.createdAt).toISOString(),
    ...(item.quota ? { quota: { label: item.quota.label, giveUpAt: new Date(item.quota.giveUpAt).toISOString(), ...(item.quota.unknownReset ? { unknownReset: true as const } : {}) } } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(isHandedOver(item) ? { handedOver: true as const } : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

export function listScheduled(sessionId: string): ScheduledItemView[] {
  return listItemsForSession(sessionId).map(viewOf);
}

/** What is asked for. Exactly one of `at` and `whenQuotaResets`. */
export interface ScheduleWhen {
  at?: unknown;
  whenQuotaResets?: unknown;
  /** The model (and reasoning level) the message is sent on — `{ provider, modelId, thinkingLevel? }`. A quota wait follows it. Absent: whatever the chat is on. */
  model?: unknown;
  /** The chat's own model as the composer shows it, for a quota wait when no `model` was chosen; absent for an agent, which is asked of the chat itself. */
  chatModel?: unknown;
}

/** Where a time with no offset is read, and whether one is allowed at all. */
export interface TimeReading {
  zone: string;
  /** The HTTP API only accepts an instant; a tool also accepts "2026-10-06T09:00". */
  requireOffset?: boolean;
}

/** Who is scheduling, for the account limit and for "by the agent". */
export interface ScheduleActor {
  source: ScheduledSource;
  user: UserRecord | null;
}

export interface ServiceDeps {
  now: () => number;
  engineId: () => string;
  planQuota: typeof planQuotaForChat;
}

const DEFAULT_DEPS: ServiceDeps = { now: Date.now, engineId: () => getHarness().id, planQuota: planQuotaForChat };

function checkMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ScheduledError("message_required", MESSAGES.message_required);
  if (scheduledMessageBytes(value) > SCHEDULED_LIMITS.maxMessageBytes) throw new ScheduledError("message_too_long", MESSAGES.message_too_long);
  return value;
}

/** A time the person or agent named, as epoch ms inside the allowed window. */
function checkTime(value: unknown, reading: TimeReading, now: number): number {
  if (typeof value !== "string") throw new ScheduledError("invalid_time", MESSAGES.invalid_time);
  const parsed = parseInstant(value, reading.zone);
  if (!parsed.ok || (reading.requireOffset && !parsed.hadOffset)) throw new ScheduledError("invalid_time", MESSAGES.invalid_time);
  if (parsed.at < now - PAST_GRACE_MS) throw new ScheduledError("time_in_past", MESSAGES.time_in_past);
  if (parsed.at > now + SCHEDULED_LIMITS.maxDays * DAY_MS) throw new ScheduledError("time_too_far", MESSAGES.time_too_far);
  return Math.max(parsed.at, now);
}

/**
 * The model (and reasoning level) chosen for a message; null when none was. A
 * malformed choice is refused here, not discovered when the message is due.
 */
function readModelChoice(value: unknown): ScheduledModelChoice | null {
  if (value === undefined || value === null) return null;
  const ref = readModelRef(value);
  if (!ref) throw new ScheduledError("invalid_model", MESSAGES.invalid_model);
  const level = isRecord(value) ? value.thinkingLevel : undefined;
  if (level === undefined || level === null || level === "") return ref;
  if (typeof level !== "string" || level.trim() === "") throw new ScheduledError("invalid_model", MESSAGES.invalid_model);
  return { ...ref, thinkingLevel: level.trim() };
}

/**
 * A time, or "when the quota resets", resolved to the fields the store needs.
 * The quota that counts is the one of the model the message is SENT on: the
 * `chosen` one, else the chat's own.
 */
async function resolveWhen(
  sessionId: string,
  when: ScheduleWhen,
  chosen: ScheduledModelChoice | null,
  reading: TimeReading,
  deps: ServiceDeps,
): Promise<Pick<StoredItem, "mode" | "dueAt" | "quota">> {
  const now = deps.now();
  const quota = when.whenQuotaResets === true;
  const timed = when.at !== undefined && when.at !== null && when.at !== "";
  if (quota === timed) throw new ScheduledError("choose_one_time", MESSAGES.choose_one_time);
  if (!quota) return { mode: "at", dueAt: checkTime(when.at, reading, now) };

  const model = chosen ? { provider: chosen.provider, modelId: chosen.modelId } : readModelRef(when.chatModel);
  const plan = await deps.planQuota(sessionId, deps.engineId(), model, now);
  if (!plan.ok) throw new ScheduledError(plan.code, MESSAGES[plan.code]);
  const { target } = plan;
  if (target.resetsAt === null) {
    // No reset to count down to (a person with every quota spent is exactly who waits on such a model): it waits for a read that says the model is usable, re-checking every few minutes, and a week at most.
    return {
      mode: "quota",
      dueAt: now,
      quota: { provider: target.provider, modelId: target.modelId, label: target.label, giveUpAt: now + QUOTA_UNKNOWN_RESET_GIVE_UP_MS, unknownReset: true },
    };
  }
  if (target.resetsAt > now + SCHEDULED_LIMITS.maxDays * DAY_MS) throw new ScheduledError("time_too_far", MESSAGES.time_too_far);
  return {
    mode: "quota",
    dueAt: target.resetsAt,
    quota: { provider: target.provider, modelId: target.modelId, label: target.label, giveUpAt: target.resetsAt + QUOTA_GIVE_UP_MS },
  };
}

/** The limit a message counts against: its chat's owner, else whoever scheduled it, else (an open instance) everyone. */
function accountKeyFor(sessionId: string, user: UserRecord | null): string {
  return getSessionOwner(sessionId) ?? user?.id ?? "";
}

export async function createScheduled(
  sessionId: string,
  input: ScheduleWhen & { message: unknown },
  reading: TimeReading,
  by: ScheduleActor,
  deps: ServiceDeps = DEFAULT_DEPS,
): Promise<ScheduledItemView> {
  const message = checkMessage(input.message);
  const chosen = readModelChoice(input.model);
  const when = await resolveWhen(sessionId, input, chosen, reading, deps);
  const inserted = insertItem({ sessionId, accountKey: accountKeyFor(sessionId, by.user), message, source: by.source, ...when, ...(chosen ? { model: chosen } : {}) }, deps.now());
  if (!inserted.ok) throw new ScheduledError(inserted.code, MESSAGES[inserted.code], 409);
  wakeScheduledSender();
  return viewOf(inserted.item);
}

/** The item `itemId`, provided it belongs to `sessionId` (another chat's id answers exactly like a missing one). */
function ownItem(sessionId: string, itemId: string): StoredItem {
  const item = findItem(itemId);
  if (!item || item.sessionId !== sessionId) throw new ScheduledError("item_not_found", MESSAGES.item_not_found, 404);
  return item;
}

/**
 * Change a message's text, time and/or model. A message that failed becomes
 * pending again (it is being given another chance on purpose). A new text, like
 * a second chance, gets a new delivery identity: the old one may have reached
 * the chat, or been refused for good. A new model re-plans a quota wait, which
 * follows the model the message is sent on.
 */
export async function updateScheduled(
  sessionId: string,
  itemId: string,
  change: ScheduleWhen & { message?: unknown },
  reading: TimeReading,
  deps: ServiceDeps = DEFAULT_DEPS,
): Promise<ScheduledItemView> {
  const existing = ownItem(sessionId, itemId);
  if (existing.status === "sending") throw new ScheduledError("already_sending", MESSAGES.already_sending, 409);
  const message = change.message === undefined ? undefined : checkMessage(change.message);
  // undefined: the model stays; null: the choice is taken away; otherwise the new one.
  const modelChange = change.model === undefined ? undefined : readModelChoice(change.model);
  const chosen = modelChange === undefined ? existing.model ?? null : modelChange;
  const retimed = change.at !== undefined || change.whenQuotaResets !== undefined;
  let when: Pick<StoredItem, "mode" | "dueAt" | "quota"> | null = null;
  if (retimed) when = await resolveWhen(sessionId, change, chosen, reading, deps);
  else if (modelChange !== undefined && existing.mode === "quota") when = await resolveWhen(sessionId, { whenQuotaResets: true, chatModel: change.chatModel }, chosen, reading, deps);

  let sending = false;
  const updated = mutateItem(itemId, (item) => {
    if (item.status === "sending") {
      sending = true;
      return undefined;
    }
    const textChanged = message !== undefined && message !== item.message;
    const next: StoredItem = {
      ...item,
      ...(when ?? {}),
      ...(textChanged ? { message } : {}),
      status: "pending",
      attempts: 0,
      deliveryNo: textChanged || item.status === "failed" ? item.deliveryNo + 1 : item.deliveryNo,
    };
    if (when && !when.quota) delete next.quota;
    if (modelChange === null) delete next.model;
    else if (modelChange) next.model = modelChange;
    delete next.notBefore;
    delete next.firstAttemptAt;
    delete next.error;
    return next;
  }, deps.now());
  if (sending) throw new ScheduledError("already_sending", MESSAGES.already_sending, 409);
  if (!updated) throw new ScheduledError("item_not_found", MESSAGES.item_not_found, 404);
  wakeScheduledSender();
  return viewOf(updated);
}

/** Cancel one message. One already being handed to its chat cannot be taken back from here. */
export function cancelScheduled(sessionId: string, itemId: string): ScheduledItemView {
  const current = ownItem(sessionId, itemId);
  const result: { outcome: "removed" | "sending" | "gone" } = { outcome: "gone" };
  mutateItem(itemId, (item) => {
    if (item.status === "sending") {
      result.outcome = "sending";
      return undefined;
    }
    result.outcome = "removed";
    return null;
  });
  if (result.outcome === "sending") throw new ScheduledError("already_sending", MESSAGES.already_sending, 409);
  if (result.outcome === "gone") throw new ScheduledError("item_not_found", MESSAGES.item_not_found, 404);
  return viewOf(current);
}

/**
 * Send a message now, whatever time it was waiting for, and say how it went. A
 * failed message is re-armed first, under a fresh delivery identity. One
 * attempt and no background retries: whoever pressed the button is looking.
 */
export async function sendScheduledNow(
  sessionId: string,
  itemId: string,
  deps: SchedulerDeps = liveSchedulerDeps(),
): Promise<{ delivered: boolean; item?: ScheduledItemView }> {
  if (ownItem(sessionId, itemId).status === "sending") throw new ScheduledError("already_sending", MESSAGES.already_sending, 409);
  let sending = false;
  const armed = mutateItem(itemId, (item) => {
    if (item.status === "sending") {
      sending = true;
      return undefined;
    }
    const next: StoredItem = { ...item, status: "pending", attempts: 0, deliveryNo: item.status === "failed" ? item.deliveryNo + 1 : item.deliveryNo };
    delete next.notBefore;
    delete next.firstAttemptAt;
    delete next.error;
    return next;
  }, deps.now());
  if (sending) throw new ScheduledError("already_sending", MESSAGES.already_sending, 409);
  if (!armed) throw new ScheduledError("item_not_found", MESSAGES.item_not_found, 404);

  await fireItem(itemId, armed.rev, deps, { manual: true });
  const after = findItem(itemId);
  // A chat that only queued it behind a running reply, or that must finish its reply before it can be switched to the message's model, is watched by the timer, which may be asleep with nothing else to do.
  if (after && (isHandedOver(after) || after.status === "pending")) wakeScheduledSender();
  return after ? { delivered: false, item: viewOf(after) } : { delivered: true };
}
