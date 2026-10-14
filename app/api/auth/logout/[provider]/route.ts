import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { requireCapability } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";
import { settleProviderChange } from "@/lib/provider-state";

export const dynamic = "force-dynamic";

/**
 * Remove a provider credential. Most engines keep exactly one credential per
 * provider and disconnect it wholesale through their own non-interactive
 * logout — `claude auth logout`, `codex logout`, pi's auth store. omp instead
 * lets several accounts serve the same provider (lib/omp/provider-login.ts,
 * backed by lib/harness/omp-credentials.ts): a JSON body naming `accountId`
 * removes just that one stored credential (`surface.removeAccount`) instead of
 * every credential for the provider (`surface.logout`, the no-body path below).
 *
 * Whatever happens, the answer says what really happened:
 *   - `{ok: true, accountId, providerRemoved}` — the account is gone, from the
 *     store itself, not just hidden;
 *   - `{ok: true, removed, count?}` — a provider-wide sign-out; `removed:false`
 *     means there was nothing stored for it (a key from the server's
 *     environment cannot be signed out of from here);
 *   - 404 `not_found` — the account was already gone (a stale list), which is
 *     the outcome the caller wanted: the caches are still dropped so the
 *     list it re-reads no longer shows it;
 *   - 400 `unsupported` / `logout_failed` — a real failure, in plain words.
 *
 * Every success (and the stale-list 404) then makes Cody forget the provider
 * everywhere it remembered it (`settleProviderChange`) and restarts idle
 * engines, so the next turn cannot use the removed account. `restarted` and
 * `active` (engines mid-reply, which finish on the old state) come back so
 * the UI can say so.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  // Removing a credential every user's sessions depend on is an
  // administrator's act, like saving or clearing a key.
  const auth = requireAdmin(req);
  if ("response" in auth) return auth.response;
  const gate = requireCapability("providerLogin", "Provider sign-out");
  if ("response" in gate) return gate.response;
  const engine = getHarness();
  const surface = engine.providerLogins;

  let accountId: string | undefined;
  try {
    const body: unknown = await req.json();
    const candidate = body && typeof body === "object" && "accountId" in body ? body.accountId : undefined;
    if (typeof candidate === "string" && candidate.length > 0) accountId = candidate;
  } catch {
    // No body, or not JSON — falls through to the provider-wide logout below.
  }

  if (accountId !== undefined) {
    if (!surface?.removeAccount) {
      return NextResponse.json(
        {
          error: `Cody cannot remove a single "${provider}" account: ${engine.displayName} exposes no per-account removal.`,
          code: "unsupported",
        },
        { status: 400 },
      );
    }
    try {
      const { removed, providerRemoved } = await surface.removeAccount(provider, accountId);
      // An opaque account id; omp's is its credential row id, which is also what a usage account carries.
      const credentialId = Number(accountId);
      const settled = await settleProviderChange({
        engineId: engine.id,
        ...(providerRemoved ? { removedProviders: [provider] } : {}),
        ...(Number.isSafeInteger(credentialId) ? { removedCredentials: [{ provider, credentialId }] } : {}),
      });
      if (!removed) {
        return NextResponse.json({ error: "That account is already gone — the list was out of date.", code: "not_found", ...settled }, { status: 404 });
      }
      return NextResponse.json({ ok: true, provider, accountId, providerRemoved, ...settled });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error), code: "logout_failed" },
        { status: 400 },
      );
    }
  }

  if (!surface?.logout) {
    return NextResponse.json(
      {
        error: `Cody cannot disconnect "${provider}": ${engine.displayName} exposes no logout command outside its own UI.`,
        code: "unsupported",
      },
      { status: 400 },
    );
  }
  try {
    const outcome = await surface.logout(provider);
    const settled = await settleProviderChange({ engineId: engine.id, removedProviders: [provider] });
    return NextResponse.json({ ok: true, provider, ...(outcome ? { removed: outcome.removed, ...(outcome.count !== undefined ? { count: outcome.count } : {}) } : {}), ...settled });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "logout_failed" },
      { status: 400 },
    );
  }
}
