import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPreviewAutoOpener } = await jiti.import("./preview-autoopen.ts");

/** Deterministic harness: probes resolve on demand, sleeps resolve instantly. */
function makeHarness({ probeResults = [], sessionActive = () => true } = {}) {
  const calls = { probes: [], opens: [], sleeps: [] };
  let probeIndex = 0;
  const opener = createPreviewAutoOpener({
    probe: async (url) => {
      calls.probes.push(url);
      const result = probeResults[probeIndex] ?? probeResults[probeResults.length - 1] ?? false;
      probeIndex += 1;
      return result;
    },
    open: (url, sessionId) => calls.opens.push({ url, sessionId }),
    isSessionActive: sessionActive,
    sleep: async (ms) => { calls.sleeps.push(ms); },
    retryDelaysMs: [0, 10, 20],
  });
  return { opener, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("opens a reachable URL once and dedupes later mentions", async () => {
  const { opener, calls } = makeHarness({ probeResults: [true] });
  opener.offer(["http://localhost:3000"], "s1");
  await settle();
  assert.deepEqual(calls.opens, [{ url: "http://localhost:3000/", sessionId: "s1" }]);

  opener.offer(["http://localhost:3000/"], "s1");
  opener.offer(["http://0.0.0.0:3000"], "s1"); // canonicalizes to the same pair
  await settle();
  assert.equal(calls.opens.length, 1);
  assert.equal(calls.probes.length, 1);
});

test("retries an unreachable URL and gives up quietly after the ladder", async () => {
  const { opener, calls } = makeHarness({ probeResults: [false, false, false] });
  opener.offer(["http://localhost:4000"], "s1");
  await settle();
  assert.equal(calls.probes.length, 3);
  assert.deepEqual(calls.sleeps, [10, 20]); // the first attempt is immediate
  assert.equal(calls.opens.length, 0);

  // Giving up leaves the pair un-handled: a fresh mention retries.
  opener.offer(["http://localhost:4000"], "s1");
  await settle();
  assert.equal(calls.probes.length, 6);
});

test("opens on a mid-ladder success (dev server finished booting)", async () => {
  const { opener, calls } = makeHarness({ probeResults: [false, true] });
  opener.offer(["http://localhost:5173"], "s1");
  await settle();
  assert.equal(calls.probes.length, 2);
  assert.deepEqual(calls.opens, [{ url: "http://localhost:5173/", sessionId: "s1" }]);
});

test("a session switch abandons pending probes without opening", async () => {
  let active = true;
  const { opener, calls } = makeHarness({ probeResults: [true], sessionActive: () => active });
  active = false;
  opener.offer(["http://localhost:3000"], "s1");
  await settle();
  assert.equal(calls.opens.length, 0);
  assert.equal(calls.probes.length, 0);

  // Switching back and mentioning it again gets a fresh chance.
  active = true;
  opener.offer(["http://localhost:3000"], "s1");
  await settle();
  assert.equal(calls.opens.length, 1);
});

test("markHandled silences later mentions of the same pair", async () => {
  const { opener, calls } = makeHarness({ probeResults: [true] });
  opener.markHandled("http://localhost:3000", "s1");
  opener.offer(["http://localhost:3000"], "s1");
  await settle();
  assert.equal(calls.probes.length, 0);
  assert.equal(calls.opens.length, 0);

  // Same URL in a different session is a different pair.
  opener.offer(["http://localhost:3000"], "s2");
  await settle();
  assert.deepEqual(calls.opens, [{ url: "http://localhost:3000/", sessionId: "s2" }]);
});

test("a markHandled during an in-flight probe suppresses the open", async () => {
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const opens = [];
  const opener = createPreviewAutoOpener({
    probe: async () => { await probeGate; return true; },
    open: (url) => opens.push(url),
    isSessionActive: () => true,
    sleep: async () => {},
    retryDelaysMs: [0],
  });
  opener.offer(["http://localhost:3000"], "s1");
  opener.markHandled("http://localhost:3000", "s1"); // e.g. the host tool opened it
  releaseProbe();
  await settle();
  assert.equal(opens.length, 0);
});

test("invalid and non-loopback URLs are ignored outright", async () => {
  const { opener, calls } = makeHarness({ probeResults: [true] });
  opener.offer(["http://example.com", "not a url", ""], "s1");
  await settle();
  assert.equal(calls.probes.length, 0);
  assert.equal(calls.opens.length, 0);
});

test("the handled set stays bounded (oldest pair evicted first)", async () => {
  const opens = [];
  const opener = createPreviewAutoOpener({
    probe: async () => true,
    open: (url) => opens.push(url),
    isSessionActive: () => true,
    sleep: async () => {},
    retryDelaysMs: [0],
    maxTrackedKeys: 2,
  });
  opener.markHandled("http://localhost:1", "s1");
  opener.markHandled("http://localhost:2", "s1");
  opener.markHandled("http://localhost:3", "s1"); // evicts :1
  // The evicted pair is offerable again; the still-tracked one stays quiet.
  opener.offer(["http://localhost:1"], "s1");
  opener.offer(["http://localhost:3"], "s1");
  await settle();
  assert.deepEqual(opens, ["http://localhost:1/"]);
});
