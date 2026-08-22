import { NextResponse } from "next/server";
import packageJson from "../../../package.json";
import { getHarness } from "@/lib/harness";
import type { HarnessCapabilities } from "@/lib/harness/types";
import { readEnv } from "@/lib/env";
import { getDiskSpace } from "@/lib/disk-space";


export const dynamic = "force-dynamic";

export interface InfoResponse {
  /** Build-time Cody version from package.json. */
  codyVersion: string;
  /** Runtime probe of the harness binary ("17.1.3"), null when absent. */
  ompVersion: string | null;
  nodeVersion: string;
  /** "<os> <arch>", e.g. "darwin arm64" (process.platform/process.arch). Not
   * to be confused with `platformInfo` below, which is about the hosting
   * shell rather than the OS. */
  platform: string;
  agentDir: string;
  /** Which agent harness this deployment runs on (see lib/harness). */
  harness: { id: string; name: string };
  /** What the ACTIVE engine can serve. The client hides the surfaces whose
   * capability is false (settings tabs, omp-only chat affordances). */
  capabilities: HarnessCapabilities;
  /** Identity of the active engine, for labels and the experimental chip. */
  engine: { id: string; displayName: string; shortName: string; experimental: boolean };
  /**
   * What shell/deployment is hosting Cody — orthogonal to `capabilities`
   * (that's what the active *engine* can serve; this describes the *shell*
   * instead). `desktop` is true only when the Windows desktop shell set
   * CODY_DESKTOP=1 in the env block it owns (docs/windows.md Process
   * Model); false for web and Docker deployments, which never set it —
   * byte-identical to today.
   */
  platformInfo: { desktop: boolean };
  /**
   * Free space on the filesystem holding the instance data dir — everything
   * Cody persists (sessions, checkpoints, installed engines) lands there, and
   * when it fills, engine installs die with errors that name a libuv errno
   * rather than a full disk. Null when the platform cannot report it.
   */
  storage: { availableBytes: number; totalBytes: number } | null;
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
      platformInfo: { desktop: readEnv("DESKTOP") === "1" },
      storage: getDiskSpace(harness.getAgentDir()),
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "info_unavailable" },
      { status: 500 },
    );
  }
}
