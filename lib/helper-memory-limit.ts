// How big a helper agent's history may grow before omp summarises it. The ONE
// copy of the rule, browser-safe and Bun-safe (its only import is the tiny type-guards module): the Settings
// card (components/settings/engine/helper-memory.ts), the helper's own prompt
// line (lib/omp/extensions/cody-context-budget.ts, loaded by omp under Bun)
// and the subagent chips in the composer.
//
// The size is what omp itself applies, from config.yml, to the helper's model
// context window. omp's order (18.8.8+):
//   1. `task.agentCompactionThresholdOverrides[<agent name>]` (a token count or
//      "N%"): exact, and it outranks every model entry below;
//   2. `compaction.modelThresholds` for the helper's model (unless
//      `compaction.modelThresholdsEnabled` is false): the exact `provider/model-id`
//      key, else the longest `provider/prefix*` key. "f400000" is an exact
//      trigger, "N%" a share, and a plain token count is a BASE that the policy
//      below scales in place of the window;
//   3. the root `compaction.thresholdTokens`, else `compaction.thresholdPercent`.
// omp 18.8.3 has no model entries (its token limit is capped at window - 1, not
// at the window less its reserve; the difference only shows for a limit at or
// past the window, where the line then errs towards summarising earlier).

import { isRecord } from "./type-guards";

/** One limit: a share of the model's window, or a fixed token count. */
export type HelperLimit = { mode: "percent" | "tokens"; value: number };

/**
 * A limit as omp resolves it for one model: a {@link HelperLimit}, plus
 * `reserve` (`compaction.reserveTokens` when set: the headroom omp keeps below
 * the window) and, for a model entry that is a plain token count, `base` (the
 * window the policy is applied to in place of the real one). `mode: "base"` is
 * that entry with no percentage to scale it by: omp then summarises at the base
 * less its reserve.
 */
export type CompactionPoint = { mode: HelperLimit["mode"] | "base"; value: number; base?: number; reserve?: number };

/** The helper's model as omp names it in `compaction.modelThresholds`: `provider/id`. */
export interface HelperModel {
  provider?: string;
  id?: string;
}

const PERCENT_ENTRY = /^(\d+(?:\.\d+)?)%$/;
const FIXED_ENTRY = /^f(\d+)$/i;

/** omp's reserve when `compaction.reserveTokens` is unset. */
const DEFAULT_RESERVE_TOKENS = 16384;

/** omp's rule for one override: a positive integer, or "N%" with N in (0, 100]. Anything else is not a limit. */
export function parseOverride(entry: unknown): HelperLimit | null {
  if (typeof entry === "number") return Number.isSafeInteger(entry) && entry > 0 ? { mode: "tokens", value: entry } : null;
  if (typeof entry !== "string") return null;
  const match = PERCENT_ENTRY.exec(entry.trim());
  const percent = match ? Number(match[1]) : Number.NaN;
  return percent > 0 && percent <= 100 ? { mode: "percent", value: percent } : null;
}

/** omp's rule for one `compaction.modelThresholds` value: an override, plus "f<tokens>" (an exact trigger); a plain token count is a base the policy scales. */
function parseModelEntry(entry: unknown): CompactionPoint | null {
  if (typeof entry === "string") {
    const fixed = FIXED_ENTRY.exec(entry.trim());
    if (fixed) {
      const tokens = Number(fixed[1]);
      return Number.isSafeInteger(tokens) && tokens > 0 ? { mode: "tokens", value: tokens } : null;
    }
  }
  const own = parseOverride(entry);
  return own?.mode === "tokens" ? { mode: "base", value: own.value } : own;
}

/** The `compaction.modelThresholds` entry for `model`: its exact `provider/id` key wins, else the longest `…*` prefix key; entries omp would reject are skipped. */
function modelEntry(compaction: Record<string, unknown>, model: HelperModel | null | undefined): CompactionPoint | null {
  const thresholds = compaction.modelThresholds;
  if (compaction.modelThresholdsEnabled === false || !isRecord(thresholds) || !model?.provider || !model.id) return null;
  const selector = `${model.provider}/${model.id}`;
  let best: CompactionPoint | null = null;
  let bestLength = -1;
  for (const [key, entry] of Object.entries(thresholds)) {
    const point = parseModelEntry(entry);
    if (!point) continue;
    if (key === selector) return point;
    if (key.endsWith("*") && selector.startsWith(key.slice(0, -1)) && key.length > bestLength) {
      best = point;
      bestLength = key.length;
    }
  }
  return best;
}

/** The limit omp applies to `agent` running `model`: see the order in the header. Null when nothing limits it. */
export function resolveHelperLimit(config: unknown, agent: string, model?: HelperModel | null): CompactionPoint | null {
  if (!isRecord(config)) return null;
  const task = isRecord(config.task) ? config.task : null;
  const overrides = task && isRecord(task.agentCompactionThresholdOverrides) ? task.agentCompactionThresholdOverrides : null;
  const compaction = isRecord(config.compaction) ? config.compaction : {};
  const reserve = typeof compaction.reserveTokens === "number" && Number.isFinite(compaction.reserveTokens) && compaction.reserveTokens >= 0 ? compaction.reserveTokens : undefined;
  const withReserve = (point: CompactionPoint): CompactionPoint => (reserve === undefined ? point : { ...point, reserve });

  const own = overrides ? parseOverride(overrides[agent]) : null;
  if (own) return withReserve(own);

  const rootPercent = typeof compaction.thresholdPercent === "number" && compaction.thresholdPercent > 0 && compaction.thresholdPercent <= 100 ? compaction.thresholdPercent : null;
  const entry = modelEntry(compaction, model);
  // A base entry drops the root token limit and scales the root percentage (else the reserve policy) against itself.
  if (entry?.mode === "base" && rootPercent !== null) return withReserve({ mode: "percent", value: rootPercent, base: entry.value });
  if (entry) return withReserve(entry);

  const tokens = compaction.thresholdTokens;
  if (typeof tokens === "number" && tokens > 0) return withReserve({ mode: "tokens", value: Math.floor(tokens) });
  return rootPercent === null ? null : withReserve({ mode: "percent", value: rootPercent });
}

function knownWindow(window: number | undefined | null): number | null {
  return typeof window === "number" && Number.isFinite(window) && window > 1 ? Math.floor(window) : null;
}

/** omp clamps a configured share to 1-99%: a trigger at the whole window could never fire before the request overflows. */
export function clampPercent(percent: number): number {
  return Math.min(99, Math.max(1, percent));
}

/** The window less its reserve: `compaction.reserveTokens` (else 16384) or 15% of the window, whichever is larger; a DEFAULT reserve that leaves no room, or any reserve at or past the window, is the 15%. */
function promptBudget(window: number, reserve: number | undefined): number {
  const proportional = Math.max(1, Math.floor(window * 0.15));
  const effective = Math.max(Math.floor(window * 0.15), reserve ?? DEFAULT_RESERVE_TOKENS);
  const impossible = (reserve === undefined && effective >= window - proportional) || effective >= window;
  return Math.max(0, Math.min(window - 1, window - (impossible ? proportional : effective)));
}

/** Where omp summarises, in tokens, for a model with this window; null when the window is unknown. A token limit below the window is exact, at or past it the window less its reserve; a share is floored. */
export function limitTokens(limit: CompactionPoint, window: number | undefined | null): number | null {
  const known = knownWindow(window);
  if (known === null) return null;
  if (limit.mode === "tokens") return limit.value >= known ? promptBudget(known, limit.reserve) : limit.value;
  if (limit.mode === "base") return promptBudget(Math.min(known, limit.value), limit.reserve);
  const scaled = limit.base !== undefined && limit.base > 0 ? Math.min(known, limit.base) : known;
  return Math.floor(scaled * (clampPercent(limit.value) / 100));
}

/** What a helper is held to: the size in tokens and its share of the window (0-100, rounded). */
export interface EffectiveHelperLimit {
  tokens: number;
  percent: number;
}

/** The limit in force for `agent` (on `model`, when it is known) on a model with `window`, or null when it has none or the window is unknown. */
export function effectiveHelperLimit(config: unknown, agent: string, window: number | undefined | null, model?: HelperModel | null): EffectiveHelperLimit | null {
  const known = knownWindow(window);
  if (known === null) return null;
  const limit = resolveHelperLimit(config, agent, model);
  if (!limit) return null;
  const tokens = limitTokens(limit, known);
  if (tokens === null) return null;
  return { tokens, percent: limit.mode === "percent" && limit.base === undefined ? clampPercent(limit.value) : Math.round((tokens / known) * 100) };
}

/** 200000 -> "200k", 1000000 -> "1M", 272000 -> "272k". */
export function formatLimitTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
