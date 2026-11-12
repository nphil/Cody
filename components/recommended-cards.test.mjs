import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

import { ompTestPackageBin } from "../lib/omp/omp-test-package.mjs";
/**
 * The Behavior hub's Recommended layer is data: 33 cards in five groups,
 * plus 5 MCP cards and 5 Retry cards — 43 keys in the shared setting space.
 * Every card resolves its copy from the engine's schema at render time,
 * except the nine keys OMP keeps config-file only, whose copy lives in
 * CURATED_ONLY.
 *
 * Membership is asserted twice: against the checked-in key snapshot
 * (lib/harness/fixtures/omp-schema-keys.json), so CI without an omp package
 * still catches a card whose key the schema does not declare, and against
 * an installed omp schema when one is present (CODY_OMP_BIN, or the
 * extracted test package), so drift in a newer omp shows up here first.
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const cards = await jiti.import("./settings/engine/recommended-cards.ts");
const {
  RECOMMENDED_CARDS, RECOMMENDED_GROUPS, MCP_CARDS, RETRY_CARDS, ALL_CURATED_CARDS,
  CURATED_ONLY, CURATED_ONLY_KEYS, SEARCH_ENTRIES, cardOwner, cardSurfaceAvailable, curatedOnly, curatedSupported,
  rowSearchIdBesideCard, searchIdForKey,
} = cards;

const snapshot = JSON.parse(await readFile(new URL("../lib/harness/fixtures/omp-schema-keys.json", import.meta.url), "utf8"));
const SNAPSHOT_KEYS = new Set(snapshot.keys);
/** Cards for keys a newer engine added: the version that first declared each. An older engine has no schema row and no fallback writer for them, so the renderer keeps them hidden. */
const INTRODUCED_IN = {
  "advisor.evictStaleResults": "18.3.0",
  "mcp.startupTimeoutMs": "18.3.0",
  "retry.fallbackOn": "18.9.0",
  "advisor.continueSeverity": "18.12.1",
  "retry.rateLimitWalksChain": "18.13.3",
  "bash.gitGuard": "18.8.7",
  "tools.restrictedFolders": "18.13.1",
};
const INTRODUCED_IN_KEYS = Object.keys(INTRODUCED_IN);
/** True when `version` ("18.8.3") is at or past `floor` ("18.9.0"). */
function atLeast(version, floor) {
  const have = String(version).split(".").map(Number);
  const want = floor.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  }
  return true;
}

const EXPECTED_GROUP_SIZES = { safety: 7, thinking: 5, advisor: 6, context: 7, memory: 8 };
const CONTROLS = new Set(["select", "toggle", "number", "methodOrder"]);

test("the five groups hold 33 cards, in the spec's sizes, with no duplicate keys", () => {
  assert.deepEqual(RECOMMENDED_GROUPS.map((group) => group.id), Object.keys(EXPECTED_GROUP_SIZES));
  for (const [group, size] of Object.entries(EXPECTED_GROUP_SIZES)) {
    assert.equal(RECOMMENDED_CARDS.filter((card) => card.group === group).length, size, `${group} holds ${size} cards`);
  }
  assert.equal(RECOMMENDED_CARDS.length, 33);
  assert.equal(MCP_CARDS.length, 5);
  assert.equal(RETRY_CARDS.length, 5);
  assert.equal(ALL_CURATED_CARDS.length, 43, "43 keys across the three surfaces");
  assert.equal(new Set(ALL_CURATED_CARDS.map((card) => card.key)).size, 43, "no key appears on two surfaces");
  for (const card of ALL_CURATED_CARDS) {
    assert.match(card.key, /^[a-zA-Z][\w.]*$/, `${card.key} is a dotted config path`);
    if (card.control) assert.ok(CONTROLS.has(card.control), `${card.key}: unknown control ${card.control}`);
    // No label or description overrides: the engine's schema owns the copy.
    assert.deepEqual(Object.keys(card).filter((field) => !["key", "group", "control", "hint"].includes(field)), [], `${card.key} carries only key/group/control/hint`);
  }
});

test("advisor guidance distinguishes the next launch from the active chat", () => {
  const advisor = RECOMMENDED_GROUPS.find((group) => group.id === "advisor");
  assert.match(advisor.description, /next time a chat launches/);
  assert.match(advisor.description, /do not update an active chat/);
});

test("retry keys are not Recommended, MCP keys are not rendered here, and both stay in the key space", () => {
  const recommended = new Set(RECOMMENDED_CARDS.map((card) => card.key));
  for (const key of ["retry.enabled", "retry.maxRetries", "retry.modelFallback", "retry.fallbackOn", "retry.rateLimitWalksChain"]) {
    assert.equal(recommended.has(key), false, `${key} lives under Models › Assignments`);
    assert.equal(cardOwner(key)?.surface, "retry");
  }
  for (const card of MCP_CARDS) {
    assert.equal(recommended.has(card.key), false, `${card.key} lives under Extensions › MCP`);
    assert.match(card.key, /^mcp\./);
    assert.equal(cardOwner(card.key)?.surface, "mcp");
  }
  assert.equal(cardOwner("tools.approvalMode")?.surface, "recommended");
  assert.equal(cardOwner("tools.approvalMode")?.group?.id, "safety");
  assert.equal(cardOwner("prewalk.enabled"), null, "a row nothing curates has no owner");
});

test("every card is either declared by the checked-in schema key snapshot or in the curated-only table", () => {
  // The snapshot is a floor for OMP 18.19.0. A card whose key the snapshot
  // lacks must be one the engine keeps config-file only (CURATED_ONLY), and
  // nothing else: that is how a card for a renamed or removed key is caught
  // in CI without an omp package.
  const schemaDeclared = ALL_CURATED_CARDS.filter((card) => SNAPSHOT_KEYS.has(card.key)).map((card) => card.key);
  const curatedOnlyKeys = ALL_CURATED_CARDS.filter((card) => !SNAPSHOT_KEYS.has(card.key)).map((card) => card.key);
  assert.ok(schemaDeclared.length > 0, "the snapshot declares the schema-backed cards");
  assert.deepEqual(curatedOnlyKeys.sort(), [...CURATED_ONLY_KEYS].sort(), "the keys the snapshot lacks are exactly the curated-only table");
  assert.ok(CURATED_ONLY.length > 0);
  // The table must not describe a key the engine actually declares: the
  // schema's copy would win at render time and the table would be dead.
  for (const entry of CURATED_ONLY) {
    assert.equal(SNAPSHOT_KEYS.has(entry.key), false, `${entry.key} is schema-declared; drop it from CURATED_ONLY`);
    assert.ok(entry.label && entry.description, `${entry.key} carries copy`);
    assert.ok(["boolean", "enum", "number"].includes(entry.type));
    if (entry.type === "enum") assert.ok(entry.options?.length >= 2, `${entry.key} lists its choices`);
    assert.equal(curatedOnly(entry.key), entry);
  }
  assert.equal(snapshot.keys.length, snapshot.settings, "the snapshot's count matches its list");
});

/** The installed omp, when one can be read here. */
function installedOmpBin() {
  const candidates = [process.env.CODY_OMP_BIN, "/tmp/ompkg/package/bin/omp", ompTestPackageBin()].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const ompBin = installedOmpBin();

test("cards match the installed OMP schema, with newer-version cards gated until declared", { skip: !ompBin && "no omp package to read" }, async () => {
  const previous = process.env.CODY_OMP_BIN;
  process.env.CODY_OMP_BIN = ompBin;
  try {
    const schemaModule = await jiti.import("../lib/omp/settings-schema.ts");
    (await jiti.import("../lib/omp/omp-cli.ts")).invalidateOmpCliCache();
    schemaModule.clearOmpSettingsSchemaCache();
    const schema = schemaModule.getOmpSettingsSchema();
    assert.ok(schema, "schema read from the installed package");
    const keys = new Set(schema.settings.map((setting) => setting.key));
    const declared = ALL_CURATED_CARDS.filter((card) => keys.has(card.key)).map((card) => card.key);
    const missing = ALL_CURATED_CARDS.filter((card) => !keys.has(card.key)).map((card) => card.key);
    // Cards for keys a newer engine added have no schema row or fallback
    // writer on an older one, so the renderer keeps them hidden instead of
    // saving settings the installed engine does not support.
    assert.ok(declared.length > 0, `installed ${schema.source.version}: no curated key is schema-declared`);
    const version = schema.source.version;
    const missingVersioned = missing.filter((key) => INTRODUCED_IN_KEYS.includes(key)).sort();
    const expectedMissing = INTRODUCED_IN_KEYS.filter((key) => !atLeast(version, INTRODUCED_IN[key])).sort();
    assert.deepEqual(missingVersioned, expectedMissing, `installed ${version}: versioned cards match engine support`);
    const unrenderable = missing.filter((key) => !CURATED_ONLY_KEYS.includes(key) && !INTRODUCED_IN_KEYS.includes(key));
    assert.deepEqual(unrenderable, [], `installed ${version}: curated cards with neither a schema row nor a curated-only entry`);
    for (const card of ALL_CURATED_CARDS) {
      const setting = schema.settings.find((entry) => entry.key === card.key);
      if (!setting || !card.control) continue;
      if (card.control === "toggle") assert.equal(setting.type, "boolean", `${card.key} toggles a boolean`);
      if (card.control === "select") assert.ok(setting.type === "enum" || (setting.type === "number" && setting.options), `${card.key} selects among declared choices`);
      if (card.control === "number") assert.equal(setting.type, "number", `${card.key} is a number`);
      if (card.control === "methodOrder") assert.equal(setting.type, "array", `${card.key} is an ordered list`);
    }
    // memory.backend shows every option the schema declares, default included.
    const backend = schema.settings.find((entry) => entry.key === "memory.backend");
    assert.equal(backend.default, "off");
    assert.ok(backend.options.some((option) => option.value === "mnemopi"));
    // The spend caps have no schema row on any engine: curated-only cards in
    // the Safety group, hidden by their own version floor below 18.13.0.
    for (const key of ["session.warnCost", "session.maxCost"]) {
      assert.equal(keys.has(key), false, `installed ${version}: ${key} has no engine UI metadata`);
      assert.ok(CURATED_ONLY_KEYS.includes(key), `${key} is curated-only`);
      assert.equal(cardOwner(key)?.group?.id, "safety", `${key} lives under Safety & approvals`);
      assert.equal(curatedOnly(key).minVersion, "18.13.0");
      assert.equal(curatedSupported(curatedOnly(key), "18.8.3"), false);
      assert.equal(curatedSupported(curatedOnly(key), "18.13.0"), true);
      assert.equal(curatedSupported(curatedOnly(key), null), true, "an unknown engine version still shows the card");
    }
    // omp lists "Ask and remember" in the approval-mode choices only from 18.12.3.
    const mode = schema.settings.find((entry) => entry.key === "tools.approvalMode");
    const modeValues = (mode.options ?? (mode.values ?? []).map((value) => ({ value }))).map((option) => option.value);
    assert.equal(modeValues.includes("always-ask-cached"), atLeast(version, "18.12.3"), `installed ${version}: always-ask-cached is offered only when the schema lists it`);
  } finally {
    if (previous === undefined) delete process.env.CODY_OMP_BIN;
    else process.env.CODY_OMP_BIN = previous;
  }
});

test("static search entries cover the curated-only cards rendered here, under the shared id scheme, plus the helper-memory card", () => {
  const ids = SEARCH_ENTRIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no id collides");
  assert.equal(ids.at(-1), "helper-agents-memory-limit", "the hand-built helper-memory card is searchable");
  const renderedCuratedOnly = RECOMMENDED_CARDS.filter((card) => CURATED_ONLY_KEYS.includes(card.key)).map((card) => card.key);
  assert.deepEqual(ids.slice(0, -1), renderedCuratedOnly.map((key) => `schema-${key}`));
  for (const entry of SEARCH_ENTRIES) {
    assert.equal(entry.tab, "engine");
    assert.equal(entry.needsCapability, "configEditor");
    assert.equal(entry.breadcrumb[2], "Recommended");
    assert.ok(entry.label && entry.description);
  }
  // retry.enabled is curated-only but rendered by the retry panel, not here.
  assert.equal(ids.includes("schema-retry.enabled"), false);
  assert.equal(searchIdForKey("advisor.enabled"), "schema-advisor.enabled", "a card takes the schema id, so a search jump lands on it");
  assert.equal(rowSearchIdBesideCard("advisor.enabled"), "schema-advisor.enabled-row");
});

test("a card's surface is available only where the engine renders it", () => {
  const omp = { configEditor: true, mcp: true, models: true };
  const pi = { configEditor: false, mcp: false, models: true };
  assert.equal(cardSurfaceAvailable("recommended", omp), true);
  assert.equal(cardSurfaceAvailable("mcp", omp), true);
  assert.equal(cardSurfaceAvailable("retry", omp), true);
  for (const surface of ["recommended", "mcp", "retry"]) assert.equal(cardSurfaceAvailable(surface, pi), false, `${surface} needs the config editor`);
  assert.equal(cardSurfaceAvailable("mcp", { ...omp, mcp: false }), false);
});
