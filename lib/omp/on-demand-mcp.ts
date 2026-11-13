import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { mergeMcpSecrets } from "../mcp-secrets";
import {
  type OnDemandRegistry,
  ON_DEMAND_REGISTRY_FILE,
  normalizePurpose,
  onDemandConfigProblem,
  parseRegistry,
  registryNames,
} from "../on-demand-mcp/registry";
import { isRecord } from "../type-guards";
import { deleteMcpServer, readUserMcpConfig, validateMcpServer, withMcpConfigLock, writeMcpServer, type McpServer } from "./mcp-config";
import { getAgentDir } from "./paths";

/**
 * Cody's side of "Load on demand" (Settings > Extensions > MCP).
 *
 * A user-level MCP server normally lives in omp's `mcp.json`, which omp starts
 * at the beginning of every chat and whose tool schemas then ride in every
 * request (the `rea` reverse-engineering server: ~14,000 tokens each). A server
 * switched to "load on demand" moves to `<agent dir>/cody-on-demand-mcp.json`
 * instead. omp never reads that file; the `cody-on-demand-mcp` extension
 * (lib/omp/extensions/cody-on-demand-mcp.ts) does, and offers the servers
 * through one small `load_tools` tool. The file format and the rules for what
 * may be in it live in lib/on-demand-mcp/registry.ts, shared with the extension.
 *
 * Every write is read, change, atomic replace under the same cross-process lock
 * as `mcp.json`, and entries this code does not understand are kept as they
 * are: a typo made by hand must not be erased by a click.
 */

const MAX_REGISTRY_BYTES = 512 * 1024;

export function getOnDemandRegistryPath(): string {
  return join(getAgentDir(), ON_DEMAND_REGISTRY_FILE);
}

export interface OnDemandServerView {
  name: string;
  /** The definition as stored, credentials included: mask it (`maskMcpSecrets`) before it leaves the server. */
  config: McpServer;
  /** One line telling the agent when to load it (may be empty). */
  purpose: string;
}

export interface OnDemandView {
  path: string;
  servers: OnDemandServerView[];
  /** Entries the extension cannot use, and why; they stay in the file. */
  problems: string[];
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** The raw document, or an empty one when there is no file yet. A file that is not a JSON object is an error, never overwritten. */
function readDocument(path: string): Record<string, unknown> {
  let text: string;
  try {
    if (statSync(path).size > MAX_REGISTRY_BYTES) throw new Error("The on-demand list is too large to edit in Cody");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  if (parsed.servers !== undefined && !isRecord(parsed.servers)) throw new Error("servers must be an object");
  return parsed;
}

function writeDocument(path: string, doc: Record<string, unknown>, servers: Record<string, unknown>): void {
  const sorted = Object.fromEntries(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  // The definitions hold the same credentials mcp.json does.
  writeFileSync(temp, `${JSON.stringify({ ...doc, version: 1, servers: sorted }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function documentServers(doc: Record<string, unknown>): Record<string, unknown> {
  return isRecord(doc.servers) ? { ...doc.servers } : {};
}

/** The servers the extension will offer, with the problems of the entries it will not. */
export function readOnDemandServers(path = getOnDemandRegistryPath()): OnDemandView {
  let registry: OnDemandRegistry;
  let problems: string[];
  try {
    ({ registry, problems } = parseRegistry(readDocument(path)));
  } catch (error) {
    return { path, servers: [], problems: [error instanceof Error ? error.message : String(error)] };
  }
  return {
    path,
    problems,
    servers: registryNames(registry).map((name) => ({ name, config: registry.servers[name].config, purpose: registry.servers[name].purpose })),
  };
}

/**
 * Create or replace one on-demand server (a rename passes `previousName`).
 * `server` may carry masked credentials from the edit form; a masked value
 * resolves against what is stored for that server. Without `purpose` the
 * stored one stays.
 */
export function writeOnDemandServer(name: string, server: McpServer, purpose?: string, previousName?: string): void {
  validateMcpServer(name, server);
  const problem = onDemandConfigProblem(server);
  if (problem) throw new Error(problem);
  const path = getOnDemandRegistryPath();
  withMcpConfigLock(path, () => {
    const doc = readDocument(path);
    const servers = documentServers(doc);
    const edited = previousName ?? name;
    const stored = servers[edited];
    const previous = isRecord(stored) ? stored : undefined;
    const previousConfig = previous !== undefined && isRecord(previous.config) ? previous.config : undefined;
    if (previousName !== undefined && previousName !== name) delete servers[previousName];
    servers[name] = {
      purpose: purpose === undefined ? normalizePurpose(previous?.purpose) : normalizePurpose(purpose),
      config: mergeMcpSecrets(server, previousConfig, edited),
    };
    writeDocument(path, doc, servers);
  });
}

export function deleteOnDemandServer(name: string): void {
  const path = getOnDemandRegistryPath();
  withMcpConfigLock(path, () => {
    const doc = readDocument(path);
    const servers = documentServers(doc);
    if (!Object.hasOwn(servers, name)) throw new Error("MCP server was not found");
    delete servers[name];
    writeDocument(path, doc, servers);
  });
}

/**
 * Move one user-level server between "loaded at the start of every chat"
 * (omp's `mcp.json`) and "loaded on demand" (the registry). The destination is
 * written before the source is removed, so an interrupted move leaves the
 * server in both places (the extension then leaves omp's own copy alone)
 * rather than in neither.
 */
export function setServerOnDemand(name: string, onDemand: boolean, purpose?: string): void {
  if (onDemand) {
    const user = readUserMcpConfig();
    if (user.error) throw new Error(user.error);
    const entry = user.servers.find((server) => server.name === name);
    if (!entry) {
      if (readOnDemandServers().servers.some((server) => server.name === name)) return;
      throw new Error("MCP server was not found");
    }
    if (user.disabledServers.includes(name) || entry.config.enabled === false) throw new Error("Turn the server on before loading it on demand");
    writeOnDemandServer(name, entry.config, purpose);
    deleteMcpServer({ scope: "user" }, name);
    return;
  }
  const entry = readOnDemandServers().servers.find((server) => server.name === name);
  if (!entry) {
    if (readUserMcpConfig().servers.some((server) => server.name === name)) return;
    throw new Error("MCP server was not found");
  }
  writeMcpServer({ scope: "user" }, name, entry.config);
  deleteOnDemandServer(name);
}
