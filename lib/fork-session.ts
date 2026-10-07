/**
 * Forking a chat with omp's own `fork` (omp 18.4.11+): "Fork from here" under a
 * reply, and "Duplicate chat" in the sidebar and the command palette. The web
 * command is `fork_session` — the older `fork` is omp's `branch`, which drops
 * the message it is given for editing. One module holds the command, how each
 * failure reads, and the page-wide verdict "this omp cannot", so every control
 * agrees.
 */
import { AgentCommandError, sendAgentCommand } from "./agent-client";
import { isUnsupportedCommandError } from "./subagent-types";

export type ForkOutcome =
  | { status: "forked"; sessionId: string }
  /** A hook in omp vetoed the fork: nothing was created. */
  | { status: "cancelled" }
  /** The chat is working: omp only forks an idle one. */
  | { status: "busy" }
  /** This omp has no `fork`, or the engine is not omp: the controls hide. */
  | { status: "unsupported" }
  | { status: "failed"; message: string };

let unsupported = false;
const listeners = new Set<() => void>();

/** True once an engine has said it cannot fork. It cannot learn mid-page, so
 *  the verdict lasts until the page reloads. */
export function isForkUnsupported(): boolean {
  return unsupported;
}

export function subscribeForkSupport(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test-only: forget the verdict. */
export function resetForkSupport(): void {
  unsupported = false;
}

/**
 * Fork `sessionId` at `entryId` (the new chat keeps the conversation through
 * that message), or copy the whole chat when there is none. The engine moves
 * onto the new chat, whose id comes back for the page to switch to.
 */
export async function forkChat(
  sessionId: string,
  entryId?: string,
  send: typeof sendAgentCommand = sendAgentCommand,
): Promise<ForkOutcome> {
  try {
    const result = await send<{ cancelled?: boolean; newSessionId?: string }>(sessionId, {
      type: "fork_session",
      ...(entryId ? { entryId } : {}),
    });
    if (result?.cancelled) return { status: "cancelled" };
    if (result?.newSessionId) return { status: "forked", sessionId: result.newSessionId };
    return { status: "failed", message: "" };
  } catch (error) {
    if (isUnsupportedCommandError(error)) {
      if (!unsupported) {
        unsupported = true;
        for (const listener of listeners) listener();
      }
      return { status: "unsupported" };
    }
    if (error instanceof AgentCommandError && error.code === "session_busy") return { status: "busy" };
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
