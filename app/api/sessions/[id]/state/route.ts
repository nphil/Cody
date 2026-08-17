import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { apiErrorResponse, resolveEngineSessionOr404, resolveSessionPathOr404 } from "@/lib/api-utils";
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
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
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
    return apiErrorResponse(error);
  }
}
