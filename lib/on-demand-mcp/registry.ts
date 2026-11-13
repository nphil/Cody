// The on-demand MCP registry: the one file both halves of the feature read.
//
// Cody's Settings page (server side) writes `<agent dir>/cody-on-demand-mcp.json`;
// the `cody-on-demand-mcp` omp extension, which omp loads under Bun, reads the
// same file to build the `load_tools` tool. This module therefore imports only
// the dependency-free `type-guards`, so it loads unchanged under Node, Bun and
// Cody's bundler.
//
// A server in the registry is NOT in omp's own `mcp.json`: omp would start it
// (and put all of its tool schemas in every request) at the beginning of every
// chat, which is exactly what "on demand" avoids.

import { isRecord } from "../type-guards";

export const ON_DEMAND_REGISTRY_FILE = "cody-on-demand-mcp.json";
/** The registry file's path may be passed to the engine explicitly (Cody knows the agent dir for sure). */
export const ON_DEMAND_REGISTRY_ENV = "CODY_ON_DEMAND_MCP_FILE";
/** Name of the single host tool every chat gets. */
export const LOAD_TOOLS_NAME = "load_tools";
/** `customType` of the session entry that records a load/unload, so a chat remembers what it mounted. */
export const ON_DEMAND_ENTRY_TYPE = "cody-on-demand-mcp";
/** The built-in toolset that is not an MCP server: omp's own desktop control. Its switch lives in Cody, not here. */
export const COMPUTER_SERVER = "computer";
/** Set by Cody on a chat's engine: `off` = offered by `load_tools`, `on` = switched on for this chat; unset = not an on-demand toolset here. */
export const ON_DEMAND_COMPUTER_ENV = "CODY_ON_DEMAND_COMPUTER";
export const COMPUTER_PURPOSE = "See and control the desktop: windows, screenshots, clicks (ready next turn)";
/** `customType` of the hidden note a failed restore leaves for the model; lib/message-display.ts HIDDEN_CUSTOM_TYPES keeps it out of the transcript and lib/rpc-manager.ts out of live events. */
export const RESTORE_NOTE_TYPE = "cody-on-demand-restore";
/** Key in a `load_tools` result's `details` through which the extension asks Cody to act (the engine cannot change its own tool docs). */
export const ON_DEMAND_SIGNAL_KEY = "codyOnDemand";

/** Same rule as omp's own `mcp.json` server names (lib/omp/mcp-config.ts). */
export const ON_DEMAND_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_PURPOSE_LENGTH = 160;

export type OnDemandConfig = Record<string, unknown>;
export interface OnDemandServer {
  /** One line telling the agent WHEN to load it. */
  purpose: string;
  /** The server definition, in the shape omp's `mcp.json` uses (`command`/`args`/`env` or `url`/`headers`). */
  config: OnDemandConfig;
}
export interface OnDemandRegistry {
  version: 1;
  servers: Record<string, OnDemandServer>;
}

export interface ParsedRegistry {
  registry: OnDemandRegistry;
  /** Entries that were dropped, with the reason; the rest of the file is still used. */
  problems: string[];
}

export function emptyRegistry(): OnDemandRegistry {
  return { version: 1, servers: {} };
}

/** Collapse a free-form purpose to one short line. */
export function normalizePurpose(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > MAX_PURPOSE_LENGTH ? `${line.slice(0, MAX_PURPOSE_LENGTH - 1).trimEnd()}…` : line;
}

/** The transports the on-demand loader speaks (legacy SSE servers stay in `mcp.json`). */
export function onDemandTransport(config: OnDemandConfig): "stdio" | "http" | undefined {
  const type = config.type;
  const hasCommand = typeof config.command === "string" && config.command.trim().length > 0;
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  if (hasCommand === hasUrl) return undefined;
  if (type === undefined || type === "stdio") return hasCommand ? "stdio" : undefined;
  return type === "http" && hasUrl ? "http" : undefined;
}

/** Why a server definition cannot be loaded on demand, or undefined when it can. */
export function onDemandConfigProblem(config: unknown): string | undefined {
  if (!isRecord(config)) return "the server definition must be an object";
  if (onDemandTransport(config) === undefined) return "it needs exactly one of a command (type stdio) or a url (type http); legacy sse servers cannot be loaded on demand";
  return undefined;
}

/** Read the registry leniently: a bad entry is dropped, never fatal, so one typo cannot hide the rest. */
export function parseRegistry(input: unknown): ParsedRegistry {
  const problems: string[] = [];
  const registry = emptyRegistry();
  let value = input;
  if (typeof input === "string") {
    if (input.trim() === "") return { registry, problems };
    try {
      value = JSON.parse(input);
    } catch {
      return { registry, problems: ["the registry file is not valid JSON"] };
    }
  }
  if (!isRecord(value)) return { registry, problems: value === undefined || value === null ? [] : ["the registry must be a JSON object"] };
  const servers = value.servers;
  if (servers === undefined) return { registry, problems };
  if (!isRecord(servers)) return { registry, problems: ["`servers` must be an object"] };
  for (const [name, entry] of Object.entries(servers)) {
    if (!ON_DEMAND_SERVER_NAME.test(name)) {
      problems.push(`"${name}": the server name may only contain letters, numbers, dots, dashes and underscores`);
      continue;
    }
    if (!isRecord(entry)) {
      problems.push(`"${name}": the entry must be an object`);
      continue;
    }
    const problem = onDemandConfigProblem(entry.config);
    if (problem) {
      problems.push(`"${name}": ${problem}`);
      continue;
    }
    registry.servers[name] = { purpose: normalizePurpose(entry.purpose), config: entry.config as OnDemandConfig };
  }
  return { registry, problems };
}

export function serializeRegistry(registry: OnDemandRegistry): string {
  const servers: Record<string, OnDemandServer> = {};
  for (const name of Object.keys(registry.servers).sort((a, b) => a.localeCompare(b))) servers[name] = registry.servers[name];
  return `${JSON.stringify({ version: 1, servers }, null, 2)}\n`;
}

/** Server names in a stable (alphabetical) order. */
export function registryNames(registry: OnDemandRegistry): string[] {
  return Object.keys(registry.servers).sort((a, b) => a.localeCompare(b));
}

/** One server's entry, by its own name only: `registry.servers["toString"]` must not find `Object.prototype`'s. */
export function registryEntry(registry: OnDemandRegistry, name: string): OnDemandServer | undefined {
  return Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
}

// -- the `load_tools` tool the model sees -----------------------------------

/** The description is part of EVERY request of EVERY chat, so it is built to stay tiny. */
export const LOAD_TOOLS_HEADER =
  "Mount an on-demand toolset into this chat when the task needs it. Its tools can be used from your next step and stay for the rest of the chat; unload:true drops them again.";
const MAX_LISTED_SERVERS = 6;
const MAX_LISTED_PURPOSE = 96;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** What `load_tools` says about one toolset: `name: purpose`. */
export function serverLine(name: string, purpose: string, max = MAX_LISTED_PURPOSE): string {
  const line = clip(purpose, max);
  return line ? `${name}: ${line}` : name;
}

/** One line of the tool description: a toolset's name and when to load it. */
export interface ToolsetListing {
  name: string;
  purpose: string;
}

/** `registry` servers plus Cody's built-in toolsets, in name order, as the description lists them. */
export function describeLoadTools(registry: OnDemandRegistry, builtins: readonly ToolsetListing[] = []): string {
  const entries: ToolsetListing[] = [
    ...registryNames(registry).map((name) => ({ name, purpose: registry.servers[name].purpose })),
    ...builtins,
  ].sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.slice(0, MAX_LISTED_SERVERS).map(({ name, purpose }) => `- ${serverLine(name, purpose)}`);
  if (entries.length > MAX_LISTED_SERVERS) lines.push(`- …and ${entries.length - MAX_LISTED_SERVERS} more (call with no server to list)`);
  return [LOAD_TOOLS_HEADER, "Toolsets:", ...lines].join("\n");
}

export const LOAD_TOOLS_SCHEMA = {
  type: "object",
  properties: {
    server: { type: "string" },
    unload: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

/** Rough token count (4 characters per token), enough to keep the budget honest in tests. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// -- remembering what a chat mounted ----------------------------------------

export interface LoadRecord {
  server: string;
  action: "load" | "unload";
}

/**
 * The servers a chat has mounted, from its saved entries (oldest first; the
 * last record for a server wins). Entries from other extensions are ignored.
 */
export function replayLoaded(entries: readonly unknown[]): string[] {
  const loaded: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== ON_DEMAND_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data) || typeof data.server !== "string") continue;
    const at = loaded.indexOf(data.server);
    if (data.action === "load") {
      if (at < 0) loaded.push(data.server);
    } else if (data.action === "unload" && at >= 0) {
      loaded.splice(at, 1);
    }
  }
  return loaded;
}

/** What a `load_tools` result asks Cody to do (only the built-in `computer` toolset needs Cody: it changes the engine's own tool docs, which only a restart can). */
export interface OnDemandSignal {
  server: string;
  action: "load" | "unload";
}

/** The request carried by a `tool_execution_end` frame of `load_tools`, or undefined when the frame carries none. */
export function onDemandSignalFromEvent(event: unknown): OnDemandSignal | undefined {
  if (!isRecord(event) || event.toolName !== LOAD_TOOLS_NAME || event.isError === true) return undefined;
  const result = event.result;
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  const signal = result.details[ON_DEMAND_SIGNAL_KEY];
  if (!isRecord(signal) || typeof signal.server !== "string") return undefined;
  if (signal.action !== "load" && signal.action !== "unload") return undefined;
  return { server: signal.server, action: signal.action };
}

// -- the tool names omp mints for MCP tools ---------------------------------

const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 8;

declare const Bun: { hash(input: string): number | bigint } | undefined;

/** omp hashes with Bun's wyhash; elsewhere (tests under Node) a stable stand-in keeps names deterministic. */
function hashBase36(name: string): string {
  if (typeof Bun !== "undefined") return Bun.hash(name).toString(36);
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let index = 0; index < name.length; index += 1) {
    hash ^= BigInt(name.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}

function sanitizePart(value: string, fallback: string, keepDigits: boolean): string {
  const sanitized = value
    .toLowerCase()
    .replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

function mint(server: string, tool: string, keepDigits: boolean): string {
  const serverPart = sanitizePart(server, "server", keepDigits);
  const toolPart = sanitizePart(tool, "tool", keepDigits);
  const prefix = `${serverPart}_`;
  const trimmed = toolPart.startsWith(prefix) ? toolPart.slice(prefix.length) : toolPart;
  const name = `mcp__${serverPart}_${trimmed}`;
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = hashBase36(name).slice(0, HASH_LENGTH);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * The name omp gives a tool of an MCP server it connects itself
 * (`mcp__<server>_<tool>`), so a tool mounted on demand is called exactly what
 * it would be had the server been in `mcp.json`: tool-approval rules and the
 * names in earlier transcripts keep applying.
 */
export function onDemandToolName(server: string, tool: string): string {
  return mint(server, tool, true);
}

/** The name omp's minting produced before digits were kept; approval rules written then still match. */
export function onDemandLegacyToolName(server: string, tool: string): string | undefined {
  const legacy = mint(server, tool, false);
  return legacy !== onDemandToolName(server, tool) ? legacy : undefined;
}
