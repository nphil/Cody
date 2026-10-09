import { getHarness } from "./harness";
import { getEngineSession } from "./harness/engine-sessions";
import type { EngineSession } from "./harness/types";
import { alignSessionTimeZone, getRpcSession, resolveSpawnCwd, startRpcSession } from "./rpc-manager";
import { isSidebarSessionPath, readSessionHeader, resolveSessionPath } from "./session-reader";

/**
 * A chat's live engine session for work nobody is typing for — a scheduled
 * message, a run Cody resumes after a stall or a restart. It takes the same
 * path the composer's own send does (`POST /api/agent/[id]`), minus the
 * request: a live child is reused (moved onto `timeZone` first when it is
 * idle), and a chat with none gets one started, resumed from its own session.
 *
 * Ownership is not checked here: the caller's work was authorised when it was
 * set up (a schedule, a run the owner started), and a chat's owner does not
 * change.
 */

/** Why a chat cannot be given a live session at all, so retrying cannot help. */
export type SessionUnavailableReason = "gone" | "sidebar";

/**
 * Read with `isSessionUnavailableError`, never `instanceof`: the server loads
 * this module more than once (the Next bundle and the custom server's jiti).
 */
export class SessionUnavailableError extends Error {
  readonly reason: SessionUnavailableReason;

  constructor(reason: SessionUnavailableReason) {
    super(reason === "sidebar"
      ? "A sidebar chat cannot be started for this."
      : "This chat no longer exists.");
    this.name = "SessionUnavailableError";
    this.reason = reason;
  }
}

export function isSessionUnavailableError(error: unknown): error is SessionUnavailableError {
  if (!(error instanceof Error) || error.name !== "SessionUnavailableError" || !("reason" in error)) return false;
  return error.reason === "gone" || error.reason === "sidebar";
}

export async function acquireSession(sessionId: string, timeZone: string): Promise<EngineSession> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return alignSessionTimeZone(existing, timeZone);

  const harness = getHarness();
  // A non-omp engine owns its transcript; the session is known by its index row.
  if (harness.createSession) {
    const row = getEngineSession(sessionId);
    if (!row || row.engine !== harness.id) throw new SessionUnavailableError("gone");
    const { session } = await startRpcSession(sessionId, "", resolveSpawnCwd(row.cwd), undefined, false, sessionId, undefined, undefined, undefined, { timeZone });
    return session;
  }

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionUnavailableError("gone");
  if (isSidebarSessionPath(filePath)) throw new SessionUnavailableError("sidebar");
  const { session } = await startRpcSession(sessionId, filePath, resolveSpawnCwd(readSessionHeader(filePath)?.cwd), undefined, false, undefined, undefined, undefined, undefined, { timeZone });
  return session;
}
