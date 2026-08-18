import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { extractSubagentHistory, sumSubagentTranscriptUsage } from "@/lib/subagent-history";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/subagents
 *
 * On-disk subagent roster for a session, recovered from the parent file's task
 * toolResults (works without a live RPC process — survives page reloads).
 *
 * `subagentUsage` is the tokens/cost those children actually reported, summed
 * from their own transcripts in the sibling artifacts dir. It is the half of an
 * orchestrated session's account that lives outside the parent file, and the
 * headline rollup adds it to the parent's own messages. The roster's per-child
 * `tokens`/`cost` are display values recovered from the parent's task
 * toolResults — the same events seen from the other side — so a caller must
 * never add both.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) {
      // A brand-new session's file can land just after the prompt
      // acknowledgement; while its RPC wrapper is alive that is "no on-disk
      // history yet", not "unknown session". The client treats an empty
      // roster the same as a 404, so answer 200 to keep the console clean.
      if (getRpcSession(id)?.isAlive()) {
        return NextResponse.json({ subagents: [], subagentUsage: null });
      }
      return resolved.response;
    }
    const filePath = resolved.filePath;
    const subagents = extractSubagentHistory(filePath);
    return NextResponse.json({ subagents, subagentUsage: sumSubagentTranscriptUsage(filePath) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
