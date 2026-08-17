import { NextResponse } from "next/server";
import packageJson from "../../../package.json";
import { getHarness } from "@/lib/harness";
import type { HarnessCapabilities } from "@/lib/harness/types";


export const dynamic = "force-dynamic";

export interface InfoResponse {
  /** Build-time Cody version from package.json. */
  codyVersion: string;
  /** Runtime probe of the harness binary ("17.1.3"), null when absent. */
  ompVersion: string | null;
  nodeVersion: string;
  /** "<platform> <arch>", e.g. "darwin arm64". */
  platform: string;
  agentDir: string;
  /** Which agent harness this deployment runs on (see lib/harness). */
  harness: { id: string; name: string };
  /** What the ACTIVE engine can serve. The client hides the surfaces whose
   * capability is false (settings tabs, omp-only chat affordances). */
  capabilities: HarnessCapabilities;
  /** Identity of the active engine, for labels and the experimental chip. */
  engine: { id: string; displayName: string; shortName: string; experimental: boolean };
}

/** Read-only runtime facts for the Info panel. Deliberately minimal: no env
 * vars, no config contents, no cwd — nothing here depends on a workspace, so
 * there is no path to allow-list check. */
export async function GET() {
  try {
    const harness = getHarness();
    const body: InfoResponse = {
      codyVersion: packageJson.version,
      ompVersion: await harness.getVersion(),
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      agentDir: harness.getAgentDir(),
      harness: { id: harness.id, name: harness.displayName },
      capabilities: harness.capabilities,
      engine: {
        id: harness.id,
        displayName: harness.displayName,
        shortName: harness.shortName,
        experimental: harness.experimental === true,
      },
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "info_unavailable" },
      { status: 500 },
    );
  }
}
