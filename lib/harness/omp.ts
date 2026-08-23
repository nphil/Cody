import path from "path";
import { getOmpVersion, resolveOmpBin } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";
import type { HarnessAdapter } from "./types";

/** The founding harness: every capability is on because the surrounding app
 * was built against omp's feature set. */
export const ompHarness: HarnessAdapter = {
  id: "omp",
  displayName: "OMP runtime",
  shortName: "OMP",
  binaryName: "omp",
  tagline: "The oh-my-pi coding agent. Cody's founding engine, every surface enabled.",
  installSpec: "@oh-my-pi/pi-coding-agent@latest",
  verifiedMajor: 18,
  capabilities: {
    liveSessions: true,
    models: true,
    skills: true,
    plugins: true,
    mcp: true,
    nativeSettings: true,
    configEditor: true,
    updates: true,
    chatExtras: true,
    fastMode: true,
    advisor: true,
    subagents: true,
    // omp has memory (mnemopi, hindsight) but exposes no read-back Cody
    // can call, so the surface stays hidden rather than empty.
    memory: false,
  },
  resolveBinary: () => resolveOmpBin(),
  getVersion: () => getOmpVersion(),
  getAgentDir: () => getAgentDir(),
  getSessionsDir: () => path.join(getAgentDir(), "sessions"),
  rpcUi: {
    mode: "rpc-ui",
    resumeFlag: "--resume",
    supportsCwdFlag: true,
    supportsAdvisor: true,
    hostTools: true,
    subagentEvents: true,
    readiness: "ready-frame",
  },
};
