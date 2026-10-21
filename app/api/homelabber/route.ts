import { NextResponse } from "next/server";
import { requireUserOrOpenInstance } from "@/lib/auth/http";
import { readEnv } from "@/lib/env";
import { getHarness } from "@/lib/harness";
import { HOMELABBER_DEFAULT_BASE, homelabberBaseFromMcpUrl } from "@/lib/homelabber-approval";
import { homelabberBaseFromConfig } from "@/lib/omp/homelabber-base";

export const dynamic = "force-dynamic";

/**
 * `GET /api/homelabber` → `{ base, source }`: the web origin of HomeLabber, for
 * the approval card's "Use backup code" link (`components/HomelabberApproval`).
 *
 * `source` says where `base` came from, in this order:
 *   - `env`: `CODY_HOMELABBER_URL`, for an install that knows better;
 *   - `mcp`: the origin of the `homelabber` server in omp's user-level
 *     mcp.json, read only when omp is the active engine (like `/api/mcp`);
 *   - `default`: the built-in `HOMELABBER_DEFAULT_BASE`.
 * The answer is an origin and nothing else — the MCP config's headers and the
 * URL's path never leave the server.
 */
export function GET(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  const fromEnv = homelabberBaseFromMcpUrl(readEnv("HOMELABBER_URL"));
  const fromConfig = fromEnv ? null : getHarness().capabilities.mcp ? homelabberBaseFromConfig() : null;
  const answer = fromEnv ? { base: fromEnv, source: "env" }
    : fromConfig ? { base: fromConfig, source: "mcp" }
      : { base: HOMELABBER_DEFAULT_BASE, source: "default" };
  return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
}
