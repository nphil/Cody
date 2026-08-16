import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const FAKE_BIN = "/tmp/ompkg/package/bin/omp";
const skip = !fs.existsSync(FAKE_BIN) && "omp package not extracted";

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
