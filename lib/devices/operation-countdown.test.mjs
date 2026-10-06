import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { allowAgent, flush, untilTrustRequest } from "./trust.test-helper.mjs";

/**
 * `options.sendDelaySeconds`: a visible countdown with a Cancel button before the first command is sent, so the person
 * can get their hands on the device's buttons. It is not an approval - the person's trust was given before the
 * operation began and nothing here asks anything. These tests run the real operation manager against a fake device and
 * pin what must hold while it counts: nothing is sent early, Cancel works at any moment, the wait dies with the clock,
 * a departed device or a different device, and it starts only once the device is trusted.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceOperationManager, COUNTDOWN_SLACK_MS } = await jiti.import("./operations.ts");

const START = 1_000_000;
const UNIT = "usb:18d1:4ee0:UNIT1";
const DEVICE = "usb-device-1";

function rig({ identity = UNIT } = {}) {
  const state = { current: identity, connected: true, releases: 0, sent: [], seen: [] };
  const provider = {
    async borrowHardwareTransport() {
      return {
        transport: { kind: "usb", async read() { return null; }, async write() {}, connected: () => state.connected },
        identity,
        async release() { state.releases += 1; },
      };
    },
    currentIdentity: () => state.current,
    describeDevice: () => ({ label: "Lenovo Smart Display" }),
  };
  const flasher = {
    protocol: "fastboot",
    actions: ["exec"],
    async run(request, context) {
      state.seen.push(request);
      if (request.command === "getvar product") return { summary: "msm8x53" };
      const steps = request.command === "two-step" ? ["flash one", "flash two"] : [request.command];
      for (const step of steps) {
        await context.confirm({ action: "fastboot command", target: step, backup: "Not applicable: reboot changes mode." });
        state.sent.push(step);
      }
      return { summary: `Fastboot accepted ${request.command}.` };
    },
  };
  const manager = new DeviceOperationManager("session-a", provider, { async getInput() { return undefined; }, async save() { return "artifact"; } }, [flasher]);
  return { manager, state };
}

const reboot = (options, command = "reboot-bootloader") => ({ protocol: "fastboot", action: "exec", deviceId: DEVICE, command, ...(options ? { options } : {}) });

/** Starts an agent operation on a device the person has already allowed, and waits until its countdown shows. */
async function counting(manager, request) {
  const { id } = manager.start(request);
  if (manager.trustLevel(DEVICE) === "none") await allowAgent(manager, { deviceId: DEVICE });
  for (let turn = 0; turn < 100; turn += 1) {
    const snapshot = manager.status(id);
    if (snapshot.state === "countdown") return snapshot;
    await flush(2);
  }
  throw new Error(`the operation never began counting down (${manager.status(id).state})`);
}

test("a requested wait is a visible countdown: nothing is sent until it ends, then exactly the one command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const started = await counting(manager, reboot({ sendDelaySeconds: 30 }));
  const { id } = started;
  assert.equal(started.state, "countdown");
  assert.equal(started.countdown.startedAt, START);
  assert.equal(started.countdown.releaseAt, START + 30_000);
  assert.equal(started.countdown.binding.target, "reboot-bootloader", "what is about to be sent is shown while it waits");
  assert.equal(started.countdown.binding.action, "fastboot command");
  assert.equal(started.riskDeclared, true);

  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(manager.status(id).state, "countdown", "one millisecond early is still counting");
  assert.deepEqual(state.sent, [], "nothing reaches the device before the countdown ends");

  t.mock.timers.tick(1);
  await flush();
  const done = manager.status(id);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(state.sent, ["reboot-bootloader"], "exactly one command, once");
  assert.equal(done.countdown, undefined, "the finished countdown is gone");
  assert.equal(state.releases, 1);
});

test("counting down is not an approval: there is nothing to give, only Cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const snapshot = await counting(manager, reboot({ sendDelaySeconds: 20 }));
  for (const approvalShaped of ["confirmation", "armed", "approvalAsked"]) assert.equal(approvalShaped in snapshot, false, `no ${approvalShaped} on the snapshot`);
  assert.equal(manager.confirm, undefined, "the manager has no way to approve anything");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(manager.status(snapshot.id).state, "countdown", "nothing the page does shortens the wait");
  manager.cancel(snapshot.id);
  await flush();
  assert.equal(manager.status(snapshot.id).state, "cancelled");
  assert.deepEqual(state.sent, []);
});

test("the wait runs once, before the first command: later commands of the same operation go out at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = await counting(manager, reboot({ sendDelaySeconds: 10 }, "two-step"));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(manager.status(id).state, "succeeded", "the second command did not start another countdown");
  assert.deepEqual(state.sent, ["flash one", "flash two"]);
});

test("the wait must be a whole number of seconds from 1 to 300; a bad one is refused before anything is asked or sent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  for (const bad of [0, -1, 1.5, 301, Number.NaN, Infinity, "10", null]) {
    assert.throws(() => manager.start(reboot({ sendDelaySeconds: bad })), /sendDelaySeconds must be a whole number of seconds from 1 to 300/, `wait ${String(bad)}`);
  }
  assert.deepEqual(manager.trustRequests(), [], "a refused request raised no question");
  assert.deepEqual(manager.snapshots(), [], "and left no operation behind");
  const longest = await counting(manager, reboot({ sendDelaySeconds: 300 }));
  assert.equal(longest.countdown.releaseAt - longest.countdown.startedAt, 300_000, "five minutes is the longest allowed");
  const shortest = await counting(manager, reboot({ sendDelaySeconds: 1 }, "reboot"));
  assert.equal(shortest.countdown.releaseAt - shortest.countdown.startedAt, 1_000);
  assert.deepEqual(state.sent, []);
});

test("no flasher ever sees the wait, and every other option reaches it untouched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  await counting(manager, reboot({ sendDelaySeconds: 20 }));
  assert.equal(state.seen[0].options, undefined, "a flasher that refuses unknown option keys (EDL does) never meets it");
  assert.equal(manager.snapshots()[0].request.options, undefined, "nor does the record the panel shows");

  await counting(manager, reboot({ sendDelaySeconds: 5, pad: "zero" }, "reboot-recovery"));
  assert.deepEqual(state.seen.at(-1).options, { pad: "zero" });
});

test("a wait asked of an untrusted device counts only once the person has allowed it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot({ sendDelaySeconds: 30 }));
  await untilTrustRequest(manager, DEVICE);
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(manager.status(id).state, "awaiting-trust", "the question has waited ten minutes and nothing is counting");
  assert.equal(manager.status(id).countdown, undefined);

  await allowAgent(manager, { deviceId: DEVICE });
  for (let turn = 0; turn < 100 && manager.status(id).state !== "countdown"; turn += 1) await flush(2);
  const snapshot = manager.status(id);
  assert.equal(snapshot.state, "countdown");
  assert.equal(snapshot.countdown.startedAt, START + 10 * 60_000, "the wait starts when the person answers, not when the agent asked");
  assert.equal(snapshot.countdown.releaseAt, START + 10 * 60_000 + 30_000);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(manager.status(id).state, "succeeded");
  assert.deepEqual(state.sent, ["reboot-bootloader"]);
});

test("cancelling during the countdown stops the command, releases the device and sends nothing later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = await counting(manager, reboot({ sendDelaySeconds: 60 }));
  t.mock.timers.tick(20_000);
  await flush();

  manager.cancel(id);
  await flush();
  const cancelled = manager.status(id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.countdown, undefined);
  assert.equal(state.releases, 1, "the device connection is let go");

  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.deepEqual(state.sent, [], "the cancelled command never fires");
});

test("a countdown the page slept through is void: past its slack nothing is sent and the reason is said", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = await counting(manager, reboot({ sendDelaySeconds: 5 }));

  // The machine slept for three minutes; the timer that was due after five seconds wakes up late.
  t.mock.timers.setTime(START + 3 * 60_000);
  t.mock.timers.tick(5_000);
  await flush();
  const refused = manager.status(id);
  assert.equal(refused.state, "failed");
  assert.match(refused.error, /^Not sent: the countdown ran past its end/);
  assert.match(refused.error, /Nothing was changed on the device/);
  assert.deepEqual(state.sent, []);
  assert.equal(refused.countdown, undefined);
});

test("the slack boundary: a timer late by exactly the slack still sends, one millisecond more and nothing does", async (t) => {
  for (const [lateBy, outcome] of [[COUNTDOWN_SLACK_MS, "succeeded"], [COUNTDOWN_SLACK_MS + 1, "failed"]]) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const { manager, state } = rig();
    const { id } = await counting(manager, reboot({ sendDelaySeconds: 5 }));
    // The timer was due at START + 5 s; the page wakes up `lateBy` later than that.
    t.mock.timers.setTime(START + lateBy);
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(manager.status(id).state, outcome, `late by ${lateBy} ms`);
    assert.deepEqual(state.sent, outcome === "succeeded" ? ["reboot-bootloader"] : [], `late by ${lateBy} ms`);
    t.mock.timers.reset();
  }
});

test("the device must still be the one the countdown started on when the command is due", async (t) => {
  for (const [what, change, pattern] of [
    ["a different device took its place", (state) => { state.current = "usb:18d1:4ee0:SOMEONE-ELSE"; }, /no longer the device the countdown started on.*SOMEONE-ELSE/],
    ["it is no longer attached", (state) => { state.current = undefined; }, /no longer the device the countdown started on.*not attached/],
    ["the connection reports it left the bus", (state) => { state.connected = false; }, /left the USB bus during the countdown/],
  ]) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const { manager, state } = rig();
    const { id } = await counting(manager, reboot({ sendDelaySeconds: 10 }));
    change(state);
    t.mock.timers.tick(10_000);
    await flush();
    const refused = manager.status(id);
    assert.equal(refused.state, "failed", what);
    assert.match(refused.error, pattern, what);
    assert.match(refused.error, /^Not sent/, what);
    assert.deepEqual(state.sent, [], `${what}: nothing was sent`);
    t.mock.timers.reset();
  }
});

test("a device that leaves during the countdown cancels it and the card says why", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = await counting(manager, reboot({ sendDelaySeconds: 30 }));

  await manager.deviceDisconnected(DEVICE);
  const cancelled = manager.status(id);
  assert.equal(cancelled.state, "cancelled");
  assert.match(cancelled.error, /left the USB bus during the countdown/);
  assert.match(cancelled.error, /the command was not sent/);
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(state.sent, []);
});

test("only a command that declared a risk to the device is marked as having done so", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager } = rig();
  const read = manager.startUser({ protocol: "fastboot", action: "exec", deviceId: DEVICE, command: "getvar product" });
  for (let turn = 0; turn < 20 && manager.status(read.id).state !== "succeeded"; turn += 1) await flush();
  assert.equal(manager.status(read.id).state, "succeeded");
  assert.equal(manager.status(read.id).riskDeclared, undefined, "a routine read declared nothing");

  const write = manager.startUser(reboot());
  for (let turn = 0; turn < 20 && manager.status(write.id).state !== "succeeded"; turn += 1) await flush();
  const done = manager.status(write.id);
  assert.equal(done.riskDeclared, true);
  const declared = done.events.find((event) => event.type === "declared");
  assert.equal(declared.declared.target, "reboot-bootloader");
  assert.match(done.output.map((line) => line.line).join("\n"), /Starting fastboot command on reboot-bootloader\. Backup: Not applicable/);
});
