import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";

/**
 * Every curated key round-trips through omp's config.yml the way the Behavior
 * hub writes it: a key the installed engine DECLARES goes through the schema
 * patch (`writeSchemaSettings`, what PUT /api/omp-settings/schema runs) and
 * anything left goes through the section spread (`writeNativeSettings`, what
 * PUT /api/omp-settings runs) — then read back through BOTH readers, because
 * the two layers of the hub show the same file and must agree. Includes
 * `compaction.methodOrder` and the legacy `strategy`/`remoteEnabled` keys the
 * native reader still migrates.
 *
 * Which side of the split a key falls on is DERIVED, never a constant: the
 * hub prefers a schema row and uses the curated table only as the fallback
 * (RecommendedSettings' RecommendedCardView), so an engine that starts
 * declaring a curated-only key simply moves it. 18.2.5 moved two.
 */
const FAKE_BIN = ompTestPackageBin();
const skip = ompTestPackageSkip();

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
/** Curated keys that only exist from omp 18.3 (mirrors components/recommended-cards.test.mjs). */
const INTRODUCED_IN_183 = ["advisor.evictStaleResults", "mcp.startupTimeoutMs"];

/** Point omp's settings path at a throwaway file and load a fresh module graph. */
async function withConfig(initial, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-recommended-roundtrip-"));
  const file = path.join(dir, "config.yml");
  if (initial !== null) fs.writeFileSync(file, initial, "utf8");
  const previousBin = process.env.CODY_OMP_BIN;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.CODY_OMP_BIN = FAKE_BIN;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const values = await jiti.import("./settings-values.ts");
    const config = await jiti.import("./settings-config.ts");
    const cards = await jiti.import("../../components/settings/engine/recommended-cards.ts");
    (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
    (await jiti.import("./settings-schema.ts")).clearOmpSettingsSchemaCache();
    await body({ ...values, ...config, ...cards }, file);
  } finally {
    if (previousBin === undefined) delete process.env.CODY_OMP_BIN;
    else process.env.CODY_OMP_BIN = previousBin;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A non-default, schema-valid value for a declared setting. */
function sampleFor(setting) {
  const options = setting.options?.map((option) => option.value) ?? setting.values ?? [];
  switch (setting.type) {
    case "boolean":
      return setting.default === true ? false : true;
    case "number":
      if (options.length > 0) return Number(options.find((value) => Number(value) !== setting.default) ?? options[0]);
      return typeof setting.default === "number" ? setting.default + 1 : 7;
    case "enum":
      return options.find((value) => value !== setting.default) ?? options[0];
    case "array":
      return ["handoff", "soft"];
    default:
      return "round-trip";
  }
}

/** Where a curated-only key lands in the NativeSettings object. */
function readNativePath(settings, meta) {
  let node = settings;
  for (const segment of meta.section ? [...meta.section.split("."), meta.field] : [meta.field]) {
    if (!node || typeof node !== "object") return undefined;
    node = node[segment];
  }
  return node;
}

function nativeSampleFor(meta) {
  if (meta.type === "boolean") return meta.default === true ? false : true;
  if (meta.type === "enum") return meta.options.find((option) => option.value !== meta.default).value;
  return meta.default + (meta.step ?? 1);
}

test("schema-declared curated keys write through the schema patch and read back through both readers", { skip }, async () => {
  await withConfig("", async ({ ALL_CURATED_CARDS, CURATED_ONLY_KEYS, readSchemaSettings, writeSchemaSettings, readNativeSettings }, file) => {
    const { schema } = readSchemaSettings();
    assert.ok(schema, "schema read from the package");
    const declared = ALL_CURATED_CARDS.map((card) => schema.settings.find((setting) => setting.key === card.key)).filter(Boolean);
    assert.ok(declared.length > 0, "the engine declares curated keys");
    // A card for a key omp 18.3 introduced hides itself on an older engine (no
    // schema row, nothing to bind), so it is only required from 18.3 on —
    // the same set components/recommended-cards.test.mjs sets aside.
    const version = await (await jiti.import("./omp-cli.ts")).getOmpVersion();
    const [major = 0, minor = 0] = (version ?? "").split(".").map(Number);
    const before183 = major < 18 || (major === 18 && minor < 3);
    for (const card of ALL_CURATED_CARDS) {
      const renderable = declared.some((setting) => setting.key === card.key) || CURATED_ONLY_KEYS.includes(card.key);
      if (!renderable && before183 && INTRODUCED_IN_183.includes(card.key)) continue;
      assert.ok(renderable, `${card.key} has neither a schema row nor a curated-only entry, so its card cannot render`);
    }

    const patch = Object.fromEntries(declared.map((setting) => [setting.key, sampleFor(setting)]));
    const written = writeSchemaSettings(patch);
    assert.equal(written.length, declared.length, "every declared key was accepted in one patch");

    const { values } = readSchemaSettings();
    for (const [key, value] of Object.entries(patch)) {
      assert.deepEqual(values[key], value, `${key} reads back through the schema reader`);
    }
    // The native reader sees the same file: every key it knows agrees.
    const { settings } = readNativeSettings();
    assert.equal(settings.tools.approvalMode, patch["tools.approvalMode"]);
    assert.equal(settings.textVerbosity, patch.textVerbosity);
    assert.equal(settings.personality, patch.personality);
    assert.equal(settings.hideThinkingBlock, patch.hideThinkingBlock);
    assert.equal(settings.externalThinking, patch.externalThinking);
    assert.equal(settings.advisor.enabled, patch["advisor.enabled"]);
    assert.equal(settings.advisor.syncBacklog, patch["advisor.syncBacklog"]);
    assert.equal(settings.advisor.immuneTurns, patch["advisor.immuneTurns"]);
    assert.equal(settings.compaction.enabled, patch["compaction.enabled"]);
    assert.equal(settings.compaction.midTurnEnabled, patch["compaction.midTurnEnabled"]);
    assert.deepEqual(settings.compaction.methodOrder, ["handoff", "soft"]);
    assert.equal(settings.memory.backend, patch["memory.backend"]);
    assert.equal(settings.autolearn.enabled, patch["autolearn.enabled"]);
    assert.equal(settings.autolearn.autoContinue, patch["autolearn.autoContinue"]);
    assert.equal(settings.mnemopi.scoping, patch["mnemopi.scoping"]);
    assert.equal(settings.mnemopi.autoRecall, patch["mnemopi.autoRecall"]);
    assert.equal(settings.mnemopi.autoRetain, patch["mnemopi.autoRetain"]);
    assert.equal(settings.mnemopi.noEmbeddings, patch["mnemopi.noEmbeddings"]);
    assert.equal(settings.mcp.enableProjectConfig, patch["mcp.enableProjectConfig"]);
    assert.equal(settings.mcp.renderMarkdownResults, patch["mcp.renderMarkdownResults"]);
    assert.equal(settings.mcp.notifications, patch["mcp.notifications"]);
    assert.equal(settings.mcp.notificationDebounceMs, patch["mcp.notificationDebounceMs"]);
    assert.equal(settings.retry.maxRetries, patch["retry.maxRetries"]);
    assert.equal(settings.retry.modelFallback, patch["retry.modelFallback"]);

    // Dotted paths persist nested — the shape omp's own resolver reads.
    const saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /compaction:\s*\n(?:\s+.*\n)*?\s+methodOrder:/);
    assert.doesNotMatch(saved, /^"?compaction\.enabled"?:/m, "no flat dotted keys");

    // Reset ({key: null}) drops each override again and prunes what it empties.
    writeSchemaSettings(Object.fromEntries(declared.map((setting) => [setting.key, null])));
    assert.deepEqual(readSchemaSettings().values, {});
    // Every pruned parent is gone; the writer leaves an empty mapping behind.
    assert.match(fs.readFileSync(file, "utf8").trim(), /^(\{\})?$/);
  });
});

test("curated-only keys write through the section spread and read back through the native reader", { skip }, async () => {
  await withConfig("# kept\npersonality: friendly\n", async ({ CURATED_ONLY, readNativeSettings, writeNativeSettings, readSchemaSettings }, file) => {
    assert.ok(CURATED_ONLY.length > 0, "the curated-only fallback table is not empty");
    // The hub's writer spreads the SECTION under its key (never the whole
    // object into a section): reproduce that shape for every table entry.
    const base = readNativeSettings().settings;
    const next = structuredClone(base);
    const expected = {};
    for (const meta of CURATED_ONLY) {
      const value = nativeSampleFor(meta);
      expected[meta.key] = value;
      if (meta.section === null) next[meta.field] = value;
      else {
        const segments = meta.section.split(".");
        let node = next;
        for (const segment of segments) {
          node[segment] = node[segment] ?? {};
          node = node[segment];
        }
        node[meta.field] = value;
      }
    }
    writeNativeSettings(next);

    const { settings } = readNativeSettings();
    for (const meta of CURATED_ONLY) {
      assert.deepEqual(readNativePath(settings, meta), expected[meta.key], `${meta.key} reads back`);
    }
    // The schema reader ignores keys it does not declare and keeps working. A
    // key the engine DOES declare is read by both layers, which is the state
    // the hub prefers — so only the undeclared ones must be absent.
    const { values, schema } = readSchemaSettings();
    const declaredKeys = new Set((schema?.settings ?? []).map((setting) => setting.key));
    for (const meta of CURATED_ONLY) {
      if (declaredKeys.has(meta.key)) continue;
      assert.equal(meta.key in values, false, `${meta.key} is not a schema value`);
    }
    // The hand-written line survives the section write.
    const saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /# kept/);
    assert.match(saved, /personality: friendly/);
    assert.match(saved, /tools:\s*\n\s+approval:\s*\n\s+bash: (allow|deny)/);
  });
});

test("compaction.methodOrder survives both writers, and legacy strategy keys still read as an order", { skip }, async () => {
  await withConfig("compaction:\n  strategy: handoff\n  remoteEnabled: false\n", async ({ readNativeSettings, readSchemaSettings, writeSchemaSettings, writeNativeSettings }, file) => {
    // The native reader migrates the pre-17.4 keys the way omp does.
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["handoff", "soft"]);
    // The schema reader sees no methodOrder yet: nothing is persisted under it.
    assert.equal(readSchemaSettings().values["compaction.methodOrder"], undefined);

    // Writing the order through the schema patch lands the 17.4+ key; the
    // native writer's clean cutover then removes the legacy pair.
    writeSchemaSettings({ "compaction.methodOrder": ["snapcompact", "remote", "soft"] });
    assert.deepEqual(readSchemaSettings().values["compaction.methodOrder"], ["snapcompact", "remote", "soft"]);
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["snapcompact", "remote", "soft"]);

    writeNativeSettings({ compaction: { methodOrder: ["shake", "soft"], autoContinue: false } });
    const saved = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(saved, /strategy:|remoteEnabled:/, "legacy keys are gone after the cutover");
    assert.deepEqual(readSchemaSettings().values["compaction.methodOrder"], ["shake", "soft"]);
    assert.equal(readNativeSettings().settings.compaction.autoContinue, false);
  });
});
