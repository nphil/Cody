import { execFileSync } from "child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";

/**
 * Hermes' settings, derived from Hermes.
 *
 * Cody's schema-driven settings tab renders whatever an engine declares, so
 * new upstream settings appear without a Cody release. omp supplies that by
 * shipping a TypeScript schema; Hermes has no schema, but it does have
 * `hermes_cli.config.DEFAULT_CONFIG` — a nested dict of every setting and its
 * default (75 sections, 553 leaves in 0.19.0). Reading THAT keeps the same
 * property: Hermes gains a setting, Cody shows it.
 *
 * It is Python, so it is read the way omp's is read through jiti — by asking
 * the engine's own runtime. `uv tool install` puts a venv beside the binary,
 * so the interpreter that can import Hermes sits next to the `hermes` symlink
 * target.
 *
 * DEFAULT_CONFIG carries no UI metadata (no labels, descriptions or tabs), so
 * this module derives what it honestly can — a label from the key, a control
 * from the default's TYPE — and invents nothing else. Everything lands in one
 * tab, grouped by Hermes' own top-level sections, which the existing panel
 * already renders and searches.
 */

export type HermesSettingType = "boolean" | "number" | "string" | "enum" | "array";

/** What a control can hold. A list is a real `string[]`: the panel's list
 * editor renders `Array.isArray(value) ? value : []`, so JSON text arrives
 * there as an empty list. */
export type HermesSettingValue = boolean | number | string | string[];

export interface HermesSetting {
  key: string;
  type: HermesSettingType;
  tab: string;
  group?: string;
  label: string;
  /** Absent for a leaf Hermes declares as `None`. That declares no value and
   * no type, so a stand-in like `""` would invent both. */
  default?: HermesSettingValue;
  /** Shown, but not editable — see LIST_WRITE_UNSUPPORTED. */
  readOnly?: boolean;
  readOnlyReason?: string;
}

export interface HermesSettingsSchema {
  tabs: Array<{ id: string; label: string }>;
  groups: Record<string, string[]>;
  settings: HermesSetting[];
  source: { packagePath: string; version: string | null };
}

export type HermesSettingsValues = Record<string, HermesSettingValue>;

/** Everything Hermes declares lands in one tab; its own top-level sections
 * become the groups, which is the only structure the data actually has. */
const TAB_ID = "hermes";

/**
 * Why a list setting is read-only here. `hermes config set` takes one scalar
 * and stores it verbatim: pointed at a list key it writes `toolsets: a,b`,
 * and Hermes then reads a string where it expects a list. 0.19.0 ships no
 * list form of the command (`hermes config set --help`, and `_set_nested`
 * refuses to grow lists), so Cody reports these keys as unwritable rather
 * than corrupting the config or claiming a save that never happened.
 */
export const LIST_WRITE_UNSUPPORTED =
  "Hermes' config CLI stores scalars only, so lists show here but cannot be saved from Cody";

/** Sections that configure something other than the coding agent. They are
 * still rendered — hiding an engine's real settings would be a lie — but they
 * sort last so the agent's own configuration leads. */
const TRAILING_SECTIONS = new Set([
  "gateway", "telegram", "discord", "slack", "whatsapp", "signal", "matrix",
  "mattermost", "email", "sms", "dingtalk", "feishu", "wecom", "bluebubbles",
  "homeassistant", "dashboard", "portal", "irc", "bots",
]);

/** The interpreter that can `import hermes_cli`. `uv tool install` places the
 * venv's bin dir as the symlink target of the installed executable, so the
 * python sits beside it. */
export function hermesPythonPath(binaryPath: string): string | null {
  try {
    const real = realpathSync(binaryPath);
    const candidate = join(dirname(real), process.platform === "win32" ? "python.exe" : "python");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** "show_reasoning" → "Show reasoning"; "api_key" → "API key". */
export function humanizeKey(key: string): string {
  const words = key.split(/[._]/).filter(Boolean);
  const label = words
    .map((word, index) => {
      const upper = word.toUpperCase();
      // Acronyms Hermes uses as bare keys read wrong in sentence case.
      if (["api", "url", "id", "ttl", "sms", "tts", "stt", "mcp", "acp", "cpu", "gpu", "ui"].includes(word)) return upper;
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
  return label;
}

function isScalar(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

/** A default value decides the control, because it is the only type
 * information DEFAULT_CONFIG carries. Values Cody cannot render as a single
 * control (nested nulls, objects in arrays — Hermes' `moa` reference models
 * are dicts) are reported as strings rather than dropped, so nothing silently
 * disappears from the panel. */
export function settingTypeOf(value: unknown): HermesSettingType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  // The list editor has one line per entry and no form for a dict, so only a
  // list of scalars can actually be rendered as one.
  if (Array.isArray(value)) return value.every(isScalar) ? "array" : "string";
  return "string";
}

/**
 * A raw config value in the shape the control for `type` renders, or
 * undefined when it has none — the panel then falls back to the setting's
 * default rather than showing an empty box that misreports what is in effect.
 *
 * The text case converts rather than rejects on purpose. `hermes config set`
 * coerces on write (`"4"` becomes the int 4 whenever the key's default is not
 * a string), so the five leaves Hermes declares as `None` — typeless, hence
 * rendered as text — come back holding a number, and a text input shows a
 * number as nothing at all. The file keeps the number; only what the panel
 * displays is derived, and it is written back as text the CLI re-coerces.
 */
function asControlValue(type: HermesSettingType, raw: unknown): HermesSettingValue | undefined {
  switch (type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "array":
      return Array.isArray(raw) && raw.every(isScalar) ? raw.map(String) : undefined;
    default:
      if (isScalar(raw)) return String(raw);
      return Array.isArray(raw) ? JSON.stringify(raw) : undefined;
  }
}

/** One leaf of DEFAULT_CONFIG as a setting the panel can render. */
function describeLeaf(path: string[], group: string, value: unknown): HermesSetting {
  const type = settingTypeOf(value);
  return {
    key: path.join("."),
    type,
    tab: TAB_ID,
    group,
    label: humanizeKey(path[path.length - 1]),
    default: asControlValue(type, value),
    // A list is still worth SHOWING — the user needs to see what Hermes is
    // configured with — but its write would be refused, and an editable
    // control whose save always fails is a worse answer than an honest
    // read-only row.
    ...(type === "array" ? { readOnly: true, readOnlyReason: LIST_WRITE_UNSUPPORTED } : {}),
  };
}

/** Flatten Hermes' nested defaults into the flat, dotted-path settings list
 * the panel renders. */
export function flattenHermesDefaults(defaults: Record<string, unknown>): HermesSetting[] {
  const settings: HermesSetting[] = [];

  const walk = (node: Record<string, unknown>, path: string[], group: string): void => {
    for (const [key, value] of Object.entries(node)) {
      // Hermes stamps its own bookkeeping into the config; it is not a setting.
      if (key.startsWith("_")) continue;
      const nextPath = [...path, key];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, nextPath, group);
        continue;
      }
      settings.push(describeLeaf(nextPath, group, value));
    }
  };

  for (const [section, value] of Object.entries(defaults)) {
    if (section.startsWith("_")) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      walk(value as Record<string, unknown>, [section], humanizeKey(section));
    } else {
      settings.push(describeLeaf([section], "General", value));
    }
  }
  return settings;
}

/** Group order: the agent's own sections first, platform plumbing last, each
 * alphabetical. */
export function orderGroups(settings: HermesSetting[]): string[] {
  const groups = [...new Set(settings.map((setting) => setting.group ?? ""))].filter(Boolean);
  const trailing = (group: string) => TRAILING_SECTIONS.has(group.toLowerCase().replace(/\s+/g, ""));
  return groups.sort((a, b) => {
    const byBucket = Number(trailing(a)) - Number(trailing(b));
    return byBucket !== 0 ? byBucket : a.localeCompare(b);
  });
}

let cached: { schema: HermesSettingsSchema; binary: string; stamp: string } | null = null;

/**
 * Identifies the installed Hermes, not just its path. `uv tool install
 * --force` rebuilds the venv in place, so the binary path is unchanged across
 * an upgrade; without this the memo would keep serving the OLD version's
 * settings until Cody restarted. The venv dir and its pyvenv.cfg are both
 * rewritten by an install, so their mtimes date the installation.
 */
function installStamp(python: string): string {
  const venv = dirname(dirname(python));
  const at = (file: string) => {
    try { return String(statSync(file).mtimeMs); } catch { return "0"; }
  };
  return `${at(venv)}:${at(join(venv, "pyvenv.cfg"))}`;
}

/**
 * Hermes' declared settings, or null when they cannot be read (Hermes came
 * from a PATH install with no adjacent venv, the import failed). Null makes
 * the panel say the schema is unavailable, which is honest; a fabricated
 * schema would offer settings that write nowhere.
 */
export function getHermesSettingsSchema(binaryPath: string): HermesSettingsSchema | null {
  const python = hermesPythonPath(binaryPath);
  if (!python) return null;
  const stamp = installStamp(python);
  if (cached && cached.binary === binaryPath && cached.stamp === stamp) return cached.schema;
  try {
    const stdout = execFileSync(
      python,
      ["-c", "import json,hermes_cli.config as c; print(json.dumps(c.DEFAULT_CONFIG, default=str))"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const defaults = JSON.parse(stdout) as Record<string, unknown>;
    const settings = flattenHermesDefaults(defaults);
    const schema: HermesSettingsSchema = {
      tabs: [{ id: TAB_ID, label: "Hermes" }],
      groups: { [TAB_ID]: orderGroups(settings) },
      settings,
      source: { packagePath: dirname(dirname(python)), version: null },
    };
    cached = { schema, binary: binaryPath, stamp };
    return schema;
  } catch {
    return null;
  }
}

/** Resolve a dotted path against the parsed config. `hermes config set`
 * stores dotted keys nested, so segments map straight onto YAML nodes. */
function resolvePath(data: Record<string, unknown>, key: string): unknown {
  let current: unknown = data;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Values currently persisted in Hermes' own config.yaml, keyed by the same
 * dotted paths and shaped for the control that renders each one. Absent keys
 * simply fall back to the schema default in the panel, exactly as they do for
 * omp; a stored value the control cannot show is dropped for the same reason,
 * rather than rendering as an empty box.
 */
export function readHermesSettingsValues(hermesHome: string, settings: HermesSetting[]): HermesSettingsValues {
  const values: HermesSettingsValues = {};
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(join(hermesHome, "config.yaml"), "utf8"));
  } catch {
    // No config yet is the normal state of a fresh install.
    return values;
  }
  if (!parsed || typeof parsed !== "object") return values;

  for (const setting of settings) {
    const raw = resolvePath(parsed as Record<string, unknown>, setting.key);
    if (raw === undefined || raw === null) continue;
    const value = asControlValue(setting.type, raw);
    if (value !== undefined) values[setting.key] = value;
  }
  return values;
}

/**
 * Run one `hermes config` subcommand, raising the CLI's own stderr as the
 * error. The panel prints that text, and Node's bare "Command failed" says
 * nothing about why Hermes refused the write — a managed key, an unreadable
 * config. stderr has to be piped to be readable at all; execFileSync
 * otherwise forwards it to Cody's stderr and leaves `error.stderr` null.
 */
function runHermesConfig(binaryPath: string, args: string[]): void {
  try {
    execFileSync(binaryPath, ["config", ...args], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(detail || (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Write one setting through Hermes' own CLI rather than editing its YAML.
 * `hermes config set` owns validation, type coercion and config migration —
 * writing the file directly would skip all three and can leave a config the
 * engine then refuses.
 */
export function writeHermesSetting(binaryPath: string, key: string, value: boolean | number | string): void {
  runHermesConfig(binaryPath, ["set", key, String(value)]);
}

/**
 * Drop a user override so the setting falls back to Hermes' own default —
 * what the panel's Reset asks for, sent as a `null` patch entry.
 *
 * `hermes config unset` exits 1 with "Config key not set" for a key that was
 * never overridden. That is already the state the reset asked for, so it
 * counts as done; every other failure still surfaces.
 */
export function resetHermesSetting(binaryPath: string, key: string): void {
  try {
    runHermesConfig(binaryPath, ["unset", key]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/config key not set/i.test(message)) throw error;
  }
}
