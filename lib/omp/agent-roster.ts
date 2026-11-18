/**
 * Which helper agents omp can start, found the way omp finds them, so the
 * Settings list names exactly what omp will accept.
 *
 * omp reads agent files from several places; the first file with a name wins:
 *  1. the nearest `.omp/agents` above a chat's folder (a project's own agents),
 *  2. the user folder `<agent dir>/agents` (`~/.omp/agent/agents` before omp 18.18.8),
 *  3. agents that extension packages and Claude plugins bring (not listed here),
 *  4. the agents built into omp.
 * `.claude/agents` is NOT read for helper agents, whatever older notes say.
 *
 * A file counts only when its first lines hold a `name` and a `description`
 * (both text); `main` and `sub` are reserved. The built-in agents are not
 * files Cody can see, so they are listed by asking omp itself
 * (`omp agents unpack`) into a throwaway folder under a throwaway home: nothing
 * of the real config is read or written.
 */

import { execFile } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { isAgentName } from "../agent-model-selector";
import type { AgentDefinitionInfo, AgentDefinitionOrigin } from "../helper-agents";
import { isRecord } from "../type-guards";
import { getOmpVersion, resolveOmpBin, versionBelow } from "./omp-cli";
import { findOmpPackageRoot } from "./package-source";
import { getAgentDir } from "./paths";

const MAX_AGENT_FILES = 200;
const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_ROOTS = 200;
const MAX_DESCRIPTION = 300;
const UNPACK_TIMEOUT_MS = 20_000;
/** A failed listing of the built-in agents is tried again after this long, not on every page load. */
const BUNDLED_RETRY_MS = 60_000;

/** omp 18.18.8 moved the user agents folder from ~/.omp/agent/agents to <agent dir>/agents. */
const USER_FOLDER_MOVED_IN = [18, 18, 8] as const;
/** The first omp that tells extensions a helper is about to start (`before_subagent_spawn`): what lets one respawn use another model. */
export const SPAWN_HOOK_SINCE = [18, 19, 0] as const;

const RESERVED_AGENT_NAMES: Readonly<Record<string, true>> = { main: true, sub: true };

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function modelList(value: unknown): string[] {
  const parts: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return parts.flatMap((part) => (typeof part === "string" && part.trim() !== "" ? [part.trim()] : []));
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DESCRIPTION ? `${collapsed.slice(0, MAX_DESCRIPTION - 1)}…` : collapsed;
}

/** What omp reads from an agent file, or null when omp would skip the file. */
export function parseAgentFile(text: string): { name: string; description: string; model: string[] } | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? oneLine(data.description) : "";
  // A name this page cannot write into config.yml is left out rather than shown with a dead dropdown.
  if (!isAgentName(name) || RESERVED_AGENT_NAMES[name.toLowerCase()] === true || description === "") return null;
  return { name, description, model: modelList(data.model) };
}

/** The `*.md` files directly inside `dir` that omp accepts as agents. */
export function readAgentDirectory(dir: string, origin: AgentDefinitionOrigin, projectRoot?: string): AgentDefinitionInfo[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort().slice(0, MAX_AGENT_FILES);
  } catch {
    return [];
  }
  const found: AgentDefinitionInfo[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_AGENT_FILE_BYTES) continue;
      const parsed = parseAgentFile(readFileSync(path, "utf8"));
      if (!parsed) continue;
      // A built-in agent's file is a temporary copy: the path would point nowhere.
      found.push({ ...parsed, origin, ...(origin === "bundled" ? {} : { path }), ...(projectRoot ? { projectRoot } : {}) });
    } catch {
      // Unreadable: omp skips such a file too.
    }
  }
  return found;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The `.omp/agents` folder omp uses for a chat started in `start`: the nearest one up the tree. */
export function nearestProjectAgentDir(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(current, ".omp", "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export interface CustomAgentSearch {
  agentDir: string;
  home: string;
  /** The folders chats start in: each contributes its nearest project agents folder. */
  projectRoots: readonly string[];
  engineVersion: string | null;
}

/** Agents defined by files: the user folder first, then each distinct project folder. */
export function discoverCustomAgents(search: CustomAgentSearch): AgentDefinitionInfo[] {
  const userFolder = versionBelow(search.engineVersion, USER_FOLDER_MOVED_IN)
    ? join(search.home, ".omp", "agent", "agents")
    : join(search.agentDir, "agents");
  const found = readAgentDirectory(userFolder, "user");
  const seen = new Set<string>();
  for (const root of search.projectRoots.slice(0, MAX_PROJECT_ROOTS)) {
    const folder = nearestProjectAgentDir(root);
    if (folder === null || seen.has(folder)) continue;
    seen.add(folder);
    found.push(...readAgentDirectory(folder, "project", dirname(dirname(folder))));
  }
  return found;
}

export interface BundledAgents {
  agents: AgentDefinitionInfo[];
  /** Why the list may be incomplete; null when omp listed its agents itself. */
  error: string | null;
}

function runUnpack(bin: string, out: string, home: string, agentDir: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Only what omp needs to start, and a home and agent folder of its own: no inherited OMP_* / PI_* setting can point it at the real config.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, FORCE_COLOR: "0", NO_COLOR: "1" };
  execFile(
    bin,
    ["agents", "unpack", "--dir", out, "--json", "--force"],
    { timeout: UNPACK_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: env as NodeJS.ProcessEnv },
    (error) => (error ? reject(error) : resolve()),
  );
  return promise;
}

function failureText(error: unknown): string {
  const first = error instanceof Error ? error.message.split("\n", 1)[0] : "";
  return first.trim().slice(0, 200) || "omp did not answer";
}

/**
 * The agents built into the omp at `bin`: ask it to write them out under a
 * throwaway home and read the files back. Never touches the real agent folder.
 */
export async function unpackBundledAgents(bin: string): Promise<BundledAgents> {
  const scratch = mkdtempSync(join(tmpdir(), "cody-agents-"));
  try {
    const out = join(scratch, "out");
    const home = join(scratch, "home");
    const agentDir = join(scratch, "agent");
    mkdirSync(home);
    mkdirSync(agentDir);
    await runUnpack(bin, out, home, agentDir);
    const agents = readAgentDirectory(out, "bundled");
    return agents.length > 0 ? { agents, error: null } : { agents: [], error: "omp wrote no built-in agents" };
  } catch (error) {
    return { agents: [], error: failureText(error) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the omp package ships as agent prompts: a partial fallback for an engine that cannot unpack (it misses agents defined in code). */
function bundledFromPackage(): AgentDefinitionInfo[] {
  const root = findOmpPackageRoot();
  return root ? readAgentDirectory(join(root, "src", "prompts", "agents"), "bundled") : [];
}

async function loadBundled(bin: string): Promise<BundledAgents> {
  const unpacked = await unpackBundledAgents(bin);
  if (unpacked.error === null) return unpacked;
  const fallback = bundledFromPackage();
  return { agents: fallback, error: unpacked.error };
}

let bundledCache: { key: string; at: number; result: Promise<BundledAgents> } | null = null;

/** The built-in agents of the installed omp. Kept per binary and version; a failed listing is retried after a minute. */
export async function bundledAgents(): Promise<BundledAgents> {
  const bin = resolveOmpBin();
  if (bin === null) return { agents: [], error: "omp is not installed" };
  const key = `${bin}@${(await getOmpVersion()) ?? "unknown"}`;
  if (bundledCache && bundledCache.key === key) {
    const result = await bundledCache.result;
    if (result.error === null || Date.now() - bundledCache.at < BUNDLED_RETRY_MS) return result;
  }
  const entry = { key, at: Date.now(), result: loadBundled(bin) };
  bundledCache = entry;
  return entry.result;
}

/** Forget the cached built-in list (tests, and a changed omp binary). */
export function clearBundledAgentsCache(): void {
  bundledCache = null;
}

export interface DiscoveredAgents {
  definitions: AgentDefinitionInfo[];
  bundledError: string | null;
  engineVersion: string | null;
}

/** Every agent file omp could use for chats started in `projectRoots`, plus its built-in agents. */
export async function discoverAgentDefinitions(projectRoots: readonly string[]): Promise<DiscoveredAgents> {
  const engineVersion = await getOmpVersion();
  const bundled = await bundledAgents();
  const custom = discoverCustomAgents({ agentDir: getAgentDir(), home: homedir(), projectRoots, engineVersion });
  return { definitions: [...custom, ...bundled.agents], bundledError: bundled.error, engineVersion };
}
