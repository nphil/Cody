import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Approving before the moment of sending.
 *
 * The person approves the exact action on the card, then chooses a wait (their hands are on the device's buttons);
 * the command goes out when the wait ends. These tests run the real operation manager against a fake device and pin
 * what must hold while it waits: nothing is sent early, the approval is spent once, it dies with the clock, a
 * cancel, a departed device or a different device, and an unanswered approval is NOT timed out.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceOperationManager, APPROVAL_SLACK_MS } = await jiti.import("./operations.ts");

const START = 1_000_000;
const UNIT = "usb:18d1:4ee0:UNIT1";
const DEVICE = "usb-device-1";

/** Let every promise chain that can run, run. setImmediate is never mocked, so it works while timers are. */
async function flush() {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

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
  };
  const flasher = {
    protocol: "fastboot",
    actions: ["exec"],
    async run(request, context) {
      state.seen.push(request);
      if (request.command === "getvar product") return { summary: "msm8x53" };
      await context.confirm({ action: "fastboot command", target: request.command, backup: "Not applicable: reboot changes mode." });
      state.sent.push(request.command);
      return { summary: `Fastboot accepted ${request.command}.` };
    },
  };
  const manager = new DeviceOperationManager("session-a", provider, { async getInput() { return undefined; }, async save() { return "artifact"; } }, [flasher]);
  return { manager, state };
}

async function awaitingApproval(manager, id) {
  for (let turn = 0; turn < 60; turn += 1) {
    const snapshot = manager.status(id);
    if (snapshot?.confirmation) return snapshot;
    await flush();
  }
  throw new Error("the operation never asked for approval");
}

/** Give the approval, then let the countdown's timer come into being before the test moves the clock. */
async function approve(manager, id, asking, sendDelaySeconds) {
  const snapshot = manager.confirm(id, asking.confirmation.id, asking.confirmation.binding, undefined, { sendDelaySeconds });
  await flush();
  return snapshot;
}

const reboot = (options) => ({ protocol: "fastboot", action: "exec", deviceId: DEVICE, command: "reboot-bootloader", ...(options ? { options } : {}) });

test("an approval that waits sends nothing until its countdown ends, then exactly the one approved command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  assert.equal(asking.state, "awaiting-confirmation");
  assert.equal(asking.approvalAsked, true);
  assert.deepEqual(asking.confirmation.device, { id: DEVICE, identity: UNIT }, "the card names the device it is for");

  const armed = await approve(manager, id, asking, 30);
  assert.equal(armed.state, "armed");
  assert.equal(armed.armed.approvedAt, START);
  assert.equal(armed.armed.releaseAt, START + 30_000);
  assert.equal(armed.armed.expiresAt, START + 30_000 + APPROVAL_SLACK_MS, "the approval lives for the countdown and a little slack, no longer");
  assert.equal(armed.armed.binding.target, "reboot-bootloader", "what was approved stays visible while it waits");
  assert.equal(armed.confirmation, undefined, "the prompt is gone once answered");

  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(manager.status(id).state, "armed", "one millisecond early is still waiting");
  assert.deepEqual(state.sent, [], "nothing reaches the device before the countdown ends");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(manager.status(id).state, "succeeded");
  assert.deepEqual(state.sent, ["reboot-bootloader"], "exactly one command, once");
  assert.equal(manager.status(id).armed, undefined, "the spent approval is gone");
  assert.equal(state.releases, 1);
});

test("an approval is single-use: it cannot be given again, re-armed or extended while it waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  await approve(manager, id, asking, 10);
  const before = manager.status(id).armed;

  assert.throws(() => manager.confirm(id, asking.confirmation.id, asking.confirmation.binding, undefined, { sendDelaySeconds: 300 }), /not awaiting confirmation/);
  assert.deepEqual(manager.status(id).armed, before, "a second confirm changed nothing");

  t.mock.timers.tick(10_000);
  await flush();
  assert.throws(() => manager.confirm(id, asking.confirmation.id, asking.confirmation.binding), /not awaiting confirmation/, "and a spent approval cannot be replayed");
  assert.deepEqual(state.sent, ["reboot-bootloader"]);
});

test("the approval still binds the exact action: a changed target is refused and leaves the prompt open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  assert.throws(() => manager.confirm(id, asking.confirmation.id, { ...asking.confirmation.binding, target: "oem unlock" }, undefined, { sendDelaySeconds: 5 }), /no longer matches/);
  assert.throws(() => manager.confirm(id, "device-confirmation-forged", asking.confirmation.binding, undefined, { sendDelaySeconds: 5 }), /no longer matches/);
  assert.equal(manager.status(id).state, "awaiting-confirmation");
  assert.deepEqual(state.sent, []);
});

test("the wait must be a whole number of seconds up to five minutes; a bad one is refused and the prompt stays open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  for (const bad of [-1, 1.5, 301, Number.NaN, "10"]) {
    assert.throws(() => manager.start(reboot({ sendDelaySeconds: bad })), /sendDelaySeconds must be a whole number of seconds from 1 to 300/, `request wait ${String(bad)}`);
  }
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  for (const bad of [-1, 1.5, 301]) {
    assert.throws(() => manager.confirm(id, asking.confirmation.id, asking.confirmation.binding, undefined, { sendDelaySeconds: bad }), /whole number of seconds from 1 to 300/, `chosen wait ${bad}`);
  }
  assert.equal(manager.status(id).state, "awaiting-confirmation", "a refused choice does not spend the approval");
  manager.confirm(id, asking.confirmation.id, asking.confirmation.binding, undefined, { sendDelaySeconds: 300 });
  assert.equal(manager.status(id).armed.releaseAt - manager.status(id).armed.approvedAt, 300_000, "five minutes is the longest allowed");
  assert.deepEqual(state.sent, []);
});

test("the wait an agent asks for is only a default: the person may change it or send at once, and no flasher ever sees it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();

  const asked = manager.start(reboot({ sendDelaySeconds: 20 }));
  const asking = await awaitingApproval(manager, asked.id);
  assert.equal(asking.confirmation.sendDelaySeconds, 20, "the card is told what was asked for");
  assert.equal(asking.request.options, undefined, "the wait is the manager's, not part of the request a flasher gets");
  assert.equal(state.seen[0].options, undefined, "a flasher that refuses unknown option keys (EDL does) never meets it");
  assert.equal(manager.confirm(asked.id, asking.confirmation.id, asking.confirmation.binding).armed.releaseAt - START, 20_000, "approved as asked: 20 s");

  const changed = manager.start({ ...reboot({ sendDelaySeconds: 20 }), command: "reboot" });
  const second = await awaitingApproval(manager, changed.id);
  const now = manager.confirm(changed.id, second.confirmation.id, second.confirmation.binding, undefined, { sendDelaySeconds: 0 });
  assert.equal(now.state, "running", "the person chose to send right away");
  assert.equal(now.armed, undefined);

  const kept = manager.start({ ...reboot({ sendDelaySeconds: 5, pad: "zero" }), command: "reboot-recovery" });
  await awaitingApproval(manager, kept.id);
  assert.deepEqual(state.seen.at(-1).options, { pad: "zero" }, "other options reach the flasher untouched");
});

test("cancelling during the countdown stops the command, releases the device and sends nothing later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  await approve(manager, id, asking, 60);
  t.mock.timers.tick(20_000);
  await flush();

  manager.cancel(id);
  await flush();
  const cancelled = manager.status(id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.armed, undefined);
  assert.equal(state.releases, 1, "the device connection is let go");

  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.deepEqual(state.sent, [], "the cancelled approval never fires");
});

test("an approval the page slept through is void: past its expiry nothing is sent and the reason is said", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  await approve(manager, id, asking, 5);

  // The machine slept for three minutes; the timer that was due after five seconds wakes up late.
  t.mock.timers.setTime(START + 3 * 60_000);
  t.mock.timers.tick(5_000);
  await flush();
  const refused = manager.status(id);
  assert.equal(refused.state, "failed");
  assert.match(refused.error, /^Not sent: the approval ran out/);
  assert.match(refused.error, /Nothing was changed on the device/);
  assert.deepEqual(state.sent, []);
  assert.equal(refused.armed, undefined);
});

test("the expiry boundary: a timer late by exactly the slack still sends, one millisecond more and nothing does", async (t) => {
  for (const [lateBy, outcome] of [[APPROVAL_SLACK_MS, "succeeded"], [APPROVAL_SLACK_MS + 1, "failed"]]) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const { manager, state } = rig();
    const { id } = manager.start(reboot());
    const asking = await awaitingApproval(manager, id);
    await approve(manager, id, asking, 5);
    // The timer was due at START + 5 s; the page wakes up `lateBy` later than that.
    t.mock.timers.setTime(START + lateBy);
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(manager.status(id).state, outcome, `late by ${lateBy} ms`);
    assert.deepEqual(state.sent, outcome === "succeeded" ? ["reboot-bootloader"] : [], `late by ${lateBy} ms`);
    t.mock.timers.reset();
  }
});

test("the device must still be the one that was approved when the command is due", async (t) => {
  for (const [what, change, pattern] of [
    ["a different device took its place", (state) => { state.current = "usb:18d1:4ee0:SOMEONE-ELSE"; }, /no longer the device you approved.*SOMEONE-ELSE/],
    ["it is no longer attached", (state) => { state.current = undefined; }, /no longer the device you approved.*not attached/],
    ["the connection reports it left the bus", (state) => { state.connected = false; }, /left the USB bus during the countdown/],
  ]) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const { manager, state } = rig();
    const { id } = manager.start(reboot());
    const asking = await awaitingApproval(manager, id);
    await approve(manager, id, asking, 10);
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

test("a device that leaves during the countdown cancels the approval and the card says why", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  await approve(manager, id, asking, 30);

  await manager.deviceDisconnected(DEVICE);
  const cancelled = manager.status(id);
  assert.equal(cancelled.state, "cancelled");
  assert.match(cancelled.error, /left the USB bus during the countdown/);
  assert.match(cancelled.error, /the command was not sent/);
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(state.sent, []);
});

test("a device that leaves before the approval is given cancels the prompt and says so instead of just vanishing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager } = rig();
  const { id } = manager.start(reboot());
  await awaitingApproval(manager, id);
  await manager.deviceDisconnected(DEVICE);
  const cancelled = manager.status(id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.confirmation, undefined);
  assert.match(cancelled.error, /left the USB bus before this was approved/);
  assert.match(cancelled.error, /Nothing was changed on the device/);

  const forgotten = rig();
  const second = forgotten.manager.start(reboot());
  await awaitingApproval(forgotten.manager, second.id);
  await forgotten.manager.deviceDisconnected(DEVICE, "forgotten");
  assert.match(forgotten.manager.status(second.id).error, /The device was disconnected before this was approved/);
});

test("an unanswered approval does not time out: a day later the prompt is still waiting and can still be answered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager, state } = rig();
  const { id } = manager.start(reboot());
  const asking = await awaitingApproval(manager, id);
  t.mock.timers.tick(24 * 60 * 60_000);
  await flush();
  assert.equal(manager.status(id).state, "awaiting-confirmation");
  assert.equal(manager.status(id).error, undefined);

  manager.confirm(id, asking.confirmation.id, asking.confirmation.binding);
  await flush();
  assert.equal(manager.status(id).state, "succeeded");
  assert.deepEqual(state.sent, ["reboot-bootloader"]);
});

test("only a command that asked for approval is marked as having done so", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const { manager } = rig();
  const read = manager.start({ protocol: "fastboot", action: "exec", deviceId: DEVICE, command: "getvar product" });
  for (let turn = 0; turn < 20 && manager.status(read.id).state !== "succeeded"; turn += 1) await flush();
  assert.equal(manager.status(read.id).state, "succeeded");
  assert.equal(manager.status(read.id).approvalAsked, undefined, "a routine read never asked");

  const write = manager.start(reboot());
  await awaitingApproval(manager, write.id);
  assert.equal(manager.status(write.id).approvalAsked, true);
});
