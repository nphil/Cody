import { createHash } from "node:crypto";
import type { OmpCredentialRow } from "../harness/omp-credentials";
import { isSignedOutCause } from "../usage/credential-health";
import { TITLE_MAX_CHARS, buildBody, clipChars, providerDisplayName, singleLine } from "./compose";

/**
 * "Account signed out": which stored accounts have lost their login, and what
 * to tell the owner about each.
 *
 * An ended login is not quota and not a fault in Cody: the provider refused to
 * renew it for good, omp disabled the credential and wrote why, and the one fix
 * is for the owner to sign in again. A red chip on the Providers page was not
 * enough (an expired Claude login sat unnoticed for two days, mistaken for
 * quota), so it is pushed.
 *
 * Pure: the rows come from omp's credential store
 * (lib/harness/omp-credentials.ts) and nothing here knows what was announced
 * before — quota-watch.ts reads, remembers and sends. An account is never named
 * by its own identity (that is an email): only by its place among the
 * provider's accounts, numbered the way Settings numbers them.
 */

/** One stored account whose login has ended. */
export interface SignedOutAlert {
  /** The engine's id for the provider ("anthropic"); the owner-facing name is derived when the message is written. */
  provider: string;
  /** omp's credential row. Signing in again makes a new row, so a later expiry is a new alert. */
  credentialId: number;
  /**
   * 0-based place among this provider's stored rows, disabled ones included —
   * the numbering lib/omp/provider-login.ts gives the same rows, so "Secondary"
   * is the same account in Settings and here.
   */
  position: number;
  /** How many rows the provider has stored, this one included. */
  providerAccounts: number;
  /** Another stored row of this provider is not disabled, so work carries on there. */
  otherUsable: boolean;
  /** SHA-256 (hex) of the cause omp wrote: the text can carry provider detail, so only its hash is kept. */
  causeFingerprint: string;
}

/**
 * Every row whose login has ended, in the order the rows came in (omp's list
 * is id-ascending). A row counts whatever its type: the cause is what says the
 * login is over. Rows an owner removed or replaced never reach this list, and a
 * disabled row with some other cause (a deliberate logout) is not an ended login.
 */
export function evaluateSignedOut(rows: readonly OmpCredentialRow[]): SignedOutAlert[] {
  const alerts: SignedOutAlert[] = [];
  for (const row of rows) {
    const cause = row.disabledCause;
    if (cause === null || !isSignedOutCause(cause)) continue;
    const siblings = rows.filter((other) => other.provider === row.provider);
    alerts.push({
      provider: row.provider,
      credentialId: row.id,
      position: siblings.indexOf(row),
      providerAccounts: siblings.length,
      otherUsable: siblings.some((other) => other !== row && other.disabledCause === null),
      causeFingerprint: createHash("sha256").update(cause).digest("hex"),
    });
  }
  return alerts;
}

/** "Primary", "Secondary", "Account 3": a position, never the account's own identity (which can be an email). */
function accountName(position: number): string {
  if (position === 0) return "Primary";
  if (position === 1) return "Secondary";
  return `Account ${position + 1}`;
}

/** What one alert says: which account, and whether Cody can carry on without it. */
export function describeSignedOut(alert: SignedOutAlert): { title: string; body: string } {
  const provider = providerDisplayName(alert.provider);
  const who = alert.providerAccounts > 1 ? `${provider} · ${accountName(alert.position)}` : provider;
  const consequence = alert.otherUsable ? "so Cody is using your other accounts" : "so Cody cannot use it";
  return {
    title: clipChars(singleLine(`${who} was signed out`), TITLE_MAX_CHARS),
    body: buildBody(`Its login expired, ${consequence}. Sign in again: Settings › Providers.`),
  };
}

/** Starts every remembered signed-out alert, which tells it apart from a quota window's (those are bare hex). */
export const SIGNED_OUT_PREFIX = "so-";

/**
 * What makes this alert the same alert next time: this provider's credential
 * row, signed out for this cause. Hashed, because it lands on disk.
 */
export function signedOutFingerprint(alert: SignedOutAlert): string {
  const digest = createHash("sha256").update([alert.provider, alert.credentialId, alert.causeFingerprint].join("|")).digest("hex");
  return `${SIGNED_OUT_PREFIX}${digest.slice(0, 24)}`;
}
