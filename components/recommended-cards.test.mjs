import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

import { ompTestPackageBin } from "../lib/omp/omp-test-package.mjs";
/**
 * The Behavior hub's Recommended layer is data: 28 cards in five groups,
 * plus 5 MCP cards and 3 Retry cards — 36 keys in the shared setting space.
 * Every card resolves its copy from the engine's schema at render time,
 * except the eight keys OMP keeps config-file only, whose copy lives in
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
  CURATED_ONLY, CURATED_ONLY_KEYS, SEARCH_ENTRIES, cardOwner, cardSurfaceAvailable, curatedOnly,
  rowSearchIdBesideCard, searchIdForKey,
} = cards;

const snapshot = JSON.parse(await readFile(new URL("../lib/harness/fixtures/omp-schema-keys.json", import.meta.url), "utf8"));
const SNAPSHOT_KEYS = new Set(snapshot.keys);
const INTRODUCED_IN_183 = ["advisor.evictStaleResults", "mcp.startupTimeoutMs"];

const EXPECTED_GROUP_SIZES = { safety: 3, thinking: 5, advisor: 5, context: 7, memory: 8 };
const CONTROLS = new Set(["select", "toggle", "number", "methodOrder"]);

test("the five groups hold 28 cards, in the spec's sizes, with no duplicate keys", () => {
  assert.deepEqual(RECOMMENDED_GROUPS.map((group) => group.id), Object.keys(EXPECTED_GROUP_SIZES));
  for (const [group, size] of Object.entries(EXPECTED_GROUP_SIZES)) {
    assert.equal(RECOMMENDED_CARDS.filter((card) => card.group === group).length, size, `${group} holds ${size} cards`);
  }
  assert.equal(RECOMMENDED_CARDS.length, 28);
  assert.equal(MCP_CARDS.length, 5);
  assert.equal(RETRY_CARDS.length, 3);
  assert.equal(ALL_CURATED_CARDS.length, 36, "36 keys across the three surfaces");
  assert.equal(new Set(ALL_CURATED_CARDS.map((card) => card.key)).size, 36, "no key appears on two surfaces");
  for (const card of ALL_CURATED_CARDS) {
    assert.match(card.key, /^[a-zA-Z][\w.]*$/, `${card.key} is a dotted config path`);
    if (card.control) assert.ok(CONTROLS.has(card.control), `${card.key}: unknown control ${card.control}`);
    // No label or description overrides: the engine's schema owns the copy.
    assert.deepEqual(Object.keys(card).filter((field) => !["key", "group", "control", "hint"].includes(field)), [], `${card.key} carries only key/group/control/hint`);
  }
});

test("retry keys are not Recommended, MCP keys are not rendered here, and both stay in the key space", () => {
  const recommended = new Set(RECOMMENDED_CARDS.map((card) => card.key));
  for (const key of ["retry.enabled", "retry.maxRetries", "retry.modelFallback"]) {
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

test("the 28/8 split holds against the checked-in schema key snapshot, once 18.3-only cards are set aside", () => {
  // The frozen snapshot predates OMP 18.3, so INTRODUCED_IN_183 can never
  // appear in it. Confirm they are exactly the cards that are missing, then
  // check the 28/8 split on everything the snapshot could have declared.
  const newerThanSnapshot = ALL_CURATED_CARDS.filter((card) => !SNAPSHOT_KEYS.has(card.key) && INTRODUCED_IN_183.includes(card.key)).map((card) => card.key);
  assert.deepEqual(newerThanSnapshot.sort(), [...INTRODUCED_IN_183].sort(), "every 18.3-only card is absent from the pre-18.3 snapshot, and nothing else is");
  const rest = ALL_CURATED_CARDS.filter((card) => !INTRODUCED_IN_183.includes(card.key));
  const schemaDeclared = rest.filter((card) => SNAPSHOT_KEYS.has(card.key)).map((card) => card.key);
  const curatedOnlyKeys = rest.filter((card) => !SNAPSHOT_KEYS.has(card.key)).map((card) => card.key);
  assert.equal(schemaDeclared.length, 28 - INTRODUCED_IN_183.length, `${28 - INTRODUCED_IN_183.length} pre-18.3 schema-declared keys; got ` + schemaDeclared.length + ": " + schemaDeclared.join(", "));
  assert.deepEqual(curatedOnlyKeys.sort(), [...CURATED_ONLY_KEYS].sort(), "the keys the snapshot lacks are exactly the curated-only table");
  assert.equal(CURATED_ONLY.length, 8);
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
    // OMP 18.3 added these controls. With 18.2 they have no schema row or
    // fallback writer, so the renderer keeps them hidden instead of saving
    // settings the installed engine does not support.
    assert.ok(declared.length > 0, `installed ${schema.source.version}: no curated key is schema-declared`);
    const [major, minor] = schema.source.version?.split(".").map(Number) ?? [];
    const supports183 = major > 18 || (major === 18 && minor >= 3);
    const missing183 = missing.filter((key) => INTRODUCED_IN_183.includes(key)).sort();
    assert.deepEqual(missing183, supports183 ? [] : [...INTRODUCED_IN_183].sort(), `installed ${schema.source.version}: versioned cards match engine support`);
    const unrenderable = missing.filter((key) => !CURATED_ONLY_KEYS.includes(key) && !INTRODUCED_IN_183.includes(key));
    assert.deepEqual(unrenderable, [], `installed ${schema.source.version}: curated cards with neither a schema row nor a curated-only entry`);
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
  } finally {
    if (previous === undefined) delete process.env.CODY_OMP_BIN;
    else process.env.CODY_OMP_BIN = previous;
  }
});

test("static search entries cover exactly the curated-only cards rendered here, under the shared id scheme", () => {
  const ids = SEARCH_ENTRIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no id collides");
  const renderedCuratedOnly = RECOMMENDED_CARDS.filter((card) => CURATED_ONLY_KEYS.includes(card.key)).map((card) => card.key);
  assert.deepEqual(ids, renderedCuratedOnly.map((key) => `schema-${key}`));
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
