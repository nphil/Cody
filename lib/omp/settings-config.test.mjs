import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { deleteNativeSettingsPaths, deleteNativeSettingsSections, readNativeSettings, writeNativeSettings } = await jiti.import("./settings-config.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "cody-settings-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uses config.yaml when the canonical config.yml is absent", () => {
  withAgentDir((dir) => {
    const fallback = join(dir, "config.yaml");
    writeFileSync(fallback, "compaction:\n  enabled: false\n", "utf8");
    assert.equal(readNativeSettings().path, fallback);
    assert.equal(readNativeSettings().settings.compaction.enabled, false);

    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(existsSync(join(dir, "config.yml")), false);
    assert.match(readFileSync(fallback, "utf8"), /hideThinkingBlock: true/);
  });
});

test("rejects malformed native settings and accepts OMP compaction method orders", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ mcp: { notifications: "yes" } }), /mcp.notifications must be a boolean/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["prune"] } }), /Invalid compaction method order/);
    writeNativeSettings({ compaction: { methodOrder: ["shake", "soft"], autoContinue: true } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["shake", "soft"]);
  });
});

test("maps pre-17.4 compaction strategy keys onto the effective method order", () => {
  withAgentDir((dir) => {
    // omp 17.4 replaced strategy/remoteEnabled with methodOrder and migrates
    // old configs itself; Cody mirrors that mapping when reading un-migrated
    // files so the UI shows the order omp will actually use.
    writeFileSync(join(dir, "config.yml"), "compaction:\n  strategy: handoff\n  remoteEnabled: false\n", "utf8");
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["handoff", "soft"]);

    // Writing the modern key removes the legacy ones (clean cutover).
    writeNativeSettings({ compaction: { methodOrder: ["snapcompact", "soft"] } });
    const raw = readFileSync(join(dir, "config.yml"), "utf8");
    assert.doesNotMatch(raw, /strategy:/);
    assert.doesNotMatch(raw, /remoteEnabled:/);
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["snapcompact", "soft"]);
  });
});

test("deletes whole sections and plan-owned paths for reset-to-defaults", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), [
      "hideThinkingBlock: true",
      "retry:",
      "  maxRetries: 3",
      "  usageAwareFallback: true",
      "  fallbackChains:",
      "    default: [openai/gpt-5]",
      "",
    ].join("\n"), "utf8");

    // Path-level reset drops only what the model plan wrote.
    assert.deepEqual(deleteNativeSettingsPaths(["retry.fallbackChains", "retry.usageAwareFallback"]).sort(), ["retry.fallbackChains", "retry.usageAwareFallback"]);
    assert.equal(readNativeSettings().settings.retry.maxRetries, 3);
    assert.equal(readNativeSettings().settings.retry.fallbackChains, undefined);

    // Section-level reset drops the whole block; unrelated keys survive.
    assert.deepEqual(deleteNativeSettingsSections(["retry"]), ["retry"]);
    assert.equal(readNativeSettings().settings.retry, undefined);
    assert.equal(readNativeSettings().settings.hideThinkingBlock, true);

    assert.throws(() => deleteNativeSettingsSections(["memory"]), /Not a resettable settings section/);
    assert.throws(() => deleteNativeSettingsPaths(["retry.maxRetries"]), /Not a resettable settings path/);
  });
});
test("persists and reads the externalThinking setting (v17.2.14+)", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ externalThinking: "yes" }), /externalThinking must be a boolean/);
    writeNativeSettings({ externalThinking: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    // Writes are incremental: an unrelated later write preserves the key.
    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    assert.equal(readNativeSettings().settings.hideThinkingBlock, true);
  });
});
test("persists and validates retry settings", () => {
  withAgentDir(() => {
    writeNativeSettings({ retry: { enabled: false, maxRetries: 3, modelFallback: true } });
    const settings = readNativeSettings().settings.retry;
    assert.equal(settings?.enabled, false);
    assert.equal(settings?.maxRetries, 3);
    assert.equal(settings?.modelFallback, true);
    assert.throws(() => writeNativeSettings({ retry: { maxRetries: 99 } }), /Retry attempts must be an integer between 0 and 20/);
  });
});
test("persists and validates tool approval policies", () => {
  withAgentDir(() => {
    writeNativeSettings({ tools: { approval: { bash: "deny", extension: "allow" } } });
    const settings = readNativeSettings().settings;
    assert.equal(settings.tools.approval.bash, "deny");
    assert.equal(settings.tools.approval.extension, "allow");
    assert.throws(() => writeNativeSettings({ tools: { approval: { bash: "bogus" } } }), /Invalid Bash approval policy/);
    assert.throws(() => writeNativeSettings({ tools: { approval: { extension: "deny" } } }), /Invalid extension tool approval policy/);
  });
});
