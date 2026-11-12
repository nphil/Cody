import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";

const FAKE_BIN = ompTestPackageBin();
const skip = ompTestPackageSkip();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/** Point OMP's settings path at a throwaway file and load a fresh module graph
 * so each test writes in isolation. */
async function withSettings(initial, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-settings-values-"));
  const file = path.join(dir, "config.yml");
  if (initial !== null) fs.writeFileSync(file, initial, "utf8");
  const previousBin = process.env.CODY_OMP_BIN;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.CODY_OMP_BIN = FAKE_BIN;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const values = await jiti.import("./settings-values.ts");
    (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
    (await jiti.import("./settings-schema.ts")).clearOmpSettingsSchemaCache();
    await body(values, file);
  } finally {
    if (previousBin === undefined) delete process.env.CODY_OMP_BIN;
    else process.env.CODY_OMP_BIN = previousBin;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("round-trips a setting Cody never hand-listed", { skip }, async () => {
  await withSettings("", async ({ readSchemaSettings, writeSchemaSettings }, file) => {
    writeSchemaSettings({ "prewalk.enabled": true, "task.maxConcurrency": 3, "task.eager": "always" });
    const saved = fs.readFileSync(file, "utf8");
    // Dotted paths persist nested, the shape OMP's own resolver reads.
    assert.match(saved, /prewalk:\s*\n\s+enabled: true/);
    const { values } = readSchemaSettings();
    assert.equal(values["prewalk.enabled"], true);
    assert.equal(values["task.maxConcurrency"], 3);
    assert.equal(values["task.eager"], "always");
  });
});

test("preserves surrounding content and comments", { skip }, async () => {
  await withSettings("# hand written\npersonality: friendly\n", async ({ writeSchemaSettings }, file) => {
    writeSchemaSettings({ "prewalk.enabled": true });
    const saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /# hand written/);
    assert.match(saved, /personality: friendly/);
  });
});

test("rejects unknown paths and values the schema does not allow", { skip }, async () => {
  await withSettings("", async ({ writeSchemaSettings }, file) => {
    assert.throws(() => writeSchemaSettings({ "not.a.setting": true }), /Unknown setting/);
    assert.throws(() => writeSchemaSettings({ "task.eager": "sometimes" }), /must be one of/);
    assert.throws(() => writeSchemaSettings({ "prewalk.enabled": "yes" }), /must be a boolean/);
    // A rejected patch is all-or-nothing: nothing reached the file.
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "", "");
  });
});

test("resetting a setting removes it and prunes the emptied parent", { skip }, async () => {
  await withSettings("", async ({ readSchemaSettings, writeSchemaSettings }, file) => {
    writeSchemaSettings({ "prewalk.enabled": true });
    writeSchemaSettings({ "prewalk.enabled": null });
    const saved = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(saved, /prewalk/);
    assert.equal(readSchemaSettings().values["prewalk.enabled"], undefined);
  });
});

test("ignores a persisted value whose type contradicts the schema", { skip }, async () => {
  await withSettings("prewalk:\n  enabled: \"maybe\"\n", async ({ readSchemaSettings }) => {
    assert.equal(readSchemaSettings().values["prewalk.enabled"], undefined);
  });
});

test("contextFiles.extra takes bare file names only, the way omp validates them", { skip }, async () => {
  await withSettings("", async ({ readSchemaSettings, writeSchemaSettings }, file) => {
    // The key arrived with a newer engine; an older schema has nothing to validate.
    if (!readSchemaSettings().schema?.settings.some((setting) => setting.key === "contextFiles.extra")) return;
    assert.throws(() => writeSchemaSettings({ "contextFiles.extra": ["docs/AGENTS.local.md"] }), /must be file names, not paths \(docs\/AGENTS\.local\.md\)/);
    assert.throws(() => writeSchemaSettings({ "contextFiles.extra": ["..\\AGENTS.local.md"] }), /not paths/);
    assert.throws(() => writeSchemaSettings({ "contextFiles.extra": [".."] }), /not paths/);
    assert.throws(() => writeSchemaSettings({ "contextFiles.extra": ["   "] }), /must not be empty/);
    assert.throws(() => writeSchemaSettings({ "contextFiles.extra": ["Agents.MD"] }), /cannot list a built-in context file \(Agents\.MD\)/);
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "", "", "a rejected list never reaches the file");
    writeSchemaSettings({ "contextFiles.extra": [" AGENTS.local.md ", "NOTES.md"] });
    assert.deepEqual(readSchemaSettings().values["contextFiles.extra"], ["AGENTS.local.md", "NOTES.md"]);
    writeSchemaSettings({ "contextFiles.extra": [] });
    assert.deepEqual(readSchemaSettings().values["contextFiles.extra"], []);
  });
});

// --- saved-reset auto-redeem: omp 18.18.7 split `autoRedeem` per window --------

const NEW_KEYS = new Set(["codexResets", "claudeResets"].flatMap((group) => [`${group}.autoRedeem5h`, `${group}.autoRedeemWeekly`]));
const OLD_KEYS = new Set(["codexResets.autoRedeem", "claudeResets.autoRedeem"]);

test("legacy autoRedeem migrates into both windows exactly as the engine does", async () => {
  const { migrateLegacyAutoRedeem } = await jiti.import("./settings-values.ts");
  const windows = (data, group = "codexResets") => ({
    five: data[group]?.autoRedeem5h ?? data[`${group}.autoRedeem5h`],
    weekly: data[group]?.autoRedeemWeekly ?? data[`${group}.autoRedeemWeekly`],
    fable: data[group]?.autoRedeemFable ?? data[`${group}.autoRedeemFable`],
    legacy: data[group]?.autoRedeem ?? data[`${group}.autoRedeem`],
  });
  const expected = [[true, "yes"], [false, "no"], ["yes", "yes"], ["no", "no"], ["unset", "unset"]];
  for (const group of ["codexResets", "claudeResets"]) {
    for (const [legacy, mode] of expected) {
      const nestedForm = windows(migrateLegacyAutoRedeem({ [group]: { autoRedeem: legacy } }, NEW_KEYS), group);
      assert.deepEqual(nestedForm, { five: mode, weekly: mode, fable: undefined, legacy: undefined }, `${group} nested ${legacy}`);
      // A quoted dotted legacy key with no nested group is dead data for omp: nothing is filled.
      const flatForm = windows(migrateLegacyAutoRedeem({ [`${group}.autoRedeem`]: legacy }, NEW_KEYS), group);
      assert.deepEqual(flatForm, { five: undefined, weekly: undefined, fable: undefined, legacy: undefined }, `${group} flat ${legacy}`);
      // ... but with a nested group beside it the fill lands in that group.
      const flatBeside = windows(migrateLegacyAutoRedeem({ [group]: { keepCredits: 1 }, [`${group}.autoRedeem`]: legacy }, NEW_KEYS), group);
      assert.deepEqual(flatBeside, { five: mode, weekly: mode, fable: undefined, legacy: undefined }, `${group} flat beside nested ${legacy}`);
    }
  }
});

test("migration never overwrites a window key already set, and never touches Fable or other keys", async () => {
  const { migrateLegacyAutoRedeem } = await jiti.import("./settings-values.ts");
  // Nested legacy wins over the flat one.
  const both = migrateLegacyAutoRedeem({ codexResets: { autoRedeem: true }, "codexResets.autoRedeem": false }, NEW_KEYS);
  assert.equal(both.codexResets.autoRedeem5h, "yes");
  // An existing nested window key stays, the other window is filled.
  const keepNested = migrateLegacyAutoRedeem({ codexResets: { autoRedeem: true, autoRedeem5h: "no", keepCredits: 2 } }, NEW_KEYS);
  assert.deepEqual(keepNested.codexResets, { autoRedeem5h: "no", keepCredits: 2, autoRedeemWeekly: "yes" });
  // An existing flat window key blocks the fill for that window only.
  const keepFlat = migrateLegacyAutoRedeem({ claudeResets: { autoRedeem: "no" }, "claudeResets.autoRedeemWeekly": "yes" }, NEW_KEYS);
  assert.deepEqual(keepFlat.claudeResets, { autoRedeem5h: "no" });
  assert.equal(keepFlat["claudeResets.autoRedeemWeekly"], "yes");
  // Fable is a separate consent: never copied, never overwritten.
  const fable = migrateLegacyAutoRedeem({ claudeResets: { autoRedeem: true, autoRedeemFable: "no" } }, NEW_KEYS);
  assert.deepEqual(fable.claudeResets, { autoRedeemFable: "no", autoRedeem5h: "yes", autoRedeemWeekly: "yes" });
  // Another group and unrelated keys pass through; the input is not mutated.
  const input = { codexResets: { autoRedeem: true }, personality: "friendly", claudeResets: { keepCredits: 1 } };
  const snapshot = structuredClone(input);
  const out = migrateLegacyAutoRedeem(input, NEW_KEYS);
  assert.deepEqual(input, snapshot);
  assert.equal(out.personality, "friendly");
  assert.deepEqual(out.claudeResets, { keepCredits: 1 });
  // No legacy key anywhere: the very same object comes back.
  const plain = { codexResets: { autoRedeem5h: "yes" } };
  assert.equal(migrateLegacyAutoRedeem(plain, NEW_KEYS), plain);
});

test("an engine without the per-window keys (18.8.x) keeps its values untouched", async () => {
  const { migrateLegacyAutoRedeem } = await jiti.import("./settings-values.ts");
  const data = { codexResets: { autoRedeem: true }, "claudeResets.autoRedeem": "yes" };
  assert.equal(migrateLegacyAutoRedeem(data, OLD_KEYS), data);
  assert.deepEqual(data, { codexResets: { autoRedeem: true }, "claudeResets.autoRedeem": "yes" });
  // A schema with only one provider's per-window keys migrates only that provider.
  const half = migrateLegacyAutoRedeem({ codexResets: { autoRedeem: true }, claudeResets: { autoRedeem: true } }, new Set(["codexResets.autoRedeem5h", "codexResets.autoRedeemWeekly"]));
  assert.equal(half.codexResets.autoRedeem5h, "yes");
  assert.deepEqual(half.claudeResets, { autoRedeem: true });
});

test("the schema reader shows the migrated value on engines that have the window keys, and nothing new on older ones", { skip }, async () => {
  await withSettings("codexResets:\n  autoRedeem: \"yes\"\nclaudeResets:\n  keepCredits: 1\nclaudeResets.autoRedeem: \"no\"\n", async ({ readSchemaSettings }) => {
    const { schema, values } = readSchemaSettings();
    if (schema.settings.some((setting) => setting.key === "codexResets.autoRedeem5h")) {
      assert.equal(values["codexResets.autoRedeem5h"], "yes");
      assert.equal(values["codexResets.autoRedeemWeekly"], "yes");
      assert.equal(values["claudeResets.autoRedeem5h"], "no");
      assert.equal(values["claudeResets.autoRedeemWeekly"], "no");
      assert.equal(values["claudeResets.autoRedeemFable"], undefined, "Fable is never migrated");
      assert.equal(values["codexResets.autoRedeem"], undefined);
    } else {
      assert.equal(values["codexResets.autoRedeem5h"], undefined);
      assert.equal(values["codexResets.autoRedeemWeekly"], undefined);
      assert.equal(values["claudeResets.autoRedeem5h"], undefined);
      assert.equal(values["codexResets.autoRedeem"], "yes", "the single key stays as it is on 18.8.x");
    }
  });
});

test("saving one window key writes both windows out and drops the legacy key in the same write", { skip }, async () => {
  const initial = "# mine\ncodexResets:\n  autoRedeem: true\n  keepCredits: 2\nclaudeResets:\n  autoRedeem: false\npersonality: friendly\n";
  await withSettings(initial, async ({ readSchemaSettings, writeSchemaSettings }, file) => {
    if (!readSchemaSettings().schema.settings.some((setting) => setting.key === "codexResets.autoRedeem5h")) {
      // 18.8.x: the single key is the real setting and a write leaves it alone.
      writeSchemaSettings({ "codexResets.keepCredits": 3 });
      assert.match(fs.readFileSync(file, "utf8"), /autoRedeem: true/);
      return;
    }
    writeSchemaSettings({ "codexResets.autoRedeemWeekly": "no" });
    const saved = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(saved.split("claudeResets")[0], /autoRedeem: true/, "codex legacy key dropped");
    assert.match(saved, /# mine/);
    assert.match(saved, /personality: friendly/);
    assert.match(saved, /keepCredits: 2/);
    // The claude group was not part of the save: its legacy key is still there.
    assert.match(saved.split("claudeResets")[1], /autoRedeem: false/);
    const { values } = readSchemaSettings();
    assert.equal(values["codexResets.autoRedeem5h"], "yes", "the untouched window keeps the migrated consent");
    assert.equal(values["codexResets.autoRedeemWeekly"], "no", "the edited window takes the edit");
    assert.equal(values["codexResets.autoRedeemFable"], undefined);
    assert.equal(values["claudeResets.autoRedeem5h"], "no", "still migrated in memory for the group not saved");

    // Saving Fable on the Claude side also settles that group's 5h and weekly.
    writeSchemaSettings({ "claudeResets.autoRedeemFable": "yes" });
    const second = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(second, /autoRedeem: /);
    const after = readSchemaSettings().values;
    assert.equal(after["claudeResets.autoRedeem5h"], "no");
    assert.equal(after["claudeResets.autoRedeemWeekly"], "no");
    assert.equal(after["claudeResets.autoRedeemFable"], "yes");
  });
});

test("a save with the flat legacy key and an existing window key keeps that window", { skip }, async () => {
  await withSettings("codexResets.autoRedeem: true\ncodexResets:\n  autoRedeem5h: \"no\"\n", async ({ readSchemaSettings, writeSchemaSettings }, file) => {
    if (!readSchemaSettings().schema.settings.some((setting) => setting.key === "codexResets.autoRedeem5h")) return;
    writeSchemaSettings({ "codexResets.keepCredits": 1 });
    assert.match(fs.readFileSync(file, "utf8"), /codexResets\.autoRedeem:/, "an unrelated save leaves the legacy key for omp");
    writeSchemaSettings({ "codexResets.autoRedeemWeekly": "unset" });
    const saved = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(saved, /codexResets\.autoRedeem:/);
    const { values } = readSchemaSettings();
    assert.equal(values["codexResets.autoRedeem5h"], "no");
    assert.equal(values["codexResets.autoRedeemWeekly"], "unset");
  });
});

test("the migrated values match what the installed engine itself reports", { skip }, async () => {
  const cases = [
    "codexResets:\n  autoRedeem: true\nclaudeResets:\n  autoRedeem: false\n",
    "codexResets.autoRedeem: \"yes\"\nclaudeResets.autoRedeem: \"no\"\n",
    "codexResets:\n  autoRedeem: true\n  autoRedeem5h: \"no\"\nclaudeResets:\n  autoRedeem: \"yes\"\n  autoRedeemFable: \"no\"\n",
    "codexResets.autoRedeem: false\ncodexResets.autoRedeemWeekly: \"yes\"\nclaudeResets.autoRedeem: \"unset\"\n",
    "codexResets:\n  keepCredits: 1\ncodexResets.autoRedeem: true\nclaudeResets:\n  autoRedeem: \"no\"\nclaudeResets.autoRedeem: \"yes\"\n",
    "codexResets:\n  autoRedeem: false\nclaudeResets:\n  autoRedeem: \"yes\"\n  autoRedeemWeekly: \"unset\"\n",
  ];
  const keys = ["codexResets.autoRedeem5h", "codexResets.autoRedeemWeekly", "claudeResets.autoRedeem5h", "claudeResets.autoRedeemWeekly", "claudeResets.autoRedeemFable"];
  for (const initial of cases) {
    await withSettings(initial, async ({ readSchemaSettings }, file) => {
      const { schema, values } = readSchemaSettings();
      if (!schema.settings.some((setting) => setting.key === "codexResets.autoRedeem5h")) return;
      for (const key of keys) {
        const run = spawnSync(FAKE_BIN, ["config", "get", key], {
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, PI_CODING_AGENT_DIR: path.dirname(file), NO_COLOR: "1" },
        });
        assert.equal(run.status, 0, `omp config get ${key}: ${run.stderr}`);
        assert.equal(values[key] ?? "unset", run.stdout.trim(), `${key} for ${JSON.stringify(initial)}`);
      }
    });
  }
});

test("a dead flat legacy key is dropped on save without granting a consent the engine never acted on", { skip }, async () => {
  await withSettings("codexResets.autoRedeem: true\n", async ({ readSchemaSettings, writeSchemaSettings }, file) => {
    if (!readSchemaSettings().schema.settings.some((setting) => setting.key === "codexResets.autoRedeem5h")) return;
    assert.equal(readSchemaSettings().values["codexResets.autoRedeem5h"], undefined);
    writeSchemaSettings({ "codexResets.autoRedeemWeekly": "no" });
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /codexResets\.autoRedeem:/);
    const { values } = readSchemaSettings();
    assert.equal(values["codexResets.autoRedeem5h"], undefined, "5h stays unset: the engine was not spending on it");
    assert.equal(values["codexResets.autoRedeemWeekly"], "no");
  });
});

test("the checked-in schema key snapshot has the per-window keys and not the retired ones", async () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL("../harness/fixtures/omp-schema-keys.json", import.meta.url), "utf8"));
  for (const key of [...NEW_KEYS, "claudeResets.autoRedeemFable"]) assert.ok(snapshot.keys.includes(key), key);
  for (const key of OLD_KEYS) assert.equal(snapshot.keys.includes(key), false, key);
});
