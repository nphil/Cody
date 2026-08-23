import { homedir } from "os";
import path from "path";
import { AcpEngineSession, type AcpMcpServer } from "./acp-session";
import { displayMcpAcpServer } from "../display/engine-tools";
import { getEngineVersion, resolveEngineBin } from "./engine-bin";
import type { EngineSession, EngineSessionOptions, HarnessAdapter } from "./types";

/**
 * OpenAI Codex as a Cody engine, driven over the Agent Client Protocol.
 *
 * The engine Cody installs is `@agentclientprotocol/codex-acp`, the official
 * ACP adapter from the same org that publishes the SDK Cody already depends
 * on. The `codex` CLI itself does NOT speak ACP — there is no `acp`
 * subcommand, no acp crate, nothing in its changelog — so the adapter is the
 * only route, and it drives `codex app-server` over JSON-RPC rather than
 * `codex exec`. Bare invocation IS ACP stdio mode; there is no subcommand.
 *
 * What that buys, versus the `codex exec --json` process-per-turn path it
 * replaces (the process-per-turn transport, since deleted):
 *
 * - One long-lived session instead of a process per turn, so the thread stays
 *   warm and `session/load` resumes it.
 * - A real approval channel. `codex exec` is non-interactive and ran with
 *   edits auto-accepted because it had nowhere to ask; over ACP the agent
 *   raises `session/request_permission` and the turn genuinely waits for a
 *   human (lib/harness/acp-session.ts).
 * - The token accounting Cody used to hand-roll. codex reports an
 *   `input_tokens` that already contains its cached count; the adapter
 *   performs that same subtraction itself before the figures leave it.
 *
 * The ACP `sessionId` IS the Codex thread id — the value `codex exec resume`
 * takes and the one that names the rollout file under
 * `~/.codex/sessions/YYYY/MM/DD/` — so every `engineSessionId` Cody already
 * stored keeps working across this change with no migration.
 *
 * Credentials are Codex's own, in `$CODEX_HOME` (default `~/.codex`): a
 * `codex login` done in a Cody terminal, or an API key in the environment
 * (see `codexEngineEnv`). Codex can also run against local models (`--oss`,
 * model_provider overrides in its config.toml), which keeps the
 * local-inference door open on this engine.
 */

/** Codex's own state directory; `CODEX_HOME` overrides it upstream. */
function codexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override || path.join(homedir(), ".codex");
}

/**
 * Everything the adapter needs pointing at, in one place — merged into the
 * live session, the post-install health probe and a Cody terminal alike, so
 * the Codex that gets verified is the Codex that runs.
 *
 * **CODEX_PATH** — which `codex` the adapter drives. Cody installs the CLI as
 * its own package beside the adapter (`installAlso`) and installs the adapter
 * without the ~296 MB copy it would otherwise bundle (`skipNativeOptional`),
 * so this is what joins the two halves. It also puts `codex` back on the
 * tools prefix's PATH, which is what `codex login` and an SSH session expect
 * to find. Resolved at call time, never cached: an engine installed after the
 * server booted must be found without a restart.
 *
 * **DEFAULT_AUTH_REQUEST** — the adapter refuses to open a session until
 * Codex is authenticated, and it will not reach for an API key on its own:
 * with `OPENAI_API_KEY` exported and nothing else, `session/new` answers
 * `-32000 Authentication required` and the chat never starts. Cody has always
 * documented that variable as a way to run this engine, so the request that
 * consumes it is declared here and the adapter performs the login itself.
 * Only when a key is actually present: declaring it unconditionally would
 * replace the honest "Authentication required" with an internal error about
 * an unset variable, and a `codex login` (ChatGPT) session needs no key at
 * all. The adapter checks whether auth is required before it uses this, so a
 * signed-in Codex is never re-authenticated behind the user's back.
 *
 * Nothing here overrules a value the operator already exported — that is a
 * deliberate choice, and `CODEX_PATH` in particular is Codex's own documented
 * override.
 */
function codexEngineEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!process.env.CODEX_PATH?.trim()) {
    // A distinct stem from the adapter's `CODY_CODEX_BIN`: there are two
    // binaries now, and an override for one must not silently answer for the
    // other.
    const cli = resolveEngineBin("codex", "CODEX_CLI");
    if (cli) env.CODEX_PATH = cli;
  }
  const key = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (key) env.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: "api-key" });
  return env;
}

/**
 * One argv, two jobs: it proves the CLI half of the install actually runs
 * (`healthArgs`) and it prints the version Cody reports as Codex's
 * (`engineCli.getVersion`). Shared so the number that gets VERIFIED is the
 * number that gets SHOWN.
 *
 * It needs `codexEngineEnv()`: with the adapter's own platform-native copy
 * deliberately not installed, only `CODEX_PATH` leads to a Codex to run.
 */
const CODEX_CLI_VERSION_ARGS = ["cli", "-V"] as const;

/**
 * Cody's host tools (open_preview, preview_screenshot, read_app_logs) as an
 * MCP server the agent connects for this session — the ACP replacement for the
 * `-c mcp_servers.…` TOML overrides the old per-turn argv carried.
 *
 * Guarded, because minting the session's capability token needs the running
 * server's internal origin and throws without it. That is not hypothetical:
 * `scripts/engine-bringup.mjs` drives this same adapter with no server behind
 * it, and an exception here would abort `session/new` — an engine reported
 * dead because an optional convenience was unavailable. No bridge is a missing
 * Preview button; a throw is a chat that will not open.
 */
function displayBridge(sessionId: string): AcpMcpServer[] {
  try {
    return [displayMcpAcpServer(sessionId)];
  } catch {
    return [];
  }
}

export function createCodexSession(options: EngineSessionOptions): EngineSession {
  const binaryPath = resolveEngineBin("codex-acp", "CODEX");
  if (!binaryPath) {
    throw new Error("codex-acp binary not found. Install Codex from the engine picker, or set CODY_CODEX_BIN.");
  }
  return new AcpEngineSession(
    {
      id: "codex",
      name: "Codex",
      binaryPath,
      // Bare argv is ACP stdio mode. `login` and `cli` are the adapter's only
      // subcommands, and both would take it out of server mode.
      args: [],
      env: codexEngineEnv(),
      // The adapter writes these into the session's own Codex config, so the
      // host tools survive the move off the per-turn argv.
      mcpServers: displayBridge,
      setupHint: "Sign in by running `codex login` in a Cody terminal, or set OPENAI_API_KEY on the container.",
    },
    options,
  );
}

export const codexHarness: HarnessAdapter = {
  id: "codex",
  displayName: "Codex",
  shortName: "Codex",
  // The adapter, not `codex`: it is what Cody installs, what the picker probes
  // for, and what a Cody terminal launches (through `cliArgs`).
  binaryName: "codex-acp",
  tagline: "OpenAI's coding agent, over the Agent Client Protocol.",
  experimental: true,
  installSpec: "@agentclientprotocol/codex-acp@latest",
  // The adapter bundles `@openai/codex` as a hard dependency, and that package
  // carries the ~296 MB platform-native Codex binary. Installed naively it is
  // a second copy of a CLI Cody already manages: measured, the adapter alone
  // is 311 MB, and adding `@openai/codex` beside it comes to 619 MB, because
  // npm does not share dependencies between two globally-installed packages.
  //
  // So the two halves are installed separately and joined by `CODEX_PATH`
  // (`engineEnv` below): the adapter without its platform-gated optionals
  // (311 MB → 16 MB), plus the Codex CLI as its own package Cody can version,
  // update and revert like any other engine — 324 MB in total, and a real
  // `codex` on the tools prefix's PATH for `codex login` and SSH sessions.
  installAlso: ["@openai/codex@latest"],
  // Which of those two packages is which, so the card can label the numbers
  // instead of showing the adapter's and calling it Codex's — and so the
  // update check asks npm about BOTH. Without the second registry name a CLI
  // left behind at 0.148.0 reads as "up to date" while 0.149.0 is published,
  // because the adapter it sits under was already current.
  engineCli: {
    adapterLabel: "Codex ACP adapter",
    label: "Codex CLI",
    packageName: "@openai/codex",
    getVersion: () => getEngineVersion("codex-acp", "CODEX", CODEX_CLI_VERSION_ARGS, codexEngineEnv()),
  },
  skipNativeOptional: true,
  // `codex login` and not the adapter's own `codex-acp login`: `installAlso`
  // puts the real CLI on the tools prefix PATH, both write the same
  // `$CODEX_HOME/auth.json`, and this is the command Codex's own docs name.
  authHint:
    "Sign in by running `codex login` once in a Cody terminal, or set OPENAI_API_KEY on the container.",
  // `codex-acp cli <args>` forwards to the real Codex CLI — the same binary
  // the ACP server drives, honouring the same `CODEX_PATH`. A Cody terminal
  // (and the SSH engine-first login) opens THAT rather than the bare binary,
  // which would be a JSON-RPC server reading the user's keystrokes.
  cliArgs: ["cli"],
  engineEnv: codexEngineEnv,
  // Bare `--version` is the right VERSION probe: it prints the adapter's own
  // version, which is the package `installSpec` names and therefore the one
  // the update check compares against the registry.
  //
  // It is the wrong HEALTH probe, for exactly the reason Hermes taught. The
  // adapter answers `--version` from its bundle before it ever looks at Codex,
  // so it reports a healthy 1.6.2 with the platform-native `@openai/codex-*`
  // dependency missing — the failure npm produces silently when it cannot
  // resolve an optional dependency — and every chat turn then dies. Verified:
  // with that package removed, `codex-acp --version` still exits 0, while the
  // health probe below exits 1 with "Missing optional dependency
  // @openai/codex-linux-x64", which is the sentence the admin needs.
  //
  // It is the same check that catches the two halves above coming apart,
  // which is the failure this install shape could otherwise hide.
  //
  // `cli -V`, not `cli --version`: the adapter scans the WHOLE argv for
  // `--version` and short-circuits, so `cli --version` reports the adapter
  // again and proves nothing. `-V` reaches Codex and prints its version.
  healthArgs: CODEX_CLI_VERSION_ARGS,
  // The ADAPTER's major, which is the package installSpec names — not the
  // CLI's 0.x, which moves on its own schedule and is a different package
  // entirely. 1.x is what Cody's ACP client has been exercised against;
  // `engineCli.adapterLabel` is what the notice names, so a 2.0 adapter reads
  // as a claim about the adapter and nothing else.
  verifiedMajor: 1,
  capabilities: {
    // Verified end to end against the real adapter: initialize, session/new,
    // a prompt round trip, and session/load of a stored thread id.
    liveSessions: true,
    // FALSE means "no models.yml MANAGEMENT editor", which is what this flag
    // gates — not "no models". The adapter's own model config option IS wired
    // through acp-session (get_state's `availableModels` + set_model), as
    // per-session data rather than a static flag: what Codex offers depends
    // on the account the session opened with.
    models: false,
    // Codex has skills of its own (~/.codex/skills); the Cody surface is built
    // against omp's discovery and would list none of them.
    skills: false,
    plugins: false,
    // ACP reports mcpCapabilities {http:true, sse:false, acp:false} and
    // session/new takes MCP servers, but Cody's MCP editor writes omp's config
    // file. Not wired.
    mcp: false,
    nativeSettings: false,
    // The engine's OWN self-update route and session restart, both omp-shaped.
    // Cody installing Codex is a different thing, driven by installSpec.
    updates: false,
    // omp-only composer affordances: steering, follow-up queue, compaction,
    // thinking levels, forking. The adapter advertises steering and the ACP
    // session capabilities {resume, list, close, delete} — but NOT fork — and
    // none of it is wired to Cody's controls yet.
    chatExtras: false,
    fastMode: false,
    advisor: false,
    // ACP has no subagent vocabulary, so the roster would stay empty.
    subagents: false,
    // Codex keeps memories, and exposes no way for Cody to read them back.
    memory: false,
  },
  resolveBinary: () => resolveEngineBin("codex-acp", "CODEX"),
  getVersion: () => getEngineVersion("codex-acp", "CODEX"),
  getAgentDir: () => codexHome(),
  // Unchanged by the move to ACP: the adapter's sessions are Codex threads,
  // written to the same rollout files under the same directory.
  getSessionsDir: () => path.join(codexHome(), "sessions"),
  createSession: (options) => createCodexSession(options),
};
