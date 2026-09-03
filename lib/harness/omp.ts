import path from "path";
import { getOmpVersion, resolveOmpBin } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";
import { readSchemaSettings, writeSchemaSettings } from "../omp/settings-values";
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
  // Audited against the 18.1.6 changelog + full test suite with 18.1.6
  // installed: the RPC command/message types are unchanged, `usage --json`
  // still parses (its new `capacity`/`disabledCredentials` keys are ignored),
  // the settings schema picks up the new keys on its own, the removed
  // `designer` model role is gone from every surface, and the skills walk now
  // follows omp's opt-in for foreign user-level directories.
  verifiedVersion: "18.1.6",
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
  settings: {
    // omp's own settings pipeline (lib/omp/settings-schema + settings-values),
    // reached through the adapter so the route never has to know which engine
    // it is answering for. This adapter is the one place the seam allows to
    // import lib/omp directly.
    readSchema: () => readSchemaSettings(),
    write: (patch) => {
      // A whole-patch failure (no schema, an unknown path) throws out of
      // writeSchemaSettings and becomes the route's 400; per-key refusals do
      // not exist for omp, which validates the entire patch before writing.
      const written = writeSchemaSettings(patch);
      return { written, rejected: [], values: readSchemaSettings().values };
    },
  },
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
