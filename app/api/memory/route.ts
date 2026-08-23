import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";

/**
 * The active engine's persistent memory, read-only.
 *
 * Gated on the `memory` capability rather than on an engine id: an engine
 * that keeps memory but cannot hand it back reports false and the UI hides
 * the surface, which is the house rule — capability flags hide surfaces, they
 * never render broken ones.
 */

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const harness = getHarness();
  if (!harness.capabilities.memory || !harness.readMemory) {
    return jsonError(`${harness.displayName} does not expose its memory to Cody.`, 400, "unsupported");
  }
  try {
    return NextResponse.json(
      { harness: { id: harness.id, shortName: harness.shortName }, documents: harness.readMemory() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500, "memory_unreadable");
  }
}
