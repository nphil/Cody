import { createCheckpoint } from "../checkpoints";
import { getHarness } from "../harness";
import { getEngineSession } from "../harness/engine-sessions";
import { EngineCommandError } from "../harness/errors";
import type { EngineSession } from "../harness/types";
import { alignSessionTimeZone, getRpcSession, resolveSpawnCwd, startRpcSession, unrestorableModelOf, WebRpcError } from "../rpc-manager";
import { getSessionEntries, isSidebarSessionPath, readSessionHeader, resolveSessionPath } from "../session-reader";
import { ownerTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import { ScheduledDeliveryError } from "./errors";
import { clientMessageIdFor, type StoredItem } from "./store";

/**
 * Handing one scheduled message to its chat — the same path the composer's own
 * send takes (`POST /api/agent/[id]`), minus the request.
 *
 * The chat may have no live child (it idled out hours ago, or the server just
 * restarted): a child is started for it exactly as the route would, in the
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

/** A chat that no longer exists (or never will): sending again cannot help. */
function gone(): ScheduledDeliveryError {
  return new ScheduledDeliveryError("The chat this message was scheduled for no longer exists.", false);
}

async function acquireSession(sessionId: string, timeZone: string): Promise<EngineSession> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return alignSessionTimeZone(existing, timeZone);

  const harness = getHarness();
  // A turn-based engine owns its transcript; the session is known by its index row.
  if (harness.createSession) {
    const row = getEngineSession(sessionId);
    if (!row || row.engine !== harness.id) throw gone();
    const { session } = await startRpcSession(sessionId, "", resolveSpawnCwd(row.cwd), undefined, false, sessionId, undefined, undefined, undefined, { timeZone });
    return session;
  }

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw gone();
  if (isSidebarSessionPath(filePath)) throw new ScheduledDeliveryError("A sidebar chat cannot receive scheduled messages.", false);
  const { session } = await startRpcSession(sessionId, filePath, resolveSpawnCwd(readSessionHeader(filePath)?.cwd), undefined, false, undefined, undefined, undefined, undefined, { timeZone });
  return session;
}

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

/**
 * Deliver one message. Resolves once the chat has taken it (running, or held
 * behind a turn that is); rejects with a `ScheduledDeliveryError` saying whether
 * another try is worth it.
 */
export async function deliverScheduledMessage(item: StoredItem): Promise<void> {
  try {
    if (item.attempts > 0 && await alreadyDelivered(item)) return;
    const timeZone = ownerTimeZone(item.sessionId);
    const session = await acquireSession(item.sessionId, timeZone);
    // The same safety net the composer's own prompt gets: a snapshot to restore to. Never allowed to hold the message back.
    await createCheckpoint(session.cwd, item.message).catch(() => null);
    await session.send({
      type: "prompt",
      message: item.message,
      streamingBehavior: "followUp",
      clientMessageId: clientMessageIdFor(item),
      timeZone,
    });
  } catch (error) {
    throw classify(error);
  }
}
