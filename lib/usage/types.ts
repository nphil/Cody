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
  /**
   * Window span in milliseconds (5h → 18 000 000), or null when the engine
   * never said how long the window lasts. Selection prefers shorter spans —
   * the window the user is spending against right now — and sorts null last.
   */
  windowMs?: number | null;
  /**
   * Model tier this window is scoped to, lowercased (e.g. "opus"), or null when
   * it covers the whole account. A tiered window constrains only the models of
   * that tier, so it must not be charged against a model of another one.
   */
  tier?: string | null;
  /** Whether the engine marks this bucket shared. A reported tier remains the
   * authoritative model scope: current OMP reports some tiered buckets as
   * shared too. */
  shared?: boolean;
  /**
   * Where an exhausted state came from, when it is not a measured reading.
   * `"block"`: omp refused the credential after ONE rejected request and
   * set a deadline (`resetsAt`). Nothing measured the quota, so the UI
   * should say "blocked after a rejected request, not measured" rather
   * than "exhausted". An account whose every window is a block was never
   * measured at all (a provider with no usage reading). Absent = measured.
   */
  source?: "block";
}
/** A banked rate-limit reset balance actually reported by the engine. This is
 * separate from subscription quota and from any pay-as-you-go credit balance. */
export interface UsageResetCredits {
  availableCount: number;
  /** Earliest valid reported expiry, or null when no usable expiry was reported. */
  earliestExpiresAt: string | null;
}

/** Where one account stands among every account serving one provider:
 *  - `in_use`: the account requests are going to — for a conversation, the
 *    account omp recorded for its last reply; otherwise the best evidence
 *    available (see `UsageInUseBasis`);
 *  - `standby`: healthy, held in reserve, taken over automatically when the
 *    one in use is limited;
 *  - `limited`: its binding window is spent;
 *  - `disabled`: omp disabled the credential outright. */
export type UsageAccountService = "in_use" | "standby" | "limited" | "disabled";

/** What the `in_use` answer rests on, strongest first:
 *  - `session`: omp's own `credential_pin` for this conversation — the
 *    account that served its most recent reply;
 *  - `recent`: the account whose windows omp last refreshed from a live
 *    response (any conversation) — used when no conversation is in scope;
 *  - `expected`: nothing has used the provider yet, so this is the account
 *    omp would rank first on quota headroom. A prediction, labelled as one. */
export type UsageInUseBasis = "session" | "recent" | "expected";

/** The account one conversation's most recent reply used, per provider. */
export interface UsageSessionAccount {
  /** `UsageAccount.id` of that account. */
  accountId: string;
  /** When omp recorded it (the pin's timestamp), or null if unrecorded. */
  since: string | null;
}

/** One authenticated account, with every quota window it reports. */
export interface UsageAccount {
  /** Engine-side provider id, e.g. "anthropic" or "openai-codex". */
  provider: string;
  /** Stable identity within the provider: engine account id, else email, else
   * a positional `${provider}#${index}` fallback. Stable across reads so a
   * removal or a re-rank never relabels an account the user was looking at. */
  id: string;
  /** Human-facing identity — email, else org/workspace name — or null when
   * the engine reports neither. Distinct from `label`, which is display copy
   * built for the composer, not a stable identity. */
  identity: string | null;
  /** omp's credential row id, when it can be resolved. It is creation order
   * and it is what Settings numbers accounts by, so ordering on it is what
   * keeps "Primary"/"Secondary" naming the SAME account in the composer and
   * in Settings. Null when the engine reported no row for this account —
   * such accounts sort last, after every identified one. */
  credentialId: number | null;
  /** Short human-facing name, e.g. "Anthropic" or "Openai Codex (work)". */
  label: string;
  /** Cody's optional name for this exact credential, resolved for display only. */
  customName?: string;
  /** Subscription tier when the provider reports one, else null. */
  planType: string | null;
  /** True when every limit on the account is reported as unmetered. */
  unlimited: boolean;
  windows: UsageWindow[];
  /** Saved rate-limit resets, when the provider explicitly reports them. */
  resetCredits?: UsageResetCredits;
  /** Present when omp has disabled this credential outright (auth failure,
   * replaced, deleted); such an account reports no live windows. */
  disabled?: { cause: string | null };
  /** ISO time a live response last refreshed this account's windows (omp's
   *  `headersUpdatedAt`) — i.e. when it last actually served a request, from
   *  any conversation. Null when omp has only polled it. */
  lastServedAt?: string | null;
}

/** Per-window quota capacity for one provider, aggregated across every
 * account serving it (see omp's `computeProviderWindowStats`). */
export interface UsageProviderCapacity {
  /** Compact window label, e.g. "5h", "7d". */
  windowId: string;
  /** Meter identity when a provider keeps independent meters in one window,
   * e.g. Codex's chat vs. Spark tiers. Null when the window has one meter. */
  meter: string | null;
  /** Accounts reporting a limit in this window. */
  accounts: number;
  /** Sum of each account's headroom in this window — accounts' worth of
   * quota left, not a percentage. */
  remainingAccounts: number;
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
  /** Per-window capacity for every provider that reported one, keyed by
   * provider id. Absent (rather than empty) when omp reported none at all. */
  capacity?: Record<string, UsageProviderCapacity[]>;
  /** Providers that could not be read at all, with a machine-readable
   * reason. Distinct from a provider reporting nothing: this is "Cody knows
   * a quota exists here and could not see it", which the UI turns into a
   * connect-this hint rather than silence. */
  unavailableProviders?: { provider: string; reason: string }[];
  /** Present only on a read scoped to one conversation (`?session=`): per
   *  provider, the account that conversation's latest reply was served by,
   *  resolved from omp's own `credential_pin` entries. A provider absent here
   *  has not been used by that conversation yet. */
  sessionAccounts?: Record<string, UsageSessionAccount>;
}
