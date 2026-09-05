import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { requireCapability } from "@/lib/engine-guard";
import type { EngineSettingValue, EngineSettingsSchema } from "@/lib/harness/types";

/**
 * The ACTIVE engine's own settings schema plus the values currently persisted
 * for it. The settings panel renders from this rather than a hand-kept list,
 * so an upstream addition shows up in its declared tab and group without a
 * Cody release.
 *
 * Engine-NEUTRAL, and neutral by construction: the engine supplies both
 * halves through `HarnessAdapter.settings` (omp from its TypeScript schema,
 * Hermes from its Python DEFAULT_CONFIG, pi from the settings tables in its
 * shipped docs), and this route only dispatches. It used to switch on engine
 * ids — `active.id === "hermes" ? … : ompBranch` — which made "no branch of
 * mine" mean "omp's branch": every other engine fell through and got omp's
 * ~550-key schema and omp's config.yml values back, stamped with its OWN id
 * and shortName ("All Pi Settings" over omp's settings). PUT was worse than
 * misleading: it wrote omp's config.yml while another engine was active and
 * reported success. An adapter hook cannot do that — an engine either
 * implements the surface or the route refuses it.
 *
 * The capability flag stays the outer gate (it is what hides the tab), and
 * the hook is the inner one, so an engine that declares `nativeSettings`
 * without implementing the surface refuses rather than borrowing someone
 * else's.
 *
 * Secret leaves (`EngineSetting.secret`, a credential-shaped string the
 * engine keeps beside its other settings) never leave the server: their
 * values are dropped from `values` here, and `secretsSet` names the ones
 * that hold something, so the panel can say "Set" without knowing what.
 */

export const dynamic = "force-dynamic";

const SURFACE = "a settings schema of its own";

/** The 400 an engine gets when it declares the capability but implements no
 * settings surface — the same `unsupported` code, and the same shape, the
 * capability gate itself answers with, because the client hides on that. */
function noSurface(shortName: string) {
  return NextResponse.json(
    { error: `${shortName} does not expose ${SURFACE} that Cody can read.`, code: "unsupported" },
    { status: 400 },
  );
}

/** Strip every secret leaf's value, reporting only which are set. A secret
 * counts as set when a non-empty string is persisted: Hermes declares its
 * keys with `""` as the default, and an empty override is the same as none. */
function redactSecrets(schema: EngineSettingsSchema | null, values: Record<string, EngineSettingValue>): { values: Record<string, EngineSettingValue>; secretsSet: string[] } {
  const secretKeys = new Set((schema?.settings ?? []).filter((setting) => setting.secret).map((setting) => setting.key));
  if (secretKeys.size === 0) return { values, secretsSet: [] };
  const shown: Record<string, EngineSettingValue> = {};
  const secretsSet: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!secretKeys.has(key)) {
      shown[key] = value;
      continue;
    }
    if (typeof value === "string" ? value.length > 0 : value !== undefined) secretsSet.push(key);
  }
  return { values: shown, secretsSet };
}

export function GET() {
  try {
    const gate = requireCapability("nativeSettings", SURFACE);
    if ("response" in gate) return gate.response;
    const active = gate.harness;
    // The active harness names the hub ("OMP" eyebrow, "All OMP settings" list), so the label
    // follows the engine selection instead of being baked into the UI.
    const { id, shortName } = active;
    const harness = { id, shortName };
    // The harness binary runs on this machine, so its platform-gated settings
    // (ui.condition "macOS") resolve from the server's own platform.
    const host = { platform: process.platform };
    if (!active.settings) return noSurface(shortName);
    const { path, schema, values, reason } = active.settings.readSchema();
    if (!schema) {
      return NextResponse.json({
        path,
        harness,
        host,
        schema: null,
        values: {},
        secretsSet: [],
        reason: reason ?? `${shortName}'s settings schema could not be read from the installed package`,
      });
    }
    const redacted = redactSecrets(schema, values);
    return NextResponse.json({ path, harness, host, schema, values: redacted.values, secretsSet: redacted.secretsSet });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { patch?: unknown };
    const patch = body.patch;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return NextResponse.json({ error: "patch must be an object of setting paths" }, { status: 400 });
    }
    const gate = requireCapability("nativeSettings", SURFACE);
    if ("response" in gate) return gate.response;
    const active = gate.harness;
    if (!active.settings) return noSurface(active.shortName);

    // The schema is read BEFORE the write so the echoed values can be
    // redacted by the same rule the GET uses; the read is memoized per
    // installed package, so this costs a config-file parse at most.
    const { schema } = active.settings.readSchema();
    const { written, rejected, values } = active.settings.write(patch as Record<string, unknown>);
    if (written.length > 0) {
      // Settings decide which models an engine offers and how its helper child
      // behaves, and the shared utility process caches both for its lifetime.
      // Dropping them here is engine-neutral: pi's `enabledModels` and
      // `defaultModel` reach /api/models through the very same cache omp's
      // model-visibility settings do.
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    const redacted = redactSecrets(schema, values);
    if (rejected.length === 0) return NextResponse.json({ success: true, written, values: redacted.values, secretsSet: redacted.secretsSet });
    // A save that did not happen is never reported as one. The panel shows
    // `error`, so the keys the engine would not take are named there.
    return NextResponse.json({
      success: false,
      written,
      rejected,
      values: redacted.values,
      secretsSet: redacted.secretsSet,
      error: `Not saved — ${rejected.map((entry) => `${entry.key}: ${entry.reason}`).join("; ")}`,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
