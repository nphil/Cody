import { existsSync, readFileSync } from "fs";
import path from "path";
import { atomicJsonWrite } from "../model-presets/store";
import { COMPUTER_SERVER, ON_DEMAND_COMPUTER_ENV, ON_DEMAND_REGISTRY_ENV } from "../on-demand-mcp/registry";
import { isRecord } from "../type-guards";
import { getOnDemandRegistryPath } from "./on-demand-mcp";
import { getAgentDir } from "./paths";
import { readPersistedBoolean } from "./settings-values";

/**
 * What each conversation has switched on through `load_tools` that is NOT an MCP
 * server: today only desktop control (`computer`).
 *
 * An MCP server a chat mounted is remembered in the chat's own session file (the
 * `cody-on-demand-mcp` extension appends an entry), so it needs nothing here.
 * Desktop control is an omp setting, not a server: omp reads `computer.enabled`
 * when the engine starts and writes its whole scripting guide (about 22,000
 * characters on 18.19) into the `eval` tool's description, which only a restart
 * can change. A chat that asks for it is therefore remembered here (session id
 * -> toolset names, in `cody-on-demand-chats.json`) and relaunched with its own
 * config layer, `computer.enabled: true`, appended after every other layer of its
 * `PI_CONFIG_FILES`: it wins over the launch default that keeps desktop control
 * off and over a config.yml that says false, and no other chat is touched.
 *
 * A config.yml that explicitly turns desktop control on makes it a normal tool
 * of every chat: nothing is on demand then, and the chat state is ignored.
 */

const SESSIONS_FILE = "cody-on-demand-chats.json";
const VERSION = 1;
/** The layer file beside this module that carries `computer: { enabled: true }`. */
export const COMPUTER_ON_LAYER_FILE = "cody-on-demand-computer-on.yml";
/** The toolsets a chat can switch on here (an MCP server is not one: see above). */
const CHAT_TOOLSETS: ReadonlySet<string> = new Set([COMPUTER_SERVER]);

interface StoredToolsets {
  version: number;
  sessions: Record<string, string[]>;
}

function sessionsPath(): string {
  return path.join(getAgentDir(), SESSIONS_FILE);
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000\r\n]/.test(value);
}

function readStore(): StoredToolsets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sessionsPath(), "utf8"));
  } catch {
    return { version: VERSION, sessions: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.sessions)) return { version: VERSION, sessions: {} };
  const sessions: Record<string, string[]> = {};
  for (const [sessionId, toolsets] of Object.entries(parsed.sessions)) {
    if (!validSessionId(sessionId) || !Array.isArray(toolsets)) continue;
    const known = toolsets.filter((name): name is string => typeof name === "string" && CHAT_TOOLSETS.has(name));
    if (known.length > 0) sessions[sessionId] = [...new Set(known)];
  }
  return { version: VERSION, sessions };
}

/** The toolsets this conversation has switched on. */
export function readSessionToolsets(sessionId: string | undefined): string[] {
  if (!sessionId || !validSessionId(sessionId)) return [];
  return readStore().sessions[sessionId] ?? [];
}

/** Switch one toolset on or off for a conversation. True when that changed anything. */
export function setSessionToolset(sessionId: string, toolset: string, on: boolean): boolean {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id.");
  if (!CHAT_TOOLSETS.has(toolset)) throw new Error(`"${toolset}" is not a toolset a chat can switch on here.`);
  const file = readStore();
  const current = file.sessions[sessionId] ?? [];
  if (current.includes(toolset) === on) return false;
  const next = on ? [...current, toolset] : current.filter((name) => name !== toolset);
  if (next.length > 0) file.sessions[sessionId] = next;
  else delete file.sessions[sessionId];
  atomicJsonWrite(sessionsPath(), file);
  return true;
}

/** Move the pre-spawn state onto omp's real session id. */
export function renameSessionToolsets(fromSessionId: string, toSessionId: string): void {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId) || fromSessionId === toSessionId) return;
  const file = readStore();
  const toolsets = file.sessions[fromSessionId];
  if (toolsets === undefined) return;
  delete file.sessions[fromSessionId];
  file.sessions[toSessionId] = toolsets;
  atomicJsonWrite(sessionsPath(), file);
}

/** A fork starts with what its parent had switched on; the parent keeps it too. */
export function copySessionToolsets(fromSessionId: string, toSessionId: string): void {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId) || fromSessionId === toSessionId) return;
  const file = readStore();
  const toolsets = file.sessions[fromSessionId];
  if (toolsets === undefined) return;
  file.sessions[toSessionId] = [...toolsets];
  atomicJsonWrite(sessionsPath(), file);
}

export function forgetSessionToolsets(sessionId: string): void {
  if (!validSessionId(sessionId)) return;
  const file = readStore();
  if (file.sessions[sessionId] === undefined) return;
  delete file.sessions[sessionId];
  atomicJsonWrite(sessionsPath(), file);
}

/** Whether desktop control is an on-demand toolset in this instance: config.yml does not turn it on for every chat. */
export function computerIsOnDemand(): boolean {
  return readPersistedBoolean("computer.enabled") !== true;
}

export function computerLayerPath(packageRoot: string): string {
  return path.join(packageRoot, "lib", "omp", COMPUTER_ON_LAYER_FILE);
}

export interface OnDemandLaunch {
  /** Environment for the engine process: where the extension finds its registry, and whether desktop control is offered here. */
  env: Record<string, string>;
  /** This chat's own `computer.enabled: true` layer, when it has switched desktop control on. */
  layer?: string;
  /** The layer's path whether or not this chat uses it, so a relaunch can drop it from what it inherited. */
  computerLayer: string;
}

/** What a chat's engine is launched with for on-demand tools. */
export function onDemandLaunch(sessionId: string, packageRoot: string): OnDemandLaunch {
  const computerLayer = computerLayerPath(packageRoot);
  const env: Record<string, string> = { [ON_DEMAND_REGISTRY_ENV]: getOnDemandRegistryPath() };
  // Not offered when config.yml already keeps it on for every chat, nor when the layer that would turn it on is missing.
  if (!computerIsOnDemand() || !existsSync(computerLayer)) return { env, computerLayer };
  if (!readSessionToolsets(sessionId).includes(COMPUTER_SERVER)) return { env: { ...env, [ON_DEMAND_COMPUTER_ENV]: "off" }, computerLayer };
  return { env: { ...env, [ON_DEMAND_COMPUTER_ENV]: "on" }, layer: computerLayer, computerLayer };
}
