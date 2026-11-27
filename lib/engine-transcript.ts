import { engineCrashRow, withEngineCrashRows } from "./engine-crash";
import { readEngineCrashes } from "./engine-crash-log";
import type { EngineSession } from "./harness/types";
import { getRpcSession } from "./rpc-manager";
import type { AgentMessage } from "./types";

/** The persistent lines engine crashes left in this chat (lib/engine-crash-log.ts), laid among the messages by time. */
export function withCrashRows<C extends { messages: AgentMessage[]; entryIds: string[] }>(sessionId: string, context: C): C {
  const merged = withEngineCrashRows<AgentMessage>(context.messages, context.entryIds, readEngineCrashes(sessionId), engineCrashRow);
  return merged.messages === context.messages ? context : { ...context, ...merged };
}

/**
 * A non-omp engine's transcript: the live session's in-memory turn log while it
 * runs, nothing once it has been disposed (reading a claude or codex native
 * transcript off disk is out of scope). Shared by GET /api/sessions/[id] and
 * GET /api/sessions/[id]/context so both page the same list.
 *
 * `alive` is the live session when there is one, for callers that also ask it
 * for its state. A failed `get_messages` leaves the transcript empty; the live
 * event stream still drives the UI.
 */
export async function readEngineMessages(id: string): Promise<{
  messages: AgentMessage[];
  alive: EngineSession | null;
}> {
  const rpc = getRpcSession(id);
  const alive = rpc?.isAlive() ? rpc : null;
  let messages: AgentMessage[] = [];
  if (alive) {
    try {
      const result = await alive.send({ type: "get_messages" }) as { messages?: AgentMessage[] } | null;
      messages = result?.messages ?? [];
    } catch {
      // Leave the transcript empty.
    }
  }
  return { messages, alive };
}
