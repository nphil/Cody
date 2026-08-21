import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  allowListActive,
  replaceProviderSelection,
  seedAllowList,
  summarizeProviderCuration,
} = await jiti.import("./model-allow-list.ts");

const model = (provider, id) => ({ provider, id });

// --- allowListActive: empty means unrestricted (OMP's own reading) ----------

test("an empty or absent allow-list is not a restriction", () => {
  assert.equal(allowListActive(undefined), false);
  assert.equal(allowListActive([]), false);
  assert.equal(allowListActive(["anthropic/opus"]), true);
});

// --- summarizeProviderCuration ---------------------------------------------

test("reports enabled of total per provider, biggest provider first", () => {
  const full = [model("openrouter", "a"), model("openrouter", "b"), model("openrouter", "c"), model("anthropic", "opus")];
  const allowed = [model("openrouter", "b"), model("anthropic", "opus")];

  assert.deepEqual(summarizeProviderCuration(full, allowed), [
    { provider: "openrouter", total: 3, enabled: 1 },
    { provider: "anthropic", total: 1, enabled: 1 },
  ]);
});

test("a provider with every model de-selected still gets a row", () => {
  const full = [model("openrouter", "a"), model("openrouter", "b")];

  // The whole point of the user-facing requirement: turning OpenRouter off
  // must not make it disappear from the panel, or there is no way back.
  assert.deepEqual(summarizeProviderCuration(full, []), [
    { provider: "openrouter", total: 2, enabled: 0 },
  ]);
});

test("unrestricted reads report every model as enabled", () => {
  const full = [model("anthropic", "opus"), model("anthropic", "sonnet")];
  assert.deepEqual(summarizeProviderCuration(full, full), [
    { provider: "anthropic", total: 2, enabled: 2 },
  ]);
});

test("an allowed model absent from the catalog read never reads as 0 of 0", () => {
  // Happens when the catalog fetch fails or races: the enabled model is proof
  // its provider offers at least one.
  assert.deepEqual(summarizeProviderCuration([], [model("llama-swap", "local")]), [
    { provider: "llama-swap", total: 1, enabled: 1 },
  ]);
});

// --- seedAllowList: turning the switch on must not enable everything -------

test("seeds only the models already in use, deduplicated", () => {
  const seeded = seedAllowList(["anthropic/opus", "", null, "anthropic/opus", "openrouter/x"]);
  assert.deepEqual(seeded.sort(), ["anthropic/opus", "openrouter/x"]);
});

test("falls back to one model so the switch cannot persist an empty list", () => {
  // `[]` reads back as "no restriction", which would make the toggle look broken.
  const seeded = seedAllowList([], [model("anthropic", "opus"), model("openrouter", "x")]);
  assert.deepEqual(seeded, ["anthropic/opus"]);
  assert.equal(allowListActive(seeded), true);
});

test("never seeds the whole catalog", () => {
  const full = [model("openrouter", "a"), model("openrouter", "b"), model("openrouter", "c")];
  assert.ok(seedAllowList(["openrouter/a"], full).length < full.length);
});

// --- replaceProviderSelection ----------------------------------------------

test("replaces one provider's entries and leaves the others alone", () => {
  const next = replaceProviderSelection(
    ["anthropic/opus", "openrouter/old-1", "openrouter/old-2"],
    "openrouter",
    ["openrouter/new"],
  );
  assert.deepEqual(next, ["anthropic/opus", "openrouter/new"]);
});

test("preserves hand-written patterns that belong to other providers", () => {
  const next = replaceProviderSelection(["anthropic/*", "openrouter/a"], "openrouter", []);
  assert.deepEqual(next, ["anthropic/*"]);
});

test("clearing a provider cannot empty the list while another provider is selected", () => {
  const next = replaceProviderSelection(["anthropic/opus", "openrouter/a"], "openrouter", []);
  assert.equal(allowListActive(next), true);
});
