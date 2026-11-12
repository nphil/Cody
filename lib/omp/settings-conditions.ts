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
  // omp 18.1.17: `plan.autosaveDir` is offered only once autosave is on.
  planAutosaveEnabled: { key: "plan.autosave", equals: true },
  usageAwareFallbackEnabled: { key: "retry.usageAwareFallback", equals: true },
  // omp 18.1.17: `tui.vimModeDisplay` is shown only while Vim mode is on. The
  // rows are terminal-only anyway, but the chip must not outnumber the TUI.
  vimModeEnabled: { key: "tui.vimMode", equals: true },
  // omp 18.14.2: `composer.predictionAlternatives` is offered only while
  // prompt prediction itself is on. Both rows are terminal-only today; the
  // rule keeps the pair consistent if Cody ever surfaces them.
  composerPredictionsEnabled: { key: "composer.predictions", equals: true },
  // hasImageProtocol is a terminal capability probe with no web equivalent, so
  // it is deliberately absent and its settings always render.
};

/** omp 18.14.2 / 18.16.0 hide three list editors (`contextFiles.extra`,
 * `tools.restrictedFolders`, `task.perCallModelAllow`) while the effective
 * list was supplied by a project settings file, so the terminal panel never
 * copies a repository's list into the global layer. Cody's panel reads and
 * writes the global layer only, so it never shows a project-supplied value
 * and there is nothing to hide: these predicates are always satisfied, and
 * are named here so the row carries no "only takes effect when…" hint. */
export const GLOBAL_LAYER_CONDITIONS: Record<string, true> = {
  contextFilesExtraNotProject: true,
  restrictedFoldersNotProject: true,
  perCallModelAllowNotProject: true,
};

/** Facts about the machine the harness binary runs on — the same machine as
 * the Cody server, so the schema route reports them and the browser applies
 * them. */
export interface HostFacts {
  platform: string;
}

/** Predicates OMP evaluates from its own process rather than from settings
 * values (omp 18: the macOS prompt-editor spelling settings are gated on
 * `condition: "macOS"` = `process.platform === "darwin"`). Cody hides the
 * same rows OMP hides; without host facts in hand they fail open. */
export const HOST_CONDITIONS: Record<string, (host: HostFacts) => boolean> = {
  macOS: (host) => host.platform === "darwin",
};

/** Whether a setting gated by `condition` should be shown, given current
 * values and (when known) the server host's facts. */
export function isConditionSatisfied(
  condition: string | undefined,
  resolved: (key: string) => unknown,
  host?: HostFacts,
): boolean {
  if (!condition) return true;
  if (GLOBAL_LAYER_CONDITIONS[condition] === true) return true;
  const hostRule = HOST_CONDITIONS[condition];
  if (hostRule) return host ? hostRule(host) : true;
  const rule = SETTING_CONDITIONS[condition];
  if (!rule) return true;
  return resolved(rule.key) === rule.equals;
}
