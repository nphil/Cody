import { requireUserOrOpenInstance } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import { consumeWorkspaceImage } from "@/lib/devices/artifact-input-source";

/** Only an already-authorized file, once, for a browser allowed to open the chat that requested it. */
export async function GET(request: Request): Promise<Response> {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("sessionId");
  if (!sessionId || !canAccessSession(sessionId, actor.user)) return new Response(null, { status: 404 });
  try { return await consumeWorkspaceImage(sessionId, params.get("token") ?? "", request.signal); }
  catch { return new Response("Workspace image is no longer available for import.", { status: 409 }); }
}
