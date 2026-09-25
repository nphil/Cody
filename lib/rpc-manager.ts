import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getSessionOwner, renameSessionOwner, setSessionOwner } from "./auth/session-owners";
import { aliasDisplaySession, publishDisplayRequest } from "./display/bus";
import { startSharedBrowser } from "./display/shared-browser";
import { isLoopbackHost } from "./display/ladder";
import { ForgeError } from "./forge/client";
import { FORGE_HOST_TOOL, runForgeTool } from "./forge/tool";
import { getHarness } from "./harness";
import type { EngineSession, EngineSessionOptions, HarnessAdapter, RpcUiSpawn } from "./harness/types";
import { validateAgentImages } from "./image-attachments";
import { APP_LOG_SHADOW_NOTE, DEFAULT_LIMIT, MAX_LIMIT, appLogNotice, formatAppLogDigest, markAppLogsRead, parseSince, readAppLogs } from "./logs/ring";
import { APP_LOG_LEVELS, type AppLogQuery } from "./logs/types";
import { invalidateModelsCache } from "./models-cache";
import { MAX_RPC_FRAME_BYTES } from "./omp/rpc-frame";
import { RpcCommandError, RpcCommandTimeoutError, RpcProcess, type RpcFrame, type RpcProcessLaunch } from "./omp/rpc-process";
import { readNativeSettings } from "./omp/settings-config";
import { getAgentDir, getSidebarChatsDir, getSessionDirNameForCwd } from "./omp/paths";
import { captureLoopbackScreenshot, ScreenshotError } from "./preview-screenshot";
import { ProjectTodoError, type TodoDocument, formatTodoForAgent, mutateProjectTodo, parseTodoAgentAction, readProjectTodo, todoAgentActionOperation } from "./project-todo";
import { resolveProject } from "./worktree";
import {
  cacheSessionPath,
  invalidateSessionEntriesCache,
  invalidateSessionListCache,
  invalidateSessionListMeta,
} from "./session-reader";
import { assistantReplyText, replyAsksUser } from "./reply-question";
import { PlanKeeper } from "./plan-keeper/keeper";
import { readPlanOverlay } from "./plan-keeper/overlay";
import { materializeLocalModelProfile, resolveLocalModelPromptProfile, type LocalModelProfileLaunch, type ModelProfileTarget, type ResolvedLocalModelProfile } from "./local-model-profile-runtime";
import { copySessionLocalRouting, materializeLocalRoutingOverlay, readLocalRoutingIntent, renameSessionLocalRouting, validateLocalRoutingModelSelection } from "./local-model-routing";
import { copySessionPreset, renameSessionPreset, sessionPresetOverlay } from "./model-presets/overlay";
import { selectPromptProfileId, type PromptProfileId } from "./local-model-profile";
import { PRESET_FULL } from "./tool-presets";
import { isRecord } from "./type-guards";
import { SIDEBAR_CONTEXT_TOOLS } from "./sidebar-context-tools";
import { SESSION_AWARENESS_TOOLS, type SessionLivePhase, type SessionToolContext } from "./session-tools";
import { findUserById, hasAnyUser, type UserRecord } from "./auth/users";
import { DEVICE_OPERATION_TOOLS } from "./devices/operation-tools";
import { DEVICE_TOOLS } from "./devices/tools";
import { aliasDeviceBridge, getDeviceBridge, peekDeviceBridge } from "./devices/bus";
import type {
  BashResultInfo,
  HostToolDefinition,
  OmpModel,
  RpcAvailableSlashCommand,
  RpcSessionState,
  SessionStatsInfo,
  WebSessionState,
} from "./pi-types";
import type { ExtensionWidgetItem } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

interface CompactionResultLike {
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

const IDLE_DESTROY_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 120_000;

/**
 * System prompt for sidebar chat sessions.
 *
 * The sidebar preloads NO project context — measured, a sidebar "hi" was
 * sending 133,559 tokens (43,438 of verbatim AGENTS.md, 89,303 of user-scope
 * MCP tool schemas) before this. It now starts near 144 and reads what it
 * needs through its bounded context tools. So the prompt's job is to tell the
 * model it has no context YET and must ask: a model that assumes it was given
 * the project answers from training-set guesses about a codebase it has never
 * seen, which is worse than saying it cannot help.
 *
 * Written for a 4B local model as much as a hosted one: short sentences,
 * explicit tool names, an explicit instruction to page.
 */
const SIDEBAR_CHAT_SYSTEM_PROMPT = [
  "You are a concise assistant in a side panel of Cody, a coding workspace. Answer in Markdown.",
  "You start with NO project context. Do not guess about this workspace, its files or its sessions from memory.",
  "Look things up on demand with your tools: list_workspace_files, read_workspace_file, read_project_context (this workspace's AGENTS.md/CLAUDE.md), list_sessions and read_session (a main chat's transcript).",
  "Results are truncated to fit your context. When one says more remains, call the same tool again with the offset it gives you, and read only as much as the question needs.",
  "You cannot edit files, run commands or browse. For those, point the user to the main chat.",
].join(" ");

/** The config overlay every sidebar session loads: no memory recall, no
 * autolearn, no advisor, no prewalk — the same four switches the one-shot
 * runner uses (lib/model-plan/one-shot.ts), for the same reason: with the
 * operator's ambient config a single turn pulled 14k tokens of injected
 * context. `mcp.enableProjectConfig` joins them so a workspace's own
 * mcp.json cannot add tools either. Written once into the sidebar-chats dir;
 * rewritten if its content ever changes. */
const SIDEBAR_OVERLAY_YAML = "memory.backend: off\nautolearn.enabled: false\nadvisor.enabled: false\nprewalk.enabled: false\nmcp.enableProjectConfig: false\n";
function sidebarOverlayPath(): string {
  const dir = getSidebarChatsDir();
  const file = path.join(dir, "overlay.yml");
  let current: string | null = null;
  try { current = readFileSync(file, "utf8"); } catch { /* absent */ }
  if (current !== SIDEBAR_OVERLAY_YAML) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, SIDEBAR_OVERLAY_YAML, { mode: 0o600 });
  }
  return file;
}

/** The empty directory every sidebar child runs from, so omp's context-file
 * discovery finds nothing to inject. `--no-rules` does NOT cover
 * `AGENTS.md`/`CLAUDE.md`, and omp has no flag that does; starting somewhere
 * with none is the lever that works. Kept inside the sidebar-chats dir so it
 * is obviously Cody-owned state and never a user workspace. */
export function sidebarBareCwd(): string {
  const dir = path.join(getSidebarChatsDir(), "cwd");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A sidebar-only agent dir, so the sidebar sees no user-scope MCP servers.
 *
 * omp reads them from `<agent dir>/mcp.json` and has NO flag or setting to
 * suppress it — `--no-tools`/`--no-extensions` cover its own builtins and
 * extension discovery, not this. Measured on the owner's install that file
 * contributed 111 tool schemas, 89,303 tokens, to every sidebar turn. So the
 * sidebar child runs against its own agent dir whose `mcp.json` is explicitly
 * empty, with what it genuinely needs SYMLINKED to the real ones:
 *
 *   agent.db   — credentials; omp already opens it from concurrent processes,
 *                and SQLite puts `-wal`/`-shm` beside the symlink TARGET, so
 *                the live database is untouched (verified).
 *   models.yml — providers and custom endpoints, including the local
 *                llama-swap models the sidebar is meant to run on.
 *   config.yml — model roles and provider order; the overlay applies on top.
 *   blobs      — externalized image payloads, so attachments still resolve.
 *
 * A target that does not exist yet is skipped rather than linked dangling: a
 * fresh install has no agent.db until its first credential.
 */
const SIDEBAR_AGENT_LINKS = ["agent.db", "models.yml", "models.yaml", "config.yml", "config.yaml", "blobs"] as const;
const SIDEBAR_EMPTY_MCP = '{"mcpServers":{}}\n';

export function sidebarAgentDir(): string {
  const dir = path.join(getSidebarChatsDir(), "agent");
  mkdirSync(dir, { recursive: true });
  const mcpPath = path.join(dir, "mcp.json");
  let currentMcp: string | null = null;
  try { currentMcp = readFileSync(mcpPath, "utf8"); } catch { /* absent */ }
  if (currentMcp !== SIDEBAR_EMPTY_MCP) writeFileSync(mcpPath, SIDEBAR_EMPTY_MCP, { mode: 0o600 });
  const real = getAgentDir();
  for (const name of SIDEBAR_AGENT_LINKS) {
    const target = path.join(real, name);
    const link = path.join(dir, name);
    if (!existsSync(target)) continue;
    try {
      if (readlinkSync(link) === target) continue;
      rmSync(link);
    } catch { /* not a link, or absent */ }
    try { symlinkSync(target, link); } catch { /* raced with another spawn */ }
  }
  return dir;
}

/**
 * Host tools implemented by the Cody SERVER rather than the browser: they
 * ride along every set_host_tools registration and settle in handleFrame with
 * no attached UI required. preview_screenshot renders a loopback URL in a
 * headless Chromium where the dev server actually runs, so the model can SEE
 * its work — including with every browser tab closed. open_preview publishes
 * a display request on the session bus (lib/display/bus.ts), auto-opening
 * Cody's Preview panel over SSE for any watching browser. read_app_logs hands
 * back the previewed app's own console and failed requests (lib/logs), so a
 * dev server throwing in the browser is something the model can read instead
 * of something only the user ever sees. cody_todo reads and updates the project-owned
 * manual list, deliberately separate from an engine execution plan. forge
 * (lib/forge/tool.ts) is the agent's access to the code host — GitHub or a
 * self-hosted Gitea — settled here because the tokens live in this process and
 * must never reach an engine child's environment.
 */
const SERVER_HOST_TOOLS: HostToolDefinition[] = [{
  name: "preview_screenshot",
  description: "Capture a screenshot of a web page served by a local dev server and see the rendered result. Use it after making UI changes to visually verify your work. Only loopback URLs (http://localhost:PORT or http://127.0.0.1:PORT) can be captured.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Loopback URL to capture, e.g. http://localhost:3000" },
      width: { type: "number", description: "Viewport width in px (default 1280)" },
      height: { type: "number", description: "Viewport height in px (default 800)" },
    },
    required: ["url"],
  },
}, {
  name: "open_preview",
  description: "Open or refresh a running local web UI in Cody's Preview panel. Call after starting or restarting a dev server and whenever its URL changes. The URL must use localhost or 127.0.0.1.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Container-local http(s) URL, for example http://127.0.0.1:3000" },
      title: { type: "string", description: "Optional short preview title." },
      mode: { type: "string", enum: ["auto", "stream", "native"], description: "Prefer auto: Cody picks the highest-fidelity preview that actually works. Pass stream or native only when one specifically is required." },
    },
    required: ["url"],
  },
}, {
  name: "shared_browser",
  description:
    "Open a URL in a browser the user WATCHES LIVE in Cody's Preview panel, and get back a DevTools endpoint to drive it with. Use this instead of launching your own headless browser whenever you verify a web UI: the user sees every click and navigation as it happens, and can take the mouse themselves mid-run. Attach your browser automation to the returned endpoint as a CDP url and operate the existing tab. Loopback URLs only.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Container-local http(s) URL to open, for example http://127.0.0.1:3000" },
      title: { type: "string", description: "Optional short preview title." },
    },
    required: ["url"],
  },
}, {
  name: "read_app_logs",
  description: `Read the previewed app's browser console and failed network requests: uncaught exceptions, console.error/warn output, 4xx/5xx responses and refused connections. Returns a deduped digest, oldest first — identical repeated lines collapse into ONE entry with a count, so a render loop reads as one line rather than thousands. Call it after changing code and reloading the preview, and whenever another tool result reports new app errors. ${APP_LOG_SHADOW_NOTE}`,
  parameters: {
    type: "object",
    properties: {
      level: { type: "string", enum: [...APP_LOG_LEVELS], description: "Minimum severity: error, warning, info or debug. Omit for everything captured." },
      since: { type: "string", description: "Only entries last seen since then: a relative age like 90s, 5m or 2h, or an ISO timestamp." },
      grep: { type: "string", description: "Case-insensitive regular expression the message or URL must match." },
      limit: { type: "number", description: `Newest N entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
    },
  },
}, {
  name: "cody_todo",
  description: "The user's own project to-do list (.cody/todo.json). Separate from your task plan: it holds what the user asked to remember. Use list before working through it, complete an item only when its work is actually done, reopen if you completed it by mistake, note to leave a short note on an item. The user sees every change with your name in the list's history.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "complete", "reopen", "note"], description: "To-do action to perform." },
      id: { type: "string", description: "To-do item id for complete, reopen, or note." },
      title: { type: "string", description: "Title for a new to-do item." },
      notes: { type: "string", description: "Optional notes for a new item or note text." },
      color: { type: "string", enum: ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"], description: "Optional color for a new item." },
    },
    required: ["action"],
  },
},
// Cross-session awareness. A main chat is regularly asked what ANOTHER
// session is doing, and Cody is the only party that can answer: an engine's
// own agent hub sees nothing but its own subagents. Shared verbatim with the
// sidebar (lib/session-tools.ts) so both describe them identically.
...SESSION_AWARENESS_TOOLS.map(({ handler: _handler, ...tool }) => tool),
FORGE_HOST_TOOL];
/** Every tool the SERVER settles itself, so `handleFrame` routes its calls
 * here instead of to a browser. The sidebar's context tools are server-side
 * for the same reason the rest are: they read the filesystem and the session
 * store, which no browser can do. */
const SERVER_HOST_TOOL_NAMES = new Set([
  ...SERVER_HOST_TOOLS.map((tool) => tool.name),
  ...SIDEBAR_CONTEXT_TOOLS.map((tool) => tool.name),
  ...DEVICE_TOOLS.map((tool) => tool.name),
  ...DEVICE_OPERATION_TOOLS.map((tool) => tool.name),
]);
/** One session-tool result's char budget for a MAIN chat. The sidebar's own
 * budget assumes the smallest supported window (6 KB); a main session runs on
 * whatever model the user picked, where paging a transcript four times to
 * answer one question is its own kind of waste. Still bounded: a transcript
 * is unbounded and a tool result has to fit one RPC frame. */
const MAIN_SESSION_RESULT_CHARS = 24_000;
const MCP_LIST_TIMEOUT_MS = 15_000;
/** Cap on the *acknowledgement* of a prompt frame — not on model execution.
 * omp acks a prompt as soon as it accepts it and the run then reports through
 * events (agent_start/agent_end), so an ack that never arrives means the child
 * is wedged: without this the API request (and the UI spinner behind it) would
 * stay pending forever. Generous enough to cover slow local startup work the
 * child does before acking. */
const PROMPT_ACK_TIMEOUT_MS = 30_000;

const RESTARTING_MESSAGE = "This session is restarting. Retry in a moment.";

/** Every rpc-dialect engine reaches the `!!` refusal, so the sentence names the
 * one that actually raised it — a pi user told "omp cannot…" would go looking
 * for a setting in an engine they are not running. */
const bashExcludeMessage = (engine: string) =>
  `${engine} cannot run a shell command with its output excluded from the model context (\`!!\`): the RPC bash command has no exclusion option, so the output would silently enter the context anyway. Run it with a single \`!\` to share the output with the model, or use a terminal outside Cody.`;

/**
 * Failure raised by Cody itself (not by omp) carrying a stable snake_case
 * code. API routes forward `{ error, code }` so the client dictionary can
 * localize it via `errors.<code>` while unknown codes fall back to the text.
 */
export class WebRpcError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "WebRpcError";
    this.code = code;
  }
}

// Extension UI methods that stay pending until the client answers (replayed to
// newly-attached SSE listeners so dialogs survive reconnects).
const PENDING_UI_METHODS = new Set(["select", "confirm", "input", "editor", "open_url"]);

// Commands forwarded to omp verbatim (request shape already matches rpc-types).
const PASSTHROUGH_COMMANDS = new Set([
  "abort",
  "abort_and_prompt",
  "set_thinking_level",
  "cycle_thinking_level",
  "cycle_model",
  "get_available_models",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "abort_bash",
  "set_todos",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_interrupt_mode",
  "get_branch_messages",
  "get_messages",
  "get_messages_page",
  "export_html",
  "handoff",
  "get_subagents",
  "get_subagent_messages",
  "set_subagent_subscription",
  "get_login_providers",
  "login",
]);

// Commands the wrapper settles locally (or forwards conditionally) — exempt
// from the engine RPC-vocabulary gate below, because rejecting them would
// break wrapper-level features that need no engine support.
const LOCAL_WRAPPER_COMMANDS = new Set([
  "reload",
  "set_host_tools",
  "set_host_uri_schemes",
  "host_tool_result",
  "host_uri_result",
]);

// pi-web commands with no omp RPC equivalent. The UI tolerates these failing.
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  navigate_tree: "Branch navigation is not supported over the omp RPC protocol",
  clear_queue: "Recalling queued messages is not supported over the omp RPC protocol",
  get_tools: "Per-session tool listing is not supported over the omp RPC protocol",
  set_tools: "Changing tools on a running session is not supported over the omp RPC protocol; tool presets apply to new sessions",
  extension_ui_input: "Extension custom UI is not supported over the omp RPC protocol",
};

// omp aliases "find"->"glob" and has no "ls" tool; the web UI presets still use
// the pi names (lib/tool-presets.ts), so translate before building --tools.
const TOOL_NAME_ALIASES: Record<string, string> = { find: "glob", search: "grep" };
const DROPPED_TOOL_NAMES = new Set(["ls"]);

/**
 * Keep a `host_tool_result` inside what the transport can actually deliver.
 *
 * omp's stdin reader parses one line as one whole command and cannot reassemble
 * chunks (see `lib/omp/rpc-frame.ts`), so `RpcProcess.sendFrame` DROPS a frame
 * over `MAX_RPC_FRAME_BYTES` — and a dropped tool result is a tool call omp
 * waits on forever, i.e. an agent turn hung with no explanation. An oversized
 * result is therefore replaced by a small error result carrying the SAME id, so
 * the call completes with an honest failure the model can act on.
 */
export function guardHostToolResultFrame(
  frame: RpcFrame,
  limit: number = MAX_RPC_FRAME_BYTES,
): { frame: RpcFrame; oversizedBytes: number | null } {
  // +1 for the newline the encoder appends — the same arithmetic the transport
  // measures the line with.
  const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
  if (bytes <= limit) return { frame, oversizedBytes: null };
  return {
    frame: {
      type: frame.type,
      id: typeof frame.id === "string" ? frame.id : "",
      isError: true,
      result: {
        content: [{
          type: "text",
          text: `This tool result could not be returned: it serializes to ${bytes} bytes, over the ${limit}-byte limit `
            + "for a single message to the engine, so Cody replaced it with this error rather than dropping it. "
            + "Retry asking for less at once — a smaller screenshot viewport, a narrower log query, or fewer results.",
        }],
      },
    },
    oversizedBytes: bytes,
  };
}

/** Translate pi-web preset tool names into omp builtin tool names. */
export function mapPresetToolNames(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const raw of toolNames) {
    const lower = raw.toLowerCase();
    if (DROPPED_TOOL_NAMES.has(lower)) continue;
    const mapped = TOOL_NAME_ALIASES[lower] ?? lower;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const FULL_PRESET_KEY = [...PRESET_FULL].map((n) => n.toLowerCase()).sort().join(",");

/** The CLI-surface facts arg building needs; omp's defaults keep the historic
 * three-argument call sites (and their tests) intact. */
type RpcSpawnFlags = Pick<RpcUiSpawn, "resumeFlag" | "supportsAdvisor">;
const OMP_SPAWN_FLAGS: RpcSpawnFlags = { resumeFlag: "--resume", supportsAdvisor: true };

/** Session CLI args for spawning an rpc-dialect engine (after the mode/cwd base). */
export function buildSessionSpawnArgs(
  sessionFile: string,
  toolNames?: string[],
  advisor = false,
  kind?: "sidebar",
  sidebarSessionDir?: string,
  flags: RpcSpawnFlags = OMP_SPAWN_FLAGS,
): string[] {
  const args: string[] = [];
  if (sessionFile) {
    // An absolute path (or anything containing "/") resolves deterministically:
    // omp's createSessionManager opens it directly via SessionManager.open
    // without any interactive resume/fork prompts (main.ts resume handling).
    // pi's --session flag has the same SessionManager.open semantics.
    args.push(flags.resumeFlag, sessionFile);
  } else if (toolNames !== undefined && kind !== "sidebar") {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey === FULL_PRESET_KEY) {
      // "Full" means everything: leave the engine's complete default toolset
      // intact rather than restricting it to the (much smaller) preset list.
    } else {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (flags.supportsAdvisor && advisor && !sessionFile) args.push("--advisor");
  
  // Sidebar chat: a conversation, not an agent. No tools, skills, extensions,
  // rules or prewalk, a short fixed system prompt, and its own session dir
  // outside the normal tree. The overlay switches off memory recall,
  // autolearn and the advisor so the request carries nothing but the prompt
  // and the conversation — on a small local model the full context would
  // swamp the window before the first reply (`--config=` form: with a space
  // the overlay never loads, see lib/model-plan/one-shot.ts).
  if (kind === "sidebar" && sidebarSessionDir) {
    args.push(
      "--no-tools",
      "--no-skills",
      "--no-extensions",
      "--no-rules",
      "--no-prewalk",
      "--no-title",
      `--config=${sidebarOverlayPath()}`,
      "--session-dir", sidebarSessionDir,
      "--system-prompt", SIDEBAR_CHAT_SYSTEM_PROMPT,
    );
  }
  
  return args;
}

/** Complete launch for an rpc-dialect session. A local profile is launch-only:
 * it changes no live OMP configuration and applies on both new and resumed sessions. */
export function buildEngineRpcLaunch(
  harness: HarnessAdapter,
  opts: {
    cwd: string;
    sessionFile: string;
    toolNames?: string[];
    advisor?: boolean;
    profile?: LocalModelProfileLaunch;
    kind?: "sidebar";
  },
): RpcProcessLaunch {
  const spec = harness.rpcUi;
  if (!spec) {
    throw new WebRpcError(`${harness.displayName} does not speak the RPC session protocol`, "engine_mismatch");
  }
  const bin = harness.resolveBinary();
  if (!bin) {
    throw new WebRpcError(
      `${harness.binaryName} binary not found. Install ${harness.displayName} from Settings → System → Engines, or set CODY_${harness.binaryName.toUpperCase()}_BIN.`,
      "engine_not_installed",
    );
  }
  const args = ["--mode", spec.mode];
  // A sidebar child runs from a BARE directory, not the workspace: omp
  // discovers `AGENTS.md`/`CLAUDE.md` from its cwd and injects them verbatim
  // (43,438 tokens on this repo, measured), and `--no-rules` does not cover
  // that. Its context tools read the real workspace on demand instead, so it
  // must not start somewhere with context files to find.
  const sidebarCwd = opts.kind === "sidebar" ? sidebarBareCwd() : undefined;
  if (spec.supportsCwdFlag) args.push("--cwd", sidebarCwd ?? opts.cwd);
  const newSessionTools = opts.profile?.toolNames ?? opts.toolNames;
  const sidebarSessionDir = opts.kind === "sidebar" ? path.join(getSidebarChatsDir(), getSessionDirNameForCwd(opts.cwd)) : undefined;
  // `--tools` alone is additive in OMP. The 8k profile must be a real
  // read+bash whitelist, while larger profiles retain OMP’s normal tool surface.
  if (opts.profile?.profileId === "minimal") args.push("--no-tools");
  args.push(...buildSessionSpawnArgs(opts.sessionFile, newSessionTools, opts.advisor === true, opts.kind, sidebarSessionDir, spec));
  // OMP accepts these flags with --resume. Existing session tool presets are
  // intentionally untouched unless a local profile explicitly replaces them.
  if (opts.sessionFile && opts.profile?.toolNames?.length) {
    args.push("--tools", opts.profile.toolNames.join(","));
  }
  if (opts.profile?.systemPromptPath) args.push("--system-prompt", opts.profile.systemPromptPath);
  // A sidebar child gets its own agent dir, whose `mcp.json` is empty, so the
  // user-scope MCP servers (111 tool schemas / 89,303 tokens on the owner's
  // install) never reach it. Credentials, providers and blobs are symlinked
  // in, so sign-ins and the local llama-swap models keep working.
  const sidebarEnv = opts.kind === "sidebar" ? { PI_CODING_AGENT_DIR: sidebarAgentDir() } : undefined;
  return {
    bin,
    label: harness.binaryName,
    args,
    ...(opts.profile?.env || sidebarEnv ? { env: { ...opts.profile?.env, ...sidebarEnv } } : {}),
    readiness: spec.readiness,
  };
}

/**
 * Launch for the shared UTILITY process (global registry queries: available
 * models, default model — see lib/omp/rpc-utility). `undefined` for omp AND
 * ONLY for omp: rpc-utility's default path spawns the installed omp, and the
 * omp-only auth routes share that process. Other rpc-dialect engines (pi) get
 * a sessionless launch; `--no-session --no-skills` exist in pi's parser with
 * omp's semantics.
 *
 * An engine that does NOT speak the dialect at all (every ACP engine: claude,
 * codex) THROWS `unsupported` rather than returning `undefined`.
 *
 * That is the whole point of this function's contract, and the bug it exists
 * to make impossible: it used to answer `undefined` for those engines too, and
 * `undefined` is rpc-utility's "spawn the installed omp" signal. So
 * `GET /api/models` faithfully asked omp for its catalog and served it as
 * Claude Code's — 150 omp models in the composer of an engine that had never
 * heard of them. A launch that means "some other engine" must never be
 * spelled the same way as a launch that means "this one".
 *
 * Callers turn the throw into an honest empty answer; failures on the models
 * path are values, never exceptions that reach the client as a 500.
 */
export function utilityRpcLaunchFor(harness: HarnessAdapter): RpcProcessLaunch | undefined {
  const spec = harness.rpcUi;
  if (!spec) {
    throw new WebRpcError(
      `${harness.displayName} does not speak the RPC utility protocol, so it has no global model catalog to read.`,
      "unsupported",
    );
  }
  if (harness.id === "omp") return undefined;
  const bin = harness.resolveBinary();
  if (!bin) {
    throw new WebRpcError(
      `${harness.binaryName} binary not found. Install ${harness.displayName} from Settings → System → Engines.`,
      "engine_not_installed",
    );
  }
  return {
    bin,
    label: harness.binaryName,
    args: ["--mode", spec.mode, "--no-session", "--no-skills"],
    readiness: spec.readiness,
  };
}

function toImageContents(value: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  const images = value as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  return images?.length ? images : undefined;
}

/**
 * Pick a spawn cwd that actually exists. A session records the directory it was
 * created in, but that directory may have been deleted since: spawn() would
 * fail with ENOENT and `omp --cwd <missing>` throws in setProjectDir. omp's own
 * resume path skips the chdir when the recorded project dir is gone and keeps
 * the launch cwd (main.ts), so hand it a live directory and let it decide.
 */
export function resolveSpawnCwd(recordedCwd?: string | null): string {
  if (recordedCwd && existsSync(recordedCwd)) return recordedCwd;
  try {
    const serverCwd = process.cwd();
    if (serverCwd && existsSync(serverCwd)) return serverCwd;
  } catch {
    // process.cwd() itself throws when the server's own cwd was removed.
  }
  return homedir();
}

/** omp's CompactionResult has no estimatedTokensAfter; approximate it from the
 * summary so the compaction banner can show savings instead of "→ 0 tokens". */
function patchEstimatedTokensAfter(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const compaction = result as CompactionResultLike;
  if (compaction.estimatedTokensAfter === undefined) {
    compaction.estimatedTokensAfter = Math.round((compaction.summary?.length ?? 0) / 4);
  }
}

/** Layer this conversation's model preset (lib/model-presets) over the
 * launch profile. The preset overlay goes AFTER the prompt-profile overlay —
 * they set disjoint keys — and before Local-only, which replaces the launch
 * wholesale while it is on: a Local-only chat is limited to local models, so
 * a preset naming cloud models must not apply there. */
function withPresetOverlay(profile: LocalModelProfileLaunch | undefined, sessionId: string): LocalModelProfileLaunch | undefined {
  const overlay = sessionPresetOverlay(sessionId);
  if (!overlay) return profile;
  const inherited = profile?.env?.PI_CONFIG_FILES ?? process.env.PI_CONFIG_FILES;
  return {
    ...(profile ?? { profileId: "full" as const }),
    env: {
      ...profile?.env,
      PI_CONFIG_FILES: [inherited, overlay].filter((value): value is string => typeof value === "string" && value.length > 0).join(path.delimiter),
    },
  };
}

/** Every per-conversation overlay, in precedence order: the launch profile,
 * then the chat's model preset, then Local-only. Relaunches rebuild this from
 * the persisted state, so a restart always picks up the chat's current preset. */
export function launchWithSessionOverlays(profile: LocalModelProfileLaunch | undefined, sessionId: string): LocalModelProfileLaunch | undefined {
  return launchWithLocalRouting(withPresetOverlay(profile, sessionId), sessionId);
}

/** Append a session-owned Local-only overlay after the prompt overlay. The
 * routing overlay owns model selection; the profile overlay owns compaction
 * and context-file suppression, so neither can overwrite the other. */
function launchWithLocalRouting(profile: LocalModelProfileLaunch | undefined, sessionId: string): LocalModelProfileLaunch | undefined {
  const intent = readLocalRoutingIntent(sessionId);
  if (!intent.enabled && intent.error) {
    throw new WebRpcError(`Local-only routing cannot start safely: ${intent.error}`, "local_routing_unavailable");
  }
  const routing = materializeLocalRoutingOverlay(intent);
  if (!routing) return profile;
  // OMP retries a fallback in the same process, so the prompt and compaction
  // budget must fit every frozen destination—not merely the initial primary.
  const envelopeProfile = materializeLocalModelProfile(resolveLocalModelPromptProfile({
    provider: intent.primary!.provider,
    modelId: intent.primary!.modelId,
    contextWindow: intent.envelope!.contextWindow,
    maxTokens: intent.envelope!.maxTokens,
  }));
  const safestProfileId = selectPromptProfileId({ contextWindow: intent.envelope!.contextWindow });
  const profileBreadth: Record<PromptProfileId, number> = { minimal: 0, compact: 1, full: 2 };
  if (profileBreadth[envelopeProfile.profileId] > profileBreadth[safestProfileId]) {
    throw new WebRpcError(`This Local-only fallback set requires the ${safestProfileId} prompt profile or a more restrictive override; change the profile override or remove the smaller fallback.`, "local_routing_unsafe_profile");
  }
  const profileConfig = envelopeProfile.env?.PI_CONFIG_FILES;
  return {
    profileId: envelopeProfile.profileId,
    ...(envelopeProfile.systemPromptPath ? { systemPromptPath: envelopeProfile.systemPromptPath } : {}),
    ...(envelopeProfile.toolNames ? { toolNames: envelopeProfile.toolNames } : {}),
    env: {
      ...envelopeProfile.env,
      PI_CONFIG_FILES: [profileConfig, routing.env.PI_CONFIG_FILES].filter((value): value is string => typeof value === "string" && value.length > 0).join(path.delimiter),
    },
  };
}

// ============================================================================
// AgentSessionWrapper
// Wraps one spawned rpc-dialect engine process (`omp --mode rpc-ui`,
// `pi --mode rpc`) with the interface the rest of the app expects (same
// command surface pi-web's in-process wrapper offered).
// ============================================================================
/** Engine facts a wrapper needs beyond the live process. */
export interface WrapperEngineContext {
  rpcUi: RpcUiSpawn;
  /** Engine name for user-facing messages ("omp", "pi"). */
  label: string;
  /** Profile already used to create this process, if any. */
  initialProfile?: LocalModelProfileLaunch;
  initialResolution?: ResolvedLocalModelProfile;
  /** Rebuilds a launch. A profile is applied only to this child process. */
  relaunch: (sessionFile: string, profile?: LocalModelProfileLaunch) => RpcProcessLaunch;
  /** Session kind: "sidebar" for sidebar chats, undefined for main/normal sessions. */
  kind?: "sidebar";
  /**
   * Sidebar only. The child runs from a BARE cwd so omp discovers no context
   * files, so the workspace its context tools read is carried separately —
   * `this.cwd` would be the bare directory and every read would find nothing.
   */
  contextCwd?: string;
  /** Sidebar only: the main chat session `read_session` defaults to. */
  contextSessionId?: string | null;
  /** Acting account, for the ownership gate on session reads. */
  user?: UserRecord | null;
}

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiRequests = new Map<string, AgentEvent>();
  private uiExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private bashRunning = false;
  private streaming = false;
  /** Text of the newest assistant reply in the current run: what omp's todo
   * reminder would auto-continue past. Cleared at run boundaries. */
  private lastReplyText: string | null = null;
  private compacting = false;
  private fastModeEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string) => void) | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private restarting = false;
  private _alive = true;
  private mcpListWaiter: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Unsubscribe for durable browser operation transcript updates. */
  private operationWatch: (() => void) | null = null;
  /** Unsubscribe for the device-bridge watch, set once the session id is known. */
  private deviceWatch: (() => void) | null = null;
  /** Host tools the web UI registered via set_host_tools (agent-callable). */
  private hostToolNames: Set<string> = new Set();
  private hostTools: Array<Record<string, unknown>> = [];
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools: Map<string, AgentEvent> = new Map();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  private hostUriSchemeEntries: Array<Record<string, unknown>> = [];
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, AgentEvent> = new Map();
  /** Watches this session's activity and keeps the composer-attached plan
   * live (lib/plan-keeper/keeper.ts); lazily created once the session id is
   * known (getPlanKeeper). */
  private planKeeper: PlanKeeper | null = null;
  /** Resolves once an in-flight destroyAndWait finishes; null when idle. Read
   * by startRpcSession so a replacement spawn awaits the old child's exit. */
  /** Resolves once an in-flight destroy finishes; null when idle. */
  destroyPromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private _sessionName: string | undefined;
  private localProfileLaunch: LocalModelProfileLaunch | undefined;
  private localProfileResolution: ResolvedLocalModelProfile | undefined;
  private proc: RpcProcess;
  readonly cwd: string;

  private readonly engine: WrapperEngineContext;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode for probes/tests.
  constructor(proc: RpcProcess, cwd: string, engine: WrapperEngineContext) {
    this.proc = proc;
    this.cwd = cwd;
    this.engine = engine;
    this.localProfileLaunch = engine.initialProfile;
    this.localProfileResolution = engine.initialResolution;
  }

  /** The smallest local profile is deliberately limited to its two OMP tools.
   *
   * A sidebar chat gets NEITHER omp's builtins (`--no-tools`) nor the
   * browser's host tools — but it does get the read-only context tools, which
   * are the whole point of the redesign: it launches with no project context
   * at all (measured: 133,559 tokens of preloaded AGENTS.md and MCP schemas
   * before, ~144 after) and fetches what it needs on demand instead. Their
   * schemas cost 416 tokens, which even an 8k local model can afford. */
  private hostToolsForCurrentProfile() {
    if (this.engine.kind === "sidebar") return SIDEBAR_CONTEXT_TOOLS.map(({ handler: _handler, ...tool }) => tool);
    if (this.localProfileLaunch?.profileId === "minimal") return [];
    return [...this.hostTools, ...SERVER_HOST_TOOLS, ...this.deviceToolsForSession()];
  }

  /**
   * The working tools exist only while a page is actually holding hardware
   * for this session. Registering all seven unconditionally would spend
   * schema tokens in every conversation for a capability most of them cannot
   * use — and offering a model `device_write` with nothing attached invites
   * it to try.
   *
   * `device_list` is the exception, and is published whenever a browser is
   * attached at all. A capability the model cannot SEE is one it never
   * suggests: with nothing granted yet, an agent asked to talk to a plugged-in
   * board had no way to learn that the browser it is being read in can reach
   * USB, serial and BLE directly. One small schema buys that, and the tool's
   * own output names the next step (grant a device in the Devices panel) and
   * reports what this particular browser can do — which differs per machine,
   * since the human may be on a laptop, a phone or a tablet.
   */
  private deviceToolsForSession(): HostToolDefinition[] {
    if (!this._sessionId) return [];
    const bridge = peekDeviceBridge(this._sessionId);
    if (!bridge?.attached) return [];
    const published = bridge.list().length > 0
      ? [...DEVICE_TOOLS, ...DEVICE_OPERATION_TOOLS]
      : DEVICE_TOOLS.filter((tool) => tool.name === "device_list");
    return published.map(({ handler: _handler, ...tool }) => tool);
  }

  /** Re-publish the tool list when a browser or its hardware comes or goes,
   * and say so once in the transcript: a tool that silently materializes
   * mid-conversation is a capability the model has no reason to go looking
   * for. Attachment is tracked alongside the device count because a browser
   * arriving with nothing granted still changes the published set — that is
   * when `device_list` appears. */
  private watchDeviceBridge(): void {
    if (!this._sessionId || this.deviceWatch) return;
    const bridge = peekDeviceBridge(this._sessionId);
    if (!bridge) return;
    if (!this.operationWatch) {
      this.operationWatch = bridge.onOperation((snapshot, event) => {
        if (!this.isAlive()) return;
        let message = `Hardware operation ${snapshot.id} is ${snapshot.state}.`;
        let level: "info" | "warning" = "info";
        if (event?.type === "progress" && event.progress) {
          message = `Hardware operation ${snapshot.id}: ${event.progress.phase}${event.progress.message ? ` — ${event.progress.message}` : ""}.`;
        } else if (event?.type === "output" && event.output) {
          const output = event.output.line.length > 1024
            ? event.output.line.slice(0, 1024) + " …[line truncated]"
            : event.output.line;
          message = `Hardware operation ${snapshot.id} device output (untrusted): ${output}`;
        } else if (event?.type === "confirmation" && event.confirmation) {
          level = "warning";
          message = `Hardware operation ${snapshot.id} is awaiting direct UI confirmation for ${event.confirmation.binding.action} on ${event.confirmation.binding.target}.`;
        } else if (snapshot.error) {
          level = "warning";
          message = `Hardware operation ${snapshot.id} failed: ${snapshot.error}`;
        } else if (snapshot.result) {
          message = `Hardware operation ${snapshot.id} completed: ${snapshot.result.summary}`;
        }
        this.emit({ type: "notice", level, message });
      });
    }
    let lastAttached = bridge.attached;
    let lastCount = bridge.attached ? bridge.list().length : 0;
    this.deviceWatch = bridge.onChange(() => {
      const attached = bridge.attached;
      const count = attached ? bridge.list().length : 0;
      if (count === lastCount && attached === lastAttached) return;
      const previous = lastCount;
      lastAttached = attached;
      lastCount = count;
      if (!this.engine.rpcUi.hostTools || !this.isAlive()) return;
      void this.proc.sendCommand({ type: "set_host_tools", tools: this.hostToolsForCurrentProfile() }).catch(() => {});
      if (count > 0 && previous === 0) {
        const labels = bridge.list().map((device) => device.label).join(", ");
        this.emit({
          type: "notice",
          level: "info",
          message: `Hardware attached in the browser: ${labels}. device_open now claims it and reports its endpoints; device_read, device_write, device_close, usb_transfer and ble_gatt work against it.`,
        });
      }
      // The loss matters more than the arrival, and used to be silent: the
      // tools simply vanished mid-conversation and the next call failed with
      // nothing to connect it to. Measured on a long ADB push where the
      // socket dropped — the agent kept retrying a device that was gone.
      if (count === 0 && previous > 0) {
        this.emit({
          type: "notice",
          level: "warning",
          message: attached
            ? "The browser released its hardware (unplugged, or the grant was revoked). Any transfer in progress did not finish; reconnect it in Cody's Devices panel."
            : "The browser holding this session's hardware disconnected (tab closed, reloaded, or offline). Any transfer in progress did not finish; reopen Cody's Devices panel to reconnect.",
        });
      }
    });
  }

  /** The phase flags a status call reports, read straight off this wrapper.
   * Deliberately not a `get_state` round trip: the whole point of asking
   * about ANOTHER session is that it may be wedged, and awaiting its child
   * would hang the asking session's own turn. */
  livePhase(): SessionLivePhase {
    return {
      running: this.isRunning(),
      streaming: this.streaming,
      promptRunning: this.promptRunning,
      bashRunning: this.bashRunning,
      compacting: this.compacting,
    };
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** The session id is not known until applyIdentity/buildWebState runs, so
   * this stays null until then — real activity always arrives after that. */
  private getPlanKeeper(): PlanKeeper | null {
    if (!this._sessionId) return null;
    if (!this.planKeeper) {
      this.planKeeper = new PlanKeeper({
        sessionId: this._sessionId,
        getTodoPhases: async () => {
          const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" });
          return state.todoPhases ?? [];
        },
        setTodoPhases: async (phases) => {
          await this.proc.sendCommand({ type: "set_todos", phases });
        },
        // The frame interfaces are exact shapes; AgentEvent carries an index
        // signature, which an interface type does not satisfy structurally.
        emit: (frame) => this.emit({ ...frame }),
      });
    }
    return this.planKeeper;
  }

  get sessionFile(): string {
    return this._sessionFile;
  }

  isAlive(): boolean {
    return this._alive && this.proc.isAlive;
  }

  isRunning(): boolean {
    return this.isAlive() && (this.promptRunning || this.streaming || this.compacting || this.bashRunning);
  }

  /** The profile actually launched for this live wrapper, for the settings API.
   * Undefined means the session predates profile tracking or is non-local. */
  localModelProfileApplication(): { provider: string; modelId: string; profileId: PromptProfileId } | undefined {
    const resolution = this.localProfileResolution;
    return resolution ? { provider: resolution.provider, modelId: resolution.modelId, profileId: resolution.profile.id } : undefined;
  }

  private localProfileNeedsRestart(next: LocalModelProfileLaunch): boolean {
    const current = this.localProfileLaunch;
    if ((current?.profileId ?? "full") !== next.profileId) return true;
    if (next.profileId === "full") return false;
    return current?.systemPromptPath !== next.systemPromptPath || current?.env?.PI_CONFIG_FILES !== next.env?.PI_CONFIG_FILES;
  }

  /** Resolve a model-specific profile and, while idle, restart this same wrapper
   * before another provider call. An active provider/tool operation is never killed. */
  async synchronizeLocalModelProfile(model?: OmpModel): Promise<void> {
    // Automatic Local-only retries stay in one OMP process; its frozen envelope
    // profile must not widen when the active primary/fallback changes.
    if (readLocalRoutingIntent(this._sessionId).enabled) return;
    const activeModel = model ?? (await this.proc.sendCommand<RpcSessionState>({ type: "get_state" })).model;
    if (!activeModel) return;
    const resolution = resolveLocalModelPromptProfile({
      provider: activeModel.provider,
      modelId: activeModel.id,
      contextWindow: activeModel.contextWindow,
      maxTokens: activeModel.maxTokens,
    });
    const next = materializeLocalModelProfile(resolution);
    if (!this.localProfileNeedsRestart(next)) {
      this.localProfileLaunch = next;
      this.localProfileResolution = resolution;
      return;
    }
    if (this.isRunning()) {
      throw new WebRpcError("Wait for the current provider or tool operation to finish before changing its prompt profile.", "session_busy");
    }
    await this.restart(next);
    this.localProfileLaunch = next;
    this.localProfileResolution = resolution;
  }

  /** Set when a persisted overlay (a preset edit) changed while this chat was
   * mid-turn: the restart happens at the turn's end instead of killing it. */
  private routingRestartPending = false;
  /** One routingForRouting run at a time per wrapper. A request that arrives
   *  while one is in flight never races it into restart()'s own
   *  session_restarting guard: it coalesces into a single follow-up run
   *  (never more than one queued) so every caller settles without throwing,
   *  and any overlay change that landed mid-run still gets applied. */
  private routingRestartInFlight: Promise<boolean> | null = null;
  private routingRestartCoalesce = false;

  /** Restart onto the current persisted overlays now if idle, else as soon as
   * the running turn ends. Never interrupts provider or tool work. */
  async restartForRoutingWhenIdle(): Promise<{ restarted: boolean; active: boolean }> {
    if (this.isRunning()) {
      this.routingRestartPending = true;
      return { restarted: false, active: true };
    }
    return { restarted: await this.restartForRouting(), active: false };
  }

  /** Apply a persisted routing-overlay change only when this wrapper is idle.
   *  Serialized per wrapper: see routingRestartInFlight above. */
  async restartForRouting(): Promise<boolean> {
    if (this.routingRestartInFlight) {
      this.routingRestartCoalesce = true;
      return this.routingRestartInFlight;
    }
    const run = this.runRoutingRestart().finally(() => {
      this.routingRestartInFlight = null;
      if (this.routingRestartCoalesce) {
        this.routingRestartCoalesce = false;
        // Something coalesced onto the run that just finished: its overlay
        // read may already be stale, so true up once more rather than let a
        // picked preset silently not apply.
        void this.restartForRouting().catch((error: unknown) => {
          console.warn("[rpc-manager] coalesced routing restart failed:", error);
        });
      }
    });
    this.routingRestartInFlight = run;
    return run;
  }

  /** The actual restart. Never called concurrently with itself — restartForRouting
   *  above serializes — but still re-checks isRunning() after its own get_state
   *  round trip: a prompt that starts during that await sets promptRunning
   *  synchronously and is sent to the still-live process (see send()'s "prompt"
   *  case), and restart() would kill it mid-turn if this went on regardless. */
  private async runRoutingRestart(): Promise<boolean> {
    if (this.isRunning()) return false;
    // The cached launch profile of a Local-only session IS the Local-only
    // launch: its frozen envelope profile plus the overlay that limits the
    // engine to local models. Relaunching from it after the mode was turned
    // off kept that overlay, so the engine went on refusing every cloud
    // model ("Model not found") while Cody reported Local-only as off. The
    // base profile is rebuilt from the active model instead; relaunch then
    // layers the routing overlay back on only while the mode is on.
    let base: LocalModelProfileLaunch | undefined;
    let resolution: ResolvedLocalModelProfile | undefined;
    try {
      const model = (await this.proc.sendCommand<RpcSessionState>({ type: "get_state" })).model;
      if (model) {
        resolution = resolveLocalModelPromptProfile({
          provider: model.provider,
          modelId: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        });
        base = materializeLocalModelProfile(resolution);
      }
    } catch {
      // No readable model: the engine's full default profile is the safe base.
    }
    // A prompt may have started while get_state was in flight. Defer to the
    // turn-end restart instead of killing a turn already underway.
    if (this.isRunning()) {
      this.routingRestartPending = true;
      return false;
    }
    const effective = launchWithSessionOverlays(base, this._sessionId);
    this.localProfileLaunch = effective;
    this.localProfileResolution = resolution;
    await this.restart(base);
    // A resumed session keeps its last model even when the overlay no longer
    // lists it, so turning Local-only on over a cloud model would have sent
    // the next turn to the cloud. Move it onto the local primary.
    const intent = readLocalRoutingIntent(this._sessionId);
    if (intent.enabled && intent.primary) {
      const current = (await this.proc.sendCommand<RpcSessionState>({ type: "get_state" })).model;
      if (!current || !validateLocalRoutingModelSelection(this._sessionId, current.provider, current.id).allowed) {
        await this.send({ type: "set_model", provider: intent.primary.provider, modelId: intent.primary.modelId });
      }
    }
    return true;
  }

  start(): void {
    this.unsubscribeFrames = this.proc.onFrame((frame) => this.handleFrame(frame));
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** Resolves once the child announced readiness and identity is known. */
  waitUntilReady(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const ready = await this.proc.waitReady(READY_TIMEOUT_MS);
    await this.proc.negotiateProtocol(ready);
    // Subscribe to subagent lifecycle/progress/event frames so the UI can show
    // a live subagent roster. Older omp builds may not know the command —
    // degrade silently (the UI falls back to no subagent info). Engines whose
    // protocol has no subagent surface (pi) are never asked: their id-less
    // unknown-command responses can never settle the request.
    if (this.engine.rpcUi.subagentEvents) {
      await this.proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
    }
    // Publish host tools before the first turn. Minimal profiles publish an
    // empty set to clear registrations retained by a resumed engine session;
    // engines without this surface are never asked.
    if (this.engine.rpcUi.hostTools) {
      await this.proc.sendCommand({ type: "set_host_tools", tools: this.hostToolsForCurrentProfile() }).catch(() => {});
    }
    const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" });
    this.applyIdentity(state);
  }

  /**
   * Every write to _sessionId goes through here — both applyIdentity AND
   * buildWebState can observe a freshly-changed id (a branch/new_session/
   * switch_session, or a non-resumable restart, surfaces through whichever
   * one next reads get_state), so the reset lives in one place rather than
   * being duplicated — and possibly missed — at each call site. A real
   * change (not the routine "still the same id" case) means the plan
   * keeper, built for the OLD session's cody-plan/<id>.json, must be
   * dropped so getPlanKeeper() rebuilds fresh — new digest, new overlay
   * path — against the new one.
   */
  private setSessionId(id: string): void {
    if (this._sessionId && this._sessionId !== id) {
      this.planKeeper?.dispose();
      this.planKeeper = null;
      // A re-keyed session takes its device grants with it: the page is still
      // holding the same hardware, it is just filed under a new id now.
      aliasDeviceBridge(this._sessionId, id);
      this.deviceWatch?.();
      this.deviceWatch = null;
      this.operationWatch?.();
      this.operationWatch = null;
    }
    this._sessionId = id;
    this.watchDeviceBridge();
  }

  private applyIdentity(state: RpcSessionState): void {
    this.setSessionId(state.sessionId);
    this._sessionFile = state.sessionFile ?? "";
    this._sessionName = state.sessionName;
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this.fastModeEnabled = state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled;
    if (this._sessionFile) cacheSessionPath(this._sessionId, this._sessionFile);
  }

  handleProcessExit(stderrTail: string): void {
    // A restart disposes the old child on purpose — not a crash.
    if (!this._alive || this.restarting) return;
    const detail = stderrTail.trim().split("\n").pop() ?? "";
    this.emit({
      type: "notice",
      level: "error",
      message: `The ${this.engine.label} process for this session exited unexpectedly${detail ? `: ${detail}` : "."}`,
    });
    // Terminal agent_end so a client mid-stream stops spinning immediately
    // instead of waiting for the reconcile poll.
    if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    this.destroy();
  }

  private handleFrame(frame: RpcFrame): void {
    this.resetIdleTimer();
    const event = frame as AgentEvent;
    let refreshSessionList = false;

    switch (event.type) {
      case "command_output": {
        // `/mcp list` is a local OMP command. Capture its authoritative text for
        // Settings instead of adding an invisible command to the chat stream.
        const waiter = this.mcpListWaiter;
        if (waiter && typeof event.text === "string") {
          clearTimeout(waiter.timer);
          this.mcpListWaiter = null;
          waiter.resolve(event.text);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "agent_start":
        this.streaming = true;
        this.lastReplyText = null;
        // The session file can appear just after the prompt acknowledgement.
        // Invalidate and signal the sidebar now rather than waiting for the
        // agent's first reply or terminal event.
        this.invalidateSessionLists();
        refreshSessionList = true;
        // If the file is not on disk yet, the sidebar refresh above may walk
        // the sessions dir before it exists — and the mtime-keyed walk cache
        // then stays stale (NTFS does not bump the sessions-root mtime for
        // files added inside a project subdirectory), hiding the running
        // session from the list until the next invalidation (agent_end).
        // Re-signal once the file actually lands.
        if (this._sessionFile && !existsSync(this._sessionFile)) {
          this.signalWhenSessionFileAppears();
        }
        break;
      case "agent_end":
        if (event.isTerminal !== false) {
          this.streaming = false;
          this.promptRunning = false;
          this.lastReplyText = null;
          this.invalidateSessionLists();
          void this.getPlanKeeper()?.notifyTerminalAgentEnd();
          if (this.routingRestartPending) {
            this.routingRestartPending = false;
            // After this frame has reached every listener, and only if nothing
            // started in between (a queued follow-up, a steer).
            setTimeout(() => {
              if (!this.isAlive() || this.isRunning()) {
                this.routingRestartPending = true;
                return;
              }
              void this.restartForRouting().catch((error: unknown) => {
                console.warn("[rpc-manager] deferred routing restart failed:", error);
              });
            }, 0);
          }
        }
        break;
      case "message_end": {
        const text = assistantReplyText(event as unknown as { type: string; [key: string]: unknown });
        if (text !== null) {
          this.lastReplyText = text;
          this.getPlanKeeper()?.notifyMessageEnd(text);
        }
        break;
      }
      case "todo_reminder": {
        // omp auto-continues an unfinished todo list unless the LAST line of
        // the reply is a question; a question anywhere else in the reply was
        // overridden and the agent carried on as if the user had answered.
        // Stop that continuation here so the run ends at the question. A
        // reply that asked nothing keeps the reminder (it is what makes the
        // agent mark its tasks done and finish them).
        if (this.lastReplyText !== null && replyAsksUser(this.lastReplyText)) {
          this.lastReplyText = null;
          void this.proc.sendCommand({ type: "abort" }).catch((error: unknown) => {
            console.warn("[rpc-manager] could not pause the todo reminder:", error);
          });
          this.emit({
            type: "notice",
            level: "info",
            message: "Paused for your answer. The engine's todo reminder would have continued without it.",
          });
        }
        break;
      }
      case "tool_execution_end": {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        this.getPlanKeeper()?.notifyToolExecutionEnd(toolName, event.args, event.result);
        break;
      }
      case "subagent_lifecycle": {
        const payload = event.payload;
        if (isRecord(payload) && (payload.status === "completed" || payload.status === "failed" || payload.status === "aborted")) {
          this.getPlanKeeper()?.notifySubagentTerminal({
            agent: typeof payload.agent === "string" ? payload.agent : undefined,
            description: typeof payload.description === "string" ? payload.description : undefined,
            status: payload.status,
          });
        }
        break;
      }
      case "turn_end":
        this.getPlanKeeper()?.notifyTurnEnd();
        break;
      case "prompt_result":
        // Local-only prompt (builtin/extension slash command) — no agent run.
        this.promptRunning = false;
        break;
      case "auto_compaction_start":
        this.compacting = true;
        break;
      case "auto_compaction_end":
        this.compacting = false;
        // Same patch the manual `compact` path applies — the client reads
        // event.result.estimatedTokensAfter for the banner.
        patchEstimatedTokensAfter(event.result);
        this.invalidateSessionLists();
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        this.invalidateSessionLists();
        refreshSessionList = true;
        break;
      case "response": {
        // Unsolicited failed responses surface async prompt failures (omp
        // reuses the original command id after the immediate ack). Some omp
        // versions omit `command` on that second response, so the active run
        // is also a terminal-failure signal instead of an ignored frame.
        if (event.success === false) {
          const promptFailure = event.command === "prompt" || (!event.command && (this.promptRunning || this.streaming));
          const detail = typeof event.error === "string"
            ? event.error
            : typeof event.message === "string"
              ? event.message
              : "RPC command failed";
          if (!promptFailure) {
            this.emit({ type: "error", error: event.error, message: detail, command: event.command });
            notifyRunningChange();
            return;
          }
          this.promptRunning = false;
          this.emit({ type: "prompt_error", errorMessage: detail, error: event.error, command: event.command });
          notifyRunningChange();
          return;
        }
        break;
      }
      case "extension_ui_request": {
        if (this.trackExtensionUiRequest(event)) {
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_tool_call": {
        const id = typeof event.id === "string" ? event.id : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        // Server-implemented tools settle right here, browser or no browser.
        if (id && SERVER_HOST_TOOL_NAMES.has(toolName)) {
          void this.handleServerHostTool(id, toolName, event);
          return;
        }
        // Route REGISTERED host tools to an attached UI (the browser answers
        // via host_tool_result); unregistered tools or no attached listener
        // are rejected immediately so the agent never hangs on a tool nobody
        // will answer.
        if (id && toolName && this.hostToolNames.has(toolName) && this.listeners.length > 0) {
          this.pendingHostTools.set(id, event);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        // Unregistered tool / no listener: reject (emits a notice) and do NOT
        // re-emit the frame — the UI must not answer a call nobody routed.
        this.rejectUnexpectedHostTool(event);
        return;
      }
      case "host_tool_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostTools.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_uri_request": {
        const id = typeof event.id === "string" ? event.id : "";
        const url = typeof event.url === "string" ? event.url : "";
        // Route registered schemes to an attached UI (the browser answers via
        // host_uri_result); unknown schemes / no listener are rejected so the
        // agent's read/write never hangs.
        const scheme = url.split(":")[0] ?? "";
        const operation = event.operation === "write" ? "write" : "read";
        const registered = this.hostUriSchemes.get(scheme);
        if (id && scheme && registered && (operation !== "write" || registered.writable) && this.listeners.length > 0) {
          this.pendingHostUris.set(id, event);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        this.proc.sendFrame({
          type: "host_uri_result",
          id,
          isError: true,
          error: `URI scheme \"${scheme}\" is not registered by Cody`,
        });
        return;
      }
      case "host_uri_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostUris.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
    }

    this.emit(event);
    notifyRunningChange({ refreshSessionList });
  }

  /** Forget a pending dialog and its expiry timer. */
  private forgetPendingUiRequest(id: string): void {
    this.pendingUiRequests.delete(id);
    const timer = this.uiExpiryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.uiExpiryTimers.delete(id);
    }
  }

  private clearPendingUiRequests(): void {
    for (const timer of this.uiExpiryTimers.values()) clearTimeout(timer);
    this.uiExpiryTimers.clear();
    this.pendingUiRequests.clear();
  }

  private trackExtensionUiRequest(event: AgentEvent): boolean {
    const method = event.method as string;
    const id = event.id as string;
    if (method === "cancel") {
      this.forgetPendingUiRequest(event.targetId as string);
      return false;
    }
    // Only the “Allow tool: <name>” confirmation is covered. Other extension
    // prompts, including login/editor confirmations, remain interactive.
    let autoApproveExtension = false;
    try {
      autoApproveExtension = readNativeSettings().settings.tools?.approval?.extension === "allow";
    } catch {
      // A malformed config must not prevent normal interactive approval.
    }
    if (method === "confirm" && typeof event.title === "string" && /^allow tool\s*:/i.test(event.title) && autoApproveExtension) {
      this.forgetPendingUiRequest(id);
      this.proc.sendFrame({ type: "extension_ui_response", id, confirmed: true });
      return true;
    }
    if (PENDING_UI_METHODS.has(method)) {
      this.forgetPendingUiRequest(id);
      const timeout = typeof event.timeout === "number" ? event.timeout : undefined;
      if (timeout && timeout > 0) {
        event.expiresAt = Date.now() + timeout;
        const timer = setTimeout(() => this.forgetPendingUiRequest(id), timeout);
        timer.unref?.();
        this.uiExpiryTimers.set(id, timer);
      }
      this.pendingUiRequests.set(id, event);
      return false;
    }
    if (method === "setStatus") {
      const key = event.statusKey as string;
      const text = event.statusText as string | undefined;
      if (text === undefined) this.extensionStatuses.delete(key);
      else this.extensionStatuses.set(key, text);
      return false;
    }
    if (method === "setWidget") {
      const key = event.widgetKey as string;
      const lines = event.widgetLines as string[] | undefined;
      if (lines === undefined) {
        this.extensionWidgets.delete(key);
      } else {
        this.extensionWidgets.set(key, {
          key,
          lines,
          placement: (event.widgetPlacement as "aboveEditor" | "belowEditor" | undefined) ?? "aboveEditor",
        });
      }
    }
    return false;
  }

  /**
   * The one way a host_tool_result leaves this process. Anything too large for
   * a single RPC frame is swapped for a small error result with the same id
   * (see guardHostToolResultFrame) — dropping it instead would hang the agent's
   * tool call forever.
   */
  private sendHostToolResult(frame: RpcFrame): void {
    const { frame: outgoing, oversizedBytes } = guardHostToolResultFrame(frame);
    if (oversizedBytes !== null) {
      this.emit({
        type: "notice",
        level: "warning",
        message: `A tool result was too large to return to the engine (${oversizedBytes} bytes); it answered with an error instead.`,
      });
    }
    this.proc.sendFrame(outgoing);
  }

  /**
   * Settle a SERVER-implemented host tool call (see SERVER_HOST_TOOLS) —
   * executed here in the Node process, answered with sendFrame like the
   * reject paths, never routed to a browser.
   */
  private async handleServerHostTool(id: string, toolName: string, event: AgentEvent): Promise<void> {
    // A sidebar session may call its workspace tools too; a main chat is only
    // ever offered the session three, and serving it a tool its engine was
    // never told about would be answering a call nothing can have made.
    const available = this.engine.kind === "sidebar" ? SIDEBAR_CONTEXT_TOOLS : SESSION_AWARENESS_TOOLS;
    const sidebarTool = available.find((tool) => tool.name === toolName);
    if (sidebarTool) {
      // Handlers always resolve to plain text, success or failure, so there is
      // nothing to catch here: a bounded, human-readable answer is the
      // contract (lib/sidebar-context-tools.ts, lib/session-tools.ts).
      const text = await sidebarTool.handler(isRecord(event.arguments) ? event.arguments : {}, {
        cwd: this.engine.contextCwd ?? this.cwd,
        ...this.sessionToolContext(),
      });
      this.sendHostToolResult({ type: "host_tool_result", id, result: { content: [{ type: "text", text }] } });
      return;
    }
    const deviceTool = this.engine.kind === "sidebar"
      ? undefined
      : [...DEVICE_TOOLS, ...DEVICE_OPERATION_TOOLS].find((tool) => tool.name === toolName);
    if (deviceTool) {
      // Same contract as the session tools: plain text either way, and the
      // bridge is addressed by THIS session's id — a tool call can never
      // reach hardware granted to another conversation.
      const text = await deviceTool.handler(isRecord(event.arguments) ? event.arguments : {}, {
        bridge: getDeviceBridge(this._sessionId),
      });
      this.sendHostToolResult({ type: "host_tool_result", id, result: { content: [{ type: "text", text }] } });
      return;
    }
    if (toolName === "forge") {
      try {
        const text = await runForgeTool(event.arguments, { cwd: this.cwd });
        this.sendHostToolResult({ type: "host_tool_result", id, result: { content: [{ type: "text", text }] } });
      } catch (error) {
        // A ForgeError already reads as an instruction ("pass repo as
        // owner/name", "HTTP 404"); anything else is a bug and says so.
        const message = error instanceof ForgeError
          ? error.message
          : `Code host request failed: ${error instanceof Error ? error.message : String(error)}`;
        this.sendHostToolResult({ type: "host_tool_result", id, isError: true, result: { content: [{ type: "text", text: message }] } });
      }
      return;
    }
    if (toolName === "cody_todo") {
      try {
        const action = parseTodoAgentAction(event.arguments);
        const projectRoot = (await resolveProject(this.cwd)).projectRoot;
        let doc: TodoDocument;
        if (action.action === "list") {
          const loaded = await readProjectTodo(projectRoot);
          if (loaded.status === "invalid") throw new ProjectTodoError(loaded.reason);
          doc = loaded.doc;
        } else {
          doc = await mutateProjectTodo(
            projectRoot,
            todoAgentActionOperation(action),
          );
        }
        this.sendHostToolResult({
          type: "host_tool_result",
          id,
          result: { content: [{ type: "text", text: formatTodoForAgent(doc) }] },
        });
      } catch (error) {
        this.sendHostToolResult({
          type: "host_tool_result",
          id,
          isError: true,
          result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to update the project to-do list" }] },
        });
      }
      return;
    }
    if (toolName === "open_preview") {
      try {
        const request = await publishDisplayRequest(this._sessionId, event.arguments as Record<string, unknown>);
        // Tell the model whether anything is actually listening — it may have
        // called before its dev server finished booting. The probe runs where
        // the dev server runs, so it is authoritative in a way a browser
        // probe never was.
        let reachable = true;
        try {
          const probe = await fetch(request.source.url, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
          void probe.body?.cancel().catch(() => {});
        } catch {
          reachable = false;
        }
        // A port that answers on loopback but on no routable interface means
        // the dev server bound 127.0.0.1. A browser on this machine still gets
        // a real iframe (the loopback rung), but every other device drops to
        // the raster stream. The model is the one who can fix that, so say how.
        // NOTE: this must test for a NON-loopback direct candidate — a live
        // loopback server always yields a `direct` rung now, so `some(direct)`
        // would be permanently true and this hint would never fire.
        const loopbackOnly = reachable && request.requestedMode === "auto"
          && !request.candidates.some((candidate) => candidate.kind === "direct" && !isLoopbackHost(candidate.host));
        const status = reachable
          ? `Preview panel is now showing ${request.source.url} (request ${request.id}).`
          : `Preview panel opened for ${request.source.url} (request ${request.id}), but nothing answered there yet — verify the server is running and listening on that port.`;
        const hint = loopbackOnly
          ? " That port is bound to loopback only: a browser on this machine frames it directly, but any other device falls back to a streamed raster view. To make it full fidelity everywhere, restart the dev server listening on every interface (add `--host 0.0.0.0`, or run `npm run dev:lan` in this repo) and call open_preview again."
          : "";
        // The app may have started throwing since the model last looked. One
        // line, never the log content itself — the model asks for that.
        const notice = appLogNotice(this._sessionId);
        this.sendHostToolResult({
          type: "host_tool_result",
          id,
          result: { content: [{ type: "text", text: `${status}${hint}${notice ? ` ${notice}` : ""}` }] },
        });
      } catch (error) {
        this.sendHostToolResult({
          type: "host_tool_result",
          id,
          isError: true,
          result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid preview request" }] },
        });
      }
      return;
    }
    if (toolName === "shared_browser") {
      try {
        const handle = await startSharedBrowser(this._sessionId, isRecord(event.arguments) ? event.arguments : {});
        // The endpoint is only half the answer: automation that opens its own
        // tab would be driving a surface nobody streams, so say plainly that
        // the existing tab is the one on screen.
        const text = [
          `Shared browser is open at ${handle.request.source.url} and streaming to the user's Preview panel — they can see it and take the mouse at any time.`,
          `Attach your browser automation to this CDP endpoint and drive the tab that is already open: ${handle.endpoint}`,
          "Opening a second tab is fine — the user sees whatever that browser shows.",
        ].join(" ");
        this.sendHostToolResult({ type: "host_tool_result", id, result: { content: [{ type: "text", text }] } });
      } catch (error) {
        this.sendHostToolResult({
          type: "host_tool_result",
          id,
          isError: true,
          result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Could not start a shared browser" }] },
        });
      }
      return;
    }
    if (toolName === "read_app_logs") {
      const input = (typeof event.arguments === "object" && event.arguments !== null ? event.arguments : {}) as { level?: unknown; since?: unknown; grep?: unknown; limit?: unknown };
      const requested = typeof input.level === "string" ? input.level : "";
      const query: AppLogQuery = {
        level: APP_LOG_LEVELS.find((candidate) => candidate === requested),
        since: parseSince(input.since) ?? undefined,
        grep: typeof input.grep === "string" && input.grep !== "" ? input.grep : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
      };
      const digest = readAppLogs(this._sessionId, query);
      // Reading is what clears the notice, and only the model's read does: a
      // UI panel on the same ring must not silence it (see markAppLogsRead).
      markAppLogsRead(this._sessionId);
      this.sendHostToolResult({
        type: "host_tool_result",
        id,
        result: { content: [{ type: "text", text: formatAppLogDigest(digest, query) }] },
      });
      return;
    }
    if (toolName !== "preview_screenshot") {
      this.rejectUnexpectedHostTool(event);
      return;
    }
    const args = (typeof event.arguments === "object" && event.arguments !== null ? event.arguments : {}) as { url?: unknown; width?: unknown; height?: unknown };
    const url = typeof args.url === "string" ? args.url : "";
    try {
      const shot = await captureLoopbackScreenshot(url, {
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
      });
      const notice = appLogNotice(this._sessionId);
      // A non-PNG result means the ladder had to trade fidelity for a payload
      // that fits one engine message — say so, so the model reads the image for
      // what it is (and knows a smaller viewport is the way to get crisp text).
      const traded = shot.mimeType === "image/png"
        ? ""
        : " Re-encoded as WebP at this size so it fits one message to the engine.";
      this.sendHostToolResult({
        type: "host_tool_result",
        id,
        result: {
          content: [
            { type: "image", data: shot.data, mimeType: shot.mimeType },
            { type: "text", text: `Screenshot of ${shot.url} at ${shot.width}x${shot.height}.${traded}${notice ? ` ${notice}` : ""}` },
          ],
        },
      });
    } catch (error) {
      const message = error instanceof ScreenshotError
        ? `${error.message}${error.hint ? ` ${error.hint}` : ""}`
        : `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`;
      this.sendHostToolResult({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
  }

  /**
   * The identity and live state a session-awareness tool call runs with.
   *
   * `user` is the security boundary, so it is resolved here and never taken
   * from the engine's arguments. A sidebar session carries the account that
   * opened it; a main session's engine has no request behind it, so the
   * account is the one that OWNS this session. When a session has no recorded
   * owner on an instance that has accounts (a pre-accounts or
   * terminal-created session), `user: null` would mean "sees everything" —
   * so it is paired with `restrictToUnowned`, which limits it to other
   * unowned sessions instead of every account's conversations.
   *
   * The main chat gets a larger page than the sidebar's
   * smallest-window-assumption budget: it runs on the model the user picked,
   * and paging a transcript four times to answer one question is its own kind
   * of waste.
   */
  private sessionToolContext(): SessionToolContext {
    const explicit = this.engine.user ?? null;
    const ownerId = explicit === null && this._sessionId ? getSessionOwner(this._sessionId) : null;
    const owner = ownerId === null ? null : findUserById(ownerId);
    const user = explicit ?? owner;
    const livePhases = getLiveSessionPhases();
    const runningSessionIds = new Set(
      [...livePhases].filter(([, phase]) => phase.running).map(([sessionId]) => sessionId),
    );
    return {
      user,
      defaultSessionId: this.engine.contextSessionId ?? (this._sessionId || null),
      runningSessionIds,
      livePhases,
      restrictToUnowned: user === null && hasAnyUser(),
      ...(this.engine.kind === "sidebar" ? {} : { charBudget: MAIN_SESSION_RESULT_CHARS }),
    };
  }

  /**
   * Settle a host_tool_call the UI did not register (or arrived with no
   * attached listener) with an explicit error so its agent turn cannot hang
   * forever waiting for a response. Registered host tools are routed to
   * listeners in handleFrame (see the host_tool_call case).
   */
  private rejectUnexpectedHostTool(event: AgentEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return;
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    this.sendHostToolResult({
      type: "host_tool_result",
      id,
      isError: true,
      result: {
        content: [{
          type: "text",
          text: `Host tool \"${toolName}\" is not available in Cody. Use OMP's built-in tools within the selected workspace.`,
        }],
      },
    });
    this.emit({ type: "notice", level: "warning", message: `Rejected unavailable host tool: ${toolName}` });
  }

  /** Reject every outstanding host tool call (browser disconnected / destroy). */
  private rejectPendingHostTools(message: string): void {
    for (const id of this.pendingHostTools.keys()) {
      this.sendHostToolResult({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
    this.pendingHostTools.clear();
  }

  /** Reject every outstanding host URI request (browser disconnected / destroy). */
  private rejectPendingHostUris(message: string): void {
    for (const id of this.pendingHostUris.keys()) {
      this.proc.sendFrame({
        type: "host_uri_result",
        id,
        isError: true,
        error: message,
      });
    }
    this.pendingHostUris.clear();
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A throwing subscriber (SSE encode failure, UI handler bug) must not
        // starve the remaining subscribers — same isolation RpcProcess and
        // notifyRunningChange apply to their listener sets.
      }
    }
  }

  private sessionFileSignalTimer: NodeJS.Timeout | null = null;

  /** Refresh list metadata and only this session's entry/scan caches when the
   * path is known. A busy session should not force every other open session to
   * re-parse its transcript. */
  private invalidateSessionLists(): void {
    if (this._sessionFile) {
      invalidateSessionListMeta();
      invalidateSessionEntriesCache(this._sessionFile);
    } else {
      invalidateSessionListCache();
    }
  }

  /** Poll briefly for the session file to appear after agent_start, then
   *  invalidate the session-list caches and re-signal the sidebar so the
   *  running session shows up even though the file landed after the first
   *  refresh (see the agent_start case). Bounded (max ~10s) and stops on
   *  destroy. */
  private signalWhenSessionFileAppears(): void {
    if (this.sessionFileSignalTimer) return;
    let attempts = 0;
    const check = () => {
      this.sessionFileSignalTimer = null;
      if (!this._alive || !this._sessionFile) return;
      if (!existsSync(this._sessionFile)) {
        attempts += 1;
        if (attempts < 40) {
          this.sessionFileSignalTimer = setTimeout(check, 250);
        }
        return;
      }
      this.invalidateSessionLists();
      notifyRunningChange({ refreshSessionList: true });
    };
    this.sessionFileSignalTimer = setTimeout(check, 250);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, IDLE_DESTROY_MS);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    const now = Date.now();
    for (const [id, event] of this.pendingUiRequests) {
      const expiresAt = event.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.forgetPendingUiRequest(id);
        continue;
      }
      listener(event);
    }
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      // No UI attached anymore: reject outstanding host tool calls so the
      // agent never waits forever on a tool nobody will answer.
      if (this.listeners.length === 0) {
        this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool");
        this.rejectPendingHostUris("The web UI disconnected while the agent was waiting for this URI request");
      }
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /** Called when a session-changing command re-keyed this wrapper (branch/new_session/switch_session). */
  onIdentityChange(cb: (oldId: string, newId: string) => void): void {
    this.onIdentityChangeCallback = cb;
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  /** Get OMP's own complete MCP inventory and live connection states. */
  async getMcpList(): Promise<string> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (this.isRunning()) throw new WebRpcError("Wait for the current run to finish", "session_busy");
    if (this.mcpListWaiter) throw new WebRpcError("MCP list is already loading", "mcp_list_loading");

    this.promptRunning = true;
    notifyRunningChange();
    let resolveOutput!: (text: string) => void;
    let rejectOutput!: (error: Error) => void;
    const output = new Promise<string>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // The timeout, destroy, and sendCommand-failure paths all reject this
    // promise while the only `await output` (success path) may never run —
    // swallow the orphan so it cannot surface as an unhandledRejection.
    void output.catch(() => {});
    const waiter = {
      resolve: resolveOutput,
      reject: rejectOutput,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    waiter.timer = setTimeout(() => {
        if (this.mcpListWaiter !== waiter) return;
        this.mcpListWaiter = null;
        rejectOutput(new WebRpcError("Timed out while loading MCP servers", "mcp_list_timeout"));
      }, MCP_LIST_TIMEOUT_MS);
    // Don't pin the event loop if the caller never awaits (route aborted): the
    // pending-UI timers already unref, this one should too.
    waiter.timer.unref?.();
    this.mcpListWaiter = waiter;

    try {
      // Bound the transport acknowledgement separately from the command
      // output timeout. A child can accept this prompt frame and then stop
      // responding before it emits command_output; without this cap the
      // wrapper remains busy forever and later MCP refreshes are blocked.
      await this.proc.sendCommand({ type: "prompt", message: "/mcp list" }, PROMPT_ACK_TIMEOUT_MS);
      return await output;
    } catch (error) {
      const expired = error instanceof RpcCommandTimeoutError;
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
        waiter.reject(
          expired
            ? new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive")
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
      }
      if (expired) {
        // No response can settle this child now; recycle it so the next
        // request gets a fresh process instead of inheriting a busy wedge.
        await this.destroyAndWait();
        throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
      }
      throw error;
    } finally {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
      }
      this.promptRunning = false;
      notifyRunningChange();
    }
  }

  private buildWebState(state: RpcSessionState): WebSessionState {
    // Reconcile process-side flags with authoritative child state.
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this._sessionName = state.sessionName;
    if (state.sessionId) {
      this.setSessionId(state.sessionId);
      this._sessionFile = state.sessionFile ?? this._sessionFile;
    }
    return {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile ?? "",
      sessionName: state.sessionName,
      isStreaming: state.isStreaming,
      isPromptRunning: this.promptRunning,
      isBashRunning: this.bashRunning,
      isCompacting: state.isCompacting,
      autoCompactionEnabled: state.autoCompactionEnabled,
      autoRetryEnabled: state.autoRetryEnabled,
      interruptMode: state.interruptMode ?? "immediate",
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      model: state.model
        ? {
            id: state.model.id,
            provider: state.model.provider,
            name: state.model.name,
            reasoning: state.model.reasoning,
            thinking: state.model.thinking ? { efforts: state.model.thinking.efforts } : undefined,
          }
        : undefined,
      messageCount: state.messageCount,
      // pi reports the same number as pendingMessageCount (omp renamed it).
      queuedMessageCount: state.queuedMessageCount ?? state.pendingMessageCount ?? 0,
      contextUsage: state.contextUsage ?? null,
      systemPrompt: state.systemPrompt?.join("\n\n") ?? "",
      thinkingLevel: state.thinkingLevel ?? "off",
      // The child's per-family tier map is authoritative: it changes when the
      // model switches families (isFastModeEnabled is family-scoped) or when
      // the runtime auto-disables priority (e.g. after an Anthropic reject).
      // The wrapper's own flag is only the spawn-time cache.
      fastModeEnabled: state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled,
      fastModeActive: state.fastModeActive,
      todoPhases: state.todoPhases ?? [],
      // Absent when the plan keeper has never touched this session — the
      // client treats that the same as an empty overlay.
      ...(state.sessionId ? { planOverlay: readPlanOverlay(state.sessionId) ?? undefined } : {}),
      extensionStatuses: Array.from(this.extensionStatuses, ([key, text]) => ({ key, text })),
      extensionWidgets: Array.from(this.extensionWidgets.values()),
    };
  }

  /** After branch/new_session/switch_session the child is on a different
   * session file — re-read identity and re-register in the registry. */
  private async refreshIdentityAfterSessionChange(): Promise<string> {
    const oldId = this._sessionId;
    const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" });
    this.applyIdentity(state);
    if (oldId && oldId !== this._sessionId) {
      this.onIdentityChangeCallback?.(oldId, this._sessionId);
    }
    this.invalidateSessionLists();
    return this._sessionId;
  }

  /** Full restart of the child process against the same session file. */
  private async restart(profile: LocalModelProfileLaunch | undefined = this.localProfileLaunch): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    const sessionFile = this._sessionFile;
    const resumable = !!sessionFile && existsSync(sessionFile);
    const old = this.proc;
    this.restarting = true;
    this.unsubscribeFrames?.();
    try {
      await old.dispose();
      if (!this._alive) return;

      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      this.clearPendingUiRequests();
      this.promptRunning = false;
      this.bashRunning = false;
      this.streaming = false;
      this.compacting = false;

      const proc = new RpcProcess({
        cwd: this.cwd,
        launch: this.engine.relaunch(resumable ? sessionFile : "", profile),
        onExit: ({ stderrTail }) => {
          if (this.proc === proc) this.handleProcessExit(stderrTail);
        },
      });
      this.proc = proc;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      try {
        const ready = await proc.waitReady(READY_TIMEOUT_MS);
        await proc.negotiateProtocol(ready);
        if (this.engine.rpcUi.subagentEvents) {
          await proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
        }
        if (this.engine.rpcUi.hostTools) {
          await proc.sendCommand({ type: "set_host_tools", tools: this.hostToolsForCurrentProfile() }).catch(() => {});
          if (this.hostUriSchemeEntries.length) {
            await proc.sendCommand({ type: "set_host_uri_schemes", schemes: this.hostUriSchemeEntries }).catch(() => {});
          }
        }
        const state = await proc.sendCommand<RpcSessionState>({ type: "get_state" });
        this.applyIdentity(state);
        // A sessionless OMP restart can still land on the cwd's latest
        // transcript because OMP may auto-resume during startup. If that file
        // already exists, force a new session before any prompt is accepted.
        if (this.engine.label === "omp" && !resumable && this._sessionFile && existsSync(this._sessionFile)) {
          await proc.sendCommand({ type: "new_session" });
          this.applyIdentity(await proc.sendCommand<RpcSessionState>({ type: "get_state" }));
        }
      } catch (error) {
        this.unsubscribeFrames?.();
        this.unsubscribeFrames = null;
        void proc.dispose();
        this.destroy();
        throw error;
      }
    } finally {
      this.restarting = false;
    }
    notifyRunningChange();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    this.resetIdleTimer();
    const type = command.type as string;

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    const unsupported = UNSUPPORTED_COMMANDS[type];
    if (unsupported) throw new RpcCommandError(type, unsupported, "unsupported");

    // Engines with a restricted RPC vocabulary (pi) must never be sent a
    // command outside it: they answer unknown commands with an ID-LESS error
    // response, which can never settle the pending request — a silent hang.
    // Rejecting here surfaces the honest "unsupported" the UI already
    // tolerates. Commands the wrapper settles locally are exempt.
    const engineCommands = this.engine.rpcUi.commands;
    if (engineCommands && !engineCommands.has(type) && !LOCAL_WRAPPER_COMMANDS.has(type)) {
      throw new RpcCommandError(type, `${type} is not supported by this engine's RPC protocol`, "unsupported");
    }

    switch (type) {
      case "prompt": {
        if (this.bashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        if (!streamingBehavior) {
          this.promptRunning = true;
          notifyRunningChange();
        }
        try {
          // omp acks immediately; agent output streams as events, completion is
          // agent_end (agent runs) or prompt_result (local-only slash commands).
          const ack = await this.proc.sendCommand<{ agentInvoked?: boolean } | undefined>({
            type: "prompt",
            message: command.message as string,
            ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
          }, PROMPT_ACK_TIMEOUT_MS);
          // Slash commands fully consumed by a builtin report agentInvoked:false
          // in the ack itself — no prompt_result frame follows.
          if (ack?.agentInvoked === false && !streamingBehavior) {
            this.promptRunning = false;
            this.emit({ type: "prompt_result", agentInvoked: false });
            notifyRunningChange();
          }
        } catch (error) {
          this.promptRunning = false;
          notifyRunningChange();
          if (error instanceof RpcCommandTimeoutError) {
            // The child took the frame but never acked it, so nothing will ever
            // report this run: recycle it exactly like the mcp-list timeout
            // path so the next request spawns a fresh child instead of talking
            // to a wedged one.
            await this.destroyAndWait();
            throw new WebRpcError("The session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        }
        return null;
      }

      case "steer":
      case "follow_up": {
        await this.proc.sendCommand({
          type,
          message: command.message as string,
          ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
        });
        return null;
      }

      case "abort":
        await this.withFinalRunningNotification(async () => {
          await this.proc.sendCommand({ type: "abort" });
          // If the prompt was aborted before the agent loop started, no
          // agent_end will arrive to clear the flag; the streaming flag still
          // tracks a live turn that ends with its own agent_end.
          this.promptRunning = false;
        });
        return null;

      case "get_state": {
        const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" });
        return this.buildWebState(state);
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const localSelection = validateLocalRoutingModelSelection(this._sessionId, provider, modelId);
        if (!localSelection.allowed) throw new WebRpcError(localSelection.reason, "local_routing_forbidden");
        const targetResolution = resolveLocalModelPromptProfile({ provider, modelId });
        const targetProfile = materializeLocalModelProfile(targetResolution);
        if (this.localProfileNeedsRestart(targetProfile) && this.isRunning()) {
          throw new WebRpcError("Wait for the current provider or tool operation to finish before changing its prompt profile.", "session_busy");
        }
        const model = await this.proc.sendCommand<OmpModel>({ type: "set_model", provider, modelId });
        await this.synchronizeLocalModelProfile(model);
        invalidateModelsCache();
        this.invalidateSessionLists();
        return { id: model.id, provider: model.provider };
      }

      case "set_fast_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean; active?: boolean }>({ type: "set_fast_mode", enabled });
        this.fastModeEnabled = result?.enabled ?? enabled;
        return { enabled: this.fastModeEnabled, active: result?.active ?? false };
      }

      case "fork": {
        // omp's `branch` is pi-web's fork: it creates a branched session file
        // and switches this live process onto it (entryId must be a user
        // message entry, matching the web UI's fork buttons).
        if (this.bashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const parentSessionId = this._sessionId;
        const result = await this.proc.sendCommand<{ text: string; cancelled: boolean }>({
          type: "branch",
          entryId: command.entryId as string,
        });
        if (result.cancelled) return { cancelled: true };
        const newSessionId = await this.refreshIdentityAfterSessionChange();
        // A branch keeps its parent resumable, so clone rather than move the
        // frozen Local-only snapshot and account ownership sidecars.
        copySessionLocalRouting(parentSessionId, newSessionId);
        copySessionPreset(parentSessionId, newSessionId);
        const owner = getSessionOwner(parentSessionId);
        if (owner) setSessionOwner(newSessionId, owner);
        return { cancelled: false, newSessionId };
      }

      case "new_session":
      case "switch_session": {
        const result = await this.proc.sendCommand<{ cancelled: boolean }>(command as { type: string });
        if (!result.cancelled) {
          const newSessionId = await this.refreshIdentityAfterSessionChange();
          return { cancelled: false, newSessionId };
        }
        return result;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(async () => {
            this.compacting = true;
            notifyRunningChange();
            try {
              const result = await this.proc.sendCommand<CompactionResultLike>({
                type: "compact",
                ...(command.customInstructions ? { customInstructions: command.customInstructions } : {}),
              });
              patchEstimatedTokensAfter(result);
              return result;
            } finally {
              this.compacting = false;
            }
          });
        } finally {
          this.invalidateSessionLists();
        }
      }

      case "abort_compaction":
        // No dedicated RPC command; a plain abort cancels the in-flight turn
        // including compaction work.
        await this.withFinalRunningNotification(() => this.proc.sendCommand({ type: "abort" }));
        return null;

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.proc.sendCommand({ type: "set_session_name", name });
        this._sessionName = name;
        this.invalidateSessionLists();
        return null;
      }

      case "get_session_stats": {
        const stats = await this.proc.sendCommand<Omit<SessionStatsInfo, "sessionName">>({ type: "get_session_stats" });
        return { ...stats, sessionName: this._sessionName };
      }

      case "get_last_assistant_text": {
        const data = await this.proc.sendCommand<{ text: string | null }>({ type: "get_last_assistant_text" });
        return { text: data.text ?? "" };
      }

      case "get_commands": {
        const data = await this.proc.sendCommand<{ commands: RpcAvailableSlashCommand[] }>({
          type: "get_available_commands",
        });
        return data;
      }

      case "reload": {
        await this.restart();
        return { success: true };
      }

      case "extension_ui_response": {
        const { id, ...rest } = command as { id: string; [key: string]: unknown };
        this.forgetPendingUiRequest(id);
        this.proc.sendFrame({ type: "extension_ui_response", id, ...rest });
        return null;
      }

      case "bash": {
        // The rpc dialect's bash command is `{type:"bash", command}` only
        // (rpc-types.ts) — there is no excludeFromContext option anywhere in
        // modes/rpc. Running a `!!` command anyway would put output the user
        // meant to keep private into the model context, so refuse instead of
        // silently ignoring it.
        if (command.excludeFromContext === true) {
          throw new WebRpcError(bashExcludeMessage(this.engine.label), "bash_exclude_unsupported");
        }
        if (this.isRunning()) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        this.bashRunning = true;
        notifyRunningChange();
        try {
          return await this.proc.sendCommand<BashResultInfo>({ type: "bash", command: command.command as string });
        } finally {
          this.bashRunning = false;
          this.invalidateSessionLists();
          notifyRunningChange();
        }
      }

      case "set_host_tools": {
        const tools = Array.isArray(command.tools) ? command.tools as Array<{ name?: unknown; [key: string]: unknown }> : [];
        const valid = tools.filter((t) => typeof t.name === "string" && t.name && !SERVER_HOST_TOOL_NAMES.has(t.name as string));
        this.hostToolNames = new Set(valid.map((t) => t.name as string));
        this.hostTools = valid;
        if (this.engine.rpcUi.hostTools) {
          await this.proc.sendCommand({ type: "set_host_tools", tools: this.hostToolsForCurrentProfile() });
        }
        return null;
      }

      case "host_tool_result": {
        if (typeof command.id === "string") this.pendingHostTools.delete(command.id);
        this.sendHostToolResult(command as RpcFrame);
        return null;
      }

      case "set_host_uri_schemes": {
        const schemes = Array.isArray(command.schemes) ? command.schemes as Array<{ scheme?: unknown; writable?: unknown; [key: string]: unknown }> : [];
        this.hostUriSchemes = new Map();
        for (const entry of schemes) {
          if (typeof entry.scheme === "string" && entry.scheme) {
            this.hostUriSchemes.set(entry.scheme, { writable: entry.writable === true });
          }
        }
        this.hostUriSchemeEntries = schemes;
        if (this.engine.rpcUi.hostTools) {
          await this.proc.sendCommand({ type: "set_host_uri_schemes", schemes });
        }
        return null;
      }

      case "host_uri_result": {
        if (typeof command.id === "string") this.pendingHostUris.delete(command.id);
        this.proc.sendFrame(command as { type: string; [key: string]: unknown });
        return null;
      }

      default: {
        if (PASSTHROUGH_COMMANDS.has(type)) {
          const result: unknown = await this.proc.sendCommand(command as { type: string });
          if (type === "set_thinking_level") this.invalidateSessionLists();
          return result ?? null;
        }
        // The same honest "unsupported" the restricted-vocabulary gate above
        // gives: a command Cody never mapped for this dialect is not a server
        // fault, and the UI already fails soft on the code.
        throw new RpcCommandError(type, `${type} is not supported by this engine's RPC protocol`, "unsupported");
      }
    }
  }

  destroy(): void {
    void this.destroyAndWait();
  }

  /** Destroy and resolve only after the omp child has fully exited. Callers
   * that delete the session file afterwards must await this — omp flushes
   * session state on shutdown and would otherwise recreate the file. */
  async destroyAndWait(): Promise<void> {
    // Re-entrant calls join the in-flight dispose; without this a new spawn
    // can overlap the old child's shutdown (see startRpcSession).
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sessionFileSignalTimer) {
      clearTimeout(this.sessionFileSignalTimer);
      this.sessionFileSignalTimer = null;
    }
    this.planKeeper?.dispose();
    this.deviceWatch?.();
    this.deviceWatch = null;
    this.operationWatch?.();
    this.operationWatch = null;
    this.unsubscribeFrames?.();
    this.clearPendingUiRequests();
    if (this.mcpListWaiter) {
      clearTimeout(this.mcpListWaiter.timer);
      this.mcpListWaiter.reject(new Error("Session was closed while loading MCP servers"));
      this.mcpListWaiter = null;
    }
    const disposed = this.proc.dispose().catch(() => {});
    this.destroyPromise = disposed;
    this.pendingHostTools.clear();
    this.hostToolNames.clear();
    this.pendingHostUris.clear();
    this.hostUriSchemes.clear();
    this.onDestroyCallback?.();
    notifyRunningChange();
    await disposed;
  }
}

// ============================================================================
// Session registry
// ============================================================================
export interface RunningSessionUpdate {
  ids: string[];
  refreshSessionList: boolean;
}

/**
 * The registry holds EngineSession, not AgentSessionWrapper: omp's wrapper is
 * one implementation of that interface (structurally — it is never declared
 * `implements`), and a non-omp engine's TurnEngineSession is another. Routes
 * that need omp-only surface (getMcpList) narrow with `instanceof
 * AgentSessionWrapper` or gate on the active engine's capabilities.
 */
declare global {
  var __ompSessions: Map<string, EngineSession> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: EngineSession; realSessionId: string }>> | undefined;
  var __ompRunningListeners: Set<(update: RunningSessionUpdate) => void> | undefined;
}

function getRegistry(): Map<string, EngineSession> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => globalThis.__ompSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: EngineSession; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

export function getRpcSession(sessionId: string): EngineSession | undefined {
  return getRegistry().get(sessionId);
}

export function getLocalModelProfileApplication(sessionId: string): { provider: string; modelId: string; profileId: PromptProfileId } | undefined {
  const session = getRegistry().get(sessionId);
  return session instanceof AgentSessionWrapper ? session.localModelProfileApplication() : undefined;
}

/** Restart after a routing preference change only if no provider/tool work runs. */
export async function restartSessionForRouting(sessionId: string): Promise<{ restarted: boolean; active: boolean }> {
  const session = getRegistry().get(sessionId);
  if (!(session instanceof AgentSessionWrapper)) return { restarted: false, active: false };
  if (session.isRunning()) return { restarted: false, active: true };
  const restarted = await session.restartForRouting();
  return { restarted, active: !restarted };
}

/** Restart onto changed persisted overlays now if idle, or when the running
 * turn ends — for a change the chat did not ask for itself (an edited preset). */
export async function restartSessionForRoutingWhenIdle(sessionId: string): Promise<{ restarted: boolean; active: boolean }> {
  const session = getRegistry().get(sessionId);
  if (!(session instanceof AgentSessionWrapper)) return { restarted: false, active: false };
  return session.restartForRoutingWhenIdle();
}

/**
 * Every live session's phase, keyed by session id — the source both the
 * omp host-tool path and the internal route the ACP bridge posts to read, so
 * a status report says the same thing whichever engine asked for it.
 *
 * An engine that cannot break "running" down (every ACP session) contributes
 * the one fact it has rather than a fabricated breakdown.
 */
export function getLiveSessionPhases(): Map<string, SessionLivePhase> {
  const phases = new Map<string, SessionLivePhase>();
  for (const [registeredId, session] of getRegistry()) {
    const running = session.isRunning();
    phases.set(session.sessionId || registeredId, session.livePhase?.() ?? {
      running,
      streaming: false,
      promptRunning: running,
      bashRunning: false,
      compacting: false,
    });
  }
  return phases;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/** Stop all live omp children after an explicit runtime update. The browser will
 * reconnect sessions on demand and start them with the updated executable. */
export async function restartAllRpcSessions(): Promise<number> {
  // A start registers its session only AFTER the child reports ready, so a
  // registry snapshot taken here misses one that is still booting. That child
  // was launched for the OUTGOING engine: it would finish a moment later, run
  // the whole turn on the old engine's credentials and write the old engine's
  // transcript, while Cody reports the new engine as active — and it would be
  // unreachable from the UI, because the session listing under the new engine
  // never includes it. Settling the in-flight starts first brings them into
  // the registry so the teardown below can actually reach them.
  //
  // allSettled, not all: a start that FAILS is not a reason to abandon the
  // teardown of every session that started fine.
  await Promise.allSettled([...getLocks().values()]);
  const sessions = [...new Set(getRegistry().values())];
  await Promise.all(sessions.map((session) => session.destroyAndWait()));
  return sessions.length;
}

/** Stop live omp children that are NOT mid-run, so they come back with freshly
 * saved config (model roles, fallback chains) on the next command. Running
 * sessions are left alone — killing an active turn to apply settings would be
 * worse than one turn on the previous config — and they pick the change up
 * when their run ends and the child is next restarted. */
export async function restartIdleRpcSessions(): Promise<{ restarted: number; active: number }> {
  const sessions = [...new Set(getRegistry().values())];
  const idle = sessions.filter((session) => !session.isRunning());
  await Promise.all(idle.map((session) => session.destroyAndWait()));
  return { restarted: idle.length, active: sessions.length - idle.length };
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(update: RunningSessionUpdate) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes and session-list refreshes. */
export function subscribeRunningSessions(listener: (update: RunningSessionUpdate) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, when it changes, broadcast it.
 * A session file may first appear after its id starts running, so callers can
 * force one otherwise-identical update to refresh sidebar session metadata.
 */
export function notifyRunningChange({ refreshSessionList = false }: { refreshSessionList?: boolean } = {}): void {
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot && !refreshSessionList) return;
  lastRunningSnapshot = snapshot;
  const update = { ids, refreshSessionList };
  for (const listener of getRunningListeners()) {
    try { listener(update); } catch { /* ignore listener errors */ }
  }
}

/**
 * Start a live session for a non-omp engine (the adapter supplies the factory).
 * Registration mirrors the omp path exactly — same registry keys, same
 * onDestroy/onIdentityChange bookkeeping — so every consumer of getRpcSession
 * behaves the same whichever engine is active.
 */
async function startEngineSession(
  create: (options: EngineSessionOptions) => EngineSession,
  sessionId: string,
  cwd: string,
): Promise<{ session: EngineSession; realSessionId: string }> {
  const registry = getRegistry();
  const created = create({ sessionId, cwd });
  created.start();
  await created.waitUntilReady();

  const realSessionId = created.sessionId;
  created.onDestroy(() => {
    if (registry.get(created.sessionId) === created) registry.delete(created.sessionId);
    if (registry.get(realSessionId) === created) registry.delete(realSessionId);
    notifyRunningChange();
  });
  created.onIdentityChange((oldId, newId) => {
    if (registry.get(oldId) === created) registry.delete(oldId);
    registry.set(newId, created);
    // The ownership row was stamped under the creation-time id; move it or
    // the session becomes "unowned" — visible to every account — as soon as
    // the engine announces its real id (Codex thread ids arrive mid-turn).
    renameSessionOwner(oldId, newId);
    aliasDisplaySession(oldId, newId);
  });
  // A turn-based engine has no frame pipeline calling notifyRunningChange the
  // way handleFrame does for omp, so drive the sidebar's running indicator (and
  // its session-list refresh) off the engine's own turn boundaries.
  created.onEvent((event) => {
    if (event.type === "agent_start" || event.type === "agent_end") {
      notifyRunningChange({ refreshSessionList: true });
    }
  });
  registry.set(realSessionId, created);
  notifyRunningChange();
  return { session: created, realSessionId };
}

/**
 * Get or create the omp RPC process for the given session.
 * For a new session (`sessionFile === ""`), omp generates its own id.
 * `profileTarget` is applied before its first provider request.
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  advisor = false,
  engineSessionId?: string,
  profileTarget?: ModelProfileTarget,
  kind?: "sidebar",
  /** Sidebar only. Its context tools read the workspace and, by default, the
   * main chat session named here, gated by this account's ownership. Passed
   * as an object rather than two more positional arguments: this signature is
   * already eight deep. */
  sidebar?: { contextSessionId?: string | null; user?: UserRecord | null },
): Promise<{ session: EngineSession; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };
  if (existing?.destroyPromise) await existing.destroyPromise;

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const harness = getHarness();
  const launchedFor = harness.id;
  const createEngineSession = harness.createSession?.bind(harness);

  const starting = (async () => {
    if (createEngineSession) {
      return startEngineSession(createEngineSession, engineSessionId ?? sessionId, cwd);
    }
    const initialResolution = profileTarget ? resolveLocalModelPromptProfile(profileTarget) : undefined;
    const initialProfile = initialResolution ? materializeLocalModelProfile(initialResolution) : undefined;
    const launchProfile = launchWithSessionOverlays(initialProfile, sessionId);
    const holder: { wrapper?: AgentSessionWrapper; renamed: boolean } = { renamed: false };
    const proc = new RpcProcess({
      cwd,
      launch: buildEngineRpcLaunch(harness, { cwd, sessionFile, toolNames, advisor, profile: launchProfile, kind }),
      onExit: ({ stderrTail }) => holder.wrapper?.handleProcessExit(stderrTail),
    });
    const created = new AgentSessionWrapper(proc, cwd, {
      rpcUi: harness.rpcUi!,
      label: harness.binaryName,
      initialProfile: launchProfile,
      initialResolution,
      relaunch: (file, profile) => buildEngineRpcLaunch(harness, {
        cwd,
        sessionFile: file,
        // Until the rename below moves the temp-key binding onto the real id,
        // a relaunch (synchronizeLocalModelProfile's startup sync, in
        // particular) must keep resolving preset/Local-only overlays by the
        // temp key: the wrapper's own sessionId flips to the real id the
        // moment identity is known (waitUntilReady), well before the rename
        // call below runs, so reading by sessionId here would silently miss
        // a binding that is still filed under the temp key.
        profile: launchWithSessionOverlays(profile, holder.renamed ? (holder.wrapper?.sessionId || sessionId) : sessionId),
        kind,
      }),
      kind,
      // The sidebar's child runs from a bare cwd, so its context tools need
      // the real workspace separately, plus the main session `read_session`
      // defaults to and the account whose sessions it may read.
      ...(kind === "sidebar" ? { contextCwd: cwd, contextSessionId: sidebar?.contextSessionId ?? null, user: sidebar?.user ?? null } : {}),
    });
    holder.wrapper = created;
    created.start();
    try {
      await created.waitUntilReady();
      if (!profileTarget) await created.synchronizeLocalModelProfile();
      // The fresh-session path must not be allowed to inherit OMP's latest
      // conversation when startup auto-resume is enabled. A newly-created
      // session file is written lazily, so existence is the resume signal.
      if (harness.id === "omp" && !sessionFile && created.sessionFile && existsSync(created.sessionFile)) {
        await created.send({ type: "new_session" });
      }
    } catch (error) {
      // Await the child's full exit before the `finally` releases the startup
      // lock: a fire-and-forget destroy() would let a retry spawn a second
      // OMP child while the failed one is still flushing/exiting, and
      // concurrent resume/delete/archive paths could race that old child.
      await created.destroyAndWait();
      throw error;
    }

    // The engine can be switched while this child was booting. Registering it
    // now would file a child of the PREVIOUS engine under the current one,
    // which is the same leak the fence in restartAllRpcSessions closes from
    // the other side — kept here too because this is the only check that
    // holds for a start which finishes after that teardown has run.
    if (getHarness().id !== launchedFor) {
      await created.destroyAndWait();
      throw new WebRpcError(
        `The ${launchedFor} engine was switched away while this session was starting.`,
        "engine_changed",
      );
    }

    const realSessionId = created.sessionId;
    if (sessionId !== realSessionId) {
      // New OMP sessions receive their durable id only after launch. This is a
      // rename, unlike a fork: the temporary id has no resumable parent.
      renameSessionOwner(sessionId, realSessionId);
      renameSessionLocalRouting(sessionId, realSessionId);
      renameSessionPreset(sessionId, realSessionId);
      aliasDisplaySession(sessionId, realSessionId);
    }
    holder.renamed = true;
    created.onDestroy(() => {
      if (registry.get(created.sessionId) === created) registry.delete(created.sessionId);
      if (registry.get(realSessionId) === created) registry.delete(realSessionId);
    });
    created.onIdentityChange((oldId, newId) => {
      if (registry.get(oldId) === created) registry.delete(oldId);
      registry.set(newId, created);
    });
    registry.set(realSessionId, created);
    return { session: created, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
