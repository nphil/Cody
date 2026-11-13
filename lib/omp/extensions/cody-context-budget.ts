// Loaded by omp itself (Bun), not by Cody's bundler: its only Cody import is
// the shared limit rule (lib/helper-memory-limit.ts, a relative path inside the
// package that also holds this file), which has no dependencies of its own.
//
// Tells every SUBAGENT of a main chat, in one hidden message, that its history
// is summarised automatically at a known size, so it works in steps and keeps
// `context_notes` current instead of redoing work after a summary. The size is
// what omp itself will apply, read from the agent dir's config.yml:
// `task.agentCompactionThresholdOverrides[<agent name>]`, else the
// `compaction.modelThresholds` entry for the helper's model, else the root
// `compaction.thresholdTokens` / `compaction.thresholdPercent` (the rule itself
// is lib/helper-memory-limit.ts).
//
// The line is a message and never a system-prompt line: omp reads ANY
// `before_agent_start` result that carries a `systemPrompt` as a replaced
// prompt, and answers by re-announcing its whole tool list (the xd:// catalog,
// thousands of tokens) as a user message. The message is added once per live
// context: a conversation that already holds it, back to its last compaction
// or `/clear`, gets nothing, and one that lost it gets it with the next prompt.
//
// The config is re-read whenever config.yml's modification time changes (one
// stat per helper start), so a helper started after a change in Settings hears
// the limit omp now applies; one that is prompted again after the change gets
// the new line as a newer note, the one the model reads last. The line is a
// pure function of (agent name, model window, config), so for a given helper
// it never changes under the provider's prompt cache. Main chats get nothing.
// This file registers NO `tool_call` / `tool_result` handler: omp turns off
// `task.speculativeLaunch` while any extension has one (see the disk-budget
// note in AGENTS.md).
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

type Context = {
  agent?: { kind?: string; name?: string };
  model?: HelperModel & { contextWindow?: number };
  sessionManager?: { getBranch?: () => unknown };
};

type HiddenMessage = { customType: string; content: string; display: false; attribution: "agent" };

type OmpApi = {
  on(event: "before_agent_start", handler: (event: unknown, ctx: Context) => { message?: HiddenMessage }): void;
};

/** The type of the hidden message; lib/message-display.ts HIDDEN_CUSTOM_TYPES keeps it out of the transcript, and the test pins the two together. */
export const CONTEXT_BUDGET_CUSTOM_TYPE = "cody-context-budget";

/** How the line starts. */
const LINE_PREFIX = "Context budget: your history is summarised automatically";

/**
 * Whether the conversation the model will read already holds `content` as its
 * newest `customType` note. omp keeps a note from `before_agent_start` as a
 * `custom_message` entry, so the answer is in the branch. A compaction folds the
 * messages before it into a summary and `/clear` drops them, so a note before
 * either is gone. A branch that cannot be read counts as "not there": a repeated
 * note costs a few hundred tokens, a missing line costs more. The same function,
 * word for word, is in cody-homelabber-gate.ts and cody-disk-budget.ts; the
 * test pins them to one another.
 */
export function noteIsLive(ctx: Context, customType: string, content: string): boolean {
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
    pi.on("before_agent_start", (_event, ctx) => {
      if (ctx.agent?.kind !== "sub") return {};
      const line = lineFor((ctx.agent.name ?? "").toLowerCase(), ctx.model);
      // The newest note of this type decides: a line read from an older config is
      // followed by the new one, and a line that is still the current one is not repeated.
      if (noteIsLive(ctx, CONTEXT_BUDGET_CUSTOM_TYPE, line)) return {};
      return { message: { customType: CONTEXT_BUDGET_CUSTOM_TYPE, content: line, display: false, attribution: "agent" } };
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
