/**
 * What was asked for -> exactly one model in a chat's live catalog, and one
 * reasoning level that model really has. Pure: no engine, no I/O.
 *
 * Nitin (or an agent speaking for him) says "opus 4.8", "gpt-5.5",
 * "anthropic/claude-opus-4-8" or "extra high". The catalog holds ids like
 * `claude-opus-4-8` under a provider. Resolution is deliberately strict about
 * the one thing that matters: it NEVER guesses. A phrase that fits several
 * models answers with the candidates, never with the one that looked likeliest,
 * because a wrong model is a paid mistake that looks like success.
 *
 * Models are matched in tiers, first tier with any hit decides:
 *   1. `provider/id`, exact then case-insensitive
 *   2. the bare id, exact then case-insensitive
 *   3. the display name, case-insensitive
 *   4. the same letters and digits once punctuation is dropped
 *      ("claude-opus-4.8" = "claude-opus-4-8")
 *   5. every word of the phrase appears somewhere in provider + id + name
 * One hit in a tier is the answer; several is ambiguity.
 */

import { hasUnverifiedLadder, selectableThinkingLevels, thinkingLevelsForMeta } from "../thinking-levels";

export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinking?: { efforts?: string[]; defaultLevel?: string; unverified?: boolean };
}

export type ModelResolution =
  | { kind: "resolved"; model: CatalogModel }
  | { kind: "ambiguous"; candidates: CatalogModel[] }
  | { kind: "unknown"; suggestions: CatalogModel[] };

export type LevelResolution =
  | { ok: true; level: string }
  | { ok: false; valid: string[] };

/** The one spelling of a model everywhere it is shown or sent: `provider/id`. */
export function modelKey(model: Pick<CatalogModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

const SEPARATORS = /[\s\-_.:/]+/g;
/** At most this many "did you mean" models. */
const MAX_SUGGESTIONS = 5;
/** Bigram similarity below this is noise, not a near miss. */
const SUGGESTION_FLOOR = 0.35;

/** Lowercase words, punctuation as single spaces: "Opus 4.8" -> "opus 4 8". */
function normalize(text: string): string {
  return text.toLowerCase().replace(SEPARATORS, " ").trim();
}

/** Letters and digits only: "claude-opus-4.8" -> "claudeopus48". */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function unique(models: readonly CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of models) {
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  if (text.length === 0) return grams;
  if (text.length === 1) {
    grams.set(text, 1);
    return grams;
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen–Dice over bigram counts: 1 identical, 0 nothing shared. */
function dice(a: Map<string, number>, b: Map<string, number>): number {
  let total = 0;
  for (const count of a.values()) total += count;
  for (const count of b.values()) total += count;
  if (total === 0) return 0;
  let overlap = 0;
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) ?? 0);
  return (2 * overlap) / total;
}

/** The nearest models to a phrase that matched none, best first. */
function suggest(query: string, models: readonly CatalogModel[]): CatalogModel[] {
  const wanted = bigrams(squash(query));
  if (wanted.size === 0) return [];
  const scored: Array<{ model: CatalogModel; score: number; order: number }> = [];
  models.forEach((model, order) => {
    let best = 0;
    for (const text of [model.id, model.name ?? "", modelKey(model)]) {
      const candidate = squash(text);
      if (candidate.length === 0) continue;
      best = Math.max(best, dice(wanted, bigrams(candidate)));
    }
    if (best >= SUGGESTION_FLOOR) scored.push({ model, score: best, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.model);
}

export function resolveModel(query: string, catalog: readonly CatalogModel[]): ModelResolution {
  const models = unique(catalog);
  const wanted = query.trim();
  if (wanted === "") return { kind: "unknown", suggestions: [] };
  const lower = wanted.toLowerCase();
  const squashed = squash(wanted);
  // "anthropic/opus-4.8" is two words (provider, model), "opus 4.8" is two,
  // and each stays one contiguous unit: "4.8" must not be satisfied by a stray
  // 4 and a stray 8 elsewhere in the id.
  const words = wanted.split(/[\s/]+/).map(normalize).filter((word) => word !== "");

  const tiers: Array<(model: CatalogModel) => boolean> = [
    (model) => modelKey(model) === wanted,
    (model) => modelKey(model).toLowerCase() === lower,
    (model) => model.id === wanted,
    (model) => model.id.toLowerCase() === lower,
    (model) => (model.name ?? "").toLowerCase() === lower,
    (model) => squashed !== "" && [modelKey(model), model.id, model.name ?? ""].some((text) => squash(text) === squashed),
    (model) => {
      if (words.length === 0) return false;
      const haystack = normalize(`${model.provider} ${model.id} ${model.name ?? ""}`);
      return words.every((word) => haystack.includes(word));
    },
  ];

  for (const tier of tiers) {
    const hits = models.filter(tier);
    if (hits.length === 1) return { kind: "resolved", model: hits[0] };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  }
  return { kind: "unknown", suggestions: suggest(wanted, models) };
}

/**
 * The levels one model offers, in the order the composer lists them. A model
 * without reasoning has exactly "off"; any other model has "auto" (the engine
 * decides), "off" and its own efforts — the same ladder the composer's
 * reasoning menu shows (lib/thinking-levels.ts), never a generic one. An
 * unverified ladder (omp has no capability data for the model) is offered too.
 */
export function modelThinkingLevels(model: CatalogModel): string[] {
  if (!model.reasoning && !hasUnverifiedLadder(model)) return ["off"];
  return selectableThinkingLevels(thinkingLevelsForMeta({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinking: model.thinking,
  }));
}

/** Other ways people say the engine's own levels. */
const LEVEL_SYNONYMS: Record<string, string> = {
  none: "off",
  no: "off",
  disabled: "off",
  false: "off",
  min: "minimal",
  minimum: "minimal",
  med: "medium",
  mid: "medium",
  "extra high": "xhigh",
  "very high": "xhigh",
  maximum: "max",
};

/**
 * `input` as one of `model`'s own levels, or the levels it does have.
 * Case-insensitive; "extra high", "x-high" and "xhigh" are one level, "none" is
 * "off". A level the model lacks is refused, not rounded to a neighbour: asking
 * for "high" on a model without it would otherwise quietly run something else.
 */
export function resolveThinkingLevel(input: string, model: CatalogModel): LevelResolution {
  const valid = modelThinkingLevels(model);
  const spaced = input.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (spaced === "") return { ok: false, valid };
  const candidates = [spaced, spaced.replace(/ /g, "")];
  if (Object.hasOwn(LEVEL_SYNONYMS, spaced)) candidates.push(LEVEL_SYNONYMS[spaced]);
  const level = candidates.find((candidate) => valid.includes(candidate));
  return level === undefined ? { ok: false, valid } : { ok: true, level };
}

/** Is this word one of the engine's reasoning levels (or a synonym)? Used to point out a level typed into the model name. */
export function looksLikeLevel(word: string): boolean {
  const spaced = word.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return Object.hasOwn(LEVEL_SYNONYMS, spaced) || selectableThinkingLevels(null).includes(spaced);
}
