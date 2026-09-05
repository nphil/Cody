import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

/**
 * The Settings registry is the ONE table the desktop rail, the phone stack,
 * the dialog search and every deep link read. These tests pin what the
 * redesign promised: eight hubs in a fixed order under three eyebrows, each
 * hidden only by its own capability gate, every legacy id landing on the hub
 * that now holds its content, and the `settings-tab-<id>` /
 * `settings-panel-<id>` DOM contract the audit scripts drive.
 */
const {
  SETTINGS_SECTIONS,
  SECTION_ALIASES,
  getVisibleSections,
  getVisibleSubViews,
  groupSections,
  normalizeSectionId,
  resolveSection,
  getSection,
} = await jiti.import("./settings/registry.ts");
const { ALL_CAPABILITIES, getNormalizedActive } = await jiti.import("./SettingsTabs.tsx");
const { SettingsSidebar } = await jiti.import("./settings/SettingsSidebar.tsx");
const { getHarnessById } = await jiti.import("../lib/harness/index.ts");

/** Every id the SettingsTab union carries, hubs and legacy alike. */
const EVERY_TAB_ID = [
  "accounts", "general", "safety", "models", "providers", "intelligence", "memory",
  "engine", "extensions", "mcp", "omp", "skills", "plugins", "localai", "system",
];

test("the eight hubs sit in the spec's order under You / engine / Server", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.id),
    ["accounts", "general", "providers", "models", "engine", "extensions", "memory", "system"],
  );
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.label),
    ["Account", "Preferences", "Providers", "Models", "Behavior", "Extensions", "Memory", "System"],
  );
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.group),
    ["you", "you", "engine", "engine", "engine", "engine", "engine", "server"],
  );
  assert.equal(new Set(SETTINGS_SECTIONS.map((section) => section.id)).size, SETTINGS_SECTIONS.length, "ids are unique");
  assert.equal(new Set(SETTINGS_SECTIONS.map((section) => section.phoneOrder)).size, SETTINGS_SECTIONS.length, "phone order is a total order");
  for (const section of SETTINGS_SECTIONS) {
    // lucide icons are forwardRef exotic objects, not plain functions.
    assert.ok(section.Icon && ["function", "object"].includes(typeof section.Icon), `${section.id} has an icon`);
    assert.ok(section.panel, `${section.id} has a panel loader`);
  }
});

test("rows per engine follow each adapter's real capability set", () => {
  // Read the flags off the adapters themselves so this test moves with them
  // rather than with a copy of them.
  const rows = (engineId) => getVisibleSections(getHarnessById(engineId).capabilities).map((section) => section.id);
  assert.deepEqual(rows("omp"), ["accounts", "general", "providers", "models", "engine", "extensions", "system"], "omp: 7 rows (no memory read-back)");
  assert.deepEqual(rows("pi"), ["accounts", "general", "providers", "models", "engine", "extensions", "system"], "pi: 7 rows (schema settings + skills)");
  assert.deepEqual(rows("hermes"), ["accounts", "general", "providers", "models", "engine", "extensions", "memory", "system"], "hermes: 8 rows (+ memory)");
  assert.deepEqual(rows("claude"), ["accounts", "general", "providers", "models", "system"], "claude: 5 rows");
  assert.deepEqual(rows("codex"), ["accounts", "general", "providers", "models", "system"], "codex: 5 rows");
  // The spec's shorthand for pi, pinned as well so a flag flip is noticed.
  const piShorthand = { ...Object.fromEntries(Object.keys(ALL_CAPABILITIES).map((key) => [key, false])), liveSessions: true, skills: true, nativeSettings: true, chatExtras: true, providerLogin: true };
  assert.equal(getVisibleSections(piShorthand).length, 7);
  const acpShorthand = { ...Object.fromEntries(Object.keys(ALL_CAPABILITIES).map((key) => [key, false])), liveSessions: true, providerLogin: true };
  assert.equal(getVisibleSections(acpShorthand).length, 5);
});

test("gates use ANY semantics and sub-views gate individually", () => {
  const none = Object.fromEntries(Object.keys(ALL_CAPABILITIES).map((key) => [key, false]));
  // Behavior stays for a schema-only engine (pi, Hermes) and for a curated-only one.
  assert.ok(getVisibleSections({ ...none, nativeSettings: true }).some((section) => section.id === "engine"));
  assert.ok(getVisibleSections({ ...none, configEditor: true }).some((section) => section.id === "engine"));
  assert.ok(!getVisibleSections(none).some((section) => section.id === "engine"));
  // Extensions stays with any one of mcp/skills/plugins; its segments follow their own flags.
  const skillsOnly = { ...none, skills: true };
  assert.ok(getVisibleSections(skillsOnly).some((section) => section.id === "extensions"));
  assert.deepEqual(getVisibleSubViews(getSection("extensions"), skillsOnly).map((view) => view.id), ["skills"]);
  assert.deepEqual(getVisibleSubViews(getSection("extensions"), ALL_CAPABILITIES).map((view) => view.id), ["mcp", "skills", "plugins"]);
  // Memory hides unless the engine can hand its memory back.
  assert.ok(!getVisibleSections(ALL_CAPABILITIES).some((section) => section.id === "memory"));
  assert.ok(getVisibleSections({ ...ALL_CAPABILITIES, memory: true }).some((section) => section.id === "memory"));
});

test("every legacy id resolves to a visible hub, with the segment it implies", () => {
  const everything = { ...ALL_CAPABILITIES, memory: true };
  const visible = new Set(getVisibleSections(everything).map((section) => section.id));
  for (const id of EVERY_TAB_ID) {
    const hub = normalizeSectionId(id);
    assert.ok(visible.has(hub), `${id} → ${hub} is a visible hub`);
    assert.equal(getNormalizedActive(id), hub, "SettingsTabs.getNormalizedActive delegates to the registry");
  }
  assert.deepEqual(resolveSection("safety"), { id: "engine" });
  assert.deepEqual(resolveSection("intelligence"), { id: "engine" });
  assert.deepEqual(resolveSection("omp"), { id: "engine" });
  assert.deepEqual(resolveSection("localai"), { id: "providers" });
  assert.deepEqual(resolveSection("mcp"), { id: "extensions", sub: "mcp" });
  assert.deepEqual(resolveSection("skills"), { id: "extensions", sub: "skills" });
  assert.deepEqual(resolveSection("plugins"), { id: "extensions", sub: "plugins" });
  assert.deepEqual(resolveSection("extensions"), { id: "extensions" });
  // `models` keeps its id: it now means the Models hub, deliberately.
  assert.deepEqual(resolveSection("models"), { id: "models" });
  assert.equal("models" in SECTION_ALIASES, false);
  // An explicit sub wins over an alias's implied one; unknown ids land on Preferences.
  assert.deepEqual(resolveSection("mcp", "skills"), { id: "extensions", sub: "skills" });
  assert.equal(normalizeSectionId("not-a-tab"), "general");
  assert.equal(normalizeSectionId(null), "general");
});

test("the phone list groups by eyebrow with Preferences first and Account last", () => {
  const groups = groupSections(getVisibleSections({ ...ALL_CAPABILITIES, memory: true }), "phone");
  assert.deepEqual(groups.map((group) => group.group), ["you", "engine", "server"]);
  assert.deepEqual(groups[0].sections.map((section) => section.id), ["general", "accounts"]);
  assert.deepEqual(groups[1].sections.map((section) => section.id), ["providers", "models", "engine", "extensions", "memory"]);
  assert.deepEqual(groups[2].sections.map((section) => section.id), ["system"]);
  // Desktop keeps registry order.
  const desktop = groupSections(getVisibleSections(ALL_CAPABILITIES), "desktop");
  assert.deepEqual(desktop[0].sections.map((section) => section.id), ["accounts", "general"]);
});

test("the desktop rail keeps the settings-tab-<id> tablist contract and names its eyebrows", () => {
  const sections = getVisibleSections(ALL_CAPABILITIES);
  const html = renderToStaticMarkup(
    React.createElement(SettingsSidebar, {
      sections,
      active: "engine",
      onSelect: () => {},
      capabilities: ALL_CAPABILITIES,
      engine: { id: "omp", displayName: "oh-my-pi", shortName: "OMP", experimental: false },
      harnessLabel: "OMP",
    }),
  );
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-orientation="vertical"/);
  for (const section of sections) {
    assert.match(html, new RegExp(`id="settings-tab-${section.id}"`), `${section.id} row`);
    assert.match(html, new RegExp(`aria-controls="settings-panel-${section.id}"`), `${section.id} controls its panel`);
  }
  assert.match(html, /id="settings-tab-engine"[^>]*aria-selected="true"/);
  assert.doesNotMatch(html, /settings-tab-memory/, "omp has no memory row");
  // Eyebrows in order: You, the engine's short name, Server.
  const you = html.indexOf(">You<");
  const engine = html.indexOf(">OMP<");
  const server = html.indexOf(">Server<");
  assert.ok(you >= 0 && engine > you && server > engine, `eyebrows in order (${you}, ${engine}, ${server})`);
  // The old descriptions are gone; the Preferences row carries a live status line.
  assert.match(html, /sound on/);
});

test("status lines read cached bodies only and never throw on odd shapes", () => {
  const data = (routes) => ({
    capabilities: ALL_CAPABILITIES,
    engine: null,
    harnessLabel: "OMP",
    routes,
    local: { localeLabel: "English", themeName: "Catppuccin", soundEnabled: true },
  });
  assert.deepEqual(getSection("general").statusLine(data({})), { text: "English · Catppuccin · sound on" });
  assert.equal(getSection("accounts").statusLine(data({})), null);
  assert.deepEqual(
    getSection("accounts").statusLine(data({ "/api/accounts/me": { user: { username: "nitin", role: "admin" } }, "/api/accounts/me/tokens": { tokens: [{}, {}] } })),
    { text: "@nitin · Admin · 2 tokens" },
  );
  assert.deepEqual(getSection("memory").statusLine(data({ "/api/memory": { documents: [1, 2, 3] } })), { text: "3 documents" });
  assert.deepEqual(
    getSection("system").statusLine(data({ "/api/app-update": { currentVersion: "0.12.3", updateAvailable: true } })),
    { text: "Cody 0.12.3 · update available", tone: "accent" },
  );
  assert.deepEqual(
    getSection("engine").statusLine(data({ "/api/omp-settings/schema": { harness: { shortName: "OMP" }, schema: { source: { version: "18.1.10" }, settings: new Array(334).fill({}) }, values: { a: 1, b: 2 } } })),
    { text: "18.1.10 · 2 changed · 334 settings" },
  );
  // Nothing cached yet: never a call, never a throw.
  assert.equal(getSection("providers").statusLine(data({})), null);
  assert.equal(getSection("models").statusLine(data({})), null);
  // Providers: connected rows, "signed in" only for a WINNING subscription
  // login (a key vendor marked authenticated is not a sign-in), a warning
  // with nothing connected — but not while the catalog cache is still cold.
  const providers = (rows, extra = {}) => data({ "/api/providers?cached=1": { engine: { id: "omp", shortName: "OMP" }, providers: rows, ...extra } });
  const subscription = { id: "anthropic", connected: true, methods: [{ kind: "oauth", state: "connected", loginId: "anthropic", winning: true }] };
  const keyed = { id: "openai", connected: true, methods: [{ kind: "key", state: "connected", winning: true }, { kind: "oauth", state: "connected", loginId: "openai-codex", winning: false }] };
  const unset = { id: "mistral", connected: false, methods: [{ kind: "key", state: "unset", winning: true }] };
  assert.deepEqual(getSection("providers").statusLine(providers([subscription, keyed, unset])), { text: "2 connected · 1 signed in" });
  assert.deepEqual(getSection("providers").statusLine(providers([keyed])), { text: "1 connected" });
  assert.deepEqual(getSection("providers").statusLine(providers([unset])), { text: "No credentials — OMP cannot answer", tone: "warn" });
  assert.equal(getSection("providers").statusLine(providers([unset], { pending: true })), null, "a cold cache is not a verdict");
  assert.deepEqual(getSection("providers").statusLine(providers([subscription], { pending: true })), { text: "1 connected · 1 signed in" });
  // Models: the cached catalog's total, hidden counts from the visibility
  // file, "new" in accent; a cold cache shows nothing; ACP says so.
  const models = (fresh, visibility) => data({ "/api/models/new?cached=1": fresh, ...(visibility ? { "/api/models/visibility": visibility } : {}) });
  assert.deepEqual(getSection("models").statusLine(models({ total: 233, newModels: [], catalogSource: "global" })), { text: "233 models", tone: "muted" });
  assert.deepEqual(
    getSection("models").statusLine(models({ total: 233, newModels: [{}, {}, {}, {}], catalogSource: "global" }, { hidden: ["a", "b"], instanceHidden: ["c"] })),
    { text: "233 models · 3 hidden · 4 new", tone: "accent" },
  );
  assert.equal(getSection("models").statusLine(models({ pending: true, newModels: [], catalogSource: "global" })), null, "never a spawn: a cold cache is silent");
  assert.deepEqual(getSection("models").statusLine(models({ catalogSource: "session", newModels: [] })), { text: "From the session" });
  // Behavior: secret leaves are redacted out of `values` and counted through `secretsSet`.
  assert.deepEqual(
    getSection("engine").statusLine(data({ "/api/omp-settings/schema": { schema: { source: { version: "0.9" }, settings: [{}, {}] }, values: { a: 1 }, secretsSet: ["api.key"] } })),
    { text: "0.9 · 2 changed · 2 settings" },
  );
  for (const section of SETTINGS_SECTIONS) {
    assert.doesNotThrow(() => section.statusLine?.(data({ "/api/accounts/me": "garbage", "/api/memory": 42, "/api/app-update": null })));
  }
});
