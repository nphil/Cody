import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { createJiti } from "jiti";

// Agent-dir state must never reach the live instance: set before importing.
const agentDir = mkdtempSync(path.join(os.tmpdir(), "cody-presets-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./store.ts");
const overlay = await jiti.import("./overlay.ts");

test("the four built-in tiers always exist, first, and cannot be deleted", () => {
  const { presets, lastUsedPresetId } = store.listPresets();
  assert.deepEqual(presets.slice(0, 4).map((preset) => preset.id), ["max", "high", "medium", "low"]);
  assert.ok(presets.every((preset) => preset.builtIn && Object.keys(preset.roles).length === 0));
  assert.equal(lastUsedPresetId, null, "a fresh install starts new chats on base settings");
  assert.throws(() => store.deletePreset("max"), (error) => error.code === "builtin");
});

test("an update is validated against the engine's chat roles, and keeps colon model ids intact", () => {
  assert.throws(() => store.updatePreset("high", { roles: { image: "openai/gpt-image-1" } }), /not a chat role/);
  assert.throws(() => store.updatePreset("high", { roles: { default: "not a selector" } }), /not a model selector/);
  assert.throws(() => store.updatePreset("high", { chains: { default: ["rm -rf"] } }), /fallback chain/);

  const saved = store.updatePreset("high", {
    roles: { default: "openai-codex/gpt-6-sol:high", smol: "openrouter/qwen/qwen3-coder:free", task: "" },
    chains: { default: ["openai-codex/gpt-6-astra", "anthropic/*", "@slow"] },
    usageAwareFallback: true,
  });
  assert.deepEqual(saved.roles, { default: "openai-codex/gpt-6-sol:high", smol: "openrouter/qwen/qwen3-coder:free" }, "an empty role inherits base");
  assert.deepEqual(store.resolveSmartDefault(saved), { provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "high" });
});

test("an over-limit chains update is rejected, never silently cut", () => {
  const preset = store.createPreset({ name: "Chain limit test" });
  const tooManyKeys = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}/*`, ["p0/m0"]]));
  assert.throws(() => store.updatePreset(preset.id, { chains: tooManyKeys }), (error) => error.code === "too_many_chains");

  const tooLongChain = Array.from({ length: 33 }, (_, i) => `p${i}/m${i}`);
  assert.throws(() => store.updatePreset(preset.id, { chains: { default: tooLongChain } }), (error) => error.code === "chain_too_long");

  // Neither rejected update left any partial chains behind.
  assert.deepEqual(store.getPreset(preset.id).chains, {});

  // A chain right at the (raised) limit is accepted in full, never cut.
  const fits = Array.from({ length: 32 }, (_, i) => `p${i}/m${i}`);
  const saved = store.updatePreset(preset.id, { chains: { default: fits } });
  assert.deepEqual(saved.chains.default, fits);
});

test("Smart falls back to the base config's default role when the preset leaves it unset", () => {
  writeFileSync(path.join(agentDir, "config.yml"), "modelRoles:\n  default: anthropic/claude-opus-5:medium\n");
  assert.deepEqual(store.resolveSmartDefault(store.getPreset("low")), { provider: "anthropic", modelId: "claude-opus-5", thinkingLevel: "medium" });
  assert.deepEqual(store.resolveSmartDefault(null), { provider: "anthropic", modelId: "claude-opus-5", thinkingLevel: "medium" });
});

test("Smart exposes only a curated default, including an exact model id with a colon", () => {
  const allowed = [{ selector: "ollama/qwen:high", provider: "ollama", id: "qwen:high" }];
  const preset = { roles: { default: "ollama/qwen:high" } };
  assert.deepEqual(store.resolveSmartDefault(preset, allowed), { provider: "ollama", modelId: "qwen:high", thinkingLevel: null });
  assert.equal(store.resolveSmartDefault({ roles: { default: "anthropic/opus" } }, allowed), null);
});

test("the overlay carries only what the preset names, and moves when the preset changes", () => {
  const high = store.getPreset("high");
  const first = overlay.materializePresetOverlay(high);
  const document = parse(readFileSync(first, "utf8"));
  assert.deepEqual(document, {
    modelRoles: { default: "openai-codex/gpt-6-sol:high", smol: "openrouter/qwen/qwen3-coder:free" },
    retry: { fallbackChains: { default: ["openai-codex/gpt-6-astra", "anthropic/*", "@slow"] }, usageAwareFallback: true },
  });
  assert.equal(overlay.materializePresetOverlay(store.getPreset("medium")), null, "an unconfigured preset runs exactly like base");
  const second = overlay.materializePresetOverlay(store.updatePreset("high", { roles: { default: "openai-codex/gpt-6-sol:xhigh" } }));
  assert.notEqual(second, first, "a changed preset gets a new overlay path, which is what a relaunch detects");
});

test("presetOverlayEquals ignores name/intent/research-only differences but catches a real overlay change", () => {
  const base = {
    id: "x", name: "A", intent: "", builtIn: false,
    roles: { default: "openai-codex/gpt-6-sol:high", smol: "openrouter/qwen/qwen3-coder:free" },
    chains: { default: ["anthropic/claude-x"], smol: ["anthropic/claude-mini"] },
    usageAwareFallback: true,
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  const renamed = {
    ...base,
    name: "B",
    intent: "renamed only",
    research: { runId: "r1", plannerModel: "x", completedAt: "2024-01-01T00:00:00.000Z", rationale: [] },
  };
  assert.equal(overlay.presetOverlayEquals(base, renamed), true, "name/intent/research alone must not count as an overlay change");

  assert.equal(overlay.presetOverlayEquals(base, { ...base, roles: { default: "openai-codex/gpt-6-sol:xhigh" } }), false, "a role change must count");
  assert.equal(overlay.presetOverlayEquals(base, { ...base, chains: { default: ["anthropic/claude-y"] } }), false, "a chain change must count");
  assert.equal(overlay.presetOverlayEquals(base, { ...base, usageAwareFallback: false }), false, "a usageAwareFallback change must count");

  assert.equal(overlay.presetOverlayEquals(null, null), true);
  assert.equal(overlay.presetOverlayEquals(null, base), false);

  // Key order in the raw fields must not matter: only the materialized shape
  // does — a client resending the same roles/chains with keys in a different
  // order (a real possibility: `roles`/`chains` are plain JSON objects) must
  // not read as a change.
  const reordered = {
    ...base,
    roles: { smol: base.roles.smol, default: base.roles.default },
    chains: { smol: [...base.chains.smol], default: [...base.chains.default] },
  };
  assert.equal(overlay.presetOverlayEquals(base, reordered), true);

  const unconfigured = { ...base, roles: {}, chains: {}, usageAwareFallback: undefined };
  assert.equal(overlay.presetOverlayEquals(null, unconfigured), true, "an unconfigured preset materializes to nothing, same as no preset");
});

test("a chat's binding follows it through rename and fork, and a deleted preset returns it to base", () => {
  const custom = store.createPreset({ name: "Night", intent: "cheap overnight runs", copyFrom: "high" });
  assert.equal(custom.roles.default, "openai-codex/gpt-6-sol:xhigh", "copying keeps the source's roles");

  overlay.setSessionPreset("__new__temp", custom.id);
  overlay.renameSessionPreset("__new__temp", "real-1");
  assert.equal(overlay.readSessionPresetId("__new__temp"), null);
  assert.equal(overlay.readSessionPresetId("real-1"), custom.id);
  overlay.copySessionPreset("real-1", "fork-1");
  assert.equal(overlay.readSessionPresetId("fork-1"), custom.id);
  assert.ok(overlay.sessionPresetOverlay("real-1"));
  assert.equal(overlay.readSessionPresetId("never-bound"), null, "a chat nobody bound runs on base settings");

  store.deletePreset(custom.id);
  assert.equal(overlay.readSessionPresetId("real-1"), null, "a binding to a deleted preset reads as base");
  assert.equal(overlay.unbindPreset(custom.id), 2);
  assert.equal(overlay.sessionPresetOverlay("real-1"), null);
});

test("the last pick becomes the preset new chats start on, including picking base", () => {
  store.setLastUsedPreset("low");
  assert.equal(store.listPresets().lastUsedPresetId, "low");
  store.setLastUsedPreset(null);
  assert.equal(store.listPresets().lastUsedPresetId, null);
  store.setLastUsedPreset("no-such-preset");
  assert.equal(store.listPresets().lastUsedPresetId, null);
});
