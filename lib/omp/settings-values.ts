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

/** Every schema-declared setting currently persisted in OMP's settings file. */
export function readSchemaSettings(): OmpSettingsSnapshot {
  const schema = getOmpSettingsSchema();
  const { path, doc } = readDocument();
  const values: Record<string, OmpSettingValue> = {};
  if (!schema) return { path, schema, values };
  const data = doc.toJS() as unknown;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { path, schema, values };
  for (const setting of schema.settings) {
    const raw = resolvePath(data as Record<string, unknown>, setting.key);
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
  for (const [key, value] of resolved) {
    if (value === null) deleteIn(doc, key);
    else {
      // Drop any legacy flat form so the nested write is the only source.
      if (doc.contents !== null) doc.deleteIn([key]);
      doc.setIn(key.split("."), value);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, doc.toString(), "utf8");
  renameSync(temp, path);
  return resolved.map(([key]) => key);
}
