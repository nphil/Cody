import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { scanLocalAiRuntimesCached } from "@/lib/local-ai";

/**
 * GET /api/local-ai — probes well-known local/OpenAI-compatible runtimes
 * (Ollama, LM Studio, llama.cpp/llama-swap) from the server's own network
 * position, plus the desktop shell's Windows host when CODY_HOST_GATEWAY is
 * set (docs/windows.md "Local AI runtimes"). Read-only and side-effect free
 * — same signed-in-only guard as GET /api/engines, no admin requirement.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  try {
    const results = await scanLocalAiRuntimesCached();
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // The scan itself never throws — every probe swallows its own network
    // errors — so this only guards against something more fundamental. Fail
    // soft with a well-formed empty payload rather than a 500.
    return NextResponse.json(
      { results: [], error: error instanceof Error ? error.message : String(error) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
