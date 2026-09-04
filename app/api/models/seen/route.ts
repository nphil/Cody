import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { markCatalogSeen, readSeenLedger } from "@/lib/model-catalog-seen";

/**
 * The "seen" ledger for the ACTIVE engine (lib/model-catalog-seen.ts).
 *
 * GET answers which `provider/id` keys have been shown to the user and when;
 * any signed-in user may read it — the proxy is the gate, as for
 * `/api/models`. POST records a display: the body's `keys` REPLACE the
 * engine's list. It is admin-only because the ledger is instance state — one
 * member marking the catalog seen would silence the "new models" notice for
 * everyone, including the admin who curates.
 */

export const dynamic = "force-dynamic";

/** ~600 models × ~40 bytes is the real-world size; this leaves room for a
 * registry an order of magnitude larger without accepting arbitrary bodies. */
const MAX_BODY_BYTES = 1_048_576;
const MAX_KEYS = 20_000;

function answer() {
  const engine = getHarness();
  const ledger = readSeenLedger(engine.id);
  return NextResponse.json(
    { engine: { id: engine.id }, seenKeys: ledger.seenKeys, seenAt: ledger.seenAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET() {
  return answer();
}

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const keys = typeof body === "object" && body !== null && "keys" in body ? (body as { keys: unknown }).keys : undefined;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every((key) => typeof key === "string")) {
    return jsonError("keys must be an array of provider/id strings", 400, "keys_required");
  }

  markCatalogSeen(getHarness().id, keys);
  return answer();
}
