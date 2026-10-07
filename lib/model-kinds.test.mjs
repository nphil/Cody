import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MODEL_KIND_OPTIONS,
  RUNNER_API_OPTIONS,
  firstKindApiMismatch,
  isResponsesFamilyApi,
  kindApiMismatch,
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
    "openai-embeddings", "openai-images", "openai-speech", "openai-transcriptions",
    "openrouter-decisions", "openrouter-images", "openrouter-rerank", "openrouter-video",
    "typesafe", "xai-tts",
  ]);
});

test("a kind must match what the model's api serves", () => {
  for (const [api, kind] of [
    ["typesafe", "judge"], ["openrouter-decisions", "judge"], ["openai-images", "image"],
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
