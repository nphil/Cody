import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { Readable, Writable } from "stream";
import { ClientApp, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import type { EngineEvent, EngineSession, EngineSessionOptions } from "./types";
import { getEngineSession, upsertEngineSession } from "./engine-sessions";
import { EngineCommandError } from "./turn-session";

/**
 * A live chat session driven over the Agent Client Protocol.
 *
 * ACP (agentclientprotocol.com) is an open JSON-RPC-over-stdio standard for
 * editors driving coding agents — the same protocol Zed, VS Code and JetBrains
 * use. This module is deliberately ENGINE-NEUTRAL: it names no engine, so any
 * ACP server becomes a Cody engine by describing its CLI in an `AcpEngineSpec`
 * (see docs/specs/2026-08-22-acp-engines.md).
 *
 * Unlike the per-turn engines in turn-session.ts, an ACP session is a single
 * long-lived process: one `session/new` up front, then a `session/prompt` per
 * turn. That is closer to how omp's rpc-ui already behaves, which is why this
 * satisfies `EngineSession` without any change to the seam.
 *
 * Two protocol properties shape the code below:
 * - `session/prompt` RESOLVES at end of turn with a stopReason; the streamed
 *   content arrives beforehand as `session/update` notifications. So the
 *   promise settling is the turn boundary, not a message.
 * - `session/cancel` is a NOTIFICATION. It cannot be awaited, and the pending
 *   prompt still resolves (with `cancelled`) — abort must not fabricate its
 *   own terminal event or the UI sees two.
 */

/** How to launch and drive one ACP server. Data, not code, so a new engine is
 * a description rather than a class. */
export interface AcpEngineSpec {
  /** Engine id ("hermes"), used for command errors and session ids. */
  readonly id: string;
  /** Human name for messages ("Hermes"). */
  readonly name: string;
  /** Absolute path of the resolved engine binary. */
  readonly binaryPath: string;
  /** Argv that puts the binary into ACP stdio mode (["acp"]). */
  readonly args: readonly string[];
  /** Extra environment for the child, merged over process.env. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Commands this transport can honestly serve. Everything else throws
 * "unsupported", which the UI is built to tolerate by hiding the surface. */
const SUPPORTED_COMMANDS = new Set(["prompt", "abort", "get_state", "get_messages"]);

/** Grace period between SIGTERM and SIGKILL when tearing a session down. */
const KILL_GRACE_MS = 3_000;
/** How much agent stderr is kept to explain a failed start. */
const STDERR_TAIL_LIMIT = 4_000;

interface AcpMessage {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
}

/** Node streams → the Web streams the SDK's ndJsonStream expects. */
function webStreams(child: ChildProcess): { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> } {
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) throw new Error("ACP child process has no stdio pipes");
  return {
    input: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    output: Writable.toWeb(stdin) as WritableStream<Uint8Array>,
  };
}

/** Text out of an ACP content block, ignoring shapes with nothing to render. */
function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

/** Streaming state carried across chunks of one assistant message. ACP sends
 * text as a run of `agent_message_chunk` notifications with no explicit start
 * or end, so the first chunk opens the message and the turn boundary closes
 * it. */
export interface AcpStreamState {
  open: boolean;
  text: string;
}

/**
 * One ACP `session/update` payload → the events Cody's UI speaks. Pure and
 * exported so the mapping is testable without a child process: the live
 * protocol is verified against a real ACP server, but every branch here is
 * pinned by unit tests.
 *
 * Unknown `sessionUpdate` kinds return NO events on purpose — ACP keeps
 * gaining variants, and an engine must not break on one it has not learned.
 */
export function translateSessionUpdate(update: unknown, state: AcpStreamState): EngineEvent[] {
  if (!update || typeof update !== "object") return [];
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;

  switch (kind) {
    case "agent_message_chunk": {
      const text = blockText((update as { content?: unknown }).content);
      if (!text) return [];
      const events: EngineEvent[] = [];
      if (!state.open) {
        state.open = true;
        state.text = "";
        events.push({ type: "message_start", role: "assistant" });
      }
      state.text += text;
      events.push({ type: "message_update", delta: text, content: [{ type: "text", text: state.text }] });
      return events;
    }
    case "agent_thought_chunk": {
      const text = blockText((update as { content?: unknown }).content);
      return text ? [{ type: "thinking", delta: text }] : [];
    }
    case "tool_call": {
      const call = update as { toolCallId?: unknown; title?: unknown; kind?: unknown };
      return [{
        type: "tool_execution_start",
        toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : "",
        toolName: typeof call.title === "string" ? call.title : String(call.kind ?? "tool"),
      }];
    }
    case "tool_call_update": {
      const call = update as { toolCallId?: unknown; status?: unknown };
      if (call.status !== "completed" && call.status !== "failed") return [];
      return [{
        type: "tool_execution_end",
        toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : "",
        isError: call.status === "failed",
      }];
    }
    default:
      return [];
  }
}

export class AcpEngineSession implements EngineSession {
  readonly cwd: string;
  private spec: AcpEngineSpec;
  private _sessionId: string;
  /** The id the AGENT knows this session by (from session/new or session/load). */
  private acpSessionId: string | null = null;
  private child: ChildProcess | null = null;
  private connection: ClientConnection | null = null;
  private listeners: Array<(event: EngineEvent) => void> = [];
  private messages: AcpMessage[] = [];
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string) => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private childExit: Promise<void> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private _alive = true;
  private running = false;
  /** Assistant text of the turn in flight, accumulated for get_messages. */
  private stream: AcpStreamState = { open: false, text: "" };
  private currentModel: string | null = null;
  /** Recent agent stderr, reported only if the connection fails. */
  private stderrTail = "";
  destroyPromise: Promise<void> | null = null;

  constructor(spec: AcpEngineSpec, options: EngineSessionOptions) {
    this.spec = spec;
    this.cwd = options.cwd && existsSync(options.cwd) ? options.cwd : process.cwd();
    this._sessionId = options.sessionId || `${spec.id}-${randomUUID()}`;
    const known = options.sessionId ? getEngineSession(options.sessionId) : null;
    if (known?.engineSessionId) this.acpSessionId = known.engineSessionId;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** The agent owns its transcript storage (Hermes uses SQLite), so Cody has
   * no file to read — the empty string is the established signal for that. */
  get sessionFile(): string {
    return "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && this.running;
  }

  start(): void {
    void this.ensureReady();
  }

  waitUntilReady(): Promise<void> {
    return this.ensureReady();
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
        return this.abort();
      case "get_state":
        return this.buildState();
      default:
        return { messages: this.messages.map((message) => ({ ...message })) };
    }
  }

  destroy(): void {
    void this.destroyAndWait();
  }

  async destroyAndWait(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive) return;
    this._alive = false;
    const pending = this.childExit ?? Promise.resolve();
    this.destroyPromise = pending;
    try {
      this.connection?.close();
    } catch {
      // Closing a already-dead connection is not an error worth surfacing.
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => this.child?.kill("SIGKILL"), KILL_GRACE_MS);
    }
    this.onDestroyCallback?.();
    await pending;
  }

  // --------------------------------------------------------------------------
  // Lifecycle

  /** Spawn, handshake and open a session — once per instance. */
  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.connect().catch((error) => {
        // A failed handshake must not be cached as "ready"; the next attempt
        // re-runs it, and the session reports itself dead meanwhile.
        this.readyPromise = null;
        this._alive = false;
        // The agent's own stderr is usually the only thing that says WHY —
        // e.g. an ACP extra that was never installed — so it rides along.
        const detail = this.stderrTail.trim();
        const message = detail
          ? `${this.spec.name} could not start its ACP server: ${String(error)}\n${detail}`
          : `${this.spec.name} could not start its ACP server: ${String(error)}`;
        this.emit({ type: "notice", level: "error", message });
        throw new Error(message);
      });
    }
    return this.readyPromise;
  }

  private async connect(): Promise<void> {
    const child = spawn(this.spec.binaryPath, [...this.spec.args], {
      cwd: this.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.childExit = new Promise<void>((resolve) => {
      child.once("exit", () => {
        if (this.killTimer) clearTimeout(this.killTimer);
        this.killTimer = null;
        this.running = false;
        this._alive = false;
        resolve();
      });
    });
    // stderr is the agent's diagnostics channel, and agents are CHATTY on it:
    // Hermes alone logs dozens of INFO lines per start. Surfacing each as a
    // notice buries the conversation, so it is buffered instead and reported
    // only when it explains a failure — which is precisely where it earns its
    // keep (a missing optional dependency announces itself here and nowhere
    // else).
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
    });

    const app = new ClientApp();
    this.registerHandlers(app);
    const { input, output } = webStreams(child);
    const connection = app.connect(ndJsonStream(output, input));
    this.connection = connection;

    await connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // Cody serves file reads/writes against the workspace it already
        // guards; terminals are deliberately absent until the terminal
        // surface is wired, and claiming them would strand the agent.
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    if (this.acpSessionId) {
      // A known session resumes; an agent without loadSession says so and the
      // catch falls through to a fresh session rather than failing the chat.
      try {
        await connection.agent.request("session/load", { sessionId: this.acpSessionId, cwd: this.cwd, mcpServers: [] });
        this.running = true;
        return;
      } catch {
        this.acpSessionId = null;
      }
    }

    const created = await connection.agent.request("session/new", { cwd: this.cwd, mcpServers: [] });
    const newId = (created as { sessionId?: unknown }).sessionId;
    if (typeof newId === "string" && newId) {
      this.acpSessionId = newId;
      upsertEngineSession(this._sessionId, { engine: this.spec.id, engineSessionId: newId, cwd: this.cwd });
    }
    this.running = true;
  }

  /** Client-side ACP methods the agent may call on Cody. */
  private registerHandlers(app: ClientApp): void {
    app.onNotification("session/update", (params: unknown) => {
      this.handleUpdate(params);
    });
    // Permissions get their real approve/deny UI in phase 2 (see the spec).
    // Until then the honest behavior is to REFUSE rather than silently
    // auto-approve: an agent editing files nobody sanctioned is worse than an
    // agent that reports it could not.
    app.onRequest("session/request_permission", async () => ({
      outcome: { outcome: "cancelled" as const },
    }));
  }

  private handleUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    for (const event of translateSessionUpdate((params as { update?: unknown }).update, this.stream)) {
      this.emit(event);
    }
  }

  // --------------------------------------------------------------------------
  // Commands

  private async prompt(command: Record<string, unknown>): Promise<unknown> {
    await this.ensureReady();
    const connection = this.connection;
    if (!connection || !this.acpSessionId) {
      throw new EngineCommandError("prompt", `${this.spec.name} session is not ready`, "session_dead");
    }
    const text = typeof command.message === "string" ? command.message : "";
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });

    try {
      const result = await connection.agent.request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      this.finishTurn();
      const stopReason = (result as { stopReason?: unknown }).stopReason;
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", stopReason: typeof stopReason === "string" ? stopReason : "end_turn" });
      return { stopReason };
    } catch (error) {
      this.finishTurn();
      this.emit({ type: "notice", level: "error", message: `${this.spec.name}: ${String(error)}` });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", stopReason: "error" });
      throw new EngineCommandError("prompt", String(error), "prompt_failed");
    }
  }

  /** Close the open assistant message and bank it for get_messages. */
  private finishTurn(): void {
    if (!this.stream.open) return;
    const text = this.stream.text;
    this.emit({ type: "message_end", content: [{ type: "text", text }] });
    this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
    this.stream.open = false;
    this.stream.text = "";
  }

  /** session/cancel is a notification: the in-flight prompt still resolves
   * (with stopReason "cancelled") and emits the terminal events, so this must
   * not emit its own or the UI would see the turn end twice. */
  private async abort(): Promise<null> {
    const connection = this.connection;
    if (connection && this.acpSessionId) {
      try {
        await connection.agent.notify("session/cancel", { sessionId: this.acpSessionId });
      } catch {
        // The prompt's own rejection path reports the failure.
      }
    }
    return null;
  }

  private buildState(): Record<string, unknown> {
    return {
      sessionId: this._sessionId,
      model: this.currentModel,
      isStreaming: false,
      messageCount: this.messages.length,
      queuedMessageCount: 0,
      sessionFile: "",
      cwd: this.cwd,
    };
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not stop the rest of the stream.
      }
    }
  }
}
