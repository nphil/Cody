import path from "path";
import { getOmpVersion, resolveOmpBin } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";
import type { HarnessAdapter } from "./types";

/** The founding harness: every capability is on because the surrounding app
 * was built against omp's feature set. */
export const ompHarness: HarnessAdapter = {
  id: "omp",
  displayName: "OMP runtime",
  binaryName: "omp",
  capabilities: {
    liveSessions: true,
    models: true,
    skills: true,
    plugins: true,
    mcp: true,
    nativeSettings: true,
    updates: true,
  },
  resolveBinary: () => resolveOmpBin(),
  getVersion: () => getOmpVersion(),
  getAgentDir: () => getAgentDir(),
  getSessionsDir: () => path.join(getAgentDir(), "sessions"),
};
