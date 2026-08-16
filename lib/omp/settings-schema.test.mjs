import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const FAKE_BIN = "/tmp/ompkg/package/bin/omp";
const hasPackage = fs.existsSync(FAKE_BIN);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("reads OMP's own schema, including groups Cody never hand-listed", { skip: !hasPackage && "omp package not extracted" }, async () => {
  process.env.CODY_OMP_BIN = FAKE_BIN;
  const { getOmpSettingsSchema, clearOmpSettingsSchemaCache } = await jiti.import("./settings-schema.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
  const schema = getOmpSettingsSchema();
  assert.ok(schema, "schema loaded from the installed package");

  // Every tab OMP declares, in its order, with its labels.
  assert.ok(schema.tabs.length >= 8, `expected OMP's tabs, got ${schema.tabs.length}`);
  assert.equal(schema.tabs[0].id, "appearance");
  assert.ok(schema.settings.length > 200, `expected the full schema, got ${schema.settings.length}`);

  const byKey = new Map(schema.settings.map((s) => [s.key, s]));

  // The gaps that motivated this: a whole group and a whole section.
  const prewalk = byKey.get("prewalk.enabled");
  assert.ok(prewalk, "prewalk.enabled present");
  assert.equal(prewalk.tab, "model");
  assert.equal(prewalk.group, "Prewalk");
  assert.equal(prewalk.type, "boolean");
  assert.ok(schema.groups.model.includes("Prewalk"), "Prewalk section registered on the model tab");

  for (const key of ["task.eager", "task.prewalk", "task.maxConcurrency", "task.maxRecursionDepth"]) {
    const setting = byKey.get(key);
    assert.ok(setting, `${key} present`);
    assert.equal(setting.tab, "tasks");
    assert.equal(setting.group, "Subagents");
  }
  assert.ok(schema.groups.tasks.includes("Subagents"), "Subagents section registered on the tasks tab");

  // Enum options survive as real literals, so a select can be rendered.
  const eager = byKey.get("task.eager");
  assert.ok(eager.options?.some((o) => o.value === "always"), "enum options preserved");
});

test("never exposes credentials or settings OMP itself hides", { skip: !hasPackage && "omp package not extracted" }, async () => {
  process.env.CODY_OMP_BIN = FAKE_BIN;
  const { getOmpSettingsSchema, clearOmpSettingsSchemaCache } = await jiti.import("./settings-schema.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
  const schema = getOmpSettingsSchema();
  const keys = new Set(schema.settings.map((s) => s.key));
  // Records without ui metadata are config-file-only upstream.
  assert.equal(keys.has("task.agentAdvisor"), false, "config-file-only setting stays hidden");
  assert.equal(keys.has("task.agentPrewalk"), false);
  for (const setting of schema.settings) {
    assert.ok(setting.label && setting.tab, `${setting.key} carries its declared metadata`);
  }
});

test("degrades to null when omp is absent rather than throwing", async () => {
  process.env.CODY_OMP_BIN = "/nonexistent/omp";
  const { getOmpSettingsSchema, clearOmpSettingsSchemaCache } = await jiti.import("./settings-schema.ts");
  // The binary probe memoizes a hit for the process lifetime, so an earlier
  // test's resolved path would otherwise survive this override.
  const { invalidateOmpCliCache } = await jiti.import("./omp-cli.ts");
  invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
  assert.equal(getOmpSettingsSchema(), null);
  delete process.env.CODY_OMP_BIN;
  invalidateOmpCliCache();
});
