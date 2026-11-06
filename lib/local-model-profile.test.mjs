import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parse } from "yaml";

const agentDir = mkdtempSync(join(tmpdir(), "cody-local-profile-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CONFIG_FILES = "";

writeFileSync(join(agentDir, "models.yml"), `providers:
  llama-swap:
    baseUrl: http://192.168.1.69:9292/v1
    auth: none
    api: openai-completions
    models:
      - id: qwen-small
        contextWindow: 8192
        maxTokens: 2048
  cloud:
    baseUrl: https://api.example.test/v1
    auth: none
    api: openai-completions
    models:
      - id: same-window
        contextWindow: 8192
        maxTokens: 2048
`);
writeFileSync(join(agentDir, "config.yml"), "disabledExtensions:\n  - custom-extension\n");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const profiles = await jiti.import("./local-model-profile.ts");
const runtime = await jiti.import("./local-model-profile-runtime.ts");
const store = await jiti.import("./local-model-profile-store.ts");

test("8k local profiles use only read and bash and suppress context files", () => {
  const profile = profiles.getPromptProfile("minimal", 8192, 2048);
  assert.deepEqual(profile.toolNames, ["read", "bash"]);
  assert.deepEqual(profile.settingsOverlay.tools, { xdev: false });
  assert.deepEqual(profile.settingsOverlay.disabledExtensions, [
    "context-file:project:AGENTS.md",
    "context-file:user:AGENTS.md",
    "context-file:project:CLAUDE.md",
    "context-file:user:CLAUDE.md",
    "context-file:project:GEMINI.md",
    "context-file:user:GEMINI.md",
  ]);
});

test("8k compaction reserves a next-turn allowance and bounds soft summaries", () => {
  const contextWindow = 8192;
  const maxOutput = 2048;
  const overlay = profiles.buildCompactionOverlay(contextWindow, maxOutput, 2600);
  assert.ok(overlay.thresholdTokens + maxOutput + Math.floor(contextWindow * 0.15) <= contextWindow);
  assert.ok(overlay.reserveTokens >= Math.floor(contextWindow * 0.15));
  assert.ok(overlay.reserveTokens <= maxOutput);
  assert.ok(overlay.keepRecentTokens >= 0);
  assert.deepEqual(overlay.methodOrder, ["soft"]);
  assert.ok(Math.floor(overlay.reserveTokens * 0.8) < maxOutput);
});

test("compact 16k and 24k profiles reserve output, a next turn, and summary capacity", () => {
  for (const [contextWindow, maxOutput] of [[16384, 4096], [24576, 8192]]) {
    const profile = profiles.getPromptProfile("compact", contextWindow, maxOutput);
    const overlay = profile.settingsOverlay;
    assert.deepEqual(profile.toolNames, ["read", "bash", "edit", "write"]);
    assert.ok(overlay.thresholdTokens + maxOutput + Math.floor(contextWindow * 0.15) <= contextWindow);
    assert.ok(Math.floor(overlay.reserveTokens * 0.8) < maxOutput);
    assert.deepEqual(overlay.methodOrder, ["shake", "handoff", "soft"]);
  }
});

test("larger compact windows retain OMP's untuned compaction defaults", () => {
  assert.deepEqual(profiles.buildCompactionOverlay(32768, 8192, 4500), {});
});

test("only configured private endpoints get a compact profile", () => {
  assert.equal(runtime.isConfirmedLocalEndpoint("http://192.168.1.69:9292/v1"), true);
  assert.equal(runtime.isConfirmedLocalEndpoint("https://fcloud.example.com/v1"), false);
  assert.equal(runtime.isConfirmedLocalEndpoint("ftp://127.0.0.1/v1"), false);
  assert.equal(runtime.resolveLocalModelPromptProfile({ provider: "llama-swap", modelId: "qwen-small" }).profile.id, "minimal");
  assert.equal(runtime.resolveLocalModelPromptProfile({ provider: "cloud", modelId: "same-window" }).profile.id, "full");
  assert.equal(runtime.resolveLocalModelPromptProfile({ provider: "missing", modelId: "unknown", contextWindow: 8192, maxTokens: 2048 }).profile.id, "full");
});

test("materialization writes the 8k tool and compaction budget", () => {
  const standard = runtime.resolveLocalModelPromptProfile({ provider: "llama-swap", modelId: "qwen-small" });
  const materialized = runtime.materializeLocalModelProfile(standard);
  const overlayPath = materialized.env.PI_CONFIG_FILES.split(":").at(-1);
  const overlay = parse(readFileSync(overlayPath, "utf8"));
  assert.ok(overlay.compaction.thresholdTokens + 2048 + Math.floor(8192 * 0.15) <= 8192);
  assert.ok(Math.floor(overlay.compaction.reserveTokens * 0.8) < 2048);
  assert.deepEqual(overlay.compaction.methodOrder, ["soft"]);
  assert.deepEqual(overlay.tools, { xdev: false });
  assert.ok(overlay.disabledExtensions.includes("custom-extension"));
  assert.ok(overlay.disabledExtensions.includes("context-file:project:AGENTS.md"));

  const smallerOutput = runtime.materializeLocalModelProfile(
    runtime.resolveLocalModelPromptProfile({ provider: "llama-swap", modelId: "qwen-small", maxTokens: 1024 }),
  );
  assert.notEqual(smallerOutput.systemPromptPath, materialized.systemPromptPath);
});

test("an explicit per-model auto overrides a pinned global profile", () => {
  store.writeGlobalPromptProfileOverride("compact");
  store.writeModelPromptProfileOverride("llama-swap", "qwen-small", "auto");
  const overrides = store.readPromptProfileOverrides();
  assert.equal(store.resolvePromptProfileOverride(overrides, "llama-swap", "qwen-small"), "auto");
});
