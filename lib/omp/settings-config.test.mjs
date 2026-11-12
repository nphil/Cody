import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { CURATED_RESETTABLE_PATHS, deleteNativeSettingsPaths, deleteNativeSettingsSections, readNativeSettings, writeNativeSettings } = await jiti.import("./settings-config.ts");

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

test("approval mode always-ask-cached survives read and write, and an unknown mode still throws", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "tools:\n  approvalMode: always-ask-cached\n", "utf8");
    assert.equal(readNativeSettings().settings.tools.approvalMode, "always-ask-cached", "the typed read keeps it");
    writeNativeSettings({ tools: { approvalMode: "yolo" } });
    assert.equal(readNativeSettings().settings.tools.approvalMode, "yolo");
    writeNativeSettings({ tools: { approvalMode: "always-ask-cached" } });
    assert.equal(readNativeSettings().settings.tools.approvalMode, "always-ask-cached", "the write round-trips it");
    assert.match(readFileSync(join(dir, "config.yml"), "utf8"), /approvalMode: always-ask-cached/);
    assert.throws(() => writeNativeSettings({ tools: { approvalMode: "sometimes" } }), /Invalid approval mode/);
  });
});

test("every tools.approval entry in the file survives a typed read and save, computer.control included", () => {
  withAgentDir((dir) => {
    const file = join(dir, "config.yml");
    writeFileSync(file, "tools:\n  approval:\n    bash: prompt\n    computer.control: allow\n    web_search: deny\n", "utf8");
    const settings = readNativeSettings().settings;
    assert.equal(settings.tools.approval["computer.control"], "allow");
    assert.equal(settings.tools.approval.web_search, "deny");
    // A client saves the object it read back (patchApproval spreads it).
    writeNativeSettings({ tools: { approval: { ...settings.tools.approval, bash: "deny" } } });
    const saved = readNativeSettings().settings.tools.approval;
    assert.deepEqual(saved, { bash: "deny", "computer.control": "allow", web_search: "deny" });
    assert.match(readFileSync(file, "utf8"), /computer\.control: allow/, "stored as one flat key, the shape omp reads");
    // A save that mentions only bash leaves the other entries untouched.
    writeNativeSettings({ tools: { approval: { bash: "allow" } } });
    assert.equal(readNativeSettings().settings.tools.approval["computer.control"], "allow");
    writeNativeSettings({ tools: { approval: { "computer.control": "deny" } } });
    assert.equal(readNativeSettings().settings.tools.approval["computer.control"], "deny");
    assert.throws(() => writeNativeSettings({ tools: { approval: { "computer.control": "maybe" } } }), /Invalid approval policy for computer\.control/);
  });
});

test("session spend caps read, write and reset as positive USD amounts, beside keys Cody does not type", () => {
  withAgentDir((dir) => {
    const file = join(dir, "config.yml");
    writeFileSync(file, "session:\n  maxCost: 12.5\n  worktreeScope: tree\nbash:\n  gitGuard: true\ntools:\n  restrictedFolders:\n    - ~/secrets\n", "utf8");
    assert.deepEqual(readNativeSettings().settings.session, { maxCost: 12.5 });
    writeNativeSettings({ session: { warnCost: 5 } });
    assert.deepEqual(readNativeSettings().settings.session, { warnCost: 5, maxCost: 12.5 });
    const text = readFileSync(file, "utf8");
    assert.match(text, /worktreeScope: tree/, "a neighbouring session key stays");
    assert.match(text, /gitGuard: true/, "bash.gitGuard stays");
    assert.match(text, /restrictedFolders:\s*\n\s+- ~\/secrets/, "tools.restrictedFolders stays");
    for (const bad of [0, -1, Number.NaN, "5"]) {
      assert.throws(() => writeNativeSettings({ session: { maxCost: bad } }), /session\.maxCost must be a positive USD amount/);
    }
    assert.deepEqual(deleteNativeSettingsPaths(["session.maxCost"]), ["session.maxCost"]);
    assert.deepEqual(readNativeSettings().settings.session, { warnCost: 5 });
  });
});

test("resets each curated-only Recommended key individually, leaving its neighbours", () => {
  withAgentDir((dir) => {
    writeFileSync(
      join(dir, "config.yml"),
      [
        "defaultThinkingLevel: low",
        "tools:",
        "  approvalMode: yolo",
        "  approval:",
        "    bash: deny",
        "    extension: allow",
        "advisor:",
        "  enabled: true",
        "  subagents: true",
        "compaction:",
        "  enabled: false",
        "  autoContinue: false",
        "  keepRecentTokens: 1234",
        "autolearn:",
        "  minToolCalls: 7",
        "retry:",
        "  enabled: false",
        "  maxRetries: 4",
        "session:",
        "  warnCost: 2",
        "  maxCost: 9",
        "",
      ].join("\n"),
      "utf8",
    );
    // Every curated-only key is resettable on its own; a top-level key and a
    // doubly nested one both go through the same path form.
    assert.deepEqual(deleteNativeSettingsPaths(["defaultThinkingLevel", "tools.approval.bash"]).sort(), ["defaultThinkingLevel", "tools.approval.bash"]);
    const after = readNativeSettings().settings;
    assert.equal(after.defaultThinkingLevel, undefined);
    assert.equal(after.tools?.approval?.bash, undefined);
    // The siblings in the same sections survive.
    assert.equal(after.tools?.approvalMode, "yolo");
    assert.equal(after.tools?.approval?.extension, "allow");
    assert.equal(after.retry?.maxRetries, 4);
    // The remaining curated keys are resettable too, and nothing beyond them.
    const rest = CURATED_RESETTABLE_PATHS.filter((path) => path !== "defaultThinkingLevel" && path !== "tools.approval.bash");
    assert.deepEqual(deleteNativeSettingsPaths(rest).sort(), [...rest].sort());
    assert.throws(() => deleteNativeSettingsPaths(["tools.approvalMode"]), /Not a resettable settings path/);
  });
});

test("review-subagents toggle lives in task.agentAdvisor.task, never in the legacy advisor.subagents key", () => {
  withAgentDir((dir) => {
    const file = join(dir, "config.yml");
    // A legacy config omp has not migrated yet still reads.
    writeFileSync(file, "advisor:\n  enabled: true\n  subagents: true\n", "utf8");
    assert.equal(readNativeSettings().settings.advisor.subagents, true);

    // Writing stores the real key, drops the stale legacy one, keeps neighbours.
    writeNativeSettings({ advisor: { subagents: false } });
    const written = readFileSync(file, "utf8");
    assert.match(written, /agentAdvisor:\s*\n\s+task: "?off"?/);
    assert.doesNotMatch(written, /subagents/);
    assert.equal(readNativeSettings().settings.advisor.subagents, false);
    assert.equal(readNativeSettings().settings.advisor.enabled, true);

    // Turning it on keeps a model pattern the user picked in a terminal.
    writeFileSync(file, "task:\n  agentAdvisor:\n    task: anthropic/claude-opus\n    scout: off\n", "utf8");
    assert.equal(readNativeSettings().settings.advisor.subagents, true);
    writeNativeSettings({ advisor: { subagents: true } });
    assert.match(readFileSync(file, "utf8"), /task: anthropic\/claude-opus/);

    // Reset drops only the generic-agent override and tidies nothing else away.
    assert.deepEqual(deleteNativeSettingsPaths(["advisor.subagents"]), ["advisor.subagents"]);
    assert.match(readFileSync(file, "utf8"), /scout: off/);
    assert.equal(readNativeSettings().settings.advisor?.subagents, undefined);
    writeFileSync(file, "task:\n  agentAdvisor:\n    task: on\nretry:\n  enabled: false\n", "utf8");
    deleteNativeSettingsPaths(["advisor.subagents"]);
    assert.doesNotMatch(readFileSync(file, "utf8"), /task|agentAdvisor/);
  });
});

test("writes the review-subagents toggle into a brand-new config file too", () => {
  withAgentDir((dir) => {
    writeNativeSettings({ advisor: { subagents: true } });
    const text = readFileSync(join(dir, "config.yml"), "utf8");
    assert.match(text, /agentAdvisor:\s*\n\s+task: on/);
    assert.doesNotMatch(text, /subagents/);
  });
});

test("accepts the sharpshooter memory backend", () => {
  withAgentDir(() => {
    writeNativeSettings({ memory: { backend: "sharpshooter" } });
    assert.equal(readNativeSettings().settings.memory.backend, "sharpshooter");
    assert.throws(() => writeNativeSettings({ memory: { backend: "bogus" } }), /Invalid memory backend/);
  });
});

test("the per-agent compaction map is read and replaced whole, leaving the advisor override and other keys alone", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), [
      "task:",
      "  agentAdvisor:",
      "    task: \"on\"",
      "  agentCompactionThresholdOverrides:",
      "    task: 20%",
      "    deep-task: 30%",
      "    custom-agent: 90000",
      "compaction:",
      "  experimentalContextManagement: true",
      "",
    ].join("\n"), "utf8");
    const read = readNativeSettings().settings;
    assert.deepEqual(read.task.agentCompactionThresholdOverrides, { task: "20%", "deep-task": "30%", "custom-agent": 90000 });
    assert.equal(read.compaction.experimentalContextManagement, true);
    assert.equal(read.advisor.subagents, true);

    // Leaving an agent out removes it; the unrelated advisor override is untouched.
    writeNativeSettings({ task: { agentCompactionThresholdOverrides: { task: "25%", "custom-agent": 90000 } } });
    assert.deepEqual(readNativeSettings().settings.task.agentCompactionThresholdOverrides, { task: "25%", "custom-agent": 90000 });
    assert.match(readFileSync(join(dir, "config.yml"), "utf8"), /agentAdvisor:\n\s+task: "?on"?/);

    // An empty map drops the key and nothing else.
    writeNativeSettings({ task: { agentCompactionThresholdOverrides: {} } });
    assert.equal(readNativeSettings().settings.task, undefined);
    assert.equal(readNativeSettings().settings.advisor.subagents, true);

    writeNativeSettings({ compaction: { experimentalContextManagement: false } });
    assert.equal(readNativeSettings().settings.compaction.experimentalContextManagement, false);
  });
});

test("a per-agent compaction entry omp would reject is refused, and a first write to an empty config keeps both task keys", () => {
  withAgentDir((dir) => {
    assert.throws(() => writeNativeSettings({ task: { agentCompactionThresholdOverrides: { task: "0%" } } }), /task\.agentCompactionThresholdOverrides\.task/);
    assert.throws(() => writeNativeSettings({ task: { agentCompactionThresholdOverrides: { task: "101%" } } }), /percentage/);
    assert.throws(() => writeNativeSettings({ task: { agentCompactionThresholdOverrides: { task: 1.5 } } }), /token count/);
    writeNativeSettings({ advisor: { subagents: true }, task: { agentCompactionThresholdOverrides: { task: "20%" } } });
    assert.match(readFileSync(join(dir, "config.yml"), "utf8"), /agentAdvisor/);
    assert.deepEqual(readNativeSettings().settings.task.agentCompactionThresholdOverrides, { task: "20%" });
    assert.equal(readNativeSettings().settings.advisor.subagents, true);
  });
});
