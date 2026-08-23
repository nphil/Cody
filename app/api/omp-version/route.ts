import { NextResponse } from "next/server";
import { getHarness } from "@/lib/harness";

export const dynamic = "force-dynamic";

/**
 * Runtime probe of the ACTIVE engine's binary (bare semver, e.g. "17.3.7"),
 * separate from the build-time Cody version — the two can legitimately drift.
 *
 * It used to probe omp unconditionally, so a Hermes instance reported omp's
 * 18.0.1 as its engine version. The engine identity now rides along, because
 * a bare version string is exactly what let the caller assume whose it was.
 */
export async function GET() {
  const harness = getHarness();
  return NextResponse.json({
    version: await harness.getVersion(),
    engine: { id: harness.id, shortName: harness.shortName, displayName: harness.displayName },
  });
}
