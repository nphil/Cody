import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startEngineHousekeeping, stopEngineHousekeeping } = await jiti.import("./housekeeping.ts");

const GIB = 1024 ** 3;
/** Timers are mocked, promises are not: one turn of the real event loop lets a whole pass finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function report(removed = [], extra = {}) {
  return {
    trigger: "hourly",
    startedAt: 0,
    finishedAt: 1,
    removed,
    freedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
    scratch: [],
    checkpointBytes: 0,
    areasBefore: [],
    areasAfter: [],
    errors: [],
    ...extra,
  };
}

test("a pass runs a minute after boot, then every hour, once however often it is started, until stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const calls = [];
  const jobs = {
    janitor: async (trigger) => {
      calls.push(`janitor:${trigger}`);
      return report();
    },
    ompTemp: async () => {
      calls.push("omp");
      return { removed: 0, bytes: 0 };
    },
  };
  try {
    startEngineHousekeeping(jobs);
    startEngineHousekeeping(jobs);

    t.mock.timers.tick(59_999);
    await settle();
    assert.deepEqual(calls, [], "nothing on the startup path");
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(calls, ["janitor:boot", "omp"], "the first pass is the boot pass and includes omp's own leftovers");

    t.mock.timers.tick(3_540_000 - 1);
    await settle();
    assert.equal(calls.length, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(calls.slice(2), ["janitor:hourly", "omp"]);

    stopEngineHousekeeping();
    t.mock.timers.tick(5 * 3_600_000);
    await settle();
    assert.equal(calls.length, 4, "stopped: no more passes");
  } finally {
    stopEngineHousekeeping();
  }
});

test("a pass that removed something logs one plain line, and one that removed nothing logs nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const log = t.mock.method(console, "log", () => {});
  const removed = [
    { path: "/tmp/cs/aaaaaaaaaaaa", bytes: 2 * GIB, reason: "scratch-idle" },
    { path: "/tmp/old-build", bytes: GIB, reason: "tmp-idle" },
    { path: "/data/agent/cody-checkpoints/app-0123456789ab", bytes: 1, reason: "checkpoint" },
  ];
  const area = (usedBytes) => ({ id: "tmp", path: "/tmp", totalBytes: 100, availableBytes: 100 - usedBytes, usedBytes, freeFraction: (100 - usedBytes) / 100, level: "ok" });
  const reports = [report(removed, { areasBefore: [area(72)], areasAfter: [area(48)] }), report()];
  const jobs = { janitor: async () => reports.shift(), ompTemp: async () => ({ removed: 0, bytes: 0 }) };
  try {
    startEngineHousekeeping(jobs);
    t.mock.timers.tick(60_000);
    await settle();
    t.mock.timers.tick(3_540_000);
    await settle();

    const lines = log.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(lines.length, 1, "the second pass removed nothing");
    assert.match(lines[0], /^\[Cody\] disk janitor: hourly pass removed 3 items, 3\.0 GB /);
    assert.match(lines[0], /1 chat scratch folder, 1 old temp file or folder, 1 old undo-snapshot store/);
    assert.match(lines[0], /temp disk 72% → 48% used/);
  } finally {
    stopEngineHousekeeping();
  }
});

test("a job that fails is reported and never takes the other job, or the process, down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const warn = t.mock.method(console, "warn", () => {});
  const log = t.mock.method(console, "log", () => {});
  let ompRan = false;
  const jobs = {
    janitor: async () => {
      throw new Error("the disk is gone");
    },
    ompTemp: async () => {
      ompRan = true;
      return { removed: 2, bytes: 3 * 1_048_576 };
    },
  };
  try {
    startEngineHousekeeping(jobs);
    t.mock.timers.tick(60_000);
    await settle();

    assert.equal(ompRan, true);
    assert.match(String(warn.mock.calls[0].arguments[0]), /disk janitor failed: the disk is gone/);
    assert.match(String(log.mock.calls[0].arguments[0]), /removed 2 old engine temp file\(s\), 3\.0 MB/);
  } finally {
    stopEngineHousekeeping();
  }
});
