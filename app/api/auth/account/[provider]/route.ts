import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { requireCapability } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";
import { MAX_PROVIDER_ACCOUNT_NAME_LENGTH, normalizeProviderAccountName } from "@/lib/provider-account-names";
import { invalidateProviderLoginsCache } from "@/lib/provider-directory-server";

export const dynamic = "force-dynamic";

/** Rename one enumerated provider account in Cody's own metadata store. The
 * engine credential and its identity remain untouched; an empty name clears
 * the Cody label and falls back to the engine-reported identity. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const auth = requireAdmin(req);
  if ("response" in auth) return auth.response;
  const gate = requireCapability("providerLogin", "Provider account names");
  if ("response" in gate) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "A JSON account name is required.", code: "invalid_request" }, { status: 400 });
  }
  const accountId = body && typeof body === "object" && typeof (body as { accountId?: unknown }).accountId === "string"
    ? (body as { accountId: string }).accountId.trim()
    : "";
  const rawName = body && typeof body === "object" && typeof (body as { name?: unknown }).name === "string"
    ? (body as { name: string }).name
    : null;
  if (!accountId || accountId.length > 500 || rawName === null) {
    return NextResponse.json({ error: "An account id and a name are required.", code: "invalid_request" }, { status: 400 });
  }

  let name: string | null;
  try {
    name = normalizeProviderAccountName(rawName);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : `Connection names must be ${MAX_PROVIDER_ACCOUNT_NAME_LENGTH} characters or fewer.`, code: "invalid_name" },
      { status: 400 },
    );
  }

  const engine = getHarness();
  const renameAccount = engine.providerLogins?.renameAccount;
  if (!renameAccount) {
    return NextResponse.json(
      { error: `Cody cannot name a single "${provider}" account: ${engine.displayName} exposes no per-account naming.`, code: "unsupported" },
      { status: 400 },
    );
  }
  try {
    const result = await renameAccount(provider, accountId, name ?? "");
    invalidateProviderLoginsCache(engine.id);
    return NextResponse.json({ ok: true, provider, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "rename_failed" },
      { status: 400 },
    );
  }
}
