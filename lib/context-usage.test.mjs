import assert from "node:assert/strict";
import test from "node:test";
import { derivePersistedContextUsage } from "./context-usage.ts";

const activeModel = { provider: "provider-a", modelId: "model-a" };
const modelList = [{ id: "model-a", provider: "provider-a", contextWindow: 200 }];

function assistant(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    model: "model-a",
    provider: "provider-a",
    ...overrides,
  };
}

function usage(input, cacheRead, cacheWrite) {
  return {
    input,
    output: 99,
    cacheRead,
    cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("prefers the latest assistant snapshot regardless of message model", () => {
  const messages = [
    assistant({ contextSnapshot: { promptTokens: 20 } }),
    { role: "user", content: "continue" },
    assistant({
      model: "another-model",
      provider: "another-provider",
      contextSnapshot: { promptTokens: 50 },
      usage: usage(180, 10, 10),
    }),
  ];
  const before = structuredClone(messages);

  assert.deepEqual(derivePersistedContextUsage(messages, activeModel, modelList), {
    percent: 25,
    contextWindow: 200,
    tokens: 50,
  });
  assert.deepEqual(messages, before);
});

test("falls back to prompt-side usage totals", () => {
  const messages = [assistant({ usage: usage(30, 10, 5) })];

  assert.deepEqual(derivePersistedContextUsage(messages, activeModel, modelList), {
    percent: 22.5,
    contextWindow: 200,
    tokens: 45,
  });
});

test("requires a matching positive model window and an assistant estimate", () => {
  const messages = [assistant({ contextSnapshot: { promptTokens: 10 } })];

  assert.equal(derivePersistedContextUsage([], activeModel, modelList), null);
  assert.equal(derivePersistedContextUsage([{ role: "user", content: "hello" }], activeModel, modelList), null);
  assert.equal(derivePersistedContextUsage(messages, null, modelList), null);
  assert.equal(derivePersistedContextUsage(messages, activeModel, []), null);
  assert.equal(derivePersistedContextUsage(messages, activeModel, [{ ...modelList[0], contextWindow: 0 }]), null);
  assert.equal(derivePersistedContextUsage(messages, activeModel, [{ ...modelList[0], contextWindow: -1 }]), null);
  assert.equal(derivePersistedContextUsage(messages, activeModel, [{ ...modelList[0], contextWindow: Number.NaN }]), null);
  assert.equal(derivePersistedContextUsage(messages, activeModel, [{ ...modelList[0], contextWindow: Infinity }]), null);
});

test("rejects non-finite and negative token estimates", () => {
  assert.equal(
    derivePersistedContextUsage(
      [assistant({ contextSnapshot: { promptTokens: -1 }, usage: usage(12, 3, 5) })],
      activeModel,
      modelList,
    )?.tokens,
    20,
  );
  assert.equal(
    derivePersistedContextUsage([assistant({ usage: usage(12, -1, 5) })], activeModel, modelList),
    null,
  );
  assert.equal(
    derivePersistedContextUsage([assistant({ usage: usage(Number.NaN, 3, 5) })], activeModel, modelList),
    null,
  );
  assert.equal(
    derivePersistedContextUsage([assistant({ contextSnapshot: { promptTokens: Infinity } })], activeModel, modelList),
    null,
  );
  assert.equal(
    derivePersistedContextUsage(
      [assistant({ contextSnapshot: { promptTokens: 20 } }), assistant({ contextSnapshot: { promptTokens: -1 } })],
      activeModel,
      modelList,
    ),
    null,
  );
});

test("preserves percentages above one hundred", () => {
  assert.deepEqual(
    derivePersistedContextUsage(
      [assistant({ contextSnapshot: { promptTokens: 250 } })],
      activeModel,
      [{ ...modelList[0], contextWindow: 100 }],
    ),
    { percent: 250, contextWindow: 100, tokens: 250 },
  );
});
