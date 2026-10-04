import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Which device operations deserve a pop-up. The rule is the point: an agent that inspects a device runs a dozen small
 * commands, and a pop-up per command (or per line of output) buried the chat. These tests state what the person IS
 * told - an approval to give, a long or bulk operation done, a failure, a system cancel - and that everything else is
 * silent.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceNoticeBatcher, LONG_OPERATION_MS, describeOperation, deviceNoticeFrame, noticeForOperation, shelfItemFor } = await jiti.import("./operation-notices.ts");

let counter = 0;
function snapshot(over = {}) {
  counter += 1;
  const { request, ...rest } = over;
  return {
    id: `op-${counter}`,
    sessionId: "session-a",
    origin: "agent",
    state: "succeeded",
    createdAt: 1_000,
    updatedAt: 1_400,
    output: [],
    events: [],
    request: { protocol: "fastboot", action: "exec", deviceId: "usb-1", command: "getvar product", ...request },
    result: { summary: "msm8x53" },
    ...rest,
  };
}

const running = (over = {}) => snapshot({ state: "running", result: undefined, ...over });
const confirmationEvent = (extra = {}) => ({
  sequence: 3,
  at: 1_100,
  type: "confirmation",
  confirmation: { id: "device-confirmation-1", requestedAt: 1_100, device: { id: "usb-1" }, binding: { action: "fastboot command", target: "reboot-bootloader", backup: "Not applicable: reboot changes mode." }, ...extra },
});

test("a routine read that succeeds is silent, however many the agent runs", () => {
  for (let index = 0; index < 25; index += 1) {
    const finished = snapshot({ request: { command: `getvar var${index}` } });
    assert.equal(noticeForOperation(finished, undefined, running({ id: finished.id })), null, `command ${index}`);
  }
});

test("progress, output and state changes never raise a pop-up", () => {
  const live = running();
  const events = [
    { sequence: 1, at: 1_001, type: "progress", progress: { phase: "acquiring", message: "Acquiring exclusive hardware lease", at: 1_001 } },
    { sequence: 2, at: 1_002, type: "output", output: { at: 1_002, line: "(bootloader) product: msm8x53", kind: "log" } },
    { sequence: 3, at: 1_003, type: "state", state: "running" },
    { sequence: 4, at: 1_004, type: "state", state: "armed" },
    { sequence: 5, at: 1_005, type: "state", state: "cancelling" },
  ];
  for (const event of events) assert.equal(noticeForOperation(live, event, live), null, event.type);
});

test("an approval request is a pop-up: it names the action, the target and the device, and is keyed per approval", () => {
  const waiting = snapshot({ state: "awaiting-confirmation", result: undefined });
  const notice = noticeForOperation(waiting, confirmationEvent(), waiting, "Lenovo Smart Display");
  assert.equal(notice.level, "warning");
  assert.match(notice.message, /Approval needed: fastboot command - reboot-bootloader on Lenovo Smart Display/);
  assert.match(notice.message, /Open the Devices panel/);
  assert.equal(notice.dedupeKey, "device:approval:device-confirmation-1");
  assert.notEqual(notice.burst, true, "an approval is never folded into a failure summary");

  const timed = noticeForOperation(waiting, confirmationEvent({ sendDelaySeconds: 20 }), waiting);
  assert.match(timed.message, /After you approve it waits 20 s before sending/);
});

test("a command the person typed themselves does not pop up an approval they are looking at", () => {
  const mine = snapshot({ origin: "user", state: "awaiting-confirmation", result: undefined });
  assert.equal(noticeForOperation(mine, confirmationEvent(), mine), null);
});

test("failures are pop-ups: an agent's always, a person's own only when it was long", () => {
  const failed = snapshot({ state: "failed", result: undefined, error: "Failed to execute 'transferIn' on 'USBDevice'" });
  const notice = noticeForOperation(failed, undefined, running({ id: failed.id }), "Lenovo");
  assert.equal(notice.level, "warning");
  assert.equal(notice.message, "fastboot getvar product on Lenovo failed: Failed to execute 'transferIn' on 'USBDevice'");
  assert.equal(notice.burst, true, "failures are the ones a burst folds");

  const mineQuick = snapshot({ origin: "user", state: "failed", result: undefined, error: "nope" });
  assert.equal(noticeForOperation(mineQuick, undefined, running({ id: mineQuick.id })), null);
  const mineLong = snapshot({ origin: "user", state: "failed", result: undefined, error: "nope", updatedAt: 1_000 + LONG_OPERATION_MS + 1 });
  assert.match(noticeForOperation(mineLong, undefined, running({ id: mineLong.id })).message, /failed: nope/);
});

test("a cancel the system made is a pop-up with its reason; one the person or the agent made is not news", () => {
  const byDevice = snapshot({ state: "cancelled", result: undefined, error: "The device left the USB bus before this was approved, so it was cancelled. Nothing was changed on the device." });
  const notice = noticeForOperation(byDevice, undefined, running({ id: byDevice.id }));
  assert.match(notice.message, /fastboot getvar product was cancelled: The device left the USB bus before this was approved/);
  assert.equal(notice.burst, true);

  const byHand = snapshot({ state: "cancelled", result: undefined });
  assert.equal(noticeForOperation(byHand, undefined, running({ id: byHand.id })), null);
});

test("a finished backup, flash or dump is a pop-up however fast it was; a quick ordinary command is not", () => {
  for (const action of ["flash", "dump", "pull", "push", "sideload", "install"]) {
    const done = snapshot({ request: { action, target: "boot_a", command: undefined }, result: { summary: `${action} done\nsecond line` } });
    const notice = noticeForOperation(done, undefined, running({ id: done.id }));
    assert.equal(notice.level, "success", action);
    assert.match(notice.message, new RegExp(`finished: ${action} done$`), `${action}: first line of the summary only`);
  }
  const quick = snapshot({ request: { action: "detect", command: undefined } });
  assert.equal(noticeForOperation(quick, undefined, running({ id: quick.id })), null);
});

test("a long operation that succeeds is a pop-up, counted from when it was allowed to run, not from when it asked", () => {
  const long = snapshot({ request: { command: "backup", protocol: "edl" }, createdAt: 1_000, updatedAt: 1_000 + LONG_OPERATION_MS, result: { summary: "Saved 14 partitions" } });
  assert.match(noticeForOperation(long, undefined, running({ id: long.id })).message, /edl backup finished: Saved 14 partitions/);

  // Two minutes waiting for the person's approval, then a one-second command: not a long operation.
  const waited = snapshot({
    createdAt: 1_000,
    updatedAt: 1_000 + 120_000 + 1_000,
    events: [{ sequence: 1, at: 1_000 + 120_000, type: "state", state: "running" }],
    request: { command: "reboot-bootloader" },
    approvalAsked: true,
  });
  assert.equal(noticeForOperation(waited, undefined, running({ id: waited.id })), null);
});

test("a finish is news only as the step from running to finished: a replayed finished operation is silent", () => {
  const failed = snapshot({ state: "failed", result: undefined, error: "old news" });
  assert.equal(noticeForOperation(failed, undefined, undefined), null, "a server that never saw it start (restarted) is being replayed to");
  assert.equal(noticeForOperation(failed, undefined, failed), null, "the same finished operation sent again");
  assert.notEqual(noticeForOperation(failed, undefined, running({ id: failed.id })), null);
});

test("describeOperation says what ran in a few words and clips what is long", () => {
  assert.equal(describeOperation(snapshot({ request: { command: "reboot-bootloader" } })), "fastboot reboot-bootloader");
  assert.equal(describeOperation(snapshot({ request: { protocol: "adb", action: "pull", target: "/sdcard/a.img", command: undefined } })), "adb pull /sdcard/a.img");
  assert.equal(describeOperation(snapshot({ request: { protocol: "adb", command: undefined, options: { kind: "root" } } })), "adb root");
  assert.ok(describeOperation(snapshot({ request: { command: "x".repeat(500) } })).length < 140);
});

function batcher(options = {}) {
  const emitted = [];
  const clock = { now: 10_000, timers: [] };
  const instance = new DeviceNoticeBatcher((notice) => emitted.push(notice), {
    windowMs: 5_000,
    now: () => clock.now,
    schedule: (run, ms) => {
      const timer = { run, at: clock.now + ms, cancelled: false };
      clock.timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    ...options,
  });
  const advance = (ms) => {
    clock.now += ms;
    for (const timer of clock.timers) if (!timer.cancelled && timer.at <= clock.now) { timer.cancelled = true; timer.run(); }
  };
  return { instance, emitted, advance };
}

const failure = (text) => ({ level: "warning", message: text, dedupeKey: `k:${text}`, burst: true });

test("a burst of failures is one pop-up now and one summary later, not one each", () => {
  const { instance, emitted, advance } = batcher();
  instance.push(failure("getvar a failed"));
  assert.deepEqual(emitted.map((notice) => notice.message), ["getvar a failed"], "the first failure is shown at once");
  for (const name of ["b", "c", "d", "e"]) instance.push(failure(`getvar ${name} failed`));
  advance(1_000);
  assert.equal(emitted.length, 1, "the rest are held while the window is open");
  advance(4_000);
  assert.equal(emitted.length, 2);
  assert.match(emitted[1].message, /^4 more device operations failed or were cancelled\. Latest: getvar e failed$/);
  assert.equal(emitted[1].dedupeKey, "device:failed:summary");
});

test("a lone failure leaves no summary, and the next burst starts fresh", () => {
  const { instance, emitted, advance } = batcher();
  instance.push(failure("first"));
  advance(5_000);
  assert.equal(emitted.length, 1);
  instance.push(failure("second"));
  assert.deepEqual(emitted.map((notice) => notice.message), ["first", "second"], "outside the window a failure is shown at once again");
});

test("approvals and completions are never held back by a failure burst", () => {
  const { instance, emitted } = batcher();
  instance.push(failure("a"));
  instance.push(failure("b"));
  instance.push({ level: "warning", message: "Approval needed", dedupeKey: "device:approval:1" });
  instance.push({ level: "success", message: "dump finished", dedupeKey: "device:done:1" });
  assert.deepEqual(emitted.map((notice) => notice.message), ["a", "Approval needed", "dump finished"]);
});

test("disposing the batcher drops what it was holding and cancels its timer", () => {
  const { instance, emitted, advance } = batcher();
  instance.push(failure("a"));
  instance.push(failure("b"));
  instance.dispose();
  advance(60_000);
  assert.deepEqual(emitted.map((notice) => notice.message), ["a"], "nobody is left to tell");
});

test("a device notice crosses to the chat as written: its level survives, a repeat carries one key, and nothing is shown without words", () => {
  for (const level of ["info", "warning", "success"]) {
    const frame = deviceNoticeFrame({ level, message: "  something happened  ", dedupeKey: `k-${level}`, burst: true });
    assert.deepEqual(frame, { type: "notice", source: "device", level, message: "  something happened  ", dedupeKey: `k-${level}` }, "the burst marker is the server's business and never travels");
    assert.deepEqual(shelfItemFor(frame), { type: level, message: "something happened", dedupeKey: `k-${level}` }, `a ${level} stays a ${level}: never an engine's red error`);
  }
  assert.deepEqual(shelfItemFor({ level: "error", message: "odd" }), { type: "info", message: "odd" }, "an unknown level is shown quietly, with no key");
  assert.deepEqual(shelfItemFor({ level: "warning", message: "x", dedupeKey: 42 }), { type: "warning", message: "x" }, "a key that is not text is ignored");
  for (const empty of [{}, { message: "" }, { message: "   " }, { message: 7 }]) assert.equal(shelfItemFor(empty), null);
});
