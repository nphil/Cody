/**
 * Claude API credits as the backup behind the Claude plans — the PURE part,
 * shared by the server (`lib/omp/claude-credits*.ts`) and the browser
 * (`hooks/useAgentSession.ts`, `components/settings/providers/`). Nothing here
 * touches a file, the network or a framework, so the browser bundle and
 * `bin/cody-server.js` can both load it (no `@/` imports, per AGENTS.md).
 *
 * The mechanism, in one paragraph. omp keeps every subscription account of a
 * provider in one credential pool and ranks it; an API key stored beside them
 * for the SAME provider is never reached while an account exists (a plan that
 * is out of room is still dialled, so its real limit error comes back). So the
 * API keys live under their own provider ids — `anthropic-api` for the first
 * key, `anthropic-api-2` for the second — which serve the same models with
 * `x-api-key`, and omp's own fallback chain walks `anthropic/<model>` →
 * `anthropic-api/<model>` → `anthropic-api-2/<model>` → whatever else the user
 * listed. One provider per key, not one pool, because omp only moves to a
 * sibling credential of the same provider when the error reads like a quota,
 * and Anthropic's reply for an empty prepaid balance ("credit balance is too
 * low", HTTP 400) does not: with both keys in one pool a chat could be stuck
 * on the empty key and sent to another vendor while the other key had money.
 * A chain walks past it. `withClaudeCreditsFallback` is that one rule,
 * written as chain entries.
 */

/** The provider id omp files the Claude subscriptions under. */
export const CLAUDE_PLAN_PROVIDER = "anthropic";

/** The provider id Cody gives the API-key (pay-as-you-go) twin of the plans — the first key's. */
export const CLAUDE_CREDITS_PROVIDER = "anthropic-api";

/** One provider per saved key, so there is a ceiling: more than any account list needs. */
export const CLAUDE_CREDITS_MAX_KEYS = 8;

/** The provider id for the nth saved key, counting from 0: `anthropic-api`, `anthropic-api-2`, … */
export function claudeCreditsProvider(slot: number): string {
  return slot === 0 ? CLAUDE_CREDITS_PROVIDER : `${CLAUDE_CREDITS_PROVIDER}-${slot + 1}`;
}

/** Every provider id a saved key can live under, in the order the chain tries them. */
export const CLAUDE_CREDITS_PROVIDERS: readonly string[] = Array.from({ length: CLAUDE_CREDITS_MAX_KEYS }, (_, slot) => claudeCreditsProvider(slot));

/** Which key slot a provider id is (0 for `anthropic-api`), or null when it is not a credits provider. */
export function claudeCreditsSlot(provider: unknown): number | null {
  if (provider === CLAUDE_CREDITS_PROVIDER) return 0;
  const match = typeof provider === "string" ? /^anthropic-api-(\d)$/.exec(provider) : null;
  const slot = match ? Number(match[1]) - 1 : 0;
  return slot > 0 && slot < CLAUDE_CREDITS_MAX_KEYS ? slot : null;
}

/** Text a user reads next to the model name wherever a key's credits serve it ("… (API credits 2)" for the second). */
export function claudeCreditsModelSuffix(provider: string): string {
  const slot = claudeCreditsSlot(provider) ?? 0;
  return slot === 0 ? " (API credits)" : ` (API credits ${slot + 1})`;
}

/** The provider half of a `provider/model[:level]` selector, or null. */
export function selectorProvider(selector: unknown): string | null {
  if (typeof selector !== "string") return null;
  const slash = selector.indexOf("/");
  return slash > 0 ? selector.slice(0, slash) : null;
}

/** The model half (everything after the first `/`, `:level` suffix kept). */
function selectorRest(selector: string): string | null {
  const slash = selector.indexOf("/");
  return slash > 0 && slash < selector.length - 1 ? selector.slice(slash + 1) : null;
}

export function isClaudePlanSelector(selector: unknown): boolean {
  return selectorProvider(selector) === CLAUDE_PLAN_PROVIDER;
}

export function isClaudeCreditsSelector(selector: unknown): boolean {
  return claudeCreditsSlot(selectorProvider(selector)) !== null;
}

/**
 * The credits twin of a plan model selector on one credits provider
 * (`anthropic/claude-opus-5-5:high` → `anthropic-api/claude-opus-5-5:high`),
 * or null for anything else — including a selector that is already a twin and
 * a wildcard.
 */
export function claudeCreditsTwin(selector: string, provider: string = CLAUDE_CREDITS_PROVIDER): string | null {
  if (!isClaudePlanSelector(selector)) return null;
  const rest = selectorRest(selector);
  if (!rest || rest === "*") return null;
  return `${provider}/${rest}`;
}

/** omp's own events name models as `provider/id[:level]` (`retry_fallback_applied.from/to`). */
export function isClaudeCreditsSwitch(from: unknown, to: unknown): boolean {
  return isClaudePlanSelector(from) && isClaudeCreditsSelector(to);
}

/** The reverse hop: omp is back on the plan after the credits served a while. */
export function isClaudeCreditsReturn(from: unknown, to: unknown): boolean {
  return isClaudeCreditsSelector(from) && isClaudePlanSelector(to);
}

/**
 * Which `retry.fallbackChains` keys the credits belong in: every role chain
 * (no `/`), and the chains of Claude plan models (`anthropic/<id>`,
 * `anthropic/*`). A chain someone wrote for another provider's model is that
 * model's own business.
 */
function chainKeyTakesCredits(key: string): boolean {
  return !key.includes("/") || selectorProvider(key) === CLAUDE_PLAN_PROVIDER;
}

/**
 * Put the credits ahead of every other provider in omp's fallback chains.
 *
 * Input is the EFFECTIVE `retry.fallbackChains` (config.yml plus any overlay)
 * and the credits providers that hold a key; output is what the credits
 * overlay should carry. Per chain:
 *
 *  - the wildcard `<provider>/*` of each credits provider goes FIRST, in key
 *    order, so the model that just hit its plan limit is answered by its own
 *    API twin — the first key, then the second if that one is empty — before
 *    any entry the user listed (Codex, OpenRouter, a local model) gets a request;
 *  - after every exact `anthropic/<id>` entry its twins `<provider>/<id>`
 *    follow, so a Claude model the user parked at the END of a chain (after a
 *    Codex model, say) is still backed by its credits when it is reached
 *    there, where the leading wildcards are behind it and unreachable;
 *  - the rest of the user's chain keeps its order, so when the credits are
 *    spent too the walk carries on exactly where it would have.
 *
 * An EMPTY chain is the user saying "no fallback here" and is left alone, as
 * is a tombstone (`null`). A missing `default` chain is created, because
 * every role without a chain of its own inherits it.
 */
export function withClaudeCreditsFallback(
  chains: Record<string, string[] | null | undefined>,
  providers: readonly string[] = [CLAUDE_CREDITS_PROVIDER],
): Record<string, string[]> {
  const wildcards = providers.map((provider) => `${provider}/*`);
  const isWildcard = new Set(wildcards);
  const out: Record<string, string[]> = {};
  for (const [key, chain] of Object.entries(chains)) {
    if (!Array.isArray(chain) || chain.length === 0 || !chainKeyTakesCredits(key)) continue;
    const entries = chain.filter((entry) => typeof entry === "string" && !isWildcard.has(entry));
    const listed = new Set(entries);
    const next = [...wildcards];
    const placed = new Set(next);
    for (const entry of entries) {
      if (!placed.has(entry)) {
        next.push(entry);
        placed.add(entry);
      }
      for (const provider of providers) {
        const twin = claudeCreditsTwin(entry, provider);
        if (twin && !listed.has(twin) && !placed.has(twin)) {
          next.push(twin);
          placed.add(twin);
        }
      }
    }
    out[key] = next;
  }
  if (!Array.isArray(chains.default)) out.default = [...wildcards];
  return out;
}

// ── What the Providers panel reads and writes (GET/PUT/DELETE /api/claude-credits) ──

/** The masked key saved for one plan account. Never the key itself. */
export interface ClaudeCreditsKey {
  /** omp's credential row id for this key (stringified). */
  keyId: string;
  /** The last four characters, the only part of a key the browser ever sees. */
  last4: string;
  /** When it was saved, or null for a key Cody has no record of (stored by other means). */
  addedAt: string | null;
}

/** One Claude plan account, with the API key saved for it (if any). */
export interface ClaudeCreditsAccount {
  /** omp's credential row id for the PLAN account (stringified) — the same id
   * `ProviderLoginAccount.id` carries for it. */
  accountId: string;
  /** The account's identity (email, else organisation), as the plan card shows it. */
  label: string;
  /** Index among the stored plan accounts, the number behind Primary / Secondary. */
  position: number;
  key: ClaudeCreditsKey | null;
}

export interface ClaudeCreditsStatus {
  /** False when omp or its Bun credential bridge is not usable on this instance. */
  available: boolean;
  /** Why, in plain words, when `available` is false. */
  reason?: string;
  /** Only an administrator may save or remove a key. */
  canEdit: boolean;
  accounts: ClaudeCreditsAccount[];
  /** Saved keys whose plan account has since been signed out, so they can still be removed. */
  strayKeys: Array<ClaudeCreditsKey & { label: string | null }>;
  /** Whether omp is set to fall back to another model after a failure at all
   * (`retry.enabled` and `retry.modelFallback`). Off means the credits are saved
   * but a limit still ends the turn. */
  fallbackEnabled: boolean;
  /** Whether omp goes back to the plan by itself once its limit lifts
   * (`retry.fallbackRevertPolicy` is not `never`). */
  returnsToPlan: boolean;
}
