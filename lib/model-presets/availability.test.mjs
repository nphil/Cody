import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { unavailablePresetSelection } = await jiti.import("./availability.ts");

function model(selector) {
  const slash = selector.indexOf("/");
  return { selector, provider: selector.slice(0, slash), id: selector.slice(slash + 1) };
}

// This is the effective get_available_models result after OMP curation.
const curated = [model("anthropic/sonnet"), model("openrouter/vendor/allowed:free"), model("ollama/qwen:high")];

test("preset roles and fallback targets must resolve in the effective roster", () => {
  assert.equal(unavailablePresetSelection({
    roles: { default: "anthropic/sonnet:high", task: "openrouter/vendor/allowed:free" },
    chains: { default: ["anthropic/sonnet", "openrouter/*", "@task"] },
  }, curated), null);

  assert.match(unavailablePresetSelection({ roles: { default: "anthropic/opus" } }, curated), /default.*anthropic\/opus.*curation/);
  assert.match(unavailablePresetSelection({ chains: { default: ["anthropic/opus"] } }, curated), /fallback.*anthropic\/opus.*curation/);
  assert.match(unavailablePresetSelection({ chains: { default: ["disabled-provider/*"] } }, curated), /disabled-provider.*curation/);
});

test("exact colon ids win over suffix interpretation; nested ids stay exact", () => {
  assert.equal(unavailablePresetSelection({ roles: { default: "ollama/qwen:high" } }, curated), null);
  assert.equal(unavailablePresetSelection({ chains: { default: ["openrouter/vendor/allowed:free"] } }, curated), null);
  assert.match(unavailablePresetSelection({ roles: { default: "openrouter/vendor/blocked:free" } }, curated), /blocked/);
});
