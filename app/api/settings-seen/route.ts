import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { engineOwnVersion, getHarness, type HarnessAdapter } from "@/lib/harness";
import type { EngineSettingsSchema } from "@/lib/harness/types";
import { FADE_AFTER_SEEN, UNKNOWN_ENGINE_VERSION, parseSeenReport } from "@/lib/settings-new-keys";
import { readUserNewKeys, recordChanged, recordSeen, settingsOwnerKeyFor, syncEngineKeys, type UserNewKeys } from "@/lib/settings-seen";

/**
 * Which of the active engine's settings are NEW since its last update, for the
 * person asking (lib/settings-seen.ts holds the ledger and the rules).
 *
 * The Settings dialog shows a "New" chip on a setting that arrived with an
 * engine update, until that person has seen the chip in 3 separate Settings
 * opens or changed the setting. Nothing about it is instance-wide: one
 * person's views never fade another's chip, so this is NOT admin-only; it is
 * per account, or one fixed record on an open instance (no accounts).
 *
 * The keys come from the same place the Behavior hub renders: the engine's own
 * settings schema (`HarnessAdapter.settings.readSchema()`, what
 * /api/omp-settings/schema answers). Every GET and POST first folds the current
 * keys into the engine's snapshot, so the diff is against the last look and the
 * very first look only records (no badge anywhere).
 *
 * GET  -> { engine: { id, version }, previousVersion, firstRun, newKeys, since, fadeAfter }
 *   newKeys   the still-badged keys for THIS person, sorted; terminal-only
 *             settings (they do nothing in a browser) are never in it.
 *   since     { [key of newKeys]: the engine version that brought it }
 *   version / previousVersion / since values are null when the engine's
 *             version could not be read.
 *   firstRun  this request was the first look at the engine (keys recorded,
 *             nothing badged).
 * POST { openId, seen?: string[], changed?: string[] } -> the same answer, after
 *   counting. `openId` is one random id per Settings open; the ledger keeps the
 *   last open that counted beside each counter, so a retried or duplicated
 *   POST cannot count twice. `seen` are chips shown in that open, `changed`
 *   are keys whose value was changed. Keys that are not new settings of the
 *   engine are ignored, never an error: the client may race an update.
 *
 * An engine that has no settings schema (or an empty one) answers
 * `newKeys: []` and writes nothing.
 */

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** A report is a handful of keys; this leaves room for the largest a client may send without accepting arbitrary bodies. */
const MAX_BODY_BYTES = 262_144;

interface EngineKeys {
  id: string;
  /** Every key the schema declares, terminal-only ones included (they stay recorded in the ledger). */
  keys: string[];
  /** The keys a browser can act on: the ones allowed to badge. */
  eligible: Set<string>;
  schemaVersion: string | null;
}

/** The active engine's declared keys, or null when it declares none (or its schema cannot be read right now). */
function readEngineKeys(harness: HarnessAdapter): EngineKeys | null {
  const settings = harness.settings;
  if (!settings) return null;
  let schema: EngineSettingsSchema | null;
  try {
    schema = settings.readSchema().schema;
  } catch {
    return null;
  }
  if (!schema || schema.settings.length === 0) return null;
  return {
    id: harness.id,
    keys: schema.settings.map((setting) => setting.key),
    eligible: new Set(schema.settings.filter((setting) => !setting.terminalOnly).map((setting) => setting.key)),
    schemaVersion: schema.source.version,
  };
}

async function versionOf(harness: HarnessAdapter, schemaVersion: string | null): Promise<string | null> {
  try {
    return (await engineOwnVersion(harness)) ?? schemaVersion;
  } catch {
    return schemaVersion;
  }
}

/** A version for the client: the ledger's placeholder for an unreadable version is no version. */
function shown(version: string | null): string | null {
  return version && version !== UNKNOWN_ENGINE_VERSION ? version : null;
}

function answer(
  engineId: string,
  sync: { engineVersion: string; previousVersion: string | null; firstRun: boolean } | null,
  mine: UserNewKeys,
) {
  const since: Record<string, string | null> = {};
  for (const [key, version] of Object.entries(mine.since)) since[key] = shown(version);
  return NextResponse.json(
    {
      engine: { id: engineId, version: shown(sync?.engineVersion ?? null) },
      previousVersion: shown(sync?.previousVersion ?? null),
      firstRun: sync?.firstRun ?? false,
      newKeys: mine.newKeys,
      since,
      fadeAfter: FADE_AFTER_SEEN,
    },
    noStore,
  );
}

/** Fold the current look into the ledger, then run `act` for the caller and answer with what is still badged for them. */
async function respond(user: { id: string } | null, act?: (ownerKey: string, engine: EngineKeys) => void) {
  const harness = getHarness();
  const engine = readEngineKeys(harness);
  if (!engine) return answer(harness.id, null, { newKeys: [], since: {} });

  const version = await versionOf(harness, engine.schemaVersion);
  // No await from here to the end: the read-modify-writes of the ledger run
  // back to back, so two requests cannot interleave inside them.
  const synced = syncEngineKeys(engine.id, version, engine.keys);
  const ownerKey = settingsOwnerKeyFor(user);
  act?.(ownerKey, engine);
  return answer(engine.id, synced, readUserNewKeys(ownerKey, engine.id, engine.eligible));
}

export async function GET(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  return respond(actor.user);
}

export async function POST(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const parsed = parseSeenReport(body);
  if ("error" in parsed) return jsonError(parsed.error, 400, "invalid_report");
  const { report } = parsed;

  return respond(actor.user, (ownerKey, engine) => {
    if (report.seen.length > 0) recordSeen(ownerKey, engine.id, report.seen, report.openId, engine.eligible);
    if (report.changed.length > 0) recordChanged(ownerKey, engine.id, report.changed, engine.eligible);
  });
}
