// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { deviceTimeZoneField } from "@/lib/device-time-zone";
import { translate } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { isMessageCommandType } from "@/lib/time-zone";

export interface SendAgentCommandOptions {
  /**
   * Abort the request after this long. Off by default — most commands are
   * acknowledgements, but a few (login, compaction) legitimately take minutes.
   * Callers whose command must be a fast ack pass a cap so a request that never
   * answers cannot leave the UI waiting forever.
   */
  timeoutMs?: number;
}
/** Structured route failure retained for callers that need an exact engine code. */
export class AgentCommandError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "AgentCommandError";
    this.code = code;
  }
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: SendAgentCommandOptions = {},
): Promise<T> {
  const controller = options.timeoutMs && options.timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  // Only commands that carry the person's words say where they are
  // (isMessageCommandType); get_state, set_model, bash and the rest do not.
  const payload = isMessageCommandType(command.type) ? { ...command, ...deviceTimeZoneField() } : command;
  let res: Response;
  try {
    res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    throw new AgentCommandError(
      body.error || body.code ? formatApiError(body) : "HTTP " + res.status,
      body.code,
    );
  }
  return body.data as T;
}

/**
 * One delivery attempt for an existing session's composer send (outbox
 * pipeline, local://send-contract.md). Unlike `sendAgentCommand`, this never
 * throws for an expected outcome — 202 pending, 409 session_restarting, 503,
 * a network failure, or any other status all come back as plain data so
 * `lib/outbox.ts#classifyDeliveryOutcome` can decide retry vs. give up.
 * `status: null` means the request never got a response at all.
 */
export interface PromptDeliveryResponse {
  status: number | null;
  success?: boolean;
  pending?: boolean;
  code?: string;
  error?: string;
  data?: { delivery?: "started" | "queued"; clientMessageId?: string; status?: "delivered" };
}

export interface PromptDeliveryCommand {
  type: "prompt";
  message: string;
  images?: unknown;
  streamingBehavior: "steer" | "followUp";
  clientMessageId: string;
}

export async function sendPromptDelivery(
  sessionId: string,
  command: PromptDeliveryCommand,
  options: SendAgentCommandOptions = {},
): Promise<PromptDeliveryResponse> {
  const controller = options.timeoutMs && options.timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A delivery attempt is always a message, and the zone is read per
      // attempt: an outbox retry goes out from wherever the person is now.
      body: JSON.stringify({ ...command, ...deviceTimeZoneField() }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    // A timeout or a genuine network failure are both "no response" from the
    // outbox's point of view — the caller retries the identical body either
    // way, so there is no translated message to construct here.
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as Omit<PromptDeliveryResponse, "status">;
  return { status: res.status, ...body };
}

export type PromptDeliveryLedgerStatus = "queued" | "started" | "delivered" | "failed" | "withdrawn" | "unknown";

export interface PromptDeliveryLedgerItem {
  clientMessageId: string;
  status: PromptDeliveryLedgerStatus;
  text?: string;
  imageCount?: number;
  behavior?: string;
  /** Still in Cody's hold (editable), not yet in the engine's own queue. */
  held?: boolean;
  rpcId?: string;
  acceptedAt?: number;
  updatedAt?: number;
  error?: string;
}

export async function getPromptDeliveryLedger(
  sessionId: string,
  clientMessageIds: string[],
): Promise<PromptDeliveryLedgerItem[]> {
  if (clientMessageIds.length === 0) return [];
  const query = new URLSearchParams();
  for (const clientMessageId of clientMessageIds) query.append("clientMessageId", clientMessageId);
  const res = await fetch("/api/agent/" + encodeURIComponent(sessionId) + "?" + query.toString(), {
    method: "GET",
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    deliveries?: unknown;
    error?: string;
    code?: string;
  };
  if (!res.ok || !Array.isArray(body.deliveries)) {
    throw new AgentCommandError(
      body.error ? formatApiError(body) : "Could not load message delivery status",
      body.code,
    );
  }
  const validStatuses = new Set<PromptDeliveryLedgerStatus>(["queued", "started", "delivered", "failed", "withdrawn", "unknown"]);
  return body.deliveries.map((item) => {
    if (typeof item !== "object" || item === null || typeof (item as { clientMessageId?: unknown }).clientMessageId !== "string"
      || !validStatuses.has((item as { status?: PromptDeliveryLedgerStatus }).status as PromptDeliveryLedgerStatus)) {
      throw new AgentCommandError("Invalid message delivery status response");
    }
    return item as PromptDeliveryLedgerItem;
  });
}
