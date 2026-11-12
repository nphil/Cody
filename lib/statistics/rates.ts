/**
 * Per-token prices, learnt from the transcripts themselves.
 *
 * omp writes each call's cost broken down by counter (`cost.input`,
 * `cost.cacheRead`, ...), so dividing a component by its token count recovers
 * the model's price for it without a catalogue to keep in step. Two things need
 * a price the line does not carry: what prompt caching saved (the gap between
 * the input price and the cache-read price, over the cached tokens) and what a
 * compaction cost (its line records tokens only).
 */

import type { RawUsage } from "./scan";
import type { RateEntry } from "./types";

/** `provider/model` -> USD per token. */
export type RateBook = Record<string, RateEntry>;

export function rateKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function perToken(cost: number, tokens: number): number {
  return tokens > 0 && cost > 0 ? cost / tokens : 0;
}

/**
 * Folds the prices one call reveals into the book and returns the effective
 * prices for that call: its own where it revealed one, the book's where it did
 * not (a call served entirely from cache never shows the input price).
 */
export function learnRates(book: RateBook, key: string, usage: RawUsage): RateEntry {
  const known = book[key];
  const next: RateEntry = {
    input: perToken(usage.costInput, usage.input) || known?.input || 0,
    output: perToken(usage.costOutput, usage.output) || known?.output || 0,
    cacheRead: perToken(usage.costCacheRead, usage.cacheRead) || known?.cacheRead || 0,
    cacheWrite: perToken(usage.costCacheWrite, usage.cacheWrite) || known?.cacheWrite || 0,
  };
  const changed = known
    ? known.input !== next.input || known.output !== next.output || known.cacheRead !== next.cacheRead || known.cacheWrite !== next.cacheWrite
    : next.input > 0 || next.output > 0 || next.cacheRead > 0 || next.cacheWrite > 0;
  if (changed) book[key] = next;
  return next;
}

/**
 * Net dollars prompt caching saved on one call: cached reads cost less than
 * fresh input, cache writes cost more. Zero when either price is unknown, so an
 * unpriced model never contributes a made-up saving.
 */
export function cacheSaving(usage: RawUsage, rates: RateEntry): number {
  let saving = 0;
  if (usage.cacheRead > 0 && rates.input > 0 && rates.cacheRead > 0) saving += usage.cacheRead * (rates.input - rates.cacheRead);
  if (usage.cacheWrite > 0 && rates.input > 0 && rates.cacheWrite > 0) saving -= usage.cacheWrite * (rates.cacheWrite - rates.input);
  return saving;
}

/**
 * The API-equivalent cost of a call that recorded tokens only, or null when any
 * counter it used has no learnt price: a partial price would understate the call.
 */
export function estimateCost(usage: RawUsage, rates: RateEntry): number | null {
  if ((usage.input > 0 && rates.input <= 0) || (usage.output > 0 && rates.output <= 0)) return null;
  if ((usage.cacheRead > 0 && rates.cacheRead <= 0) || (usage.cacheWrite > 0 && rates.cacheWrite <= 0)) return null;
  const cost = usage.input * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite;
  return cost > 0 ? cost : null;
}
