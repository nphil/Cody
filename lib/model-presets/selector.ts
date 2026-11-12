/**
 * Pure selector helpers for editing a preset's roles and fallback chains in
 * the UI. Mirrors `ModelRoles.splitSelector`'s dialect (itself mirroring
 * `lib/model-plan/derive.ts`'s effort-suffix recognition) so a selector
 * reads the same whether the role picker, the chain editor or the research
 * review is the one splitting it — and mirrors `store.ts`'s own
 * `readRoles`/`updatePreset`: an empty or absent role entry means "inherit
 * the base config".
 *
 * Client-safe: no node imports, so this can be imported from "use client"
 * components and from a plain node test alike.
 */
import { isRecognizedThinkingSuffix } from "../model-plan/derive";

/** Sentinel for "inherit the base config" — what an absent or blank role
 *  entry already means to `ModelPreset.roles` and to the PUT route (a role
 *  present with `""` is dropped server-side, same as being absent). */
export const INHERIT = "";

export interface SplitSelector {
  model: string;
  level: string;
}

/**
 * Split `provider/modelId[:level]` into its model and reasoning level.
 * `knownSelectors` are exact selectors that must never be split (a model id
 * can itself contain a colon, e.g. `ollama/qwen3:8b`); everything else is
 * only split when the trailing segment is a level OMP would recognize.
 */
export function splitPresetSelector(raw: string, knownSelectors: ReadonlySet<string>): SplitSelector {
  if (!raw) return { model: "", level: "" };
  if (knownSelectors.has(raw)) return { model: raw, level: "" };
  const colon = raw.lastIndexOf(":");
  if (colon <= raw.lastIndexOf("/") || !isRecognizedThinkingSuffix(raw.slice(colon + 1))) {
    return { model: raw, level: "" };
  }
  return { model: raw.slice(0, colon), level: raw.slice(colon + 1) };
}

/** Inverse of `splitPresetSelector`. An empty model always joins back to
 *  the inherit sentinel, even if a level is somehow still set. */
export function joinPresetSelector(model: string, level: string): string {
  if (!model) return INHERIT;
  return level ? `${model}:${level}` : model;
}

/** A preset selector as the routing layer needs it. */
export interface ParsedPresetSelector {
  provider: string;
  modelId: string;
  /** The `:level` suffix when omp would recognize it as a reasoning level,
   *  else null — a model id may itself contain a colon (`qwen3:8b`, `:free`). */
  thinkingLevel: string | null;
}

/** Parse `provider/modelId[:level]` into provider, model id and reasoning
 *  level; null when there is no provider or no model id. The ONE parser for
 *  the server (Smart resolution) and the composer (preset hints). */
export function parsePresetSelector(selector: string): ParsedPresetSelector | null {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return null;
  const provider = selector.slice(0, slash);
  let modelId = selector.slice(slash + 1);
  let thinkingLevel: string | null = null;
  const colon = modelId.lastIndexOf(":");
  if (colon > 0 && isRecognizedThinkingSuffix(modelId.slice(colon + 1))) {
    thinkingLevel = modelId.slice(colon + 1);
    modelId = modelId.slice(0, colon);
  }
  return modelId ? { provider, modelId, thinkingLevel } : null;
}

/** First omp release whose provider-qualified selectors (`provider/id`) must
 *  name an exact model id: near matches fail there with a "did you mean"
 *  error, where older engines silently picked a sibling. */
export const EXACT_SELECTOR_SINCE = "18.14.0";

/** A `provider/id[:level]` selector omp cannot resolve, with the provider's
 *  closest ids (as `provider/id`) the way omp's own error names them. */
export interface SelectorProblem {
  selector: string;
  suggestions: string[];
}

/** omp's fuzzy match: every character of `needle` appears in order in `hay`. */
function isSubsequence(needle: string, hay: string): boolean {
  let at = 0;
  for (const char of hay) if (char === needle[at] && ++at === needle.length) return true;
  return needle.length === 0;
}

/**
 * Check one preset or chain entry against the live roster the way omp >=18.14
 * resolves it: when the text before the first `/` names a provider the roster
 * has, the rest must be one of that provider's exact ids (case-insensitive,
 * with or without a trailing recognized `:level`). Returns null when the entry
 * resolves, or when no verdict is possible: a role reference (`@smol`), a
 * wildcard (`openai/*`), or a provider the roster does not list (it may only be
 * briefly unavailable, so the entry is still saveable).
 */
export function selectorProblem(selector: string, models: ReadonlyArray<{ provider: string; id: string }>): SelectorProblem | null {
  const slash = selector.indexOf("/");
  if (selector.startsWith("@") || slash <= 0 || slash === selector.length - 1 || selector.endsWith("/*")) return null;
  const provider = selector.slice(0, slash).toLowerCase();
  const ids = models.filter((model) => model.provider.toLowerCase() === provider).map((model) => model.id);
  if (ids.length === 0) return null;

  const rest = selector.slice(slash + 1).toLowerCase();
  const lower = new Set(ids.map((id) => id.toLowerCase()));
  if (lower.has(rest)) return null;
  const colon = rest.lastIndexOf(":");
  const base = colon > 0 && isRecognizedThinkingSuffix(selector.slice(slash + 1 + colon + 1)) ? rest.slice(0, colon) : rest;
  if (lower.has(base)) return null;

  const suggestions = ids
    .filter((id) => isSubsequence(base, id.toLowerCase()))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 3)
    .map((id) => `${selector.slice(0, slash)}/${id}`);
  return { selector, suggestions };
}

/** The readable sentence for a refused selector. */
export function selectorProblemMessage(problem: SelectorProblem): string {
  const hint = problem.suggestions.length > 0 ? ` Did you mean ${problem.suggestions.join(", ")}?` : "";
  return `"${problem.selector}" is not a model this engine lists, and omp no longer guesses a close match for provider/model selectors.${hint}`;
}

/** The first unresolvable entry among a preset update's roles and chains, or null. */
export function firstSelectorProblem(
  update: { roles?: unknown; chains?: unknown },
  models: ReadonlyArray<{ provider: string; id: string }>,
): SelectorProblem | null {
  const entries: string[] = [];
  if (update.roles && typeof update.roles === "object" && !Array.isArray(update.roles)) {
    for (const value of Object.values(update.roles)) if (typeof value === "string") entries.push(value);
  }
  if (update.chains && typeof update.chains === "object" && !Array.isArray(update.chains)) {
    // Chain KEYS are not checked: a key for a model that has left the roster
    // is stale bookkeeping, and refusing it would block every other edit.
    for (const list of Object.values(update.chains)) {
      if (Array.isArray(list)) for (const value of list) if (typeof value === "string") entries.push(value);
    }
  }
  for (const entry of entries) {
    const problem = selectorProblem(entry, models);
    if (problem) return problem;
  }
  return null;
}
