import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { agentCommandErrorResponse, getStateBounded, livePhaseState, resolveEngineSessionOr404, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getHarness } from "@/lib/harness";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // A live process proves the session exists: omp does not create the session
    // file until the history holds an assistant message, so the path check
    // below would 404 a brand-new running session.
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      // `?fast=1`: the run phase this server already holds, for a page that
      // attaches to a live chat without waiting behind a busy engine's queue.
      const quick = new URL(req.url).searchParams.get("fast") === "1" ? livePhaseState(rpc) : null;
      return NextResponse.json(quick ?? await getStateBounded(rpc));
    }

    // A non-omp engine has no session file to fall back on: its index row is
    // what proves the session exists, so answer the same "known but idle"
    // payload instead of the 404 the path check would produce.
    if (getHarness().createSession) {
      const engine = resolveEngineSessionOr404(id, req);
      if ("response" in engine) return engine.response;
      return NextResponse.json({ running: false });
    }

    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    return NextResponse.json({ running: false });
  } catch (error) {
    return agentCommandErrorResponse(error);
  }
}
