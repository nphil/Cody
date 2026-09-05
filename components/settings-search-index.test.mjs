import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

/**
 * The dialog-wide search must find every setting a hub renders, and only
 * those. The contract every hub follows: the module that owns a card table
 * exports `SEARCH_ENTRIES` derived FROM that table, and this test scans the
 * rendered `<NativeSetting label=…>` cards to prove nothing drifted.
 *
 * Hubs another slice is still writing (no `SEARCH_ENTRIES` export yet, or a
 * module that does not load) are skipped and reported as diagnostics; the
 * temporary fallback list covers them in the meantime. Preferences is the
 * one hub that must always take part.
 */
const {
  FALLBACK_ENTRIES,
  PRELOADED_STATIC_INDEX,
  SEARCH_FILTERS,
  buildSchemaSearchEntries,
  buildStaticSearchIndex,
  schemaRowsFromBody,
  collectSearchEntries,
  matchesSearchFilter,
  readSearchEntriesExport,
  resultHighlight,
  resultTarget,
  searchSettings,
} = await jiti.import("./settings/search-index.ts");
const { PREFERENCE_CARDS, SEARCH_ENTRIES: PREFERENCE_ENTRIES } = await jiti.import("./settings/panels/PreferencesPanel.tsx");
const { ALL_CAPABILITIES } = await jiti.import("./SettingsTabs.tsx");
const { slugify, TERMINAL_ONLY_BADGE, UNAVAILABLE_BADGE } = await jiti.import("./settings/primitives.tsx");

const SETTINGS_DIR = new URL("./settings/", import.meta.url).pathname;
const PANELS_DIR = join(SETTINGS_DIR, "panels");

/** The hub each panel module renders, so a module that exports an empty
 * table still marks its hub as covered. */
const PANEL_TABS = {
  "AccountPanel.tsx": "accounts",
  "PreferencesPanel.tsx": "general",
  "ProvidersPanel.tsx": "providers",
  "ModelsPanel.tsx": "models",
  "EnginePanel.tsx": "engine",
  "ExtensionsPanel.tsx": "extensions",
  "MemoryPanel.tsx": "memory",
  "SystemPanel.tsx": "system",
};

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/** Every `<NativeSetting …>` opening tag with a LITERAL label, as
 * {label, searchId}. Labels bound from a table (`label={card("x").label}`)
 * are checked through the table itself. */
function renderedCards(source) {
  const cards = [];
  for (const match of source.matchAll(/<NativeSetting\b([\s\S]*?)>/g)) {
    const attrs = match[1];
    const label = attrs.match(/\blabel="([^"]+)"/)?.[1];
    if (!label) continue;
    const searchId = attrs.match(/\bsearchId="([^"]+)"/)?.[1];
    cards.push({ label, id: searchId ?? slugify(label) });
  }
  return cards;
}

/** Load a panel module's SEARCH_ENTRIES, or null when it has none or fails to load. */
async function loadPanelEntries(path) {
  try {
    const loaded = await jiti.import(path);
    return readSearchEntriesExport(loaded);
  } catch {
    return null;
  }
}

test("Preferences derives its search entries from the card table it renders", () => {
  assert.equal(PREFERENCE_ENTRIES.length, PREFERENCE_CARDS.length);
  for (const card of PREFERENCE_CARDS) {
    const entry = PREFERENCE_ENTRIES.find((candidate) => candidate.id === slugify(card.label));
    assert.ok(entry, `${card.label} is searchable`);
    assert.equal(entry.tab, "general");
    assert.equal(entry.label, card.label);
    assert.equal(entry.description, card.description);
    assert.deepEqual(entry.breadcrumb, ["Cody", "Preferences"]);
  }
  // Every `card("id")` the panel renders resolves to a row of the table.
  const source = readFileSync(join(PANELS_DIR, "PreferencesPanel.tsx"), "utf8");
  const ids = new Set(PREFERENCE_CARDS.map((card) => card.id));
  for (const match of source.matchAll(/\bcard\("([^"]+)"\)/g)) {
    assert.ok(ids.has(match[1]), `card("${match[1]}") exists in PREFERENCE_CARDS`);
  }
  assert.ok(PRELOADED_STATIC_INDEX.coveredTabs.has("general"));
});

test("every rendered <NativeSetting label> in a hub that exports SEARCH_ENTRIES is in the union, and static ids never collide", async (t) => {
  const sources = [];
  const skipped = [];
  for (const path of walk(PANELS_DIR)) {
    const entries = await loadPanelEntries(path);
    const name = path.slice(SETTINGS_DIR.length);
    if (entries === null) {
      assert.notEqual(name, "panels/PreferencesPanel.tsx", "Preferences must export SEARCH_ENTRIES");
      skipped.push(name);
      continue;
    }
    const tab = PANEL_TABS[name.slice("panels/".length)];
    assert.ok(tab, `${name} is a known hub module (add it to PANEL_TABS)`);
    sources.push({ name, path, tab, entries });
  }
  if (skipped.length > 0) t.diagnostic(`hubs without SEARCH_ENTRIES yet (searched through the temporary fallback): ${skipped.join(", ")}`);

  const index = buildStaticSearchIndex(sources.map((source) => ({ tab: source.tab, entries: source.entries })));
  const union = collectSearchEntries({ capabilities: ALL_CAPABILITIES, shortName: "OMP", statics: index });
  const ids = new Set(union.map((entry) => entry.id));

  for (const source of sources) {
    for (const card of renderedCards(readFileSync(source.path, "utf8"))) {
      assert.ok(ids.has(card.id), `${source.name}: "${card.label}" (id ${card.id}) is missing from the search union`);
    }
  }

  // Ids must be unique across the whole static layer (tables + fallback):
  // the highlight is one id for the whole dialog.
  const staticIds = [...index.entries, ...FALLBACK_ENTRIES.filter((entry) => !index.coveredTabs.has(entry.tab))].map((entry) => entry.id);
  const duplicates = staticIds.filter((id, position) => staticIds.indexOf(id) !== position);
  assert.deepEqual([...new Set(duplicates)], [], "static search ids collide");
});

test("the temporary fallback still mirrors the stub panels it stands in for", (t) => {
  // Not a hard failure: those files belong to slices mid-rewrite. The
  // diagnostic names any label the fallback would fail to find so the
  // drift is visible until the hub exports its own table.
  const fallbackIds = new Set(FALLBACK_ENTRIES.map((entry) => entry.id));
  const drift = [];
  for (const path of walk(PANELS_DIR)) {
    const source = readFileSync(path, "utf8");
    if (/export const SEARCH_ENTRIES\b/.test(source)) continue;
    for (const card of renderedCards(source)) {
      if (!fallbackIds.has(card.id)) drift.push(`${path.slice(SETTINGS_DIR.length)}: ${card.label}`);
    }
  }
  if (drift.length > 0) t.diagnostic(`fallback drift: ${drift.join("; ")}`);
  assert.equal(new Set(FALLBACK_ENTRIES.map((entry) => entry.id)).size, FALLBACK_ENTRIES.length, "fallback ids are unique");
});

test("the fallback drops out per hub as soon as that hub exports its table", () => {
  const withoutEngine = collectSearchEntries({ capabilities: ALL_CAPABILITIES, shortName: "OMP", statics: { entries: [], coveredTabs: new Set() } });
  assert.ok(withoutEngine.some((entry) => entry.id === "approval-mode"), "Behavior is searched through the fallback while its panel has no table");

  const engineTable = [{ id: "schema-tools.approvalMode", tab: "engine", label: "Approval mode", breadcrumb: ["{engine}", "Behavior"], action: "jump" }];
  const withEngine = collectSearchEntries({ capabilities: ALL_CAPABILITIES, shortName: "Pi", statics: buildStaticSearchIndex([{ tab: "engine", entries: engineTable }]) });
  assert.ok(!withEngine.some((entry) => entry.id === "approval-mode"), "the fallback's Behavior rows are gone");
  assert.ok(withEngine.some((entry) => entry.id === "full-name"), "other hubs keep their fallback");
  const card = withEngine.find((entry) => entry.id === "schema-tools.approvalMode");
  assert.deepEqual(card.breadcrumb, ["Pi", "Behavior"], "{engine} is the active engine's short name");
});

test("hidden hubs and gated cards are dropped from the union, never dimmed", () => {
  const noConfig = { ...ALL_CAPABILITIES, configEditor: false, nativeSettings: false, mcp: false, skills: false, plugins: false, chatExtras: false };
  const union = collectSearchEntries({ capabilities: noConfig, shortName: "Claude", statics: { entries: PREFERENCE_ENTRIES, coveredTabs: new Set(["general"]) } });
  assert.ok(!union.some((entry) => entry.tab === "engine"), "no Behavior rows without the hub");
  assert.ok(!union.some((entry) => entry.tab === "extensions"));
  assert.ok(!union.some((entry) => entry.id === "message-during-active-run"), "a card gated on chatExtras is gone");
  assert.ok(union.some((entry) => entry.id === "theme"));
  assert.ok(union.some((entry) => entry.id === "tab-providers"), "every visible hub has a row of its own");
  assert.ok(!union.some((entry) => entry.id === "tab-engine"));
});

test("schema rows are searchable by label, description and key, deduped against a card with the same id", () => {
  const body = {
    schema: {
      tabs: [{ id: "tools", label: "Tools" }],
      settings: [
        { key: "tools.someUncuratedKey", tab: "tools", group: "Approvals", label: "Uncurated", description: "Nothing curates this.", terminalOnly: false },
        { key: "ui.theme", tab: "ui", label: "Theme", description: "TUI colours.", terminalOnly: true },
      ],
    },
    values: { "ui.theme": "dark" },
  };
  const rows = buildSchemaSearchEntries(schemaRowsFromBody(body), "OMP", ALL_CAPABILITIES);
  assert.deepEqual(rows.map((row) => row.id), ["schema-tools.someUncuratedKey", "schema-ui.theme"]);
  assert.deepEqual(rows[0].breadcrumb, ["OMP", "Behavior", "Tools", "Approvals"]);
  assert.deepEqual(rows[0].keywords, ["tools.someUncuratedKey"]);
  assert.equal(rows[1].scope, TERMINAL_ONLY_BADGE);
  assert.equal(rows[1].modified, true);
  assert.equal(rows[0].modified, false);
  assert.deepEqual(rows[1].breadcrumb, ["OMP", "Behavior", "ui"], "an unknown tab id is shown as-is");

  const card = { id: "schema-tools.someUncuratedKey", tab: "engine", label: "Uncurated", description: "Card copy.", breadcrumb: ["{engine}", "Behavior"], action: "jump" };
  const union = collectSearchEntries({ capabilities: ALL_CAPABILITIES, shortName: "OMP", dynamic: { schemaRows: schemaRowsFromBody(body) }, statics: buildStaticSearchIndex([{ tab: "engine", entries: [card] }]) });
  const matches = union.filter((entry) => entry.id === "schema-tools.someUncuratedKey");
  assert.equal(matches.length, 1, "one id, one entry");
  assert.equal(matches[0].description, "Card copy.", "the card wins over the schema row");
  assert.equal(buildSchemaSearchEntries(null, "OMP").length, 0);
  assert.equal(buildSchemaSearchEntries(schemaRowsFromBody(null), "OMP").length, 0);

  // A secret leaf counts as changed through `secretsSet`, never `values`.
  const secret = schemaRowsFromBody({ schema: { settings: [{ key: "api.key", tab: "auth", label: "API key" }] }, values: {}, secretsSet: ["api.key"] });
  assert.equal(secret[0].modified, true);
  // Rows resolved by useSchemaIndex carry `visible`; an unmet condition drops the row.
  const resolved = buildSchemaSearchEntries([
    { key: "a", label: "A", tab: "t", visible: true, modified: false },
    { key: "b", label: "B", tab: "t", visible: false, modified: true },
  ], "OMP");
  assert.deepEqual(resolved.map((entry) => entry.id), ["schema-a"], "a row whose condition does not hold has no control to jump to");
});

test("a schema row a curated card owns trails the card's home, and the schema list when that surface is absent", () => {
  const body = {
    schema: {
      tabs: [{ id: "tools", label: "Tools" }, { id: "mcp", label: "MCP" }],
      settings: [
        { key: "tools.approvalMode", tab: "tools", group: "Approvals", label: "Approval mode", description: "When to ask." },
        { key: "mcp.enableProjectConfig", tab: "mcp", label: "Project MCP", description: "Discover project servers." },
      ],
    },
    values: {},
  };
  const withCards = buildSchemaSearchEntries(schemaRowsFromBody(body), "OMP", ALL_CAPABILITIES);
  assert.deepEqual(withCards[0].breadcrumb, ["OMP", "Behavior", "Recommended", "Safety & approvals"], "the Recommended card holds the id, so the trail says where it is");
  assert.equal(withCards[0].tab, "engine");
  assert.deepEqual({ tab: withCards[1].tab, sub: withCards[1].sub, trail: withCards[1].breadcrumb }, { tab: "extensions", sub: "mcp", trail: ["OMP", "Extensions", "MCP"] }, "an MCP-bound card renders under Extensions");

  const schemaOnly = buildSchemaSearchEntries(schemaRowsFromBody(body), "Hermes", { ...ALL_CAPABILITIES, configEditor: false });
  assert.deepEqual(schemaOnly[0].breadcrumb, ["Hermes", "Behavior", "Tools", "Approvals"], "no card on this engine: the row is the key's only home");
  assert.equal(schemaOnly[1].tab, "engine");
  assert.deepEqual(buildSchemaSearchEntries(schemaRowsFromBody(body), "OMP")[0].breadcrumb, ["OMP", "Behavior", "Tools", "Approvals"], "without capabilities nothing is assumed");
});

test("ranking: label prefix, then label contains, then keyword or key, then description, then trail", () => {
  const entries = [
    { id: "d", tab: "engine", label: "Zeta", description: "The approval policy.", breadcrumb: ["OMP", "Behavior"], action: "jump" },
    { id: "c", tab: "engine", label: "Bash Override", keywords: ["tools.approval.bash"], breadcrumb: ["OMP", "Behavior"], action: "jump" },
    { id: "b", tab: "engine", label: "Extension Approval", breadcrumb: ["OMP", "Behavior"], action: "jump" },
    { id: "a", tab: "engine", label: "Approval Mode", breadcrumb: ["OMP", "Behavior"], action: "jump" },
    { id: "e", tab: "engine", label: "Unrelated", breadcrumb: ["OMP", "Approvals"], action: "jump" },
    { id: "f", tab: "general", label: "Theme", breadcrumb: ["Cody", "Preferences"], action: "jump" },
  ];
  const results = searchSettings("approval", entries);
  assert.deepEqual(results.map((result) => result.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(results.map((result) => result.rank), [0, 1, 2, 3, 4]);
  assert.deepEqual(searchSettings("  ", entries), [], "nothing for an empty query without a chip");
  assert.deepEqual(searchSettings("ANTHROPIC", [{ id: "p", tab: "providers", label: "Anthropic", keywords: ["ANTHROPIC_API_KEY"], breadcrumb: [], action: "jump" }]).map((result) => result.id), ["p"], "case-insensitive");
});

test("chips narrow the union and list everything they match when the query is empty", () => {
  const entries = [
    { id: "changed", tab: "engine", label: "Changed row", modified: true, breadcrumb: [], action: "jump" },
    { id: "cody", tab: "general", label: "Cody row", scope: "Cody only", breadcrumb: [], action: "jump" },
    { id: "tui", tab: "engine", label: "Terminal row", scope: TERMINAL_ONLY_BADGE, breadcrumb: [], action: "jump" },
    { id: "gone", tab: "models", label: "Unavailable row", badge: UNAVAILABLE_BADGE, breadcrumb: [], action: "jump" },
    { id: "plain", tab: "engine", label: "Plain row", breadcrumb: [], action: "jump" },
  ];
  assert.deepEqual(SEARCH_FILTERS.map((chip) => chip.id), ["changed", "cody", "terminal", "unavailable"]);
  assert.deepEqual(SEARCH_FILTERS.map((chip) => chip.label), ["Changed", "Cody only", "Terminal only", "Unavailable"]);
  for (const chip of SEARCH_FILTERS) {
    const results = searchSettings("", entries, { filter: chip.id });
    assert.equal(results.length, 1, `${chip.id} matches one row`);
    assert.ok(matchesSearchFilter(results[0], chip.id));
  }
  assert.deepEqual(searchSettings("row", entries, { filter: "terminal" }).map((result) => result.id), ["tui"], "query and chip combine");
  assert.equal(searchSettings("row", entries, { filter: null }).length, 5);
});

test("a result opens its hub (with the legacy sub-view) and highlights everything but a hub row", () => {
  assert.deepEqual(resultTarget({ id: "load-project-mcp-servers", tab: "extensions", sub: "mcp", label: "x", breadcrumb: [], action: "jump" }), { id: "extensions", sub: "mcp" });
  assert.deepEqual(resultTarget({ id: "theme", tab: "general", label: "x", breadcrumb: [], action: "jump" }), { id: "general" });
  assert.equal(resultHighlight({ id: "tab-providers", tab: "providers", label: "x", breadcrumb: [], action: "jump" }), null);
  assert.equal(resultHighlight({ id: "schema-ui.theme", tab: "engine", label: "x", breadcrumb: [], action: "jump" }), "schema-ui.theme");
  const mcp = FALLBACK_ENTRIES.find((entry) => entry.id === "load-project-mcp-servers");
  assert.deepEqual({ tab: mcp.tab, sub: mcp.sub }, { tab: "extensions", sub: "mcp" }, "legacy ids resolve to hub + segment");
});
