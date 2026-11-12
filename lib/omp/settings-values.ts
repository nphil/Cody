import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isMap, parseDocument } from "yaml";
import { getSettingsPath } from "./paths";
import { getOmpSettingsSchema, type OmpSetting, type OmpSettingsSchema } from "./settings-schema";

/**
 * Generic read/write for any setting OMP's schema declares, addressed by its
 * dotted path. The hand-written counterpart in ./settings-config.ts stays in
 * charge of the settings Cody gives bespoke controls to (model registry,
 * approval matrix, fallback chains); everything else flows through here so a
 * setting added upstream is editable the moment OMP ships it.
 *
 * OMP stores dotted paths nested (`prewalk.enabled` → `prewalk: { enabled }`),
 * so segments map straight onto YAML nodes. Writes go through the document API
 * to preserve the user's comments and key order, then land atomically.
 */

export type OmpSettingValue = boolean | number | string | string[];

function readDocument() {
  const path = getSettingsPath();
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  return { path, doc };
}

/** The values a setting may take, when the schema constrains them. */
function allowedValues(setting: OmpSetting): Set<string> | null {
  if (setting.type !== "enum") return null;
  const declared = [...(setting.values ?? []), ...(setting.options ?? []).map((option) => option.value)];
  return declared.length > 0 ? new Set(declared) : null;
}

/** Coerce a stored value to the schema's type, or drop it. A settings file
 * edited by hand can hold anything; a mistyped value must not reach a control
 * that assumes otherwise. */
function coerce(setting: OmpSetting, raw: unknown): OmpSettingValue | undefined {
  switch (setting.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "enum": {
      if (typeof raw !== "string") return undefined;
      const allowed = allowedValues(setting);
      return !allowed || allowed.has(raw) ? raw : undefined;
    }
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "array":
      return Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : undefined;
  }
}

/** Resolve a dotted path against the plain-JS view of the file. A path may also
 * be persisted with the whole dotted key as one quoted mapping key; OMP's
 * migrations normalize toward the nested form but still read both, so Cody
 * does too. */
function resolvePath(data: Record<string, unknown>, key: string): unknown {
  let current: unknown = data;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current !== undefined) return current;
  return data[key];
}

export interface OmpSettingsSnapshot {
  path: string;
  schema: OmpSettingsSchema | null;
  /** Only the values actually persisted; an absent key means "OMP's default". */
  values: Record<string, OmpSettingValue>;
}

/** The saved-reset groups whose single `autoRedeem` consent omp 18.18.7 split
 * into one key per window. */
const AUTO_REDEEM_GROUPS = ["codexResets", "claudeResets"] as const;
const AUTO_REDEEM_WINDOW_KEYS = ["autoRedeem5h", "autoRedeemWeekly"] as const;
const AUTO_REDEEM_MODES: ReadonlySet<string> = new Set(["unset", "yes", "no"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LegacyAutoRedeemPlan {
  group: (typeof AUTO_REDEEM_GROUPS)[number];
  /** What the engine copies into every window key that is not set yet:
   * `true`/`false` become "yes"/"no"; a string is carried over as it is. */
  mode: unknown;
  /** The window keys (`autoRedeem5h`, ...) the engine would fill from the legacy value. */
  fill: string[];
}

/** Which groups still carry the legacy `autoRedeem` (nested, or as the quoted
 * dotted key) and which window keys omp would fill from it. Only for a group
 * whose per-window keys the running engine's schema declares: an engine
 * without them (18.8.x) still reads the single key itself. Mirrors omp's
 * src/config/settings.ts migration (18.18.7+): the nested value wins over the
 * flat one, a window key counts as set when it holds anything but undefined (a
 * YAML null included), and the Fable window is never filled. omp writes the
 * fill into the nested group when there is one; with no nested group it writes
 * a quoted dotted key that its settings reader never picks up (checked on
 * 18.19.0: `omp config get` says "unset"), so that case fills nothing here
 * either: showing or materializing a consent the engine does not act on would
 * grant new spending permission. */
function planLegacyAutoRedeem(data: Record<string, unknown>, schemaKeys: ReadonlySet<string>): LegacyAutoRedeemPlan[] {
  const plans: LegacyAutoRedeemPlan[] = [];
  for (const group of AUTO_REDEEM_GROUPS) {
    if (!AUTO_REDEEM_WINDOW_KEYS.every((key) => schemaKeys.has(`${group}.${key}`))) continue;
    const nested = isPlainRecord(data[group]) ? data[group] : undefined;
    const dotted = `${group}.autoRedeem`;
    // The key being present at all (even as null) is dropped by the engine.
    const present = (nested !== undefined && "autoRedeem" in nested) || dotted in data;
    if (!present) continue;
    const legacy = nested?.autoRedeem ?? data[dotted];
    const mode = typeof legacy === "boolean" ? (legacy ? "yes" : "no") : legacy;
    const fill =
      nested === undefined || legacy === undefined || legacy === null
        ? []
        : AUTO_REDEEM_WINDOW_KEYS.filter((key) => nested[key] === undefined && data[`${group}.${key}`] === undefined);
    plans.push({ group, mode, fill });
  }
  return plans;
}

/**
 * The settings file as the engine sees it after its in-memory migration of the
 * old single saved-reset switch (`codexResets.autoRedeem`, `claudeResets.autoRedeem`)
 * into `autoRedeem5h` / `autoRedeemWeekly`. omp 18.18.7+ does this on load and
 * leaves config.yml untouched, so the file alone shows those switches unset
 * while the engine is already spending saved resets on the old consent.
 *
 * Pure: returns `data` itself when there is nothing to migrate, otherwise a
 * copy with only the affected groups changed. `schemaKeys` is the running
 * engine's declared key set; a group is left alone unless it declares both
 * window keys, so an 18.8.x engine's values stay exactly as they are.
 */
export function migrateLegacyAutoRedeem(data: Record<string, unknown>, schemaKeys: ReadonlySet<string>): Record<string, unknown> {
  const plans = planLegacyAutoRedeem(data, schemaKeys);
  if (plans.length === 0) return data;
  const migrated: Record<string, unknown> = { ...data };
  for (const { group, mode, fill } of plans) {
    const nested = isPlainRecord(data[group]) ? { ...data[group] } : undefined;
    if (nested) {
      delete nested.autoRedeem;
      migrated[group] = nested;
      for (const key of fill) nested[key] = mode;
    }
    delete migrated[`${group}.autoRedeem`];
  }
  return migrated;
}

/** Every schema-declared setting currently persisted in OMP's settings file. */
export function readSchemaSettings(): OmpSettingsSnapshot {
  const schema = getOmpSettingsSchema();
  const { path, doc } = readDocument();
  const values: Record<string, OmpSettingValue> = {};
  if (!schema) return { path, schema, values };
  const data = doc.toJS() as unknown;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { path, schema, values };
  const source = migrateLegacyAutoRedeem(data as Record<string, unknown>, new Set(schema.settings.map((setting) => setting.key)));
  for (const setting of schema.settings) {
    const raw = resolvePath(source, setting.key);
    if (raw === undefined || raw === null) continue;
    const value = coerce(setting, raw);
    if (value !== undefined) values[setting.key] = value;
  }
  return { path, schema, values };
}

/**
 * One value straight out of OMP's settings file, bypassing the schema view.
 *
 * `readSchemaSettings` above deliberately sees only the settings OMP gives `ui`
 * metadata — those are the ones a settings panel may render. A handful of
 * schema-declared settings carry no `ui` and are config-file-only upstream, yet
 * still change what OMP does (which foreign tools' `~/` skill directories it
 * loads, for one), and Cody has to mirror those decisions rather than render
 * them. `undefined` means the key is absent, so OMP's own default applies — the
 * caller owns that default, because the schema view never publishes it. A file
 * that cannot be read or parsed reads as absent too: these are best-effort
 * lookups feeding behaviour, not an editor that must report the failure.
 */
function readPersisted(key: string): unknown {
  try {
    const { doc } = readDocument();
    const data = doc.toJS() as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    return resolvePath(data as Record<string, unknown>, key);
  } catch {
    return undefined;
  }
}

export function readPersistedBoolean(key: string): boolean | undefined {
  const raw = readPersisted(key);
  return typeof raw === "boolean" ? raw : undefined;
}

export function readPersistedStringList(key: string): string[] | undefined {
  const raw = readPersisted(key);
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/** Built-in context file names, lower-cased. Listing one in `contextFiles.extra`
 * would load a second copy or bypass one-per-depth shadowing. Mirrors omp's
 * session/context-settings.ts (18.17+). */
const BUILTIN_CONTEXT_FILE_NAMES: Record<string, true> = {
  "agents.md": true,
  "claude.md": true,
  "gemini.md": true,
  "copilot-instructions.md": true,
};

/** Why `entry` is not a valid `contextFiles.extra` name, in omp's own words;
 * undefined for a plain, non-built-in file name. The engine rejects a bad entry
 * when the session starts, so catching it here keeps a broken list out of
 * config.yml instead of failing every chat that follows. */
function contextFileNameError(entry: string): string | undefined {
  const name = entry.trim();
  if (name === "") return "contextFiles.extra entries must not be empty";
  if (BUILTIN_CONTEXT_FILE_NAMES[name.toLowerCase()] === true) return `contextFiles.extra cannot list a built-in context file (${name})`;
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return `contextFiles.extra entries must be file names, not paths (${name})`;
  }
  return undefined;
}

/** Validate one patch entry against its schema definition. `null` resets the
 * setting to OMP's default by removing the key. */
function validate(setting: OmpSetting, value: unknown): OmpSettingValue | null {
  if (value === null) return null;
  switch (setting.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${setting.key} must be a boolean`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${setting.key} must be a number`);
      return value;
    case "enum": {
      if (typeof value !== "string") throw new Error(`${setting.key} must be a string`);
      const allowed = allowedValues(setting);
      if (allowed && !allowed.has(value)) throw new Error(`${setting.key} must be one of: ${[...allowed].join(", ")}`);
      return value;
    }
    case "string":
      if (typeof value !== "string") throw new Error(`${setting.key} must be a string`);
      return value;
    case "array":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${setting.key} must be a list of strings`);
      if (setting.key === "contextFiles.extra") {
        for (const entry of value as string[]) {
          const problem = contextFileNameError(entry);
          if (problem) throw new Error(problem);
        }
        return (value as string[]).map((entry) => entry.trim());
      }
      return value as string[];
  }
}

/** Remove a key and any mapping ancestors it just emptied, so resetting the
 * last setting under `prewalk` does not leave `prewalk: {}` behind. */
function deleteIn(doc: ReturnType<typeof readDocument>["doc"], key: string): void {
  // deleteIn throws on an empty document rather than reporting a miss.
  if (doc.contents === null) return;
  const segments = key.split(".");
  doc.deleteIn([key]);
  doc.deleteIn(segments);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const parentPath = segments.slice(0, depth);
    const parent = doc.getIn(parentPath, true);
    if (!isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(parentPath);
  }
}

/**
 * Apply a patch of dotted-path → value against OMP's settings file. Unknown
 * keys are rejected rather than written: the schema is the contract, and a
 * typo'd path would otherwise sit in the file forever doing nothing.
 * Returns the keys that were written or reset.
 */
export function writeSchemaSettings(patch: Record<string, unknown>): string[] {
  const schema = getOmpSettingsSchema();
  if (!schema) throw new Error("OMP's settings schema is unavailable, so settings cannot be written");
  const byKey = new Map(schema.settings.map((setting) => [setting.key, setting]));

  const resolved: Array<[string, OmpSettingValue | null]> = [];
  for (const [key, value] of Object.entries(patch)) {
    const setting = byKey.get(key);
    if (!setting) throw new Error(`Unknown setting: ${key}`);
    resolved.push([key, validate(setting, value)]);
  }
  if (resolved.length === 0) return [];

  const { path, doc } = readDocument();
  // An empty settings file parses to null contents, which setIn fills in for
  // us; anything else that is not a mapping is not OMP's settings file.
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  // Saving a per-window auto-redeem key while the legacy single key is still in
  // the file: write BOTH windows out with what the engine already treats as
  // their value, and drop the legacy key, in this same write. Left alone the
  // untouched window would silently fall back to "unset" the moment omp
  // rewrites the file itself.
  const legacyGroups: string[] = [];
  if (doc.contents !== null) {
    const schemaKeys = new Set(byKey.keys());
    const current = doc.toJS() as unknown;
    for (const plan of planLegacyAutoRedeem(isPlainRecord(current) ? current : {}, schemaKeys)) {
      const touched = Object.keys(patch).some((key) => key.startsWith(`${plan.group}.autoRedeem`) && key !== `${plan.group}.autoRedeem`);
      if (!touched) continue;
      legacyGroups.push(plan.group);
      const mode = typeof plan.mode === "string" && AUTO_REDEEM_MODES.has(plan.mode) ? plan.mode : "unset";
      for (const key of plan.fill) {
        doc.deleteIn([`${plan.group}.${key}`]);
        doc.setIn([plan.group, key], mode);
      }
    }
  }
  for (const [key, value] of resolved) {
    if (value === null) deleteIn(doc, key);
    else {
      // Drop any legacy flat form so the nested write is the only source.
      if (doc.contents !== null) doc.deleteIn([key]);
      doc.setIn(key.split("."), value);
    }
  }
  for (const group of legacyGroups) deleteIn(doc, `${group}.autoRedeem`);

  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, doc.toString(), "utf8");
  renameSync(temp, path);
  return resolved.map(([key]) => key);
}
