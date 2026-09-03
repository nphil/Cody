import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { PROVIDER_CATALOG, PROVIDER_VARIABLE_NAMES, type ProviderDefinition } from "./provider-catalog";

/**
 * Cody-managed provider keys: the credentials an admin types into Settings,
 * handed to every engine child as environment variables.
 *
 * Why this exists: an engine with no credentials does not fail loudly. Pi ends
 * the turn with an empty assistant message carrying `stopReason: "error"`,
 * Hermes prints a bare "HTTP 401", Codex asks for a login in a terminal the
 * user is not looking at. The only way to configure any of them used to be a
 * terminal inside the container. Storing keys here and injecting them at
 * spawn (`engineChildEnv`) gives all five engines one in-app path, without
 * Cody writing five engines' private auth files.
 *
 * Lives in the instance data dir like every other piece of Cody-level state,
 * so it survives engine switches and image updates; written 0600 and
 * atomically because it holds secrets. Values NEVER leave the server: the API
 * reports which variables are set, not what they hold.
 */

const FILE_NAME = "cody-provider-keys.json";

interface KeysFile {
  version: 1;
  keys: Record<string, string>;
}

export function getProviderKeysPath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

function readFile(): KeysFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getProviderKeysPath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.keys)) return { version: 1, keys: {} };
    const keys: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.keys)) {
      // The same gate as the write side. The file lives where an engine's own
      // file tools can reach it, and a name outside the catalogue (PATH,
      // NODE_OPTIONS) would otherwise ride into every child and terminal.
      if (typeof value === "string" && value.length > 0 && isKnownProviderVariable(name)) keys[name] = value;
    }
    return { version: 1, keys };
  } catch {
    return { version: 1, keys: {} };
  }
}

/** Atomic replace, 0600 throughout: a crash mid-write can never truncate the
 * file, and nothing on the box but Cody can read it. */
function writeFile(file: KeysFile): void {
  const target = getProviderKeysPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** The stored variables, values included. Server-side only. */
export function readProviderKeys(): Record<string, string> {
  return readFile().keys;
}

export function isKnownProviderVariable(name: string): boolean {
  return PROVIDER_VARIABLE_NAMES.has(name);
}

/** Store one variable. An empty value removes it. Unknown names are refused
 * so the file only ever holds variables an engine actually reads. */
export function setProviderKey(name: string, value: string): void {
  if (!isKnownProviderVariable(name)) throw new Error(`Unknown provider variable: ${name}`);
  const file = readFile();
  const trimmed = value.trim();
  if (trimmed) file.keys[name] = trimmed;
  else delete file.keys[name];
  writeFile(file);
}

export interface ProviderVariableStatus {
  name: string;
  label: string;
  secret: boolean;
  hint?: string;
  /** Saved through Cody. */
  stored: boolean;
  /** Present in Cody's own environment (set on the container), which the
   * engines would see even with nothing stored. A stored value overrides it. */
  fromEnvironment: boolean;
}

export interface ProviderStatus {
  id: string;
  name: string;
  engines: readonly string[];
  variables: ProviderVariableStatus[];
  /** Every variable the provider needs is available from somewhere. */
  configured: boolean;
}

/** What the panel shows: which providers are set up, and by which route —
 * never the values themselves. */
export function describeProviders(engineId?: string): ProviderStatus[] {
  const stored = readFile().keys;
  const providers: ProviderDefinition[] = engineId
    ? PROVIDER_CATALOG.filter((provider) => provider.engines.includes(engineId))
    : [...PROVIDER_CATALOG];
  return providers.map((provider) => {
    const variables = provider.variables.map((variable) => ({
      name: variable.name,
      label: variable.label,
      secret: variable.secret,
      ...(variable.hint ? { hint: variable.hint } : {}),
      stored: variable.name in stored,
      fromEnvironment: typeof process.env[variable.name] === "string" && process.env[variable.name] !== "",
    }));
    return {
      id: provider.id,
      name: provider.name,
      engines: provider.engines,
      variables,
      configured: variables.every((variable) => variable.stored || variable.fromEnvironment),
    };
  });
}

/**
 * The environment an engine child runs with: Cody's own, the stored keys on
 * top, then whatever the caller adds (an adapter's `engineEnv()`, a
 * terminal's TERM). Stored keys win over the container's environment because
 * they are the more recent, deliberate choice — the panel says when both are
 * present. Every spawn of an engine goes through here: the rpc dialect
 * (lib/omp/rpc-process.ts), ACP (lib/harness/acp-session.ts) and Cody
 * terminals (lib/terminal-manager.ts), so a key typed into Settings reaches a
 * `pi /login` prompt exactly as it reaches a chat session.
 */
export function engineChildEnv(extra?: Record<string, string | undefined> | ReadonlyArray<{ name: string; value: string }>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...readProviderKeys() };
  if (Array.isArray(extra)) {
    for (const { name, value } of extra as ReadonlyArray<{ name: string; value: string }>) env[name] = value;
  } else if (extra) {
    for (const [name, value] of Object.entries(extra as Record<string, string | undefined>)) {
      if (value !== undefined) env[name] = value;
    }
  }
  return env;
}
