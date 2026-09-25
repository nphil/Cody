import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { requireCapability } from "@/lib/engine-guard";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getHarness } from "@/lib/harness";
import { invalidateProviderLoginsCache } from "@/lib/provider-directory-server";

export const dynamic = "force-dynamic";

/**
 * Remove a provider credential. Most engines keep exactly one credential per
 * provider and disconnect it wholesale through their own non-interactive
 * logout — `claude auth logout`, `codex logout`, pi's auth store. omp instead
 * lets several accounts serve the same provider (lib/omp/provider-login.ts,
 * backed by lib/harness/omp-credentials.ts): a JSON body naming `accountId`
 * permanently removes just that one stored credential (`surface.removeAccount`)
 * instead of every credential for the provider (`surface.logout`, the no-body
 * path below, unchanged). OMP-disabled history is not silently promoted into
 * this action; only the selected row is purged.
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
    const candidate = body && typeof body === "object" ? (body as { accountId?: unknown }).accountId : undefined;
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
      if (!removed) {
        return NextResponse.json({ error: `Cody found no "${provider}" account matching that id.`, code: "not_found" }, { status: 404 });
      }
      invalidateModelsCache();
      // ...and the rail's cached `?cached=1` roster, or it keeps answering
      // "signed in" until the 15s peek window lapses.
      invalidateProviderLoginsCache(engine.id);
      return NextResponse.json({ ok: true, provider, accountId, providerRemoved, permanent: true });
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
    await surface.logout(provider);
    invalidateModelsCache();
    // ...and the rail's cached `?cached=1` roster, or it keeps answering
    // "signed in" until the 15s peek window lapses.
    invalidateProviderLoginsCache(engine.id);
    return NextResponse.json({ ok: true, provider });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "logout_failed" },
      { status: 400 },
    );
  }
}
