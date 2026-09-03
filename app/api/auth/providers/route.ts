import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";

export const dynamic = "force-dynamic";

/**
 * The providers the ACTIVE engine can sign the user in to with its own
 * login — omp's /login roster, pi's OAuth providers, Claude Code's and
 * Codex's subscriptions, Hermes' OAuth providers — read through the
 * adapter's `providerLogins` surface, so this route never names an engine.
 * An empty list carries the engine's own reason (not installed, its status
 * command failed); an engine without the surface refuses `unsupported`,
 * which is what hides the section.
 */
export async function GET() {
  const gate = requireCapability("providerLogin", "Provider sign-in");
  if ("response" in gate) return gate.response;
  const engine = getHarness();
  const surface = engine.providerLogins;
  if (!surface) {
    return NextResponse.json(
      { error: `${engine.displayName} has no provider sign-in surface`, code: "unsupported" },
      { status: 400 },
    );
  }
  const list = await surface.list();
  return NextResponse.json(
    { engine: { id: engine.id, shortName: engine.shortName }, providers: list.providers, ...(list.reason ? { reason: list.reason } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
