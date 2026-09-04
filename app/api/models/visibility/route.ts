import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { MAX_VISIBILITY_KEYS, readInstanceHidden, readUserVisibility, writeInstanceHidden, writeUserVisibility } from "@/lib/model-visibility";
import { readNativeSettings } from "@/lib/omp/settings-config";

/**
 * Who hides and pins which models under the ACTIVE engine
 * (lib/model-visibility.ts).
 *
 * GET answers three lists for the signed-in user: `instanceHidden` (an
 * administrator's hide for everyone), `hidden` (this user's own) and
 * `pinned` (this user's), plus `instanceSource`, which says where the
 * instance-wide hide LIVES:
 *
 *   - "enabledModels" — omp. Its instance hide is omp's own allow-list in
 *     config.yml, written through /api/omp-settings; the effective catalog
 *     (/api/models) already excludes what it hides, so `instanceHidden` is
 *     `[]` here and a PUT of it is refused `unsupported`. The client derives
 *     the hidden set as full catalog − effective catalog.
 *   - "readonly" — omp whose config.yml holds path-scoped registry entries
 *     Cody must not rewrite (settings-config `registryHasScopedEntries`);
 *     the catalog renders its curation controls read-only.
 *   - "cody" — every other engine: the hide is this file's.
 *
 * PUT `{instanceHidden?, hidden?, pinned?}` replaces each list it names.
 * `instanceHidden` is an administrator's act (403 otherwise); `hidden` and
 * `pinned` are any user's own. Keys are `provider/id` and are stored
 * deduplicated and sorted. Any signed-in user may read; the proxy is the
 * gate, as for /api/models.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_048_576;

type InstanceSource = "enabledModels" | "cody" | "readonly";

function instanceSourceFor(engineId: string): InstanceSource {
  if (engineId !== "omp") return "cody";
  try {
    return readNativeSettings().settings.registryHasScopedEntries === true ? "readonly" : "enabledModels";
  } catch {
    // An unreadable config.yml is the settings editor's problem to report;
    // the visibility answer stays honest about where the hide would go.
    return "enabledModels";
  }
}

function answer(userId: string) {
  const engine = getHarness();
  const source = instanceSourceFor(engine.id);
  const mine = readUserVisibility(userId, engine.id);
  return NextResponse.json(
    {
      engine: { id: engine.id },
      instanceHidden: source === "cody" ? readInstanceHidden(engine.id) : [],
      hidden: mine.hidden,
      pinned: mine.pinned,
      instanceSource: source,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  return answer(resolved.user.id);
}

function readKeyList(body: Record<string, unknown>, field: string): string[] | undefined | { error: NextResponse } {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (!Array.isArray(value) || value.length > MAX_VISIBILITY_KEYS || !value.every((key) => typeof key === "string")) {
    return { error: jsonError(`${field} must be an array of provider/id strings`, 400, "keys_required") };
  }
  return value as string[];
}

export async function PUT(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const record = body as Record<string, unknown>;
  const instanceHidden = readKeyList(record, "instanceHidden");
  if (instanceHidden && "error" in instanceHidden) return instanceHidden.error;
  const hidden = readKeyList(record, "hidden");
  if (hidden && "error" in hidden) return hidden.error;
  const pinned = readKeyList(record, "pinned");
  if (pinned && "error" in pinned) return pinned.error;
  if (instanceHidden === undefined && hidden === undefined && pinned === undefined) {
    return jsonError("Nothing to update: send instanceHidden, hidden or pinned", 400, "keys_required");
  }

  const engine = getHarness();
  if (instanceHidden !== undefined) {
    if (resolved.user.role !== "admin") return jsonError("Administrator access required", 403, "admin_required");
    const source = instanceSourceFor(engine.id);
    if (source !== "cody") {
      return jsonError(
        `${engine.displayName} hides models for the whole instance through its own enabledModels setting, not through Cody's visibility file.`,
        400,
        "unsupported",
      );
    }
    writeInstanceHidden(engine.id, instanceHidden);
  }
  if (hidden !== undefined || pinned !== undefined) {
    writeUserVisibility(resolved.user.id, engine.id, {
      ...(hidden !== undefined ? { hidden } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
    });
  }
  return answer(resolved.user.id);
}
