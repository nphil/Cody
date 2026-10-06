import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * How the Devices panel folds a device's history. A dozen `getvar`s from an agent are one entry; anything a person
 * must act on, anything still running, anything that changed the device or saved a file, and anything the person ran
 * themselves keeps its own card - and what is waiting for the person is always listed first.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { BURST_GAP_MS, describeRoutine, entrySize, groupActivity, isRoutine, needsPerson } = await jiti.import("./activity-groups.ts");

let clock = 1_000_000;
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

const ids = (entries) => entries.map((entry) => (entry.kind === "burst" ? `burst(${entry.operations.map((member) => member.id).join(",")})` : entry.operation.id));

test("a burst of routine agent commands is one entry, counted, with every command inside it", () => {
  const history = Array.from({ length: 7 }, () => operation());
  const entries = groupActivity(history);
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
  const entries = groupActivity([operation(), operation({ state: "failed", error: "No such variable", result: undefined }), operation({ state: "cancelled", result: undefined }), operation()]);
  assert.equal(entries.length, 1);
  assert.deepEqual({ ok: entries[0].succeeded, failed: entries[0].failed, cancelled: entries[0].cancelled }, { ok: 2, failed: 1, cancelled: 1 });
});

test("a command that declared a risk to the device, a flash, a dump, and a command the person ran are never folded", () => {
  const read = operation();
  const asked = operation({ riskDeclared: true, request: { command: "reboot-bootloader" } });
  const flash = operation({ request: { action: "flash", target: "boot_a", command: undefined } });
  const dump = operation({ request: { action: "dump", target: "boot_a", command: undefined } });
  const saved = operation({ request: { action: "detect", command: undefined }, result: { summary: "table", fileId: "file-1" } });
  const mine = operation({ origin: "user" });
  for (const single of [asked, flash, dump, saved, mine]) assert.equal(isRoutine(single), false, single.request.command ?? single.request.action);
  assert.equal(isRoutine(read), true);
  const entries = groupActivity([read, asked, flash, dump, saved, mine]);
  assert.equal(entries.length, 6, "every one keeps its own card");
  assert.equal(entries.every((entry) => entry.kind === "single" || entry === entries[entries.length - 1]), true);
});

test("a command still running is never folded, and joins the burst only once it has finished", () => {
  const [earlier, later] = [operation(), operation()];
  const live = operation({ state: "running", result: undefined });
  assert.equal(isRoutine(live), false);
  assert.deepEqual(ids(groupActivity([earlier, later, live])), [live.id, `burst(${earlier.id},${later.id})`]);
  const done = { ...live, state: "succeeded", result: { summary: "OKAY" } };
  assert.deepEqual(ids(groupActivity([earlier, later, done])), [`burst(${earlier.id},${later.id},${live.id})`]);
});

test("something else that happened on the device splits a burst in two", () => {
  const first = [operation(), operation()];
  const flash = operation({ request: { action: "flash", target: "boot_a", command: undefined } });
  const second = [operation(), operation(), operation()];
  const entries = groupActivity([...first, flash, ...second]);
  assert.deepEqual(ids(entries), [
    `burst(${second.map((member) => member.id).join(",")})`,
    flash.id,
    `burst(${first.map((member) => member.id).join(",")})`,
  ], "newest first");
});

test("commands further apart than the burst gap are two bursts", () => {
  const early = operation({ createdAt: 5_000_000 });
  const late = operation({ createdAt: early.updatedAt + BURST_GAP_MS + 1 });
  assert.equal(groupActivity([early, late]).length, 2);
  const close = operation({ createdAt: early.updatedAt + BURST_GAP_MS });
  assert.equal(groupActivity([early, close]).length, 1, "the gap itself is still one burst");
});

test("what is waiting for the person is listed first, whatever else is newer", () => {
  const waiting = operation({ state: "awaiting-trust", result: undefined, request: { command: "reboot-bootloader" } });
  const counting = operation({ state: "countdown", result: undefined, riskDeclared: true, request: { command: "reboot" } });
  const newerReads = [operation(), operation(), operation()];
  const entries = groupActivity([waiting, counting, ...newerReads]);
  assert.equal(needsPerson(waiting) && needsPerson(counting), true);
  assert.deepEqual(ids(entries).slice(0, 2), [counting.id, waiting.id], "what waits for the person first (newest of them first)");
  assert.equal(entries[2].kind, "burst");
});

test("a burst keeps one id while it grows at its newer end, so its open/closed state is not lost", () => {
  const first = operation();
  const grown = groupActivity([first, operation(), operation()]);
  const smaller = groupActivity([first]);
  assert.equal(grown[0].id, smaller[0].id);
});

test("a burst of different protocols names each once, in order of first use", () => {
  const entries = groupActivity([operation({ request: { protocol: "adb", command: "getprop ro.product.model" } }), operation(), operation({ request: { protocol: "adb", command: "id" } })]);
  assert.deepEqual(entries[0].protocols, ["adb", "fastboot"]);
});

test("a routine command is described by what it ran and what came of it, one line each", () => {
  assert.deepEqual(describeRoutine(operation({ request: { command: "getvar product" }, result: { summary: "msm8x53\nsecond line" } })), { title: "getvar product", outcome: "msm8x53" });
  assert.deepEqual(describeRoutine(operation({ state: "failed", error: "No such variable", result: undefined })).outcome, "No such variable");
  assert.deepEqual(describeRoutine(operation({ state: "cancelled", result: undefined, error: "The device left the USB bus" })).outcome, "The device left the USB bus");
  assert.equal(describeRoutine(operation({ request: { action: "detect", command: undefined } })).title, "detect");
  assert.equal(describeRoutine(operation({ request: { protocol: "adb", command: undefined, options: { kind: "reverse-list" } } })).title, "reverse-list");
  assert.ok(describeRoutine(operation({ request: { command: "x".repeat(400) } })).title.length <= 120);
});
