import { homedir } from "os";
import path from "path";
import { AcpEngineSession } from "./acp-session";
import { getEngineVersion, resolveEngineBin } from "./engine-bin";
import type { EngineSession, EngineSessionOptions, HarnessAdapter } from "./types";

/**
 * Hermes Agent (Nous Research) as a Cody engine, driven over the Agent Client
 * Protocol — `hermes acp` is a stdio JSON-RPC ACP server, the same one Zed,
 * VS Code and JetBrains drive. The protocol work lives in acp-session.ts and
 * names no engine; this file is only the description of Hermes.
 *
 * Hermes is a broader program than a coding agent: it also runs autonomous
 * routines, named bots, and a gateway onto a dozen-plus messaging platforms.
 * None of that is IDE-shaped, so Cody deliberately surfaces the coding agent
 * and leaves the rest to Hermes' own interfaces (docs/specs/2026-08-22-acp-
 * engines.md).
 *
 * Storage note: Hermes keeps conversations in `~/.hermes/state.db` (SQLite),
 * not in per-session files, so there is no transcript for Cody's session
 * reader to walk. `AcpEngineSession` reports `sessionFile: ""` and session
 * metadata rides the `cody-engine-sessions.json` sidecar, exactly as the
 * turn-based engines do.
 */

/** Hermes' own state directory; `HERMES_HOME` overrides it upstream. */
function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim();
  return override || path.join(homedir(), ".hermes");
}

export function createHermesSession(options: EngineSessionOptions): EngineSession {
  const binaryPath = resolveEngineBin("hermes", "HERMES");
  if (!binaryPath) {
    throw new Error("hermes binary not found. Install Hermes from the engine picker, or set CODY_HERMES_BIN.");
  }
  return new AcpEngineSession(
    {
      id: "hermes",
      name: "Hermes",
      binaryPath,
      args: ["acp"],
      setupHint: "Run `hermes setup` in a Cody terminal to pick a provider and add an API key.",
    },
    options,
  );
}

export const hermesHarness: HarnessAdapter = {
  id: "hermes",
  displayName: "Hermes Agent",
  shortName: "Hermes",
  binaryName: "hermes",
  tagline: "Nous Research's self-hosted agent, with persistent memory and its own skills.",
  experimental: true,
  // PyPI, not npm — and the `[acp]` extra is REQUIRED: without it the binary
  // installs fine and then `hermes acp` exits reporting "ACP dependencies not
  // installed", i.e. an engine that looks healthy and cannot start.
  installSpec: "hermes-agent[acp]",
  installVia: "uv",
  // `hermes --version` prints a report whose lines include "Python: 3.11.15";
  // a first-match version scan would report the PYTHON version as the
  // engine's. The acp subcommand prints the bare number.
  versionArgs: ["acp", "--version"],
  authHint:
    "Hermes brings its own model configuration: run `hermes setup` once in a Cody terminal to pick a provider and add keys.",
  capabilities: {
    liveSessions: true,
    // Hermes exposes models through its own config (and, over ACP, session
    // config options). Until Cody reads them (phase 1d) the composer's model
    // control would be a dropdown with nothing in it, so it stays hidden.
    models: false,
    // Hermes has skills, but they are its own format and store — the existing
    // skills surface is built against omp's discovery. Phase 2 adapts it.
    skills: false,
    plugins: false,
    // ACP carries MCP capabilities, but Cody's MCP editor writes omp's config
    // file; Hermes keeps its own. Not wired yet.
    mcp: false,
    // Hermes declares ~550 settings in its own DEFAULT_CONFIG; Cody derives
    // the schema from it, so the panel is real and stays current with
    // upstream (lib/harness/hermes-settings.ts).
    nativeSettings: true,
    // This flag gates the engine's OWN self-update route and the session
    // restart control, both of which are omp-specific. Cody installing
    // Hermes through uv is a different thing entirely, driven by installSpec.
    updates: false,
    // omp-only composer affordances: steering, follow-up queue, compaction,
    // thinking levels, forking. None are wired over ACP yet.
    chatExtras: false,
    fastMode: false,
    advisor: false,
    // ACP has no subagent vocabulary at all, so the roster would stay empty.
    subagents: false,
  },
  resolveBinary: () => resolveEngineBin("hermes", "HERMES"),
  getVersion: () => getEngineVersion("hermes", "HERMES", ["acp", "--version"]),
  getAgentDir: () => hermesHome(),
  // Hermes stores conversations in SQLite rather than a directory of
  // transcripts; this path exists so the adapter contract is satisfied, and
  // the session list comes from the engine-sessions sidecar instead.
  getSessionsDir: () => path.join(hermesHome(), "sessions"),
  createSession: (options) => createHermesSession(options),
};
