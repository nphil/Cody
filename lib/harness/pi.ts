import { homedir } from "os";
import path from "path";
import { getEngineVersion, resolveEngineBin } from "./engine-bin";
import { readPiSettings, writePiSettings } from "./pi-settings";
import type { HarnessAdapter } from "./types";

/**
 * Pi (pi.dev) as a Cody engine (experimental). Pi is omp's ancestor: it
 * speaks the same NDJSON RPC dialect (`pi --mode rpc`) and writes the same
 * session .jsonl format, so it rides rpc-manager's live-chat pipeline rather
 * than the turn-based seam. The differences are stated in `rpcUi`:
 *
 * - No `{type:"ready"}` frame at startup — readiness is the response to the
 *   first command (pi buffers stdin until its reader attaches).
 * - Resume-by-file is `--session <path>` (pi's own `--resume` is a boolean
 *   interactive picker); there is no `--cwd`, `--advisor`, host-tool or
 *   subagent surface.
 * - Unknown RPC commands are answered with an ID-LESS error response that can
 *   never settle the pending request, so the command vocabulary below is a
 *   hard allowlist — anything else is rejected Cody-side as "unsupported".
 *
 * Every other omp surface (models registry, plugins, MCP config, updates) is
 * capability-gated off. Skills and the schema-driven settings panel are not:
 * pi has real discovery roots for the first and documents every setting it
 * accepts for the second (see ./pi-settings.ts).
 */

/** pi 0.73's RPC command cases (dist/modes/rpc/rpc-mode.js), plus
 * extension_ui_response which its input loop handles before the switch. */
const PI_RPC_COMMANDS: ReadonlySet<string> = new Set([
  "abort",
  "abort_bash",
  "abort_retry",
  "bash",
  "clone",
  "compact",
  "cycle_model",
  "cycle_thinking_level",
  "export_html",
  "extension_ui_response",
  "follow_up",
  "fork",
  "get_available_models",
  "get_commands",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_messages",
  "get_session_stats",
  "get_state",
  "new_session",
  "prompt",
  "set_auto_compaction",
  "set_auto_retry",
  "set_follow_up_mode",
  "set_model",
  "set_session_name",
  "set_steering_mode",
  "set_thinking_level",
  "steer",
  "switch_session",
]);

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

export const piHarness: HarnessAdapter = {
  id: "pi",
  displayName: "Pi",
  shortName: "Pi",
  binaryName: "pi",
  tagline: "The pi.dev coding agent — omp's ancestor, driven over its native RPC mode.",
  experimental: true,
  installSpec: "@mariozechner/pi-coding-agent@latest",
  // Exercised through the shared rpc-dialect transport (engine bring-up runs
  // it on every image build) — the version those runs last audited.
  verifiedVersion: "0.73.1",
  authHint:
    "Run `pi` once in a Cody terminal to configure a provider, or set provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) on the container.",
  capabilities: {
    liveSessions: true,
    // The models.yml/providers editor is omp's own config pipeline; pi has no
    // MCP, no plugin CLI Cody can drive, and updates ride the engine card's
    // npm reinstall instead of a self-updater.
    models: false,
    // pi discovers skills from .pi/skills, .agents/skills (walk-up + home)
    // and <agent dir>/skills, and honors disable-model-invocation — the
    // skills tab (list/toggle/install-to-.agents) is fully honest for it.
    skills: true,
    plugins: false,
    mcp: false,
    // The schema-driven settings panel, derived from the settings tables in
    // the INSTALLED pi package's own docs/settings.md — so pi's global
    // settings.json is editable here and a setting pi adds upstream appears
    // when the user updates pi, with no Cody release (lib/harness/pi-settings.ts).
    nativeSettings: true,
    // Still false: this flag is Cody's HAND-BUILT editors for omp's
    // config.yml, which pi neither has nor reads.
    configEditor: false,
    updates: false,
    // The full RPC-dialect chat surface: steer/follow-up, set_model,
    // thinking levels, fork, compact — plus the file-level history/branch
    // surfaces, which work because pi writes real v3 transcripts.
    chatExtras: true,
    // omp-only protocol extras pi's dialect lacks.
    fastMode: false,
    advisor: false,
    subagents: false,
    memory: false,
  },
  resolveBinary: () => resolveEngineBin("pi", "PI"),
  getVersion: () => getEngineVersion("pi", "PI"),
  getAgentDir: () => piAgentDir(),
  settings: {
    // Resolved per call rather than captured: pi installed (or updated) after
    // the server booted must be picked up without a restart.
    readSchema: () => readPiSettings(resolveEngineBin("pi", "PI"), piAgentDir()),
    write: (patch) => writePiSettings(resolveEngineBin("pi", "PI"), piAgentDir(), patch),
  },
  getSessionsDir: () => process.env.PI_CODING_AGENT_SESSION_DIR || path.join(piAgentDir(), "sessions"),
  rpcUi: {
    mode: "rpc",
    resumeFlag: "--session",
    supportsCwdFlag: false,
    supportsAdvisor: false,
    hostTools: false,
    subagentEvents: false,
    readiness: "first-response",
    commands: PI_RPC_COMMANDS,
  },
};
