/**
 * The one place per-message usage becomes a session rollup.
 *
 * A session's tokens and API-equivalent cost are the sum of the `usage`
 * recorded on each assistant message plus the `model_usage` entries omp writes
 * for billed calls that are not transcript messages (a late response, a
 * discarded empty or length-stopped turn, a cache-warm refresh, a helper call:
 * omp 18.17+ counts them in its own session total, its cost cap and
 * `omp stats`). That arithmetic runs over two different
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
 *    children — which is how this repo is developed. A `model_usage` entry is
 *    not a message and sits on no branch of the chat, so a rollup over the
 *    rendered messages misses it too.
 *  - DOUBLE-COUNT. The parent's `task` toolResult carries a tokens/cost rollup
 *    per child, but that is a DISPLAY value derived from the very same events.
 *    Adding it to the transcript sum counts the children twice, which is just
 *    as wrong as missing them.
 *
 * The rule: usage is counted once, at the assistant message or `model_usage`
 * entry that reported it.
 */

import type { AgentMessage, AssistantMessage, SessionEntry } from "./types";
import { asCount, isRecord } from "./type-guards";

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

/** What a rollup reads off one record: an assistant message or a `model_usage` entry. */
interface UsageRecord {
  usage?: AssistantMessage["usage"];
  provider?: string;
  model?: string;
}

/**
 * Sum the usage of every item `recordOf` yields a record for.
 *
 * "Unpriced" is decided per model over its WHOLE contribution, not per
 * message: a single turn served entirely from cache can legitimately cost
 * ~zero, and flagging its model on that basis would cry wolf about a model
 * that is priced perfectly well.
 */
function sumUsage<T>(items: readonly T[], recordOf: (item: T) => UsageRecord | undefined): UsageTotals {
  const totals = emptyUsageTotals();
  const perModel = new Map<string, { tokens: number; cost: number }>();
  for (const item of items) {
    const record = recordOf(item);
    const usage = record?.usage;
    if (!record || !usage) continue;
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
    const id = usageModelId(record.provider, record.model);
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

/** Sum the usage recorded on a transcript's assistant messages. */
export function aggregateMessageUsage(messages: readonly AgentMessage[]): UsageTotals {
  return sumUsage(messages, (message) => (message.role === "assistant" ? message : undefined));
}

/**
 * Sum every `model_usage` entry of a session file, whichever branch it sits on
 * (a late one names the branch it interrupted in `activeLeafId` but is spend
 * all the same). Disjoint from {@link aggregateMessageUsage}: the call a
 * `model_usage` entry records never also appears as an assistant message.
 */
export function aggregateModelUsage(entries: readonly SessionEntry[]): UsageTotals {
  return sumUsage(entries, (entry) => (entry.type === "model_usage" ? entry : undefined));
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

/**
 * Failed edits by the engine's reason, counted the way omp's own
 * `getSessionStats` does (session/session-stats.ts): an `edit` toolResult that
 * is an error and carries `details.errorKind`. omp >= 18.13 records the kind;
 * an older transcript has none, so the result is empty (never "zero failures"
 * claimed from missing data). Keys keep the engine's snake_case spelling.
 */
export function countEditRejections(messages: readonly AgentMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== "edit" || !message.isError) continue;
    if (!isRecord(message.details)) continue;
    const kind = message.details.errorKind;
    if (typeof kind === "string" && kind.length > 0) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** The stats panel's one-line summary, `3 (stale tag 2, no match 1)`: the
 *  engine's snake_case reasons as plain words (the spelling omp's own
 *  session-stats screen uses), most frequent first with ties in name order;
 *  null when nothing failed. */
export function formatEditRejections(rejections: Readonly<Record<string, number>> | undefined): string | null {
  if (!rejections) return null;
  const kinds = Object.entries(rejections)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort(([aKind, aCount], [bKind, bCount]) => bCount - aCount || aKind.localeCompare(bKind));
  if (kinds.length === 0) return null;
  const total = kinds.reduce((sum, [, count]) => sum + count, 0);
  return `${total.toLocaleString("en-US")} (${kinds.map(([kind, count]) => `${kind.replaceAll("_", " ")} ${count}`).join(", ")})`;
}
