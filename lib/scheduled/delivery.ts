import { createCheckpoint } from "../checkpoints";
import { EngineCommandError } from "../harness/errors";
import { getRpcSession, unrestorableModelOf, WebRpcError } from "../rpc-manager";
import { acquireSession, isSessionUnavailableError } from "../session-acquire";
import { getSessionEntries, resolveSessionPath } from "../session-reader";
import { ownerTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import { ScheduledDeliveryError } from "./errors";
import { clientMessageIdFor, type StoredItem } from "./store";
import type { HandedOverCheck, ScheduledHandOver } from "./types";

/**
 * Handing one scheduled message to its chat — the same path the composer's own
 * send takes (`POST /api/agent/[id]`), minus the request.
 *
 * The chat may have no live child (it idled out hours ago, or the server just
 * restarted): `acquireSession` starts one exactly as the route would, in the
 * owner's zone, because nobody is typing. The message goes in as a `prompt`
 * with `streamingBehavior: "followUp"`, so a chat that is mid-turn holds it in
 * its queue until the turn ends instead of colliding with it. It carries a
 * `clientMessageId` that is stable for the life of one delivery, so the
 * wrapper's ledger turns a retry into a rejoin, never a second send.
 *
 * Ownership is not re-checked here: it was checked when the message was
 * scheduled, by the route or tool that did it, and a chat's owner does not
 * change.
 */

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

/** How far back the transcript is searched: a retry looks for its own message, which is among the newest. */
const TRANSCRIPT_LOOKBACK = 200;
/** Clock slack between this process and the engine's own timestamps. */
const TRANSCRIPT_SLACK_MS = 5_000;

/**
 * Did an earlier attempt of this message already reach the chat? A retry that
 * follows a crash, or a chat whose child idled out between attempts, has lost
 * the wrapper's in-memory ledger — the transcript is then the only witness.
 * Only an omp transcript can say; an engine that keeps its own history answers
 * false and relies on the ledger alone.
 */
async function alreadyDelivered(item: StoredItem): Promise<boolean> {
  if (item.firstAttemptAt === undefined) return false;
  try {
    const file = await resolveSessionPath(item.sessionId);
    if (!file) return false;
    const entries = getSessionEntries(file);
    const wanted = item.message.trim();
    for (let index = entries.length - 1; index >= 0 && index >= entries.length - TRANSCRIPT_LOOKBACK; index -= 1) {
      const entry = entries[index];
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && at < item.firstAttemptAt - TRANSCRIPT_SLACK_MS) return false;
      if (userText(entry.message.content).trim() === wanted) return true;
    }
  } catch {
    // A transcript that cannot be read proves nothing: send, and let the ledger dedupe what it can.
  }
  return false;
}

/** The engine's refusal is final; everything else (a restart, a dead child, a failed spawn) is worth retrying. */
function classify(error: unknown): ScheduledDeliveryError {
  if (error instanceof ScheduledDeliveryError) return error;
  if (isSessionUnavailableError(error)) {
    return new ScheduledDeliveryError(error.reason === "sidebar"
      ? "A sidebar chat cannot receive scheduled messages."
      : "The chat this message was scheduled for no longer exists.", false);
  }
  const message = error instanceof Error ? error.message : String(error);
  // omp's own refusal (`RpcCommandError`): matched by name so this module needs nothing from lib/omp.
  if (error instanceof Error && error.name === "RpcCommandError") return new ScheduledDeliveryError(message, false);
  if (error instanceof EngineCommandError) {
    const transient = error.code === "session_busy" || error.code === "session_dead" || error.code === "session_restarting";
    return new ScheduledDeliveryError(message, transient);
  }
  // A chat whose saved model is gone cannot be opened by a timer: only a person picking another model reopens it, so retrying forever would never end.
  const unrestorable = unrestorableModelOf(error);
  if (unrestorable) {
    return new ScheduledDeliveryError(
      `This chat used ${unrestorable.provider}/${unrestorable.modelId}, which is no longer available. Open the chat and pick another model, then schedule the message again.`,
      false,
    );
  }
  if (error instanceof WebRpcError) return new ScheduledDeliveryError(message, true);
  return new ScheduledDeliveryError(message, true);
}

/** The part of a live omp session this module reads: its delivery ledger. An engine without it (ACP) keeps no such record. */
type LedgerRow = { status: string; error?: string };
type LedgerReader = (clientMessageIds: string[]) => readonly LedgerRow[];

function ledgerOf(session: object): LedgerReader | null {
  if (!("getDeliveryLedger" in session) || typeof session.getDeliveryLedger !== "function") return null;
  const read = session.getDeliveryLedger;
  return (ids) => {
    const rows: unknown = read.call(session, ids);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row): LedgerRow[] => (isRecord(row) && typeof row.status === "string"
      ? [{ status: row.status, ...(typeof row.error === "string" ? { error: row.error } : {}) }]
      : []));
  };
}

/**
 * What the chat did with a send it accepted. Only a message that started (or
 * already reached the transcript) is delivered: one that is held in the
 * wrapper, or queued in omp behind a running reply, is not — an engine loss or
 * a restart would take it with them. A chat with no ledger cannot tell the
 * two apart, so for it a taken send is a delivered one, as it always was.
 */
function handOverOf(session: object, clientMessageId: string, ack: unknown): ScheduledHandOver {
  const read = ledgerOf(session);
  if (!read) return "delivered";
  if (isRecord(ack) && (ack.delivery === "started" || ack.status === "started" || ack.status === "delivered")) return "delivered";
  // The ack can be older than the ledger: the engine's own echo of the message may have landed after it was written.
  const row = read([clientMessageId])[0];
  if (row?.status === "started" || row?.status === "delivered") return "delivered";
  if (row?.status === "failed") throw new ScheduledDeliveryError(row.error ?? "The chat's engine stopped before it read this message.", true);
  return "queued";
}

/**
 * Deliver one message. Resolves once the chat has taken it, saying whether it
 * started (or is in the conversation) or is only queued behind a running turn;
 * rejects with a `ScheduledDeliveryError` saying whether another try is worth it.
 */
export async function deliverScheduledMessage(item: StoredItem): Promise<ScheduledHandOver> {
  try {
    if (item.attempts > 0 && await alreadyDelivered(item)) return "delivered";
    const timeZone = ownerTimeZone(item.sessionId);
    const session = await acquireSession(item.sessionId, timeZone);
    // The same safety net the composer's own prompt gets: a snapshot to restore to. Never allowed to hold the message back.
    await createCheckpoint(session.cwd, item.message).catch(() => null);
    const clientMessageId = clientMessageIdFor(item);
    const ack = await session.send({
      type: "prompt",
      message: item.message,
      streamingBehavior: "followUp",
      clientMessageId,
      timeZone,
    });
    return handOverOf(session, clientMessageId, ack);
  } catch (error) {
    throw classify(error);
  }
}

const ENGINE_LOST = "The chat's engine stopped before it read this message.";

/**
 * Where a message the chat only queued stands now, asked of the chat's live
 * session and never by starting one: a chat with no live child has lost the
 * message, and the retry is what starts it again. `failed` and `unknown` both
 * mean it is gone (the engine was recycled, the wrapper replaced, the server
 * restarted); the retry first looks in the transcript for a copy that got
 * through after all, so nothing is sent twice.
 */
export async function checkHandedOver(item: StoredItem): Promise<HandedOverCheck> {
  const session = getRpcSession(item.sessionId);
  const read = session?.isAlive() ? ledgerOf(session) : null;
  if (!read) return { state: "lost", reason: ENGINE_LOST, freshId: false };
  const row = read([item.handedClientMessageId ?? clientMessageIdFor(item)])[0];
  switch (row?.status) {
    case "started":
    case "delivered":
      return { state: "done" };
    case "queued":
    case "sending":
      return { state: "waiting" };
    case "withdrawn":
      return { state: "withdrawn" };
    case "failed":
      // This wrapper still remembers the outcome of that id, so sending it again would rejoin the lost send: only a new id reaches the engine.
      return { state: "lost", reason: row.error ?? ENGINE_LOST, freshId: true };
    default:
      return { state: "lost", reason: "The chat lost track of this message when its engine restarted.", freshId: false };
  }
}
