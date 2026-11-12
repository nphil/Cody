// How big a helper agent's history may grow before omp summarises it. The ONE
// copy of the rule, browser-safe and Bun-safe (its only import is the tiny type-guards module): the Settings
// card (components/settings/engine/helper-memory.ts), the helper's own prompt
// line (lib/omp/extensions/cody-context-budget.ts, loaded by omp under Bun)
// and the subagent chips in the composer.
//
// The size is what omp itself applies, from config.yml:
// `task.agentCompactionThresholdOverrides[<agent name>]` (a token count or
// "N%"), else the root `compaction.thresholdTokens`, else the root
// `compaction.thresholdPercent`, applied to the helper's model context window.

import { isRecord } from "./type-guards";

/** One limit: a share of the model's window, or a fixed token count. */
export type HelperLimit = { mode: "percent" | "tokens"; value: number };

const PERCENT_ENTRY = /^(\d+(?:\.\d+)?)%$/;

/** omp's rule for one override: a positive integer, or "N%" with N in (0, 100]. Anything else is not a limit. */
export function parseOverride(entry: unknown): HelperLimit | null {
  if (typeof entry === "number") return Number.isSafeInteger(entry) && entry > 0 ? { mode: "tokens", value: entry } : null;
  if (typeof entry !== "string") return null;
  const match = PERCENT_ENTRY.exec(entry.trim());
  const percent = match ? Number(match[1]) : Number.NaN;
  return percent > 0 && percent <= 100 ? { mode: "percent", value: percent } : null;
}

/** The limit omp applies to `agent`: its own override, else the root tokens, else the root percent. */
export function resolveHelperLimit(config: unknown, agent: string): HelperLimit | null {
  if (!isRecord(config)) return null;
  const task = isRecord(config.task) ? config.task : null;
  const overrides = task && isRecord(task.agentCompactionThresholdOverrides) ? task.agentCompactionThresholdOverrides : null;
  const own = overrides ? parseOverride(overrides[agent]) : null;
  if (own) return own;
  const compaction = isRecord(config.compaction) ? config.compaction : null;
  if (!compaction) return null;
  const tokens = compaction.thresholdTokens;
  if (typeof tokens === "number" && tokens > 0) return { mode: "tokens", value: Math.floor(tokens) };
  const percent = compaction.thresholdPercent;
  if (typeof percent === "number" && percent > 0 && percent <= 100) return { mode: "percent", value: percent };
  return null;
}

function knownWindow(window: number | undefined | null): number | null {
  return typeof window === "number" && Number.isFinite(window) && window > 1 ? Math.floor(window) : null;
}

/** The limit in tokens for a model with this window (a token limit never exceeds the window); null when the window is unknown. */
export function limitTokens(limit: HelperLimit, window: number | undefined | null): number | null {
  const known = knownWindow(window);
  if (known === null) return null;
  return limit.mode === "tokens" ? Math.min(limit.value, known - 1) : Math.round((known * limit.value) / 100);
}

/** What a helper is held to: the size in tokens and its share of the window (0-100, rounded). */
export interface EffectiveHelperLimit {
  tokens: number;
  percent: number;
}

/** The limit in force for `agent` on a model with `window`, or null when it has none or the window is unknown. */
export function effectiveHelperLimit(config: unknown, agent: string, window: number | undefined | null): EffectiveHelperLimit | null {
  const known = knownWindow(window);
  if (known === null) return null;
  const limit = resolveHelperLimit(config, agent);
  if (!limit) return null;
  const tokens = limitTokens(limit, known);
  if (tokens === null) return null;
  return { tokens, percent: limit.mode === "percent" ? limit.value : Math.round((tokens / known) * 100) };
}

/** 200000 -> "200k", 1000000 -> "1M", 272000 -> "272k". */
export function formatLimitTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
