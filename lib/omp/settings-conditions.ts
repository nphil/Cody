/**
 * OMP gates a handful of settings behind named predicates (`ui.condition`) and
 * hides them when the predicate is false — there is no point offering Mnemopi
 * tuning while the memory backend is Hindsight. The predicates live in OMP's
 * TUI layer, so Cody restates the value-derived ones here to reproduce the same
 * show/hide behaviour from the settings it already has in hand.
 *
 * A condition not listed here (or one whose gating setting is unreadable) is
 * treated as satisfied: showing an inert row is far better than silently
 * hiding a setting after an upstream rename.
 */

export interface ConditionRule {
  /** Dotted path of the setting the predicate reads. */
  key: string;
  /** The predicate holds when that setting equals this value. */
  equals: boolean | string;
}

export const SETTING_CONDITIONS: Record<string, ConditionRule> = {
  advisorEnabled: { key: "advisor.enabled", equals: true },
  autolearnActive: { key: "autolearn.enabled", equals: true },
  autoThinkingActive: { key: "defaultThinkingLevel", equals: "auto" },
  hindsightActive: { key: "memory.backend", equals: "hindsight" },
  mnemopiActive: { key: "memory.backend", equals: "mnemopi" },
  planModeEnabled: { key: "plan.enabled", equals: true },
  usageAwareFallbackEnabled: { key: "retry.usageAwareFallback", equals: true },
  // hasImageProtocol is a terminal capability probe with no web equivalent, so
  // it is deliberately absent and its settings always render.
};

/** Whether a setting gated by `condition` should be shown, given current values. */
export function isConditionSatisfied(condition: string | undefined, resolved: (key: string) => unknown): boolean {
  if (!condition) return true;
  const rule = SETTING_CONDITIONS[condition];
  if (!rule) return true;
  return resolved(rule.key) === rule.equals;
}
