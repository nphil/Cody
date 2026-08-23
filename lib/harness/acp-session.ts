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
  /** One sentence telling the user how to configure this engine, appended
   * when a turn ends with no reply — overwhelmingly the shape of an engine
   * with no model or credentials yet. Engine-specific wording belongs here,
   * not in this module. */
  readonly setupHint?: string;
}

/** Commands this transport can honestly serve. Everything else throws
 * "unsupported", which the UI is built to tolerate by hiding the surface. */
const SUPPORTED_COMMANDS = new Set(["prompt", "abort", "get_state", "get_messages", "respond_permission"]);

/** One choice the AGENT offered for a permission request. Cody renders the
 * agent's own options rather than inventing Allow/Deny buttons: only the agent
 * knows whether "always" is on the table, and `kind` is what tells the UI
 * which choice is the dangerous one. */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** The two answers the protocol allows. */
type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

/** A permission request waiting on a human. */
interface PendingPermission {
  requestId: string;
  toolCall: unknown;
  options: AcpPermissionOption[];
  /** Settles the JSON-RPC request the agent is blocked on. */
  settle: (outcome: PermissionOutcome) => void;
}

/** Only the shapes Cody can render; an option missing a field is dropped
 * rather than shown as a button that means nothing. */
function readPermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { optionId, name, kind } = entry as Record<string, unknown>;
    if (typeof optionId !== "string" || typeof name !== "string") return [];
    if (typeof kind !== "string" || !kinds.has(kind)) return [];
    return [{ optionId, name, kind: kind as AcpPermissionOption["kind"] }];
  });
}

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

/** Why a turn produced no assistant content, in the user's terms. Exported
 * for the test: the wording is the whole point of the function. */
export function emptyTurnMessage(engineName: string, stopReason: string, setupHint?: string): string {
  switch (stopReason) {
    case "refusal":
      return `${engineName} declined to answer this prompt.`;
    case "max_tokens":
      return `${engineName} hit its output limit before writing a reply.`;
    case "max_turn_requests":
      return `${engineName} reached its tool-call limit for this turn without replying.`;
    case "cancelled":
      return `${engineName} stopped before replying.`;
    default:
      // The overwhelmingly common cause of a clean, empty end_turn: no model
      // or credentials configured, so there was nothing to answer with.
      return `${engineName} ended the turn without a reply.`
        + (setupHint ? ` ${setupHint}` : " If this is a fresh install, it may have no model configured yet.");
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
  /** The turn in flight, if any. ACP's session/prompt resolves only at end
   * of turn, so it runs detached and this is what "busy" means. */
  private turn: Promise<void> | null = null;
  /** Permission requests the agent is blocked on, by request id. */
  private pendingPermissions = new Map<string, PendingPermission>();
  private nextPermissionId = 1;
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

  /** A TURN is in flight — not merely "the agent process is up". An ACP
   * connection is long-lived, so reporting the process would light the
   * sidebar's running indicator on every idle session, forever. */
  isRunning(): boolean {
    return this._alive && this.turn !== null;
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
      case "respond_permission":
        return this.respondPermission(command);
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
    // Before the connection closes: settling these resolves the agent's own
    // blocked requests, and the UI listener is still attached to hear that
    // the cards are gone.
    this.cancelPendingPermissions();
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
      // Claim NOTHING that registerHandlers does not answer. An agent that
      // believes an advertised capability and calls it gets -32601 back;
      // Hermes happens to ignore clientCapabilities and use its own file
      // tools, but this transport exists to carry engines that do not. fs and
      // terminals land here when phase 2 wires their handlers.
      clientCapabilities: {},
    });

    if (this.acpSessionId) {
      // A known session resumes; an agent without loadSession says so and the
      // catch falls through to a fresh session rather than failing the chat.
      try {
        await connection.agent.request("session/load", { sessionId: this.acpSessionId, cwd: this.cwd, mcpServers: [] });
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
  }

  /** Client-side ACP methods the agent may call on Cody. */
  private registerHandlers(app: ClientApp): void {
    app.onNotification("session/update", (ctx: unknown) => {
      this.handleUpdate(ctx);
    });
    app.onRequest("session/request_permission", (ctx: unknown) => this.requestPermission(ctx));
  }

  /**
   * The agent wants permission for a tool call, and its JSON-RPC request stays
   * open until a human answers. That is the point: this is the only Cody
   * transport with a real approval channel, so the turn genuinely waits rather
   * than auto-approving and telling the user afterwards.
   *
   * There is deliberately NO timeout. An unanswered request is not an error —
   * the user may be reading the diff — and expiring it would either fabricate
   * a refusal the agent then reports as a failure, or worse, an approval.
   * Abort and destroy both settle whatever is outstanding, and the request is
   * carried in get_state so a browser that reloads still finds it.
   */
  private requestPermission(ctx: unknown): Promise<{ outcome: PermissionOutcome }> {
    const params = (ctx && typeof ctx === "object" ? (ctx as { params?: unknown }).params ?? ctx : {}) as Record<string, unknown>;
    const options = readPermissionOptions(params.options);
    const requestId = `perm-${this.nextPermissionId++}`;

    // An agent that offers no option Cody can render leaves nothing to click,
    // so refusing is the only honest answer — approving would grant something
    // the user was never shown.
    if (options.length === 0) {
      this.emit({
        type: "notice",
        level: "warning",
        message: `${this.spec.name} asked for permission but offered no options Cody could show, so it was declined.`,
      });
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const { promise, resolve } = Promise.withResolvers<{ outcome: PermissionOutcome }>();
    const pending: PendingPermission = {
      requestId,
      toolCall: params.toolCall ?? null,
      options,
      settle: (outcome) => {
        if (!this.pendingPermissions.delete(requestId)) return;
        this.emit({ type: "permission_resolved", requestId, outcome: outcome.outcome });
        resolve({ outcome });
      },
    };
    this.pendingPermissions.set(requestId, pending);
    this.emit({ type: "permission_request", requestId, toolCall: pending.toolCall, options });
    return promise;
  }

  /** Answer one outstanding request. An unknown id is a stale click — the
   * request was already cancelled or answered in another tab — and says so
   * rather than throwing the whole command. */
  private respondPermission(command: Record<string, unknown>): { answered: boolean } {
    const requestId = typeof command.requestId === "string" ? command.requestId : "";
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { answered: false };
    const optionId = typeof command.optionId === "string" ? command.optionId : "";
    const chosen = pending.options.find((option) => option.optionId === optionId);
    // No recognised option means deny: an unrecognised id must never be
    // resolved into an approval.
    pending.settle(chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" });
    return { answered: true };
  }

  /**
   * Settle everything outstanding as cancelled. The protocol REQUIRES it on
   * cancellation — "a client [that cancels] MUST respond to all pending
   * session/request_permission requests with this Cancelled outcome" — and a
   * dying session must do it too, or the agent's request never settles.
   */
  private cancelPendingPermissions(): void {
    for (const pending of [...this.pendingPermissions.values()]) {
      pending.settle({ outcome: "cancelled" });
    }
  }

  /**
   * The SDK hands a notification CONTEXT to the handler — `{params, signal,
   * agent}` — not the raw params, which is what its own built-in handlers
   * assume (`(ctx) => implementation.cancel(ctx.params)`). Reading `.update`
   * off the context instead of off `ctx.params` silently discarded every
   * frame the agent sent: no streamed text, no thinking, no tool calls, and
   * every turn ending in the "no reply" notice.
   *
   * Both shapes are accepted so a future SDK that passes params directly
   * keeps working; unwrapping is decided by which object actually carries
   * `update`, never by shape-guessing.
   */
  private handleUpdate(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const direct = payload as { update?: unknown; params?: { update?: unknown } };
    const update = direct.update ?? direct.params?.update;
    if (update === undefined) return;
    for (const event of translateSessionUpdate(update, this.stream)) {
      this.emit(event);
    }
  }

  // --------------------------------------------------------------------------
  // Commands

  /**
   * Launch a turn and ACKNOWLEDGE it — the turn itself runs detached and
   * reports through events.
   *
   * ACP's `session/prompt` request resolves only when the whole turn ends,
   * but Cody's prompt POST is an acknowledgement that the browser aborts
   * after 30 seconds. Awaiting the turn here made every Hermes turn longer
   * than that surface as a FAILED send: the user's message rolled back out
   * of the transcript and into the composer, under a banner promising the
   * prompt never started, while the agent carried on working. The turn
   * engines return as soon as the turn is launched; this now matches them.
   */
  private async prompt(command: Record<string, unknown>): Promise<null> {
    await this.ensureReady();
    const connection = this.connection;
    if (!connection || !this.acpSessionId) {
      throw new EngineCommandError("prompt", `${this.spec.name} session is not ready`, "session_dead");
    }
    if (this.turn) {
      throw new EngineCommandError(
        "prompt",
        `The ${this.spec.name} engine runs one turn at a time. Wait for the current turn to finish`,
        "session_busy",
      );
    }
    const text = typeof command.message === "string" ? command.message : "";
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.turn = this.runTurn(connection, text).finally(() => {
      this.turn = null;
    });
    return null;
  }

  /** The detached body of one turn. Never rejects: a failure is reported to
   * the session as events, because by now nobody is awaiting a promise. */
  private async runTurn(connection: ClientConnection, text: string): Promise<void> {
    try {
      const result = await connection.agent.request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      const answered = this.stream.open;
      this.finishTurn();
      const stopReason = (result as { stopReason?: unknown }).stopReason;
      const reason = typeof stopReason === "string" ? stopReason : "end_turn";
      // A turn that ends having said NOTHING leaves the user staring at their
      // own message wondering if anything happened. It is the normal shape of
      // an agent that has no model configured yet — the ACP layer sees a clean
      // end_turn with no content — so the silence gets explained rather than
      // rendered as a void.
      if (!answered) this.emit({ type: "notice", level: "warning", message: emptyTurnMessage(this.spec.name, reason, this.spec.setupHint) });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", stopReason: reason });
    } catch (error) {
      this.finishTurn();
      this.emit({ type: "notice", level: "error", message: `${this.spec.name}: ${String(error)}` });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", stopReason: "error" });
    }
  }

  /** Close the open assistant message and bank it for get_messages. Any
   * permission still outstanding dies with the turn that raised it: nothing
   * will act on the answer now, and leaving the card on screen invites a
   * click that does nothing. */
  private finishTurn(): void {
    this.cancelPendingPermissions();
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
    // Ordered before the notification, not after: the protocol says a client
    // that cancels MUST answer every outstanding permission request with
    // `cancelled`, and an agent that is blocked on one cannot act on the
    // cancellation until it is unblocked.
    this.cancelPendingPermissions();
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

  /**
   * The browser reconciles every 15 seconds by asking whether the turn is
   * still live, and `isStreaming || isPromptRunning || isCompacting` is the
   * ONLY evidence it accepts. Hard-coding isStreaming:false told it every
   * turn past 15 seconds had finished: it ended the run, unlocked the
   * composer under a still-working agent, and dropped the turn's real
   * terminal events. These now follow the live turn, as the turn engines' do.
   */
  private buildState(): Record<string, unknown> {
    const running = this.turn !== null;
    return {
      sessionId: this._sessionId,
      model: this.currentModel,
      isStreaming: running,
      isPromptRunning: running,
      isCompacting: false,
      messageCount: this.messages.length,
      queuedMessageCount: 0,
      sessionFile: "",
      cwd: this.cwd,
      // Carried in state, not only in the event stream: a reload drops the
      // events it already missed, and a turn blocked on an approval nobody
      // can see any more is a session that looks hung.
      pendingPermissions: [...this.pendingPermissions.values()].map((entry) => ({
        requestId: entry.requestId,
        toolCall: entry.toolCall,
        options: entry.options,
      })),
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
