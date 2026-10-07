/**
 * Per-session send outbox: client-side delivery reliability for the composer.
 *
 * The bug this replaces: the composer cleared only after the server ack, so a
 * slow or dropped ack left a message stuck in the input with no sign it had
 * (or had not) gone anywhere. Now every send becomes an entry here BEFORE the
 * network call — the composer clears immediately, and this entry's status
 * (sending → queued|started → delivered, or failed) is the only place the
 * text lives until the server has genuinely accepted it.
 *
 * Pure state machine and storage only: no network, no React, no i18n. The
 * HTTP call and the wiring into messages and the queue rows live in
 * hooks/useAgentSession.ts; the chip UI lives in components/ChatInput.tsx.
 */

import { SESSION_STORAGE_PREFIXES } from "./storage-keys";

export type OutboxBehavior = "steer" | "followUp";
export type OutboxStatus = "sending" | "queued" | "started" | "delivered" | "failed";
export type OutboxFailureOrigin = "client" | "server";

export interface OutboxImage {
  data: string;
  mimeType: string;
  name?: string;
}

export interface OutboxEntry {
  /** Also the wire clientMessageId: the server's idempotency key. */
  id: string;
  sessionId: string;
  text: string;
  images: OutboxImage[];
  behavior: OutboxBehavior;
  status: OutboxStatus;
  /** Delivery attempts made so far (0 = never attempted yet). */
  attempt: number;
  /** Epoch ms a scheduled retry should fire, or null when none is pending. */
  nextRetryAt: number | null;
  /** Epoch ms the current retry streak began — reset by a manual Retry or a
   *  resume-after-reload, so either gives the entry a fresh give-up budget. */
  retryingSince: number;
  createdAt: number;
  /** Last retry/failure detail, for the failed chip. */
  error?: string;
  /** Client give-up is only a guess; a server-reported failure is definitive. */
  failureOrigin?: OutboxFailureOrigin;
  /** Queued and still held by Cody's server (not yet handed to the engine):
   *  the only state in which it can really be edited or deleted. */
  held?: boolean;
  /** Refused only because the chat's saved model is gone (`model_unrestorable`):
   *  not a failure and not a retry — it waits, untouched, for the person to pick
   *  a model (releaseBlocked), then goes out under the same id. */
  blocked?: boolean;
}

/** Whitespace outside a submitted message is not significant in a transcript. */
export function normalizeOutboxText(text: string): string {
  return text.trim();
}

export function createClientMessageId(): string {
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback rfc4122-ish v4 uuid for environments without crypto.randomUUID.
  let hex = "";
  for (let i = 0; i < 32; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createOutboxEntry(input: {
  sessionId: string;
  text: string;
  images?: OutboxImage[];
  behavior: OutboxBehavior;
  id?: string;
  now?: number;
}): OutboxEntry {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? createClientMessageId(),
    sessionId: input.sessionId,
    text: input.text,
    images: input.images ?? [],
    behavior: input.behavior,
    status: "sending",
    attempt: 0,
    nextRetryAt: null,
    retryingSince: now,
    createdAt: now,
  };
}

// ---- retry classification --------------------------------------------------

/** First retry delay after a failed attempt. */
const RETRY_BASE_DELAY_MS = 1_000;
/**
 * Ceiling for the doubling backoff AND the elapsed-time give-up budget (the
 * contract's "backoff up to ~2 min, then failed"): mirrors
 * `RECONNECT_MAX_DELAY_MS`/`RECONNECT_GIVE_UP_MS` in lib/stream-recovery.ts,
 * here collapsed into one constant because the two happen to coincide.
 */
export const OUTBOX_RETRY_MAX_MS = 120_000;

/** Delay before retry attempt `attempt` (1-based, the attempt that just
 *  failed): 1s, 2s, 4s, …, capped at OUTBOX_RETRY_MAX_MS. */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, OUTBOX_RETRY_MAX_MS);
}

/** True once the current retry streak (since the entry was created, or since
 *  its last manual Retry/resume) has run longer than the budget — a stream
 *  that keeps failing stops being retried automatically and becomes a failed
 *  chip with a manual Retry, rather than looping forever. */
export function shouldGiveUpRetrying(entry: OutboxEntry, now: number = Date.now()): boolean {
  return now - entry.retryingSince >= OUTBOX_RETRY_MAX_MS;
}

/** The raw shape of one delivery attempt's result — deliberately decoupled
 *  from `fetch`/`Response` so this stays unit-testable with plain objects.
 *  `status: null` means the request never got a response at all (network
 *  error, abort, timeout). */
export interface RawDeliveryResponse {
  status: number | null;
  success?: boolean;
  pending?: boolean;
  code?: string;
  error?: string;
  data?: { delivery?: "started" | "queued"; status?: "delivered"; held?: boolean };
}

export type DeliveryOutcome =
  | { kind: "success"; delivery: ServerDeliveryStatus; held?: boolean }
  | { kind: "pending" }
  | { kind: "retry"; detail?: string }
  | { kind: "blocked"; detail?: string }
  | { kind: "failed"; detail: string; origin: "server" };

/**
 * Classifies one raw HTTP outcome per the send contract (local://send-contract.md):
 * network error, 202 pending, 409 session_restarting, and 503 are retried
 * with the same clientMessageId; everything else (including an ACP engine's
 * definitive session_busy) is a failure the outbox does not retry on its own.
 */
export function classifyDeliveryOutcome(response: RawDeliveryResponse): DeliveryOutcome {
  if (response.status === null) return { kind: "retry", detail: response.error };
  if (response.status === 200 && response.success) {
    return {
      kind: "success",
      delivery: response.data?.status === "delivered" ? "delivered" : response.data?.delivery === "queued" ? "queued" : "started",
      ...(response.data?.held === true ? { held: true } : {}),
    };
  }
  if (response.status === 202 && response.pending) return { kind: "pending" };
  if (response.status === 409 && response.code === "session_restarting") return { kind: "retry", detail: response.error };
  if (response.code === "model_unrestorable") return { kind: "blocked", detail: response.error };
  if (response.status === 503) return { kind: "retry", detail: response.error };
  return { kind: "failed", detail: response.error || response.code || `HTTP ${response.status}`, origin: "server" };
}

// ---- entry-list transitions -------------------------------------------------
// Every function below is a pure `(entries) => entries` transform so the
// hook can pair it with a single React state setter and a single persist call.

/** Marks the start of one delivery attempt: bumps the attempt counter and
 *  clears any stale scheduled-retry timestamp. */
export function beginAttempt(entries: readonly OutboxEntry[], id: string): OutboxEntry[] {
  return entries.map((entry) => (entry.id === id && entry.status !== "delivered" && entry.status !== "failed"
    ? { ...entry, attempt: entry.attempt + 1, nextRetryAt: null, status: "sending" as const, blocked: undefined }
    : entry));
}

export function applyOutcome(
  entries: readonly OutboxEntry[],
  id: string,
  outcome: DeliveryOutcome,
  now: number = Date.now(),
): OutboxEntry[] {
  if (outcome.kind === "success") return applyServerDelivery(entries, id, outcome.delivery, undefined, outcome.held);
  return entries.map((entry): OutboxEntry => {
    if (entry.id !== id || entry.status === "delivered" || entry.status === "failed" || entry.status === "queued" || entry.status === "started") return entry;
    switch (outcome.kind) {
      case "pending":
        return shouldGiveUpRetrying(entry, now)
          ? { ...entry, status: "failed", failureOrigin: "client", nextRetryAt: null, error: entry.error }
          : { ...entry, nextRetryAt: now + backoffDelayMs(entry.attempt) };
      case "retry":
        return shouldGiveUpRetrying(entry, now)
          ? { ...entry, status: "failed", failureOrigin: "client", nextRetryAt: null, error: outcome.detail ?? entry.error }
          : { ...entry, nextRetryAt: now + backoffDelayMs(entry.attempt), error: outcome.detail ?? entry.error };
      case "blocked":
        return { ...entry, blocked: true, nextRetryAt: null, error: outcome.detail ?? entry.error };
      case "failed":
        return { ...entry, status: "failed", failureOrigin: outcome.origin, nextRetryAt: null, error: outcome.detail };
    }
  });
}

/** Frees every entry waiting on a model choice, with a fresh retry budget: the
 *  hours it waited are not a streak of failed attempts. Returns the ids to send. */
export function releaseBlocked(entries: readonly OutboxEntry[], now: number = Date.now()): { entries: OutboxEntry[]; ids: string[] } {
  const ids: string[] = [];
  const next = entries.map((entry): OutboxEntry => {
    if (!entry.blocked || entry.status !== "sending") return entry;
    ids.push(entry.id);
    return { ...entry, blocked: undefined, attempt: 0, nextRetryAt: null, retryingSince: now, error: undefined };
  });
  return { entries: next, ids };
}

/** The chat's saved model is gone, so every message still on its way to the
 *  engine from this page waits for a model pick instead of racing the refusal:
 *  the banner can appear before each message's own answer has come back, and the
 *  pick must find them all. Only `sending` entries; a queued or started one
 *  already reached a running engine. */
export function blockWaiting(entries: readonly OutboxEntry[]): OutboxEntry[] {
  return entries.map((entry) => (entry.status === "sending" && !entry.blocked
    ? { ...entry, blocked: true, nextRetryAt: null }
    : entry));
}

/** Which entries the ledger could not account for still need the reload-recovery
 *  (settle against the loaded transcript, or re-send). An entry this page sent
 *  and still owns — `sending` and live — is driven by its own delivery
 *  (in flight, retry timer, or waiting for a model): the transcript on screen then
 *  holds its OPTIMISTIC bubble, which is not proof the engine ever got it. Treating
 *  it as proof marks the message delivered while its request is still out, and a
 *  refused one is lost for good. */
export function idsNeedingResumeCheck(
  entries: readonly OutboxEntry[],
  unknownIds: readonly string[],
  liveIds: ReadonlySet<string>,
): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return unknownIds.filter((id) => !(liveIds.has(id) && byId.get(id)?.status === "sending"));
}

export type ServerDeliveryStatus = "queued" | "started" | "delivered" | "failed" | "withdrawn";

/** Apply a ledger transition by id. A late acknowledgement can never undo a
 *  delivery proof or move an accepted entry back to an earlier state.
 *  `withdrawn` (deleted, taken back to edit, or returned by Stop — it never
 *  reached the engine) removes the entry outright. */
export function applyServerDelivery(
  entries: readonly OutboxEntry[],
  id: string,
  status: ServerDeliveryStatus,
  error?: string,
  held?: boolean,
): OutboxEntry[] {
  if (status === "withdrawn") return entries.filter((entry) => entry.id !== id);
  const rank: Record<OutboxStatus, number> = { sending: 0, queued: 1, started: 2, delivered: 3, failed: 3 };
  return entries.map((entry): OutboxEntry => {
    if (entry.id !== id || entry.status === "delivered") return entry;
    // A held message handed to the engine stays queued, just no longer editable.
    if (status === "queued" && entry.status === "queued") return { ...entry, held: held === true };
    const clientGuess = entry.status === "failed" && entry.failureOrigin !== "server";
    if (entry.status === "failed" && !clientGuess && status !== "delivered") return entry;
    if (!clientGuess && rank[status] < rank[entry.status]) return entry;
    return {
      ...entry,
      status,
      nextRetryAt: null,
      error: status === "failed" ? (error ?? entry.error) : undefined,
      failureOrigin: status === "failed" ? "server" : undefined,
      held: status === "queued" ? held === true : undefined,
    };
  });
}

/** A manual retry appends a fresh delivery after the caller checks the old id.
 * Keep the failed entry immutable, preserve its text and images, and reset the
 * retry budget for the new id. */
export function retryEntry(entries: readonly OutboxEntry[], id: string, now: number = Date.now(), retryId: string = createClientMessageId()): OutboxEntry[] {
  const failed = entries.find((entry) => entry.id === id);
  if (!failed) return entries as OutboxEntry[];
  return [...entries, {
    ...failed,
    id: retryId,
    status: "sending",
    attempt: 0,
    nextRetryAt: null,
    retryingSince: now,
    createdAt: now,
    error: undefined,
    failureOrigin: undefined,
    held: undefined,
  }];
}

function transcriptTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function transcriptParts(message: unknown): { timestamp: number; text: string; imageCount: number } | null {
  if (!isPlainObject(message) || message.role !== "user") return null;
  const timestamp = transcriptTimestamp(message.timestamp ?? message.createdAt);
  if (timestamp === null) return null;
  const content = message.content;
  if (typeof content === "string") return { timestamp, text: normalizeOutboxText(content), imageCount: 0 };
  if (!Array.isArray(content)) return null;
  let text = "";
  let imageCount = 0;
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "image" || part.type === "image_url") imageCount += 1;
  }
  return { timestamp, text: normalizeOutboxText(text), imageCount };
}

function boundaryOccurrences(text: string, value: string): number {
  if (!value) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length - value.length) {
    const index = text.indexOf(value, from);
    if (index < 0) break;
    const end = index + value.length;
    const leftBoundary = index === 0 || text.slice(0, index).endsWith("\n\n");
    const rightBoundary = end === text.length || text.slice(end).startsWith("\n\n");
    if (leftBoundary && rightBoundary) count += 1;
    from = end;
  }
  return count;
}

/** Reconcile persisted outbox entries against loaded user messages after each
 *  entry was created. unknownIds restricts updates to IDs absent from the
 *  server ledger while still allowing known entries to explain joined messages. */
export function reconcileTranscriptDeliveries(
  entries: readonly OutboxEntry[],
  transcript: readonly unknown[],
  unknownIds?: ReadonlySet<string>,
): OutboxEntry[] {
  const ordered = entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.index - b.index)
    .map(({ entry }) => entry);
  let result = entries as OutboxEntry[];
  const resolvedIds = new Set<string>();
  const canResolve = (entry: OutboxEntry) => entry.status !== "delivered"
    && !resolvedIds.has(entry.id)
    && (!unknownIds || unknownIds.has(entry.id));
  const resolve = (id: string) => {
    result = applyServerDelivery(result, id, "delivered");
    resolvedIds.add(id);
  };

  for (const rawMessage of transcript) {
    const message = transcriptParts(rawMessage);
    if (!message) continue;
    let joinedMatch: OutboxEntry[] | null = null;
    for (let start = 0; start < ordered.length && !joinedMatch; start += 1) {
      let joinedText = "";
      let imageCount = 0;
      const group: OutboxEntry[] = [];
      for (let end = start; end < ordered.length; end += 1) {
        const entry = ordered[end];
        if (entry.createdAt > message.timestamp) break;
        joinedText = group.length ? joinedText + "\n\n" + normalizeOutboxText(entry.text) : normalizeOutboxText(entry.text);
        imageCount += entry.images.length;
        group.push(entry);
        if (joinedText === message.text && imageCount === message.imageCount && group.some(canResolve)) {
          joinedMatch = group;
          break;
        }
        if (joinedText.length > message.text.length) break;
      }
    }
    if (joinedMatch) {
      for (const entry of joinedMatch) if (canResolve(entry)) resolve(entry.id);
      continue;
    }

    if (!message.text && message.imageCount > 0) {
      const imageOnly = ordered.find((entry) => canResolve(entry)
        && entry.createdAt <= message.timestamp
        && !normalizeOutboxText(entry.text)
        && entry.images.length === message.imageCount);
      if (imageOnly) resolve(imageOnly.id);
      continue;
    }

    let matchedText = false;
    const usedOccurrences = new Map<string, number>();
    for (const entry of ordered) {
      if (!canResolve(entry) || entry.createdAt > message.timestamp) continue;
      const target = normalizeOutboxText(entry.text);
      const occurrences = boundaryOccurrences(message.text, target);
      const used = usedOccurrences.get(target) ?? 0;
      if (occurrences > used && entry.images.length === message.imageCount) {
        resolve(entry.id);
        matchedText = true;
        usedOccurrences.set(target, used + 1);
      }
    }

    // Slash commands can become expanded prompts in the saved transcript. The
    // first user message after the command is therefore the only safe fallback.
    const slash = !matchedText && ordered.find((entry) => canResolve(entry)
      && entry.createdAt <= message.timestamp
      && entry.text.trimStart().startsWith("/")
      && entry.images.length === message.imageCount);
    if (slash) resolve(slash.id);
  }
  return result;
}

/** Edit on a failed chip: hand the entry back to the caller (to repopulate
 *  the composer with its text + images) and drop it from the outbox — the
 *  next Enter creates a fresh entry/clientMessageId, exactly like any send. */
export function restoreForEdit(entries: readonly OutboxEntry[], id: string): { entry: OutboxEntry | null; entries: OutboxEntry[] } {
  const entry = entries.find((candidate) => candidate.id === id) ?? null;
  return { entry, entries: entries.filter((candidate) => candidate.id !== id) };
}

/** Prepares a persisted outbox for a fresh mount/session-switch-back: a
 *  reload can never know whether an in-flight "sending" attempt actually
 *  reached the server; the ledger lookup decides which entry needs recovery.
 * Unknown entries get a fresh give-up budget for an immediate resume attempt,
 * without trusting stale backoff clocks. Server-reported failures stay failed;
 * client-side give-ups are guesses and are re-armed. */
export function reviveForResume(entries: readonly OutboxEntry[], now: number = Date.now()): OutboxEntry[] {
  return entries
    .filter((entry) => entry.status !== "delivered")
    .map((entry) => (entry.status === "failed" && entry.failureOrigin === "server"
      ? entry
      : { ...entry, status: "sending" as const, attempt: 0, nextRetryAt: null, retryingSince: now, failureOrigin: undefined, blocked: undefined }));
}

// ---- persistence (sessionStorage; best-effort, size-bounded) ---------------

/** Generous enough for several image-laden entries (the 900 KiB single-frame
 *  budget becomes ~1.2 MB of base64) while leaving room under a typical
 *  sessionStorage quota for the other keys this app already keeps there. */
const OUTBOX_STORAGE_MAX_CHARS = 3_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutboxImage(value: unknown): value is OutboxImage {
  return isPlainObject(value)
    && typeof value.data === "string"
    && typeof value.mimeType === "string"
    && (value.name === undefined || typeof value.name === "string");
}

const OUTBOX_STATUSES: readonly OutboxStatus[] = ["sending", "queued", "started", "delivered", "failed"];

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!isPlainObject(value)) return false;
  return typeof value.id === "string"
    && typeof value.sessionId === "string"
    && typeof value.text === "string"
    && Array.isArray(value.images) && value.images.every(isOutboxImage)
    && (value.behavior === "steer" || value.behavior === "followUp")
    && typeof value.status === "string" && OUTBOX_STATUSES.includes(value.status as OutboxStatus)
    && typeof value.attempt === "number"
    && (value.nextRetryAt === null || typeof value.nextRetryAt === "number")
    && typeof value.retryingSince === "number"
    && typeof value.createdAt === "number"
    && (value.error === undefined || typeof value.error === "string")
    && (value.failureOrigin === undefined || value.failureOrigin === "client" || value.failureOrigin === "server")
    && (value.held === undefined || typeof value.held === "boolean")
    && (value.blocked === undefined || typeof value.blocked === "boolean");
}

export function serializeOutboxEntries(entries: readonly OutboxEntry[]): string {
  return JSON.stringify(entries);
}

/** Malformed or foreign JSON (a stale shape from a previous version, a
 *  quota-truncated write) degrades to an empty outbox rather than throwing —
 *  a corrupt mirror must never break the composer. */
export function deserializeOutboxEntries(raw: string): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOutboxEntry);
  } catch {
    return [];
  }
}

export function readPersistedOutbox(sessionId: string): OutboxEntry[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_PREFIXES.outbox + sessionId);
    return raw ? deserializeOutboxEntries(raw) : [];
  } catch {
    return [];
  }
}

/** Read → apply → persist in one call, so every caller that transitions a
 *  session's outbox (a fresh send, a delivery outcome, a manual Retry, a
 *  delivered resolution) does it against the current on-disk state without
 *  repeating the read/persist plumbing at each call site. Returns the
 *  resulting entries so the caller can also update live React state when
 *  this is the currently-displayed session. */
export function mutatePersistedOutbox(sessionId: string, updater: (entries: OutboxEntry[]) => OutboxEntry[]): OutboxEntry[] {
  const next = updater(readPersistedOutbox(sessionId));
  persistOutbox(sessionId, next);
  return next;
}

/** Delivered entries are transient (the chip is about to disappear) and are
 *  never persisted at all; everything else is kept, trimming images off the
 *  oldest entries first and finally dropping the oldest entries outright if
 *  the payload still will not fit the bound — mirrors persistQueue's
 *  size-bounded, best-effort strategy in hooks/useAgentSession.ts. */
export function persistOutbox(sessionId: string, entries: readonly OutboxEntry[]): void {
  try {
    if (typeof window === "undefined") return;
    const key = SESSION_STORAGE_PREFIXES.outbox + sessionId;
    const live = entries.filter((entry) => entry.status !== "delivered");
    if (live.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    let payload = live;
    let raw = serializeOutboxEntries(payload);
    let index = 0;
    while (raw.length > OUTBOX_STORAGE_MAX_CHARS && index < payload.length) {
      if (payload[index].images.length > 0) {
        payload = payload.map((entry, i) => (i === index ? { ...entry, images: [] } : entry));
        raw = serializeOutboxEntries(payload);
      }
      index += 1;
    }
    while (raw.length > OUTBOX_STORAGE_MAX_CHARS && payload.length > 1) {
      payload = payload.slice(1);
      raw = serializeOutboxEntries(payload);
    }
    if (raw.length > OUTBOX_STORAGE_MAX_CHARS) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, raw);
  } catch {
    // Best-effort only (quota exceeded, private mode, SSR).
  }
}

export function clearPersistedOutbox(sessionId: string): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(SESSION_STORAGE_PREFIXES.outbox + sessionId);
  } catch {
    // ignore storage errors
  }
}
