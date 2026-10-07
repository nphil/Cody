import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * How the Devices panel tells what happened on a device. A dozen `getvar`s from an agent are one line and fifty-eight
 * dumps are one backup; whatever a person has to answer comes first, and a failure stays there until it is acknowledged.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { BURST_GAP_MS, ROUTINE_QUIET_MS, activityView, dayKey, describeRoutine, entrySize, groupActivity, isQuiet, isRoutine, needsPerson, planBefore, problemKeys, quietUntil } = await jiti.import("./activity-groups.ts");
const { SERIES_GAP_MS } = await jiti.import("./jobs.ts");

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
let clock = NOW - 3_600_000;
let counter = 0;
function operation(over = {}) {
  counter += 1;
  const { request, ...rest } = over;
  const createdAt = over.createdAt ?? (clock += 1_000);
  return {
    id: `op-${counter}`,
    sessionId: "session-a",
    origin: "agent",
    state: "succeeded",
    createdAt,
    updatedAt: over.updatedAt ?? createdAt + 300,
    output: [],
    events: [],
    result: { summary: "OKAY" },
    request: { protocol: "fastboot", action: "exec", deviceId: "usb-1", command: `getvar var${counter}`, ...request },
    ...rest,
  };
}
const dump = (target, over = {}) => {
  const { request, ...rest } = over;
  return operation({ request: { protocol: "edl", action: "dump", command: undefined, target, ...request }, ...rest });
};
const flash = (target) => operation({ request: { action: "flash", target, command: undefined } });
const group = (operations, now = NOW) => groupActivity(operations, { now });
const describe = (entries) => entries.map((entry) => (entry.kind === "burst" ? `burst(${entry.operations.map((member) => member.id).join(",")})` : `job(${entry.members.map((member) => member.id).join(",")})`));

test("a burst of routine agent commands is one entry, counted, with every command inside it", () => {
  const history = Array.from({ length: 7 }, () => operation());
  const entries = group(history);
  assert.equal(entries.length, 1);
  const [burst] = entries;
  assert.equal(burst.kind, "burst");
  assert.equal(burst.operations.length, 7);
  assert.deepEqual(burst.operations.map((member) => member.id), history.map((member) => member.id), "oldest first inside the burst");
  assert.deepEqual({ ok: burst.succeeded, failed: burst.failed, cancelled: burst.cancelled }, { ok: 7, failed: 0, cancelled: 0 });
  assert.deepEqual(burst.protocols, ["fastboot"]);
  assert.equal(burst.startedAt, history[0].createdAt);
  assert.equal(burst.endedAt, history[6].updatedAt);
  assert.equal(entrySize(burst), 7);
});

test("failed and cancelled routine commands stay in the burst and are counted, not hidden", () => {
  const entries = group([operation(), operation({ state: "failed", error: "No such variable", result: undefined }), operation({ state: "cancelled", result: undefined }), operation()]);
  assert.equal(entries.length, 1);
  assert.deepEqual({ ok: entries[0].succeeded, failed: entries[0].failed, cancelled: entries[0].cancelled }, { ok: 2, failed: 1, cancelled: 1 });
});

test("a command that declared a risk to the device, a flash, a dump, a saved file and anything the person ran are never folded", () => {
  const read = operation();
  const asked = operation({ riskDeclared: true, request: { command: "reboot-bootloader" } });
  const saved = operation({ request: { action: "detect", command: undefined }, result: { summary: "table", fileId: "file-1" } });
  const mine = operation({ origin: "user" });
  for (const single of [asked, flash("boot_a"), dump("boot_a"), saved, mine]) assert.equal(isRoutine(single), false, single.request.command ?? single.request.action);
  assert.equal(isRoutine(read), true);
  const entries = group([read, asked, flash("boot_a"), dump("boot_a"), saved, mine]);
  assert.equal(entries.filter((entry) => entry.kind === "burst").length, 1, "only the plain read is folded");
  assert.equal(entries.filter((entry) => entry.kind === "job").length, 5, "everything else is a job of its own");
});

test("a command that has only just started is not shown at all, so a dozen quick reads do not flash cards in and out", () => {
  const read = operation({ state: "running", result: undefined, createdAt: NOW - 500 });
  assert.equal(isQuiet(read, NOW), true);
  assert.deepEqual(group([read]), []);
  assert.equal(quietUntil(read), read.createdAt + ROUTINE_QUIET_MS, "the panel wakes itself then");
  assert.equal(quietUntil(operation()), undefined, "a finished command is never quiet");
  assert.equal(quietUntil(operation({ state: "running", result: undefined, riskDeclared: true })), undefined, "a command that declared a risk is shown at once");
});

test("a command still running after the quiet period is a job; it joins the burst only once it has finished", () => {
  const [earlier, later] = [operation({ createdAt: NOW - 20_000 }), operation({ createdAt: NOW - 19_000 })];
  const live = operation({ state: "running", result: undefined, createdAt: NOW - ROUTINE_QUIET_MS - 1 });
  assert.equal(isQuiet(live, NOW), false);
  assert.deepEqual(describe(group([earlier, later, live])), [`burst(${earlier.id},${later.id})`, `job(${live.id})`]);
  const done = { ...live, state: "succeeded", result: { summary: "OKAY" } };
  assert.deepEqual(describe(group([earlier, later, done])), [`burst(${earlier.id},${later.id},${live.id})`]);
});

test("a command the agent sent that declares a risk is shown at once, however briefly it has run", () => {
  const risky = operation({ state: "running", result: undefined, riskDeclared: true, createdAt: NOW - 100, request: { command: "reboot-bootloader" } });
  assert.equal(isQuiet(risky, NOW), false);
  assert.equal(group([risky]).length, 1);
  const mine = operation({ origin: "user", state: "running", result: undefined, createdAt: NOW - 100 });
  assert.equal(isQuiet(mine, NOW), false, "the person pressed a button and expects to see it");
});

test("something else that happened on the device splits a burst in two", () => {
  const first = [operation(), operation()];
  const middle = flash("boot_a");
  const second = [operation(), operation(), operation()];
  assert.deepEqual(describe(group([...first, middle, ...second])), [
    `burst(${first.map((member) => member.id).join(",")})`,
    `job(${middle.id})`,
    `burst(${second.map((member) => member.id).join(",")})`,
  ], "oldest first");
});

test("commands further apart than the burst gap are two bursts", () => {
  const early = operation({ createdAt: NOW - 3_000_000 });
  const late = operation({ createdAt: early.updatedAt + BURST_GAP_MS + 1 });
  assert.equal(group([early, late]).length, 2);
  const close = operation({ createdAt: early.updatedAt + BURST_GAP_MS });
  assert.equal(group([early, close]).length, 1, "the gap itself is still one burst");
});

test("a burst keeps one id while it grows at its newer end, so its open/closed state is not lost", () => {
  const first = operation();
  assert.equal(group([first, operation(), operation()])[0].id, group([first])[0].id);
});

test("a burst of different protocols names each once, in order of first use", () => {
  const entries = group([operation({ request: { protocol: "adb", command: "getprop ro.product.model" } }), operation(), operation({ request: { protocol: "adb", command: "id" } })]);
  assert.deepEqual(entries[0].protocols, ["adb", "fastboot"]);
});

test("fifty-eight dumps of one device are ONE job that owns every one of them", () => {
  const names = Array.from({ length: 58 }, (_, index) => `part${index}`);
  const dumps = names.map((name) => dump(name));
  const entries = group(dumps);
  assert.equal(entries.length, 1);
  const [job] = entries;
  assert.equal(job.kind, "job");
  assert.equal(job.members.length, 58);
  assert.deepEqual(job.members.map((member) => member.request.target), names, "oldest first");
  assert.equal(job.id, dumps[0].id, "the first member names the job, so it keeps its id while it grows");
  assert.equal(job.counts.succeeded, 58);
  assert.equal(job.action, "dump");
  assert.equal(job.protocol, "edl");
  assert.equal(entrySize(job), 58);
});

test("a job grows at its newer end without changing its id, and an empty-handed device has no job", () => {
  const first = dump("a");
  const grown = group([first, dump("b"), dump("c")]);
  assert.equal(grown[0].id, group([first])[0].id);
  assert.deepEqual(group([]), []);
});

test("dumps further apart than the gap are two jobs; the gap itself is still one", () => {
  const early = dump("a", { createdAt: NOW - 3_000_000 });
  const late = dump("b", { createdAt: early.updatedAt + SERIES_GAP_MS + 1 });
  assert.equal(group([early, late]).length, 2);
  const close = dump("b", { createdAt: early.updatedAt + SERIES_GAP_MS });
  assert.equal(group([early, close]).length, 1);
});

test("a different kind of task in between ends the job, but a routine read in between does not", () => {
  const a = dump("a");
  const read = operation();
  const b = dump("b");
  const [job, burst] = group([a, read, b]);
  assert.equal(job.kind, "job");
  assert.deepEqual(job.members.map((member) => member.id), [a.id, b.id], "the read did not break the backup");
  assert.equal(burst.kind, "burst");

  const f = flash("boot_a");
  const entries = group([dump("x"), f, dump("y")]);
  assert.equal(entries.length, 3, "a flash between two dumps makes three jobs");
});

test("dumps by different protocols are different jobs", () => {
  const entries = group([dump("a"), dump("b", { request: { protocol: "fastboot" } }), dump("c")]);
  assert.equal(entries.length, 3, "an edl dump, then a fastboot dump, then an edl dump: three, because the middle one is a different kind");
});

test("a command waiting for the person is a job of its own, so the question never hides the work that came before it", () => {
  const earlier = [dump("a"), dump("b")];
  const waiting = dump("c", { state: "awaiting-trust", result: undefined });
  const entries = group([...earlier, waiting]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].members.map((member) => member.id), earlier.map((member) => member.id));
  assert.equal(entries[1].phase, "waiting");
  assert.equal(needsPerson(waiting), true);
  assert.equal(needsPerson(operation({ state: "countdown" })), true);
  assert.equal(needsPerson(operation({ state: "running" })), false);
});

test("a routine command is described by what it ran and what came of it, one line each", () => {
  assert.deepEqual(describeRoutine(operation({ request: { command: "getvar product" }, result: { summary: "msm8x53\nsecond line" } })), { title: "getvar product", outcome: "msm8x53" });
  assert.deepEqual(describeRoutine(operation({ state: "failed", error: "No such variable", result: undefined })).outcome, "No such variable");
  assert.deepEqual(describeRoutine(operation({ state: "cancelled", result: undefined, error: "The device left the USB bus" })).outcome, "The device left the USB bus");
  assert.equal(describeRoutine(operation({ request: { action: "detect", command: undefined } })).title, "detect");
  assert.equal(describeRoutine(operation({ request: { protocol: "adb", command: undefined, options: { kind: "reverse-list" } } })).title, "reverse-list");
  assert.ok(describeRoutine(operation({ request: { command: "x".repeat(400) } })).title.length <= 120);
});

// ---- the view ------------------------------------------------------------------------------------------------------

const view = (perDevice, over = {}) => activityView(
  Object.entries(perDevice).map(([deviceId, operations]) => ({ deviceId, entries: group(operations) })),
  { now: NOW, acknowledged: new Set(), timeZone: "UTC", ...over },
);
const failedDump = (target, over = {}) => dump(target, { state: "failed", error: "The device stopped answering", result: undefined, ...over });

test("what needs the person comes first: a countdown (soonest first), then the question, then a failure, whatever else is newer", () => {
  const releaseAt = NOW + 20_000;
  const binding = { action: "fastboot command", target: "reboot-bootloader", backup: "none" };
  const soon = operation({ state: "countdown", result: undefined, riskDeclared: true, request: { command: "reboot" }, countdown: { startedAt: NOW - 10_000, releaseAt: NOW + 5_000, binding } });
  const later = operation({ state: "countdown", result: undefined, riskDeclared: true, request: { command: "reboot-bootloader" }, countdown: { startedAt: NOW - 10_000, releaseAt, binding } });
  const asking = dump("c", { state: "awaiting-trust", result: undefined });
  const broken = failedDump("d");
  const newerReads = [operation(), operation(), operation()];
  const { needsYou } = view({ "usb-1": [broken, asking, later, soon, ...newerReads] });
  assert.deepEqual(needsYou.map((item) => item.kind), ["countdown", "countdown", "question", "problem"]);
  assert.deepEqual(needsYou.filter((item) => item.kind === "countdown").map((item) => item.operation.id), [soon.id, later.id]);
  assert.equal(needsYou[0].releaseAt, NOW + 5_000);
});

test("every command waiting behind one question is ONE row for that device, with how many are waiting", () => {
  const waiting = [dump("a", { state: "awaiting-trust", result: undefined }), dump("b", { state: "awaiting-trust", result: undefined }), dump("c", { state: "awaiting-trust", result: undefined })];
  const other = dump("z", { state: "awaiting-trust", result: undefined, request: { deviceId: "usb-2" } });
  const { needsYou, live, history } = view({ "usb-1": waiting, "usb-2": [other] });
  assert.deepEqual(needsYou.map((item) => [item.kind, item.deviceId, item.waiting]), [["question", "usb-1", 3], ["question", "usb-2", 1]]);
  assert.deepEqual([live.length, history.length], [0, 0], "they are not also listed as running or as history");
});

test("a failure stays at the top until it is acknowledged, however many newer jobs there are, and then it is history", () => {
  const broken = failedDump("vendor_b");
  const newer = [flash("boot_a"), flash("boot_b")].map((op, index) => ({ ...op, createdAt: NOW - 120_000 + index * 1000, updatedAt: NOW - 119_000 + index * 1000 }));
  const open = view({ "usb-1": [broken, ...newer] });
  assert.deepEqual(open.needsYou.map((item) => item.kind), ["problem"]);
  assert.deepEqual(open.needsYou[0].keys, [broken.id]);
  assert.equal(open.history[0].count, 1, "the two flashes are one job; the failure is not also in history");

  const seen = view({ "usb-1": [broken, ...newer] }, { acknowledged: new Set([broken.id]) });
  assert.deepEqual(seen.needsYou, []);
  assert.equal(seen.history[0].count, 2, "acknowledged: it is history now, still failed, still findable");
});

test("a new failure in a job the person had acknowledged raises it again", () => {
  const first = failedDump("a");
  const second = failedDump("b");
  assert.deepEqual(view({ "usb-1": [first, second] }, { acknowledged: new Set([first.id]) }).needsYou.map((item) => item.keys), [[first.id, second.id]]);
  assert.deepEqual(view({ "usb-1": [first, second] }, { acknowledged: new Set([first.id, second.id]) }).needsYou, []);
  assert.deepEqual(problemKeys(group([first, second])[0]), [first.id, second.id]);
});

test("a stop the system made is a problem the person is told about; a stop the person made, or a refusal, is not", () => {
  const stopped = dump("a", { state: "cancelled", error: "The device left the USB bus, so this operation was cancelled.", result: undefined });
  assert.deepEqual(view({ "usb-1": [stopped] }).needsYou.map((item) => item.kind), ["problem"]);
  const mine = dump("a", { state: "cancelled", result: undefined });
  const refused = dump("b", { request: { deviceId: "usb-2" }, state: "failed", error: "The user declined control of Lenovo; do not ask again until they reconnect it", result: undefined });
  const calm = view({ "usb-1": [mine], "usb-2": [refused] });
  assert.deepEqual(calm.needsYou, []);
  assert.equal(calm.history.length, 2, "both are plain history");
});

test("running jobs are listed under what needs the person, newest first, and are not history yet", () => {
  const running = (target, createdAt) => dump(target, { state: "running", result: undefined, createdAt, updatedAt: createdAt + 100 });
  const older = running("a", NOW - 50_000);
  const newer = running("b", NOW - 5_000);
  const { live, history, needsYou } = view({ "usb-1": [older], "usb-2": [{ ...newer, request: { ...newer.request, deviceId: "usb-2" } }] });
  assert.deepEqual(live.map((job) => job.members[0].request.target), ["b", "a"]);
  assert.deepEqual([history.length, needsYou.length], [0, 0]);
});

test("a job that has been running for a while and had a failure on the way is shown as running, with the failure counted on it", () => {
  const { live, needsYou } = view({ "usb-1": [dump("a"), failedDump("b"), dump("c", { state: "running", result: undefined })] });
  assert.equal(live.length, 1);
  assert.equal(live[0].counts.failed, 1);
  assert.deepEqual(needsYou, [], "it raises its hand when it ends, not before");
});

test("history is grouped by day, newest first, and says which is today and yesterday", () => {
  const at = (days, hours) => NOW - days * 86_400_000 + hours * 3_600_000;
  const done = (days, hours, target) => dump(target, { createdAt: at(days, hours), updatedAt: at(days, hours) + 5_000 });
  const { history } = view({ "usb-1": [done(3, 0, "old"), done(1, 0, "yesterday"), done(0, -2, "early"), done(0, -1, "later")] });
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].days.map((day) => day.when), ["today", "yesterday", "earlier"]);
  assert.deepEqual(history[0].days[0].entries.map((entry) => entry.members[0].request.target), ["later", "early"], "newest first inside a day");
  assert.equal(history[0].days[0].key, "2026-10-06");
  assert.equal(history[0].days[1].key, "2026-10-05");
  assert.equal(history[0].days[2].key, "2026-10-03");
});

test("what day a job belongs to follows the time zone the person is in, not the server's", () => {
  const lateEvening = Date.UTC(2026, 9, 6, 23, 30);
  assert.equal(dayKey(lateEvening, "UTC"), "2026-10-06");
  assert.equal(dayKey(lateEvening, "Asia/Tokyo"), "2026-10-07");
  assert.equal(dayKey(lateEvening, "America/Los_Angeles"), "2026-10-06");
  const job = dump("a", { createdAt: lateEvening - 1000, updatedAt: lateEvening });
  const tokyo = activityView([{ deviceId: "usb-1", entries: groupActivity([job], { now: lateEvening + 3_600_000 }) }], { now: lateEvening + 3_600_000, acknowledged: new Set(), timeZone: "Asia/Tokyo" });
  assert.equal(tokyo.history[0].days[0].when, "today", "it is already the 7th in Tokyo an hour later");
  const utc = activityView([{ deviceId: "usb-1", entries: groupActivity([job], { now: lateEvening + 3_600_000 }) }], { now: lateEvening + 3_600_000, acknowledged: new Set(), timeZone: "UTC" });
  assert.equal(utc.history[0].days[0].when, "yesterday");
});

test("yesterday is the calendar day before today, also across a month end", () => {
  const firstOfMonth = Date.UTC(2026, 10, 1, 9, 0);
  const lastOfMonth = Date.UTC(2026, 9, 31, 22, 0);
  const job = dump("a", { createdAt: lastOfMonth, updatedAt: lastOfMonth + 1000 });
  const { history } = activityView([{ deviceId: "usb-1", entries: groupActivity([job], { now: firstOfMonth }) }], { now: firstOfMonth, acknowledged: new Set(), timeZone: "UTC" });
  assert.equal(history[0].days[0].when, "yesterday");
});

test("each device has its own history, the one that did something last first, and routine bursts are history too", () => {
  const { history } = view({
    "usb-1": [dump("a", { createdAt: NOW - 7_200_000, updatedAt: NOW - 7_100_000 })],
    "usb-2": [operation({ request: { deviceId: "usb-2" }, createdAt: NOW - 600_000 }), operation({ request: { deviceId: "usb-2" }, createdAt: NOW - 599_000 })],
  });
  assert.deepEqual(history.map((entry) => [entry.deviceId, entry.count]), [["usb-2", 1], ["usb-1", 1]]);
  assert.equal(history[0].days[0].entries[0].kind, "burst");
});

test("a finished backup is one line of history, not fifty-eight", () => {
  const dumps = Array.from({ length: 58 }, (_, index) => dump(`p${index}`, { createdAt: NOW - 600_000 + index * 2_000, updatedAt: NOW - 600_000 + index * 2_000 + 1_500 }));
  const { history, needsYou, live } = view({ "usb-1": dumps });
  assert.deepEqual([needsYou.length, live.length], [0, 0]);
  assert.equal(history[0].count, 1);
  assert.equal(history[0].days[0].entries[0].members.length, 58);
});

test("a zip or a save to the server that failed is pinned with what else needs the person, until it is acknowledged", () => {
  const transfer = (id, state, over = {}) => ({ id, kind: "save", artifactIds: ["a"], label: "Lenovo backup", state, progress: { phase: "uploading", done: 1, total: 2, bytes: 1, totalBytes: 2 }, startedAt: NOW - 5_000, endedAt: NOW - 1_000, origin: "agent", ...over });
  const failed = transfer("t1", "failed", { error: { code: "disk-full", message: "The server has no room for this backup." } });
  const transfers = [failed, transfer("t2", "succeeded"), transfer("t3", "cancelled"), transfer("t4", "running", { endedAt: undefined })];
  const open = view({ "usb-1": [failedDump("a")] }, { transfers });
  assert.deepEqual(open.needsYou.map((item) => item.kind === "transfer" ? [item.kind, item.job.id] : [item.kind]), [["problem"], ["transfer", "t1"]], "a failed transfer, not a finished, cancelled or running one");
  assert.deepEqual(view({ "usb-1": [] }, { transfers, acknowledged: new Set(["t1"]) }).needsYou, []);
});

test("the table a backup is measured against is the newest one read before the backup began", () => {
  const table = (names, at) => operation({ createdAt: at, request: { protocol: "edl", action: "exec", command: "printgpt", target: undefined }, result: { summary: "tables", details: { partitions: names.map((name) => ({ name, bytes: 10 })) } } });
  const older = table(["a"], NOW - 900_000);
  const newer = table(["a", "b"], NOW - 800_000);
  const after = table(["a", "b", "c"], NOW - 100_000);
  const other = { ...table(["z"], NOW - 700_000), request: { protocol: "edl", action: "exec", command: "printgpt", deviceId: "usb-2" } };
  const job = group([dump("a", { createdAt: NOW - 600_000, updatedAt: NOW - 590_000 })])[0];
  assert.deepEqual(planBefore([older, newer, after, other], job).map((item) => item.name), ["a", "b"]);
  assert.equal(planBefore([after], job), undefined, "a table read afterwards is not what it was working from");
  assert.equal(planBefore([], job), undefined);
  const failedRead = { ...newer, state: "failed", result: undefined };
  assert.deepEqual(planBefore([older, failedRead], job).map((item) => item.name), ["a"], "a read that failed told nothing");
});
