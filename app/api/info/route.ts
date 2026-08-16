import { NextResponse } from "next/server";
import packageJson from "../../../package.json";
import { getOmpVersion } from "@/lib/omp/omp-cli";
import { getAgentDir } from "@/lib/omp/paths";

export const dynamic = "force-dynamic";

export interface InfoResponse {
  /** Build-time Cody version from package.json. */
  codyVersion: string;
  /** Runtime probe of the installed omp binary ("omp/17.1.3"), null when absent. */
  ompVersion: string | null;
  nodeVersion: string;
  /** "<platform> <arch>", e.g. "darwin arm64". */
  platform: string;
  agentDir: string;
}

/** Read-only runtime facts for the Info panel. Deliberately minimal: no env
 * vars, no config contents, no cwd — nothing here depends on a workspace, so
 * there is no path to allow-list check. */
export async function GET() {
  try {
    const body: InfoResponse = {
      codyVersion: packageJson.version,
      ompVersion: await getOmpVersion(),
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      agentDir: getAgentDir(),
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "info_unavailable" },
      { status: 500 },
    );
  }
}
