/**
 * Scheduled messages: the vocabulary the server, the agent tools and the
 * composer all share.
 *
 * Pure and browser-safe (no Node imports): the composer needs the limits to
 * explain a refusal, and the routes need the same numbers to enforce it, so
 * they live in exactly one place. Everything that touches disk, a timer or a
 * session lives beside this file and never ships to the browser.
 */

/** The guards against a runaway. The brief's numbers; the routes, the tools and the composer all read these. */
export const SCHEDULED_LIMITS = {
  /** Messages waiting (or failed and not yet dismissed) in one chat. */
  perChat: 20,
  /** The same, across every chat one account owns. */
  perAccount: 100,
  /** How far ahead a time may be. A quota reset beyond it is refused too. */
  maxDays: 30,
  /** One message's size in UTF-8 bytes. The whole store is rewritten on every change, so it is bounded. */
  maxMessageBytes: 64 * 1024,
} as const;

/** How long a quota-mode message keeps trying after the reset it waited for. */
export const QUOTA_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export type ScheduledMode = "at" | "quota";
export type ScheduledSource = "user" | "agent";

/**
 * pending: waiting for its time (a quota item past its reset is still pending
 * while it re-checks); sending: handed to the delivery path right now — or,
 * once the chat has taken it but only queued it behind a running reply, kept
 * here (`handedOver` in the view) until the reply is over and it really
 * starts; failed: gave up — the person decides (Retry, Edit or Cancel).
 */
export type ScheduledStatus = "pending" | "sending" | "failed";

/**
 * What the chat did with a message it accepted: `delivered` — it is in the
 * conversation (started, or an engine that cannot tell queued from started);
 * `queued` — it only sits behind a reply that is still running, which an engine
 * loss or a restart would lose.
 */
export type ScheduledHandOver = "delivered" | "queued";

/**
 * Where a message that was handed over (queued) stands, read from the chat's own
 * ledger on every scheduler round. `lost` means the chat no longer has it (the
 * engine stopped, the child was replaced, the server restarted): it goes back to
 * waiting as a retry. `freshId` is for a ledger row that says `failed` on a
 * wrapper that still remembers the old id's outcome, so only a new id is sent
 * for real.
 */
export type HandedOverCheck =
  | { state: "done" }
  | { state: "waiting" }
  | { state: "withdrawn" }
  | { state: "lost"; reason: string; freshId: boolean };

/** What a quota-mode message is waiting on. Never an email address. */
export interface ScheduledQuotaView {
  /** "Claude · Secondary": the provider's name plus the account's position when it has several. */
  label: string;
  /** ISO — after this the message is given up on (24 h past the reset). */
  giveUpAt: string;
}

/** One scheduled message, as the API and the agent's tools describe it. */
export interface ScheduledItemView {
  id: string;
  sessionId: string;
  message: string;
  mode: ScheduledMode;
  /** ISO — when it is due: the time chosen, or the quota reset it waits for. */
  at: string;
  source: ScheduledSource;
  status: ScheduledStatus;
  createdAt: string;
  quota?: ScheduledQuotaView;
  /** Sending only: the chat has the message queued behind a reply that is still running. It waits there, possibly for hours. */
  handedOver?: true;
  /** Failed: why, in a sentence. Pending after a failed attempt: what the retry is for. */
  error?: string;
}

/** The model a quota-mode message is about: the chat's own, as the composer shows it. */
export interface ScheduledModelRef {
  provider: string;
  modelId: string;
}

/** POST /api/sessions/<id>/scheduled. Exactly one of `at` and `whenQuotaResets`. */
export interface CreateScheduledBody {
  message: string;
  /** An ISO 8601 instant with an offset or `Z` ("2026-10-05T23:40:00-04:00"). */
  at?: string;
  /** Send when the chat's model's quota refills. Needs a reset time Cody can see. */
  whenQuotaResets?: boolean;
  /** The chat's current model as the composer shows it; the server derives it when absent. */
  model?: ScheduledModelRef;
}

/** PATCH /api/sessions/<id>/scheduled/<itemId>. Any subset; a failed item becomes pending again. */
export interface UpdateScheduledBody {
  message?: string;
  at?: string;
  whenQuotaResets?: boolean;
  model?: ScheduledModelRef;
}

export interface ScheduledListResponse {
  items: ScheduledItemView[];
  limits: typeof SCHEDULED_LIMITS;
}

/** POST .../send-now: `delivered` true means the message is already in the chat and the item is gone. */
export interface ScheduledSendNowResponse {
  ok: true;
  delivered: boolean;
  item?: ScheduledItemView;
}

/** Stable codes an error body carries, so the composer can word each one in the person's language. */
export const SCHEDULED_ERROR_CODES = [
  "session_not_found",
  "item_not_found",
  "invalid_json",
  "invalid_body",
  "message_required",
  "message_too_long",
  "invalid_time",
  "time_in_past",
  "time_too_far",
  "choose_one_time",
  "no_model",
  "no_quota_reset",
  "too_many_for_chat",
  "too_many_for_account",
  "already_sending",
] as const;

export type ScheduledErrorCode = (typeof SCHEDULED_ERROR_CODES)[number];

export function isScheduledErrorCode(value: unknown): value is ScheduledErrorCode {
  return typeof value === "string" && (SCHEDULED_ERROR_CODES as readonly string[]).includes(value);
}

/** UTF-8 length of a message — the unit `maxMessageBytes` is in. Works in the browser and on the server. */
export function scheduledMessageBytes(message: string): number {
  return new TextEncoder().encode(message).length;
}
