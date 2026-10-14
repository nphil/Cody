/**
 * "This Claude model is out on the plan, but the API credits carry it."
 *
 * The routing passes (role binding, chain filtering, agent pins) all ask
 * whether a model is exhausted and, if so, route AROUND it — to the next entry
 * of the user's chain. With Claude API credits saved that answer is wrong for a
 * Claude plan model: omp's own fallback chain puts the model's API twin first,
 * so the very same model keeps working, and sending a role to Codex (or any
 * other provider) now would jump ahead of credits the user set aside for
 * exactly this moment. A plan model is therefore "covered" while the credits
 * can still answer for it; only when EVERY saved key is spent (omp blocks a key
 * it was refused on, which Cody's usage snapshot reports as an exhausted
 * `anthropic-api…` account — one provider per key) does the old behaviour come back.
 */

import { CLAUDE_PLAN_PROVIDER, claudeCreditsSlot } from "../claude-credits";
import type { UsageSnapshot } from "../usage/types";

/** The saved credits, as far as routing needs them. */
export interface ClaudeCreditsCover {
  /** The Claude models the credits can answer for (ids only). */
  modelIds: ReadonlySet<string>;
  /** How many API keys are served (default 1). The usage snapshot lists only the
   * keys omp has BLOCKED, so "spent" means as many blocked keys as served ones. */
  keyCount?: number;
}

/** Saved keys omp has blocked, as the usage snapshot reports them. */
function spentKeys(snapshot: UsageSnapshot | null): number {
  return (snapshot?.accounts ?? []).filter((account) => claudeCreditsSlot(account?.provider) !== null
    && (account.windows ?? []).some((window) => window?.state === "exhausted" && !window.tier)).length;
}

export function coveredByClaudeCredits(
  snapshot: UsageSnapshot | null,
  provider: string,
  modelId: string,
  cover: ClaudeCreditsCover | null | undefined,
): boolean {
  if (!cover || provider !== CLAUDE_PLAN_PROVIDER || !cover.modelIds.has(modelId)) return false;
  return spentKeys(snapshot) < (cover.keyCount ?? 1);
}
