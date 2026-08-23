import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { Readable, Writable } from "stream";
import { ClientApp, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import type { EngineEvent, EngineSession, EngineSessionOptions, EngineUsage } from "./types";
import { getEngineSession, upsertEngineSession } from "./engine-sessions";
import { EngineCommandError } from "./errors";

/**
 * A live chat session driven over the Agent Client Protocol.
 *
 * ACP (agentclientprotocol.com) is an open JSON-RPC-over-stdio standard for
 * editors driving coding agents — the same protocol Zed, VS Code and JetBrains
 * use. This module is deliberately ENGINE-NEUTRAL: it names no engine, so any
 * ACP server becomes a Cody engine by describing its CLI in an `AcpEngineSpec`
 * (see docs/specs/2026-08-22-acp-engines.md).
 *
 * Unlike the process-per-turn transport this replaced, an ACP session is one
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
  /**
   * Where in a tool call's `_meta` this agent puts the real tool NAME.
   *
   * ACP's `title` is a human SENTENCE — one adapter renders a Bash call as
   * "npm run typecheck" — so using it as the name fills Cody's tool chips with
   * whole command lines instead of "Bash". The schema's own `name` field is
   * marked UNSTABLE, which leaves `_meta`, and `_meta` is by definition each
   * agent's own namespace. So the agent that has one says where it is, as a
   * path of keys, and this module never learns any agent's name for itself.
   */
  readonly toolNameMetaPath?: readonly string[];
  /**
   * MCP servers to attach to the session, built per Cody session id.
   *
   * A function because the descriptor is session-scoped: Cody's display bridge
   * (open_preview, preview_screenshot, read_app_logs) hands the server a
   * capability token minted for exactly one session. Returning an empty list
   * is normal and must stay cheap — it is what an engine without the bridge,
   * or a server that cannot issue a token, reports.
   */
  readonly mcpServers?: (sessionId: string) => readonly AcpMcpServer[];
  /** One sentence telling the user how to configure this engine, appended
   * when a turn ends with no reply — overwhelmingly the shape of an engine
   * with no model or credentials yet. Engine-specific wording belongs here,
   * not in this module. */
  readonly setupHint?: string;
}

/**
 * One stdio MCP server offered to the agent at session/new (ACP's
 * `McpServerStdio`). The `type` field is deliberately absent: the shape is
 * discriminated by its absence, and at least one adapter reads a stdio server
 * as `!("type" in server)` — adding `type: "stdio"` makes it silently ignore
 * the server, i.e. tools that never appear and no error anywhere.
 */
export interface AcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ReadonlyArray<{ name: string; value: string }>;
}

/** Commands this transport can honestly serve. Everything else throws
 * "unsupported", which the UI is built to tolerate by hiding the surface.
 *
 * `set_model` is here because the transport implements it — but implementing
 * it is not the same as the AGENT offering models, so it still answers
 * "unsupported" per session when the agent published no model selector (see
 * setModel). A command in this set is a promise about Cody, not about the
 * engine on the other end of the pipe. */
const SUPPORTED_COMMANDS = new Set(["prompt", "abort", "get_state", "get_messages", "respond_permission", "set_model"]);

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

/**
 * The model selector one ACP agent published for one session, normalized.
 *
 * ACP carries model selection as SESSION state, not as a global catalog: it
 * only exists once `session/new` (or `session/load`) has answered, and its
 * contents are whatever that agent, signed in to that account, can reach. So
 * there is nothing for a sessionless route to read, and `/api/models` answers
 * `catalogSource: "session"` for these engines rather than handing back the
 * catalog of some other engine that happens to be installed.
 *
 * TWO wire shapes are live in the ecosystem at once, and both are handled
 * because both were measured against a real agent:
 *
 *  - CONFIG OPTIONS (current spec, @agentclientprotocol/sdk 1.4.0). The
 *    `session/new` response carries `configOptions: SessionConfigOption[]`;
 *    the model one is the entry whose `category` is `"model"`, a
 *    `type: "select"` with `currentValue` and `options`. Changes arrive as a
 *    `session/update` of `sessionUpdate: "config_option_update"` carrying the
 *    full set again, and switching is
 *    `session/set_config_option {sessionId, configId, value}`, whose response
 *    is once more the full set. Both installed adapters use this shape.
 *
 *  - SESSION MODEL STATE (the older field, still shipped). `session/new`
 *    carries `models: {availableModels: [{modelId, name, description}],
 *    currentModelId}`; changes arrive as `current_model_update`; switching is
 *    `session/set_model {sessionId, modelId}`. Measured live against an agent
 *    running the Python ACP SDK, which publishes exactly this and no
 *    `configOptions` at all.
 *
 * `configId` is what tells the two apart at switch time: a string means the
 * config-option call, `null` means the `session/set_model` call. Nothing here
 * names an engine — the shape decides, and an agent that publishes neither
 * yields `null` and gets an honest "unsupported" when asked to switch.
 */
export interface AcpModelSurface {
  /** Config-option id for `session/set_config_option`, or null when the agent
   * published the older `models` field and switching goes through
   * `session/set_model`. */
  configId: string | null;
  /** The value id currently selected. */
  current: string;
  /** Everything selectable, flattened out of ACP's optionally-grouped list. */
  options: Array<{ value: string; name: string; description?: string }>;
}

function optionEntry(raw: unknown): { value: string; name: string; description?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { value, name, description } = raw as Record<string, unknown>;
  if (typeof value !== "string" || !value) return null;
  return {
    value,
    // `name` is required by the schema, but an agent that omits it leaves the
    // id, which reads fine — better than dropping a model the user has.
    name: typeof name === "string" && name ? name : value,
    ...(typeof description === "string" && description ? { description } : {}),
  };
}

/** ACP's `SessionConfigSelectOptions` is either a flat list of options or a
 * list of `{group, name, options}`. Cody renders one list, so a grouped
 * payload is flattened rather than dropped. */
function readSelectOptions(raw: unknown): Array<{ value: string; name: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const flat = optionEntry(entry);
    if (flat) return [flat];
    const group = entry as { options?: unknown } | null;
    if (!group || typeof group !== "object" || !Array.isArray(group.options)) return [];
    return group.options.flatMap((option) => {
      const parsed = optionEntry(option);
      return parsed ? [parsed] : [];
    });
  });
}

/**
 * Pick the MODEL selector out of an agent's `configOptions`.
 *
 * `category` is the schema's own hint for exactly this ("help Clients
 * distinguish broadly common selectors … model selector vs session mode
 * selector"), and clients "MUST handle missing or unknown categories
 * gracefully" — so a bare `id` of "model" is accepted as the fallback, and an
 * agent that publishes neither yields nothing rather than a guess. A mode,
 * effort or fast-mode selector must never be mistaken for the model one: the
 * user would be switching their permission mode from the model picker.
 */
export function readConfigOptionModels(raw: unknown): AcpModelSurface | null {
  if (!Array.isArray(raw)) return null;
  const selects = raw.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && (entry as Record<string, unknown>).type === "select");
  const option = selects.find((entry) => entry.category === "model")
    ?? selects.find((entry) => entry.id === "model");
  if (!option || typeof option.id !== "string" || typeof option.currentValue !== "string") return null;
  const options = readSelectOptions(option.options);
  if (options.length === 0) return null;
  return { configId: option.id, current: option.currentValue, options };
}

/** The older `models` field of a `session/new` / `session/load` response
 * (`SessionModelState`), whose entries key on `modelId` rather than `value`. */
export function readSessionModelState(raw: unknown): AcpModelSurface | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as { availableModels?: unknown; currentModelId?: unknown };
  if (!Array.isArray(state.availableModels)) return null;
  const options = state.availableModels.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { modelId, name, description } = entry as Record<string, unknown>;
    if (typeof modelId !== "string" || !modelId) return [];
    return [{
      value: modelId,
      name: typeof name === "string" && name ? name : modelId,
      ...(typeof description === "string" && description ? { description } : {}),
    }];
  });
  if (options.length === 0) return null;
  const current = typeof state.currentModelId === "string" && state.currentModelId
    ? state.currentModelId
    : options[0].value;
  return { configId: null, current, options };
}

/**
 * The model selector out of a `session/new`, `session/load` or
 * `session/set_config_option` response — whichever shape the agent speaks.
 *
 * Config options win when both are present: that is the shape the current
 * spec defines, and an agent shipping both is mid-migration, with the older
 * field the one more likely to be stale.
 */
export function readModelSurface(response: unknown): AcpModelSurface | null {
  if (!response || typeof response !== "object") return null;
  const body = response as { configOptions?: unknown; models?: unknown };
  return readConfigOptionModels(body.configOptions) ?? readSessionModelState(body.models);
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

/** Follow a path of keys through nested plain objects; anything that is not a
 * non-empty string at the end is "not there". */
function readMetaString(meta: unknown, path: readonly string[]): string {
  let current: unknown = meta;
  for (const key of path) {
    if (!current || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current ? current : "";
}

/**
 * What to CALL a tool call, in descending order of trustworthiness: the path
 * the engine declared into its own `_meta`, then the schema's `name` (correct
 * where present, but marked UNSTABLE so it often is not), then `title` — which
 * is a human sentence and the last honest resort — then the tool KIND, so a
 * call with nothing at all still renders as "edit" rather than "undefined".
 */
function toolCallName(call: Record<string, unknown>, metaPath?: readonly string[]): string {
  const fromMeta = metaPath ? readMetaString(call._meta, metaPath) : "";
  if (fromMeta) return fromMeta;
  if (typeof call.name === "string" && call.name) return call.name;
  if (typeof call.title === "string" && call.title) return call.title;
  return String(call.kind ?? "tool");
}

/** What a translated `session/update` needs to know about the engine that sent
 * it. Data only — the module still names no engine. */
export interface AcpTranslateOptions {
  /** AcpEngineSpec.toolNameMetaPath. */
  readonly toolNameMetaPath?: readonly string[];
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
export function translateSessionUpdate(
  update: unknown,
  state: AcpStreamState,
  options: AcpTranslateOptions = {},
): EngineEvent[] {
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
      const call = update as Record<string, unknown>;
      return [{
        type: "tool_execution_start",
        toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : "",
        toolName: toolCallName(call, options.toolNameMetaPath),
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

/**
 * A turn's token usage, from the `PromptResponse.usage` the agent returns when
 * the turn ends. Null when the agent reports none, or reports only zeroes —
 * an empty frame would add nothing and still cost a render.
 *
 * This is the ONE place Cody's usage rule (lib/harness/types.ts: every frame
 * is a delta to ADD) meets ACP cleanly. `PromptResponse.usage` describes the
 * turn that just ended, so consecutive turns sum correctly with no
 * bookkeeping. The `usage_update` NOTIFICATIONS during a turn are cumulative
 * for the session and would double-count against this, which is why they are
 * deliberately not translated.
 *
 * Cost is not read here. ACP's cost shape is not stated to be per-turn, and a
 * cumulative figure added as a delta compounds into a number that is wrong and
 * looks authoritative. Tokens are exact; a missing cost line is honest.
 *
 * Cody's arithmetic is input + output + cacheRead + cacheWrite, and ACP already
 * reports cached reads and writes BESIDE a cache-free input count — verified
 * against a live turn whose four fields summed to its own `totalTokens` — so
 * the mapping needs no subtraction.
 *
 * Exported for the test: the arithmetic is the whole point of the function.
 */
export function readPromptUsage(raw: unknown): EngineUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const usage: EngineUsage = {
    input: count(source.inputTokens),
    output: count(source.outputTokens),
    cacheRead: count(source.cachedReadTokens),
    cacheWrite: count(source.cachedWriteTokens),
  };
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return total > 0 ? usage : null;
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
  /**
   * Settles when `initialize` completes — BEFORE `session/new`.
   *
   * The two are not the same question, and conflating them costs a release
   * gate. `initialize` needs no credentials: it proves the binary exists,
   * spawns, and speaks ACP at the version Cody drives. `session/new` is where
   * an agent reaches for the user's account — measured, the Claude adapter
   * HANGS there with none, and Codex answers "Authentication required". So
   * "the engine came up" is answerable in CI and "a session opened" is not.
   */
  private connected = Promise.withResolvers<void>();
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
  /** The agent's own model selector for THIS session, or null when it
   * published none. Captured at session open and kept current from the
   * agent's update notifications — see AcpModelSurface. */
  private models: AcpModelSurface | null = null;
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
      case "set_model":
        return this.setModel(command);
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

  /**
   * Resolves once the agent has answered `initialize` — it is running and
   * speaks the protocol — without waiting for a session to open.
   *
   * This is what a release gate can assert: `session/new` reaches for
   * credentials CI does not have, and waiting for it would either hang the
   * build or force the gate to carry secrets.
   */
  async waitUntilConnected(): Promise<void> {
    const ready = this.ensureReady();
    // Whichever settles first wins: connect resolving past initialize, or the
    // whole attempt failing. The catch keeps a later rejection from going
    // unhandled once `connected` has already won the race.
    ready.catch(() => {});
    await Promise.race([this.connected.promise, ready]);
  }

  /** Spawn, handshake and open a session — once per instance. */
  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.connect().catch((error) => {
        // A failed handshake must not be cached as "ready"; the next attempt
        // re-runs it, and the session reports itself dead meanwhile.
        this.readyPromise = null;
        this._alive = false;
        this.connected.reject(error instanceof Error ? error : new Error(String(error)));
        // A fresh deferred, so a retry is not answered by the failed attempt.
        this.connected = Promise.withResolvers<void>();
        this.connected.promise.catch(() => {});
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

    const initialized = connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // Claim NOTHING that registerHandlers does not answer. An agent that
      // believes an advertised capability and calls it gets -32601 back;
      // Hermes happens to ignore clientCapabilities and use its own file
      // tools, but this transport exists to carry engines that do not. fs and
      // terminals land here when phase 2 wires their handlers.
      clientCapabilities: {},
    });
    await initialized;
    // The agent is up and speaking ACP. Everything past this point can need
    // the user's account, so this is the last point a check can reach without
    // one.
    this.connected.resolve();

    // Built once and used for BOTH session/load and session/new: a resumed
    // session that lost its MCP servers is a session whose tools silently
    // stopped existing. A builder that throws (an unconfigured capability
    // issuer, say) costs the session its extra tools, never its chat.
    let mcpServers: readonly AcpMcpServer[] = [];
    try {
      mcpServers = this.spec.mcpServers?.(this._sessionId) ?? [];
    } catch {
      mcpServers = [];
    }

    if (this.acpSessionId) {
      // A known session resumes; an agent without loadSession says so and the
      // catch falls through to a fresh session rather than failing the chat.
      try {
        const loaded = await connection.agent.request("session/load", { sessionId: this.acpSessionId, cwd: this.cwd, mcpServers });
        this.applyModelSurface(readModelSurface(loaded), { announce: false });
        return;
      } catch {
        this.acpSessionId = null;
      }
    }

    const created = await connection.agent.request("session/new", { cwd: this.cwd, mcpServers });
    // Model selection is session state in ACP, so THIS is the only moment it
    // becomes knowable. Captured before anything can ask for it: get_state is
    // what the composer reads, and a picker that renders one turn late looks
    // like an engine with no models.
    this.applyModelSurface(readModelSurface(created), { announce: false });
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
  /**
   * Keep the model selector current from the agent's own notifications, so a
   * switch made outside Cody — the user typing `/model` at the agent, or the
   * agent falling back after a rate limit — reaches the composer.
   *
   * Two notifications, one per wire shape: `config_option_update` republishes
   * the whole `configOptions` set, and `current_model_update` carries just the
   * new id for the older `models` shape. Anything else is left to
   * translateSessionUpdate.
   */
  private handleModelUpdate(update: unknown): void {
    if (!update || typeof update !== "object") return;
    const frame = update as { sessionUpdate?: unknown; configOptions?: unknown; modelId?: unknown };
    if (frame.sessionUpdate === "config_option_update") {
      // A republished set with no model selector in it means the agent
      // dropped one it used to offer; keeping the old list would leave a
      // picker whose entries no longer exist.
      this.applyModelSurface(readConfigOptionModels(frame.configOptions), { announce: true });
      return;
    }
    if (frame.sessionUpdate === "current_model_update" && typeof frame.modelId === "string" && this.models) {
      this.applyModelSurface({ ...this.models, current: frame.modelId }, { announce: true });
    }
  }

  /**
   * Adopt a model selector and, when asked, tell the UI the resolved model
   * changed. `config_update` is the event Cody's session hook already treats
   * as authoritative for the running model, so an ACP switch lands through
   * the same path as omp's — no new client vocabulary for the same fact.
   *
   * Silent at session open (`announce: false`): the state is fetched right
   * after, and an event before any listener is attached is one nobody hears.
   */
  private applyModelSurface(surface: AcpModelSurface | null, options: { announce: boolean }): void {
    const previous = this.models?.current;
    this.models = surface;
    if (!options.announce) return;
    const resolved = this.resolvedModel();
    if (!resolved || resolved.id === previous) return;
    this.emit({ type: "config_update", model: resolved });
  }

  /** The running model as the rest of Cody names one: `{provider, id, name}`.
   * ACP has no provider dimension — one opaque value id is the whole
   * selection — so the ENGINE stands in as the provider, which is what it
   * actually is here. `spec.id` is data on the engine's own descriptor, so
   * this module still names no engine. */
  private resolvedModel(): { provider: string; id: string; name: string } | null {
    if (!this.models) return null;
    const current = this.models.current;
    const match = this.models.options.find((option) => option.value === current);
    return { provider: this.spec.id, id: current, name: match?.name ?? current };
  }

  /**
   * Switch the session's model.
   *
   * The composer's command is omp-shaped (`{provider, modelId}`); only the id
   * carries meaning here, and it is passed through verbatim because it is the
   * agent's own value id, not something Cody may reinterpret.
   *
   * An agent that published no selector answers "unsupported" — the same code
   * a command outside the vocabulary gets, and the one the UI hides on. That
   * is per SESSION, deliberately: whether models can be switched is a fact
   * about the agent and the account behind it, discovered at session/new, and
   * no static capability flag on the adapter could tell the truth about it.
   */
  private async setModel(command: Record<string, unknown>): Promise<{ provider: string; id: string; name: string }> {
    // The selector only exists once a session is open, and the composer can
    // pick a model on a session it has not prompted yet — so this waits for
    // the handshake rather than reporting "no models" on a session that
    // simply has not started.
    await this.ensureReady();
    const surface = this.models;
    if (!surface) {
      throw new EngineCommandError(
        "set_model",
        `${this.spec.name} did not offer a model selection for this session`,
        "unsupported",
      );
    }
    const requested = typeof command.modelId === "string" && command.modelId
      ? command.modelId
      : typeof command.model === "string" ? command.model : "";
    const chosen = surface.options.find((option) => option.value === requested);
    if (!chosen) {
      throw new EngineCommandError(
        "set_model",
        `${this.spec.name} does not offer a model called "${requested}" in this session`,
        "invalid_model",
      );
    }
    const connection = this.connection;
    if (!connection || !this.acpSessionId) {
      throw new EngineCommandError("set_model", `${this.spec.name} session is not ready`, "session_dead");
    }
    if (surface.configId !== null) {
      // The response republishes the whole set, so the agent's own view of
      // what is now selected wins over the value Cody asked for — an agent
      // may clamp or normalize it.
      const result = await connection.agent.request("session/set_config_option", {
        sessionId: this.acpSessionId,
        configId: surface.configId,
        value: chosen.value,
      });
      this.applyModelSurface(readConfigOptionModels((result as { configOptions?: unknown }).configOptions) ?? { ...surface, current: chosen.value }, { announce: true });
    } else {
      // `session/set_model` answers with an empty object; the agent confirms
      // by accepting, and a `current_model_update` may follow.
      await connection.agent.request("session/set_model", {
        sessionId: this.acpSessionId,
        modelId: chosen.value,
      });
      this.applyModelSurface({ ...surface, current: chosen.value }, { announce: true });
    }
    const resolved = this.resolvedModel();
    if (!resolved) throw new EngineCommandError("set_model", `${this.spec.name} reported no model after the switch`, "unsupported");
    return resolved;
  }

  private handleUpdate(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const direct = payload as { update?: unknown; params?: { update?: unknown } };
    const update = direct.update ?? direct.params?.update;
    if (update === undefined) return;
    this.handleModelUpdate(update);
    for (const event of translateSessionUpdate(update, this.stream, { toolNameMetaPath: this.spec.toolNameMetaPath })) {
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
      const usage = readPromptUsage((result as { usage?: unknown }).usage);
      if (usage) this.emit({ type: "usage_event", usage });
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
      model: this.resolvedModel(),
      // The engine's OWN models, for the composer's picker. They live here
      // rather than in /api/models because in ACP they ARE session state:
      // there is no sessionless catalog to fetch, and the list an agent
      // publishes depends on the account it opened the session with. An
      // agent that offered no selector reports an empty list and
      // `modelSelectable: false`, which is the honest way to hide the picker
      // — as opposed to what this used to do, which was report no model at
      // all and let /api/models answer with omp's catalog instead.
      availableModels: this.models
        ? this.models.options.map((option) => ({
          provider: this.spec.id,
          id: option.value,
          name: option.name,
          ...(option.description ? { description: option.description } : {}),
        }))
        : [],
      modelSelectable: this.models !== null,
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
