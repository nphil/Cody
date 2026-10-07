import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Jobs: one task as the person would name it. What state a job is in, how far along it is and when it will be done
 * (only as far as there is something to measure), and what it is called.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SERIES_LINGER_MS, etaLabel, jobArtifactIds, jobPhase, jobProgress, jobTitle, makeJob, memberOutcome, plannedItems, problemMembers, recentRate, seriesKey, stepOf } = await jiti.import("./jobs.ts");
const { DECLINED_MESSAGE_PREFIX } = await jiti.import("./trust.ts");

const MB = 1024 * 1024;
let counter = 0;
const NOW = 5_000_000;

function operation(over = {}) {
  counter += 1;
  const { request, ...rest } = over;
  const createdAt = over.createdAt ?? NOW - 600_000 + counter * 1_000;
  return {
    id: `op-${counter}`,
    sessionId: "session-a",
    origin: "agent",
    state: "succeeded",
    createdAt,
    updatedAt: over.updatedAt ?? createdAt + 500,
    output: [],
    events: [],
    result: { summary: "ok" },
    request: { protocol: "edl", action: "dump", deviceId: "usb-1", target: `part${counter}`, ...request },
    ...rest,
  };
}

/** A finished dump of `bytes`, which ran for `seconds`. */
function dumped(target, bytes, seconds = 2) {
  const started = NOW - 300_000 + counter * 10_000;
  return operation({
    request: { target },
    createdAt: started,
    updatedAt: started + seconds * 1000,
    progress: { phase: "read", completed: bytes, total: bytes, at: started + seconds * 1000 },
    events: [{ sequence: 1, at: started, type: "state", state: "running" }],
  });
}

/** A dump in flight: `completed` of `total` bytes, moving `perSecond` bytes a second, the newest report `age` ms old. */
function dumping(target, total, completed, perSecond, age = 0) {
  const events = [];
  for (let step = 0; step <= 8; step += 1) {
    const at = NOW - age - (8 - step) * 1000;
    events.push({ sequence: step + 2, at, type: "progress", progress: { phase: "read", completed: Math.max(0, completed - (8 - step) * perSecond), total, at } });
  }
  return operation({
    request: { target },
    state: "running",
    result: undefined,
    createdAt: NOW - 20_000,
    updatedAt: NOW - age,
    progress: { phase: "read", completed, total, at: NOW - age, message: `Reading edl-1-${target}.bin` },
    events,
  });
}

test("every operation comes to one of a handful of outcomes, and a refusal the person made is not a failure", () => {
  assert.equal(memberOutcome(operation()), "succeeded");
  assert.equal(memberOutcome(operation({ state: "failed", error: "No such variable" })), "failed");
  assert.equal(memberOutcome(operation({ state: "failed", error: `${DECLINED_MESSAGE_PREFIX}Lenovo; do not ask again until they reconnect it` })), "declined");
  assert.equal(memberOutcome(operation({ state: "cancelled" })), "cancelled", "stopped by the person: no reason given");
  assert.equal(memberOutcome(operation({ state: "cancelled", error: "The device left the USB bus" })), "stopped", "stopped by the system: it says why");
  for (const state of ["starting", "running", "cancelling"]) assert.equal(memberOutcome(operation({ state })), "active");
  assert.equal(memberOutcome(operation({ state: "awaiting-trust" })), "waiting");
  assert.equal(memberOutcome(operation({ state: "countdown" })), "countdown");
});

test("a job has one state: waiting and countdown outrank running, running outranks any outcome, a failure outranks a stop", () => {
  const phase = (members) => makeJob(members, NOW).phase;
  assert.equal(phase([operation(), operation({ state: "awaiting-trust" })]), "waiting");
  assert.equal(phase([operation({ state: "countdown" }), operation({ state: "awaiting-trust" })]), "waiting");
  assert.equal(phase([operation({ state: "countdown" }), operation({ state: "running" })]), "countdown");
  assert.equal(phase([operation({ state: "failed", error: "x" }), operation({ state: "running" })]), "running");
  assert.equal(phase([operation({ state: "cancelled", error: "left the bus" }), operation({ state: "failed", error: "x" })]), "failed");
  assert.equal(phase([operation({ state: "cancelled", error: "left the bus" }), operation()]), "stopped");
  assert.equal(phase([operation(), operation({ state: "cancelled" })]), "cancelled");
  assert.equal(phase([operation({ state: "failed", error: `${DECLINED_MESSAGE_PREFIX}Lenovo` }), operation({ state: "failed", error: `${DECLINED_MESSAGE_PREFIX}Lenovo` })]), "declined");
  assert.equal(phase([operation(), operation()].map((member) => ({ ...member, updatedAt: NOW - SERIES_LINGER_MS - 1 }))), "done");
});

test("a series that has just finished a step is still running, so it does not flicker to done between two partitions", () => {
  const steps = [operation(), operation({ updatedAt: NOW - 3_000 })];
  assert.equal(makeJob(steps, NOW).phase, "running", "3 s after the last step");
  assert.equal(makeJob(steps, NOW + SERIES_LINGER_MS).phase, "done", "the grace is over");
  assert.equal(makeJob([operation({ updatedAt: NOW - 1_000 })], NOW).phase, "done", "one operation is just done: there is no series to be between steps of");
  const hole = [operation(), operation({ state: "failed", error: "timed out", updatedAt: NOW - 1_000 })];
  assert.equal(makeJob(hole, NOW).phase, "failed", "a failure is never held back");
});

test("bulk operations of one kind on one device are a series; a command is never", () => {
  const dump = operation();
  assert.equal(seriesKey(dump), "usb-1|edl|dump");
  assert.equal(seriesKey(operation({ request: { deviceId: "usb-2" } })), "usb-2|edl|dump");
  assert.equal(seriesKey(operation({ request: { action: "exec", command: "getvar x" } })), undefined);
  assert.equal(seriesKey(operation({ request: { action: "detect" } })), undefined);
  for (const action of ["flash", "pull", "push", "sideload", "install"]) assert.notEqual(seriesKey(operation({ request: { action } })), undefined, action);
});

test("a job's origin is who asked: the person, the agent, or both", () => {
  assert.equal(makeJob([operation({ origin: "user" })], NOW).origin, "user");
  assert.equal(makeJob([operation(), operation()], NOW).origin, "agent");
  assert.equal(makeJob([operation({ origin: "user" }), operation()], NOW).origin, "mixed");
});

test("the problems of a job are the steps that failed or were stopped, not the ones the person cancelled or refused", () => {
  const failed = operation({ state: "failed", error: "timed out" });
  const stopped = operation({ state: "cancelled", error: "left the bus" });
  const job = makeJob([operation(), failed, stopped, operation({ state: "cancelled" }), operation({ state: "failed", error: `${DECLINED_MESSAGE_PREFIX}Lenovo` })], NOW);
  assert.deepEqual(problemMembers(job).map((member) => member.id), [failed.id, stopped.id]);
});

test("how far a dump has got: its fraction, what it is on, and how long is left at the rate it is moving", () => {
  const job = makeJob([dumping("modem_b", 100 * MB, 41 * MB, 2 * MB)], NOW);
  const progress = jobProgress(job, { now: NOW });
  assert.equal(progress.fraction, 0.41);
  assert.equal(progress.doneItems, 0);
  assert.deepEqual(progress.current, { name: "modem_b", fraction: 0.41, etaSeconds: 30 }, "59 MB at 2 MB/s");
  assert.equal(progress.etaSeconds, 30, "one operation: what is left of it is what is left");
  assert.equal(progress.totalBytes, 100 * MB);
  assert.equal(progress.doneBytes, 41 * MB);
});

test("no estimate without a measured rate: a dump that has only just begun says how far, not how long", () => {
  const fresh = operation({ request: { target: "boot_a" }, state: "running", result: undefined, progress: { phase: "read", completed: 0, total: 64 * MB, at: NOW }, events: [{ sequence: 1, at: NOW, type: "progress", progress: { phase: "read", completed: 0, total: 64 * MB, at: NOW } }] });
  const progress = jobProgress(makeJob([fresh], NOW), { now: NOW });
  assert.equal(progress.fraction, 0);
  assert.equal(progress.etaSeconds, null);
  assert.equal(progress.current.etaSeconds, null);
});

test("a stalled transfer has no estimate either: stale reports are not a rate", () => {
  const stalled = dumping("boot_a", 100 * MB, 40 * MB, 2 * MB, 30_000);
  assert.equal(recentRate(stalled.events, NOW), null);
  assert.equal(jobProgress(makeJob([stalled], NOW), { now: NOW }).etaSeconds, null);
});

test("the rate is measured over the newest report only, and a count that restarts from zero starts a new measurement", () => {
  const at = (seconds) => NOW - seconds * 1000;
  const progress = (seconds, completed) => ({ sequence: 1, at: at(seconds), type: "progress", progress: { phase: "read", completed, total: 1000 * MB, at: at(seconds) } });
  assert.equal(recentRate([progress(8, 10 * MB), progress(4, 20 * MB), progress(0, 30 * MB)], NOW), 2.5 * MB);
  // The second read pass starts again from zero: only the new pass counts.
  assert.equal(recentRate([progress(9, 90 * MB), progress(6, 100 * MB), progress(3, 0), progress(0, 6 * MB)], NOW), 2 * MB);
  assert.equal(recentRate([progress(0, 10 * MB)], NOW), null, "one report is not a rate");
  assert.equal(recentRate([progress(0.5, 10 * MB), progress(0, 11 * MB)], NOW), null, "under a second of movement is not a rate");
});

test("a backup of the device's whole table: n of N, bytes against the table, and an estimate from the speed of the partition in flight", () => {
  const table = [{ name: "a", bytes: 10 * MB }, { name: "b", bytes: 10 * MB }, { name: "c", bytes: 80 * MB }, { name: "d", bytes: 100 * MB }];
  const done = [dumped("a", 10 * MB), dumped("b", 10 * MB)];
  const job = makeJob([...done, dumping("c", 80 * MB, 60 * MB, 5 * MB)], NOW);
  const progress = jobProgress(job, { now: NOW, plan: table });
  assert.equal(progress.totalItems, 4);
  assert.equal(progress.doneItems, 2);
  assert.equal(progress.totalBytes, 200 * MB);
  assert.equal(progress.doneBytes, 80 * MB, "two finished partitions and three quarters of the third");
  assert.equal(progress.fraction, 0.4);
  assert.equal(progress.current.name, "c");
  assert.equal(progress.etaSeconds, 24, "120 MB still to read at 5 MB/s");
});

test("a table the job does not follow is not a promise: without it there is no total, only what is done", () => {
  const table = [{ name: "a", bytes: 10 * MB }, { name: "b", bytes: 10 * MB }];
  const job = makeJob([dumped("a", 10 * MB), dumped("not-in-the-table", 10 * MB), dumping("b", 10 * MB, 5 * MB, MB / 2)], NOW);
  const progress = jobProgress(job, { now: NOW, plan: table });
  assert.equal(progress.totalItems, undefined);
  assert.equal(progress.totalBytes, undefined);
  assert.equal(progress.fraction, null, "a series with no known end has no overall fraction");
  assert.equal(progress.doneItems, 2);
  assert.equal(progress.current.fraction, 0.5, "but the partition in flight still has its own");
  assert.equal(progress.etaSeconds, null, "and nothing is said about when the whole job will end");
  assert.equal(progress.current.etaSeconds, 10, "only about the partition in flight: 5 MB at half a megabyte a second");
});

test("only a backup is measured against the table: three flashed partitions are not three of fifty-eight", () => {
  const table = [{ name: "a", bytes: 10 * MB }, { name: "b", bytes: 10 * MB }, { name: "c", bytes: 10 * MB }];
  const flash = (target) => operation({ request: { action: "flash", target } });
  const progress = jobProgress(makeJob([flash("a"), flash("b")], NOW), { now: NOW, plan: table });
  assert.equal(progress.totalItems, undefined);
  assert.equal(progress.fraction, null);
});

test("a backup set is one operation that says which step it is on: that, not its per-partition byte count, is how far it has got", () => {
  assert.deepEqual(stepOf("Reading boot_a (3 of 58)"), { index: 3, count: 58 });
  assert.equal(stepOf("Reading boot_a a second time to compare"), null);
  assert.equal(stepOf("Reading x (0 of 5)"), null);
  assert.equal(stepOf("Reading x (7 of 5)"), null);
  assert.equal(stepOf(undefined), null);
  const set = operation({
    request: { action: "exec", command: "backup", target: undefined },
    state: "running",
    result: undefined,
    progress: { phase: "read", completed: 50 * MB, total: 100 * MB, at: NOW, message: "Reading boot_a (3 of 58)" },
    events: [{ sequence: 1, at: NOW, type: "progress", progress: { phase: "read", completed: 50 * MB, total: 100 * MB, at: NOW, message: "Reading boot_a (3 of 58)" } }],
  });
  const progress = jobProgress(makeJob([set], NOW), { now: NOW });
  assert.equal(progress.totalItems, 58);
  assert.equal(progress.doneItems, 2, "on step three: two are finished");
  assert.equal(progress.fraction, 2.5 / 58);
  assert.equal(progress.current.name, "Reading boot_a", "the step is a number of its own, not part of the name");
  assert.equal(progress.totalBytes, undefined, "bytes restart in every region and say nothing about the whole");
  assert.equal(progress.etaSeconds, null);
});

test("while a backup set reads a partition a second time to compare, it is still on the same step", () => {
  const events = [
    { sequence: 1, at: NOW - 2000, type: "progress", progress: { phase: "read", completed: 100 * MB, total: 100 * MB, at: NOW - 2000, message: "Reading boot_a (3 of 58)" } },
    { sequence: 2, at: NOW, type: "progress", progress: { phase: "check", completed: 10 * MB, total: 100 * MB, at: NOW, message: "Reading boot_a a second time to compare" } },
  ];
  const set = operation({ request: { action: "exec", command: "backup", target: undefined }, state: "running", result: undefined, progress: events[1].progress, events });
  const progress = jobProgress(makeJob([set], NOW), { now: NOW });
  assert.equal(progress.totalItems, 58);
  assert.ok(progress.fraction > 2 / 58 && progress.fraction < 3 / 58, "inside step three");
});

test("a finished job is done and whole; a command with no total says nothing it cannot know", () => {
  const done = makeJob([dumped("boot_a", 64 * MB)], NOW + 60_000);
  const progress = jobProgress(done, { now: NOW + 60_000 });
  assert.equal(progress.fraction, 1);
  assert.equal(progress.doneBytes, 64 * MB);
  assert.equal(progress.current, undefined);
  const command = operation({ request: { action: "exec", command: "reset", target: undefined }, state: "running", result: undefined });
  const running = jobProgress(makeJob([command], NOW), { now: NOW });
  assert.equal(running.fraction, null);
  assert.equal(running.etaSeconds, null);
});

test("estimates are told in coarse words, because a rate cannot back more precision than that", () => {
  assert.deepEqual(etaLabel(4), { key: "devices.eta.soon" });
  assert.deepEqual(etaLabel(14), { key: "devices.eta.soon" });
  assert.deepEqual(etaLabel(15), { key: "devices.eta.underMinute" });
  assert.deepEqual(etaLabel(59), { key: "devices.eta.underMinute" });
  assert.deepEqual(etaLabel(61), { key: "devices.eta.minutes", count: 2 });
  assert.deepEqual(etaLabel(10 * 60), { key: "devices.eta.minutes", count: 10 });
  assert.deepEqual(etaLabel(11 * 60 + 1), { key: "devices.eta.minutes", count: 10 }, "past ten minutes it rounds to five");
  assert.deepEqual(etaLabel(14 * 60), { key: "devices.eta.minutes", count: 15 });
  assert.deepEqual(etaLabel(2 * 3600 + 20 * 60), { key: "devices.eta.hours", hours: 2, minutes: 20 });
  assert.deepEqual(etaLabel(2 * 3600 + 58), { key: "devices.eta.hoursOnly", hours: 2 }, "no minutes to speak of: not '2 h 0 min'");
});

test("a job is named for what it did: a backup of a partition, a backup of fifty-eight, the whole disk, a flash", () => {
  const title = (members, name = "EDL") => jobTitle(makeJob(members, NOW), name);
  assert.deepEqual(title([operation({ request: { target: "boot_a" } })]), { key: "devices.job.dump", vars: { target: "boot_a" } });
  assert.deepEqual(title(Array.from({ length: 58 }, () => operation())), { key: "devices.job.dumpSeries", count: 58, vars: {} });
  assert.deepEqual(title(Array.from({ length: 3 }, () => operation({ request: { protocol: "esp" } }))), { key: "devices.job.dumpItems", count: 3, vars: {} });
  assert.deepEqual(title([operation({ request: { target: "user-area" } })]), { key: "devices.job.dumpAll", vars: {} });
  assert.deepEqual(title([operation({ request: { protocol: "esp", target: undefined } })], "ESP32"), { key: "devices.job.dumpPlain", vars: { protocol: "ESP32" } });
  assert.deepEqual(title([operation({ request: { action: "flash", target: "boot_a" } })]), { key: "devices.job.flash", vars: { target: "boot_a", protocol: "EDL" } });
  assert.deepEqual(title([operation({ request: { action: "flash", target: "a" } }), operation({ request: { action: "flash", target: "b" } })]), { key: "devices.job.flashSeries", count: 2, vars: {} });
  assert.deepEqual(title([operation({ request: { protocol: "adb", action: "pull", target: "/sdcard/a.img" } })]), { key: "devices.job.pull", vars: { target: "/sdcard/a.img" } });
});

test("EDL commands are named for what they do, and any other command by what was typed", () => {
  const exec = (command, extra = {}) => jobTitle(makeJob([operation({ request: { action: "exec", command, target: undefined, ...extra } })], NOW), "EDL");
  assert.equal(exec("backup").key, "devices.job.backupSet");
  assert.equal(exec("restore").key, "devices.job.restoreSet");
  assert.equal(exec("printgpt").key, "devices.job.readTables");
  assert.equal(exec("connect").key, "devices.job.connect");
  assert.equal(exec("check").key, "devices.job.checkDisk");
  assert.equal(exec("reset").key, "devices.job.reset");
  assert.deepEqual(exec("erase", { target: "persist" }), { key: "devices.job.erase", vars: { target: "persist" } });
  assert.deepEqual(exec("reboot-bootloader"), { key: "devices.job.command", vars: { command: "reboot-bootloader" } });
  assert.deepEqual(exec("getvar product"), { key: "devices.job.command", vars: { command: "getvar product" } }, "the whole command is what the person typed");
});

test("the files a job saved are found by the operations that saved them", () => {
  const job = makeJob([operation(), operation()], NOW);
  const artifacts = [
    { id: "f1", provenance: { operationId: job.members[0].id } },
    { id: "f2", provenance: { operationId: job.members[1].id } },
    { id: "other-job", provenance: { operationId: "op-elsewhere" } },
    { id: "input" },
  ];
  assert.deepEqual(jobArtifactIds(job, artifacts), ["f1", "f2"]);
});

test("the partition table a device reported becomes the items a backup is measured against, and nothing else does", () => {
  assert.deepEqual(plannedItems({ partitions: [{ name: "boot_a", bytes: 64 }, { name: "bad" }, { name: 5, bytes: 1 }, { name: "zero", bytes: 0 }, null, "x"] }), [{ name: "boot_a", bytes: 64 }]);
  assert.deepEqual(plannedItems(undefined), []);
  assert.deepEqual(plannedItems({ partitions: "nope" }), []);
});

test("jobPhase reads the members it is given: a job with a question open is waiting even when its earlier steps are done", () => {
  const steps = [operation(), operation({ state: "awaiting-trust" })];
  const job = makeJob(steps, NOW);
  assert.equal(jobPhase(steps, job.counts, NOW), "waiting");
});
