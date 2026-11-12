// Loaded by omp itself (Bun), not by Cody's bundler: its only Cody import is
// the shared limit rule (lib/helper-memory-limit.ts, a relative path inside the
// package that also holds this file), which has no dependencies of its own.
//
// Tells every SUBAGENT of a main chat, in one line of its system prompt, that
// its history is summarised automatically at a known size, so it works in
// steps and keeps `context_notes` current instead of redoing work after a
// summary. The size is what omp itself will apply, read from the agent dir's
// config.yml: `task.agentCompactionThresholdOverrides[<agent name>]`, else the
// `compaction.modelThresholds` entry for the helper's model, else the root
// `compaction.thresholdTokens` / `compaction.thresholdPercent` (the rule itself
// is lib/helper-memory-limit.ts).
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
import { clampPercent, formatLimitTokens, limitTokens, resolveHelperLimit, type CompactionPoint, type HelperModel } from "../../helper-memory-limit";

export interface Deps {
  /** Changes whenever the config file does (its mtime); a constant when it cannot be told. */
  stamp: () => number;
  /** The parsed config.yml, or null when it is missing or unreadable. */
  readConfig: () => unknown;
}

type Context = { agent?: { kind?: string; name?: string }; model?: HelperModel & { contextWindow?: number } };

type OmpApi = {
  on(event: "before_agent_start", handler: (event: { systemPrompt?: unknown }, ctx: Context) => { systemPrompt?: string[] }): void;
};

/** How the line starts, so a stale one is recognised when the config has changed since. */
const LINE_PREFIX = "Context budget: your history is summarised automatically";

const ADVICE =
  "Work in steps that each leave a clear result. When the context-window reminder arrives, bring context_notes up to date (task, decisions, changed files, evidence, exact next steps) before continuing, and after a summary check your notes before re-reading files or re-running work.";

/** The one line. `window` is the model's context window in tokens, when known. */
export function budgetLine(limit: CompactionPoint | null, window: number | undefined): string {
  const known = typeof window === "number" && Number.isFinite(window) && window > 1 ? Math.floor(window) : null;
  const tokens = limit && known ? limitTokens(limit, known) : null;
  let clause = "";
  if (limit?.mode === "percent" && limit.base === undefined) {
    clause = known && tokens !== null
      ? ` at about ${formatLimitTokens(tokens)} tokens (${clampPercent(limit.value)}% of this model's ${formatLimitTokens(known)}-token window)`
      : ` at about ${clampPercent(limit.value)}% of this model's context window`;
  } else if (limit && (tokens !== null || limit.mode === "tokens")) {
    // A token limit, or a model entry omp scales: only the result is worth saying.
    clause = ` at about ${formatLimitTokens(tokens ?? limit.value)} tokens${known ? ` (this model's window is ${formatLimitTokens(known)} tokens)` : ""}`;
  }
  return `${LINE_PREFIX}${clause}. ${ADVICE}`;
}

/** The extension, over its collaborators (a test hands in a fake config). */
export function createContextBudget(deps: Deps): (pi: OmpApi) => void {
  let config: unknown = null;
  let loadedAt: number | undefined;
  const lineFor = (agent: string, model: Context["model"]): string => {
    const stamp = deps.stamp();
    if (loadedAt !== stamp) {
      loadedAt = stamp;
      try {
        config = deps.readConfig();
      } catch {
        config = null;
      }
    }
    return budgetLine(resolveHelperLimit(config, agent, model), model?.contextWindow);
  };

  return function codyContextBudget(pi: OmpApi): void {
    pi.on("before_agent_start", (event, ctx) => {
      // Never replace a prompt this file cannot read: the result REPLACES the system prompt.
      if (ctx.agent?.kind !== "sub" || !Array.isArray(event?.systemPrompt)) return {};
      const current: string[] = event.systemPrompt;
      const line = lineFor((ctx.agent.name ?? "").toLowerCase(), ctx.model);
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
