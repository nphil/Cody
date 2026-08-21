import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { modelBrand, providerBrand, brandAccountLabel } = await jiti.import("./provider-brand.ts");

// --- providerBrand ----------------------------------------------------------

test("a provider id resolves to its product brand and mark", () => {
  assert.deepEqual(providerBrand("anthropic"), { name: "Claude", icon: "claude" });
  assert.deepEqual(providerBrand("openai-codex"), { name: "Codex", icon: "openai" });
  assert.equal(providerBrand("openrouter").icon, "openrouter");
});

test("regional and plan-scoped ids resolve to the same brand as their parent", () => {
  assert.equal(providerBrand("moonshotai-cn").icon, "moonshot");
  assert.equal(providerBrand("kimi-coding").icon, "moonshot");
  assert.equal(providerBrand("zai-coding-cn").icon, "zhipu");
  assert.equal(providerBrand("azure-openai-responses").icon, "azure");
});

test("Vertex serving Anthropic is a Claude row, not a Gemini one", () => {
  assert.equal(providerBrand("google-vertex").icon, "gemini");
  assert.equal(providerBrand("google-vertex-anthropic").icon, "claude");
});

test("an unknown provider resolves to nothing, so the caller draws its fallback", () => {
  assert.equal(providerBrand("some-local-runtime"), null);
  assert.equal(providerBrand(undefined), null);
});

// --- modelBrand: the picker's actual contract -------------------------------
//
// A gateway is not a vendor. Every model behind one OpenRouter key reports
// provider "openrouter"; keying rows off that alone paints one identical mark
// down hundreds of rows, which is the whole reason this resolver exists.

test("behind a gateway, a model wears its vendor's mark and not the gateway's", () => {
  assert.equal(modelBrand("openrouter", "anthropic/claude-sonnet-4").icon, "claude");
  assert.equal(modelBrand("openrouter", "google/gemini-2.5-pro").icon, "gemini");
  assert.equal(modelBrand("openrouter", "meta-llama/llama-3.3-70b").icon, "llama");
});

test("a bare model id is read from its family name", () => {
  assert.equal(modelBrand("openrouter", "gpt-5.3-chat-latest").icon, "openai");
  assert.equal(modelBrand("openrouter", "o3-mini").icon, "openai");
  assert.equal(modelBrand("openrouter", "deepseek-r1").icon, "deepseek");
  assert.equal(modelBrand("openrouter", "mixtral-8x7b").icon, "mistral");
  assert.equal(modelBrand("openrouter", "grok-4").icon, "xai");
  assert.equal(modelBrand("openrouter", "qwen3-coder").icon, "qwen");
  assert.equal(modelBrand("openrouter", "kimi-k2").icon, "moonshot");
  assert.equal(modelBrand("openrouter", "glm-4.6").icon, "zhipu");
});

test("an unrecognized model falls back to the provider serving it", () => {
  assert.equal(modelBrand("anthropic", "some-unreleased-thing").icon, "claude");
  assert.equal(modelBrand("ollama", "my-local-finetune").icon, "ollama");
  assert.equal(modelBrand("some-local-runtime", "my-local-finetune"), null);
});

test("an unknown vendor prefix does not shadow the family name behind it", () => {
  // "cognitivecomputations/dolphin-mistral" — the prefix means nothing to us,
  // but the family after it still does.
  assert.equal(modelBrand("openrouter", "cognitivecomputations/mistral-7b").icon, "mistral");
});

// --- brandAccountLabel: unchanged by the widened brand table ----------------

test("account labels keep their discriminator while gaining the product name", () => {
  assert.equal(brandAccountLabel("anthropic", "Anthropic (work)"), "Claude (work)");
  assert.equal(brandAccountLabel("anthropic", "Acme Corp"), "Acme Corp");
});
