import { jsonError, requireCredential } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { distillCacheKey, readDistillCache, writeDistillCache } from "@/lib/distill/cache";
import { readDistillChain } from "@/lib/distill/config";
import { DISTILL_KINDS, DISTILL_VERBOSITIES, type DistillKind, type DistillVerbosity } from "@/lib/distill/prompts";
import {
  DistillQueueOverflowError,
  DistillSupersededError,
  distillEngine,
  engineAttempt,
  runDistillChain,
  withDistillSlot,
} from "@/lib/distill/runner";
import { isRecord } from "@/lib/type-guards";
import { isSessionLocalOnly } from "@/lib/local-model-routing";

/**
 * POST /api/distill — one summary, streamed.
 *
 * The answer is always `text/event-stream`, one JSON object per `data:` line,
 * and it always ends with exactly one terminal event: `done` (carrying the
 * FULL text, so the client replaces rather than appends) or `error`. Only the
 * request itself can fail with an HTTP status — an unauthenticated caller, or
 * a session that belongs to somebody else. Everything downstream of that is
 * an error EVENT, because a distill that cannot run must leave the original
 * thinking or reply exactly as it is, never replace it with an error page.
 *
 * Ownership is the sidecar rule (lib/auth/session-owners.ts) and NOT the
 * usual `resolveSessionPathOr404`: a summary is asked for while the turn is
 * still streaming, before the session file exists on disk, so requiring a
 * file would make the feature dead exactly when it is most useful. The
 * ownership check itself is unchanged — another account's session is refused
 * with the same 404 as a missing one, and a session with no owner is
 * readable, as everywhere else.
 */

export const dynamic = "force-dynamic";

/**
 * Text is clamped to 200 KB before it reaches a model (lib/distill/prompts.ts)
 * but is never REJECTED for being long, so the body limit sits well above it.
 * Past this the request is refused as an event, not as a status.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Long enough to be invisible, short enough that an idle proxy never reaps a
 * reply distill that has not started streaming yet. */
const HEARTBEAT_MS = 15_000;

type DistillErrorCode = "unsupported" | "no_model" | "failed" | "too_large";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
} as const;

/** A stream that carries one terminal event and closes. */
function singleEvent(event: Record<string, unknown>): Response {
  const body = `data: ${JSON.stringify(event)}\n\n`;
  return new Response(body, { headers: SSE_HEADERS });
}

function errorEvent(code: DistillErrorCode, message: string): Response {
  return singleEvent({ type: "error", message, code });
}

interface DistillBody {
  sessionId: string;
  entryId?: string;
  blockIndex?: number;
  kind: DistillKind;
  text: string;
  verbosity?: DistillVerbosity;
  /** Everyday language instead of developer shorthand — see
   * lib/distill-preferences.ts's `plainLanguage`. */
  plain: boolean;
  final: boolean;
}

function readBody(value: unknown): DistillBody | null {
  if (!isRecord(value)) return null;
  const { sessionId, entryId, blockIndex, kind, text, verbosity } = value;
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  if (typeof text !== "string" || !text.trim()) return null;
  if (entryId !== undefined && typeof entryId !== "string") return null;
  if (blockIndex !== undefined && (typeof blockIndex !== "number" || !Number.isInteger(blockIndex) || blockIndex < 0)) {
    return null;
  }
  const resolvedKind = typeof kind === "string" ? DISTILL_KINDS[kind] : undefined;
  if (!resolvedKind) return null;
  const resolvedVerbosity = typeof verbosity === "string" ? DISTILL_VERBOSITIES[verbosity] : undefined;
  // Verbosity is what a reply distill IS; a thinking line has one length.
  if (resolvedKind === "reply" && !resolvedVerbosity) return null;
  return {
    sessionId: sessionId.trim(),
    entryId: entryId?.trim() || undefined,
    blockIndex,
    kind: resolvedKind,
    text,
    verbosity: resolvedKind === "reply" ? resolvedVerbosity : undefined,
    plain: value.plain === true,
    final: value.final === true,
  };
}

export async function POST(request: Request) {
  // An open instance (no accounts at all) has nobody to sign in as; every
  // other credential failure is a real 401.
  const resolved = requireCredential(request);
  if ("response" in resolved && resolved.response.status !== 409) return resolved.response;
  const user = "credential" in resolved ? resolved.credential.user : null;

  let parsed: unknown;
  try {
    parsed = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorEvent("too_large", "That text is too large to summarize.");
    }
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const body = readBody(parsed);
  if (!body) return jsonError("Invalid request body", 400, "invalid_body");

  if (!canAccessSession(body.sessionId, user)) {
    return jsonError("Session not found", 404, "session_not_found");
  }

  if (isSessionLocalOnly(body.sessionId)) {
    return errorEvent("unsupported", "Distill is disabled for Local-only sessions; no cloud fallback will be used.");
  }

  const engine = distillEngine();
  if (engine.status === "unsupported") return errorEvent("unsupported", engine.reason);
  if (engine.status === "unavailable") return errorEvent("no_model", engine.reason);
  const attempt = engineAttempt(engine.bin);

  // Only a FINISHED summary of an identified entry is worth storing: a live
  // thinking block is rewritten every few hundred milliseconds.
  const cacheKey = body.final && body.entryId
    ? distillCacheKey(body.entryId, body.blockIndex, body.kind, body.verbosity, body.plain)
    : null;
  if (cacheKey) {
    const hit = readDistillCache(body.sessionId, cacheKey);
    if (hit) return singleEvent({ type: "done", text: hit.text, model: hit.model, cached: true });
  }

  // Two summaries of the same thinking block are the same request; the newer
  // one wins while the older is still queued.
  const slotKey = body.kind === "thinking"
    ? `${body.sessionId}:${body.entryId ?? "-"}:${body.blockIndex ?? "-"}`
    : null;

  const encoder = new TextEncoder();
  const abort = new AbortController();
  let release: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      const finish = (): void => {
        clearInterval(heartbeat);
        request.signal?.removeEventListener("abort", onAbort);
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const onAbort = (): void => {
        abort.abort();
        finish();
      };
      release = finish;

      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) {
        onAbort();
        return;
      }

      void (async () => {
        try {
          const result = await withDistillSlot(slotKey, () => runDistillChain({
            chain: readDistillChain(),
            kind: body.kind,
            verbosity: body.verbosity,
            text: body.text,
            plain: body.plain,
            attempt,
            signal: abort.signal,
            onDelta: (delta) => send({ type: "delta", text: delta }),
          }));
          if (!result.ok) {
            send({ type: "error", message: result.message, code: "failed" satisfies DistillErrorCode });
            return;
          }
          if (cacheKey) {
            writeDistillCache(body.sessionId, cacheKey, {
              text: result.text,
              model: result.model,
              at: Date.now(),
            });
          }
          send({ type: "done", text: result.text, model: result.model, cached: false });
        } catch (error) {
          // "superseded" and queue overflow are not failures the reader
          // should see, but every stream still has to end with exactly one
          // terminal event and the code vocabulary is fixed, so both go out
          // as `failed` carrying a distinct word the client recognizes and
          // silently absorbs, keeping whatever summary is already on
          // screen. Queue overflow additionally tells the client to forget
          // this request ever happened, so an off-screen block that was
          // evicted (never a genuine chain failure) gets a fresh attempt the
          // next time it is actually visible, instead of staying latched at
          // "Could not distill". Real chain exhaustion is the same code with
          // the model's own reason.
          const message = error instanceof DistillSupersededError
            ? "superseded"
            : error instanceof DistillQueueOverflowError
            ? "queue_overflow"
            : error instanceof Error ? error.message : String(error);
          send({ type: "error", message, code: "failed" satisfies DistillErrorCode });
        } finally {
          finish();
        }
      })();
    },
    cancel() {
      abort.abort();
      release?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
