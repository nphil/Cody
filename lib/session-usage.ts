/**
 * The one place per-message usage becomes a session rollup.
 *
 * A session's tokens and API-equivalent cost are the sum of the `usage`
 * recorded on each assistant message. That arithmetic runs over two different
 * inputs — the parent transcript in the browser, and each subagent transcript
 * in the parent's sibling artifacts dir on the server — so it lives here
 * instead of being written twice and drifting.
 *
 * Two opposite failure modes this module exists to prevent:
 *
 *  - UNDER-COUNT. omp writes every subagent transcript beside the parent
 *    session file (see lib/subagent-history.ts) and the session walk
 *    deliberately skips that directory, so a rollup over the parent's own
 *    assistant messages misses every token an orchestrated run spent in its
 *    children — which is how this repo is developed.
 *  - DOUBLE-COUNT. The parent's `task` toolResult carries a tokens/cost rollup
 *    per child, but that is a DISPLAY value derived from the very same events.
 *    Adding it to the transcript sum counts the children twice, which is just
 *    as wrong as missing them.
 *
 * The rule: usage is counted once, at the assistant message that reported it.
 */

import type { AgentMessage } from "./types";
import { asCount } from "./type-guards";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** API-equivalent list-price spend, summed from each `usage.cost.total`. */
  cost: number;
  /**
   * Models whose messages reported tokens while their whole contribution
   * priced at zero. omp prices an uncatalogued model at 0 rather than flagging
   * it, so these names are exactly why `cost` is a floor rather than a total.
   */
  unpricedModels: string[];
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedModels: [] };
}

/** Tokens a rollup accounts for. Reasoning tokens are deliberately absent:
 *  every engine reports them as a subset of output, so adding them would
 *  inflate the total by counting the same tokens twice. */
export function usageTokenTotal(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * `provider/model`, the form the model picker shows, so a name in the unpriced
 * list is one the reader can act on. Ids that already carry their provider
 * (models.dev style) are left alone rather than doubled.
 */
export function usageModelId(provider: string | undefined, model: string | undefined): string {
  const providerId = typeof provider === "string" ? provider.trim() : "";
  const modelId = typeof model === "string" ? model.trim() : "";
  if (!providerId) return modelId;
  if (!modelId) return providerId;
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

/**
 * Sum the usage recorded on a transcript's assistant messages.
 *
 * "Unpriced" is decided per model over its WHOLE contribution, not per
 * message: a single turn served entirely from cache can legitimately cost
 * ~zero, and flagging its model on that basis would cry wolf about a model
 * that is priced perfectly well.
 */
export function aggregateMessageUsage(messages: readonly AgentMessage[]): UsageTotals {
  const totals = emptyUsageTotals();
  const perModel = new Map<string, { tokens: number; cost: number }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage) continue;
    const input = asCount(usage.input);
    const output = asCount(usage.output);
    const cacheRead = asCount(usage.cacheRead);
    const cacheWrite = asCount(usage.cacheWrite);
    const cost = asCount(usage.cost?.total);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.cost += cost;
    const tokens = input + output + cacheRead + cacheWrite;
    if (tokens <= 0 && cost <= 0) continue;
    const id = usageModelId(message.provider, message.model);
    if (!id) continue;
    const seen = perModel.get(id);
    if (seen) {
      seen.tokens += tokens;
      seen.cost += cost;
    } else {
      perModel.set(id, { tokens, cost });
    }
  }
  for (const [id, model] of perModel) {
    if (model.tokens > 0 && model.cost <= 0) totals.unpricedModels.push(id);
  }
  totals.unpricedModels.sort();
  return totals;
}

/** Combine rollups from disjoint transcripts. Unpriced names are a union: a
 *  model unpriced anywhere makes the combined cost a floor everywhere. */
export function addUsageTotals(...parts: readonly UsageTotals[]): UsageTotals {
  const totals = emptyUsageTotals();
  const unpriced = new Set<string>();
  for (const part of parts) {
    totals.input += asCount(part.input);
    totals.output += asCount(part.output);
    totals.cacheRead += asCount(part.cacheRead);
    totals.cacheWrite += asCount(part.cacheWrite);
    totals.cost += asCount(part.cost);
    for (const id of part.unpricedModels) unpriced.add(id);
  }
  totals.unpricedModels = [...unpriced].sort();
  return totals;
}
