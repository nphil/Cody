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
  /**
   * Which requests a `source: "block"` window refuses, in omp's own scope
   * vocabulary (`auth_credential_blocks.blockScope`): `""` or absent = every
   * request on the account; `tier:fable` / `tier:mythos` (Claude), `spark` /
   * `chat` / `shared` (Codex), `pool:auto` / `pool:api` (Cursor). A scoped
   * block must not read as the whole account being out of quota.
   */
  blockScope?: string;
  /**
   * What the engine measured, when the meter counts money or credits rather
   * than a share of a plan (a LiteLLM key budget in `usd`, a Codex spend cap
   * in `credits`). Lets the UI say "$12.40 of $50" next to the percentage.
   * Absent for plain percentage windows.
   */
  amount?: UsageWindowAmount;
}

/** A money or credit meter's own numbers, in the engine's unit. */
export interface UsageWindowAmount {
  /** The engine's unit, lowercased ("usd", "credits"). */
  unit: string;
  used: number | null;
  limit: number | null;
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
 *  - `disabled`: omp disabled the credential outright;
 *  - `signed_out`: omp disabled it because its login ended (a token refresh
 *    the provider refused for good, an invalidated token) — not a quota
 *    problem, and only signing in again brings it back. Unusable exactly like
 *    `disabled`; kept apart so every surface can say what to do about it
 *    (`isSignedOutCause`, lib/usage/credential-health.ts). */
export type UsageAccountService = "in_use" | "standby" | "limited" | "disabled" | "signed_out";

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
  /** `UsageAccount.id` of that account — or null when omp recorded a pin
   *  Cody cannot match to an account (the credential store could not be
   *  read, or the account was since removed). The conversation HAS used the
   *  provider, so the reader falls back to the account that most recently
   *  served a request, and says so; it never guesses by headroom, which picks
   *  the idle sibling precisely because the account in use is burning quota. */
  accountId: string | null;
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
  /**
   * omp's account-routing policy for this login (`auth.accountPolicies`):
   * which login it uses first and how much quota it keeps back. Present only
   * when a policy applies to the account; reading it explains why omp holds
   * or skips an account.
   */
  policy?: UsageAccountPolicy;
  /**
   * Shared gates that have not started counting (`"5h"`: a Claude account
   * with no session open reports no 5-hour window at all). The window is
   * absent because nothing is metering yet, not because it was dropped.
   */
  inactiveGates?: string[];
  /**
   * ISO time of the reading these windows come from, set ONLY when they are
   * carried over from an earlier read because the newest one did not report
   * this account. Absent on a window set the newest read measured.
   */
  windowsStaleSince?: string;
  /**
   * ISO time omp MEASURED these windows: the report's own `fetchedAt`, not the
   * time Cody read omp. omp re-serves its last saved report for a login whose
   * live fetch keeps failing (Claude's usage endpoint answers HTTP 429 to
   * bursts), so this is the only honest age of the numbers. Absent when the
   * engine printed no `fetchedAt`; such a reading is never called out of date.
   */
  measuredAt?: string | null;
  /**
   * Set (by `withOutdatedReadings`, lib/usage/reading-age.ts) when the reading
   * is older than `READING_OUTDATED_AFTER_MS`: these windows are a photograph
   * of the past, not the present. Windows whose reset has already passed are
   * dropped from such an account, so what is left is only what was last known.
   */
  outdated?: true;
}

/** `omp usage --json`'s per-account `policy` object, with every field optional
 * because the shape grew across releases. */
export interface UsageAccountPolicy {
  priority: number | null;
  reservePct: number | null;
  /** Whether the reserve is omp's global default or this account's own. */
  reserveSource: "global" | "override" | null;
  reclaimAbovePct: number | null;
  /** Where omp's routing puts the account right now. */
  state: "eligible" | "inside-reserve" | "exhausted" | "unknown";
  remainingPct: number | null;
}

/** A stored login omp knows has a usage reader but could not produce a reading
 * for in the newest read (`accountsWithoutUsage`). It is NOT an account row:
 * nothing was measured, so it carries no windows and routes as "unknown". */
export interface UsageUnreportedAccount {
  provider: string;
  type: "oauth" | "api_key";
  /** email, else org name, else account id — the same identity a reading would carry. */
  identity: string | null;
  /** The engine account id when it gave one; joins to `UsageAccount.id`. */
  accountId: string | null;
  policy?: UsageAccountPolicy;
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
  /**
   * Set when the newest attempt to read usage FAILED (the command timed out,
   * crashed, printed nothing usable) and `accounts` are the last good reading,
   * kept instead of being replaced by "no data". `at` is when the failed
   * attempt happened; `fetchedAt` is when these numbers were read. A snapshot
   * carrying this is always `stale`.
   */
  refreshFailed?: { at: string; reason: string };
  /** Stored logins with a usage reader that the newest read had no reading
   * for. Absent on an engine that does not list them. */
  unreportedAccounts?: UsageUnreportedAccount[];
}
