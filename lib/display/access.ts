import { getRequestUser } from "../auth/guard";
import { canAccessSession } from "../auth/session-owners";
import { getEngineSession } from "../harness/engine-sessions";
import { getRpcSession } from "../rpc-manager";
import { resolveSessionPath } from "../session-reader";

export async function authorizeDisplaySession(request: Request, sessionId: string): Promise<boolean> {
  if (!sessionId || !canAccessSession(sessionId, getRequestUser(request))) return false;
  if (getRpcSession(sessionId)?.isAlive()) return true;
  if (getEngineSession(sessionId)) return true;
  return (await resolveSessionPath(sessionId)) !== null;
}
