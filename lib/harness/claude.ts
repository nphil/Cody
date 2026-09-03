import { homedir } from "os";
import path from "path";
import { AcpEngineSession, type AcpMcpServer } from "./acp-session";
import { displayMcpAcpServer } from "../display/engine-tools";
import { getEngineVersion, resolveEngineBin } from "./engine-bin";
import type { EngineSession, EngineSessionOptions, HarnessAdapter } from "./types";

/**
 * Claude Code as a Cody engine, driven over the Agent Client Protocol.
 *
 * What Cody installs is `@agentclientprotocol/claude-agent-acp`, the official
 * ACP adapter from the same org that publishes the SDK Cody already depends
 * on. The `claude` CLI does not speak ACP itself; the adapter drives it
 * through the Claude Agent SDK. Bare invocation IS ACP stdio mode — there is
 * no subcommand — and `--cli <args>` forwards to the wrapped CLI.
 *
 * What that buys over the `claude -p --output-format stream-json`
 * process-per-turn path it replaces (since deleted):
 *
 * - One long-lived session instead of a process per turn, and `session/load`
 *   to resume it.
 * - A real approval channel. `claude -p` is non-interactive and ran with edits
 *   auto-accepted because it had nowhere to ask; over ACP the agent raises
 *   `session/request_permission` and the turn genuinely waits for a human
 *   (lib/harness/acp-session.ts).
 *
 * The ACP `sessionId` IS Claude Code's own session id — the value Cody already
 * stored as `engineSessionId` and passed as `--session-id`/`--resume` — so
 * every stored id keeps working across this change with no migration. An id
 * the CLI no longer holds fails `session/load` as `resourceNotFound`, which
 * the ACP client already answers by opening a fresh session.
 *
 * Credentials are Claude Code's own: `claude` login state under the
 * container's persistent HOME, or ANTHROPIC_API_KEY.
 *
 * ONE COPY OF THE CLI. The adapter bundles a ~309 MB platform-native Claude
 * CLI as an optional dependency of `@anthropic-ai/claude-agent-sdk`. Cody
 * already installs and version-manages `@anthropic-ai/claude-code`, so it
 * installs the adapter WITHOUT that bundle (`skipNativeOptional`) and points
 * it at the CLI it owns through `CLAUDE_CODE_EXECUTABLE` (`engineEnv`). The
 * alternative — two copies of the same native binary in one tools prefix —
 * is the shape of the disk exhaustion that put the guards in install.ts
 * there in the first place.
 */

/** The Claude CLI the adapter drives. Its own resolution ladder, separate from
 * the adapter's, so `CODY_CLAUDE_BIN` keeps naming the thing Cody runs (the
 * adapter) while an operator can still redirect the CLI underneath it. */
function claudeCliBin(): string | null {
  return resolveEngineBin("claude", "CLAUDE_CLI");
}

/**
 * Point the adapter at the CLI Cody installed, since its own bundled copy was
 * deliberately not installed.
 *
 * Deferring to an existing value is the whole reason this is a function: an
 * operator who exported `CLAUDE_CODE_EXECUTABLE` on the container has chosen a
 * CLI, and Cody silently substituting its own would be the hardest kind of bug
 * to see — everything works, against the wrong binary.
 */
function claudeEngineEnv(): Record<string, string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return {};
  const cli = claudeCliBin();
  return cli ? { CLAUDE_CODE_EXECUTABLE: cli } : {};
}

/**
 * One argv, two jobs: it proves the CLI half of the install actually runs
 * (`healthArgs`) and it prints the version Cody reports as Claude Code's
 * (`engineCli.getVersion`). Shared so the number that gets VERIFIED is the
 * number that gets SHOWN.
 *
 * It needs `claudeEngineEnv()`: with the bundled copy deliberately not
 * installed, a bare run dies with "Claude native binary not found for
 * linux-x64 … or set CLAUDE_CODE_EXECUTABLE".
 */
const CLAUDE_CLI_VERSION_ARGS = ["--cli", "--version"] as const;

/**
 * Cody's display bridge (open_preview, preview_screenshot, read_app_logs) as
 * an MCP server on the session. This is how Claude Code has always reached
 * those tools — the per-turn path passed the same server as `--mcp-config` —
 * so it rides ACP's `session/new` rather than being quietly dropped in the
 * move. Session-scoped, because the capability token is.
 *
 * Failing to build one costs the session its display tools and nothing else:
 * the token issuer throws when the server's internal secret is unset (a bare
 * `next dev`, a test harness), and no chat should die for want of a preview.
 */
function claudeMcpServers(sessionId: string): readonly AcpMcpServer[] {
  try {
    return [displayMcpAcpServer(sessionId)];
  } catch {
    return [];
  }
}

export function createClaudeSession(options: EngineSessionOptions): EngineSession {
  const binaryPath = resolveEngineBin("claude-agent-acp", "CLAUDE");
  if (!binaryPath) {
    throw new Error("claude-agent-acp binary not found. Install Claude Code from the engine picker, or set CODY_CLAUDE_BIN.");
  }
  return new AcpEngineSession(
    {
      id: "claude",
      name: "Claude Code",
      binaryPath,
      // Bare argv is ACP stdio mode. `--cli` would hand the whole invocation
      // to the wrapped CLI instead, and `--version` would print the adapter's
      // own version and exit.
      args: [],
      env: claudeEngineEnv(),
      // The adapter's `title` is a human sentence ("npm run typecheck"); the
      // tool's real name is here. Verified against a live tool call.
      toolNameMetaPath: ["claudeCode", "toolName"],
      mcpServers: claudeMcpServers,
      setupHint: "Run `claude` in a Cody terminal to sign in, or set ANTHROPIC_API_KEY on the container.",
    },
    options,
  );
}

export const claudeHarness: HarnessAdapter = {
  id: "claude",
  displayName: "Claude Code",
  shortName: "Claude",
  // The adapter, not `claude`: it is what Cody installs, what the picker
  // probes for, and what a Cody terminal launches (through `cliArgs`).
  binaryName: "claude-agent-acp",
  tagline: "Anthropic's coding agent, over the Agent Client Protocol.",
  experimental: true,
  installSpec: "@agentclientprotocol/claude-agent-acp@latest",
  // Without its bundled CLI — see the note above. npm ignores `--omit=optional`
  // for a global install, so install.ts uses the platform gate instead.
  skipNativeOptional: true,
  // …which means the CLI has to come from somewhere, and this is it. Pinned
  // `@latest` like the adapter: every install IS the update path, so both
  // halves of the engine move together and neither can go stale alone.
  installAlso: ["@anthropic-ai/claude-code@latest"],
  // Which of those two packages is which, so the card can label the numbers
  // instead of showing the adapter's and calling it Claude Code's — and so
  // the update check asks npm about BOTH. Without the second registry name a
  // CLI left behind at 2.1.238 reads as "up to date" while 2.1.241 is
  // published, because the adapter it sits under was already current.
  engineCli: {
    adapterLabel: "Claude Code ACP adapter",
    label: "Claude Code CLI",
    packageName: "@anthropic-ai/claude-code",
    getVersion: () => getEngineVersion("claude-agent-acp", "CLAUDE", CLAUDE_CLI_VERSION_ARGS, claudeEngineEnv()),
  },
  engineEnv: claudeEngineEnv,
  authHint:
    "Sign in by running `claude` once in a Cody terminal, or set ANTHROPIC_API_KEY on the container.",
  // `claude-agent-acp --cli` forwards to the real Claude CLI. A Cody terminal
  // (and the SSH engine-first login) opens THAT rather than the bare binary,
  // which would be a JSON-RPC server reading the user's keystrokes.
  cliArgs: ["--cli"],
  // Bare `--version` is the right VERSION probe: it prints the adapter's own
  // version, which is the package `installSpec` names and therefore the one
  // the update check compares against the registry.
  //
  // It is the wrong HEALTH probe, for the reason Hermes taught. `--version` is
  // answered from the adapter's own package.json before it looks at Claude at
  // all, so it reports a healthy 0.70.0 with no CLI underneath — which is
  // exactly the state `skipNativeOptional` creates on purpose, and exactly the
  // state a failed companion install leaves behind by accident. `--cli
  // --version` runs the CLI the adapter would drive and prints ITS version;
  // verified both ways, it exits 0 with "2.1.241 (Claude Code)" when the chain
  // is whole and throws "Claude native binary not found … or set
  // CLAUDE_CODE_EXECUTABLE" when it is not.
  healthArgs: CLAUDE_CLI_VERSION_ARGS,
  // The ADAPTER's version, which is the package installSpec names — not the
  // CLI's 2.x, which moves on its own schedule and is a different package
  // entirely. 0.73.0 is what Cody's ACP client has been exercised against
  // (initialize, session/new, a prompt round trip, modes and set_mode);
  // `engineCli.adapterLabel` is what the notice names, so a 1.0 adapter reads
  // as a claim about the adapter and nothing else.
  verifiedVersion: "0.73.0",
  capabilities: {
    // Verified end to end against the real adapter: initialize, session/new,
    // a prompt round trip, a tool call, an approval, and session/load of a
    // stored session id.
    liveSessions: true,
    // FALSE means "no models.yml MANAGEMENT editor", which is what this flag
    // gates — not "no models". The adapter's own model selection (a `model`
    // config option on session/new) IS wired: acp-session captures it, reports
    // it through get_state as `availableModels`, and switches it with
    // set_model. That is deliberately data rather than a flag, because whether
    // an agent offers models depends on the account the session opened with,
    // which nothing static here could know.
    models: false,
    // Claude Code has skills of its own; the Cody surface is built against
    // omp's discovery and would list none of them.
    skills: false,
    plugins: false,
    // ACP reports mcpCapabilities {http, sse} and Cody DOES attach its display
    // bridge at session/new — but this flag gates the MCP *editor*, which
    // writes omp's config file. Not wired.
    mcp: false,
    nativeSettings: false,
    configEditor: false,
    // The engine's OWN self-update route and session restart, both omp-shaped.
    // Cody installing Claude Code through npm is a separate thing, driven by
    // installSpec.
    updates: false,
    // omp-only composer affordances: steering, follow-up queue, compaction,
    // thinking levels, forking. The adapter carries analogues of several
    // (setSessionMode, session/fork) but none are wired to Cody's commands.
    chatExtras: false,
    fastMode: false,
    advisor: false,
    // ACP has no subagent vocabulary, so the roster would stay empty.
    subagents: false,
    // Claude Code's CLAUDE.md is project context the user writes, not memory
    // the agent maintains and can hand back.
    memory: false,
  },
  resolveBinary: () => resolveEngineBin("claude-agent-acp", "CLAUDE"),
  getVersion: () => getEngineVersion("claude-agent-acp", "CLAUDE"),
  getAgentDir: () => path.join(homedir(), ".claude"),
  getSessionsDir: () => path.join(homedir(), ".claude", "projects"),
  createSession: (options) => createClaudeSession(options),
};
