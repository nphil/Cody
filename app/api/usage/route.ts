import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import { getAgentDir } from "@/lib/omp/paths";
import { readProviderAccountNames } from "@/lib/provider-account-names";
import { resolveSessionPath } from "@/lib/session-reader";
import { withUsageAccountNames } from "@/lib/usage/account-names";
import { usageReaderInstalled } from "@/lib/usage/omp-usage";
import { credentialForPin, getUsageSnapshot } from "@/lib/usage/cache";
import { readSessionCredentialPins } from "@/lib/usage/session-pins";
import { reconcileRoutingForRequest } from "@/lib/routing/request";
import type { UsageSessionAccount, UsageSnapshot } from "@/lib/usage/types";

/**
 * GET /api/usage — plan-quota windows (e.g. "5h: 42% used, resets 14:00")
 * for every signed-in provider account, for the usage meter in Settings and
 * the status strip. Same signed-in-only guard as GET /api/local-ai; all
 * probing and caching lives in lib/usage, so this route is just auth +
 * fail-soft plumbing.
 */
export const dynamic = "force-dynamic";

function emptySnapshot(reason: string): UsageSnapshot {
  return { available: false, accounts: [], fetchedAt: new Date().toISOString(), stale: false, reason };
}

/** Loose shape check only: the id is looked up, never interpolated into a path. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Per provider, the account this conversation's latest reply was served by:
 * omp's own `credential_pin` entries in the session file, matched against the
 * credential store's digests. A session the caller cannot see, or one with no
 * file yet (first turn still running), answers `{}` — "not used yet" — never
 * an error, and never another account's data.
 */
async function sessionAccounts(
  sessionId: string,
  user: Parameters<typeof canAccessSession>[1],
  snapshot: UsageSnapshot,
): Promise<Record<string, UsageSessionAccount>> {
  const result: Record<string, UsageSessionAccount> = {};
  if (!SESSION_ID.test(sessionId) || !canAccessSession(sessionId, user)) return result;
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return result;
  for (const [provider, pin] of await readSessionCredentialPins(filePath)) {
    const credential = credentialForPin(pin.hash);
    if (!credential || credential.provider !== provider) continue;
    const account = snapshot.accounts.find((candidate) => candidate.provider === provider && candidate.credentialId === credential.credentialId);
    if (account) result[provider] = { accountId: account.id, since: pin.timestamp };
  }
  return result;
}

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  // Quota belongs to the ACCOUNTS, not to whichever engine is driving chat:
  // a Claude or Codex login spends the same plan whether omp, Claude Code or
  // Codex sends the request. `omp usage --json` is the only reader lib/usage
  // has, so the one real precondition is that omp is installed, not that it
  // is the active engine. Without it the answer is an unavailable snapshot,
  // a VALUE the meter hides on, and nothing is spawned to find that out.
  if (!usageReaderInstalled()) {
    return NextResponse.json(
      emptySnapshot("omp is not installed, so account quota cannot be read."),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // The client poll is itself the refresh trigger, so wait for the fresh
    // read rather than being handed the entry it came to replace — otherwise
    // every poll lands after the TTL and reports "may be out of date" forever.
    const snapshot = await getUsageSnapshot({ awaitFresh: true });
    // One read, one routing decision. Reconciling here rather than on a timer
    // of its own means the blackout registry, the role bindings and the ring
    // are always derived from the SAME snapshot — the single-source-of-truth
    // property the composer, the subagents and the fallback chains all
    // depend on. It never throws and writes nothing when nothing moved.
    // Observation runs for every engine; writes to omp's config only when
    // omp is the active engine (reconcile.ts owns that gate).
    const routing = await reconcileRoutingForRequest(snapshot);
    // A bad or temporarily unreadable Cody name file cannot make quota
    // unavailable. Names only affect the response, never routing decisions.
    let displaySnapshot = routing.snapshot;
    try {
      displaySnapshot = withUsageAccountNames(routing.snapshot, readProviderAccountNames(getAgentDir()));
    } catch { /* Keep the measured snapshot and its quota windows. */ }
    const sessionId = new URL(request.url).searchParams.get("session");
    const scoped = sessionId && displaySnapshot.available
      ? { sessionAccounts: await sessionAccounts(sessionId, resolved.user, displaySnapshot) }
      : {};
    return NextResponse.json(
      { ...displaySnapshot, ...scoped, routing: { autoBind: routing.autoBind, blackouts: routing.blackouts, roleChanges: routing.roleChanges, chainChanges: routing.chainChanges, agentChanges: routing.agentChanges } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // getUsageSnapshot is expected to fail soft on its own; this only guards
    // against something more fundamental (e.g. the cache module itself
    // throwing during import-time setup). Never surface a 500 for a usage
    // widget — an empty, well-formed snapshot is always a valid answer.
    return NextResponse.json(emptySnapshot(error instanceof Error ? error.message : String(error)), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
