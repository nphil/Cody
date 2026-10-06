import { credentialForPin } from "./cache";
import { readSessionCredentialPins } from "./session-pins";
import type { UsageSessionAccount, UsageSnapshot } from "./types";

/**
 * Per provider, the account one conversation's latest reply was served by:
 * omp's own `credential_pin` entries in the session file, matched against the
 * credential store's digests. No access check lives here — the caller decides
 * who may ask (the usage route gates on ownership; a scheduled message acts
 * for the chat's own owner).
 *
 * An unmatched pin still proves the conversation used the provider, so it is
 * reported with no account rather than dropped, which would read as "never
 * used" and route the gauge onto whichever sibling is idlest.
 */
export async function readSessionAccounts(
  sessionFile: string,
  snapshot: UsageSnapshot,
): Promise<Record<string, UsageSessionAccount>> {
  const result: Record<string, UsageSessionAccount> = {};
  for (const [provider, pin] of await readSessionCredentialPins(sessionFile)) {
    const credential = credentialForPin(pin.hash);
    const account = credential && credential.provider === provider
      ? snapshot.accounts.find((candidate) => candidate.provider === provider && candidate.credentialId === credential.credentialId)
      : undefined;
    result[provider] = { accountId: account?.id ?? null, since: pin.timestamp };
  }
  return result;
}
