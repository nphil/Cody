import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  allowListActive,
  curationModeFor,
  exactIdProviders,
  isProviderGlob,
  providerGlob,
  providerOfEntry,
  replaceProviderSelection,
  seedAllowList,
  summarizeProviderCuration,
  writeProviderSelection,
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
    { provider: "openrouter", total: 3, enabled: 1, mode: "unrestricted" },
    { provider: "anthropic", total: 1, enabled: 1, mode: "unrestricted" },
  ]);
});

test("a provider with every model de-selected still gets a row", () => {
  const full = [model("openrouter", "a"), model("openrouter", "b")];

  // The whole point of the user-facing requirement: turning OpenRouter off
  // must not make it disappear from the panel, or there is no way back.
  assert.deepEqual(summarizeProviderCuration(full, []), [
    { provider: "openrouter", total: 2, enabled: 0, mode: "unrestricted" },
  ]);
});

test("unrestricted reads report every model as enabled", () => {
  const full = [model("anthropic", "opus"), model("anthropic", "sonnet")];
  assert.deepEqual(summarizeProviderCuration(full, full), [
    { provider: "anthropic", total: 2, enabled: 2, mode: "unrestricted" },
  ]);
});

test("an allowed model absent from the catalog read never reads as 0 of 0", () => {
  // Happens when the catalog fetch fails or races: the enabled model is proof
  // its provider offers at least one.
  assert.deepEqual(summarizeProviderCuration([], [model("llama-swap", "local")]), [
    { provider: "llama-swap", total: 1, enabled: 1, mode: "unrestricted" },
  ]);
});

test("an empty allow-list leaves every row unrestricted", () => {
  const full = [model("anthropic", "opus")];
  assert.deepEqual(summarizeProviderCuration(full, full, []), [
    { provider: "anthropic", total: 1, enabled: 1, mode: "unrestricted" },
  ]);
});

test("an active allow-list labels each row with how it is curated", () => {
  const full = [
    model("openrouter", "vendor/a"),
    model("openrouter", "vendor/b"),
    model("openrouter", "vendor/c"),
    model("anthropic", "opus"),
    model("anthropic", "sonnet"),
    model("openai", "gpt"),
  ];
  const allowed = [model("openrouter", "vendor/a"), model("openrouter", "vendor/b"), model("anthropic", "opus")];
  const enabledModels = ["openrouter/**", "anthropic/opus"];

  assert.deepEqual(summarizeProviderCuration(full, allowed, enabledModels), [
    { provider: "openrouter", total: 3, enabled: 2, mode: "all" },
    { provider: "anthropic", total: 2, enabled: 1, mode: "exact" },
    { provider: "openai", total: 1, enabled: 0, mode: "none" },
  ]);
});

// --- providerGlob / isProviderGlob / providerOfEntry -----------------------

test("the whole-provider glob crosses slashes so nested ids are covered", () => {
  // OMP matches with Bun.Glob, where `*` stops at `/` — `openrouter/*` would
  // match none of OpenRouter's `vendor/model` ids. `**` is the form that means
  // "everything under this provider, now and later".
  assert.equal(providerGlob("openrouter"), "openrouter/**");
});

test("recognises both spellings of a whole-provider glob and nothing else", () => {
  assert.equal(isProviderGlob("anthropic/**"), true);
  assert.equal(isProviderGlob("anthropic/*"), true);

  assert.equal(isProviderGlob("anthropic/opus"), false);
  assert.equal(isProviderGlob("anthropic/opus*"), false);
  assert.equal(isProviderGlob("openrouter/anthropic/*"), false);
  assert.equal(isProviderGlob("anthropic/*:high"), false);
  assert.equal(isProviderGlob("*"), false);
  assert.equal(isProviderGlob("anthropic"), false);
  assert.equal(isProviderGlob("*/**"), false);
  assert.equal(isProviderGlob(""), false);
});

test("the provider of an entry is its first path segment only", () => {
  assert.equal(providerOfEntry("anthropic/opus"), "anthropic");
  assert.equal(providerOfEntry("openrouter/anthropic/model"), "openrouter");
  assert.equal(providerOfEntry("openrouter/**"), "openrouter");
  assert.equal(providerOfEntry("bare-id"), null);
  assert.equal(providerOfEntry("*"), null);
  assert.equal(providerOfEntry("/leading-slash"), null);
});

// --- curationModeFor -------------------------------------------------------

test("reads a provider's mode from the raw setting", () => {
  const enabledModels = ["openrouter/**", "anthropic/opus", "anthropic/sonnet"];
  assert.equal(curationModeFor(enabledModels, "openrouter"), "all");
  assert.equal(curationModeFor(enabledModels, "anthropic"), "exact");
  assert.equal(curationModeFor(enabledModels, "openai"), "none");
  assert.equal(curationModeFor([], "openai"), "none");
});

test("a hand-written single-star glob also reads as the whole provider", () => {
  assert.equal(curationModeFor(["anthropic/*"], "anthropic"), "all");
});

test("a pattern under another provider never counts for the provider it names", () => {
  // `openrouter/anthropic/*` belongs to `openrouter`; it says nothing about the
  // native `anthropic` provider.
  assert.equal(curationModeFor(["openrouter/anthropic/*"], "anthropic"), "none");
  assert.equal(curationModeFor(["openrouter/anthropic/*"], "openrouter"), "exact");
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

test("seeds requested providers as globs and drops their now-redundant exact keys", () => {
  const seeded = seedAllowList(
    ["openrouter/vendor/a", "anthropic/opus", "openrouter/vendor/b", "openai/gpt"],
    [],
    { providerGlobs: ["openrouter", "openai"] },
  );
  // Globs first, in the order given; other providers' exact keys survive in
  // their original order.
  assert.deepEqual(seeded, ["openrouter/**", "openai/**", "anthropic/opus"]);
});

test("a glob-seeded provider stays open even when nothing of it is in use", () => {
  const seeded = seedAllowList(["anthropic/opus"], [], { providerGlobs: ["openrouter"] });
  assert.deepEqual(seeded, ["openrouter/**", "anthropic/opus"]);
  assert.equal(curationModeFor(seeded, "openrouter"), "all");
});

test("glob seeding dedupes providers and skips the fallback", () => {
  const fallback = [model("anthropic", "opus")];
  assert.deepEqual(seedAllowList([], fallback, { providerGlobs: ["openrouter", "openrouter"] }), ["openrouter/**"]);
});

test("an empty providerGlobs option behaves like the plain seed", () => {
  const fallback = [model("anthropic", "opus")];
  assert.deepEqual(seedAllowList([], fallback, { providerGlobs: [] }), ["anthropic/opus"]);
  assert.deepEqual(seedAllowList(["openrouter/x"], fallback, {}), ["openrouter/x"]);
});

test("a bare-id key in use is kept regardless of globs", () => {
  const seeded = seedAllowList(["local-model"], [], { providerGlobs: ["openrouter"] });
  assert.deepEqual(seeded, ["openrouter/**", "local-model"]);
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

test("matches a provider on the first path segment, never a later one", () => {
  const next = replaceProviderSelection(["openrouter/anthropic/model", "anthropic/opus"], "anthropic", []);
  assert.deepEqual(next, ["openrouter/anthropic/model"]);
});

// --- writeProviderSelection: what the curation dialog saves ----------------

test("a full selection with future models included writes the glob and drops stale exact entries", () => {
  const next = writeProviderSelection(
    ["openrouter/**", "anthropic/opus", "anthropic/retired"],
    "anthropic",
    ["anthropic/opus", "anthropic/sonnet"],
    ["anthropic/opus", "anthropic/sonnet"],
    { includeFuture: true },
  );
  assert.deepEqual(next, ["openrouter/**", "anthropic/**"]);
  assert.equal(curationModeFor(next, "anthropic"), "all");
});

test("a pruned selection writes exact ids even when future models were requested", () => {
  // A glob would un-hide the model the user just pruned.
  const next = writeProviderSelection(
    ["anthropic/**"],
    "anthropic",
    ["anthropic/opus"],
    ["anthropic/opus", "anthropic/sonnet"],
    { includeFuture: true },
  );
  assert.deepEqual(next, ["anthropic/opus"]);
  assert.equal(curationModeFor(next, "anthropic"), "exact");
});

test("a full selection without future models writes exact ids", () => {
  const next = writeProviderSelection(
    ["anthropic/**", "openai/gpt"],
    "anthropic",
    ["anthropic/opus", "anthropic/sonnet"],
    ["anthropic/opus", "anthropic/sonnet"],
    { includeFuture: false },
  );
  assert.deepEqual(next, ["openai/gpt", "anthropic/opus", "anthropic/sonnet"]);
});

test("saving replaces a hand-written single-star glob with the slash-crossing form", () => {
  const next = writeProviderSelection(["openrouter/*"], "openrouter", ["openrouter/vendor/a"], ["openrouter/vendor/a"], {
    includeFuture: true,
  });
  assert.deepEqual(next, ["openrouter/**"]);
});

test("patterns of other providers that mention this one are untouched", () => {
  const before = ["openrouter/anthropic/*", "openrouter/anthropic/model", "anthropic/opus"];
  const next = writeProviderSelection(before, "anthropic", ["anthropic/sonnet"], ["anthropic/opus", "anthropic/sonnet"], {
    includeFuture: true,
  });
  assert.deepEqual(next, ["openrouter/anthropic/*", "openrouter/anthropic/model", "anthropic/sonnet"]);
});

test("writes a deduped list", () => {
  const next = writeProviderSelection(["openai/gpt", "openai/gpt"], "anthropic", ["anthropic/opus", "anthropic/opus"], [], {
    includeFuture: false,
  });
  assert.deepEqual(next, ["openai/gpt", "anthropic/opus"]);
});

test("an unknown catalog cannot prove anything is pruned, so future models are honoured", () => {
  const next = writeProviderSelection([], "anthropic", ["anthropic/opus"], [], { includeFuture: true });
  assert.deepEqual(next, ["anthropic/**"]);
});

test("de-selecting everything in a provider clears it without touching the rest", () => {
  const next = writeProviderSelection(["anthropic/**", "openai/gpt"], "anthropic", [], ["anthropic/opus"], {
    includeFuture: true,
  });
  assert.deepEqual(next, ["openai/gpt"]);
  assert.equal(curationModeFor(next, "anthropic"), "none");
});

// --- exactIdProviders ------------------------------------------------------

test("lists, sorted, the providers pinned to an exact list", () => {
  const enabledModels = ["openrouter/**", "openai/gpt", "anthropic/sonnet", "anthropic/opus", "bare-id"];
  assert.deepEqual(exactIdProviders(enabledModels), ["anthropic", "openai"]);
});

test("a provider with both a glob and exact keys is not pinned", () => {
  assert.deepEqual(exactIdProviders(["anthropic/opus", "anthropic/*"]), []);
});

test("a pattern under another provider pins that provider, not the one it names", () => {
  assert.deepEqual(exactIdProviders(["openrouter/anthropic/*"]), ["openrouter"]);
  assert.deepEqual(exactIdProviders([]), []);
});
