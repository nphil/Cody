import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createJiti } from "jiti";

/**
 * The distill store's wire contract. What a transcript renders is entirely
 * decided here, so these cases are the ones a plausible regression breaks:
 * treating `done.text` as an append, letting an unknown frame throw, badging
 * a message for a supersede, or answering a scroll with a dozen streams.
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname },
});
const { readDistillState, requestDistill, resetDistillStore, AUTH_BACKOFF_MS, thinkingSummaryKeys } = await jiti.import("./useDistill.ts");

/** A fetch stub that answers one SSE body per call, in order. */
function stubFetch(bodies) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    const next = bodies.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    if (typeof next === "number") return Promise.resolve({ ok: false, status: next, body: null });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ ok: true, status: 200, body: sseBody(next) });
  };
  return calls;
}

function sseBody(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader() {
      return {
        read() {
          if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
          const value = encoder.encode(chunks[index]);
          index += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Advances the mocked clock and lets its callbacks' own microtasks (a
 *  resolved fetch, a `.then` chain) actually run before the assertion. */
const settleMocked = async (ms = 5) => { const p = settle(); mock.timers.tick(ms); await p; };

const reply = (key, text) => ({ key, sessionId: "s1", entryId: "e1", kind: "reply", text, verbosity: "medium", final: true, plain: false });

test.beforeEach(() => resetDistillStore());

test("deltas accumulate and the done frame replaces them wholesale", async () => {
  stubFetch([[
    'data: {"type":"delta","text":"Half "}\n',
    'data: {"type":"delta","text":"a sentence"}\n',
    'data: {"type":"done","text":"The whole normalized answer.","model":"openai/gpt-5","cached":false}\n',
  ]]);
  requestDistill(reply("k1", "a".repeat(500)));
  await settle();
  const state = readDistillState("k1");
  assert.equal(state.status, "done");
  assert.equal(state.text, "The whole normalized answer.", "done.text is the answer, not a suffix of it");
  assert.equal(state.model, "openai/gpt-5");
  assert.equal(state.cached, false);
  assert.equal(state.errorCode, null);
});

test("a thinking stream with no deltas at all still lands its summary", async () => {
  stubFetch([['data: {"type":"done","text":"Checking how the namer picks a model.","model":"","cached":true}\n']]);
  requestDistill({ key: "k2", sessionId: "s1", entryId: "e1", blockIndex: 0, kind: "thinking", text: "reasoning…", final: true });
  await settle();
  const state = readDistillState("k2");
  assert.equal(state.text, "Checking how the namer picks a model.");
  assert.equal(state.cached, true);
  assert.equal(state.model, null, "an empty selector means the engine default; there is no name to show");
});

test("unknown and renamed frames are ignored, never fatal", async () => {
  stubFetch([[
    ": keep-alive\n",
    'data: {"type":"progress","stage":"spawned"}\n',
    "data: not json at all\n",
    'data: {"type":"delta"}\n',
    'data: {"type":"done","text":"Survived."}\n',
  ]]);
  requestDistill(reply("k3", "b".repeat(500)));
  await settle();
  assert.equal(readDistillState("k3").text, "Survived.");
  assert.equal(readDistillState("k3").status, "done");
});

test("a stream cut off before its terminal event fails instead of hanging", async () => {
  stubFetch([['data: {"type":"delta","text":"partial"}\n']]);
  requestDistill(reply("k4", "c".repeat(500)));
  await settle();
  assert.equal(readDistillState("k4").status, "error");
  assert.equal(readDistillState("k4").errorCode, "failed");
});

test("a supersede is not a failure: the previous answer stays and nothing is badged", async () => {
  stubFetch([
    ['data: {"type":"done","text":"First summary."}\n'],
    ['data: {"type":"error","code":"failed","message":"superseded"}\n'],
  ]);
  requestDistill({ key: "k5", sessionId: "s1", blockIndex: 0, kind: "thinking", text: "one", final: false });
  await settle();
  requestDistill({ key: "k5", sessionId: "s1", blockIndex: 0, kind: "thinking", text: "one two", final: false });
  await settle();
  const state = readDistillState("k5");
  assert.equal(state.text, "First summary.", "the older summary keeps standing in");
  assert.equal(state.errorCode, null, "a supersede must never show 'Could not distill'");
});

test("a rejected request says nothing at all: no retry footer for a body the route refused", async () => {
  stubFetch([400]);
  requestDistill(reply("k6", "d".repeat(500)));
  await settle();
  assert.equal(readDistillState("k6").errorCode, "unsupported", "no retry footer for a body the route refused");
});

test("a 401 pauses Distill for the whole page, then recovers on its own", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    stubFetch([401]);
    requestDistill(reply("k7", "e".repeat(500)));
    await settleMocked();
    assert.equal(readDistillState("k7").errorCode, "unsupported");

    // Still within the backoff window: a DIFFERENT block's request never
    // even leaves the client.
    const calls = stubFetch([['data: {"type":"done","text":"Should not run yet."}\n']]);
    requestDistill(reply("k8", "f".repeat(500)));
    await settleMocked();
    assert.equal(calls.length, 0, "still paused");
    assert.equal(readDistillState("k8").status, "idle");

    // Past the backoff window, Distill tries again on its own: no reload,
    // no manual retry.
    mock.timers.tick(AUTH_BACKOFF_MS);
    requestDistill(reply("k8", "f".repeat(500)));
    await settleMocked();
    assert.equal(calls.length, 1, "the backoff cleared on its own");
    assert.equal(readDistillState("k8").status, "done");
  } finally {
    mock.timers.reset();
  }
});

test("unsupported latches permanently: it never clears itself the way a 401 backoff does", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    stubFetch([['data: {"type":"error","code":"unsupported","message":"ACP engine"}\n']]);
    requestDistill(reply("k9", "g".repeat(500)));
    await settleMocked();
    assert.equal(readDistillState("k9").errorCode, "unsupported");

    mock.timers.tick(AUTH_BACKOFF_MS * 10);
    const calls = stubFetch([['data: {"type":"done","text":"Should never run."}\n']]);
    requestDistill(reply("k10", "h".repeat(500)));
    await settleMocked();
    assert.equal(calls.length, 0, "unsupported does not recover on its own, unlike a 401 backoff");
  } finally {
    mock.timers.reset();
  }
});

test("queue overflow is not badged as a failure, and forgets the request so a later ask is not deduped", async () => {
  stubFetch([['data: {"type":"error","code":"failed","message":"queue_overflow"}\n']]);
  requestDistill({ key: "k11", sessionId: "s1", blockIndex: 0, kind: "thinking", text: "reasoning", final: true, plain: false });
  await settle();
  const state = readDistillState("k11");
  assert.equal(state.status, "idle", "reads as never-asked, not as a failed distill");
  assert.equal(state.errorCode, null, "never shows 'Could not distill' for an eviction that was never the model's fault");

  // Because the request was forgotten (not deduped like a genuine repeat),
  // asking again with the SAME text actually reaches the server.
  const calls = stubFetch([['data: {"type":"done","text":"Reading the config loader."}\n']]);
  requestDistill({ key: "k11", sessionId: "s1", blockIndex: 0, kind: "thinking", text: "reasoning", final: true, plain: false });
  await settle();
  assert.equal(calls.length, 1, "a block dropped by queue overflow gets a real retry when visible again");
  assert.equal(readDistillState("k11").text, "Reading the config loader.");
});

test("a request already dispatched is left to finish; a newer same-key tick queues behind it instead of aborting it", async () => {
  const calls = [];
  const seenSignals = [];
  const gates = [];
  globalThis.fetch = (url, init) => {
    calls.push(JSON.parse(init.body).text);
    seenSignals.push(init.signal);
    const { promise, resolve } = Promise.withResolvers();
    gates.push(resolve);
    const text = calls.length === 1 ? "Slow but real." : "Newer.";
    return promise.then(() => ({ ok: true, status: 200, body: sseBody([`data: {"type":"done","text":"${text}"}\n`]) }));
  };

  requestDistill({ key: "live1", sessionId: "s1", blockIndex: 0, kind: "thinking", text: "growing", final: false, plain: false });
  await settle();
  // A second tick for the SAME block arrives before the first has answered
  // — exactly the streaming re-ask cadence once a real attempt takes longer
  // than the resubmission interval.
  requestDistill({ key: "live1", sessionId: "s1", blockIndex: 0, kind: "thinking", text: "growing more", final: false, plain: false });
  await settle();

  assert.equal(calls.length, 1, "the newer tick must not dispatch a second fetch while the first is still in flight");
  assert.equal(seenSignals[0].aborted, false, "the in-flight request must survive a newer same-key tick");

  gates[0]();
  await settle();
  assert.equal(readDistillState("live1").text, "Slow but real.", "the slow answer is not thrown away by the newer tick");
  assert.equal(calls.length, 2, "the queued newer text gets its own attempt the moment the first's slot frees up");
  assert.equal(seenSignals[1].aborted, false);

  gates[1]();
  await settle();
  assert.equal(readDistillState("live1").text, "Newer.", "and it wins once it lands");
});

test("thinkingSummaryKeys: the final key never depends on whether the block is expanded; the live key does", () => {
  const base = { distillOn: true, plain: false, sessionId: "s1", entryId: "e1", blockIndex: 2 };
  const collapsed = thinkingSummaryKeys({ ...base, collapsed: true });
  const expanded = thinkingSummaryKeys({ ...base, collapsed: false });
  assert.equal(collapsed.finalKey, expanded.finalKey, "the settled summary is requested however the box is drawn");
  assert.ok(collapsed.liveKey !== null, "a collapsed, streaming box wants a running summary");
  assert.equal(expanded.liveKey, null, "an open box already shows everything; no running summary is needed");
});

test("thinkingSummaryKeys: distill off or a missing id means no keys at all, and plain never collides with normal", () => {
  const off = thinkingSummaryKeys({ distillOn: false, collapsed: true, plain: false, sessionId: "s1", entryId: "e1", blockIndex: 0 });
  assert.deepEqual(off, { liveKey: null, finalKey: null });

  const noSession = thinkingSummaryKeys({ distillOn: true, collapsed: true, plain: false, sessionId: undefined, entryId: "e1", blockIndex: 0 });
  assert.equal(noSession.liveKey, null);

  const unsettled = thinkingSummaryKeys({ distillOn: true, collapsed: false, plain: false, sessionId: "s1", entryId: undefined, blockIndex: 0 });
  assert.equal(unsettled.finalKey, null, "final needs an entryId; the block has not settled yet");

  const normal = thinkingSummaryKeys({ distillOn: true, collapsed: true, plain: false, sessionId: "s1", entryId: "e1", blockIndex: 0 });
  const plain = thinkingSummaryKeys({ distillOn: true, collapsed: true, plain: true, sessionId: "s1", entryId: "e1", blockIndex: 0 });
  assert.notEqual(normal.liveKey, plain.liveKey);
  assert.notEqual(normal.finalKey, plain.finalKey);
});

test("a server fault is retryable, so the muted footer can actually appear", async () => {
  // 4xx is about this request and a Retry click cannot fix it; 5xx is the
  // transient case the footer exists for.
  stubFetch([503]);
  requestDistill(reply("k11", "i".repeat(500)));
  await settle();
  assert.equal(readDistillState("k11").errorCode, "failed");
});

test("an error event with a real code surfaces it for the retry footer", async () => {
  stubFetch([['data: {"type":"error","code":"no_model","message":"no chain entry answered"}\n']]);
  requestDistill(reply("k9", "g".repeat(500)));
  await settle();
  assert.equal(readDistillState("k9").errorCode, "no_model");
  assert.equal(readDistillState("k9").text, "", "a failed distill contributes no text; the full reply stands");
});

test("an identical repeat is a no-op, so an effect may fire every render", async () => {
  const calls = stubFetch([['data: {"type":"done","text":"Once."}\n']]);
  const request = reply("k10", "h".repeat(500));
  requestDistill(request);
  requestDistill({ ...request });
  requestDistill({ ...request });
  await settle();
  assert.equal(calls.length, 1);
});

test("at most two streams are open at once; the rest queue", async () => {
  let open = 0;
  let peak = 0;
  const release = [];
  globalThis.fetch = () => {
    open += 1;
    peak = Math.max(peak, open);
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: () => new Promise((resolve) => {
              release.push(() => {
                open -= 1;
                resolve({ done: true, value: undefined });
              });
            }),
          };
        },
      },
    });
  };
  for (let i = 0; i < 6; i++) requestDistill(reply(`q${i}`, `${i}`.repeat(500)));
  await settle();
  assert.equal(peak, 2, "a scroll through history must not open a fan of streams");
  while (release.length > 0) release.shift()();
  await settle();
  assert.ok(peak <= 2);
});
