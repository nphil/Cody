import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The numbers in the top bar come from three Linux files read on this server or
 * printed by a loop on a machine over ssh. What matters: CPU use is the busy
 * share BETWEEN two readings (never since boot), memory counts reclaimable
 * cache as free, an old kernel still reads, and a half-printed or garbled
 * stream never produces a number.
 */
const jiti = createJiti(import.meta.url);
const proc = await jiti.import("./proc.ts");

const STAT_A = "cpu  1000 100 500 8000 400 0 50 0 0 0";
const STAT_B = "cpu  1330 100 600 8300 500 0 50 0 0 0"; // +330 user, +100 system, +300 idle, +100 iowait

test("cpu time totals the first eight columns and counts iowait as idle", () => {
  assert.deepEqual(proc.parseCpuTimes(STAT_A), { total: 10050, idle: 8400 });
  // guest and guest_nice are already inside user/nice: adding them would count them twice.
  assert.deepEqual(proc.parseCpuTimes("cpu  10 0 5 80 5 0 0 0 7 7"), { total: 100, idle: 85 });
});

test("an old kernel with only four cpu columns still reads", () => {
  assert.deepEqual(proc.parseCpuTimes("cpu 10 0 5 85"), { total: 100, idle: 85 });
});

test("a line that is not the aggregate cpu line, or is garbled, is refused", () => {
  assert.equal(proc.parseCpuTimes("cpu0 1 2 3 4 5"), null);
  assert.equal(proc.parseCpuTimes("cpu  1 2 x 4 5"), null);
  assert.equal(proc.parseCpuTimes("cpu 1 2"), null);
  assert.equal(proc.parseCpuTimes(""), null);
});

test("cpu use is the busy share between two readings", () => {
  const a = proc.parseCpuTimes(STAT_A);
  const b = proc.parseCpuTimes(STAT_B);
  // 830 ticks passed, 400 of them idle (300 idle + 100 iowait): 430 busy.
  assert.equal(proc.cpuPercent(a, b), 51.8);
  assert.equal(proc.cpuPercent(a, { total: a.total + 100, idle: a.idle + 100 }), 0);
  assert.equal(proc.cpuPercent(a, { total: a.total + 100, idle: a.idle }), 100);
});

test("no ticks, or counters that went backwards, give no figure rather than a wrong one", () => {
  const a = proc.parseCpuTimes(STAT_A);
  assert.equal(proc.cpuPercent(a, a), null, "no time passed");
  assert.equal(proc.cpuPercent(a, { total: a.total - 5, idle: a.idle - 5 }), null, "rebooted between readings");
  assert.equal(proc.cpuPercent(a, { total: a.total + 10, idle: a.idle - 1 }), null, "idle ran backwards");
});

const MEMINFO = [
  "MemTotal:       65667444 kB",
  "MemFree:         2111468 kB",
  "MemAvailable:   22034404 kB",
  "Buffers:          500000 kB",
  "Cached:         15000000 kB",
];

test("memory in use leaves out reclaimable cache (MemAvailable)", () => {
  assert.deepEqual(proc.parseMeminfo(MEMINFO), { totalKb: 65667444, availableKb: 22034404 });
});

test("a kernel without MemAvailable falls back to free + buffers + cache", () => {
  const old = MEMINFO.filter((line) => !line.startsWith("MemAvailable"));
  assert.deepEqual(proc.parseMeminfo(old), { totalKb: 65667444, availableKb: 2111468 + 500000 + 15000000 });
});

test("memory without a total, or without any free figure, is refused", () => {
  assert.equal(proc.parseMeminfo(MEMINFO.slice(1)), null);
  assert.equal(proc.parseMeminfo(["MemTotal: 100 kB"]), null);
  assert.equal(proc.parseMeminfo([]), null);
});

test("available memory is clamped into 0..total", () => {
  assert.equal(proc.parseMeminfo(["MemTotal: 100 kB", "MemAvailable: 250 kB"]).availableKb, 100);
});

test("the one-minute load comes from the first loadavg field only", () => {
  assert.equal(proc.parseLoad1("21.51 25.50 30.54 23/7590 479055"), 21.51);
  assert.equal(proc.parseLoad1("0.00 0.01 0.05 1/100 42\n"), 0);
  assert.equal(proc.parseLoad1("nonsense"), null);
});

test("cores are the cpuN lines of /proc/stat", () => {
  const stat = [STAT_A, "cpu0 1 1 1 1 1", "cpu1 1 1 1 1 1", "cpu12 1 1 1 1 1", "intr 5 6 7", "ctxt 4"].join("\n");
  assert.equal(proc.countCores(stat), 3);
  assert.equal(proc.countCores("cpu  1 2 3 4\nctxt 1"), null);
});

test("metrics put cpu, memory and load in the shape the bar reads", () => {
  const first = proc.buildRawSample({ cpuLine: STAT_A, memLines: MEMINFO, loadLine: "1.0 1.0 1.0 1/1 1", cores: 16 });
  const second = proc.buildRawSample({ cpuLine: STAT_B, memLines: MEMINFO, loadLine: "2.5 1.0 1.0 1/1 1", cores: 16 });
  assert.deepEqual(proc.metricsFrom(null, first, 1000), {
    cpuPercent: null,
    cores: 16,
    load1: 1,
    memTotalBytes: 65667444 * 1024,
    memUsedBytes: (65667444 - 22034404) * 1024,
    memPercent: 66.4,
    at: 1000,
  });
  const metrics = proc.metricsFrom(first, second, 3000);
  assert.equal(metrics.cpuPercent, 51.8);
  assert.equal(metrics.load1, 2.5);
  assert.equal(metrics.at, 3000);
});

test("a reading with no cpu line or no memory is refused as a whole", () => {
  assert.equal(proc.buildRawSample({ cpuLine: null, memLines: MEMINFO, loadLine: null, cores: 4 }), null);
  assert.equal(proc.buildRawSample({ cpuLine: STAT_A, memLines: [], loadLine: null, cores: 4 }), null);
  const noLoad = proc.buildRawSample({ cpuLine: STAT_A, memLines: MEMINFO, loadLine: null, cores: null });
  assert.equal(noLoad.load1, null, "load is optional");
  assert.equal(noLoad.cores, null, "cores are optional");
});

function frame(cores, cpu, load = "0.50 0.40 0.30 1/200 999") {
  return [`@S ${cores}`, cpu, ...MEMINFO, load, "@E", ""].join("\n");
}

test("the ssh stream yields one reading per framed block, however the bytes are chunked", () => {
  const stream = new proc.SampleStream();
  const text = frame(8, STAT_A) + frame(8, STAT_B);
  const events = [];
  // Feed three bytes at a time: line boundaries fall anywhere.
  for (let i = 0; i < text.length; i += 3) events.push(...stream.feed(text.slice(i, i + 3)));
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.kind === "sample"));
  assert.equal(events[0].sample.cores, 8);
  assert.equal(events[0].sample.cpu.total, 10050);
  assert.equal(events[1].sample.cpu.total, 10880);
  assert.equal(events[1].sample.load1, 0.5);
});

test("a machine that is not Linux says so once", () => {
  const stream = new proc.SampleStream();
  assert.deepEqual(stream.feed("@NOPROC\n"), [{ kind: "no_proc" }]);
});

test("junk between frames, a block cut short and a frame with missing memory yield nothing", () => {
  const stream = new proc.SampleStream();
  const junk = "Warning: something\nhead: cannot open '/proc/stat'\n";
  const cutShort = ["@S 4", STAT_A, "MemTotal: 100 kB"].join("\n") + "\n"; // never closed
  const noMemory = ["@S 4", STAT_A, "0.1 0.1 0.1 1/1 1", "@E", ""].join("\n");
  assert.deepEqual(stream.feed(junk + cutShort + noMemory), []);
  // The unclosed block was dropped when the next @S began; a good frame still works.
  const events = stream.feed(frame(4, STAT_A));
  assert.equal(events.length, 1);
});

test("Windows line endings do not poison the numbers", () => {
  const stream = new proc.SampleStream();
  const events = stream.feed(frame(2, STAT_A).replace(/\n/g, "\r\n"));
  assert.equal(events.length, 1);
  assert.equal(events[0].sample.cpu.total, 10050);
});

test("a stream that never sends a newline cannot grow without bound", () => {
  const stream = new proc.SampleStream();
  stream.feed("x".repeat(200_000));
  // Still usable afterwards.
  assert.equal(stream.feed(frame(1, STAT_A)).length, 1);
});
