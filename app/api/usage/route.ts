import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";
import { getUsageSnapshot } from "@/lib/usage/cache";
import type { UsageSnapshot } from "@/lib/usage/types";

/**
 * GET /api/usage — the active engine's plan-quota windows (e.g. "5h: 42%
 * used, resets 14:00") for the usage meter in Settings / the status strip.
 * Same signed-in-only guard as GET /api/local-ai; all probing and caching
 * lives in lib/usage, so this route is just auth + fail-soft plumbing.
 */
export const dynamic = "force-dynamic";

function emptySnapshot(reason: string): UsageSnapshot {
  return { available: false, accounts: [], fetchedAt: new Date().toISOString(), stale: false, reason };
}

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  // `omp usage --json` is the ONLY reader lib/usage has, so this route can
  // only answer for omp. It used to answer for every engine: on Hermes the
  // composer's quota ring reported an OMP account's exhaustion, polled every
  // 90 seconds, for a subscription the running agent was not spending.
  //
  // The refusal is a VALUE, not an error — an unavailable snapshot is a
  // well-formed answer this endpoint already returns for a missing binary,
  // and the meter is built to hide on it. A 4xx here would paint an error
  // over a widget whose honest state is simply "nothing to show".
  const harness = getHarness();
  if (harness.id !== "omp") {
    return NextResponse.json(
      emptySnapshot(`${harness.displayName} does not report plan quota to Cody.`),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // The client poll is itself the refresh trigger, so wait for the fresh
    // read rather than being handed the entry it came to replace — otherwise
    // every poll lands after the TTL and reports "may be out of date" forever.
    const snapshot = await getUsageSnapshot({ awaitFresh: true });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // getUsageSnapshot is expected to fail soft on its own; this only guards
    // against something more fundamental (e.g. the cache module itself
    // throwing during import-time setup). Never surface a 500 for a usage
    // widget — an empty, well-formed snapshot is always a valid answer.
    return NextResponse.json(emptySnapshot(error instanceof Error ? error.message : String(error)), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
