// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { translate } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";

export interface SendAgentCommandOptions {
  /**
   * Abort the request after this long. Off by default — most commands are
   * acknowledgements, but a few (login, compaction) legitimately take minutes.
   * Callers whose command must be a fast ack pass a cap so a request that never
   * answers cannot leave the UI waiting forever.
   */
  timeoutMs?: number;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: SendAgentCommandOptions = {},
): Promise<T> {
  const controller = options.timeoutMs && options.timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    // A caller-imposed timeout must not surface as a browser's generic
    // "Failed to fetch" — the difference matters to whoever is reading it.
    if (controller?.signal.aborted) throw new Error(translate("errors.request_timed_out"));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
  };
  if (!res.ok || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    throw new Error(
      body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`,
    );
  }
  return body.data as T;
}
