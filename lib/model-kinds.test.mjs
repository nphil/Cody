import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MODEL_KIND_OPTIONS,
  MODEL_TOKENIZERS,
  MODELS_YML_SINCE,
  RUNNER_API_KINDS,
  RUNNER_API_OPTIONS,
  RUNNER_API_SINCE,
  compatSwitchesFor,
  discoveryAcceptsAdvertisedReasoning,
  engineAtLeast,
  firstKindApiMismatch,
  isResponsesFamilyApi,
  kindApiMismatch,
  modelsYmlOffers,
  offeredCompatSwitches,
  offeredRunnerApis,
  offeredTokenizers,
  withCompatFlag,
} = await jiti.import("./model-kinds.ts");
const { serializeModelsConfig, validateModelsConfig } = await jiti.import("./omp/models-config.ts");

const provider = (model, extra = {}) => ({
  providers: {
    p: { baseUrl: "https://api.example.com/v1", auth: "none", api: "openai-completions", models: [model], ...extra },
  },
});

test("kind select never offers search and exposes every runner api", () => {
  assert.ok(!MODEL_KIND_OPTIONS.includes("search"));
  assert.deepEqual([...RUNNER_API_OPTIONS].sort(), [
    "liquid-systemone", "openai-decisions", "openai-embeddings", "openai-images", "openai-speech",
    "openai-transcriptions", "openrouter-decisions", "openrouter-images", "openrouter-rerank",
    "openrouter-video", "typesafe", "workers-ai-systemone", "xai-tts",
  ]);
});

test("a kind must match what the model's api serves", () => {
  for (const [api, kind] of [
    ["typesafe", "judge"], ["openrouter-decisions", "judge"], ["openai-decisions", "judge"],
    ["workers-ai-systemone", "judge"], ["liquid-systemone", "judge"], ["openai-images", "image"],
    ["openrouter-images", "image"], ["xai-tts", "tts"], ["openai-speech", "tts"],
    ["openai-embeddings", "embedding"], ["openrouter-rerank", "rerank"],
    ["openrouter-video", "video"], ["openai-transcriptions", "stt"],
  ]) {
    assert.equal(kindApiMismatch("p", "model m", kind, api), null, `${api} serves ${kind}`);
    assert.match(kindApiMismatch("p", "model m", "chat", api), /does not match api/, `${api} rejects chat`);
  }
  assert.equal(
    kindApiMismatch("p", "model m", "tts", "openai-images"),
    'Provider p, model m: kind "tts" does not match api "openai-images", which serves kind "image".',
  );
  // Chat transports serve chat/tiny; only the image-capable ones also serve image.
  assert.equal(kindApiMismatch("p", "model m", "tiny", "openai-completions"), null);
  assert.match(kindApiMismatch("p", "model m", "image", "openai-completions"), /"chat" or "tiny"/);
  assert.equal(kindApiMismatch("p", "model m", "image", "openai-responses"), null);
  // Unset kind or api never conflicts.
  assert.equal(kindApiMismatch("p", "model m", undefined, "typesafe"), null);
  assert.equal(kindApiMismatch("p", "model m", "tts", undefined), null);
});

test("a newer models.yml key is offered from the release that knows it, or while the file already carries it", () => {
  assert.equal(engineAtLeast("18.19.0", "18.9.2"), true);
  assert.equal(engineAtLeast("18.9.2", "18.9.2"), true);
  assert.equal(engineAtLeast("18.8.3", "18.9.2"), false);
  assert.equal(engineAtLeast("18.10.0", "18.9.2"), true, "minor compares as a number, not a string");
  assert.equal(engineAtLeast("19.0.0", "18.19.0"), true);
  // An unreadable engine version is not "at least" anything.
  assert.equal(engineAtLeast(null, "18.9.2"), false);
  assert.equal(engineAtLeast("not a version", "18.9.2"), false);

  assert.equal(modelsYmlOffers("18.8.3", RUNNER_API_SINCE["openai-decisions"]), false);
  assert.equal(modelsYmlOffers("18.8.3", RUNNER_API_SINCE["openai-decisions"], true), true, "already in the file: still shown, so it can be removed");
  assert.equal(modelsYmlOffers("18.19.0", RUNNER_API_SINCE["liquid-systemone"]), true);
  assert.equal(modelsYmlOffers("18.18.9", RUNNER_API_SINCE["liquid-systemone"]), false);
  assert.equal(modelsYmlOffers(null, RUNNER_API_SINCE["liquid-systemone"]), false);
  assert.equal(modelsYmlOffers(null, undefined), true, "an option with no floor is always offered");
  assert.equal(modelsYmlOffers("18.8.3", RUNNER_API_SINCE["typesafe"]), true, "apis absent from the table predate Cody's support");
  // The three judge apis ride the same since-table, and every since-entry is a runner api.
  assert.deepEqual(Object.keys(RUNNER_API_SINCE).sort(), ["liquid-systemone", "openai-decisions", "workers-ai-systemone"]);
  assert.ok(Object.keys(RUNNER_API_SINCE).every((api) => api in RUNNER_API_KINDS));
});

test("the tokenizer list is the ten values omp 18.19 accepts, the two newest gated by release", () => {
  assert.deepEqual(
    MODEL_TOKENIZERS.map((entry) => entry.value),
    ["claude-v3", "claude-v47", "claude-v5", "claude-v5-sonnet", "qwen3", "deepseek-v3", "kimi-k2", "glm5", "o200k", "cl100k"],
  );
  assert.deepEqual(
    MODEL_TOKENIZERS.filter((entry) => entry.since).map((entry) => [entry.value, entry.since]),
    [["o200k", MODELS_YML_SINCE.tokenizerO200k], ["cl100k", MODELS_YML_SINCE.tokenizerCl100k]],
  );
});

// The since-tables are Cody's claim about WHICH engine accepts WHAT. Ask the
// installed engine's own models.yml schema (the check that rejects a whole file),
// so a table that drifts from omp turns this red instead of writing a file the
// engine drops. Runs on whichever engine CODY_OMP_BIN / the default resolves to.
const { findOmpPackageRoot, ompPackageVersion } = await jiti.import("./omp/package-source.ts");
const engineRoot = findOmpPackageRoot();
const engineVersion = engineRoot ? ompPackageVersion(engineRoot) : null;
const bunProbe = spawnSync("bun", ["--version"], { encoding: "utf8" });
const probeSkip = !engineRoot ? "omp is not installed" : bunProbe.status !== 0 ? "bun is not available" : false;

function engineVerdicts(cases) {
  const probe = fileURLToPath(new URL("./omp/fixtures/models-yml-schema-probe.mjs", import.meta.url));
  const run = spawnSync("bun", [probe, engineRoot, JSON.stringify(cases)], { cwd: engineRoot, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `schema probe failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test(`the installed omp (${engineVersion}) accepts exactly the runner apis and tokenizers the editor offers for it`, { skip: probeSkip }, () => {
  const base = { baseUrl: "http://x/v1", api: "openai-completions", auth: "none" };
  const cases = {};
  for (const [api, kind] of Object.entries(RUNNER_API_KINDS)) {
    cases[`api:${api}`] = { providers: { p: { ...base, models: [{ id: "m", api, kind }] } } };
  }
  for (const { value } of MODEL_TOKENIZERS) {
    cases[`tokenizer:${value}`] = { providers: { p: { ...base, models: [{ id: "m", tokenizer: value }] } } };
  }
  const verdicts = engineVerdicts(cases);
  for (const [api] of Object.entries(RUNNER_API_KINDS)) {
    assert.equal(
      verdicts[`api:${api}`] === "accept",
      modelsYmlOffers(engineVersion, RUNNER_API_SINCE[api]),
      `omp ${engineVersion} on api ${api}: ${verdicts[`api:${api}`]}`,
    );
  }
  for (const { value, since } of MODEL_TOKENIZERS) {
    assert.equal(
      verdicts[`tokenizer:${value}`] === "accept",
      modelsYmlOffers(engineVersion, since),
      `omp ${engineVersion} on tokenizer ${value}: ${verdicts[`tokenizer:${value}`]}`,
    );
  }
});

test(`the installed omp (${engineVersion}) takes the other newer keys the editor writes, ignoring them where it predates them`, { skip: probeSkip }, () => {
  const base = { baseUrl: "http://x/v1", api: "openai-completions", auth: "none" };
  const verdicts = engineVerdicts({
    imageCountBudget: { providers: { p: { ...base, models: [{ id: "m", imageCountBudget: 7 }] } } },
    advertisedReasoning: { providers: { p: { ...base, discovery: { type: "lm-studio", advertisedReasoning: false } } } },
    requiresThinkingPresence: { providers: { p: { ...base, api: "anthropic-messages", compat: { requiresThinkingPresence: true }, models: [{ id: "m" }] } } },
    bindingControls: { providers: { p: { ...base, api: "bedrock-converse-stream", compat: { supportsThinkingBindingControls: false }, models: [{ id: "m" }] } } },
    messageThreads: { providers: { p: { ...base, api: "anthropic-messages", compat: { statefulResponses: false }, models: [{ id: "m" }] } } },
  });
  // Not a closed enum, so no engine rejects the file over them; the editor still
  // hides a switch the engine has no effect for (MODELS_YML_SINCE).
  for (const [name, verdict] of Object.entries(verdicts)) assert.equal(verdict, "accept", `${name}: ${verdict}`);
});

test("the editor blocks on the first mismatch, inheriting the provider api", () => {
  assert.equal(firstKindApiMismatch("p", { api: "openai-images", models: [{ id: "a", kind: "image" }] }), null);
  assert.match(
    firstKindApiMismatch("p", { api: "openai-images", models: [{ id: "a", kind: "image" }, { id: "b", kind: "video" }] }),
    /model b: kind "video" does not match api "openai-images"/,
  );
  // No api at all behaves as openai-completions in the editor.
  assert.match(firstKindApiMismatch("p", { models: [{ id: "a", kind: "tts" }] }), /api "openai-completions"/);
});

test("the save-time validator enforces the same rule, for models and modelOverrides", () => {
  assert.throws(
    () => validateModelsConfig(provider({ id: "m", kind: "tts", api: "openai-images" })),
    /model m: kind "tts" does not match api "openai-images"/,
  );
  validateModelsConfig(provider({ id: "m", kind: "image", api: "openai-images" }));
  assert.throws(
    () => validateModelsConfig(provider({ id: "m" }, { modelOverrides: { m: { kind: "video" } } })),
    /modelOverrides\.m: kind "video" does not match api "openai-completions"/,
  );
  // An override for a model this file does not declare has no known api yet.
  validateModelsConfig(provider({ id: "m" }, { modelOverrides: { other: { kind: "video" } } }));
});

test("statefulResponses is only offered for the OpenAI Responses family", () => {
  for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
    assert.equal(isResponsesFamilyApi(api), true, api);
  }
  for (const api of ["openai-completions", "anthropic-messages", "google-vertex", "typesafe", undefined]) {
    assert.equal(isResponsesFamilyApi(api), false, String(api));
  }
});

test("compat flag: default removes the key, on/off write booleans, siblings survive", () => {
  assert.deepEqual(withCompatFlag(undefined, "statefulResponses", true), { statefulResponses: true });
  assert.deepEqual(withCompatFlag({ statefulResponses: true }, "statefulResponses", false), { statefulResponses: false });
  assert.deepEqual(
    withCompatFlag({ statefulResponses: false, supportsStrictMode: true }, "statefulResponses", undefined),
    { supportsStrictMode: true },
  );
  // Back to default with nothing else in compat: the whole block is gone, not `compat: {}`.
  assert.equal(withCompatFlag({ statefulResponses: true }, "statefulResponses", undefined), undefined);
});

test("saving keeps unknown keys and writes kind/statefulResponses only when set", () => {
  const source = [
    "futureTopLevel: keep-me",
    "providers:",
    "  p:",
    "    baseUrl: https://api.example.com/v1",
    "    api: openai-responses",
    "    auth: none",
    "    futureProviderKey: {a: 1}",
    "    compat:",
    "      supportsStrictMode: true",
    "      futureCompat: x",
    "    models:",
    "      - id: m",
    "        futureModelKey: [1, 2]",
    "",
  ].join("\n");

  const base = {
    futureTopLevel: "keep-me",
    providers: {
      p: {
        baseUrl: "https://api.example.com/v1", api: "openai-responses", auth: "none", futureProviderKey: { a: 1 },
        compat: { supportsStrictMode: true, futureCompat: "x" },
        models: [{ id: "m", futureModelKey: [1, 2] }],
      },
    },
  };
  const unset = serializeModelsConfig(base, source);
  assert.ok(!/kind|statefulResponses/.test(unset), "unset fields leave no key behind");

  const set = structuredClone(base);
  set.providers.p.compat = withCompatFlag(set.providers.p.compat, "statefulResponses", false);
  set.providers.p.models[0].kind = "chat";
  set.providers.p.models[0].compat = withCompatFlag(undefined, "statefulResponses", true);
  const written = serializeModelsConfig(set, source);
  assert.match(written, /futureTopLevel: keep-me/);
  assert.match(written, /futureProviderKey/);
  assert.match(written, /futureCompat: x/);
  assert.match(written, /futureModelKey/);
  assert.match(written, /statefulResponses: false/);
  assert.match(written, /statefulResponses: true/);
  assert.match(written, /kind: chat/);

  // Back to default: the keys disappear again and nothing unknown is lost.
  const reset = structuredClone(set);
  reset.providers.p.compat = withCompatFlag(reset.providers.p.compat, "statefulResponses", undefined);
  delete reset.providers.p.models[0].kind;
  reset.providers.p.models[0].compat = withCompatFlag(reset.providers.p.models[0].compat, "statefulResponses", undefined);
  const cleared = serializeModelsConfig(reset, written);
  assert.ok(!/kind|statefulResponses/.test(cleared));
  assert.match(cleared, /futureCompat: x/);
  assert.match(cleared, /futureModelKey/);
});

test("the editor offers each runner api and tokenizer only from the release that knows it", () => {
  const oldApis = offeredRunnerApis("18.8.3");
  assert.ok(!oldApis.includes("openai-decisions") && !oldApis.includes("workers-ai-systemone") && !oldApis.includes("liquid-systemone"));
  assert.ok(oldApis.includes("typesafe") && oldApis.includes("openai-images"), "pre-existing runner apis stay");
  assert.deepEqual(offeredRunnerApis("18.9.2").filter((api) => api in RUNNER_API_SINCE).sort(), ["openai-decisions", "workers-ai-systemone"]);
  assert.deepEqual(offeredRunnerApis("18.19.0"), [...RUNNER_API_OPTIONS]);
  // A file already naming one keeps showing it, whatever the engine.
  assert.ok(offeredRunnerApis("18.8.3", "liquid-systemone").includes("liquid-systemone"));
  // An unreadable engine version offers only what is old enough for every engine.
  assert.ok(!offeredRunnerApis(null).includes("openai-decisions"));

  assert.deepEqual(offeredTokenizers("18.8.3"), ["claude-v3", "claude-v47", "claude-v5", "claude-v5-sonnet", "qwen3", "deepseek-v3", "kimi-k2", "glm5"]);
  assert.ok(offeredTokenizers("18.10.3").includes("o200k") && !offeredTokenizers("18.10.3").includes("cl100k"));
  assert.ok(offeredTokenizers("18.16.0").includes("cl100k"));
  // A value Cody has never heard of is kept (and shown) instead of silently dropped.
  assert.ok(offeredTokenizers("18.19.0", "future-tok").includes("future-tok"));
  assert.ok(offeredTokenizers("18.8.3", "cl100k").includes("cl100k"));
});

test("compat switches follow the api, and a switch newer than the engine shows only when the file sets it", () => {
  assert.deepEqual(compatSwitchesFor("openai-responses").map((s) => s.key), ["statefulResponses"]);
  assert.deepEqual(compatSwitchesFor("anthropic-messages").map((s) => s.key), ["statefulResponses", "requiresThinkingPresence"]);
  assert.deepEqual(compatSwitchesFor("bedrock-converse-stream").map((s) => s.key), ["supportsThinkingBindingControls"]);
  for (const api of ["openai-completions", "google-vertex", "typesafe", undefined]) {
    assert.deepEqual(compatSwitchesFor(api), [], String(api));
  }
  // Responses chaining predates the table: on every engine.
  assert.deepEqual(offeredCompatSwitches("openai-responses", undefined, "18.8.3"), ["statefulResponses"]);
  // Anthropic: threads from 18.17.0, thinking presence from 18.13.0.
  assert.deepEqual(offeredCompatSwitches("anthropic-messages", undefined, "18.8.3"), []);
  assert.deepEqual(offeredCompatSwitches("anthropic-messages", undefined, "18.13.0"), ["requiresThinkingPresence"]);
  assert.deepEqual(offeredCompatSwitches("anthropic-messages", undefined, "18.17.0"), ["statefulResponses", "requiresThinkingPresence"]);
  assert.deepEqual(offeredCompatSwitches("anthropic-messages", { statefulResponses: false }, "18.8.3"), ["statefulResponses"]);
  assert.deepEqual(offeredCompatSwitches("bedrock-converse-stream", undefined, "18.8.3"), []);
  assert.deepEqual(offeredCompatSwitches("bedrock-converse-stream", undefined, "18.9.1"), ["supportsThinkingBindingControls"]);
  assert.deepEqual(MODELS_YML_SINCE.advertisedReasoning, "18.13.2");
});

test("advertisedReasoning belongs to the discovery types that read /v1/models rows", () => {
  for (const type of ["openai-models-list", "lm-studio", "proxy"]) {
    assert.equal(discoveryAcceptsAdvertisedReasoning(type), true, type);
  }
  for (const type of ["litellm", "ollama", "llama.cpp", "apple-foundation-models", undefined, 7]) {
    assert.equal(discoveryAcceptsAdvertisedReasoning(type), false, String(type));
  }
  const withDiscovery = (discovery) => provider({ id: "m" }, { discovery });
  validateModelsConfig(withDiscovery({ type: "lm-studio", advertisedReasoning: false }));
  validateModelsConfig(withDiscovery({ type: "litellm" }));
  assert.throws(
    () => validateModelsConfig(withDiscovery({ type: "litellm", advertisedReasoning: false })),
    /discovery\.advertisedReasoning only applies to openai-models-list, lm-studio, or proxy/,
  );
  // The editor's trust/ignore switch round-trips through the file: ignore writes false, trust removes it.
  const source = "providers:\n  p:\n    baseUrl: http://x/v1\n    api: openai-completions\n    auth: none\n    discovery:\n      type: lm-studio\n";
  const ignore = { providers: { p: { baseUrl: "http://x/v1", api: "openai-completions", auth: "none", discovery: { type: "lm-studio", advertisedReasoning: false } } } };
  const written = serializeModelsConfig(ignore, source);
  assert.match(written, /advertisedReasoning: false/);
  const trusted = serializeModelsConfig({ providers: { p: { ...ignore.providers.p, discovery: { type: "lm-studio" } } } }, written);
  assert.ok(!/advertisedReasoning/.test(trusted));
});

test("imageCountBudget must be a positive integer, on models and modelOverrides", () => {
  validateModelsConfig(provider({ id: "m", imageCountBudget: 8 }));
  for (const bad of [0, -1, 1.5, "7", Number.NaN]) {
    assert.throws(() => validateModelsConfig(provider({ id: "m", imageCountBudget: bad })), /imageCountBudget must be a positive integer/, String(bad));
  }
  validateModelsConfig(provider({ id: "m" }, { modelOverrides: { m: { imageCountBudget: 3 } } }));
  assert.throws(
    () => validateModelsConfig(provider({ id: "m" }, { modelOverrides: { m: { imageCountBudget: 0 } } })),
    /modelOverrides\.m: imageCountBudget must be a positive integer/,
  );
});
