import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The rules that tell a token burn from work. Every sequence here is shaped
 * like something this server's transcripts really hold: the 2026-11-12 loop
 * (a compaction before every request, each keeping ~91% and followed by
 * ~167,000 tokens at full price), the milder dead end omp 18.20.0 still has
 * (a compaction every third request that keeps ~83%), a healthy helper (one
 * compaction every dozen or more requests, keeping ~30%), a long main chat
 * with an hour-old cache, and a provider that never caches at all. What is
 * pinned is the outcome a person would see: stopped, or left alone.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { BURN_LIMITS, detectBurn, describeBurn } = await jiti.import("./burn-detect.ts");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse("2026-11-12T17:05:00Z");

/** Builds a transcript's events on a clock the test owns. */
function trail(start = T0) {
  const events = [];
  let at = start;
  const api = {
    events,
    get now() { return at; },
    wait(ms) { at += ms; return api; },
    request(fresh = 4_000, { cached = true, gap = 7 * SECOND } = {}) { at += gap; events.push({ kind: "request", at, fresh, cached }); return api; },
    compaction(before, after, { warned = false, gap = SECOND } = {}) { at += gap; events.push({ kind: "compaction", at, before, after, warned }); return api; },
    /** `count` ordinary steps. */
    work(count) { for (let i = 0; i < count; i += 1) api.request(); return api; },
  };
  return api;
}

test("the 2026-11-12 loop is stopped within six requests of its start", () => {
  const t = trail().work(75);
  let verdict = null;
  let requests = 0;
  while (!verdict && requests < 30) {
    t.compaction(208_780, 189_735, { warned: true }).request(166_271);
    requests += 1;
    verdict = detectBurn(t.events, t.now);
  }
  assert.deepEqual(verdict, { rule: "stuck", compactions: 5, requests: 5 });
  assert.ok(requests <= 6, `tripped after ${requests} looping requests`);
  assert.equal(
    describeBurn(verdict, "Helper DbHealth"),
    "Helper DbHealth cleaned up its memory 5 times within 5 steps and freed almost nothing each time",
  );
});

test("compactions on every step are churn even when each one frees plenty", () => {
  const t = trail().work(20);
  for (let i = 0; i < 5; i += 1) t.compaction(96_160, 40_000).request();
  assert.equal(detectBurn(t.events, t.now), null, "five is still inside what the regular path has been seen to do");
  t.compaction(96_160, 40_000).request();
  assert.deepEqual(detectBurn(t.events, t.now), { rule: "churn", compactions: 6, requests: 6 });
  assert.equal(describeBurn({ rule: "churn", compactions: 6, requests: 6 }, "The main agent"), "The main agent cleaned up its memory 6 times within 6 steps");
});

test("the dead end omp 18.20.0 still has (every third request, ~83% kept) is stuck", () => {
  const t = trail().work(6);
  for (let i = 0; i < 4; i += 1) t.compaction(83_950, 69_092, { warned: true }).work(3);
  assert.equal(detectBurn(t.events, t.now), null);
  t.compaction(83_950, 69_092, { warned: true }).request();
  assert.deepEqual(detectBurn(t.events, t.now), { rule: "stuck", compactions: 5, requests: 13 });
});

test("a healthy helper is left alone: a compaction every dozen requests that frees most of the context", () => {
  const t = trail();
  for (let i = 0; i < 12; i += 1) {
    t.work(13).compaction(200_357, 58_403).request(27_000);
    assert.equal(detectBurn(t.events, t.now), null);
  }
});

test("one compaction that freed too little is not a loop, and neither are four", () => {
  const t = trail().work(30);
  for (let i = 0; i < 4; i += 1) t.compaction(255_208, 188_061, { warned: true }).work(2);
  assert.equal(detectBurn(t.events, t.now), null);
});

test("a dead end at a 200,000-token trigger is stuck: a useless compaction every dozen requests", () => {
  // What omp 18.8.3 did to a revived helper (201,698 -> 178,907, flagged), and what 18.20.0 still does near the recovery band.
  const t = trail().work(20);
  for (let i = 0; i < 4; i += 1) t.compaction(201_698, 178_907, { warned: true }).work(12);
  assert.equal(detectBurn(t.events, t.now), null);
  t.compaction(201_698, 178_907, { warned: true }).request();
  assert.deepEqual(detectBurn(t.events, t.now), { rule: "stuck", compactions: 5, requests: 49 });
});

test("compactions that freed too little but came far apart are not stuck", () => {
  const t = trail();
  for (let i = 0; i < 8; i += 1) t.compaction(85_399, 70_000, { warned: true }).work(16);
  assert.equal(detectBurn(t.events, t.now), null, "five of them span 80 requests");
});

test("an engine flag alone does not make a compaction useless", () => {
  // omp 18.8.3 flagged compactions that halved the context (85,399 -> 40,295): wasteful settings, not a loop.
  const t = trail().work(10);
  for (let i = 0; i < 5; i += 1) t.compaction(85_399, 40_295, { warned: true }).work(3);
  assert.equal(detectBurn(t.events, t.now), null);
  // With no figure for what was left, the flag is all there is to go on.
  const blind = trail().work(10);
  for (let i = 0; i < 5; i += 1) blind.compaction(85_399, null, { warned: true }).work(3);
  assert.equal(detectBurn(blind.events, blind.now)?.rule, "stuck");
});

test("an old loop in a transcript is history: nothing is judged once the evidence is stale", () => {
  const t = trail().work(5);
  for (let i = 0; i < 8; i += 1) t.compaction(208_780, 189_735, { warned: true }).request(166_271);
  assert.equal(detectBurn(t.events, t.now)?.rule, "stuck");
  assert.equal(detectBurn(t.events, t.now + BURN_LIMITS.freshMs + SECOND), null, "the loop ended three minutes ago");
  // A chat reopened the next day reads the same lines.
  assert.equal(detectBurn(t.events, t.now + 24 * 60 * MINUTE), null);
});

test("what was already dealt with is never judged twice", () => {
  const t = trail().work(5);
  for (let i = 0; i < 8; i += 1) t.compaction(208_780, 189_735, { warned: true }).request(166_271);
  const stoppedAt = t.now;
  assert.equal(detectBurn(t.events, t.now, BURN_LIMITS, stoppedAt), null);
  // Woken again, it loops again: fresh evidence is judged on its own.
  for (let i = 0; i < 4; i += 1) t.compaction(208_780, 189_735, { warned: true }).request(166_271);
  assert.equal(detectBurn(t.events, t.now, BURN_LIMITS, stoppedAt), null);
  t.compaction(208_780, 189_735, { warned: true }).request(166_271);
  assert.equal(detectBurn(t.events, t.now, BURN_LIMITS, stoppedAt)?.rule, "stuck");
});

test("request after request at full price is a burn, with no compaction at all", () => {
  // LumaShow, 2026-09-28: every second or third request rewrote a 390,000-token context to the cache.
  const t = trail().work(40);
  for (let i = 0; i < 7; i += 1) t.request(388_000).work(2);
  assert.equal(detectBurn(t.events, t.now), null, "seven hot requests");
  t.request(388_000);
  const verdict = detectBurn(t.events, t.now);
  assert.deepEqual(verdict, { rule: "rate", requests: 8, tokens: 8 * 388_000, minutes: 3 });
  assert.equal(describeBurn(verdict, "The main agent"), "The main agent paid full price for 3.1 million tokens of context in 3 minutes (8 requests)");
});

test("a long chat's ordinary expensive moments are not a burn", () => {
  // An hour-old cache, a model switch, a compaction and its rewrite: five hot requests in ten minutes is the most any ordinary transcript here holds.
  const t = trail().work(60);
  t.request(564_000).work(4).request(610_000).work(3).request(120_000).work(5).request(150_000).work(2).request(101_000).work(6);
  assert.equal(detectBurn(t.events, t.now), null);
  // The same eight spread over an afternoon.
  const slow = trail().work(10);
  for (let i = 0; i < 8; i += 1) slow.request(300_000).wait(9 * MINUTE).work(3);
  assert.equal(detectBurn(slow.events, slow.now), null);
});

test("a provider that never caches bills every request in full, and that is not a burn", () => {
  const t = trail();
  for (let i = 0; i < 40; i += 1) t.request(180_000, { cached: false });
  assert.equal(detectBurn(t.events, t.now), null);
});

test("a transcript whose requests cannot be read is not judged on its compactions alone", () => {
  const t = trail();
  for (let i = 0; i < 9; i += 1) t.compaction(208_780, 189_735, { warned: true });
  assert.equal(detectBurn(t.events, t.now), null);
});

test("the numbers are the documented ones", () => {
  assert.deepEqual(
    { ...BURN_LIMITS },
    {
      windowMs: 30 * MINUTE,
      freshMs: 3 * MINUTE,
      churnCompactions: 6,
      churnRequests: 12,
      stuckCompactions: 5,
      stuckRequests: 60,
      warnedKeptRatio: 0.7,
      plainKeptRatio: 0.9,
      hotTokens: 100_000,
      hotRequests: 8,
      hotWindowMs: 10 * MINUTE,
      scanEveryMs: 20_000,
      tailBytes: 8 * 1024 * 1024,
      escalateStops: 3,
      escalateWindowMs: 60 * MINUTE,
      sendBoundMs: 60_000,
    },
  );
});
