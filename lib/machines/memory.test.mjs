import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What Cody learns about memory only ever reorders the places a job can run, so
 * what matters is that it stays bounded and can never wedge anything: needs
 * fade after two weeks, cool-downs end, a broken ledger file is started
 * afresh, the first reading of a machine (or one after a reboot) is only a
 * baseline, and this server's own "low on memory" alarm goes off once per
 * episode, not on every reading.
 */
const agentDir = mkdtempSync(join(tmpdir(), "cody-memory-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const memory = await jiti.import("./memory.ts");
const store = await jiti.import("./memory-store.ts");
const watch = await jiti.import("./memory-watch.ts");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const LEDGER = join(agentDir, "cody-worker-memory.json");

let seq = 0;
function folder(name, files = {}) {
  const dir = join(agentDir, `${name}-${++seq}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function freshStore() {
  rmSync(LEDGER, { force: true });
  store.resetMemoryLedgerCache();
}

/** Run `body` with console.warn and console.log caught; returns what was warned. */
function quietly(body) {
  const warned = [];
  const { warn, log } = console;
  console.warn = (message) => warned.push(String(message));
  console.log = () => {};
  try {
    body();
  } finally {
    console.warn = warn;
    console.log = log;
  }
  return warned;
}

// ── What a command needs ─────────────────────────────────────────────────────

test("runs of the same command share what was learned: numbers and spacing do not split them, projects do", () => {
  assert.equal(memory.commandShape("cargo  build -j 16\n--release"), "cargo build -j # --release");
  assert.equal(memory.commandShape("x".repeat(300)).length, 200);
  assert.equal(memory.estimateKey("/data/home/a", "make -j8"), "/data/home/a\nmake -j#");
  assert.notEqual(memory.estimateKey("/data/home/a", "make"), memory.estimateKey("/data/home/b", "make"));
});

test("a command needs the biggest of its last three runs of the past two weeks, plus a fifth", () => {
  const ledger = memory.emptyLedger();
  assert.equal(memory.estimateBytes(ledger, "k", NOW), null, "never run: unknown, anything will do");

  memory.recordPeak(ledger, "k", { at: NOW - 20 * DAY, bytes: 9 * GIB, machine: "w1", oom: false });
  memory.recordPeak(ledger, "k", { at: NOW - 3 * DAY, bytes: 1 * GIB, machine: "w1", oom: false });
  memory.recordPeak(ledger, "k", { at: NOW - 2 * DAY, bytes: 2 * GIB, machine: "w2", oom: false });
  assert.equal(memory.estimateBytes(ledger, "k", NOW), Math.round(2 * GIB * 1.2), "the 20-day-old run no longer counts");

  memory.recordPeak(ledger, "k", { at: NOW - DAY, bytes: 512 * MIB, machine: "w1", oom: false });
  memory.recordPeak(ledger, "k", { at: NOW - HOUR, bytes: 768 * MIB, machine: "w1", oom: false });
  assert.equal(ledger.peaks.k.length, 3, "only the last three runs are kept");
  assert.equal(memory.estimateBytes(ledger, "k", NOW), Math.round(2 * GIB * 1.2));
  memory.recordPeak(ledger, "k", { at: NOW, bytes: 256 * MIB, machine: "w1", oom: false });
  assert.equal(memory.estimateBytes(ledger, "k", NOW), Math.round(768 * MIB * 1.2), "the 2 GB run has dropped out of the last three");
  assert.equal(memory.estimateBytes(ledger, "k", NOW + 15 * DAY), null, "two weeks later nothing is known any more");
});

test("a run the kernel stopped for lack of memory counts as needing at least the limit it ran into", () => {
  const ledger = memory.emptyLedger();
  memory.recordPeak(ledger, "k", { at: NOW, bytes: 3 * GIB, machine: "w1", oom: true, capBytes: 16 * GIB });
  assert.deepEqual(ledger.peaks.k, [{ at: NOW, bytes: 16 * GIB, machine: "w1", oom: true }]);
  memory.recordPeak(ledger, "k", { at: NOW, bytes: null, machine: "w1", oom: true, capBytes: 10 * GIB });
  assert.equal(ledger.peaks.k.at(-1).bytes, 10 * GIB, "no peak reading: the limit alone");
  memory.recordPeak(ledger, "none", { at: NOW, bytes: null, machine: "w1", oom: false });
  assert.equal(ledger.peaks.none, undefined, "a run with no reading teaches nothing");
});

// ── Cool-downs ───────────────────────────────────────────────────────────────

test("a machine that ran out of memory goes behind the others for 5 minutes, one that was short of it for 2", () => {
  const ledger = memory.emptyLedger();
  assert.equal(memory.startCooldown(ledger, "w1", "pressure", NOW), true);
  assert.deepEqual(memory.coolingDown(ledger, "w1", NOW), { until: NOW + 2 * 60_000, why: "pressure" });
  assert.equal(memory.startCooldown(ledger, "w1", "pressure", NOW + 60_000), false, "already cooling down: not news");
  assert.equal(memory.coolingDown(ledger, "w1", NOW).until, NOW + 3 * 60_000, "but it lasts from the newer reading");

  assert.equal(memory.startCooldown(ledger, "w1", "oom", NOW + 60_000), true, "an out-of-memory kill is worse news than pressure");
  assert.deepEqual(memory.coolingDown(ledger, "w1", NOW + 60_000), { until: NOW + 6 * 60_000, why: "oom" });
  assert.equal(memory.startCooldown(ledger, "w1", "pressure", NOW + 120_000), false, "pressure does not shorten or replace it");
  assert.equal(memory.coolingDown(ledger, "w1", NOW + 120_000).why, "oom");

  assert.equal(memory.coolingDown(ledger, "w1", NOW + 6 * 60_000), null, "it ends by itself");
  assert.equal(memory.startCooldown(ledger, "w1", "pressure", NOW + 6 * 60_000), true);
});

test("an out-of-memory count only counts once it went up within the same boot", () => {
  const ledger = memory.emptyLedger();
  assert.equal(memory.noteOomCount(ledger, "w1", "boot-a", 4), false, "the first reading is a baseline");
  assert.equal(memory.noteOomCount(ledger, "w1", "boot-a", 4), false);
  assert.equal(memory.noteOomCount(ledger, "w1", "boot-a", 5), true);
  assert.equal(memory.noteOomCount(ledger, "w1", "boot-b", 0), false, "after a reboot the count starts again");
  assert.equal(memory.noteOomCount(ledger, "w1", "boot-b", 1), true);
});

// ── The ledger itself ────────────────────────────────────────────────────────

test("a ledger read from disk keeps what is well-formed, entry by entry, and anything else starts afresh", () => {
  assert.equal(memory.checkLedger(null), null);
  assert.equal(memory.checkLedger([]), null);
  assert.equal(memory.checkLedger({ version: 2 }), null);
  const checked = memory.checkLedger({
    version: 1,
    peaks: { good: [{ at: 1, bytes: 5, machine: "w1", oom: false, extra: 1 }, { at: "x", bytes: 5, machine: "w1", oom: false }], bad: "nope", empty: [{}] },
    cooldowns: { w1: { until: 10, why: "oom" }, w2: { until: 10, why: "boredom" }, w3: null },
    events: [
      { at: 1, machine: "local", kind: "high", text: "t" },
      { at: 1, machine: "local", kind: "party", text: "t" },
      { at: 1, machine: "w1", kind: "oom", text: "j", detail: { what: "job", capBytes: null, peakBytes: 5 } },
      { at: 1, machine: "w1", kind: "pressure", text: "c", detail: { what: "cooldown", minutes: "2" } },
      { at: 1, machine: "w1", kind: "oom", text: "w", detail: { what: "wait" } },
      "x",
    ],
    jobs: { 123: { w1: 2, w2: -1 }, abc: { w1: 1 } },
    seen: { w1: { boot: "b", oom: 3 }, w2: { boot: 1, oom: 3 } },
  });
  assert.deepEqual(checked, {
    version: 1,
    peaks: { good: [{ at: 1, bytes: 5, machine: "w1", oom: false }] },
    cooldowns: { w1: { until: 10, why: "oom" } },
    events: [
      { at: 1, machine: "local", kind: "high", text: "t" },
      { at: 1, machine: "w1", kind: "oom", text: "j", detail: { what: "job", capBytes: null, peakBytes: 5 } },
      { at: 1, machine: "w1", kind: "pressure", text: "c" },
      { at: 1, machine: "w1", kind: "oom", text: "w" },
    ],
    jobs: { 123: { w1: 2 } },
    seen: { w1: { boot: "b", oom: 3 } },
  });
});

test("pruning forgets what is too old to matter and keeps the newest commands", () => {
  const ledger = memory.emptyLedger();
  for (let i = 0; i < memory.MAX_COMMANDS + 1; i++) memory.recordPeak(ledger, `k${i}`, { at: NOW - (memory.MAX_COMMANDS + 1 - i) * 1000, bytes: MIB, machine: "w1", oom: false });
  memory.recordPeak(ledger, "old", { at: NOW - 15 * DAY, bytes: MIB, machine: "w1", oom: false });
  memory.startCooldown(ledger, "w1", "oom", NOW - 10 * 60_000);
  memory.startCooldown(ledger, "w2", "pressure", NOW);
  memory.recordEvent(ledger, { at: NOW - 8 * DAY, machine: "w1", kind: "oom", text: "old" });
  memory.recordEvent(ledger, { at: NOW - DAY, machine: "w1", kind: "oom", text: "recent" });
  memory.countJob(ledger, "w1", NOW - 25 * HOUR);
  memory.countJob(ledger, "w1", NOW - 2 * HOUR);

  memory.pruneLedger(ledger, NOW);
  assert.equal(Object.keys(ledger.peaks).length, memory.MAX_COMMANDS);
  assert.equal(ledger.peaks.k0, undefined, "the command run longest ago goes first");
  assert.ok(ledger.peaks[`k${memory.MAX_COMMANDS}`]);
  assert.equal(ledger.peaks.old, undefined);
  assert.deepEqual(Object.keys(ledger.cooldowns), ["w2"]);
  assert.deepEqual(ledger.events.map((event) => event.text), ["recent"]);
  assert.deepEqual(memory.jobsLast24h(ledger, NOW), { w1: 1 });
  assert.equal(Object.keys(ledger.jobs).length, 1);
});

test("the recent-events list holds at most fifty", () => {
  const ledger = memory.emptyLedger();
  for (let i = 0; i < 60; i++) memory.recordEvent(ledger, { at: NOW + i, machine: "w1", kind: "pressure", text: `e${i}` });
  assert.equal(ledger.events.length, memory.MAX_EVENTS);
  assert.equal(ledger.events[0].text, "e10");
});

test("runs are counted per place over the last 24 hours", () => {
  const ledger = memory.emptyLedger();
  memory.countJob(ledger, "w1", NOW);
  memory.countJob(ledger, "w1", NOW - HOUR);
  memory.countJob(ledger, "local", NOW - 23 * HOUR);
  memory.countJob(ledger, "w2", NOW - 25 * HOUR);
  assert.deepEqual(memory.jobsLast24h(ledger, NOW), { w1: 2, local: 1 });
});

// ── Readings ─────────────────────────────────────────────────────────────────

test("the kernel's files are read as they are written", () => {
  assert.equal(memory.parseOomKills("low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n"), 2);
  assert.equal(memory.parseOomKills("low 0\n"), null);
  assert.equal(memory.parsePressure("some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=5\n"), 12.5);
  assert.equal(memory.parsePressure("full avg10=1.00 avg60=0.00 avg300=0.00 total=5\n"), null);
  assert.equal(memory.underPressure(10), true);
  assert.equal(memory.underPressure(9.99), false);
  assert.equal(memory.underPressure(null), false, "unknown is not short of memory");
});

test("a failed job counts as stopped for memory only when the kernel killed something while it ran", () => {
  assert.equal(memory.killedForMemory(137, { peakBytes: null, oomKills: 1 }), true);
  assert.equal(memory.killedForMemory(0, { peakBytes: null, oomKills: 1 }), false, "it finished anyway");
  assert.equal(memory.killedForMemory(1, { peakBytes: GIB, oomKills: 0 }), false);
  assert.equal(memory.killedForMemory(137, { peakBytes: null, oomKills: null }), false, "unknown is not an out-of-memory kill");
  assert.equal(memory.killedForMemory(137, undefined), false);
});

test("this server keeps 2 GB or a tenth of its limit for itself; the rest is what a job may use", () => {
  assert.equal(memory.codyReserveBytes(8 * GIB), 2 * GIB);
  assert.equal(memory.codyReserveBytes(64 * GIB), Math.round(6.4 * GIB));
  const reading = (used, limit, pressure = null) => ({ usedBytes: used, limitBytes: limit, pressure, oomKills: 0, bootId: "b" });
  assert.equal(memory.localSpareMB(reading(4 * GIB, 16 * GIB)), 10240);
  assert.equal(memory.localSpareMB(reading(10 * GIB, 64 * GIB)), 48742);
  assert.equal(memory.localSpareMB(reading(15 * GIB, 16 * GIB)), 0, "never below nothing");
  assert.equal(memory.localSpareMB(null), null, "unknown stays unknown");

  assert.equal(memory.localStrain(reading(13 * GIB, 16 * GIB)), null, "81% and nothing waiting is fine");
  assert.equal(memory.localStrain(reading(14 * GIB, 16 * GIB)), "this server is using 14.0 of its 16.0 GB of memory (88%)");
  assert.equal(memory.localStrain(reading(4 * GIB, 16 * GIB, 30)), "this server is using 4.0 of its 16.0 GB of memory (25%) and is waiting on memory");
  assert.equal(memory.localStrain(null), null);
});

// ── On disk ──────────────────────────────────────────────────────────────────

test("a ledger file that is not one is started afresh, and every write leaves a whole file behind", () => {
  freshStore();
  writeFileSync(LEDGER, "{not json");
  let need;
  const warned = quietly(() => {
    need = store.jobNeedMB("k", NOW);
  });
  assert.equal(need, null);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not be read .*starting a new one/);

  store.recordJobRun({ key: "k", machine: "w1", label: "Alpha", peakBytes: 1000 * MIB, oom: false, capBytes: 16 * GIB }, NOW);
  assert.equal(store.jobNeedMB("k", NOW), 1200);
  const saved = JSON.parse(readFileSync(LEDGER, "utf8"));
  assert.deepEqual(saved.peaks.k, [{ at: NOW, bytes: 1000 * MIB, machine: "w1", oom: false }]);
  assert.deepEqual(readdirSync(agentDir).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");

  store.resetMemoryLedgerCache();
  assert.equal(store.jobNeedMB("k", NOW), 1200, "a restart reads it back");

  writeFileSync(LEDGER, JSON.stringify({ version: 9 }));
  store.resetMemoryLedgerCache();
  const again = quietly(() => assert.equal(store.jobNeedMB("k", NOW), null));
  assert.match(again[0], /is not a memory ledger; starting a new one/);

  store.recordJobRun({ key: "quiet", machine: "w1", label: "Alpha", peakBytes: null, oom: false, capBytes: null }, NOW);
  assert.equal(store.jobNeedMB("quiet", NOW), null, "a run without a reading is not written down");
});

test("a worker running out of memory is remembered with the job's own words and cools down; this server only lists it", () => {
  freshStore();
  quietly(() => store.recordJobRun({ key: "big", machine: "w1", label: "Alpha", peakBytes: 2 * GIB, oom: true, capBytes: 16 * GIB, text: "Alpha ran out of memory: its kernel stopped the command." }, NOW));
  assert.equal(store.jobNeedMB("big", NOW), Math.ceil(16 * 1024 * 1.2), "the command now counts as needing more than the 16 GB it ran into");
  assert.deepEqual(store.machineCooldown("w1", NOW + 1), { until: NOW + 5 * 60_000, why: "oom" });
  assert.equal(store.machineCooldown("w1", NOW + 5 * 60_000), null);

  quietly(() => store.recordJobRun({ key: "big", machine: "local", label: "this server", peakBytes: GIB, oom: true, capBytes: null, text: "This server ran out of memory." }, NOW + 1000));
  assert.equal(store.machineCooldown("local", NOW + 1000), null, "this server is never put behind the workers this way");
  assert.deepEqual(
    store.memoryOverview(NOW + 2000).events.map((event) => [event.machine, event.kind, event.text, event.detail]),
    [
      ["local", "oom", "This server ran out of memory.", { what: "job", capBytes: null, peakBytes: GIB }],
      ["w1", "oom", "Alpha ran out of memory: its kernel stopped the command.", { what: "job", capBytes: 16 * GIB, peakBytes: 2 * GIB }],
    ],
    "newest first, each told once, with its figures",
  );
});

test("a worker's reading cools it down only for something new, and writes nothing otherwise", () => {
  freshStore();
  quietly(() => {
    store.noteMachineMemory("w2", "Beta", { bootId: "b1", oomKills: 3, pressure: 0 }, NOW);
    assert.equal(store.machineCooldown("w2", NOW), null, "the first reading is a baseline");
    store.noteMachineMemory("w2", "Beta", { bootId: "b1", oomKills: 4, pressure: 0 }, NOW + 1000);
    assert.equal(store.machineCooldown("w2", NOW + 1000).why, "oom");

    store.noteMachineMemory("w3", "Gamma", { bootId: "b1", oomKills: 9 }, NOW);
    store.noteMachineMemory("w3", "Gamma", { bootId: "b2", oomKills: 0 }, NOW + 1000);
    assert.equal(store.machineCooldown("w3", NOW + 1000), null, "a reboot only sets a new baseline");

    store.noteMachineMemory("w4", "Delta", { pressure: 25 }, NOW);
    assert.deepEqual(store.machineCooldown("w4", NOW), { until: NOW + 2 * 60_000, why: "pressure" });
    store.noteMachineMemory("w5", "Echo", {}, NOW);
    assert.equal(store.machineCooldown("w5", NOW), null, "nothing known: nothing changes");
  });
  assert.deepEqual(
    store.memoryOverview(NOW + 2000).events.map((event) => [event.text, event.detail]),
    [
      ["Delta: it was short of memory, so it goes behind the other workers for 2 min.", { what: "cooldown", minutes: 2 }],
      ["Beta: its kernel stopped a process for lack of memory, so it goes behind the other workers for 5 min.", { what: "cooldown", minutes: 5 }],
    ],
  );

  rmSync(LEDGER);
  quietly(() => {
    store.noteMachineMemory("w2", "Beta", { bootId: "b1", oomKills: 4, pressure: 0 }, NOW + 3000);
    store.noteMachineMemory("w4", "Delta", { pressure: 30 }, NOW + 3000);
  });
  assert.equal(existsSync(LEDGER), false, "the same reading again, or pressure while already cooling down, is not a write");
});

test("the panel gets runs per place for the last day and the events of the last week, newest first", () => {
  freshStore();
  store.countJobStart("w1", NOW);
  store.countJobStart("w1", NOW);
  store.countJobStart("local", NOW - HOUR);
  store.countJobStart("w2", NOW - 25 * HOUR);
  store.noteMemoryEvent({ at: NOW - 8 * DAY, machine: "w1", kind: "oom", text: "too old" });
  store.noteMemoryEvent({ at: NOW - DAY, machine: "local", kind: "high", text: "first" });
  store.noteMemoryEvent({ at: NOW - HOUR, machine: "w1", kind: "pressure", text: "second" });
  const overview = store.memoryOverview(NOW);
  assert.deepEqual(overview.jobs24h, { w1: 2, local: 1 });
  assert.deepEqual(overview.events.map((event) => event.text), ["second", "first"]);
});

// ── This server ──────────────────────────────────────────────────────────────

const MEMINFO = "MemTotal:       16777216 kB\nMemFree:          100000 kB\nMemAvailable:    8388608 kB\n";

test("this server's memory comes from its control group, without the cache the kernel can drop", () => {
  const proc = folder("proc", { meminfo: MEMINFO, "sys/kernel/random/boot_id": "f4a34512-762d\n" });
  const cgroup = folder("cg", {
    "memory.current": "6442450944\n",
    "memory.max": "8589934592\n",
    "memory.stat": "anon 5000\nfile 2000\ninactive_file 1073741824\n",
    "memory.events": "low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n",
    "memory.pressure": "some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=5\n",
  });
  assert.deepEqual(watch.readLocalMemory(cgroup, proc), { usedBytes: 5 * GIB, limitBytes: 8 * GIB, pressure: 12.5, oomKills: 1, bootId: "f4a34512-762d" });

  const unlimited = folder("cg", { "memory.current": "1073741824\n", "memory.max": "max\n" });
  assert.deepEqual(watch.readLocalMemory(unlimited, proc), { usedBytes: GIB, limitBytes: 16 * GIB, pressure: null, oomKills: null, bootId: "f4a34512-762d" }, "no limit: the machine's memory is the limit");

  const none = folder("cg");
  assert.deepEqual(watch.readLocalMemory(none, folder("proc", { meminfo: MEMINFO })), { usedBytes: 8 * GIB, limitBytes: 16 * GIB, pressure: null, oomKills: null, bootId: null }, "no control group: the machine's own numbers");
  assert.equal(watch.readLocalMemory(none, folder("proc")), null, "nothing readable: unknown");
});

test("the biggest processes are named for the alarm", () => {
  const proc = folder("proc", {
    "1/status": "Name:\tnext-server\nVmRSS:\t 2097152 kB\n",
    "2/status": "Name:\tomp\nVmRSS:\t 1048576 kB\n",
    "3/status": "Name:\tsh\nVmRSS:\t 1024 kB\n",
    "4/status": "Name:\tkthreadd\n",
    "self/status": "Name:\tself\nVmRSS:\t 99999999 kB\n",
  });
  assert.deepEqual(watch.biggestProcesses(proc, 2), ["next-server 2.0 GB", "omp 1.0 GB"]);
  assert.deepEqual(watch.biggestProcesses(join(proc, "missing")), []);
});

test("this server's alarm goes off once per episode and its out-of-memory kills are listed", () => {
  const state = { watcher: null, timer: null, pending: null, lastAt: 0, high: false, oomKills: null };
  const events = [];
  const notes = [];
  const tell = { event: (event) => events.push(event), notify: async (title, message) => notes.push([title, message]), biggest: () => ["next-server 3.1 GB", "omp 1.2 GB"] };
  const at = (usedGiB, oomKills = 0) => ({ usedBytes: usedGiB * GIB, limitBytes: 10 * GIB, pressure: null, oomKills, bootId: "b" });

  watch.checkLocalMemory(state, at(5, 7), 1, tell);
  watch.checkLocalMemory(state, at(9.2, 7), 2, tell);
  watch.checkLocalMemory(state, at(9.5, 7), 3, tell);
  watch.checkLocalMemory(state, at(8.5, 7), 4, tell);
  watch.checkLocalMemory(state, at(7.5, 7), 5, tell);
  watch.checkLocalMemory(state, at(9.1, 7), 6, tell);
  watch.checkLocalMemory(state, at(9.1, 9), 7, tell);
  watch.checkLocalMemory(state, null, 8, tell);

  assert.deepEqual(events.map((event) => [event.at, event.machine, event.kind]), [[2, "local", "high"], [6, "local", "high"], [7, "local", "oom"]], "the first reading's 7 kills are old news");
  assert.equal(events[0].text, "Cody's server is using 9.2 of its 10.0 GB of memory (92%). Biggest: next-server 3.1 GB, omp 1.2 GB.");
  assert.equal(events[2].text, "Cody's server: the kernel stopped 2 processes for lack of memory (9.1 of 10.0 GB in use).");
  assert.deepEqual(events[0].detail, { what: "high", usedBytes: 9.2 * GIB, limitBytes: 10 * GIB, biggest: ["next-server 3.1 GB", "omp 1.2 GB"] });
  assert.deepEqual(events[2].detail, { what: "killed", count: 2, usedBytes: 9.1 * GIB, limitBytes: 10 * GIB });
  assert.deepEqual(notes, [
    ["Cody is low on memory", `${events[0].text} New jobs go to workers while it lasts.`],
    ["Cody is low on memory", `${events[1].text} New jobs go to workers while it lasts.`],
  ]);
});
