/**
 * What the Send menu's "Model" row needs that is not a React concern: which
 * models a search finds, which reasoning levels one model offers, and how a
 * choice reads ("Opus 4.8 · High"). Pure and browser-safe, like ui.ts.
 *
 * The catalog is the COMPOSER's (components/ChatInput.tsx builds it from the
 * same list the model picker shows), so a model offered here is one the chat
 * can be switched to, spelled the way the picker spells it.
 */
import { selectableThinkingLevels } from "../thinking-levels";
import { thinkingLevelLabel } from "../thinking-level-labels";
import type { ScheduledModelChoice } from "./types";

/** `useI18n().t` / `translate`. */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** One model as the picker lists it. */
export interface ScheduleModelOption {
  provider: string;
  modelId: string;
  /** The display name ("Opus 4.8"), never the raw id unless the catalog knows nothing better. */
  name: string;
}

export interface ScheduleModelGroup {
  id: string;
  provider: string;
  options: readonly ScheduleModelOption[];
}

/** What the menu may choose from, handed over by the composer. */
export interface ScheduleModelCatalog {
  /** The chat's own model: what "Same as chat" means. Null while the chat has none. */
  current: ScheduleModelOption | null;
  /** The composer's pinned models, one group per provider: what the list shows before a search. */
  groups: readonly ScheduleModelGroup[];
  /** Every model the chat may be switched to: what a search looks through. */
  all: readonly ScheduleModelOption[];
  /** `provider:modelId` -> the model's own reasoning ladder, as the models route bakes it (`["off", ...efforts]`). */
  levels: Readonly<Record<string, readonly string[]>>;
  /** Display names two providers share: their rows add the provider so they can be told apart. */
  duplicateNames: ReadonlySet<string>;
  /** "Limit reached · resets 11:40 PM" for a model whose quota is spent, else null. The model stays choosable: queueing onto it is the point. */
  limitText?: (option: ScheduleModelOption) => string | null;
}

/** The one spelling of a model in a key: `provider/modelId`. */
export function scheduleModelKey(model: { provider: string; modelId: string }): string {
  return `${model.provider}/${model.modelId}`;
}

export function sameScheduleModel(a: { provider: string; modelId: string } | null | undefined, b: { provider: string; modelId: string } | null | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.modelId === b.modelId);
}

/** The catalog's entry for a choice, or null when the catalog no longer lists it. */
export function findScheduleModel(catalog: Pick<ScheduleModelCatalog, "all">, model: { provider: string; modelId: string } | null | undefined): ScheduleModelOption | null {
  if (!model) return null;
  return catalog.all.find((option) => sameScheduleModel(option, model)) ?? null;
}

const SEPARATORS = /[\s\-_.:/]+/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(SEPARATORS, " ").trim();
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The models a typed phrase finds: every word of it appears somewhere in the
 * provider, the id or the display name ("opus 4.8" finds "claude-opus-4-8"),
 * or the phrase's letters and digits appear in them once punctuation is gone.
 * An empty phrase finds everything. Order is the catalog's.
 */
export function searchScheduleModels<T extends ScheduleModelOption>(options: readonly T[], query: string): T[] {
  const phrase = query.trim();
  if (phrase === "") return [...options];
  const words = phrase.split(/[\s/]+/).map(normalize).filter((word) => word !== "");
  const squashed = squash(phrase);
  return options.filter((option) => {
    const haystack = normalize(`${option.provider} ${option.modelId} ${option.name}`);
    if (words.every((word) => haystack.includes(word))) return true;
    return squashed !== "" && squash(`${option.provider}${option.modelId}${option.name}`).includes(squashed);
  });
}

/** Options grouped by provider, providers in first-seen order, each group's models in the order given. */
export function groupScheduleModels(options: readonly ScheduleModelOption[]): ScheduleModelGroup[] {
  const groups = new Map<string, ScheduleModelOption[]>();
  for (const option of options) {
    const list = groups.get(option.provider) ?? [];
    list.push(option);
    groups.set(option.provider, list);
  }
  return [...groups].map(([provider, list]) => ({ id: `provider:${provider}`, provider, options: list }));
}

/**
 * The reasoning levels a model offers for a scheduled message: the composer's
 * own ladder (Auto first, then Off and the model's efforts), from the model's
 * own entry in the models route. A model that offers only "Off" — or that the
 * catalog has no ladder for — has no real choice to make, so the list is
 * empty and the selector stays out of the way. The leading "Default" (no level
 * set: the chat keeps the one it has) is the menu's, not a level.
 */
export function scheduleReasoningLevels(catalog: Pick<ScheduleModelCatalog, "levels">, model: { provider: string; modelId: string } | null | undefined): string[] {
  if (!model) return [];
  const ladder = catalog.levels[`${model.provider}:${model.modelId}`];
  if (!ladder || ladder.length < 2) return [];
  return selectableThinkingLevels(ladder);
}

/**
 * A choice made for one model, kept valid for another: choosing a different
 * model drops the reasoning level (it was one of the OLD model's); choosing
 * the same one keeps it. A level the model does not offer is never kept.
 */
export function chooseScheduleModel(
  catalog: Pick<ScheduleModelCatalog, "levels">,
  previous: ScheduledModelChoice | null,
  next: { provider: string; modelId: string },
): ScheduledModelChoice {
  const keep = previous && sameScheduleModel(previous, next) && previous.thinkingLevel && scheduleReasoningLevels(catalog, next).includes(previous.thinkingLevel);
  return keep ? { provider: next.provider, modelId: next.modelId, thinkingLevel: previous.thinkingLevel } : { provider: next.provider, modelId: next.modelId };
}

/** The choice with `level` as its reasoning, or without one (`null`: Default). */
export function withScheduleReasoning(choice: ScheduledModelChoice, level: string | null): ScheduledModelChoice {
  return level ? { provider: choice.provider, modelId: choice.modelId, thinkingLevel: level } : { provider: choice.provider, modelId: choice.modelId };
}

export interface ScheduleModelText {
  /** "Opus 4.8" */
  name: string;
  /** "High", or null when the choice sets none. */
  level: string | null;
  /** "Opus 4.8 · High" */
  text: string;
}

/** A choice in words: the catalog's display name (the id when it knows none) and its reasoning level. */
export function scheduleModelText(
  choice: ScheduledModelChoice,
  name: string | null | undefined,
  t: Translate,
): ScheduleModelText {
  const shown = name?.trim() || choice.modelId;
  const level = choice.thinkingLevel ? thinkingLevelLabel(choice.thinkingLevel, t) : null;
  return { name: shown, level, text: level ? `${shown} · ${level}` : shown };
}
