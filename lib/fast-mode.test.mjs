import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { supportsPriorityFastMode } = await jiti.import("./fast-mode.ts");

test("direct Anthropic realizes fast mode", () => {
  assert.equal(supportsPriorityFastMode({ provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" }), true);
});

// This predicate is keyed by provider + api, never by model id or family —
// so a new Claude tier (Fable, shipped above Opus) needs no entry of its own
// here, and behaves exactly like every other direct-Anthropic model: fast
// mode on direct Anthropic, dropped the moment a third party serves it.
test("a newly added Claude tier (Fable) needs no id-specific entry: same provider rule as any other Claude model", () => {
  assert.equal(supportsPriorityFastMode({ provider: "anthropic", id: "claude-fable-5-1", api: "anthropic-messages" }), true);
  assert.equal(supportsPriorityFastMode({ provider: "bedrock-anthropic", id: "claude-fable-5-1", api: "anthropic-messages" }), false);
  assert.equal(supportsPriorityFastMode({ provider: "openrouter", id: "anthropic/claude-fable-5.1", api: "openai-completions" }), false);
});

// The regression: a Codex subscription is provider "openai-codex", not "openai",
// and the old provider allowlist missed it — so the composer hid a control the
// harness would have acted on.
test("an OpenAI-Codex subscription model realizes fast mode", () => {
  assert.equal(supportsPriorityFastMode({ provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" }), true);
});

test("the OpenAI provider realizes fast mode", () => {
  assert.equal(supportsPriorityFastMode({ provider: "openai", id: "gpt-5.5", api: "openai-responses" }), true);
});

test("both Google surfaces realize fast mode", () => {
  assert.equal(supportsPriorityFastMode({ provider: "google", id: "gemini-3-pro", api: "google-generative-ai" }), true);
  assert.equal(supportsPriorityFastMode({ provider: "google-vertex", id: "gemini-3-pro", api: "google-vertex" }), true);
});

// Claude anywhere but direct Anthropic accepts the request and drops the tier,
// so offering the toggle there would be a lie.
test("Claude served by a third party does not realize fast mode", () => {
  assert.equal(supportsPriorityFastMode({ provider: "bedrock-anthropic", id: "claude-sonnet-4", api: "anthropic-messages" }), false);
  assert.equal(supportsPriorityFastMode({ provider: "google-vertex", id: "claude-sonnet-4", api: "anthropic-messages" }), false);
});

test("OpenRouter realizes it only for its OpenAI and Google upstreams", () => {
  assert.equal(supportsPriorityFastMode({ provider: "openrouter", id: "openai/gpt-4o", api: "openai-completions" }), true);
  assert.equal(supportsPriorityFastMode({ provider: "openrouter", id: "google/gemini-2.5-pro", api: "openai-completions" }), true);
  assert.equal(supportsPriorityFastMode({ provider: "openrouter", id: "anthropic/claude-sonnet-4", api: "openai-completions" }), false);
});

test("a local OpenAI-compatible server has no tier to send", () => {
  assert.equal(supportsPriorityFastMode({ provider: "llama-swap", id: "qwen3.8-27b", api: "openai-completions" }), false);
});

// Priority is real on Fireworks but /fast does not drive it: it has its own
// provider tier setting, and upstream gives those models no tier family.
test("Fireworks is left to its own tier setting", () => {
  assert.equal(supportsPriorityFastMode({ provider: "fireworks", id: "glm-4.6", api: "openai-completions" }), false);
});
