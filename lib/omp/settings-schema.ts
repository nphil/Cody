import fs from "fs";
import path from "path";
import { findOmpPackageRoot, loadOmpPackageSource, loadOmpRegistrySettings, ompPackageVersion } from "./package-source";
import { isTerminalOnlySetting, settingNoteFor } from "./settings-surface";

/**
 * Cody reads settings from the installed OMP package rather than a hand-kept
 * list. OMP 18.2 ships a flat schema module; 18.3 registers settings by domain
 * and exposes the display order through its registry aggregator.
 *
 * The package source imports Bun-only runtime siblings, so the source loader
 * stubs unrelated imports while preserving the shared settings registry and
 * the tab metadata. Values that depend on stubbed imports are discarded by
 * normalization; UI labels and choices remain real package data.
 */

/** Record settings use their dedicated controls and stay out of the generic
 * settings list, avoiding a second editor for the same value. */
export type OmpSettingType = "boolean" | "enum" | "number" | "string" | "array";

export interface OmpSettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface OmpSetting {
  /** Dotted config path, e.g. "prewalk.enabled". */
  key: string;
  type: OmpSettingType;
  tab: string;
  /** Section within the tab; undefined settings render above the first heading. */
  group?: string;
  label: string;
  description?: string;
  /** Enum values when the schema declares them without explicit options. */
  values?: string[];
  options?: OmpSettingOption[];
  /** JSON-safe default; omitted when the schema computes it from an import. */
  default?: boolean | number | string | string[];
  /** OMP populates the choices from a runtime registry (its TUI theme list).
   * Cody has no equivalent registry, so those render as a free text field. */
  runtimeOptions?: boolean;
  /** The engine can SHOW this setting but not accept a write for it. The panel
   * renders the real value and disables editing, because offering a control
   * whose save always fails is worse than not offering one. */
  readOnly?: boolean;
  /** One clause saying why, shown with the setting. */
  readOnlyReason?: string;
  /** Array settings whose element order is meaningful upstream. */
  ordered?: boolean;
  /** Name of the OMP predicate gating visibility; see SETTING_CONDITIONS. */
  condition?: string;
  /** Configures the harness's terminal UI only, so changing it does nothing
   * while working in Cody. See ./settings-surface.ts. */
  terminalOnly?: boolean;
  /** A Cody-specific caveat: the engine behaves differently when driven over
   * RPC than it does from its own terminal. See ./settings-surface.ts. */
  codyNote?: string;
}

export interface OmpSettingsSchema {
  /** Tabs in OMP's declared order, with its own labels. */
  tabs: Array<{ id: string; label: string }>;
  /** Section order per tab, straight from TAB_GROUPS. */
  groups: Record<string, string[]>;
  settings: OmpSetting[];
  /** Which omp package the schema came from, for diagnostics. */
  source: { packagePath: string; version: string | null };
}

export function getOmpPackageRoot(): string | null {
  return findOmpPackageRoot();
}

/** The installed omp package's CHANGELOG.md, when the package ships one
 * (it is in omp's npm `files` list; a future omp dropping it fails soft). */
export function getOmpChangelogPath(): string | null {
  const root = getOmpPackageRoot();
  if (!root) return null;
  const file = path.join(root, "CHANGELOG.md");
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}


function isSettingDefault(value: unknown): value is boolean | number | string | string[] {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const CODY_UI_OVERRIDES: Record<string, Record<string, unknown>> = {
  "providers.anthropic.slowMode": {
    tab: "providers",
    group: "Anthropic",
    label: "Anthropic Slow Mode",
    description: "Allow Anthropic subscription requests to use the low-priority lane.",
  },
};

/** Options survive only when they are real literals; anything derived from a
 * stubbed import is dropped rather than rendered as garbage. A NUMBER setting
 * may offer a word choice meaning "use the built-in default" (omp 18.3's
 * compaction thresholds offer "default", whose stored value is -1): it is
 * rewritten to that numeric default so a picked option is always writable. */
function normalizeOptions(raw: unknown, numericDefault?: number): OmpSettingOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw.flatMap((entry): OmpSettingOption[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { value, label, description } = entry as Record<string, unknown>;
    if (typeof value !== "string" || typeof label !== "string") return [];
    const numericValue = numericDefault !== undefined && !Number.isFinite(Number(value)) ? String(numericDefault) : value;
    return [{ value: numericValue, label, ...(typeof description === "string" ? { description } : {}) }];
  });
  return options.length > 0 ? options : undefined;
}

function normalizeValues(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}

/** One text field of a setting's `ui` block. Several are GETTERS in omp 18.3
 *  (a description that formats a key hint), and their imports are stubbed
 *  when Cody loads the source, so reading one can throw. One bad getter must
 *  cost that field, never the whole schema: an uncaught throw here once
 *  blanked the entire settings panel. */
function readText(meta: Record<string, unknown>, field: string): string | undefined {
  try {
    const value = meta[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalize(schemaModule: Record<string, unknown>, source: OmpSettingsSchema["source"]): OmpSettingsSchema | null {
  const rawSchema = schemaModule.SETTINGS_SCHEMA;
  if (typeof rawSchema !== "object" || rawSchema === null) return null;

  const tabOrder = Array.isArray(schemaModule.SETTING_TABS)
    ? schemaModule.SETTING_TABS.filter((tab): tab is string => typeof tab === "string")
    : [];
  const tabMetadata = (typeof schemaModule.TAB_METADATA === "object" && schemaModule.TAB_METADATA !== null
    ? schemaModule.TAB_METADATA
    : {}) as Record<string, { label?: unknown }>;
  const rawGroups = (typeof schemaModule.TAB_GROUPS === "object" && schemaModule.TAB_GROUPS !== null
    ? schemaModule.TAB_GROUPS
    : {}) as Record<string, unknown>;

  const settings: OmpSetting[] = [];
  for (const [key, entry] of Object.entries(rawSchema as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const definition = entry as Record<string, unknown>;
    if (definition.credential === true) continue;
    const ui = definition.ui ?? CODY_UI_OVERRIDES[key];
    // No ui metadata means OMP itself does not surface it, except for the one
    // known provider preference omitted from its panel despite being supported.
    if (typeof ui !== "object" || ui === null) continue;
    const uiMeta = ui as Record<string, unknown>;
    const tab = readText(uiMeta, "tab");
    const label = readText(uiMeta, "label");
    if (tab === undefined || label === undefined) continue;
    const type = definition.type;
    if (type !== "boolean" && type !== "enum" && type !== "number" && type !== "string" && type !== "array") continue;
    if (uiMeta.secret === true) continue;
    const values = normalizeValues(definition.values);
    const options = normalizeOptions(uiMeta.options, type === "number" && typeof definition.default === "number" ? definition.default : undefined);
    if (type === "enum" && !values && !options) continue;
    const group = readText(uiMeta, "group");
    const description = readText(uiMeta, "description");

    settings.push({
      key,
      type,
      tab,
      ...(group !== undefined ? { group } : {}),
      label,
      ...(description !== undefined ? { description } : {}),
      ...(values ? { values } : {}),
      ...(options ? { options } : {}),
      ...(isSettingDefault(definition.default) ? { default: definition.default } : {}),
      ...(uiMeta.options === "runtime" ? { runtimeOptions: true } : {}),
      ...(uiMeta.ordered === true ? { ordered: true } : {}),
      ...(typeof uiMeta.condition === "string" ? { condition: uiMeta.condition } : {}),
      ...(isTerminalOnlySetting(key) ? { terminalOnly: true } : {}),
      ...(settingNoteFor(key) ? { codyNote: settingNoteFor(key) } : {}),
    });
  }
  if (settings.length === 0) return null;

  const presentTabs = new Set(settings.map((setting) => setting.tab));
  const ordered = tabOrder.filter((tab) => presentTabs.has(tab));
  for (const tab of presentTabs) if (!ordered.includes(tab)) ordered.push(tab);

  const groups: Record<string, string[]> = {};
  for (const tab of ordered) {
    const declared = Array.isArray(rawGroups[tab])
      ? (rawGroups[tab] as unknown[]).filter((group): group is string => typeof group === "string")
      : [];
    const used = new Set(settings.filter((setting) => setting.tab === tab && setting.group).map((setting) => setting.group as string));
    groups[tab] = [...declared.filter((group) => used.has(group)), ...[...used].filter((group) => !declared.includes(group))];
  }

  return {
    tabs: ordered.map((id) => ({
      id,
      label: typeof tabMetadata[id]?.label === "string" ? String(tabMetadata[id].label) : id,
    })),
    groups,
    settings,
    source,
  };
}
let cached: { key: string; schema: OmpSettingsSchema | null } | null = null;

/**
 * The installed OMP's settings schema, or null when it cannot be read (omp not
 * installed, an older layout without the source file, or a load failure). The
 * caller falls back to Cody's own controls, so a null here degrades the
 * settings UI rather than breaking it. Cached per package path + version.
 */
export function getOmpSettingsSchema(): OmpSettingsSchema | null {
  const packageRoot = getOmpPackageRoot();
  if (!packageRoot) return null;
  const version = ompPackageVersion(packageRoot);
  const cacheKey = `${packageRoot}@${version ?? "unknown"}`;
  if (cached?.key === cacheKey) return cached.schema;

  let schema: OmpSettingsSchema | null = null;
  try {
    // OMP 18.2 shipped one flat schema module. 18.3 registers settings by
    // domain, so load its registry aggregate only when the legacy entrypoint is
    // absent; this keeps the supported older engine path intact.
    const legacy = loadOmpPackageSource(packageRoot, "src", "config", "settings-schema.ts");
    if (legacy) {
      schema = normalize(legacy, { packagePath: packageRoot, version });
    } else {
      const loaded = loadOmpRegistrySettings(packageRoot);
      if (loaded.definitions && loaded.ui) {
        const entries = Object.fromEntries(loaded.definitions.flatMap((definition) =>
          typeof definition.id === "string" ? [[definition.id, definition]] : [],
        ));
        schema = normalize({ ...loaded.ui, SETTINGS_SCHEMA: entries }, { packagePath: packageRoot, version });
      }
    }
  } catch {
    schema = null;
  }
  cached = { key: cacheKey, schema };
  return schema;
}

export function clearOmpSettingsSchemaCache(): void {
  cached = null;
}
