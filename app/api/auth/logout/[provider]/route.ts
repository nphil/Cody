import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";

export const dynamic = "force-dynamic";

/**
 * Remove a provider credential through the engine's own logout. Only an
 * engine with a NON-INTERACTIVE logout offers one (`claude auth logout`,
 * `codex logout`, `hermes auth logout`, pi's auth store); omp keeps the
 * credential in a store only its own /logout selector can edit, so its
 * adapter has no `logout` and the row shows no button.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const gate = requireCapability("providerLogin", "Provider sign-out");
  if ("response" in gate) return gate.response;
  const engine = getHarness();
  const surface = engine.providerLogins;
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
    return NextResponse.json({ ok: true, provider });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "logout_failed" },
      { status: 400 },
    );
  }
}
