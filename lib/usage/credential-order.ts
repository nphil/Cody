import type { OmpCredentialRow } from "../harness/omp-credentials";
import { tierOfBlockScope } from "./quota-tiers";
import type { UsageAccount, UsageSnapshot } from "./types";

/**
 * Ordering accounts the way the user was told they are ordered.
 *
 * Two Cody surfaces name the same account: Settings numbers a provider's
 * accounts by omp's credential row id (creation order — stable, and unmoved
 * by an account being disabled or hitting a limit), while the composer's
 * quota popup names them "Primary"/"Secondary" from the usage snapshot. But
 * `omp usage --json` lists reporting accounts first and appends disabled
 * tombstones after them, so the moment a primary account's token expired the
 * two surfaces disagreed outright: Settings called it Primary, the composer
 * called it Secondary and promoted the sibling.
 *
 * So the credential store is authoritative for ORDER on both surfaces. Only
 * disabled accounts carry their row id in the usage payload; the active ones
 * are matched here, by engine account id first and email second (an account
 * id never collides, an email can be reused across providers), which is the
 * same join `lib/omp/provider-login.ts` makes for state.
 *
 * Failure is not an error: an account that cannot be matched keeps
 * `credentialId: null` and sorts after every identified one, in the order the
 * engine reported it. That is exactly the pre-enrichment behaviour, so a
 * missing or unreadable credential store degrades to what shipped before
 * rather than reshuffling anything.
 */

function matchKeys(row: OmpCredentialRow): string[] {
  const keys: string[] = [];
  if (row.identity) keys.push(row.identity.trim().toLowerCase());
  return keys;
}

function accountKeys(account: UsageAccount): string[] {
  const keys: string[] = [];
  if (account.identity) keys.push(account.identity.trim().toLowerCase());
  if (account.id) keys.push(account.id.trim().toLowerCase());
  return keys;
}

/** Attach each account's credential row id, then order every provider's
 * accounts by it. Pure: takes the rows, returns a new snapshot. */
export function applyCredentialOrder(
  snapshot: UsageSnapshot,
  credentials: readonly OmpCredentialRow[],
): UsageSnapshot {
  if (!snapshot.available || snapshot.accounts.length === 0 || credentials.length === 0) return snapshot;

  // provider -> matchable key -> row id. Lowest row id wins a contested key so
  // the mapping is deterministic regardless of store iteration order.
  const byProvider = new Map<string, Map<string, number>>();
  for (const row of credentials) {
    let keys = byProvider.get(row.provider);
    if (!keys) {
      keys = new Map<string, number>();
      byProvider.set(row.provider, keys);
    }
    for (const key of matchKeys(row)) {
      const existing = keys.get(key);
      if (existing === undefined || row.id < existing) keys.set(key, row.id);
    }
  }

  const claimed = new Map<string, Set<number>>();
  const resolve = (account: UsageAccount): number | null => {
    if (account.credentialId !== null) return account.credentialId;
    const keys = byProvider.get(account.provider);
    if (!keys) return null;
    let taken = claimed.get(account.provider);
    if (!taken) {
      taken = new Set<number>();
      claimed.set(account.provider, taken);
    }
    for (const key of accountKeys(account)) {
      const id = keys.get(key);
      // One row backs one account: a second account matching the same row
      // (two reports for one credential) stays unidentified rather than
      // stealing a position already given away.
      if (id !== undefined && !taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    return null;
  };

  const identified = snapshot.accounts.map((account) => ({ account, credentialId: resolve(account) }));
  // Claim the ids the disabled tombstones already carried, so an active
  // account cannot be matched onto a row a tombstone owns.
  const accounts = identified
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => {
      if (a.credentialId === b.credentialId) return a.index - b.index;
      if (a.credentialId === null) return 1;
      if (b.credentialId === null) return -1;
      return a.credentialId - b.credentialId;
    })
    .map(({ account, credentialId }) => (account.credentialId === credentialId ? account : { ...account, credentialId }));

  return { ...snapshot, accounts };
}

/**
 * A rate-limit BLOCK is a harder fact than a quota percentage, and until now
 * nothing in Cody could see it.
 *
 * omp records a block against the credential (`auth_credential_blocks`) when
 * a provider answers with a limit, and refuses to send on that credential
 * until it expires. The usage API is a different source and does not know
 * about it — measured on this machine: an Anthropic account reporting **4%
 * used** was blocked until 03:20Z, so the composer ring showed plenty of
 * headroom while every turn fell back to another provider. Same for the
 * Token Plan key, blocked for six days while its plan reported fine.
 *
 * A block is therefore folded in as an exhausted window on the account: the
 * ring shows it, `resolveModelAvailability` reports the model exhausted, the
 * blackout registry remembers it until `blockedUntil`, and the role binder
 * routes around it. One source of truth means the blocks have to be IN it.
 *
 * omp 18.19 scopes a block (`blockScope`: a Claude tier, a Codex chat/spark
 * lane, a Cursor pool, …), so a credential gets ONE window per scope, and a
 * scoped window names only what it refuses: a Fable-tier block must not read as
 * the whole Claude account being out. The unscoped ('') window keeps its
 * original id so remembered blackouts still match; a scoped one appends the
 * scope. A row with no `blocks` list (older source) reads as one '' block.
 */
export function applyCredentialBlocks(
  snapshot: UsageSnapshot,
  credentials: readonly OmpCredentialRow[],
  now = Date.now(),
): UsageSnapshot {
  if (!snapshot.available || credentials.length === 0) return snapshot;
  const blocked = new Map<number, { scope: string; until: string }[]>();
  for (const row of credentials) {
    // A disabled row (removed, or disabled by omp) can no longer serve, so a
    // block still recorded against it is not a fact about routing. Surfacing
    // it fabricated a blocked account for a credential the user had removed.
    if (row.disabledCause) continue;
    const candidates = row.blocks?.length
      ? row.blocks.flatMap((block) => (block.until !== null && Number.isFinite(new Date(block.until).getTime()) ? [{ scope: block.scope, until: new Date(block.until).toISOString() }] : []))
      : row.blockedUntil ? [{ scope: "", until: row.blockedUntil }] : [];
    // An expired block is not a block; the helper already filters, but the
    // snapshot may be served from cache across the expiry.
    const live = candidates.filter((block) => Date.parse(block.until) > now);
    if (live.length > 0) blocked.set(row.id, live);
  }
  if (blocked.size === 0) return snapshot;

  const blockWindows = (provider: string, credentialId: number | null, blocks: { scope: string; until: string }[]) => blocks.map(({ scope, until }) => ({
    id: scope ? `${provider}:blocked:${credentialId ?? "credential"}:${scope}` : `${provider}:blocked:${credentialId ?? "credential"}`,
    label: "rate-limit block",
    utilization: 100,
    resetsAt: until,
    state: "exhausted" as const,
    windowMs: null,
    // A scope that names a model family (tier:fable, spark) carries that tier,
    // like a measured window for it, so it never counts as account-wide.
    tier: tierOfBlockScope(scope),
    shared: true,
    source: "block" as const,
    blockScope: scope,
  }));

  const claimed = new Set<number>();
  // Which providers the snapshot itself reports accounts for, decided BEFORE any
  // block is folded in: a provider that reports nothing (an API key) must give
  // EVERY blocked key its own account — asking `accounts` below would find the
  // account just synthesized for the first blocked key and leave the second one
  // invisible (two saved keys, both refused, read as one spent and one usable).
  const reporting = new Set(snapshot.accounts.map((account) => account.provider));
  const accounts = snapshot.accounts.map((account) => {
    const blocks = account.credentialId === null ? undefined : blocked.get(account.credentialId);
    if (!blocks || account.credentialId === null) return account;
    claimed.add(account.credentialId);
    return { ...account, windows: [...(account.windows ?? []), ...blockWindows(account.provider, account.credentialId, blocks)] };
  });

  // A blocked credential whose provider reports no usage at all — an API key
  // (OpenRouter, the Alibaba Token Plan) rather than a coding plan — would
  // otherwise stay invisible and keep being chosen as a fallback while omp
  // refuses to send on it. Measured: the Token Plan key blocked for six days
  // still read as "unknown", i.e. usable.
  for (const row of credentials) {
    const blocks = blocked.get(row.id);
    if (!blocks || claimed.has(row.id)) continue;
    if (accounts.some((account) => account.provider === row.provider && account.credentialId === row.id)) continue;
    // Only synthesize when the provider reports NO account of its own: an unmatched
    // credential beside a reporting sibling is an identity join Cody could
    // not make, not proof that the reporting account is blocked.
    if (reporting.has(row.provider)) continue;
    accounts.push({
      provider: row.provider,
      id: `${row.provider}#${row.id}`,
      identity: row.identity ?? null,
      credentialId: row.id,
      label: row.provider,
      planType: null,
      unlimited: false,
      windows: blockWindows(row.provider, row.id, blocks),
    });
  }
  return { ...snapshot, accounts };
}
