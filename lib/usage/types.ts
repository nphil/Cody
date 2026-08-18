/**
 * Cody's normalized plan-quota vocabulary.
 *
 * Engines report quota in wildly different shapes (per-provider windows, model
 * tiers, banked resets); everything Cody renders is flattened into these four
 * types first, so the UI, the API route and the composer all speak one language
 * regardless of which engine produced the numbers.
 */

/** Severity of a single quota window, from Cody's own thresholds. */
export type UsageWindowState = "ok" | "warning" | "exhausted";

/** One quota window (a rolling limit bucket) of one account. */
export interface UsageWindow {
  /** Stable identifier, unique within its account (e.g. "anthropic:7d:opus"). */
  id: string;
  /** Short human-facing name, e.g. "Opus · weekly" or "5-hour window". */
  label: string;
  /** Percentage of the window consumed, 0-100. */
  utilization: number;
  /** ISO timestamp of the next reset, or null when the engine reports none. */
  resetsAt: string | null;
  state: UsageWindowState;
}

/** One authenticated account, with every quota window it reports. */
export interface UsageAccount {
  /** Engine-side provider id, e.g. "anthropic" or "openai-codex". */
  provider: string;
  /** Short human-facing name, e.g. "Anthropic" or "Openai Codex (work)". */
  label: string;
  /** Subscription tier when the provider reports one, else null. */
  planType: string | null;
  /** True when every limit on the account is reported as unmetered. */
  unlimited: boolean;
  windows: UsageWindow[];
}

/** A point-in-time view of every quota-reporting account. */
export interface UsageSnapshot {
  /** False when no usage could be read at all; `reason` says why. */
  available: boolean;
  accounts: UsageAccount[];
  /** ISO timestamp of the read that produced these accounts. */
  fetchedAt: string;
  /** True when served past its TTL while a refresh runs behind it. */
  stale: boolean;
  reason?: string;
}
