import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { readSchemaSettings, writeSchemaSettings } from "@/lib/omp/settings-values";
import { getHarness } from "@/lib/harness";
import { requireCapability } from "@/lib/engine-guard";
import { LIST_WRITE_UNSUPPORTED, getHermesSettingsSchema, readHermesSettingsValues, resetHermesSetting, writeHermesSetting } from "@/lib/harness/hermes-settings";

/**
 * OMP's own settings schema plus the values currently persisted for it. The
 * settings panel renders from this rather than a hand-kept list, so an upstream
 * addition shows up in its declared tab and group without a Cody release.
 *
 * Engine-generic, but only for the engines that HAVE such a schema: omp reads
 * its TypeScript one, Hermes derives one from its DEFAULT_CONFIG, and both
 * declare `nativeSettings`. An engine that declares neither used to fall
 * through to omp's branch and get omp's ~550-key schema and omp's config.yml
 * values back, stamped with its OWN id and shortName — "All Pi Settings" over
 * omp's settings. PUT was worse than misleading: it wrote omp's config.yml
 * while another engine was active, reporting success. The tab is hidden on
 * those engines, but a hidden tab is a UI convenience and this is the
 * boundary.
 */

export const dynamic = "force-dynamic";

/** Hermes declares its settings in Python rather than in omp's TypeScript
 * schema, so its schema is derived from its own DEFAULT_CONFIG. Same shape,
 * same panel — only the source differs. */
function readHermesSchema(harness: ReturnType<typeof getHarness>) {
  const binary = harness.resolveBinary();
  const schema = binary ? getHermesSettingsSchema(binary) : null;
  const home = harness.getAgentDir();
  return {
    path: `${home}/config.yaml`,
    schema,
    values: schema ? readHermesSettingsValues(home, schema.settings) : {},
  };
}

/** Why Hermes cannot take this patch entry, or null when it can. A `null`
 * entry is the panel's Reset and goes to `hermes config unset`. */
function unwritableReason(value: unknown): string | null {
  if (value === null) return null;
  if (Array.isArray(value)) return LIST_WRITE_UNSUPPORTED;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return null;
  return `Cody has no config form for a ${value === undefined ? "missing" : typeof value} value`;
}

const SURFACE = "a settings schema of its own";

export function GET() {
  try {
    const gate = requireCapability("nativeSettings", SURFACE);
    if ("response" in gate) return gate.response;
    const active = gate.harness;
    const { path, schema, values } = active.id === "hermes"
      ? readHermesSchema(active)
      : readSchemaSettings();
    // The active harness names the panel ("All OMP Settings"), so the label
    // follows CODY_HARNESS instead of being baked into the UI.
    const { id, shortName } = getHarness();
    const harness = { id, shortName };
    // The harness binary runs on this machine, so its platform-gated settings
    // (ui.condition "macOS") resolve from the server's own platform.
    const host = { platform: process.platform };
    if (!schema) {
      return NextResponse.json({ path, harness, host, schema: null, values: {}, reason: `${shortName}'s settings schema could not be read from the installed package` });
    }
    return NextResponse.json({ path, harness, host, schema, values });
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
    if (active.id === "hermes") {
      // Written through `hermes config set`, never by editing its YAML: the
      // CLI owns validation, coercion and config migration, and a file Cody
      // wrote behind its back can be one Hermes then refuses to load.
      const binary = active.resolveBinary();
      if (!binary) return NextResponse.json({ error: "hermes binary not found" }, { status: 400 });
      const written: string[] = [];
      const rejected: Array<{ key: string; reason: string }> = [];
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        const reason = unwritableReason(value);
        if (reason) {
          rejected.push({ key, reason });
          continue;
        }
        try {
          if (value === null) resetHermesSetting(binary, key);
          else writeHermesSetting(binary, key, value as boolean | number | string);
          written.push(key);
        } catch (error) {
          // One key Hermes refuses must not abort the rest of the patch, nor
          // disappear: it is named in the response instead.
          rejected.push({ key, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      const { values } = readHermesSchema(active);
      if (rejected.length === 0) return NextResponse.json({ success: true, written, values });
      // A save that did not happen is never reported as one. The panel shows
      // `error`, so the keys Hermes would not take are named there.
      return NextResponse.json({
        success: false,
        written,
        rejected,
        values,
        error: `Not saved — ${rejected.map((entry) => `${entry.key}: ${entry.reason}`).join("; ")}`,
      });
    }
    const written = writeSchemaSettings(patch as Record<string, unknown>);
    if (written.length > 0) {
      // The helper OMP process caches settings for its lifetime, and model
      // visibility derives from several of these paths; drop both so the next
      // read reflects what was just saved.
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    return NextResponse.json({ success: true, written, values: readSchemaSettings().values });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
