import { homedir } from "os";
import path from "path";
import { getEngineVersion, resolveEngineBin } from "./engine-bin";
import { createCodexSession } from "./turn-session";
import type { HarnessAdapter } from "./types";

/**
 * OpenAI Codex as a Cody engine (experimental). Live chat runs `codex exec
 * --json` one turn per process (see lib/harness/turn-session); everything
 * omp-specific is capability-gated off. Credentials are Codex's own:
 * `codex login` state under ~/.codex or OPENAI_API_KEY. Codex can also run
 * against local models (`--oss`, model_provider overrides in its
 * config.toml), which keeps the local-inference door open on this engine.
 */
export const codexHarness: HarnessAdapter = {
  id: "codex",
  displayName: "Codex",
  shortName: "Codex",
  binaryName: "codex",
  tagline: "OpenAI's coding agent, driven through the codex CLI.",
  experimental: true,
  installSpec: "@openai/codex@latest",
  authHint:
    "Sign in by running `codex login` once in a Cody terminal, or set OPENAI_API_KEY on the container.",
  capabilities: {
    liveSessions: true,
    models: false,
    skills: false,
    plugins: false,
    mcp: false,
    nativeSettings: false,
    updates: false,
    chatExtras: false,
  },
  resolveBinary: () => resolveEngineBin("codex", "CODEX"),
  getVersion: () => getEngineVersion("codex", "CODEX"),
  getAgentDir: () => path.join(homedir(), ".codex"),
  getSessionsDir: () => path.join(homedir(), ".codex", "sessions"),
  createSession: (options) => createCodexSession(options),
};
