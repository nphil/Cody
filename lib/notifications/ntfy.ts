import { isRecord } from "../type-guards";
import type { NtfyPriority } from "./catalog";

/**
 * A small client for the two things Cody asks of an ntfy server: publish a
 * message, and clear one by its sequence id (https://docs.ntfy.sh/publish/).
 *
 * Publishing uses ntfy's JSON form — one POST of the whole message to the
 * server's ROOT url (not the topic url) — because titles, tags and answer
 * buttons carry commas, quotes and non-ASCII text that the header form needs
 * escaping for. The JSON field names are ntfy's own: `topic`, `title`,
 * `message`, `priority` (1-5), `tags`, `click`, `actions`, `sequence_id`.
 * Markdown stays at its default, off: a chat's text is shown as written.
 *
 * Nothing here throws. A network call must never reach into session code, so a
 * failure is a value (`{ok:false, error, status?}`) the caller can log or show.
 */

export interface NtfyTarget {
  /** Base URL without a trailing slash (lib/notifications/store.ts normalizes it). */
  server: string;
  topic: string;
  /** Bearer token; empty publishes anonymously. */
  token: string;
}

/** Opens a page when tapped. */
export interface NtfyViewAction {
  action: "view";
  label: string;
  url: string;
}

/** Calls an HTTP endpoint when tapped; `clear` dismisses the notification once it answers 2xx. */
export interface NtfyHttpAction {
  action: "http";
  label: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  clear: boolean;
}

export type NtfyAction = NtfyViewAction | NtfyHttpAction;

export interface NtfyMessage {
  title: string;
  message: string;
  priority: NtfyPriority;
  tags: string[];
  /** Opened when the notification itself is tapped. */
  click?: string;
  /** ntfy shows at most three. */
  actions?: NtfyAction[];
  /** Messages sharing one replace each other, and can be cleared together. */
  sequenceId?: string;
}

export type NtfyResult = { ok: true } | { ok: false; error: string; status?: number };

export interface NtfyRequestOptions {
  /** Test seam; defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const NTFY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ERROR_LENGTH = 200;

/** The JSON object POSTed to the server root. Exported so a test can pin the wire shape. */
export function buildPublishBody(target: NtfyTarget, message: NtfyMessage): Record<string, unknown> {
  return {
    topic: target.topic,
    title: message.title,
    message: message.message,
    priority: message.priority,
    tags: message.tags,
    ...(message.click ? { click: message.click } : {}),
    ...(message.actions && message.actions.length > 0 ? { actions: message.actions } : {}),
    ...(message.sequenceId ? { sequence_id: message.sequenceId } : {}),
  };
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** At most MAX_RESPONSE_BYTES of the body: a server we do not control must not be able to stream us full. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8", 0, MAX_RESPONSE_BYTES);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The system error code (ECONNREFUSED, ENOTFOUND...) fetch hides under `cause`. */
function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : null;
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `The ntfy server did not answer within ${Math.round(timeoutMs / 1000)} seconds`;
  }
  const code = errorCode(error);
  return code ? `Could not reach the ntfy server (${code})` : "Could not reach the ntfy server";
}

/**
 * The reason a non-2xx answer gives. ntfy's own errors are JSON
 * (`{"code":40301,"http":403,"error":"forbidden",...}`) and that text is what
 * helps ("forbidden" means the topic wants a token). Anything else — an HTML
 * page, another service's JSON — is NOT echoed: the address is user-supplied,
 * and what a server on it says must not become a way to read it.
 */
function describeFailure(status: number, body: string): string {
  const error = parseJson(body)?.error;
  return typeof error === "string" && error.trim() !== "" ? error.trim().slice(0, MAX_ERROR_LENGTH) : `HTTP ${status}`;
}

async function send(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  options: NtfyRequestOptions,
  accept: (body: string) => boolean,
): Promise<NtfyResult> {
  const timeoutMs = options.timeoutMs ?? NTFY_TIMEOUT_MS;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      ...init,
      // A redirect is never followed: a POST that is redirected (http to https
      // is the usual one) comes back as a GET of the web app, which answers 200
      // and looks exactly like a message that was accepted.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readBounded(response);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      return {
        ok: false,
        status: response.status,
        error: `The server redirected the request${location ? ` to ${location.slice(0, 120)}` : ""}; use that address as the ntfy server`,
      };
    }
    if (!response.ok) return { ok: false, status: response.status, error: describeFailure(response.status, body) };
    if (!accept(body)) return { ok: false, status: response.status, error: "That address answered, but not like an ntfy server" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeFetchError(error, timeoutMs) };
  }
}

/** Publish one message. Success means ntfy answered with the message it stored (it always includes an `id`). */
export function publishNtfy(target: NtfyTarget, message: NtfyMessage, options: NtfyRequestOptions = {}): Promise<NtfyResult> {
  return send(
    `${target.server}/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(target.token) },
      body: JSON.stringify(buildPublishBody(target, message)),
    },
    options,
    (body) => typeof parseJson(body)?.id === "string",
  );
}

/** Mark the notification with this sequence id read, which also dismisses it on every device. */
export function clearNtfy(target: NtfyTarget, sequenceId: string, options: NtfyRequestOptions = {}): Promise<NtfyResult> {
  return send(
    `${target.server}/${encodeURIComponent(target.topic)}/${encodeURIComponent(sequenceId)}/clear`,
    { method: "PUT", headers: authHeaders(target.token) },
    options,
    () => true,
  );
}
