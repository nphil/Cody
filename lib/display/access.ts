import { getRequestUser } from "../auth/guard";
import { canAccessSession } from "../auth/session-owners";
import type { UserRecord } from "../auth/users";
import { getEngineSession } from "../harness/engine-sessions";
import { getRpcSession } from "../rpc-manager";
import { resolveSessionPath } from "../session-reader";

/**
 * Ownership AND existence. `canAccessSession` cannot distinguish an unknown
 * session id from an unowned one (both answer "visible to everyone"), so the
 * display surface must additionally prove the session really exists before it
 * hands out a socket or a request.
 */
export async function canAccessDisplaySession(sessionId: string, user: UserRecord | null): Promise<boolean> {
  if (!sessionId || !canAccessSession(sessionId, user)) return false;
  if (getRpcSession(sessionId)?.isAlive()) return true;
  if (getEngineSession(sessionId)) return true;
  return (await resolveSessionPath(sessionId)) !== null;
}

export function authorizeDisplaySession(request: Request, sessionId: string): Promise<boolean> {
  return canAccessDisplaySession(sessionId, getRequestUser(request));
}
