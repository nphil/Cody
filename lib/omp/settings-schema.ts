import fs from "fs";
import path from "path";
import { findOmpPackageRoot, loadOmpPackageSource, ompPackageVersion } from "./package-source";
import { isTerminalOnlySetting } from "./settings-surface";

/**
 * Cody renders OMP's settings from OMP's own schema rather than a hand-kept
 * list, so a setting added upstream shows up here — in its declared tab and
 * group, with its declared label — without a code change on this side.
 *
 * OMP exposes no settings-schema RPC command (checked against the RPC command
 * union), so the schema is read from the installed package's source:
 * `<package>/src/config/settings-schema.ts`, which ships in the npm tarball.
 *
 * That file imports Bun-only siblings which cannot load under Node, so it is
 * evaluated through ./package-source, which stubs every import. Only the `ui`
 * metadata matters here: values derived from those imports (some `default`s and
 * `options`) come out as stub objects and are discarded by normalization, while
 * labels, tabs and groups are plain literals and survive intact.
 */

/** Types Cody can render. OMP's `record` settings are structured maps with
 * bespoke editors upstream; Cody surfaces the ones that matter (tool approval,
 * retry fallback chains) through its own curated controls instead. */
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
  default?: boolean | number | string;
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

/** The installed omp package's CHANGELOG.md, when the package ships one
 * (it is in omp's npm `files` list; a future omp dropping it fails soft). */
export function getOmpChangelogPath(): string | null {
  const root = findOmpPackageRoot();
  if (!root) return null;
  const file = path.join(root, "CHANGELOG.md");
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

function isPlainValue(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

/** Options survive only when they are real literals; anything derived from a
 * stubbed import is dropped rather than rendered as garbage. */
function normalizeOptions(raw: unknown): OmpSettingOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw.flatMap((entry): OmpSettingOption[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { value, label, description } = entry as Record<string, unknown>;
    if (typeof value !== "string" || typeof label !== "string") return [];
    return [{ value, label, ...(typeof description === "string" ? { description } : {}) }];
  });
  return options.length > 0 ? options : undefined;
}

function normalizeValues(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
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
    // A credential must never reach the browser, even masked.
    if (definition.credential === true) continue;
    const ui = definition.ui;
    // No ui metadata means OMP itself does not surface it — config-file only.
    if (typeof ui !== "object" || ui === null) continue;
    const uiMeta = ui as Record<string, unknown>;
    const tab = uiMeta.tab;
    const label = uiMeta.label;
    if (typeof tab !== "string" || typeof label !== "string") continue;
    const type = definition.type;
    if (type !== "boolean" && type !== "enum" && type !== "number" && type !== "string" && type !== "array") continue;
    if (uiMeta.secret === true) continue;
    // An enum with no usable values and no options has nothing to choose from.
    const values = normalizeValues(definition.values);
    const options = normalizeOptions(uiMeta.options);
    if (type === "enum" && !values && !options) continue;

    settings.push({
      key,
      type,
      tab,
      ...(typeof uiMeta.group === "string" ? { group: uiMeta.group } : {}),
      label,
      ...(typeof uiMeta.description === "string" ? { description: uiMeta.description } : {}),
      ...(values ? { values } : {}),
      ...(options ? { options } : {}),
      ...(isPlainValue(definition.default) ? { default: definition.default } : {}),
      ...(uiMeta.options === "runtime" ? { runtimeOptions: true } : {}),
      ...(uiMeta.ordered === true ? { ordered: true } : {}),
      ...(typeof uiMeta.condition === "string" ? { condition: uiMeta.condition } : {}),
      ...(isTerminalOnlySetting(key) ? { terminalOnly: true } : {}),
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
  const packageRoot = findOmpPackageRoot();
  if (!packageRoot) return null;
  const version = ompPackageVersion(packageRoot);
  const cacheKey = `${packageRoot}@${version ?? "unknown"}`;
  if (cached?.key === cacheKey) return cached.schema;

  let schema: OmpSettingsSchema | null = null;
  try {
    const loaded = loadOmpPackageSource(packageRoot, "src", "config", "settings-schema.ts");
    // A failure here (new upstream layout, transpile error, evaluation throw)
    // leaves the hand-written controls in charge instead of an empty panel.
    if (loaded) schema = normalize(loaded, { packagePath: packageRoot, version });
  } catch {
    schema = null;
  }

  cached = { key: cacheKey, schema };
  return schema;
}

/** Drop the memoized schema so the next read re-evaluates the package. */
export function clearOmpSettingsSchemaCache(): void {
  cached = null;
}
