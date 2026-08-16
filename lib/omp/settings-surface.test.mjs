import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const FAKE_BIN = "/tmp/ompkg/package/bin/omp";
const skip = !fs.existsSync(FAKE_BIN) && "omp package not extracted";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadSchema() {
  process.env.CODY_OMP_BIN = FAKE_BIN;
  const { getOmpSettingsSchema, clearOmpSettingsSchemaCache } = await jiti.import("./settings-schema.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
  return getOmpSettingsSchema();
}

test("every terminal-only rule still matches the installed schema", { skip }, async () => {
  const schema = await loadSchema();
  const keys = new Set(schema.settings.map((setting) => setting.key));
  const { TERMINAL_ONLY_RULES } = await jiti.import("./settings-surface.ts");

  // A rule that matches nothing is a rule the harness renamed out from under
  // us — the badge would silently stop appearing for a setting that still does
  // nothing in the browser.
  for (const key of TERMINAL_ONLY_RULES.keys) {
    assert.ok(keys.has(key), `terminal-only key "${key}" is no longer in the schema`);
  }
  for (const prefix of TERMINAL_ONLY_RULES.prefixes) {
    assert.ok(
      [...keys].some((key) => key.startsWith(prefix)),
      `terminal-only prefix "${prefix}" no longer matches any setting`,
    );
  }
});

test("classifies terminal chrome without catching settings the browser uses", { skip }, async () => {
  const { isTerminalOnlySetting } = await jiti.import("./settings-surface.ts");

  for (const key of ["theme.dark", "statusLine.preset", "tui.tight", "display.shimmer", "startup.showSplash", "symbolPreset"]) {
    assert.equal(isTerminalOnlySetting(key), true, `${key} should be terminal-only`);
  }
  // These drive the agent itself and reach Cody's UI, so they must stay unmarked.
  for (const key of ["prewalk.enabled", "task.eager", "compaction.enabled", "memory.backend", "tools.approvalMode", "defaultThinkingLevel"]) {
    assert.equal(isTerminalOnlySetting(key), false, `${key} must not be marked terminal-only`);
  }
  // Prefixes match on the dotted path, not a bare substring.
  assert.equal(isTerminalOnlySetting("mytui.thing"), false);
});
