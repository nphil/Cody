import { resolveProviderAccountName, type ProviderAccountNameEntry } from "../provider-account-names";
import type { UsageSnapshot } from "./types";

/** Add Cody's display-only names to accounts with an exact credential match.
 * Never rename an OMP account from a positional usage report. */
export function withUsageAccountNames(
  snapshot: UsageSnapshot,
  names: Readonly<Record<string, ProviderAccountNameEntry>>,
): UsageSnapshot {
  let changed = false;
  const accounts = snapshot.accounts.map((account) => {
    if (account.credentialId === null || !Number.isSafeInteger(account.credentialId)) return account;
    const customName = resolveProviderAccountName(
      names,
      account.provider,
      String(account.credentialId),
      account.identity,
    );
    if (customName === (account.customName ?? null)) return account;
    changed = true;
    return { ...account, customName: customName ?? undefined };
  });
  return changed ? { ...snapshot, accounts } : snapshot;
}
