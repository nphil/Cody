// A small Model Context Protocol client, used by the `cody-on-demand-mcp` omp
// extension to talk to a server that is NOT in omp's own `mcp.json`.
//
// Why not omp's client? omp does not export its MCP code to extensions, and the
// only way into omp's own MCP manager is its config files, which omp reads at
// the start of a chat — exactly when an on-demand server must NOT be started.
// This client speaks just what `load_tools` needs: `initialize`, `tools/list`
// and `tools/call`, over stdio (newline-delimited JSON-RPC) or streamable HTTP.
//
// It imports only Node built-ins so it runs under Bun (inside omp) and under
// Node (Cody's tests) alike.
import { type ChildProcess, spawn } from "node:child_process";

import { isRecord } from "../type-guards";
import { type OnDemandConfig, onDemandTransport } from "./registry";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cody-on-demand-mcp", version: "1.0.0" };
/** How long a server gets to answer `initialize` / `tools/list` (rea starts in ~1 s; a cold `npx` download takes longer). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 90_000;
/** How long one tool call may run (omp's own default is 30 s; the heavy servers this is for need more). */
export const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const STDERR_TAIL_BYTES = 4_096;
const CLOSE_GRACE_MS = 1_500;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string } & Record<string, unknown>;
}

export type McpContentBlock = { type: string } & Record<string, unknown>;

export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpClient {
  /** The server's own usage notes from `initialize`, when it sent any. */
  readonly instructions: string | undefined;
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>;
  /** Ends the connection and, for stdio, the whole process tree the server started. */
  close(): Promise<void>;
  /** Called once if the server goes away without `close()` having been asked for. */
  onClose(handler: (reason: string) => void): void;
}

export interface ConnectOptions {
  /** Working directory of a stdio server unless its config names one. */
  cwd: string;
  /** The environment a stdio server inherits (default: this process's). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// -- configuration values ---------------------------------------------------

/** `${VAR}` and `${VAR:-default}`, the same forms omp expands in `mcp.json`. */
export function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const found = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof found === "string" && (fallback === undefined || found !== "")) return found;
    if (fallback !== undefined) return fallback;
    return `\${${name}}`;
  });
}

function stringMap(value: unknown, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    const expanded = expandEnvVars(raw, env);
    // omp also treats a value that is exactly an environment variable's name as a reference to it.
    const referenced = Object.hasOwn(env, expanded) ? env[expanded] : undefined;
    out[key] = referenced || expanded;
  }
  return out;
}

// -- JSON-RPC core ----------------------------------------------------------

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

type Message = Record<string, unknown>;

/** The request/response bookkeeping both transports share. */
class Rpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  constructor(
    private readonly transport: { send(message: Message, signal?: AbortSignal): Promise<void> },
    private readonly answerServerRequest: (message: Message) => Message | undefined,
  ) {}

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (!this.pending.delete(id)) return;
      cleanup();
      // Tell the server to stop working on it (best effort), and drop the HTTP request if one is still open.
      void this.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: error.message } }).catch(() => {});
      controller.abort();
      reject(error);
    };
    const onAbort = () => fail(new Error(signal?.reason instanceof Error ? signal.reason.message : "aborted"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      // Not pending yet, so `fail` would do nothing: reject here or the caller waits forever.
      reject(new Error(signal.reason instanceof Error ? signal.reason.message : "aborted"));
      return promise;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => fail(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    this.pending.set(id, {
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
      cleanup,
    });
    this.transport.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, controller.signal).catch((error: unknown) => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return promise;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** A message the server sent: a response to one of ours, or a request/notification of its own. */
  receive(message: unknown): void {
    if (!isRecord(message)) return;
    const { id, method } = message;
    if (typeof method === "string") {
      // A request from the server needs an answer (`ping` is the only one a tools client must serve); notifications need none.
      if (id !== undefined) {
        const reply = this.answerServerRequest(message);
        if (reply) void this.transport.send(reply).catch(() => {});
      }
      return;
    }
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const code = message.error.code;
      entry.reject(new Error(`MCP error ${typeof code === "number" ? code : "?"}: ${String(message.error.message ?? "request failed")}`));
    } else {
      entry.resolve(message.result);
    }
  }

  failAll(error: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}

function answerServerRequest(message: Message): Message | undefined {
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported server request: ${String(message.method)}` } };
}

// -- stdio ------------------------------------------------------------------

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // The server runs in its own process group (see `spawn` below), so `npx` -> node -> ... all get the signal.
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

class StdioTransport {
  private readonly child: ChildProcess;
  private buffer = "";
  private stderrTail = "";
  private closing = false;
  private exited = false;
  private readonly exitWaiters: Array<() => void> = [];
  private closeHandler: ((reason: string) => void) | undefined;
  rpc!: Rpc;

  constructor(command: string, args: string[], cwd: string, env: Record<string, string | undefined>) {
    this.child = spawn(command, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (error) => this.onExit(`could not start: ${error.message}`));
    this.child.on("exit", (code, signal) => this.onExit(`exited (${signal ?? `code ${code}`})`));
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.rpc.receive(JSON.parse(line));
        } catch {
          // Not JSON-RPC (a stray log line on stdout): ignore it, the way omp's client does.
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private onExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    const detail = this.stderrTail.trim();
    const message = `MCP server ${reason}${detail ? `: ${detail.slice(-600)}` : ""}`;
    this.rpc.failAll(new Error(message));
    for (const wake of this.exitWaiters.splice(0)) wake();
    if (!this.closing) this.closeHandler?.(message);
  }

  send(message: Message): Promise<void> {
    if (this.exited) return Promise.reject(new Error("MCP server is not running"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    return promise;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.exited) return;
    const { promise: gone, resolve: onGone } = Promise.withResolvers<void>();
    this.exitWaiters.push(onGone);
    // Closing stdin is the protocol's polite goodbye; then the process group is signalled so a wrapper such as `npx` cannot leave the real server behind.
    try {
      this.child.stdin!.end();
    } catch {
      // already closed
    }
    const term = setTimeout(() => killTree(this.child, "SIGTERM"), CLOSE_GRACE_MS);
    const kill = setTimeout(() => killTree(this.child, "SIGKILL"), CLOSE_GRACE_MS * 3);
    await gone;
    clearTimeout(term);
    clearTimeout(kill);
    // The leader may exit while a descendant lingers: sweep the group once.
    killTree(this.child, "SIGTERM");
  }
}

// -- streamable HTTP --------------------------------------------------------

/** The `data:` payloads of a server-sent-events body, one JSON message per event. */
async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const flush = (): unknown | undefined => {
    if (data.length === 0) return undefined;
    const text = data.join("\n");
    data = [];
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line === "") {
          const message = flush();
          if (message !== undefined) yield message;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        newline = buffer.search(/\r?\n/);
      }
    }
    const last = flush();
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock();
  }
}

class HttpTransport {
  private sessionId: string | undefined;
  private closeHandler: ((reason: string) => void) | undefined;
  rpc!: Rpc;
  protocolVersion = PROTOCOL_VERSION;

  constructor(private readonly url: string, private readonly headers: Record<string, string>) {}

  private requestHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.sessionId ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    };
  }

  async send(message: Message, signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.url, { method: "POST", headers: this.requestHeaders(), body: JSON.stringify(message), signal });
    const session = response.headers.get("Mcp-Session-Id");
    if (session) this.sessionId = session;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 400)}` : ""}`);
    }
    const type = response.headers.get("Content-Type") ?? "";
    if (type.includes("text/event-stream") && response.body) {
      // The reply arrives on the event stream; read it in the background so `send` returns once the server accepted the message.
      void (async () => {
        try {
          for await (const item of sseMessages(response.body!)) this.rpc.receive(item);
        } catch (error) {
          // A call that was cancelled aborts its own stream on purpose; that must not fail the other calls in flight.
          if (!signal?.aborted) this.rpc.failAll(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      return;
    }
    if (type.includes("application/json")) {
      const body: unknown = await response.json();
      for (const item of Array.isArray(body) ? body : [body]) this.rpc.receive(item);
      return;
    }
    await response.body?.cancel();
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.closeHandler = undefined;
    if (!this.sessionId) return;
    await fetch(this.url, { method: "DELETE", headers: { ...this.headers, "Mcp-Session-Id": this.sessionId }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
  }
}

// -- the client -------------------------------------------------------------

type Transport = StdioTransport | HttpTransport;

class Client implements McpClient {
  instructions: string | undefined;
  constructor(
    private readonly rpc: Rpc,
    private readonly transport: Transport,
    private readonly callTimeoutMs: number,
    private readonly connectTimeoutMs: number,
  ) {}

  async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.rpc.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      this.connectTimeoutMs,
      signal,
    );
    if (isRecord(result)) {
      if (typeof result.instructions === "string" && result.instructions.trim()) this.instructions = result.instructions.trim();
      if (this.transport instanceof HttpTransport && typeof result.protocolVersion === "string") this.transport.protocolVersion = result.protocolVersion;
    }
    await this.rpc.notify("notifications/initialized");
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc.request("tools/list", cursor ? { cursor } : {}, this.connectTimeoutMs, signal);
      if (!isRecord(page) || !Array.isArray(page.tools)) throw new Error("the MCP server answered tools/list without a tools array");
      for (const tool of page.tools) {
        if (isRecord(tool) && typeof tool.name === "string") tools.push(tool as unknown as McpTool);
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult> {
    const result = await this.rpc.request("tools/call", { name, arguments: args }, options?.timeoutMs ?? this.callTimeoutMs, options?.signal);
    return (isRecord(result) ? result : {}) as McpCallResult;
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  onClose(handler: (reason: string) => void): void {
    this.transport.onClose(handler);
  }
}

/** Open a connection to one on-demand server and complete the MCP handshake. */
export async function connectMcp(config: OnDemandConfig, options: ConnectOptions): Promise<McpClient> {
  const env = options.env ?? process.env;
  const kind = onDemandTransport(config);
  const connectTimeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = typeof config.timeout === "number" && config.timeout > 0 ? config.timeout : DEFAULT_CALL_TIMEOUT_MS;
  let transport: Transport;
  if (kind === "stdio") {
    const serverEnv = { ...env, ...stringMap(config.env, env) };
    const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string").map((arg) => expandEnvVars(arg, serverEnv)) : [];
    const cwd = typeof config.cwd === "string" && config.cwd ? expandEnvVars(config.cwd, serverEnv) : options.cwd;
    transport = new StdioTransport(expandEnvVars(String(config.command), serverEnv), args, cwd, serverEnv);
  } else if (kind === "http") {
    transport = new HttpTransport(expandEnvVars(String(config.url), env), stringMap(config.headers, env));
  } else {
    throw new Error("only stdio and http servers can be loaded on demand");
  }
  const rpc = new Rpc(transport, answerServerRequest);
  transport.rpc = rpc;
  const client = new Client(rpc, transport, callTimeoutMs, connectTimeoutMs);
  try {
    await client.initialize(options.signal);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  return client;
}
