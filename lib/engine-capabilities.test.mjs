import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * One memoized `/api/info` read serves the whole page: AppShell loads it and
 * threads capabilities and engine identity down as props, and the few callers
 * off that path ask here. Three properties matter and all are easy to get
 * wrong: only an explicit `false` may gate anything (an unreachable /api/info
 * must not strip the UI down to the smallest engine's surface), the answer is
 * memoized so a keystroke-driven caller cannot turn it into a fetch per
 * keystroke, and the engine's identity must never be guessed — a failed read
 * reports no engine rather than the founding one.
 *
 * Each case gets its own jiti instance because the memo is module state.
 */
async function withStubbedInfo(payload, body) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (payload === "network-error") throw new Error("offline");
    return { ok: payload !== "http-error", json: async () => payload, ...init };
  };
  try {
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
    // Not named `module`: Next's lint forbids assigning that identifier, and
    // this file is inside the lint root.
    const loaded = await jiti.import("./engine-capabilities.ts");
    await body(loaded.engineSupports, calls, loaded.loadEngineInfo);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("an explicit false gates, and nothing else does", async () => {
  await withStubbedInfo({ capabilities: { skills: false, memory: true } }, async (engineSupports) => {
    assert.equal(await engineSupports("skills"), false);
    assert.equal(await engineSupports("memory"), true);
    // A flag this server has never heard of is not a reason to hide a surface.
    assert.equal(await engineSupports("somethingNew"), true);
  });
});

test("the answer is fetched once, however often it is asked", async () => {
  await withStubbedInfo({ capabilities: { skills: false } }, async (engineSupports, calls) => {
    await Promise.all([engineSupports("skills"), engineSupports("skills"), engineSupports("models")]);
    await engineSupports("skills");
    assert.deepEqual(calls, ["/api/info"], "one request for the whole page load");
  });
});

test("an unreachable or unhelpful /api/info keeps every surface", async () => {
  await withStubbedInfo("network-error", async (engineSupports) => {
    assert.equal(await engineSupports("skills"), true);
  });
  await withStubbedInfo("http-error", async (engineSupports) => {
    assert.equal(await engineSupports("skills"), true);
  });
  await withStubbedInfo({}, async (engineSupports) => {
    assert.equal(await engineSupports("skills"), true);
  });
});

test("the active engine's identity and version come from the same read", async () => {
  await withStubbedInfo(
    {
      capabilities: { chatExtras: false },
      engine: { id: "hermes", displayName: "Hermes", shortName: "Hermes", experimental: true },
      // Named for the founding engine on the wire, but it is whatever
      // harness.getVersion() answered — the ACTIVE engine's version.
      ompVersion: "0.19.0",
    },
    async (engineSupports, calls, loadEngineInfo) => {
      const info = await loadEngineInfo();
      assert.equal(info.engine?.shortName, "Hermes");
      assert.equal(info.engine?.experimental, true);
      assert.equal(info.version, "0.19.0");
      assert.equal(await engineSupports("chatExtras"), false);
      assert.deepEqual(calls, ["/api/info"], "identity and flags share one request");
    },
  );
});

test("a failed read names no engine rather than guessing the founding one", async () => {
  for (const payload of ["network-error", "http-error", {}]) {
    await withStubbedInfo(payload, async (_engineSupports, _calls, loadEngineInfo) => {
      const info = await loadEngineInfo();
      assert.equal(info.engine, null);
      assert.equal(info.version, null);
    });
  }
});
