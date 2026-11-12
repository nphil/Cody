/**
 * What omp says when a provider has no usable sign-in, and when it announces
 * saved resets itself, read into plain facts the chat can act on. Pure, so it
 * is tested without React.
 *
 * Three engine behaviours land here (omp 18.8.3 and 18.19.0 differ):
 *
 * - 18.15.0+ hops BEFORE the turn onto the first keyed `retry.fallbackChains`
 *   entry when the model's provider has no login, and announces it with
 *   `retry_fallback_applied` whose `reason` is `no credential for <provider>`
 *   (src/session/turn-recovery.ts applyMissingCredentialFallback). 18.8.3
 *   never sends that reason: it fails the prompt instead.
 * - With no login and no keyed fallback, 18.19.0 refuses the prompt with a
 *   typed PromptPreflightError and 18.8.3 throws a plain Error; the text is the
 *   same in both: `No API key found for <provider>.\n\nUse /login, set an API
 *   key environment variable, or create <agent.db>` (src/session/agent-session.ts).
 *   The model registry's own lookup says it with quotes:
 *   `No API key found for "<provider>"` (src/config/model-registry.ts).
 * - A session whose engine cannot ask (no prompt UI) says, once, that saved
 *   resets are eligible to spend but auto-redeem is unset, as a `notice` frame
 *   with source `claude-auto-reset` or `codex-auto-reset` (18.8.3 and 18.19.0).
 *   The same sources also carry other, unrelated notices ("Auto-redeemed a
 *   saved ... reset", "... was already redeemed elsewhere"): only the
 *   "eligible to spend" one is mapped here.
 *
 * The saved-reset EXPIRY warning (omp 18.9.0+) is not a `notice` frame: omp
 * builds it for its terminal status line only (modes/status-line-host.ts), so
 * an RPC host never receives it. Cody's own expiry badge covers that.
 */
import { providerBrand } from "@/lib/provider-brand";

/** The `reason` text omp puts on `retry_fallback_applied` for a signed-out provider. */
const MISSING_CREDENTIAL_REASON = /^no credential for (\S+)\s*$/i;

/** The provider a `retry_fallback_applied.reason` says has no credential, else null. */
export function missingCredentialProvider(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  return MISSING_CREDENTIAL_REASON.exec(reason.trim())?.[1] ?? null;
}

// `No API key found for anthropic.\n\nUse /login ...` (prompt) or
// `No API key found for "anthropic"` (registry). The provider id may itself
// contain dots, so the sentence-ending dot is the one followed by whitespace or the end.
const NO_API_KEY_UNQUOTED = /\bNo API key found for (\S+?)\.(?=\s|$)/;
const NO_API_KEY_QUOTED = /\bNo API key found for "([^"\s]+)"/;

/** The provider named by omp's "No API key found for <provider>" refusal, else null. */
export function missingApiKeyProvider(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return NO_API_KEY_QUOTED.exec(text)?.[1] ?? NO_API_KEY_UNQUOTED.exec(text)?.[1] ?? null;
}

/** "anthropic" -> "Claude", "my-custom_provider" -> "My Custom Provider". */
export function credentialProviderName(provider: string): string {
  const tidy = provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
  return providerBrand(provider)?.name ?? (tidy || provider);
}

/** A button row a notice can carry; the shelf (components/NoticeActions.tsx) turns it into controls. */
export type NoticeCta =
  | { kind: "sign_in"; provider: string }
  | { kind: "saved_reset"; provider: SavedResetProvider };

export type SavedResetProvider = "anthropic" | "openai-codex";

const SIGNED_OUT_KEY_PREFIX = "signed-out:";
const SAVED_RESET_KEY_PREFIX = "saved-reset:";

/** How long a notice with buttons stays on the shelf; plain notices fade after five seconds, too short to read and click. */
export const ACTIONABLE_NOTICE_VISIBLE_MS = 20_000;

/**
 * The shelf folds repeats by `dedupeKey`, and every raw-error path hands its
 * key to `addNotice`; carrying the provider in the key lets the shelf attach
 * the sign-in button for any of them without each caller passing it along.
 */
export function signedOutDedupeKey(provider: string): string {
  return `${SIGNED_OUT_KEY_PREFIX}${provider}`;
}

export function savedResetDedupeKey(provider: SavedResetProvider): string {
  return `${SAVED_RESET_KEY_PREFIX}${provider}`;
}

/** The buttons a notice with this `dedupeKey` carries, if any. */
export function noticeCtaForDedupeKey(dedupeKey: string | undefined): NoticeCta | undefined {
  if (!dedupeKey) return undefined;
  if (dedupeKey.startsWith(SIGNED_OUT_KEY_PREFIX)) {
    const provider = dedupeKey.slice(SIGNED_OUT_KEY_PREFIX.length);
    return provider ? { kind: "sign_in", provider } : undefined;
  }
  if (dedupeKey.startsWith(SAVED_RESET_KEY_PREFIX)) {
    const provider = dedupeKey.slice(SAVED_RESET_KEY_PREFIX.length);
    return provider === "anthropic" || provider === "openai-codex" ? { kind: "saved_reset", provider } : undefined;
  }
  return undefined;
}

const SAVED_RESET_SOURCES: Readonly<Record<string, SavedResetProvider>> = {
  "claude-auto-reset": "anthropic",
  "codex-auto-reset": "openai-codex",
};

// `Saved Claude resets are eligible to spend, but auto-redeem is unset and no prompt UI is available. Run ...`
const SAVED_RESETS_ELIGIBLE = /eligible to spend, but auto-redeem is unset/i;

/**
 * The provider whose saved resets omp says are eligible but unspent because
 * auto-redeem is unset and it cannot ask. Null for every other notice, which
 * keeps its existing treatment.
 */
export function savedResetEligibleProvider(source: unknown, message: unknown): SavedResetProvider | null {
  if (typeof source !== "string" || typeof message !== "string") return null;
  const provider = SAVED_RESET_SOURCES[source];
  return provider && SAVED_RESETS_ELIGIBLE.test(message) ? provider : null;
}

/**
 * The settings that say whether omp may spend this provider's saved resets by
 * itself, newest spelling first. 18.18.7 split the single `autoRedeem` into
 * per-window keys; 18.8.3 has only the single one. Callers pick the first key
 * the running engine's schema actually has.
 */
export function autoRedeemSettingKeys(provider: SavedResetProvider): readonly string[] {
  return provider === "anthropic"
    ? ["claudeResets.autoRedeem5h", "claudeResets.autoRedeemWeekly", "claudeResets.autoRedeem"]
    : ["codexResets.autoRedeem5h", "codexResets.autoRedeemWeekly", "codexResets.autoRedeem"];
}

/** What of the saved-reset snapshot this helper reads (lib/harness/reset-credits.ts). */
export interface ResetSnapshotLike {
  available?: boolean;
  accounts: ReadonlyArray<{
    id: string;
    provider?: string;
    canRedeem: boolean;
    retrying?: boolean;
    credits: ReadonlyArray<{ id: string }>;
  }>;
}

/**
 * The first account of `provider` with a credit it can spend right now, and
 * that credit: the same rule the quota popover's "Use reset" row applies.
 * Null when none is redeemable, in which case the notice shows no button.
 */
export function pickRedeemableResetCredit(
  snapshot: ResetSnapshotLike | null | undefined,
  provider: SavedResetProvider,
): { accountId: string; creditId: string } | null {
  if (!snapshot || snapshot.available === false) return null;
  for (const account of snapshot.accounts) {
    if (account.provider !== provider || !account.canRedeem || account.retrying) continue;
    const credit = account.credits[0];
    if (credit) return { accountId: account.id, creditId: credit.id };
  }
  return null;
}
