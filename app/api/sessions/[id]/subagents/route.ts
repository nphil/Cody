import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { sumSubagentTranscriptUsage } from "@/lib/subagent-history";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/subagents
 *
 * `subagentUsage`: the tokens/cost a session's subagents actually reported,
 * summed from their own transcripts in the sibling artifacts dir. It is the
 * half of an orchestrated session's account that lives outside the parent
 * file, and the headline rollup adds it to the parent's own messages.
 *
 * Usage only, on purpose: the live roster comes from the engine
 * (get_subagents), and this route never parses the parent file. It runs on
 * every session switch, and a parse of a running chat's file blocked the
 * whole server for seconds.
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
      // acknowledgement; while its RPC wrapper is alive that is "nothing on
      // disk yet", not "unknown session". The client treats no usage the
      // same as a 404, so answer 200 to keep the console clean.
      if (getRpcSession(id)?.isAlive()) {
        return NextResponse.json({ subagentUsage: null });
      }
      return resolved.response;
    }
    return NextResponse.json({ subagentUsage: sumSubagentTranscriptUsage(resolved.filePath) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
