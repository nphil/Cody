import { existsSync } from "fs";
import { homedir } from "os";
import { renameSessionOwner } from "./auth/session-owners";
import { aliasDisplaySession, publishDisplayRequest } from "./display/bus";
import { isLoopbackHost } from "./display/ladder";
import { getHarness } from "./harness";
import type { EngineSession, EngineSessionOptions, HarnessAdapter, RpcUiSpawn } from "./harness/types";
import { validateAgentImages } from "./image-attachments";
import { APP_LOG_SHADOW_NOTE, DEFAULT_LIMIT, MAX_LIMIT, appLogNotice, formatAppLogDigest, markAppLogsRead, parseSince, readAppLogs } from "./logs/ring";
import { APP_LOG_LEVELS, type AppLogQuery } from "./logs/types";
import { invalidateModelsCache } from "./models-cache";
import { MAX_RPC_FRAME_BYTES } from "./omp/rpc-frame";
import { RpcCommandError, RpcProcess, type RpcFrame, type RpcProcessLaunch } from "./omp/rpc-process";
import { readNativeSettings } from "./omp/settings-config";
import { captureLoopbackScreenshot, ScreenshotError } from "./preview-screenshot";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { PRESET_FULL } from "./tool-presets";
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
 * Host tools implemented by the Cody SERVER rather than the browser: they
 * ride along every set_host_tools registration and settle in handleFrame with
 * no attached UI required. preview_screenshot renders a loopback URL in a
 * headless Chromium where the dev server actually runs, so the model can SEE
 * its work — including with every browser tab closed. open_preview publishes
 * a display request on the session bus (lib/display/bus.ts), auto-opening
 * Cody's Preview panel over SSE for any watching browser. read_app_logs hands
 * back the previewed app's own console and failed requests (lib/logs), so a
 * dev server throwing in the browser is something the model can read instead
 * of something only the user ever sees.
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
}];
const SERVER_HOST_TOOL_NAMES = new Set(SERVER_HOST_TOOLS.map((tool) => tool.name));
const MCP_LIST_TIMEOUT_MS = 15_000;

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
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: string[], advisor = false, flags: RpcSpawnFlags = OMP_SPAWN_FLAGS): string[] {
  const args: string[] = [];
  if (sessionFile) {
    // An absolute path (or anything containing "/") resolves deterministically:
    // omp's createSessionManager opens it directly via SessionManager.open
    // without any interactive resume/fork prompts (main.ts resume handling).
    // pi's --session flag has the same SessionManager.open semantics.
    args.push(flags.resumeFlag, sessionFile);
  } else if (toolNames !== undefined) {
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
  return args;
}

/**
 * Complete launch (binary + argv + readiness) for an rpc-dialect engine
 * session — the harness's RpcUiSpawn descriptor decides the CLI surface.
 * `sessionFile: ""` means a brand-new session.
 */
export function buildEngineRpcLaunch(
  harness: HarnessAdapter,
  opts: { cwd: string; sessionFile: string; toolNames?: string[]; advisor?: boolean },
): RpcProcessLaunch {
  const spec = harness.rpcUi;
  if (!spec) {
    throw new WebRpcError(`${harness.displayName} does not speak the RPC session protocol`, "engine_mismatch");
  }
  const bin = harness.resolveBinary();
  if (!bin) {
    throw new WebRpcError(
      `${harness.binaryName} binary not found. Install ${harness.displayName} from Settings → User Accounts → Agent engine, or set CODY_${harness.binaryName.toUpperCase()}_BIN.`,
      "engine_not_installed",
    );
  }
  const args = ["--mode", spec.mode];
  // Engines without a --cwd flag (pi) inherit the spawn cwd, which RpcProcess
  // always sets; passing the flag anyway would be silently swallowed.
  if (spec.supportsCwdFlag) args.push("--cwd", opts.cwd);
  args.push(...buildSessionSpawnArgs(opts.sessionFile, opts.toolNames, opts.advisor === true, spec));
  return { bin, label: harness.binaryName, args, readiness: spec.readiness };
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
 * codex, hermes) THROWS `unsupported` rather than returning `undefined`.
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
      `${harness.binaryName} binary not found. Install ${harness.displayName} from Settings → User Accounts → Agent engine.`,
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

// ============================================================================
// AgentSessionWrapper
// Wraps one spawned rpc-dialect engine process (`omp --mode rpc-ui`,
// `pi --mode rpc`) with the interface the rest of the app expects (same
// command surface pi-web's in-process wrapper offered).
// ============================================================================

/** Engine facts a wrapper needs beyond the live process: the CLI descriptor
 * (command gating, host-tool/subagent availability) and how to rebuild the
 * launch for an in-place restart (`reload`). */
export interface WrapperEngineContext {
  rpcUi: RpcUiSpawn;
  /** Engine name for user-facing messages ("omp", "pi"). */
  label: string;
  /** Rebuilds the launch for a restart; "" means start a fresh session. */
  relaunch: (sessionFile: string) => RpcProcessLaunch;
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
  private compacting = false;
  private fastModeEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string) => void) | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private restarting = false;
  private mcpListWaiter: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private _alive = true;
  /** Host tools the web UI registered via set_host_tools (agent-callable). */
  private hostToolNames: Set<string> = new Set();
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools: Map<string, AgentEvent> = new Map();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, AgentEvent> = new Map();
  /** Resolves once an in-flight destroyAndWait finishes; null when idle. Read
   * by startRpcSession so a replacement spawn awaits the old child's exit. */
  destroyPromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private _sessionName: string | undefined;
  private proc: RpcProcess;
  readonly cwd: string;

  private readonly engine: WrapperEngineContext;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode for probes/tests.
  constructor(proc: RpcProcess, cwd: string, engine: WrapperEngineContext) {
    this.proc = proc;
    this.cwd = cwd;
    this.engine = engine;
  }

  get sessionId(): string {
    return this._sessionId;
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
    // Server-implemented host tools are available from the first turn, no
    // browser needed; a later UI set_host_tools re-sends them merged. Older
    // omp builds without host tools degrade silently; engines without the
    // host-tool surface (pi) are never asked.
    if (this.engine.rpcUi.hostTools) {
      await this.proc.sendCommand({ type: "set_host_tools", tools: [...SERVER_HOST_TOOLS] }).catch(() => {});
    }
    const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" });
    this.applyIdentity(state);
  }

  private applyIdentity(state: RpcSessionState): void {
    this._sessionId = state.sessionId;
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
        // The session file can appear just after the prompt acknowledgement.
        // Invalidate and signal the sidebar now rather than waiting for the
        // agent's first reply or terminal event.
        invalidateSessionListCache();
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
          invalidateSessionListCache();
        }
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
        invalidateSessionListCache();
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        invalidateSessionListCache();
        refreshSessionList = true;
        break;
      case "response": {
        // Unsolicited failed responses surface async prompt failures (omp
        // reuses the original command id after the immediate ack).
        if (event.success === false && event.command === "prompt") {
          this.promptRunning = false;
          this.emit({ type: "prompt_error", errorMessage: (event.error as string) ?? "Prompt failed" });
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
      invalidateSessionListCache();
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
      await this.proc.sendCommand({ type: "prompt", message: "/mcp list" });
      return await output;
    } catch (error) {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
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
      this._sessionId = state.sessionId;
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
    invalidateSessionListCache();
    return this._sessionId;
  }

  /** Full restart of the child process against the same session file. This is
   * Cody's `reload`: extensions, skills, prompts, and tools are rediscovered
   * on boot, matching a fresh CLI launch. */
  private async restart(): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    const sessionFile = this._sessionFile;
    const resumable = !!sessionFile && existsSync(sessionFile);
    const old = this.proc;
    // Stays true for the whole restart so send() rejects commands that would
    // otherwise hit the disposed or half-built child.
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
        launch: this.engine.relaunch(resumable ? sessionFile : ""),
        onExit: ({ stderrTail }) => {
          if (this.proc === proc) this.handleProcessExit(stderrTail);
        },
      });
      this.proc = proc;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      try {
        const ready = await proc.waitReady(READY_TIMEOUT_MS);
        await proc.negotiateProtocol(ready);
        // The replacement process starts with subscriptions disabled; restore
        // the live roster/transcript event stream before reading its state.
        // Engines without the subagent surface (pi) are never asked.
        if (this.engine.rpcUi.subagentEvents) {
          await proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
        }
        const state = await proc.sendCommand<RpcSessionState>({ type: "get_state" });
        this.applyIdentity(state);
      } catch (error) {
        // Never leave the replacement running with nobody reading its frames.
        this.unsubscribeFrames?.();
        this.unsubscribeFrames = null;
        void proc.dispose();
        // The wrapper has no usable child left; drop it from the registry so the
        // next request starts a fresh session instead of reusing a corpse.
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
          });
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
        const model = await this.proc.sendCommand<OmpModel>({ type: "set_model", provider, modelId });
        invalidateModelsCache();
        invalidateSessionListCache();
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
        const result = await this.proc.sendCommand<{ text: string; cancelled: boolean }>({
          type: "branch",
          entryId: command.entryId as string,
        });
        if (result.cancelled) return { cancelled: true };
        const newSessionId = await this.refreshIdentityAfterSessionChange();
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
          invalidateSessionListCache();
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
        invalidateSessionListCache();
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
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "set_host_tools": {
        const tools = Array.isArray(command.tools) ? command.tools as Array<{ name?: unknown; [key: string]: unknown }> : [];
        // A server tool name in the UI's list would shadow the server
        // implementation — the server one wins.
        const valid = tools.filter((t) => typeof t.name === "string" && t.name && !SERVER_HOST_TOOL_NAMES.has(t.name as string));
        this.hostToolNames = new Set(valid.map((t) => t.name as string));
        // Server-implemented tools ride every registration: omp replaces the
        // whole roster per set_host_tools, so a UI re-register (SSE
        // reconnect) must never drop them. Engines without the host-tool
        // surface (pi) accept the registration locally but are never told —
        // they could not call the tools anyway.
        if (this.engine.rpcUi.hostTools) {
          await this.proc.sendCommand({ type: "set_host_tools", tools: [...valid, ...SERVER_HOST_TOOLS] });
        }
        return null;
      }

      case "host_tool_result": {
        if (typeof command.id === "string") this.pendingHostTools.delete(command.id);
        // Browser-answered host tools can carry big payloads too (a UI
        // screenshot, a file read): guard the same way, keeping the id, so an
        // undeliverable answer still settles the call.
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
          if (type === "set_thinking_level") invalidateSessionListCache();
          return result ?? null;
        }
        throw new Error(`Unsupported command: ${type}`);
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
 * For new sessions (sessionFile === ""), omp generates its own id.
 * Pass toolNames to pre-configure the builtin toolset of a NEW session
 * (empty array = all tools disabled); ignored when resuming.
 *
 * When the active engine is not omp (it supplies `createSession`), the spawn
 * branches to that engine's own session implementation: `sessionFile`,
 * `toolNames` and `advisor` are omp-only and ignored, and `engineSessionId`
 * carries the Cody session id to resume ("" mints a brand-new one, the way
 * `sessionFile: ""` does for omp). It defaults to `sessionId`, which is right
 * for every caller that resumes an existing session by id.
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  advisor = false,
  engineSessionId?: string,
): Promise<{ session: EngineSession; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };
  // A wrapper whose omp child is still flushing/exiting must fully dispose
  // before a replacement spawns — two children touching the same .jsonl would
  // race on resume/delete/archive.
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
    // The wrapper needs the process and the process's onExit needs the wrapper;
    // the holder breaks that cycle (onExit only fires once the child dies).
    const holder: { wrapper?: AgentSessionWrapper } = {};
    const proc = new RpcProcess({
      cwd,
      launch: buildEngineRpcLaunch(harness, { cwd, sessionFile, toolNames, advisor }),
      onExit: ({ stderrTail }) => holder.wrapper?.handleProcessExit(stderrTail),
    });
    const created = new AgentSessionWrapper(proc, cwd, {
      // Non-null: buildEngineRpcLaunch above already threw for descriptor-less
      // engines, so this wrapper only exists for rpc-dialect harnesses.
      rpcUi: harness.rpcUi!,
      label: harness.binaryName,
      // Restart (`reload`) re-resolves the binary so an engine updated
      // mid-session restarts onto the new install; presets/advisor are
      // resume-only concerns and never apply to a restart.
      relaunch: (file) => buildEngineRpcLaunch(harness, { cwd, sessionFile: file }),
    });
    holder.wrapper = created;
    created.start();
    try {
      await created.waitUntilReady();
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
