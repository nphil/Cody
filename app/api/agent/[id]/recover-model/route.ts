import { NextResponse } from "next/server";
import { agentCommandErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getRpcSession, resolveSpawnCwd, startRpcSession } from "@/lib/rpc-manager";
import { isSidebarSessionPath, readSessionHeader } from "@/lib/session-reader";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

// POST /api/agent/[id]/recover-model - Reopen a chat whose saved model is gone.
// Body: { provider, modelId }. omp 18.6.3+ will not resume a session whose saved
// model no longer exists or has no credentials (`model_unrestorable`); this
// spawns the chat once with the chosen model and records it in the session, so
// every later start resumes normally. A chat that is already running answers
// success without touching it.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await parseJsonWithinLimit<unknown>(req, 4 * 1024);
    const provider = isRecord(body) && typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = isRecord(body) && typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) {
      return NextResponse.json({ error: "provider and modelId are required", code: "model_required" }, { status: 400 });
    }

    if (getRpcSession(id)?.isAlive()) return NextResponse.json({ success: true, data: { provider, modelId, alreadyRunning: true } });

    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    if (isSidebarSessionPath(filePath)) {
      return NextResponse.json({ error: "Sidebar chats do not need model recovery", code: "unsupported" }, { status: 400 });
    }
    const cwd = resolveSpawnCwd(readSessionHeader(filePath)?.cwd);
    await startRpcSession(id, filePath, cwd, undefined, false, undefined, undefined, undefined, undefined, { restoreModel: { provider, modelId } });
    return NextResponse.json({ success: true, data: { provider, modelId } });
  } catch (error) {
    return agentCommandErrorResponse(error);
  }
}
