import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { listResetCredits, type ResetCreditAccount, type ResetCreditBridgeDeps, type ResetCreditsSnapshot } from "./reset-credits";

/**
 * Saved-reset balances, read gently.
 *
 * Discovering them is not free: omp asks the provider live, per account, on
 * every call — for Claude up to three requests per account (the Cedar grant,
 * then the at-wall session reset, then the profile for the organization). The
 * provider rate-limits those endpoints per source address, and the composer
 * used to trigger a full discovery on every popover open, window focus and
 * 90-second tick, from every open tab. Measured on a live install: Anthropic
 * answered 429 to every usage read on both accounts, and every Claude row
 * read "Failed to load saved resets" while each account held one.
 *
 * So one process-wide read serves every caller for `RESET_CREDITS_TTL_MS`; a
 * failed check backs off exponentially instead of retrying at poll speed; an
 * explicit refresh is honoured at most once per
 * `RESET_CREDITS_MIN_FORCE_INTERVAL_MS`. And a failed check for one account
 * never erases what the provider last confirmed for it: that answer is kept
 * (in memory and in the instance data dir, so a restart keeps it too) and
 * shown as "as of" rather than as an error.
 */

export const RESET_CREDITS_TTL_MS = 10 * 60_000;
export const RESET_CREDITS_RETRY_BASE_MS = 2 * 60_000;
export const RESET_CREDITS_RETRY_MAX_MS = 15 * 60_000;
export const RESET_CREDITS_MIN_FORCE_INTERVAL_MS = 60_000;

const STORE_FILE = "cody-reset-credits.json";

/** The provider's last confirmed answer for one account. */
export interface ConfirmedResetAccount { account: ResetCreditAccount; checkedAt: string }

/**
 * Lay a fresh listing over the last confirmed answers. Pure.
 *
 * - An account the provider answered for replaces its confirmed answer.
 * - An account whose check failed keeps its confirmed answer, marked `stale`
 *   (the count is the last one confirmed); with none, it is marked `retrying`.
 * - A listing that failed outright serves every confirmed answer as stale.
 * - A provider the listing could not read at all (`failedProviders`) keeps its
 *   confirmed accounts as stale, even though the listing named none of them.
 * - Accounts no longer listed (logged out) are dropped.
 */
export function mergeResetCredits(
  live: ResetCreditsSnapshot,
  confirmed: ReadonlyMap<string, ConfirmedResetAccount>,
  now: Date,
): { snapshot: ResetCreditsSnapshot; confirmed: Map<string, ConfirmedResetAccount>; failed: boolean } {
  const checkedAt = now.toISOString();
  if (!live.available) {
    if (confirmed.size === 0) return { snapshot: live, confirmed: new Map(confirmed), failed: true };
    const accounts = [...confirmed.values()].map(({ account, checkedAt: at }) => ({ ...account, checkedAt: at, stale: true }));
    return { snapshot: { available: true, accounts, fetchedAt: checkedAt }, confirmed: new Map(confirmed), failed: true };
  }
  const next = new Map<string, ConfirmedResetAccount>();
  let failed = false;
  const accounts = live.accounts.map((account): ResetCreditAccount => {
    if (account.error) {
      failed = true;
      const previous = confirmed.get(account.id);
      if (previous) {
        next.set(account.id, previous);
        // Keep today's label and position: they come from the credential
        // store, not from the failed provider call.
        return { ...previous.account, label: account.label, ...(account.position !== undefined ? { position: account.position } : {}), checkedAt: previous.checkedAt, stale: true };
      }
      return { ...account, retrying: true };
    }
    const fresh: ResetCreditAccount = { ...account, checkedAt };
    delete fresh.stale;
    delete fresh.retrying;
    next.set(account.id, { account: fresh, checkedAt });
    return fresh;
  });
  // A provider that threw returns no rows, which is not the same as "logged
  // out": its confirmed accounts stay, marked as carried over.
  const unread = new Set(live.failedProviders ?? []);
  const listed = new Set(live.accounts.map((account) => account.id));
  for (const [id, previous] of confirmed) {
    if (listed.has(id) || !previous.account.provider || !unread.has(previous.account.provider)) continue;
    failed = true;
    next.set(id, previous);
    accounts.push({ ...previous.account, checkedAt: previous.checkedAt, stale: true });
  }
  const { failedProviders: _failedProviders, ...rest } = live;
  return { snapshot: { ...rest, accounts, fetchedAt: checkedAt }, confirmed: next, failed };
}

interface ResetCreditsCacheState {
  snapshot: ResetCreditsSnapshot | null;
  liveAt: number;
  nextLiveAt: number;
  failures: number;
  inFlight: Promise<ResetCreditsSnapshot> | null;
  confirmed: Map<string, ConfirmedResetAccount> | null;
}

declare global {
  var __codyResetCreditsCache: ResetCreditsCacheState | undefined;
}

function state(): ResetCreditsCacheState {
  if (!globalThis.__codyResetCreditsCache) {
    globalThis.__codyResetCreditsCache = { snapshot: null, liveAt: 0, nextLiveAt: 0, failures: 0, inFlight: null, confirmed: null };
  }
  return globalThis.__codyResetCreditsCache;
}

function storePath(agentDir: string): string {
  return path.join(agentDir, STORE_FILE);
}

async function loadConfirmed(agentDir: string): Promise<Map<string, ConfirmedResetAccount>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(agentDir), "utf8"));
    const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? (parsed as { accounts: unknown[] }).accounts
      : [];
    const map = new Map<string, ConfirmedResetAccount>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const { account, checkedAt } = row as Partial<ConfirmedResetAccount>;
      if (!account || typeof account.id !== "string" || typeof account.label !== "string" || typeof checkedAt !== "string") continue;
      if (typeof account.availableCount !== "number" || !Array.isArray(account.credits)) continue;
      map.set(account.id, { account, checkedAt });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function saveConfirmed(agentDir: string, confirmed: ReadonlyMap<string, ConfirmedResetAccount>): Promise<void> {
  const target = storePath(agentDir);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(temp, JSON.stringify({ version: 1, accounts: [...confirmed.values()] }), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch {
    // Losing the carry-over only costs a "retrying" row after a restart.
  }
}

export interface GetResetCreditsOptions {
  /** An explicit user refresh. Still at most one live check per minute. */
  force?: boolean;
  deps?: ResetCreditBridgeDeps;
  now?: () => number;
}

/** Saved-reset balances for every account, served from the shared cache
 *  unless it is due (see the module comment). Never throws. */
export function getResetCredits(options: GetResetCreditsOptions = {}): Promise<ResetCreditsSnapshot> {
  const cache = state();
  const now = options.now?.() ?? Date.now();
  if (cache.inFlight) return cache.inFlight;
  if (cache.snapshot) {
    const due = now >= cache.nextLiveAt;
    const forced = options.force === true && now - cache.liveAt >= RESET_CREDITS_MIN_FORCE_INTERVAL_MS;
    if (!due && !forced) return Promise.resolve(cache.snapshot);
  }
  const agentDir = options.deps?.agentDir?.() ?? getAgentDir();
  const run = (async () => {
    const live = await listResetCredits(options.deps);
    cache.confirmed ??= await loadConfirmed(agentDir);
    const merged = mergeResetCredits(live, cache.confirmed, new Date(now));
    cache.confirmed = merged.confirmed;
    if (live.available) await saveConfirmed(agentDir, merged.confirmed);
    cache.failures = merged.failed ? cache.failures + 1 : 0;
    cache.liveAt = now;
    cache.nextLiveAt = now + (merged.failed
      ? Math.min(RESET_CREDITS_RETRY_MAX_MS, RESET_CREDITS_RETRY_BASE_MS * 2 ** (cache.failures - 1))
      : RESET_CREDITS_TTL_MS);
    cache.snapshot = merged.snapshot;
    return merged.snapshot;
  })().catch((error: unknown) => {
    // listResetCredits fails soft; this only guards the merge/store plumbing.
    // The last good reading stays served, and the retry backs off like any failed check.
    cache.failures += 1;
    cache.liveAt = now;
    cache.nextLiveAt = now + Math.min(RESET_CREDITS_RETRY_MAX_MS, RESET_CREDITS_RETRY_BASE_MS * 2 ** (cache.failures - 1));
    return cache.snapshot ?? { available: false, accounts: [], fetchedAt: new Date(now).toISOString(), reason: error instanceof Error ? error.message : String(error) };
  }).finally(() => {
    cache.inFlight = null;
  });
  cache.inFlight = run;
  return run;
}

/** A redemption changed a balance: the next read goes live. */
export function invalidateResetCredits(): void {
  state().nextLiveAt = 0;
}

/** Tests only: forget everything, including the in-memory carry-over. */
export function resetResetCreditsCache(): void {
  globalThis.__codyResetCreditsCache = undefined;
}
