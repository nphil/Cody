// What matters here (lib/workers/placement.ts): placement is a pure decision.
// A worker that could NEVER take the job (wrong architecture, missing tool,
// down, unread, already failed it) gives "none"; a worker that matches but is
// full or quiet-hours-only gives "busy" (worth queueing for); anything else is
// placed, best worker first, and the same inputs give the same answer in any order.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const placement = await jiti.import("./placement.ts");
const { place, freeCores, describeRefusals, IDLE_CPU_PERCENT, MIN_FREE_MEM_MB } = placement;

function facts(over = {}) {
  return { name: "w", arch: "x86_64", cpus: 8, memMB: 16384, slots: 4, tools: ["node", "rust"], onlyWhenIdle: false, ...over };
}
function load(over = {}) {
  return { cpuPercent: 0, load1: 0, memAvailMB: 8000, at: 1, ...over };
}
function worker(id, over = {}) {
  return { id, label: id, facts: facts(), healthy: true, running: 0, recentLaunches: 0, load: load(), ...over };
}
const request = (over = {}) => ({ arch: null, tools: [], excluded: new Set(), ...over });

// ── eligible ─────────────────────────────────────────────────────────────────

test("a healthy worker with the right architecture and tools is placed", () => {
  const out = place([worker("a")], request({ arch: "x86_64", tools: ["node"] }));
  assert.deepEqual(out, { kind: "placed", id: "a", label: "a", freeCores: 8 });
});

test("no candidates at all means nobody could ever take it", () => {
  assert.deepEqual(place([], request()), { kind: "none", refusals: [] });
  assert.equal(describeRefusals([]), "no machine is switched on as a worker");
});

test("arch null accepts any architecture and no required tools accepts any worker", () => {
  const arm = worker("arm", { facts: facts({ arch: "aarch64", tools: [] }) });
  assert.equal(place([arm], request()).kind, "placed");
  assert.equal(place([arm], request({ arch: null, tools: [] })).kind, "placed");
});

test("a worker with 4 slots and 2 running is still open; at 4 it is full", () => {
  assert.equal(place([worker("a", { running: 2 })], request()).kind, "placed");
  assert.equal(place([worker("a", { running: 3 })], request()).kind, "placed");
  assert.equal(place([worker("a", { running: 4 })], request()).kind, "busy");
});

// ── permanent refusals ───────────────────────────────────────────────────────

function refusalOf(candidate, req) {
  const out = place([candidate], req);
  assert.notEqual(out.kind, "placed");
  assert.equal(out.refusals.length, 1);
  return { kind: out.kind, refusal: out.refusals[0] };
}

test("a worker with the wrong architecture is never chosen", () => {
  const { kind, refusal } = refusalOf(worker("a"), request({ arch: "aarch64" }));
  assert.equal(kind, "none");
  assert.deepEqual(refusal, { id: "a", label: "a", kind: "permanent", why: "it is x86_64, the job needs aarch64" });
});

test("a worker missing a required tool is never chosen, and every missing tool is named", () => {
  const { kind, refusal } = refusalOf(worker("a"), request({ tools: ["node", "go", "docker"] }));
  assert.equal(kind, "none");
  assert.equal(refusal.kind, "permanent");
  assert.equal(refusal.why, "it has no go, docker");
});

test("a worker that is not healthy is never chosen", () => {
  const { kind, refusal } = refusalOf(worker("a", { healthy: false }), request());
  assert.equal(kind, "none");
  assert.equal(refusal.why, "it did not answer its last check");
});

test("a worker whose description was never read is never chosen", () => {
  const { kind, refusal } = refusalOf(worker("a", { facts: null }), request());
  assert.equal(kind, "none");
  assert.equal(refusal.why, "its description (/etc/cody-worker.json) has not been read yet");
});

test("a machine that already failed this job is excluded even if it is perfect", () => {
  const { kind, refusal } = refusalOf(worker("a"), request({ excluded: new Set(["a"]) }));
  assert.equal(kind, "none");
  assert.deepEqual(refusal, { id: "a", label: "a", kind: "permanent", why: "it already failed this job" });
});

test("an unhealthy worker is reported as down even when it also has the wrong architecture", () => {
  const { refusal } = refusalOf(worker("a", { healthy: false }), request({ arch: "aarch64" }));
  assert.equal(refusal.why, "it did not answer its last check");
});

// ── busy refusals ────────────────────────────────────────────────────────────

test("all slots in use is busy, not none", () => {
  const { kind, refusal } = refusalOf(worker("a", { facts: facts({ slots: 2 }), running: 2 }), request());
  assert.equal(kind, "busy");
  assert.deepEqual(refusal, { id: "a", label: "a", kind: "busy", why: "all 2 of its job slots are in use" });
});

test("an onlyWhenIdle worker takes a job at the idle limit but not above it", () => {
  const idle = facts({ onlyWhenIdle: true });
  assert.equal(place([worker("a", { facts: idle, load: load({ cpuPercent: IDLE_CPU_PERCENT }) })], request()).kind, "placed");
  const { kind, refusal } = refusalOf(worker("a", { facts: idle, load: load({ cpuPercent: IDLE_CPU_PERCENT + 0.4 }) }), request());
  assert.equal(kind, "busy");
  assert.equal(refusal.kind, "busy");
  assert.equal(refusal.why, `it only takes jobs while idle and its CPU is at ${Math.round(IDLE_CPU_PERCENT + 0.4)}%`);
});

test("an onlyWhenIdle worker judged by load average when there is no cpu reading", () => {
  const idle = facts({ onlyWhenIdle: true, cpus: 8 });
  const quiet = worker("a", { facts: idle, load: load({ cpuPercent: null, load1: 1 }) }); // 12.5%
  assert.equal(place([quiet], request()).kind, "placed");
  const loud = worker("a", { facts: idle, load: load({ cpuPercent: null, load1: 6 }) }); // 75%
  const { kind, refusal } = refusalOf(loud, request());
  assert.equal(kind, "busy");
  assert.equal(refusal.why, "it only takes jobs while idle and its CPU is at 75%");
});

test("an onlyWhenIdle worker whose load is unknown is busy, not assumed idle", () => {
  const idle = facts({ onlyWhenIdle: true });
  for (const l of [null, load({ cpuPercent: null, load1: null })]) {
    const { kind, refusal } = refusalOf(worker("a", { facts: idle, load: l }), request());
    assert.equal(kind, "busy");
    assert.equal(refusal.why, "it only takes jobs while idle and its load could not be read");
  }
});

test("an ordinary worker is not held back by a busy CPU or unknown load", () => {
  assert.equal(place([worker("a", { load: load({ cpuPercent: 99 }) })], request()).kind, "placed");
  assert.equal(place([worker("a", { load: null })], request()).kind, "placed");
});

test("memory under the minimum is busy; at the minimum, or unknown, is fine", () => {
  const { kind, refusal } = refusalOf(worker("a", { load: load({ memAvailMB: MIN_FREE_MEM_MB - 1 }) }), request());
  assert.equal(kind, "busy");
  assert.equal(refusal.why, `only ${MIN_FREE_MEM_MB - 1} MB of its memory is free`);
  assert.equal(place([worker("a", { load: load({ memAvailMB: MIN_FREE_MEM_MB }) })], request()).kind, "placed");
  assert.equal(place([worker("a", { load: load({ memAvailMB: null }) })], request()).kind, "placed");
});

test("one permanent and one busy refusal together answer busy", () => {
  const wrongArch = worker("arm", { facts: facts({ arch: "aarch64" }) });
  const full = worker("full", { running: 4 });
  const out = place([wrongArch, full], request({ arch: "x86_64" }));
  assert.equal(out.kind, "busy");
  assert.deepEqual(out.refusals.map((r) => [r.id, r.kind]), [["arm", "permanent"], ["full", "busy"]]);
  assert.equal(place([full, wrongArch], request({ arch: "x86_64" })).kind, "busy");
});

test("only permanent refusals answer none", () => {
  const out = place([worker("a", { healthy: false }), worker("b", { facts: null })], request());
  assert.equal(out.kind, "none");
  assert.equal(out.refusals.length, 2);
});

test("a refused worker never beats an eligible one", () => {
  const out = place([worker("down", { healthy: false }), worker("ok", { load: load({ cpuPercent: 90 }) })], request());
  assert.equal(out.kind, "placed");
  assert.equal(out.id, "ok");
});

// ── choosing the best ────────────────────────────────────────────────────────

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}
function winners(candidates, req = request()) {
  const ids = new Set();
  for (const order of permutations(candidates)) {
    const out = place(order, req);
    assert.equal(out.kind, "placed");
    ids.add(out.id);
  }
  return [...ids];
}

test("the worker with the most free cores wins", () => {
  const candidates = [
    worker("busy", { load: load({ cpuPercent: 75 }) }), // 2 free
    worker("quiet", { load: load({ cpuPercent: 0 }) }), // 8 free
    worker("half", { load: load({ cpuPercent: 50 }) }), // 4 free
  ];
  assert.deepEqual(winners(candidates), ["quiet"]);
});

test("equal free cores: the one running fewer jobs wins", () => {
  // Identical readings; "a" would win the name tiebreak, so only the running count can explain "b".
  const candidates = [
    worker("a", { running: 2, load: load({ cpuPercent: 0 }) }),
    worker("b", { running: 1, load: load({ cpuPercent: 0 }) }),
    worker("c", { running: 3, load: load({ cpuPercent: 0 }) }),
  ];
  assert.deepEqual(winners(candidates), ["b"]);
});

test("equal cores and jobs: the one with more free memory wins", () => {
  const candidates = [
    worker("a", { load: load({ memAvailMB: 2000 }) }),
    worker("b", { load: load({ memAvailMB: 9000 }) }),
    worker("c", { load: load({ memAvailMB: 4000 }) }),
  ];
  assert.deepEqual(winners(candidates), ["b"]);
});

test("free memory falls back to the worker's total when no reading exists", () => {
  const candidates = [
    worker("small", { facts: facts({ memMB: 4096 }), load: null }),
    worker("big", { facts: facts({ memMB: 65536 }), load: null }),
  ];
  assert.deepEqual(winners(candidates), ["big"]);
});

test("everything equal: the label decides, in any input order", () => {
  const candidates = [worker("m"), worker("c"), worker("z"), worker("a")];
  assert.deepEqual(winners(candidates), ["a"]);
  const labelled = [worker("id1", { label: "zeta" }), worker("id2", { label: "alpha" })];
  assert.deepEqual(winners(labelled), ["id2"]);
});

test("free cores outrank running jobs, and running jobs outrank memory", () => {
  const coresBeatJobs = [
    worker("many-cores", { running: 3, load: load({ cpuPercent: 0 }) }),
    worker("few-cores", { running: 0, load: load({ cpuPercent: 20 }) }),
  ];
  assert.deepEqual(winners(coresBeatJobs), ["many-cores"]);
  const jobsBeatMem = [
    worker("big-mem", { running: 2, load: load({ memAvailMB: 60000 }) }),
    worker("few-jobs", { running: 1, load: load({ memAvailMB: 1000 }) }),
  ];
  assert.deepEqual(winners(jobsBeatMem), ["few-jobs"]);
});

test("core differences under a tenth of a core are ties", () => {
  // cpuPercent 0 vs 0.5% of 8 cores = 0.04 cores: same after rounding to 0.1, so jobs decide.
  const candidates = [
    worker("a", { running: 2, load: load({ cpuPercent: 0 }) }),
    worker("b", { running: 1, load: load({ cpuPercent: 0.5 }) }),
  ];
  assert.deepEqual(winners(candidates), ["b"]);
});

test("the placed answer reports the winner's free cores", () => {
  const out = place([worker("a", { load: load({ cpuPercent: 25 }) })], request());
  assert.deepEqual(out, { kind: "placed", id: "a", label: "a", freeCores: 6 });
});

test("place does not reorder or change its input", () => {
  const input = [worker("b", { load: load({ cpuPercent: 80 }) }), worker("a")];
  const snapshot = structuredClone(input);
  place(input, request());
  assert.deepEqual(input, snapshot);
});

// ── freeCores ────────────────────────────────────────────────────────────────

test("free cores come from the cpu reading when there is one", () => {
  assert.equal(freeCores(worker("a", { load: load({ cpuPercent: 25 }) })), 6);
  assert.equal(freeCores(worker("a", { load: load({ cpuPercent: 100 }) })), 0);
});

test("the cpu reading wins over the load average", () => {
  assert.equal(freeCores(worker("a", { load: load({ cpuPercent: 0, load1: 8 }) })), 8);
});

test("without a cpu reading, load average over cores stands in, capped at fully busy", () => {
  assert.equal(freeCores(worker("a", { load: load({ cpuPercent: null, load1: 4 }) })), 4);
  assert.equal(freeCores(worker("a", { load: load({ cpuPercent: null, load1: 80 }) })), 0);
});

test("an unreadable or missing load counts as an idle machine", () => {
  assert.equal(freeCores(worker("a", { load: null })), 8);
  assert.equal(freeCores(worker("a", { load: load({ cpuPercent: null, load1: null }) })), 8);
});

test("each launch from the last few seconds takes one slot's share of the cores", () => {
  // 8 cores / 4 slots = 2 cores per launch.
  assert.equal(freeCores(worker("a", { recentLaunches: 1 })), 6);
  assert.equal(freeCores(worker("a", { recentLaunches: 2, load: load({ cpuPercent: 25 }) })), 2); // 8 - 2 - 4
});

test("free cores are never negative", () => {
  assert.equal(freeCores(worker("a", { recentLaunches: 9 })), 0);
  assert.equal(freeCores(worker("a", { recentLaunches: 3, load: load({ cpuPercent: 100 }) })), 0);
});

test("a worker whose description is unknown has no free cores", () => {
  assert.equal(freeCores(worker("a", { facts: null })), 0);
});

test("a recent launch lowers a worker's rank before any reading shows it", () => {
  const candidates = [worker("a", { recentLaunches: 2 }), worker("b", { recentLaunches: 0 })];
  assert.deepEqual(winners(candidates), ["b"]);
});

// ── describeRefusals ─────────────────────────────────────────────────────────

test("refusals read as one line per machine joined by semicolons", () => {
  const out = place([worker("pi", { facts: facts({ arch: "aarch64" }) }), worker("box", { running: 4 })], request({ arch: "x86_64" }));
  assert.equal(describeRefusals(out.refusals), "pi: it is aarch64, the job needs x86_64; box: all 4 of its job slots are in use");
});

test("refusals are named by label, not id", () => {
  const out = place([worker("m-1", { label: "Build box", healthy: false })], request());
  assert.equal(describeRefusals(out.refusals), "Build box: it did not answer its last check");
});
