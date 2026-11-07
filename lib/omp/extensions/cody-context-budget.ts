// Loaded by omp itself (Bun), not by Cody's bundler: keep this file free of
// Cody imports so it resolves from any install location.
//
// Tells every SUBAGENT of a main chat, in one line of its system prompt, that
// its history is summarised automatically at a known size, so it works in
// steps and keeps `context_notes` current instead of redoing work after a
// summary. The size is what omp itself will apply, read from the agent dir's
// config.yml: `task.agentCompactionThresholdOverrides[<agent name>]`, else the
// root `compaction.thresholdTokens` / `compaction.thresholdPercent`.
//
// The config is re-read whenever config.yml's modification time changes (one
// stat per helper start), so a helper started after a change in Settings hears
// the limit omp now applies. The line is a pure function of (agent name, model
// window, config), so for a given helper it never changes under the provider's
// prompt cache. Main chats get nothing. This file registers NO `tool_call` /
// `tool_result` handler: omp turns off `task.speculativeLaunch` while any
// extension has one (see the disk-budget note in AGENTS.md).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Deps {
  /** Changes whenever the config file does (its mtime); a constant when it cannot be told. */
  stamp: () => number;
  /** The parsed config.yml, or null when it is missing or unreadable. */
  readConfig: () => unknown;
}

type Context = { agent?: { kind?: string; name?: string }; model?: { contextWindow?: number } };

type OmpApi = {
  on(event: "before_agent_start", handler: (event: { systemPrompt?: unknown }, ctx: Context) => { systemPrompt?: string[] }): void;
};

/** A limit as written in config.yml: a token count, or a share of the window. */
export type Limit = { tokens: number } | { percent: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** omp's own rule for an override: a positive integer, or "N%" with N in (0, 100]. Anything else is not a limit. */
export function parseLimit(value: unknown): Limit | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? { tokens: value } : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(value);
  if (!match) return null;
  const percent = Number(match[1]);
  return percent > 0 && percent <= 100 ? { percent } : null;
}

/** The limit omp applies to `agent`: its own override, else the root tokens, else the root percent. */
export function resolveLimit(config: unknown, agent: string): Limit | null {
  if (!isRecord(config)) return null;
  const task = isRecord(config.task) ? config.task : null;
  const overrides = task && isRecord(task.agentCompactionThresholdOverrides) ? task.agentCompactionThresholdOverrides : null;
  const own = overrides ? parseLimit(overrides[agent]) : null;
  if (own) return own;
  const compaction = isRecord(config.compaction) ? config.compaction : null;
  if (!compaction) return null;
  const tokens = compaction.thresholdTokens;
  if (typeof tokens === "number" && tokens > 0) return { tokens: Math.floor(tokens) };
  const percent = compaction.thresholdPercent;
  if (typeof percent === "number" && percent > 0 && percent <= 100) return { percent };
  return null;
}

/** 200000 -> "200k", 1000000 -> "1M", 272000 -> "272k". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** How the line starts, so a stale one is recognised when the config has changed since. */
const LINE_PREFIX = "Context budget: your history is summarised automatically";

const ADVICE =
  "Work in steps that each leave a clear result. When the context-window reminder arrives, bring context_notes up to date (task, decisions, changed files, evidence, exact next steps) before continuing, and after a summary check your notes before re-reading files or re-running work.";

/** The one line. `window` is the model's context window in tokens, when known. */
export function budgetLine(limit: Limit | null, window: number | undefined): string {
  const known = typeof window === "number" && Number.isFinite(window) && window > 1 ? Math.floor(window) : null;
  let clause = "";
  if (limit && "tokens" in limit) {
    const tokens = known ? Math.min(limit.tokens, known - 1) : limit.tokens;
    clause = ` at about ${formatTokens(tokens)} tokens${known ? ` (this model's window is ${formatTokens(known)} tokens)` : ""}`;
  } else if (limit) {
    clause = known
      ? ` at about ${formatTokens(Math.round((known * limit.percent) / 100))} tokens (${limit.percent}% of this model's ${formatTokens(known)}-token window)`
      : ` at about ${limit.percent}% of this model's context window`;
  }
  return `${LINE_PREFIX}${clause}. ${ADVICE}`;
}

/** The extension, over its collaborators (a test hands in a fake config). */
export function createContextBudget(deps: Deps): (pi: OmpApi) => void {
  let config: unknown = null;
  let loadedAt: number | undefined;
  const lineFor = (agent: string, window: number | undefined): string => {
    const stamp = deps.stamp();
    if (loadedAt !== stamp) {
      loadedAt = stamp;
      try {
        config = deps.readConfig();
      } catch {
        config = null;
      }
    }
    return budgetLine(resolveLimit(config, agent), window);
  };

  return function codyContextBudget(pi: OmpApi): void {
    pi.on("before_agent_start", (event, ctx) => {
      // Never replace a prompt this file cannot read: the result REPLACES the system prompt.
      if (ctx.agent?.kind !== "sub" || !Array.isArray(event?.systemPrompt)) return {};
      const current: string[] = event.systemPrompt;
      const line = lineFor((ctx.agent.name ?? "").toLowerCase(), ctx.model?.contextWindow);
      // A line from an earlier read of a changed config is replaced, never stacked.
      return { systemPrompt: current.includes(line) ? current : [...current.filter((entry) => !(typeof entry === "string" && entry.startsWith(LINE_PREFIX))), line] };
    });
  };
}

/** Bun's global, present when omp runs this file (omp is a Bun program); absent under Node, where the line just has no numbers. */
declare const Bun: { YAML: { parse(text: string): unknown } } | undefined;

/** `<agent dir>/config.yml`, the file omp reads its settings from. */
const CONFIG_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "config.yml");

function readOmpConfig(path: string): unknown {
  if (typeof Bun === "undefined") return null;
  return Bun.YAML.parse(readFileSync(path, "utf8"));
}

function configStamp(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

export default createContextBudget({ stamp: () => configStamp(CONFIG_PATH), readConfig: () => readOmpConfig(CONFIG_PATH) });
