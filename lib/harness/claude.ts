import { homedir } from "os";
import path from "path";
import { getEngineVersion, resolveEngineBin } from "./engine-bin";
import { createClaudeSession } from "./turn-session";
import type { HarnessAdapter } from "./types";

/**
 * Claude Code as a Cody engine (experimental). Live chat runs the `claude`
 * CLI one turn per process in stream-json mode (see lib/harness/turn-session)
 * — every other omp surface (models registry, skills, plugins, MCP config,
 * native settings, updates) is capability-gated off. Credentials are Claude
 * Code's own: `claude` login state or ANTHROPIC_API_KEY, both under the
 * container's persistent HOME.
 */
export const claudeHarness: HarnessAdapter = {
  id: "claude",
  displayName: "Claude Code",
  shortName: "Claude",
  binaryName: "claude",
  tagline: "Anthropic's coding agent, driven through the claude CLI.",
  experimental: true,
  installSpec: "@anthropic-ai/claude-code@latest",
  authHint:
    "Sign in by running `claude` once in a Cody terminal, or set ANTHROPIC_API_KEY on the container.",
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
  resolveBinary: () => resolveEngineBin("claude", "CLAUDE"),
  getVersion: () => getEngineVersion("claude", "CLAUDE"),
  getAgentDir: () => path.join(homedir(), ".claude"),
  getSessionsDir: () => path.join(homedir(), ".claude", "projects"),
  createSession: (options) => createClaudeSession(options),
};
