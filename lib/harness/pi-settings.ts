import { existsSync, chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import type {
  EngineSetting,
  EngineSettingValue,
  EngineSettingsRead,
  EngineSettingsSchema,
  EngineSettingsWrite,
} from "./types";

/**
 * Pi's settings, derived from Pi.
 *
 * Cody's settings tab is schema-driven — it renders whatever the active engine
 * declares — so the question for each engine is only "where does it declare
 * its settings?". omp ships a TypeScript schema; Hermes has DEFAULT_CONFIG;
 * pi has neither. What pi DOES ship, in the npm tarball, is
 * `docs/settings.md`: every setting with its type, its default and a sentence
 * of description, in regular four-column markdown tables under `###` section
 * headings.
 *
 * Parsing that at RUNTIME, from the installed package, is what keeps the
 * house rule intact: a setting pi adds upstream appears in Cody's panel the
 * moment the user updates pi, with no Cody release. The machine-readable
 * alternative — `dist/core/settings-manager.js` — carries the same defaults
 * in imperative code with no types, descriptions or grouping at all, so it
 * would buy a hand-written key list dressed up as a pipeline. The docs are
 * the only place pi states the whole surface.
 *
 * The cost is that the source is prose, so every step fails soft: an
 * unparseable table row is skipped, a missing file answers `schema: null`
 * with a reason, and a documented type Cody cannot render as one control
 * (`object`, a bare `array` whose entries may be objects) is left out rather
 * than rendered as a control that would corrupt it on save.
 *
 * Scope: Cody's panel is global-only, so this reads and writes
 * `<piAgentDir>/settings.json`. Pi also merges a project `.pi/settings.json`
 * over it; that file belongs to the repo, not to the instance, and is left
 * alone.
 */

/** One tab, pi's own doc sections as the groups — the only structure the
 * source actually has. */
const TAB_ID = "pi";
const TAB_LABEL = "Pi";

/** The settings file this module reads and writes. */
export function piSettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

/**
 * Settings that only configure pi's TERMINAL UI, so flipping one changes
 * nothing in a browser. The panel labels them rather than hiding them,
 * because the same file drives the `pi` a user runs in a Cody terminal.
 *
 * This is Cody's own judgement (the docs carry no such metadata) and the
 * pi-side twin of lib/omp/settings-surface.ts — deliberately conservative,
 * and deliberately NOT shared with it: the two engines' key names only
 * partly overlap, and a shared list would silently mislabel whichever one
 * renamed a key first. Anything ambiguous (telemetry, image handling that
 * reaches the model) is left unmarked.
 */
const TERMINAL_ONLY_KEYS = new Set([
  // Chrome pi draws in its own TUI and Cody draws itself.
  "theme",
  "quietStartup",
  "collapseChangelog",
  "showHardwareCursor",
  "editorPaddingX",
  "autocompleteMaxVisible",
  "doubleEscapeAction",
  "treeFilterMode",
  // Thinking blocks reach Cody over RPC unchanged; this hides them in pi's
  // own transcript only.
  "hideThinkingBlock",
  // Input handling belongs to the TUI composer; Cody has its own.
  "steeringMode",
  "followUpMode",
  // Inline terminal image rendering.
  "terminal.showImages",
  "terminal.imageWidthCells",
  "terminal.clearOnShrink",
  // pi's own markdown renderer; Cody renders markdown in the browser.
  "markdown.codeBlockIndent",
]);

/** The rules themselves, for the test that keeps them honest. */
export const PI_TERMINAL_ONLY_KEYS: readonly string[] = [...TERMINAL_ONLY_KEYS];

/**
 * Settings whose NAME says they hold a credential (an API key, a token, a
 * secret, a password). pi documents none today, but a future row would
 * otherwise be printed in clear: a matching STRING setting is flagged
 * `secret`, the schema route sends only whether it is set, and the row
 * renders write-only. The twin lives in ./hermes-settings.ts, deliberately
 * not shared, for the same reason the terminal-only lists are not.
 */
const SECRET_KEY_PATTERN = /(api_?key|token|secret|password)$/i;

export function isPiSecretKey(key: string, type: EngineSetting["type"]): boolean {
  return type === "string" && SECRET_KEY_PATTERN.test(key);
}

/**
 * Documented types Cody has no single control for. `object` is a nested map
 * (`thinkingBudgets`), and a bare `array` is pi's own name for a list whose
 * entries may be objects (`packages` accepts both a string and a
 * `{source, skills, extensions}` form). Rendering either through the list
 * editor would show `[object Object]` and destroy the entries on save, so
 * they are left out of the panel and edited in the file — which is what the
 * docs tell users to do for them anyway.
 */
const UNRENDERABLE_TYPES = new Set(["object", "array"]);

/** The documented type column mapped onto a control. Anything unrecognized
 * is skipped by the caller rather than guessed at. */
function controlTypeOf(documented: string): EngineSetting["type"] | null {
  switch (documented.trim().toLowerCase()) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "string[]":
      return "array";
    default:
      return null;
  }
}

/** Strip markdown emphasis/code fences from a cell so a `` `value` `` reads
 * as its value. */
function unwrapCell(cell: string): string {
  return cell.trim().replace(/^`+|`+$/g, "").trim();
}

/**
 * A documented default as a real value, or undefined when the docs state
 * none. `-` means "no default" and `SDK default` means "whatever the SDK
 * picks" — neither is a value, and inventing one (`""`, `0`) would tell the
 * user pi is configured with something it is not.
 */
function parseDefault(cell: string, type: EngineSetting["type"]): EngineSettingValue | undefined {
  const raw = cell.trim();
  if (!raw || raw === "-" || !raw.startsWith("`")) return undefined;
  // Keep the fenced text verbatim: `markdown.codeBlockIndent` defaults to two
  // significant spaces, which a trim would erase.
  const inner = raw.replace(/^`+/, "").replace(/`+$/, "");
  if (type === "boolean") {
    if (inner.trim() === "true") return true;
    if (inner.trim() === "false") return false;
    return undefined;
  }
  if (type === "number") {
    const parsed = Number(inner.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === "array") {
    try {
      const parsed = JSON.parse(inner.trim()) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed as string[];
    } catch {
      // Not JSON: the docs are describing the default in prose.
    }
    return undefined;
  }
  const quoted = /^"([\s\S]*)"$/.exec(inner);
  return quoted ? quoted[1] : undefined;
}

/**
 * Values a string setting accepts, when the description enumerates them.
 *
 * pi writes closed sets as a run of fenced, quoted literals
 * (`"all"` or `"one-at-a-time"`), which is worth rendering as a dropdown.
 * It writes OPEN sets the same way after an "e.g." or beside an "or custom",
 * and a dropdown there is a trap: `defaultProvider` lists two of the dozen
 * providers pi supports, and `theme` names two of a registry any package can
 * extend. A closed control over an open set makes valid values unreachable,
 * so those stay free text — the same call lib/omp/settings-schema.ts makes
 * for omp's runtime-populated theme list.
 */
const OPEN_SET_MARKERS = /\be\.g\.|\bfor example\b|\bor custom\b|\bsame format as\b|\bsuch as\b/i;

export function enumValuesFromDescription(description: string): string[] | undefined {
  if (OPEN_SET_MARKERS.test(description)) return undefined;
  const values = [...description.matchAll(/`"([^"`]*)"`/g)].map((match) => match[1]);
  const unique = [...new Set(values)];
  return unique.length >= 2 ? unique : undefined;
}

/** A row of a settings table, once its four cells are known. */
function describeRow(key: string, documentedType: string, defaultCell: string, description: string, group: string): EngineSetting | null {
  if (!key || UNRENDERABLE_TYPES.has(documentedType.trim().toLowerCase())) return null;
  const type = controlTypeOf(documentedType);
  if (!type) return null;

  const values = type === "string" ? enumValuesFromDescription(description) : undefined;
  const resolvedType: EngineSetting["type"] = values ? "enum" : type;
  const parsedDefault = parseDefault(defaultCell, type);
  // The enum extraction above needs the code fences; the panel renders the
  // description as plain text, where a stray backtick is just noise.
  const prose = description.replace(/`/g, "").trim();

  return {
    key,
    type: resolvedType,
    tab: TAB_ID,
    group,
    label: humanizeKey(key),
    ...(prose ? { description: prose } : {}),
    ...(values ? { values } : {}),
    ...(parsedDefault !== undefined ? { default: parsedDefault } : {}),
    ...(TERMINAL_ONLY_KEYS.has(key) ? { terminalOnly: true } : {}),
    ...(isPiSecretKey(key, resolvedType) ? { secret: true } : {}),
  };
}

/** Initialisms pi uses as camelCase segments; sentence case turns them into
 * words that read as typos ("Npm command", "Base delay Ms"). "ms" is the
 * exception that stays lower — it is a unit, and "MS" reads as something
 * else entirely. */
const INITIALISMS = new Map([
  ["ms", "ms"], ["id", "ID"], ["ui", "UI"], ["url", "URL"],
  ["api", "API"], ["npm", "NPM"], ["sdk", "SDK"], ["tui", "TUI"],
]);

/** "compaction.reserveTokens" → "Reserve tokens"; "npmCommand" → "NPM command".
 * Only the LAST segment becomes the label — the leading ones are the group's
 * job, and the panel prints the full dotted key beside every row anyway. */
export function humanizeKey(key: string): string {
  const leaf = key.split(".").pop() ?? key;
  const spaced = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  const words = spaced.split(/\s+/).map((word, index) => {
    const initialism = INITIALISMS.get(word.toLowerCase());
    if (initialism) return initialism;
    if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
    // A lone capital is an axis, not a word ("editorPaddingX").
    return word.length === 1 ? word : word.toLowerCase();
  });
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** Split one markdown table row into its cells, tolerating a missing or
 * present trailing pipe. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map((cell) => cell.trim());
}

/** The `|---|---|` rule under a table header. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/**
 * Every setting pi documents, in document order, grouped by its `###`
 * headings.
 *
 * Deliberately defensive about what it accepts: only four-column tables whose
 * header starts with "Setting" are settings tables (settings.md opens with a
 * two-column Location/Scope table, and other pi docs are full of tables that
 * are not settings at all), and any row that does not yield a renderable
 * type is dropped. Exported for the test — the parse is the whole risk here.
 */
export function parsePiSettingsDocs(markdown: string): EngineSetting[] {
  const settings: EngineSetting[] = [];
  const seen = new Set<string>();
  let group = "General";
  let inSettingsTable = false;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      inSettingsTable = false;
      // `####` sub-headings expand on a setting above them (`#### packages`),
      // so they never open a new group.
      if (heading[1].length <= 3) group = heading[2].trim() || group;
      continue;
    }

    const cells = tableCells(line);
    if (!cells) {
      inSettingsTable = false;
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    if (cells.length === 4 && cells[0].toLowerCase() === "setting") {
      inSettingsTable = true;
      continue;
    }
    if (!inSettingsTable || cells.length !== 4) continue;

    const key = unwrapCell(cells[0]);
    const setting = describeRow(key, cells[1], cells[2], cells[3], group);
    // A duplicate key would give the panel two rows writing the same path.
    if (setting && !seen.has(setting.key)) {
      seen.add(setting.key);
      settings.push(setting);
    }
  }
  return settings;
}

/** Group order is pi's own document order, which is how its docs are meant to
 * be read. */
function orderedGroups(settings: EngineSetting[]): string[] {
  return [...new Set(settings.map((setting) => setting.group ?? ""))].filter(Boolean);
}

/** Walk up from the resolved pi binary to the package that owns it — the same
 * shape as lib/omp/settings-schema.ts's omp walk, because the question is the
 * same: which installed package is this engine, so its shipped files can be
 * read. */
export function findPiPackageRoot(binaryPath: string): string | null {
  let current: string;
  try {
    current = realpathSync(binaryPath);
  } catch {
    current = binaryPath;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    const manifest = join(current, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
      // The name is checked, not just the layout: omp is a FORK of this
      // package and installs into a sibling directory of the same tools
      // prefix, so "the first package.json above the binary" would happily
      // hand pi omp's docs if the walk ever started from the wrong link.
      if (parsed.name === "@mariozechner/pi-coding-agent") return current;
    } catch {
      // Unreadable manifest: keep walking.
    }
  }
  return null;
}

function packageVersion(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Why there is no schema, in terms that name the fix. */
export interface PiSchemaResult {
  schema: EngineSettingsSchema | null;
  reason?: string;
}

let cached: { key: string; result: PiSchemaResult } | null = null;

/**
 * Pi's declared settings, read from the installed package's own docs.
 *
 * Never throws: a missing binary, a package layout without docs, or a
 * settings.md that yields nothing all answer `schema: null` plus a reason the
 * panel prints. Cached per package path + version, so an upgrade re-reads.
 */
export function getPiSettingsSchema(binaryPath: string | null): PiSchemaResult {
  if (!binaryPath) {
    return { schema: null, reason: "Pi is not installed, so Cody cannot read the settings its version documents." };
  }
  const packageRoot = findPiPackageRoot(binaryPath);
  if (!packageRoot) {
    return { schema: null, reason: `Cody could not find the installed @mariozechner/pi-coding-agent package above ${binaryPath}.` };
  }
  const docsFile = join(packageRoot, "docs", "settings.md");
  const version = packageVersion(packageRoot);
  const cacheKey = `${packageRoot}@${version ?? "unknown"}`;
  if (cached?.key === cacheKey) return cached.result;

  let result: PiSchemaResult;
  try {
    const markdown = readFileSync(docsFile, "utf8");
    const settings = parsePiSettingsDocs(markdown);
    result = settings.length === 0
      ? { schema: null, reason: `Pi ships ${docsFile}, but Cody found no settings tables in it — the format may have changed.` }
      : {
        schema: {
          tabs: [{ id: TAB_ID, label: TAB_LABEL }],
          groups: { [TAB_ID]: orderedGroups(settings) },
          settings,
          source: { packagePath: packageRoot, version },
        },
      };
  } catch {
    result = { schema: null, reason: `Cody could not read ${docsFile}, so Pi's settings cannot be listed.` };
  }
  cached = { key: cacheKey, result };
  return result;
}

/** Drop the memoized schema so the next read re-parses the package. */
export function clearPiSettingsSchemaCache(): void {
  cached = null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * A stored value in the shape the control for `type` renders, or undefined
 * when it has none — the panel then falls back to the documented default
 * rather than showing an empty box that misreports what pi is running with.
 */
function asControlValue(type: EngineSetting["type"], raw: unknown): EngineSettingValue | undefined {
  switch (type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "array":
      return isStringArray(raw) ? raw : undefined;
    default:
      return typeof raw === "string" ? raw : undefined;
  }
}

/** Read pi's global settings.json, or an empty object when there is none —
 * the normal state of a fresh install, never an error. */
function readSettingsFile(agentDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(piSettingsPath(agentDir), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Absent, or hand-edited into something unparseable. Either way there are
    // no values to show; the defaults stand.
  }
  return {};
}

/**
 * The same read, but for a WRITE — and it refuses what the read tolerates.
 *
 * Reading an unparseable settings.json can safely fall back to "no overrides,
 * show the defaults". Writing cannot: read → mutate → write the whole object
 * would replace a file Cody could not understand with one built from the two
 * keys it does, silently destroying whatever the user had hand-edited into
 * it. A save that cannot preserve the file refuses and says where it is.
 */
function readSettingsFileForWrite(agentDir: string): Record<string, unknown> {
  const file = piSettingsPath(agentDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // No file yet is the normal state of a fresh install.
    return {};
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Cody could not parse ${file} as JSON, so it will not overwrite it. Fix or move the file, then save again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a JSON object, so Cody will not overwrite it.`);
  }
  return parsed as Record<string, unknown>;
}

/** Resolve a dotted key against the parsed JSON — the nesting pi's own
 * SettingsManager stores (`compaction.enabled` → `{compaction:{enabled}}`). */
function resolvePath(data: Record<string, unknown>, key: string): unknown {
  let current: unknown = data;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Values currently persisted for the settings pi documents, keyed by the
 * same dotted paths and shaped for the control that renders each one. */
export function readPiSettingsValues(agentDir: string, settings: EngineSetting[]): Record<string, EngineSettingValue> {
  const data = readSettingsFile(agentDir);
  const values: Record<string, EngineSettingValue> = {};
  for (const setting of settings) {
    const raw = resolvePath(data, setting.key);
    if (raw === undefined || raw === null) continue;
    const value = asControlValue(setting.type, raw);
    if (value !== undefined) values[setting.key] = value;
  }
  return values;
}

/** Why pi cannot take this patch entry, or null when it can. */
function validate(setting: EngineSetting, value: unknown): { ok: true; value: EngineSettingValue | null } | { ok: false; reason: string } {
  // The panel's Reset sends null: drop the override so pi's own default wins.
  if (value === null) return { ok: true, value: null };
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "expects true or false" };
    case "number": {
      const parsed = typeof value === "number" ? value : Number(value);
      return typeof value !== "object" && Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, reason: "expects a number" };
    }
    case "array":
      return isStringArray(value) ? { ok: true, value } : { ok: false, reason: "expects a list of strings" };
    case "enum": {
      if (typeof value !== "string") return { ok: false, reason: "expects one of its documented values" };
      const allowed = setting.values ?? setting.options?.map((option) => option.value) ?? [];
      return allowed.length === 0 || allowed.includes(value)
        ? { ok: true, value }
        : { ok: false, reason: `expects one of ${allowed.join(", ")}` };
    }
    default:
      return typeof value === "string" ? { ok: true, value } : { ok: false, reason: "expects text" };
  }
}

/** Set a dotted path in place, creating the intermediate objects pi's own
 * loader expects. Returns false when an intermediate is occupied by a
 * non-object the user put there by hand — overwriting it would silently
 * discard their value. */
function setPath(root: Record<string, unknown>, key: string, value: EngineSettingValue): boolean {
  const segments = key.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (next === undefined || next === null) {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
      continue;
    }
    if (typeof next !== "object" || Array.isArray(next)) return false;
    node = next as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
  return true;
}

/** Remove a dotted path, pruning parent objects the removal left empty so a
 * reset does not leave `"compaction": {}` behind. */
function deletePath(root: Record<string, unknown>, key: string): void {
  const segments = key.split(".");
  const chain: Array<Record<string, unknown>> = [root];
  let node: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return;
    node = next as Record<string, unknown>;
    chain.push(node);
  }
  delete node[segments[segments.length - 1]];
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    if (Object.keys(chain[depth]).length > 0) break;
    delete chain[depth - 1][segments[depth - 1]];
  }
}

/**
 * Persist the whole object back, atomically and with the file's existing
 * mode.
 *
 * Read → mutate → write the WHOLE object is the contract: pi's settings.json
 * holds keys Cody's panel never lists (`thinkingBudgets`, `packages` object
 * entries, anything a newer pi added), and a writer that reconstructed the
 * file from the schema would delete every one of them. The temp-and-rename
 * is so a crash mid-write cannot leave pi with a truncated config it refuses
 * to load.
 */
function writeSettingsFile(agentDir: string, data: Record<string, unknown>, trailingNewline: boolean): void {
  const target = piSettingsPath(agentDir);
  let mode: number | null = null;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    // New file: let the umask decide, as pi's own writer does.
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  // Two-space JSON is what pi's own SettingsManager writes, so a Cody save
  // leaves a file that looks like one pi wrote.
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}${trailingNewline ? "\n" : ""}`, "utf8");
  if (mode !== null) chmodSync(temp, mode);
  renameSync(temp, target);
}

/** Whether the file on disk ends with a newline, so a save preserves the
 * habit of whichever editor last touched it. */
function hadTrailingNewline(agentDir: string): boolean {
  try {
    return readFileSync(piSettingsPath(agentDir), "utf8").endsWith("\n");
  } catch {
    return false;
  }
}

/**
 * Apply a dotted-path patch to pi's global settings.json.
 *
 * Per-key refusals are REPORTED, not thrown: one key the panel sent with the
 * wrong shape must not abort the rest of the save, and must not vanish
 * either. The only throw is the case where no key could possibly be written.
 */
export function writePiSettings(
  binaryPath: string | null,
  agentDir: string,
  patch: Record<string, unknown>,
): EngineSettingsWrite {
  const { schema, reason } = getPiSettingsSchema(binaryPath);
  if (!schema) throw new Error(reason ?? "Pi's settings schema is unavailable, so settings cannot be written");
  const byKey = new Map(schema.settings.map((setting) => [setting.key, setting]));

  const data = readSettingsFileForWrite(agentDir);
  const written: string[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(patch)) {
    const setting = byKey.get(key);
    if (!setting) {
      rejected.push({ key, reason: `${key} is not a setting this version of Pi documents` });
      continue;
    }
    const checked = validate(setting, value);
    if (!checked.ok) {
      rejected.push({ key, reason: `${key} ${checked.reason}` });
      continue;
    }
    if (checked.value === null) {
      deletePath(data, key);
      written.push(key);
      continue;
    }
    if (!setPath(data, key, checked.value)) {
      rejected.push({ key, reason: `${key} sits under a value in settings.json that is not an object; edit the file directly` });
      continue;
    }
    written.push(key);
  }

  if (written.length > 0) writeSettingsFile(agentDir, data, hadTrailingNewline(agentDir));
  return { written, rejected, values: readPiSettingsValues(agentDir, schema.settings) };
}

/** Pi's schema plus the values currently persisted for it, in the shape the
 * schema route serves. */
export function readPiSettings(binaryPath: string | null, agentDir: string): EngineSettingsRead {
  const { schema, reason } = getPiSettingsSchema(binaryPath);
  return {
    path: piSettingsPath(agentDir),
    schema,
    values: schema ? readPiSettingsValues(agentDir, schema.settings) : {},
    ...(reason ? { reason } : {}),
  };
}
