import { NextResponse } from "next/server";
import { jsonError, requireCredential } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { markCatalogSeen, readSeenLedger } from "@/lib/model-catalog-seen";

/**
 * The "seen" ledger for the ACTIVE engine (lib/model-catalog-seen.ts).
 *
 * GET answers which `provider/id` keys have been shown to the user and when;
 * any signed-in user may read it — the proxy is the gate, as for
 * `/api/models`. POST records a display: the body's `keys` REPLACE the
 * engine's list by default, or — with `merge: true` — are UNIONED into the
 * ledger's current keys, so a curation dialog that displayed one provider's
 * models can mark exactly those as seen without touching what the ledger
 * already recorded for every other provider (`markCatalogSeen` itself stays
 * a pure replace; this route composes the union from `readSeenLedger`). It
 * is admin-only because the ledger is instance state — one member marking
 * the catalog seen would silence the "new models" notice for everyone,
 * including the admin who curates.
 *
 * On an open instance (no accounts at all, `requireCredential` answers 409
 * `no_accounts`) there is no admin to require: `useModelCatalog`'s
 * `openInstance` already treats whoever is looking as the administrator, and
 * the un-gated `/api/omp-settings` PUT lets that same viewer write
 * `enabledModels` freely, so refusing this ledger write would only make the
 * "new models" feature inert rather than actually protect anything.
 */

/** Admin-only, except that "no accounts exist yet" (`no_accounts`) is not a
 * missing permission — it's the open-instance case every other admin write
 * here already treats as "the viewer is the administrator". */
function requireAdminOrOpenInstance(request: Request): NextResponse | null {
  const resolved = requireCredential(request);
  if ("response" in resolved) return resolved.response.status === 409 ? null : resolved.response;
  if (resolved.credential.user.role !== "admin") {
    return jsonError("Administrator access required", 403, "admin_required");
  }
  return null;
}

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
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const record = typeof body === "object" && body !== null ? (body as { keys?: unknown; merge?: unknown }) : {};
  const keys = record.keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every((key) => typeof key === "string")) {
    return jsonError("keys must be an array of provider/id strings", 400, "keys_required");
  }
  const merge = record.merge === true;

  const engine = getHarness();
  const nextKeys = merge ? [...new Set([...readSeenLedger(engine.id).seenKeys, ...keys])] : keys;
  markCatalogSeen(engine.id, nextKeys);
  return answer();
}
