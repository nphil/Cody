import fs from "fs";
import os from "os";
import path from "path";
import { createJiti } from "jiti";
import { resolveOmpBin } from "./omp-cli";
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
 * That file imports Bun-only siblings (@oh-my-pi/*, ../live/voices, …) which
 * cannot load under Node. Only the `ui` metadata matters here, so every import
 * is aliased to a permissive stub and the module is transpiled by jiti. Values
 * derived from those imports (some `default`s and `options`) come out as stub
 * objects and are discarded by normalization — labels, tabs and groups are
 * plain literals and survive intact.
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

const STUB_FILENAME = "cody-omp-schema-stub.cjs";

/** A module whose every export is callable, indexable and iterable — enough to
 * let the schema's top-level expressions evaluate. `then` must stay undefined:
 * a thenable here would make any await on the module hang forever. */
const STUB_SOURCE = `
function makeAny() {
  const fn = function () { return makeAny(); };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then" || prop === "constructor" || prop === "__esModule") return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "length") return 0;
      if (prop === "map" || prop === "filter" || prop === "slice") return () => [];
      return makeAny();
    },
    apply() { return makeAny(); },
  });
}
module.exports = makeAny();
`;

/** Walk up from the omp binary to the package root that owns it. */
function findOmpPackageRoot(): string | null {
  const bin = resolveOmpBin();
  if (!bin) return null;
  let current: string;
  try {
    current = fs.realpathSync(bin);
  } catch {
    current = bin;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    current = path.dirname(current);
    if (current === path.dirname(current)) break;
    const manifest = path.join(current, "package.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.includes("pi-coding-agent")) return current;
    } catch {
      // Unreadable manifest: keep walking.
    }
  }
  return null;
}

function schemaFilePath(packageRoot: string): string | null {
  const candidate = path.join(packageRoot, "src", "config", "settings-schema.ts");
  return fs.existsSync(candidate) ? candidate : null;
}

function packageVersion(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
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
  const version = packageVersion(packageRoot);
  const cacheKey = `${packageRoot}@${version ?? "unknown"}`;
  if (cached?.key === cacheKey) return cached.schema;

  let schema: OmpSettingsSchema | null = null;
  try {
    const file = schemaFilePath(packageRoot);
    if (file) {
      const source = fs.readFileSync(file, "utf8");
      const imports = [...source.matchAll(/^import\s+[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
      const stubPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cody-omp-schema-")), STUB_FILENAME);
      fs.writeFileSync(stubPath, STUB_SOURCE, "utf8");
      const alias = Object.fromEntries(imports.map((specifier) => [specifier, stubPath]));
      const jiti = createJiti(__filename, { alias, interopDefault: true, moduleCache: false });
      const loaded = jiti(file) as Record<string, unknown>;
      schema = normalize(loaded, { packagePath: packageRoot, version });
      try {
        fs.rmSync(path.dirname(stubPath), { recursive: true, force: true });
      } catch {
        // Temp dir cleanup is best effort.
      }
    }
  } catch {
    // Any failure (new upstream layout, transpile error, evaluation throw)
    // leaves the hand-written controls in charge instead of an empty panel.
    schema = null;
  }

  cached = { key: cacheKey, schema };
  return schema;
}

/** Drop the memoized schema so the next read re-evaluates the package. */
export function clearOmpSettingsSchemaCache(): void {
  cached = null;
}
