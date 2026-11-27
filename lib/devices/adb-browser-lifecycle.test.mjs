import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { sandboxDevice } from "./adb-device.test-helper.mjs";
import { allowAgent } from "./trust.test-helper.mjs";
import { fakeBrowser, fakeUsbAdbDevice } from "./usb-adb.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { adbFlasher } = await jiti.import("./adb.ts");
const { createPageOperationDelegate } = await jiti.import("./operations.ts");
const { DeviceBridgeConnection, forgetDevice } = await jiti.import("./client.ts");

const posix = process.platform !== "win32";
const artifacts = { async getInput() {}, async save() { return "saved"; } };
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) {
    const value = check();
    if (value) return value;
  }
  throw new Error("Expected state was not reached");
};
const finished = (manager, id) => until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));
const said = (manager, id, pattern) => manager.status(id).output.some((row) => pattern.test(row.line));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startWait = (manager, info, options) => manager.startUser({ deviceId: info.id, protocol: "adb", action: "exec", options: { kind: "wait-for-device", pollMs: 100, ...options } });
/** The wait has made at least one pass over the device and reported what it saw. */
const polling = (manager, id) => until(() => manager.status(id).progress?.phase === "adb.wait" && manager.status(id));

/**
 * A page with one granted ADB device, driven through `DeviceBridgeConnection`:
 * the registry, the lease book, the USB lifecycle listeners and the operation
 * manager are the shipped ones. Only the browser's `navigator.usb` and the
 * silicon behind the bulk endpoints are emulated.
 */
async function page(sessionId, device, operationArtifacts = artifacts) {
  const browser = fakeBrowser();
  browser.plug(device);
  const connection = new DeviceBridgeConnection(sessionId);
  connection.setOperationDelegate(createPageOperationDelegate(sessionId, connection, operationArtifacts, [adbFlasher]));
  const info = await connection.requestDevice("usb");
  const manager = connection.operationManager;
  return {
    browser,
    connection,
    manager,
    info,
    /** The agent's restart, started and trusted the way the chat does it. `sendDelaySeconds` holds the send in a visible countdown. */
    async startRoot(timeoutSeconds, sendDelaySeconds) {
      const { id } = manager.start({ deviceId: info.id, protocol: "adb", action: "exec", options: { kind: "root", timeoutSeconds, ...(sendDelaySeconds === undefined ? {} : { sendDelaySeconds }) } });
      await allowAgent(manager);
      return { id };
    },
    async close() {
      await forgetDevice(info.id);
      connection.destroy();
      browser.restore();
    },
  };
}

test("adb root lives through the WebUSB disconnect it causes: the device returns as a new USB object with the same identity, is adopted again, and is checked", { skip: !posix }, async () => {
  const first = fakeUsbAdbDevice({ adbd: sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } }), serial: "cronos-restart" });
  const { browser, connection, manager, info, startRoot, close } = await page("lifecycle-restart", first);
  try {
    const root = await startRoot(10);
    await until(() => said(manager, root.id, /restarting adbd as root/));

    // The device leaves the bus the way it really does: the browser fires `disconnect` at the page's own listener.
    const second = fakeUsbAdbDevice({ adbd: sandboxDevice({ props: { "service.adb.root": "1" } }), serial: "cronos-restart" });
    assert.notEqual(second, first);
    browser.unplug(first);
    await until(() => said(manager, root.id, /left the USB bus, as expected/));
    assert.ok(!["cancelled", "cancelling"].includes(manager.status(root.id).state), "the operation that asked for the restart is not cancelled");
    assert.equal(manager.trustLevel(info.id), "none", "the disconnect ends the connection's trust");

    // A moment later it re-enumerates: a NEW object, same vendor/product/serial.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(second.opened, false, "nothing touches the returning device before it is back on the bus");
    browser.plug(second);
    const done = await finished(manager, root.id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.result.verified, true);
    assert.deepEqual(done.result.details.observed, { "service.adb.root": "1" });
    assert.ok(second.adbd.services.some((service) => service.includes("getprop service.adb.root")), "the state was read from the restarted device");
    assert.deepEqual(connection.getSnapshot().devices.map((device) => device.id), [info.id], "it is still the same granted device id");
  } finally {
    await close();
  }
});

test("a disconnect nobody announced still cancels the operation on the real route, and the connection's trust goes with it", { skip: !posix }, async () => {
  const device = fakeUsbAdbDevice({ adbd: sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } }), serial: "cronos-unplugged" });
  const { browser, manager, info, startRoot, close } = await page("lifecycle-unplugged", device);
  try {
    const root = await startRoot(10, 30);
    await until(() => manager.status(root.id).state === "countdown");
    // Still in the countdown: no restart was sent or announced, so unplugging is just unplugging.
    browser.unplug(device);
    const done = await finished(manager, root.id);
    assert.equal(done.state, "cancelled");
    assert.equal(manager.trustLevel(info.id), "none");
    assert.equal(device.adbd.services.includes("root:"), false, "the restart was never sent");
  } finally {
    await close();
  }
});

test("a different device appearing after the restart is never adopted or talked to; the result says Cody could not reconnect", { skip: !posix }, async () => {
  const first = fakeUsbAdbDevice({ adbd: sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } }), serial: "cronos-identity" });
  const { browser, manager, startRoot, close } = await page("lifecycle-identity", first);
  try {
    const root = await startRoot(1);
    await until(() => said(manager, root.id, /restarting adbd as root/));
    const stranger = fakeUsbAdbDevice({ adbd: sandboxDevice({ props: { "service.adb.root": "1" } }), serial: "someone-else" });
    let strangerOpens = 0;
    const open = stranger.open;
    stranger.open = async () => { strangerOpens += 1; await open.call(stranger); };
    browser.unplug(first);
    browser.plug(stranger);
    const done = await finished(manager, root.id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.result.verified, false);
    assert.equal(done.result.details.restarted, true);
    assert.match(done.result.summary, /could not reconnect/);
    assert.equal(strangerOpens, 0, "the other USB identity was never opened");
    assert.deepEqual(stranger.adbd.services, [], "nothing was asked of the other device");
  } finally {
    await close();
  }
});

test("a wait-for-device lives through the WebUSB disconnect of the device it waits for: the same device returns as a new USB object, is adopted again, and the connection's trust ends", { skip: !posix }, async () => {
  // The granted device is up in normal mode; the wait is for recovery, so it keeps looking.
  const first = fakeUsbAdbDevice({ adbd: sandboxDevice(), serial: "cronos-wait" });
  const { browser, connection, manager, info, close } = await page("lifecycle-wait", first);
  try {
    const { id } = manager.start({ deviceId: info.id, protocol: "adb", action: "exec", options: { kind: "wait-for-device", pollMs: 100, state: "recovery", timeoutSeconds: 20 } });
    await allowAgent(manager);
    await polling(manager, id);

    // It reboots into recovery: the browser fires `disconnect`, and a moment later the SAME device (same vendor/product/serial) is back as a new object.
    const second = fakeUsbAdbDevice({ adbd: sandboxDevice({ state: "recovery", props: { "ro.product.model": "Cronos" } }), serial: "cronos-wait" });
    assert.notEqual(second, first);
    browser.unplug(first);
    await until(() => said(manager, id, /left the USB bus/));
    assert.ok(!["cancelled", "cancelling"].includes(manager.status(id).state), "the wait is not cancelled by the device leaving: waiting for it is what it is doing");
    assert.equal(manager.trustLevel(info.id), "none", "the disconnect ends the connection's trust");
    await sleep(300);
    assert.ok(!["cancelled", "cancelling", "failed"].includes(manager.status(id).state));
    browser.plug(second);

    const done = await finished(manager, id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.result.verified, true);
    assert.equal(done.result.details.state, "recovery");
    assert.equal(done.result.details.model, "Cronos");
    assert.deepEqual(connection.getSnapshot().devices.map((device) => device.id), [info.id], "it is still the same granted device id");
  } finally {
    await close();
  }
});

/** An adbd that has not started: the USB device is there and says nothing, like a tablet in the middle of booting. */
function bootingAdbd() {
  return {
    services: [],
    transport: {
      kind: "usb",
      read(_length, _timeoutMs, signal) {
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async write() {},
      close() {},
    },
  };
}

test("a wait for a device that is still booting lives through its re-enumeration: the silent adbd goes, the same device returns answering, and the wait reports it", { skip: !posix }, async () => {
  const booting = fakeUsbAdbDevice({ adbd: bootingAdbd(), serial: "cronos-booting" });
  const { browser, manager, info, close } = await page("lifecycle-booting", booting);
  try {
    const { id } = startWait(manager, info, { timeoutSeconds: 20 });
    await until(() => manager.status(id).state === "running");
    await sleep(300); // authenticating against an adbd that says nothing
    assert.equal(manager.status(id).state, "running");

    const booted = fakeUsbAdbDevice({ adbd: sandboxDevice({ props: { "ro.product.model": "Cronos" } }), serial: "cronos-booting" });
    browser.unplug(booting);
    await until(() => said(manager, id, /left the USB bus/));
    assert.ok(!["cancelled", "cancelling", "failed"].includes(manager.status(id).state), "the device re-enumerating while it boots does not end the wait");
    browser.plug(booted);
    const done = await finished(manager, id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.result.details.model, "Cronos");
  } finally {
    await close();
  }
});

test("a different device that appears while the wait is out is never adopted, opened or talked to, and the wait ends at its own deadline", { skip: !posix }, async () => {
  const first = fakeUsbAdbDevice({ adbd: sandboxDevice(), serial: "cronos-wait-id" });
  const { browser, manager, info, close } = await page("lifecycle-wait-identity", first);
  try {
    const { id } = startWait(manager, info, { state: "recovery", timeoutSeconds: 2 });
    await polling(manager, id);
    const stranger = fakeUsbAdbDevice({ adbd: sandboxDevice({ state: "recovery" }), serial: "someone-else" });
    browser.unplug(first);
    browser.plug(stranger);
    const done = await finished(manager, id);
    assert.equal(done.state, "failed");
    assert.match(done.error, /did not reach the recovery state within 2 s/);
    assert.equal(stranger.opened, false);
    assert.deepEqual(stranger.adbd.services, [], "nothing was asked of the other device");
  } finally {
    await close();
  }
});

test("a wait still ends when the user disconnects the device in Devices", { skip: !posix }, async () => {
  const device = fakeUsbAdbDevice({ adbd: sandboxDevice(), serial: "cronos-wait-forgotten" });
  const { connection, manager, info, close } = await page("lifecycle-wait-forgotten", device);
  try {
    const { id } = startWait(manager, info, { state: "recovery", timeoutSeconds: 30 });
    await polling(manager, id);
    await connection.disconnectDevice(info.id);
    assert.equal((await finished(manager, id)).state, "cancelled");
  } finally {
    await close();
  }
});

test("a wait is bounded by its deadline and by Cancel while WebUSB is still opening the device, and the device is free again once the late open ends", { skip: !posix }, async () => {
  const device = fakeUsbAdbDevice({ adbd: sandboxDevice(), serial: "cronos-slow-open" });
  const { manager, info, close } = await page("lifecycle-slow-open", device);
  try {
    // The browser takes its time opening the device: each scenario gets its own held open.
    const open = device.open;
    const slowOpen = () => {
      const gate = Promise.withResolvers();
      device.open = async () => { await gate.promise; await open.call(device); };
      return gate;
    };
    /** Nothing may keep the device reserved once a late open has ended: an ordinary operation works again. */
    const freeAgain = async () => {
      for (const end = Date.now() + 5000; Date.now() < end; await sleep(20)) {
        const attempt = manager.start({ deviceId: info.id, protocol: "adb", action: "detect" });
        const outcome = await finished(manager, attempt.id);
        if (outcome.state === "succeeded") return;
      }
      assert.fail("the device stayed reserved after the late open ended");
    };

    // Deadline: the one-second wait ends at about one second although the open has not.
    const slowDeadline = slowOpen();
    const began = Date.now();
    const first = startWait(manager, info, { timeoutSeconds: 1 });
    const failed = await finished(manager, first.id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /did not become available within 1 s: its USB connection was still being opened/);
    assert.ok(Date.now() - began < 3000, `took ${Date.now() - began} ms for a 1 s window`);
    assert.equal(device.opened, false, "the device was never opened while the wait was still looking");
    slowDeadline.resolve();
    await freeAgain();

    // Cancel: a long wait ends at once, with its acquisition still pending, instead of after the open.
    const slowCancel = slowOpen();
    const second = startWait(manager, info, { timeoutSeconds: 30 });
    await sleep(150);
    assert.equal(manager.status(second.id).events.some((event) => event.progress?.phase === "waiting"), false, "the acquisition has neither failed nor finished: it is still being opened");
    const cancelledAt = Date.now();
    manager.cancel(second.id);
    assert.equal((await finished(manager, second.id)).state, "cancelled");
    assert.ok(Date.now() - cancelledAt < 1500, `Cancel took ${Date.now() - cancelledAt} ms`);
    slowCancel.resolve();
    await freeAgain();
  } finally {
    await close();
  }
});

test("a cancelled push leaves a delayed USB claim reserved; a new read-only verify after regrant uses only the new handle", { skip: !posix }, async () => {
  const target = "/data/local/tmp/verify-after-regrant.bin";
  const original = Buffer.from("bytes already on the tablet");
  const proposed = Buffer.from("a write that must not be sent");
  const oldAdbd = sandboxDevice();
  writeFileSync(oldAdbd.real(target), original);
  const oldUsb = fakeUsbAdbDevice({ adbd: oldAdbd, serial: "cronos-claim-regrant" });
  const claimGate = Promise.withResolvers();
  const readGate = Promise.withResolvers();
  let oldClaims = 0, oldCloses = 0, oldWrites = 0, newCloses = 0, newReads = 0;
  const claim = oldUsb.claimInterface;
  oldUsb.claimInterface = async (number) => { oldClaims += 1; await claimGate.promise; await claim.call(oldUsb, number); };
  const oldClose = oldUsb.close;
  oldUsb.close = async () => { oldCloses += 1; await oldClose.call(oldUsb); };
  const oldWrite = oldUsb.transferOut;
  oldUsb.transferOut = async (...args) => { oldWrites += 1; return oldWrite.apply(oldUsb, args); };
  const { browser, connection, manager, info, close } = await page("lifecycle-claim-regrant", oldUsb, {
    ...artifacts,
    async getInput() { return new Blob([proposed]); },
  });
  try {
    const usbOptions = { deviceId: info.id, protocol: "adb", interfaceNumber: 0, alternateSetting: 0 };
    const push = manager.startUser({
      ...usbOptions, action: "push", target, fileId: "input", sha256: createHash("sha256").update(proposed).digest("hex"),
    });
    await until(() => oldClaims === 1, 2000);
    const acquisition = manager.status(push.id).lease;
    assert.equal(acquisition.step, "claiming interface 0");
    assert.equal(typeof acquisition.nativeGeneration, "number");

    manager.cancel(push.id);
    const cancelled = await until(() => manager.status(push.id).state === "cancelled" && manager.status(push.id), 1500);
    assert.equal(cancelled.lease.state, "quarantined");
    assert.equal(oldCloses, 0, "Cody has not called close during the browser's claim");
    await assert.rejects(connection.borrowHardwareTransport(info.id), (error) => {
      assert.equal(error.busy.held, "unresolved-claim");
      assert.match(error.message, /claiming interface 0.*grant it again/);
      return true;
    });

    browser.unplug(oldUsb);
    const newAdbd = sandboxDevice({ root: oldAdbd.root });
    const newUsb = fakeUsbAdbDevice({ adbd: newAdbd, serial: oldUsb.serialNumber });
    const newClose = newUsb.close, newRead = newUsb.transferIn;
    newUsb.close = async () => { newCloses += 1; await newClose.call(newUsb); };
    newUsb.transferIn = async (...args) => { newReads += 1; await readGate.promise; return newRead.apply(newUsb, args); };
    browser.plug(newUsb);
    assert.equal((await connection.requestDevice("usb")).id, info.id);

    const verify = manager.startUser({
      ...usbOptions, action: "verify", target, length: original.length, sha256: createHash("sha256").update(original).digest("hex"),
    });
    await until(() => newReads > 0, 2000);
    const verifyLease = manager.status(verify.id).lease;
    assert.ok(verifyLease.nativeGeneration > acquisition.nativeGeneration);
    assert.equal(manager.status(push.id).lease.state, "quarantined");
    claimGate.resolve();
    await until(() => manager.status(push.id).lease.state !== "quarantined", 2000);
    assert.equal(oldCloses, 1);
    assert.equal(newCloses, 0);
    assert.equal(newUsb.opened, true);

    readGate.resolve();
    const verified = await finished(manager, verify.id);
    assert.equal(verified.state, "succeeded", verified.error);
    assert.equal(verified.result.verified, true);
    assert.equal(oldClaims, 1, "Cody never tried the claim again");
    assert.equal(oldWrites, 0, "the abandoned push never submitted any USB data");
    assert.deepEqual(newAdbd.writes, [], "verify wrote no file or partition data");
    assert.deepEqual(readFileSync(oldAdbd.real(target)), original);
  } finally {
    claimGate.resolve();
    readGate.resolve();
    await close();
  }
});
