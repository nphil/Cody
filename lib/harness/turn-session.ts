import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { createInterface } from "readline";
import type { AgentMessage } from "../types";
import type { WebSessionState } from "../pi-types";
import { buildClaudeTurnArgv, createClaudeTurnState, translateClaudeLine } from "./claude-stream";
import { buildCodexTurnArgv, createCodexTurnState, translateCodexLine } from "./codex-stream";
import { resolveEngineBin } from "./engine-bin";
import { claudeDisplayMcpConfig, codexDisplayMcpArgs } from "../display/engine-tools";
import { engineSessionTitle, getEngineSession, renameEngineSession, upsertEngineSession } from "./engine-sessions";
import type { EngineEvent, EngineSession, EngineSessionOptions } from "./types";

/**
 * Live chat for engines whose CLI runs ONE TURN PER PROCESS.
 *
 * omp keeps a long-lived `--mode rpc-ui` child and speaks a bidirectional
 * protocol with it (lib/rpc-manager.ts). Claude Code and Codex have no such
 * mode: each prompt is a fresh `claude -p …` / `codex exec …` process that
 * streams NDJSON and exits, and continuity comes from passing the engine's own
 * session id back on the next turn. This class is that pattern, factored once:
 *
 *   send({type:"prompt"}) → emit agent_start + the user echo → spawn a child →
 *   translate every stdout line into pi-vocabulary events → on exit emit a
 *   terminal agent_end (plus an error notice when the child failed).
 *
 * Everything the omp protocol offers beyond prompt/abort/state/messages
 * (forking, compaction, steering, thinking levels, model switching, host
 * tools…) throws with code "unsupported" — the same contract rpc-manager's
 * UNSUPPORTED_COMMANDS map already established, which the UI tolerates.
 */

/** Cody-side failure with a stable snake_case code, forwarded by the agent API
 * routes as `{error, code}` exactly like rpc-manager's WebRpcError. Defined
 * locally on purpose: lib/harness must not depend on lib/rpc-manager. */
export class EngineCommandError extends Error {
  readonly command: string;
  readonly code: string;

  constructor(command: string, message: string, code: string) {
    super(message);
    this.name = "EngineCommandError";
    this.command = command;
    this.code = code;
  }
}

/**
 * Per-turn translator state. The engine stream modules own the frame shapes;
 * this is the mutable scratchpad they read and write while a turn runs, and
 * the channel through which identity (engine session id) and model reach the
 * session afterwards.
 */
export interface TurnStreamState {
  /** Engine-native session id seen in the stream (claude init / codex thread). */
  engineSessionId: string | null;
  /** Model the engine reported for this turn, when it reports one at all. */
  model: string | null;
  /** Provider label stamped onto synthesized assistant messages. */
  provider: string;
  /** Model label used until/unless the engine names one. */
  modelFallback: string;
  /** Text accumulated for the assistant message currently streaming. */
  text: string;
  /** Reasoning accumulated for the assistant message currently streaming. */
  thinking: string;
  /** True once message_start was emitted for the streaming assistant message. */
  streaming: boolean;
  /** toolCallId → toolName, so a result frame can name the call it answers. */
  toolNames: Map<string, string>;
  /** toolCallIds already announced with tool_execution_start. */
  startedTools: Set<string>;
  /** Usage/cost payload from the engine's terminal frame, when present. */
  usage: Record<string, unknown> | null;
  /** Failure text from the engine's own frames; surfaced as an error notice. */
  errorMessage: string | null;
}

export interface TurnArgvInput {
  prompt: string;
  cwd: string;
  /** Cody's session id (equals the engine id for identity-preassigning engines). */
  sessionId: string;
  /** The engine's own session id, when known. */
  engineSessionId: string | null;
  /** True when a previous turn already created the engine-side session. */
  resume: boolean;
  /** Per-turn, session-scoped Cody display MCP launch arguments. */
  displayMcpConfig?: string;
  displayMcpArgs?: string[];
}

/** Everything that differs between one turn-based engine and another. */
export interface EngineTurnSpec {
  /** Engine id, matching the HarnessAdapter ("claude", "codex"). */
  id: string;
  /** Human name, used in "…not supported by the Claude Code engine". */
  name: string;
  /** Provider stamped on synthesized assistant messages. */
  provider: string;
  /** Model label shown before/unless the engine reports its own. */
  defaultModel: string;
  /** True when the engine accepts a caller-chosen session id on the first turn
   * (claude --session-id). False engines mint their own and Cody re-keys the
   * session when the id arrives (codex thread.started). */
  preassignsIdentity: boolean;
  resolveBin(): string | null;
  buildArgv(input: TurnArgvInput): string[];
  createState(seed: { engineSessionId: string | null; model: string | null }): TurnStreamState;
  translate(line: unknown, state: TurnStreamState): EngineEvent[];
}

/** Same idle budget as the omp wrapper (lib/rpc-manager.ts). */
const IDLE_DESTROY_MS = 10 * 60 * 1000;
const STDERR_TAIL_LIMIT = 8 * 1024;
/** Grace between the abort/destroy SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 5_000;

/** Commands answered locally; every other command type is "unsupported". */
const SUPPORTED_COMMANDS = new Set(["prompt", "abort", "get_state", "get_messages", "get_messages_page"]);

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

export class TurnEngineSession implements EngineSession {
  readonly cwd: string;
  private spec: EngineTurnSpec;
  private _sessionId: string;
  private engineSessionId: string | null = null;
  private model: string | null = null;
  private title = "";
  /** True once a turn actually reached the engine (its session exists). */
  private engineSessionExists = false;
  private listeners: Array<(event: EngineEvent) => void> = [];
  /** Completed messages of the turns this process ran — the get_messages log. */
  private messages: AgentMessage[] = [];
  private child: ChildProcess | null = null;
  private aborting = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private childExit: Promise<void> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string) => void) | null = null;
  private _alive = true;
  destroyPromise: Promise<void> | null = null;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode — same reason
  // AgentSessionWrapper avoids them.
  constructor(spec: EngineTurnSpec, options: EngineSessionOptions) {
    this.spec = spec;
    this.cwd = options.cwd && existsSync(options.cwd) ? options.cwd : process.cwd();
    const known = options.sessionId ? getEngineSession(options.sessionId) : null;
    this._sessionId = options.sessionId || (spec.preassignsIdentity ? randomUUID() : `${spec.id}-${randomUUID()}`);
    if (known) {
      this.engineSessionId = known.engineSessionId || null;
      this.title = known.title;
      // A row with an engine id means the engine-side session already exists,
      // so the next turn must resume it rather than try to create it.
      this.engineSessionExists = !!known.engineSessionId;
    } else if (spec.preassignsIdentity) {
      // claude lets Cody choose the id, which keeps codySessionId ===
      // engineSessionId from the very first turn.
      this.engineSessionId = this._sessionId;
    }
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** The engine owns its transcript storage; Cody has no file for it. */
  get sessionFile(): string {
    return "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && this.child !== null;
  }

  start(): void {
    this.resetIdleTimer();
  }

  /** No child exists until the first prompt, so the session is ready at once. */
  waitUntilReady(): Promise<void> {
    return Promise.resolve();
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  onIdentityChange(cb: (oldId: string, newId: string) => void): void {
    this.onIdentityChangeCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = typeof command.type === "string" ? command.type : "";
    if (!this._alive) throw new EngineCommandError(type, "Session is no longer running", "session_dead");
    this.resetIdleTimer();

    if (!SUPPORTED_COMMANDS.has(type)) {
      throw new EngineCommandError(
        type,
        `"${type}" is not supported by the ${this.spec.name} engine`,
        "unsupported",
      );
    }

    switch (type) {
      case "prompt":
        return this.prompt(command);
      case "abort":
        this.abort();
        return null;
      case "get_state":
        return this.buildState();
      case "get_messages":
        return { messages: [...this.messages] };
      default:
        return this.messagesPage(command);
    }
  }

  destroy(): void {
    void this.destroyAndWait();
  }

  async destroyAndWait(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const pending = this.childExit ?? Promise.resolve();
    this.destroyPromise = pending;
    if (this.child) {
      this.aborting = true;
      this.killChild("SIGTERM");
      this.scheduleKill();
    }
    this.onDestroyCallback?.();
    await pending;
  }

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  private prompt(command: Record<string, unknown>): null {
    if (this.child) {
      throw new EngineCommandError(
        "prompt",
        `The ${this.spec.name} engine runs one turn at a time — wait for the current turn to finish`,
        "session_busy",
      );
    }
    const message = typeof command.message === "string" ? command.message : "";
    if (!message.trim()) {
      throw new EngineCommandError("prompt", "Prompt message is required", "prompt_required");
    }
    // The per-turn CLI invocations carry text only. Refuse attachments loudly
    // rather than dropping them: a silently text-only prompt would misrepresent
    // what the model actually saw.
    if (Array.isArray(command.images) && command.images.length > 0) {
      throw new EngineCommandError(
        "prompt",
        `The ${this.spec.name} engine does not support image attachments yet — send the prompt without images`,
        "images_unsupported",
      );
    }
    const bin = this.spec.resolveBin();
    if (!bin) {
      throw new EngineCommandError(
        "prompt",
        `The ${this.spec.name} binary was not found — install the engine from Settings → Agent engine`,
        "engine_not_installed",
      );
    }

    if (!this.title) this.title = engineSessionTitle(message);
    this.persistIndexRow();

    this.emit({ type: "agent_start" });
    // The engine never echoes the prompt back, but the transcript (and the
    // optimistic bubble reconciliation in useAgentSession) expects a completed
    // user message for every turn.
    this.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() },
    });

    this.startTurn(bin, message);
    return null;
  }

  private abort(): void {
    if (!this.child) return;
    // SIGTERM lets the engine flush its own session state, so the next prompt
    // can resume where this turn stopped. The terminal agent_end is emitted by
    // the exit handler, exactly once, like any other turn ending.
    this.aborting = true;
    this.killChild("SIGTERM");
    this.scheduleKill();
  }

  /** WebSessionState as the browser expects it (rpc-manager buildWebState),
   * synthesized from what a turn-based engine can actually know. */
  private buildState(): WebSessionState {
    const running = this.child !== null;
    return {
      sessionId: this._sessionId,
      sessionFile: "",
      sessionName: this.title || undefined,
      isStreaming: running,
      isPromptRunning: running,
      isBashRunning: false,
      isCompacting: false,
      autoCompactionEnabled: false,
      interruptMode: "immediate",
      steeringMode: "all",
      followUpMode: "all",
      model: { id: this.model ?? this.spec.defaultModel, provider: this.spec.provider },
      messageCount: this.messages.length,
      queuedMessageCount: 0,
      contextUsage: null,
      systemPrompt: "",
      thinkingLevel: "off",
      fastModeEnabled: false,
      todoPhases: [],
      extensionStatuses: [],
      extensionWidgets: [],
    };
  }

  /** Page over the in-memory turn log. Engine-native transcripts on disk are
   * out of scope for v1, so history is what this process streamed. */
  private messagesPage(command: Record<string, unknown>): {
    messages: AgentMessage[];
    total: number;
    offset: number;
    hasMore: boolean;
  } {
    const total = this.messages.length;
    const rawOffset = typeof command.offset === "number" ? Math.floor(command.offset) : 0;
    const offset = Math.min(Math.max(rawOffset, 0), total);
    const rawLimit = typeof command.limit === "number" ? Math.floor(command.limit) : total - offset;
    const limit = Math.min(Math.max(rawLimit, 0), total - offset);
    const messages = this.messages.slice(offset, offset + limit);
    return { messages, total, offset, hasMore: offset + messages.length < total };
  }

  // --------------------------------------------------------------------------
  // Turn execution
  // --------------------------------------------------------------------------

  private startTurn(bin: string, prompt: string): void {
    // The state's engineSessionId is deliberately NOT seeded from the session:
    // it means "the id this turn's stream reported", which is how the session
    // learns that the engine-side session really exists. Seeding it would make
    // a turn that died before reaching the engine (missing auth, bad argv) look
    // resumable, and every later turn would --resume a session never created.
    const state = this.spec.createState({ engineSessionId: null, model: this.model });
    const displayMcpConfig = this.spec.id === "claude" ? claudeDisplayMcpConfig(this._sessionId) : undefined;
    const displayMcpArgs = this.spec.id === "codex" ? codexDisplayMcpArgs(this._sessionId) : undefined;
    const argv = this.spec.buildArgv({
      prompt,
      cwd: this.cwd,
      sessionId: this._sessionId,
      engineSessionId: this.engineSessionId,
      resume: this.engineSessionExists && !!this.engineSessionId,
      displayMcpConfig,
      displayMcpArgs,
    });

    let child: ChildProcess;
    try {
      child = spawn(bin, argv, {
        cwd: this.cwd,
        env: process.env,
        // stdin closed: both CLIs take the prompt on argv, and an open stdin
        // makes them wait for input that will never come.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // POSIX: own process group so a turn's whole tree (the agent's own
        // shell commands and MCP servers) dies with the abort, mirroring
        // lib/omp/rpc-process.ts. Windows kills the tree with taskkill /t.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this.finishTurn(state, { code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    this.child = child;
    this.aborting = false;
    let stderrTail = "";
    let settled = false;
    this.childExit = new Promise<void>((resolve) => {
      const settle = (info: { code: number | null; error?: string }) => {
        if (settled) return;
        settled = true;
        this.finishTurn(state, { ...info, stderrTail });
        resolve();
      };
      if (child.stdout) {
        const reader = createInterface({ input: child.stdout });
        reader.on("line", (line) => this.consumeLine(line, state));
        reader.on("error", () => {});
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
      });
      child.on("error", (error) => settle({ code: null, error: error.message }));
      child.on("close", (code) => settle({ code }));
    });
  }

  private consumeLine(line: string, state: TurnStreamState): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Engines print the occasional non-JSON line (warnings, npm notices).
      // Never let one kill the reader mid-turn.
      return;
    }
    let events: EngineEvent[] = [];
    try {
      events = this.spec.translate(parsed, state);
    } catch {
      // A translator bug must not abort a running turn; the frame is dropped
      // and the stream continues.
      return;
    }
    for (const event of events) this.emit(event);
    this.adoptIdentity(state);
  }

  private finishTurn(
    state: TurnStreamState,
    info: { code: number | null; error?: string; stderrTail?: string },
  ): void {
    this.child = null;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    const aborted = this.aborting;
    this.aborting = false;

    // A child that died mid-message would otherwise leave the streaming bubble
    // hanging forever — close it with what arrived.
    if (state.streaming && (state.text || state.thinking)) {
      const content: Array<Record<string, unknown>> = [];
      if (state.thinking) content.push({ type: "thinking", thinking: state.thinking });
      if (state.text) content.push({ type: "text", text: state.text });
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content,
          model: state.model ?? state.modelFallback,
          provider: state.provider,
          timestamp: Date.now(),
        },
      });
      state.streaming = false;
      state.text = "";
      state.thinking = "";
    }

    this.adoptIdentity(state);
    if (state.engineSessionId) this.engineSessionExists = true;

    if (!aborted) {
      const detail = state.errorMessage || info.error || lastLine(info.stderrTail ?? "");
      if (state.errorMessage) {
        this.emit({ type: "notice", level: "error", message: `${this.spec.name}: ${state.errorMessage}` });
      } else if (info.error || (info.code !== null && info.code !== 0)) {
        const exit = info.code !== null ? ` (exit code ${info.code})` : "";
        this.emit({
          type: "notice",
          level: "error",
          message: `The ${this.spec.name} turn failed${exit}${detail ? `: ${detail}` : "."}`,
        });
      }
    }

    this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    this.persistIndexRow();
    this.resetIdleTimer();
  }

  /** Adopt the engine's own identity/model as soon as the stream reveals it. */
  private adoptIdentity(state: TurnStreamState): void {
    if (state.model && state.model !== this.model) this.model = state.model;
    const engineId = state.engineSessionId;
    if (!engineId || engineId === this.engineSessionId) return;
    this.engineSessionId = engineId;
    if (this.spec.preassignsIdentity || engineId === this._sessionId) return;
    // Engines that mint their own id (codex thread.started) re-key the session:
    // the index row moves and the registry is told to move with it.
    const oldId = this._sessionId;
    this._sessionId = engineId;
    try {
      renameEngineSession(oldId, engineId);
    } catch {
      // Bookkeeping only — a failed rename must not break the live turn.
    }
    this.onIdentityChangeCallback?.(oldId, engineId);
  }

  private persistIndexRow(): void {
    if (!this.title) return;
    try {
      upsertEngineSession(this._sessionId, {
        engine: this.spec.id,
        engineSessionId: this.engineSessionId ?? "",
        title: this.title,
        cwd: this.cwd,
      });
    } catch {
      // The index is a convenience sidecar; losing a write costs a sidebar row,
      // never the turn itself.
    }
  }

  // --------------------------------------------------------------------------
  // Plumbing
  // --------------------------------------------------------------------------

  private emit(event: EngineEvent): void {
    if (event.type === "message_end" && event.message) {
      this.messages.push(event.message as AgentMessage);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One throwing subscriber (SSE encode failure, handler bug) must not
        // starve the others — same isolation the omp wrapper applies.
      }
    }
  }

  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    const pid = child?.pid;
    if (!child || !pid) return;
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } catch {
        try { child.kill(signal); } catch {}
      }
      return;
    }
    try {
      // Negative pid = the detached process group, so the agent's own
      // grandchildren go down with it instead of being orphaned.
      process.kill(-pid, signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  }

  private scheduleKill(): void {
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.child) this.killChild("SIGKILL");
    }, KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  private resetIdleTimer(): void {
    if (!this._alive) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, IDLE_DESTROY_MS);
    this.idleTimer.unref?.();
  }
}

// ============================================================================
// Engine specs
// ============================================================================

/** Claude Code: `claude -p` per turn, identity pre-assigned by Cody. */
export const claudeTurnSpec: EngineTurnSpec = {
  id: "claude",
  name: "Claude Code",
  provider: "anthropic",
  defaultModel: "claude-code",
  preassignsIdentity: true,
  resolveBin: () => resolveEngineBin("claude", "CLAUDE"),
  buildArgv: (input) => buildClaudeTurnArgv(input),
  createState: (seed) => createClaudeTurnState(seed),
  translate: (line, state) => translateClaudeLine(line, state),
};

/** Codex: `codex exec` per turn, thread id minted by the engine. */
export const codexTurnSpec: EngineTurnSpec = {
  id: "codex",
  name: "Codex",
  provider: "openai",
  defaultModel: "codex",
  preassignsIdentity: false,
  resolveBin: () => resolveEngineBin("codex", "CODEX"),
  buildArgv: (input) => buildCodexTurnArgv(input),
  createState: (seed) => createCodexTurnState(seed),
  translate: (line, state) => translateCodexLine(line, state),
};

export function createClaudeSession(options: EngineSessionOptions): EngineSession {
  return new TurnEngineSession(claudeTurnSpec, options);
}

export function createCodexSession(options: EngineSessionOptions): EngineSession {
  return new TurnEngineSession(codexTurnSpec, options);
}
