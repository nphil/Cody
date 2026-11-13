// Loaded by omp itself (Bun), not by Cody's bundler. Its Cody imports are the
// relative `lib/on-demand-mcp/*` modules, which depend on nothing but Node
// built-ins, so it works unchanged in omp's runtime and in Cody's tests.
//
// Gives every chat ONE small tool, `load_tools`. Heavy MCP servers (the
// reverse-engineering `rea` server puts ~14,000 tokens in every request) are
// listed in Settings > Extensions > MCP as "Load on demand": they are NOT in
// omp's `mcp.json`, so a chat starts without them and pays nothing. When the
// task needs one, the agent calls `load_tools {server}`; this extension starts
// the server, lists its tools, and registers each as a normal omp tool
// (`mcp__<server>_<tool>`, exactly the name omp would have given it), so they
// can be used from the very next step. The chat remembers what it mounted as
// `cody-on-demand-mcp` entries in its own session file, and a restarted or
// resumed engine mounts the same servers again before the first request.
//
// Why an extension and not omp's `/mcp` commands: omp reads MCP servers from
// its config files when a chat starts and offers no way to add one to a live
// session through RPC; an extension can register tools at any time, on both
// supported engine versions (18.8.x and 18.19.x).
//
// This file registers NO `tool_call` / `tool_result` handler: omp turns off
// `task.speculativeLaunch` while any extension has one (see the disk-budget
// note in AGENTS.md).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { type ConnectOptions, type McpCallResult, type McpClient, type McpContentBlock, type McpTool, connectMcp } from "../../on-demand-mcp/mcp-client";
import {
  COMPUTER_PURPOSE,
  COMPUTER_SERVER,
  LOAD_TOOLS_NAME,
  LOAD_TOOLS_SCHEMA,
  ON_DEMAND_COMPUTER_ENV,
  ON_DEMAND_ENTRY_TYPE,
  ON_DEMAND_REGISTRY_ENV,
  ON_DEMAND_REGISTRY_FILE,
  ON_DEMAND_SIGNAL_KEY,
  RESTORE_NOTE_TYPE,
  type OnDemandConfig,
  type OnDemandRegistry,
  type OnDemandSignal,
  describeLoadTools,
  emptyRegistry,
  onDemandLegacyToolName,
  onDemandToolName,
  parseRegistry,
  registryEntry,
  registryNames,
  replayLoaded,
  serverLine,
} from "../../on-demand-mcp/registry";

// -- what the extension needs from omp (a structural subset, so tests can fake it) --

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  details?: unknown;
  isError?: boolean;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: object;
  loadMode?: "essential" | "discoverable";
  approval?: "read" | "write" | "exec";
  strict?: boolean;
  mcpServerName?: string;
  mcpToolName?: string;
  mcpReadOnlyHint?: boolean;
  legacyName?: string;
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: Context): Promise<ToolResult>;
}
interface Context {
  cwd: string;
  sessionManager?: { getBranch?: () => unknown };
}
export interface OmpApi {
  /** `never` as the event type lets every handler declare the event shape it reads. */
  on(event: string, handler: (event: never, ctx: Context) => unknown): void;
  registerTool(tool: ToolDefinition): void;
  getActiveTools(): string[];
  appendEntry(customType: string, data?: unknown): void;
}

export interface Deps {
  /** The registry file. */
  registryPath: string;
  /** Environment handed to servers (and used for `${VAR}` in their definitions). */
  env: Record<string, string | undefined>;
  connect: (config: OnDemandConfig, options: ConnectOptions) => Promise<McpClient>;
  /** How long to wait for omp to confirm that mounted tools are live. */
  mountTimeoutMs?: number;
  /** How often to look. */
  pollMs?: number;
  /** How long the first request of a resumed chat waits for its servers (default RESTORE_WAIT_MS). */
  restoreWaitMs?: number;
}

const DEFAULT_MOUNT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 25;
/** A resumed chat waits at most this long for its servers before the first request goes out. Kept under omp's 30 s limit on an event handler, which would otherwise cut the wait short and drop the handler's answer. */
const RESTORE_WAIT_MS = 25_000;
export { RESTORE_NOTE_TYPE };

/**
 * Whether the conversation the model will read already holds `content` as its
 * newest `customType` note (same rule as cody-homelabber-gate.ts: omp keeps a
 * note from `before_agent_start` as a `custom_message` entry; a compaction or
 * reset after it means it is gone; an unreadable branch counts as not there).
 */
function noteIsLive(ctx: Context, customType: string, content: string): boolean {
  let branch: unknown;
  try {
    branch = ctx.sessionManager?.getBranch?.();
  } catch {
    return false;
  }
  if (!Array.isArray(branch)) return false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry: unknown = branch[index];
    if (typeof entry !== "object" || entry === null || !("type" in entry)) continue;
    if (entry.type === "compaction" || entry.type === "reset_boundary") return false;
    if (entry.type === "custom_message" && "customType" in entry && entry.customType === customType) return "content" in entry && entry.content === content;
  }
  return false;
}
const MAX_INSTRUCTIONS_CHARS = 1_500;
const INTENT_FIELD = "i";

// -- the registry file ------------------------------------------------------

interface RegistryView {
  registry: OnDemandRegistry;
  problems: string[];
}

function createRegistryReader(path: string): () => RegistryView {
  let stamp: number | undefined;
  let view: RegistryView = { registry: emptyRegistry(), problems: [] };
  return () => {
    let next: number;
    try {
      next = statSync(path).mtimeMs;
    } catch {
      stamp = -1;
      view = { registry: emptyRegistry(), problems: [] };
      return view;
    }
    if (next === stamp) return view;
    stamp = next;
    try {
      const { registry, problems } = parseRegistry(readFileSync(path, "utf8"));
      view = { registry, problems };
    } catch (error) {
      view = { registry: emptyRegistry(), problems: [`could not read the registry: ${error instanceof Error ? error.message : String(error)}`] };
    }
    return view;
  };
}

// -- the mounted tools ------------------------------------------------------

/** The JSON Schema an MCP server declares, minus what omp's own MCP bridge strips (`$schema`, `nullable`). */
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "$schema" || key === "nullable") continue;
    out[key] = cleanSchema(item);
  }
  return out;
}

function toolSchema(tool: McpTool): object {
  const schema = cleanSchema(tool.inputSchema ?? {});
  const object = typeof schema === "object" && schema !== null && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  return { ...object, type: "object", properties: typeof object.properties === "object" && object.properties !== null ? object.properties : {} };
}

/** What omp's MCP bridge sends on: no harness intent field (unless the server declares one), no empty optional placeholders. */
function prepareArgs(params: unknown, schema: Record<string, unknown>): Record<string, unknown> {
  let args: Record<string, unknown> = typeof params === "object" && params !== null && !Array.isArray(params) ? { ...(params as Record<string, unknown>) } : {};
  const properties = (typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {}) as Record<string, unknown>;
  if (INTENT_FIELD in args && !Object.hasOwn(properties, INTENT_FIELD)) {
    const { [INTENT_FIELD]: _intent, ...rest } = args;
    args = rest;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, value] of Object.entries(args)) {
    const empty = value === "" || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
    if (empty && !required.has(key) && Object.hasOwn(properties, key)) delete args[key];
  }
  return args;
}

function sameJson(text: string, structured: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(structured);
  } catch {
    return false;
  }
}

/** An MCP result as omp shows it: text blocks joined, images kept, an error marked, structured data fenced once. */
export function formatResult(result: McpCallResult): ToolResult {
  const blocks: Content[] = [];
  let text = "";
  const flush = () => {
    if (text) blocks.push({ type: "text", text });
    text = "";
  };
  const append = (value: string) => {
    text += text ? `\n\n${value}` : value;
  };
  const content: McpContentBlock[] = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") append(item.text);
    else if (item.type === "image" && typeof item.data === "string") {
      flush();
      blocks.push({ type: "image", data: item.data, mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png" });
    } else if (item.type === "resource" && typeof item.resource === "object" && item.resource !== null) {
      const resource = item.resource as { uri?: unknown; text?: unknown };
      append(typeof resource.text === "string" && resource.text ? `[Resource: ${String(resource.uri)}]\n${resource.text}` : `[Resource: ${String(resource.uri)}]`);
    }
  }
  flush();
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  if (result.isError) {
    const first = blocks[0];
    if (first.type === "text") blocks[0] = { type: "text", text: `Error: ${first.text}` };
    else blocks.unshift({ type: "text", text: "Error:" });
  }
  if (result.structuredContent !== undefined && !content.some((item) => item.type === "text" && typeof item.text === "string" && sameJson(item.text, result.structuredContent))) {
    blocks.push({ type: "text", text: `\`\`\`json\n${JSON.stringify(result.structuredContent, null, 2)}\n\`\`\`` });
  }
  return { content: blocks, ...(result.isError ? { isError: true } : {}), details: { isError: result.isError === true } };
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Mounted {
  client: McpClient;
  /** The omp tool names this server's tools answer to. */
  names: string[];
}

const COMPUTER_LOADED_TEXT =
  "Desktop control (computer) is switched on for this chat. Cody restarts the engine as soon as this turn ends, so the desktop tools exist from the user's next message, not in this turn. End your reply by telling the user to send their request again (or just \"continue\").";
const COMPUTER_UNLOADED_TEXT =
  "Desktop control (computer) is switched off for this chat. Cody restarts the engine as soon as this turn ends, so the desktop tools are gone from the user's next message.";

/** The extension, over its collaborators (a test hands in a fake MCP connection and a fake omp). */
export function createOnDemandMcp(deps: Deps): (pi: OmpApi) => void {
  const mountTimeoutMs = deps.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const restoreWaitMs = deps.restoreWaitMs ?? RESTORE_WAIT_MS;
  const readRegistry = createRegistryReader(deps.registryPath);
  /** Desktop control is the one toolset that is not an MCP server: Cody owns its switch (see COMPUTER_SERVER). */
  const computerState = (): "off" | "on" | undefined => {
    const state = deps.env[ON_DEMAND_COMPUTER_ENV];
    return state === "off" || state === "on" ? state : undefined;
  };
  return (pi) => {
    // Nothing on demand: no tool, no cost. A server added in Settings reaches a chat that starts afterwards.
    const initial = readRegistry();
    const initialComputer = computerState();
    if (registryNames(initial.registry).length === 0 && initialComputer === undefined) return;

    const mounted = new Map<string, Mounted>();
    /** Every tool name registered so far. omp cannot forget a tool and re-registering a name rebuilds the system prompt, so a server loaded again reuses them. */
    const registered = new Set<string>();
    /** Servers that are not running although they were loaded, with why (unloaded, crashed). */
    const stopped = new Map<string, string>();
    const restoreFailures = new Map<string, string>();
    let computerRequest: OnDemandSignal["action"] | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    let restore: Promise<unknown> = Promise.resolve();
    let exitHooked = false;

    const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
      const run = queue.then(job, job);
      queue = run.catch(() => {});
      return run;
    };

    /** omp activates a registered tool asynchronously; wait until it says so. */
    const waitUntilActive = async (names: readonly string[]): Promise<string[]> => {
      const deadline = Date.now() + mountTimeoutMs;
      for (;;) {
        const active = new Set(pi.getActiveTools());
        const missing = names.filter((name) => !active.has(name));
        if (missing.length === 0 || Date.now() >= deadline) return missing;
        await sleep(pollMs);
      }
    };

    const terminateAllNow = () => {
      for (const { client } of mounted.values()) void client.close().catch(() => {});
    };

    const definitionFor = (server: string, tool: McpTool, name: string): ToolDefinition => {
      const schema = toolSchema(tool) as Record<string, unknown>;
      const legacy = onDemandLegacyToolName(server, tool.name);
      return {
        name,
        label: `${server}/${tool.name}`,
        description: tool.description ?? `MCP tool from ${server}`,
        parameters: schema,
        // Like a tool of a server in mcp.json: a mutation tier, no strict grammar.
        approval: "write",
        strict: false,
        mcpServerName: server,
        mcpToolName: tool.name,
        ...(tool.annotations?.readOnlyHint === true ? { mcpReadOnlyHint: true } : {}),
        ...(legacy ? { legacyName: legacy } : {}),
        async execute(_id, params, signal) {
          // Looked up on every call: the same registration serves the server each time it is (re)started.
          const live = mounted.get(server);
          if (!live) {
            const why = stopped.get(server);
            return textResult(`The "${server}" toolset is not running${why ? ` (${why})` : ""}. Call ${LOAD_TOOLS_NAME} {"server":"${server}"} to start it again.`, true);
          }
          try {
            return formatResult(await live.client.callTool(tool.name, prepareArgs(params, schema), { signal }));
          } catch (error) {
            return textResult(`MCP failure\nserver: ${server}\ntool: ${tool.name}\nmessage: ${errorText(error)}`, true);
          }
        },
      };
    };

    const hookExit = () => {
      if (exitHooked) return;
      exitHooked = true;
      process.once("exit", terminateAllNow);
    };

    const mount = async (
      server: string,
      config: OnDemandConfig,
      ctx: Context,
      signal?: AbortSignal,
    ): Promise<{ names: string[]; missing: string[]; clashes: string[]; instructions?: string }> => {
      const client = await deps.connect(config, { cwd: ctx.cwd, env: deps.env, signal });
      let tools: McpTool[];
      try {
        tools = await client.listTools(signal);
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
      client.onClose((reason) => {
        if (mounted.get(server)?.client !== client) return;
        mounted.delete(server);
        stopped.set(server, reason);
      });
      // A name some other connection already owns (the same server also listed in mcp.json) is left alone.
      const taken = new Set(pi.getActiveTools());
      const names: string[] = [];
      const fresh: string[] = [];
      const clashes: string[] = [];
      for (const tool of tools) {
        const name = onDemandToolName(server, tool.name);
        if (names.includes(name) || clashes.includes(name)) continue;
        if (!registered.has(name)) {
          if (taken.has(name)) {
            clashes.push(name);
            continue;
          }
          pi.registerTool(definitionFor(server, tool, name));
          registered.add(name);
          fresh.push(name);
        }
        names.push(name);
      }
      mounted.set(server, { client, names });
      stopped.delete(server);
      hookExit();
      return { names, missing: await waitUntilActive(fresh), clashes, instructions: client.instructions };
    };

    /** Stop a server's process. Its tools stay registered (omp has no way to drop one) and answer "not running" until it is loaded again. */
    const stop = async (server: string, why: string): Promise<void> => {
      const live = mounted.get(server);
      if (!live) return;
      mounted.delete(server);
      stopped.set(server, why);
      await live.client.close().catch(() => {});
    };

    // -- load_tools ---------------------------------------------------------

    const computerLine = (): string => `computer: ${COMPUTER_PURPOSE}${computerState() === "on" ? " [on]" : ""}`;

    const listing = (): string => {
      const view = readRegistry();
      const lines = registryNames(view.registry).map((name) => {
        const why = stopped.get(name);
        const state = mounted.has(name) ? " [loaded]" : why ? ` [stopped: ${why}]` : restoreFailures.has(name) ? ` [could not be restored: ${restoreFailures.get(name)}]` : "";
        return `- ${serverLine(name, view.registry.servers[name].purpose, 400)}${state}`;
      });
      if (computerState() !== undefined) lines.push(`- ${computerLine()}`);
      return lines.length > 0 ? `On-demand toolsets:\n${lines.join("\n")}` : "There are no on-demand toolsets.";
    };

    const unknown = (server: string): ToolResult => textResult(`There is no on-demand toolset "${server}".\n${listing()}`, true);

    /** Desktop control: Cody turns it on for this chat and restarts the engine when the turn ends (the signal in `details`). */
    const switchComputer = (on: boolean): ToolResult => {
      const action = on ? "load" : "unload";
      if ((computerState() === "on") === on && computerRequest === undefined) return textResult(on ? "Desktop control is already on in this chat." : "Desktop control is not on in this chat.");
      if (computerRequest === action) return textResult(`Desktop control is already being switched ${on ? "on" : "off"}; the engine restarts when this turn ends.`);
      computerRequest = action;
      return { content: [{ type: "text", text: on ? COMPUTER_LOADED_TEXT : COMPUTER_UNLOADED_TEXT }], details: { [ON_DEMAND_SIGNAL_KEY]: { server: COMPUTER_SERVER, action } } };
    };

    const doLoad = async (server: string, ctx: Context, signal?: AbortSignal): Promise<ToolResult> => {
      if (server === COMPUTER_SERVER && computerState() !== undefined) return switchComputer(true);
      const entry = registryEntry(readRegistry().registry, server);
      if (!entry) return unknown(server);
      const live = mounted.get(server);
      if (live) return textResult(`"${server}" is already loaded (${live.names.length} tools).`);
      try {
        const result = await mount(server, entry.config, ctx, signal);
        pi.appendEntry(ON_DEMAND_ENTRY_TYPE, { server, action: "load" });
        restoreFailures.delete(server);
        const prefix = onDemandToolName(server, "x").slice(0, -1);
        const lines = [
          `Loaded "${server}": ${result.names.length} tools are mounted now, for the rest of this chat.` +
            (result.missing.length > 0 ? ` ${result.missing.length} of them are still being activated; retry in a moment if one is reported missing.` : "") +
            (result.clashes.length > 0 ? ` ${result.clashes.length} more are already provided by an MCP connection of the same name and were left alone.` : ""),
          `Run one by writing a JSON arguments object to xd://${prefix}<tool> (read the path first for its schema).`,
          `Tools: ${result.names.map((name) => (name.startsWith(prefix) ? name.slice(prefix.length) : name)).join(", ")}`,
        ];
        if (result.instructions) lines.push(`Server notes: ${result.instructions.slice(0, MAX_INSTRUCTIONS_CHARS)}`);
        return textResult(lines.join("\n"));
      } catch (error) {
        return textResult(`Could not load "${server}": ${errorText(error)}`, true);
      }
    };

    const doUnload = async (server: string): Promise<ToolResult> => {
      if (server === COMPUTER_SERVER && computerState() !== undefined) return switchComputer(false);
      if (!registryEntry(readRegistry().registry, server) && !mounted.has(server)) return unknown(server);
      const live = mounted.get(server);
      if (!live) return textResult(`"${server}" is not loaded.`);
      await stop(server, "unloaded");
      pi.appendEntry(ON_DEMAND_ENTRY_TYPE, { server, action: "unload" });
      return textResult(`Stopped "${server}". Its ${live.names.length} tools stay listed until this chat's engine restarts, but calling one now says the toolset is not running; ${LOAD_TOOLS_NAME} starts it again.`);
    };

    pi.registerTool({
      name: LOAD_TOOLS_NAME,
      label: "Load tools",
      description: describeLoadTools(initial.registry, initialComputer === undefined ? [] : [{ name: COMPUTER_SERVER, purpose: `${COMPUTER_PURPOSE}${initialComputer === "on" ? " [on]" : ""}` }]),
      parameters: LOAD_TOOLS_SCHEMA,
      loadMode: "essential",
      approval: "read",
      strict: false,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = typeof params === "object" && params !== null ? (params as { server?: unknown; unload?: unknown }) : {};
        const server = typeof args.server === "string" ? args.server.trim() : "";
        if (!server) return textResult(listing());
        return enqueue(() => (args.unload === true ? doUnload(server) : doLoad(server, ctx, signal)));
      },
    });

    // -- a chat that comes back mounts what it had -----------------------------

    const reconcile = (ctx: Context): Promise<unknown> =>
      enqueue(async () => {
        const branch = ctx.sessionManager?.getBranch?.();
        const wanted = new Set(replayLoaded(Array.isArray(branch) ? branch : []));
        for (const server of [...mounted.keys()]) {
          if (!wanted.has(server)) await stop(server, "this part of the conversation had not loaded it");
        }
        for (const server of wanted) {
          if (mounted.has(server)) continue;
          const entry = registryEntry(readRegistry().registry, server);
          if (!entry) {
            restoreFailures.set(server, "it is no longer in the on-demand list");
            continue;
          }
          try {
            const result = await mount(server, entry.config, ctx);
            if (result.missing.length > 0) restoreFailures.set(server, `${result.missing.length} tools were not activated in time`);
            else restoreFailures.delete(server);
          } catch (error) {
            restoreFailures.set(server, errorText(error));
          }
        }
      });

    const startReconcile = (_event: unknown, ctx: Context) => {
      // Background: the chat must be usable while a big server starts. The first request waits for it (see before_agent_start).
      restore = reconcile(ctx).catch(() => {});
    };
    pi.on("session_start", startReconcile);
    pi.on("session_switch", startReconcile);
    pi.on("session_branch", startReconcile);
    pi.on("session_tree", startReconcile);
    pi.on("before_agent_start", async (_event: unknown, ctx: Context) => {
      const settled = new AbortController();
      await Promise.race([restore, sleep(restoreWaitMs, undefined, { signal: settled.signal }).catch(() => {})]);
      settled.abort();
      if (restoreFailures.size === 0) return {};
      const failed = [...restoreFailures].map(([server, why]) => `${server} (${why})`).join("; ");
      const content = `On-demand toolsets this chat had loaded but that could not be restored: ${failed}. Call ${LOAD_TOOLS_NAME} to try again.`;
      if (noteIsLive(ctx, RESTORE_NOTE_TYPE, content)) return {};
      // A hidden message, never a `systemPrompt`: omp treats any systemPrompt from this hook as a replaced prompt and announces the whole tool catalog again.
      return { message: { customType: RESTORE_NOTE_TYPE, content, display: false, attribution: "agent" } };
    });
    pi.on("session_shutdown", async () => {
      await Promise.all([...mounted.values()].map(({ client }) => client.close().catch(() => {})));
      mounted.clear();
    });
  };
}

export function registryPathFromEnv(env: Record<string, string | undefined> = process.env): string {
  return env[ON_DEMAND_REGISTRY_ENV] || join(env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), ON_DEMAND_REGISTRY_FILE);
}

export default createOnDemandMcp({ registryPath: registryPathFromEnv(), env: process.env, connect: connectMcp });
