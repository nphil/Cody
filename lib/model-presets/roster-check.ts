import { getHarness } from "../harness";
import { engineAtLeast } from "../model-kinds";
import { loadRoster } from "../model-plan/roster";
import { EXACT_SELECTOR_SINCE, firstSelectorProblem, selectorProblemMessage } from "./selector";

/**
 * omp >= 18.14 refuses a `provider/id` selector that is not an exact id and
 * only names near matches in the error, so a shortened or dated id typed into
 * a preset would save fine and then fail every chat bound to it. This is the
 * save-time check: the readable refusal for the first role or chain entry the
 * live roster cannot resolve, or null.
 *
 * Tolerant by design: an older engine still resolves near matches itself, and a
 * roster that cannot be read (engine busy, no login yet) gives no verdict, so
 * neither case blocks a save.
 */
export async function presetRosterProblem(update: { roles?: unknown; chains?: unknown }): Promise<string | null> {
  if (update.roles === undefined && update.chains === undefined) return null;
  try {
    if (!engineAtLeast(await getHarness().getVersion(), EXACT_SELECTOR_SINCE)) return null;
    const { models } = await loadRoster();
    const problem = firstSelectorProblem(update, models);
    return problem ? selectorProblemMessage(problem) : null;
  } catch {
    return null;
  }
}
