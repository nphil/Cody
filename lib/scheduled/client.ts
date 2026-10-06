/**
 * Browser fetch helpers for the scheduled-message routes
 * (`/api/sessions/<id>/scheduled…`).
 *
 * Every route answers JSON and, on a refusal, `{ error, code }` with one of
 * the stable codes in `types.ts`. This module turns that into a typed
 * `ScheduledRequestError` so the composer can word each refusal in the
 * person's language instead of printing the server's English sentence.
 *
 * Browser-safe on purpose (no Node imports): the composer's hook and its tests
 * share it. Mutations are never cached and never replayed — a repeated POST
 * would schedule the message twice.
 */
import type {
  CreateScheduledBody,
  ScheduledErrorCode,
  ScheduledItemView,
  ScheduledListResponse,
  ScheduledSendNowResponse,
  UpdateScheduledBody,
} from "./types";
import { isScheduledErrorCode } from "./types";

/**
 * A scheduled-message request that did not succeed.
 *
 * `status` is the HTTP status, or 0 when the request never got an answer (the
 * network was down). `code` is the route's stable refusal code, or null when
 * the answer carried none (a proxy error page, a crash).
 */
export class ScheduledRequestError extends Error {
  readonly status: number;
  readonly code: ScheduledErrorCode | null;

  constructor(message: string, status: number, code: ScheduledErrorCode | null = null) {
    super(message);
    this.name = "ScheduledRequestError";
    this.status = status;
    this.code = code;
  }
}

function sessionBase(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/scheduled`;
}

function itemBase(sessionId: string, itemId: string): string {
  return `${sessionBase(sessionId)}/${encodeURIComponent(itemId)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  // Parsed JSON, narrowed to "an object"; every field read below is checked.
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * One request, answered with the parsed JSON object. An abort passes through
 * untouched (the caller asked for it); any other transport failure becomes a
 * status-0 `ScheduledRequestError`, so a caller only ever has one error type
 * to word.
 */
async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ScheduledRequestError(error instanceof Error ? error.message : String(error), 0);
  }
  const body = asRecord(await response.json().catch(() => null));
  if (!response.ok) {
    throw new ScheduledRequestError(
      typeof body?.error === "string" && body.error ? body.error : `HTTP ${response.status}`,
      response.status,
      isScheduledErrorCode(body?.code) ? body.code : null,
    );
  }
  if (!body) throw new ScheduledRequestError("The server answered with something that is not a JSON object.", response.status);
  return body;
}

/** The row an answer carries; a 2xx without one is a broken server, not a success. */
function itemOf(body: Record<string, unknown>): ScheduledItemView {
  if (typeof asRecord(body.item)?.id !== "string") {
    throw new ScheduledRequestError("The server did not return the scheduled message.", 200);
  }
  return body.item as ScheduledItemView;
}

/** The chat's scheduled messages, soonest first, with the limits the server enforces. */
export async function listScheduled(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<ScheduledListResponse> {
  const body = await request(sessionBase(sessionId), { method: "GET" }, options.signal);
  if (!Array.isArray(body.items) || !asRecord(body.limits)) {
    throw new ScheduledRequestError("The server did not return the scheduled messages.", 200);
  }
  return { items: body.items as ScheduledItemView[], limits: body.limits as ScheduledListResponse["limits"] };
}

/** Schedule a message. Resolves with the new row (the server answers 201). */
export async function createScheduled(sessionId: string, body: CreateScheduledBody): Promise<ScheduledItemView> {
  return itemOf(await request(sessionBase(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Change a scheduled message. A failed one becomes pending again. */
export async function updateScheduled(sessionId: string, itemId: string, body: UpdateScheduledBody): Promise<ScheduledItemView> {
  return itemOf(await request(itemBase(sessionId, itemId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Cancel a scheduled message. Refused (`already_sending`) once it is on its way. */
export async function cancelScheduled(sessionId: string, itemId: string): Promise<void> {
  await request(itemBase(sessionId, itemId), { method: "DELETE" });
}

/** Send one now (for a failed item this is the Retry). */
export async function sendScheduledNow(sessionId: string, itemId: string): Promise<ScheduledSendNowResponse> {
  const body = await request(`${itemBase(sessionId, itemId)}/send-now`, { method: "POST" });
  if (typeof body.delivered !== "boolean") {
    throw new ScheduledRequestError("The server did not say whether the message was sent.", 200);
  }
  return { ok: true, delivered: body.delivered, ...(body.item ? { item: itemOf(body) } : {}) };
}
