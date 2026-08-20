import { NextResponse } from "next/server";
import { getOmpVersion } from "@/lib/omp/omp-cli";

export const dynamic = "force-dynamic";

/** Runtime probe of the installed omp binary (bare semver, e.g. "17.3.7"),
 * separate from the build-time Cody version — the two can legitimately drift. */
export async function GET() {
  const version = await getOmpVersion();
  return NextResponse.json({ version });
}
