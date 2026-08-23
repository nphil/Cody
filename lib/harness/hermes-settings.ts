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
 * default (76 sections, ~550 leaves). Reading THAT keeps the same property:
 * Hermes gains a setting, Cody shows it.
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

export interface HermesSetting {
  key: string;
  type: HermesSettingType;
  tab: string;
  group?: string;
  label: string;
  default?: boolean | number | string;
}

export interface HermesSettingsSchema {
  tabs: Array<{ id: string; label: string }>;
  groups: Record<string, string[]>;
  settings: HermesSetting[];
  source: { packagePath: string; version: string | null };
}

/** Everything Hermes declares lands in one tab; its own top-level sections
 * become the groups, which is the only structure the data actually has. */
const TAB_ID = "hermes";

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

/** A default value decides the control, because it is the only type
 * information DEFAULT_CONFIG carries. Values Cody cannot render as a single
 * control (nested nulls, objects in arrays) are reported as strings rather
 * than dropped, so nothing silently disappears from the panel. */
export function settingTypeOf(value: unknown): HermesSettingType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  return "string";
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
      const type = settingTypeOf(value);
      settings.push({
        key: nextPath.join("."),
        type,
        tab: TAB_ID,
        group,
        label: humanizeKey(key),
        default: type === "array" ? JSON.stringify(value) : (value as boolean | number | string | null) ?? "",
      });
    }
  };

  for (const [section, value] of Object.entries(defaults)) {
    if (section.startsWith("_")) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      walk(value as Record<string, unknown>, [section], humanizeKey(section));
    } else {
      const type = settingTypeOf(value);
      settings.push({
        key: section,
        type,
        tab: TAB_ID,
        group: "General",
        label: humanizeKey(section),
        default: type === "array" ? JSON.stringify(value) : (value as boolean | number | string | null) ?? "",
      });
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

/** Values currently persisted in Hermes' own config.yaml, flattened to the
 * same dotted paths. Absent keys simply fall back to the schema default in
 * the panel, exactly as they do for omp. */
export function readHermesSettingsValues(hermesHome: string): Record<string, boolean | number | string> {
  const file = join(hermesHome, "config.yaml");
  const values: Record<string, boolean | number | string> = {};
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch {
    // No config yet is the normal state of a fresh install.
    return values;
  }
  if (!parsed || typeof parsed !== "object") return values;

  const walk = (node: Record<string, unknown>, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("_")) continue;
      const nextPath = [...path, key];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, nextPath);
      } else if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        values[nextPath.join(".")] = value;
      } else if (Array.isArray(value)) {
        values[nextPath.join(".")] = JSON.stringify(value);
      }
    }
  };
  walk(parsed as Record<string, unknown>, []);
  return values;
}

/**
 * Write one setting through Hermes' own CLI rather than editing its YAML.
 * `hermes config set` owns validation, type coercion and config migration —
 * writing the file directly would skip all three and can leave a config the
 * engine then refuses.
 */
export function writeHermesSetting(binaryPath: string, key: string, value: boolean | number | string): void {
  execFileSync(binaryPath, ["config", "set", key, String(value)], {
    encoding: "utf8",
    timeout: 30_000,
  });
}
