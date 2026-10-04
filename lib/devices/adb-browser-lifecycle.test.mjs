import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { sandboxDevice } from "./adb-device.test-helper.mjs";
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

/**
 * A page with one granted ADB device, driven through `DeviceBridgeConnection`:
 * the registry, the lease book, the USB lifecycle listeners and the operation
 * manager are the shipped ones. Only the browser's `navigator.usb` and the
 * silicon behind the bulk endpoints are emulated.
 */
async function page(sessionId, device) {
  const browser = fakeBrowser();
  browser.plug(device);
  const connection = new DeviceBridgeConnection(sessionId);
  connection.setOperationDelegate(createPageOperationDelegate(sessionId, connection, artifacts, [adbFlasher]));
  const info = await connection.requestDevice("usb");
  const manager = connection.operationManager;
  return {
    browser,
    connection,
    manager,
    info,
    async startRoot(timeoutSeconds) {
      manager.setShellAccess(info.id, true);
      const { id } = manager.start({ deviceId: info.id, protocol: "adb", action: "exec", options: { kind: "root", timeoutSeconds } });
      const waiting = await until(() => manager.status(id).state === "awaiting-confirmation" && manager.status(id));
      return { id, confirm: () => manager.confirm(id, waiting.confirmation.id, waiting.confirmation.binding) };
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
    root.confirm();
    await until(() => said(manager, root.id, /restarting adbd as root/));

    // The device leaves the bus the way it really does: the browser fires `disconnect` at the page's own listener.
    const second = fakeUsbAdbDevice({ adbd: sandboxDevice({ props: { "service.adb.root": "1" } }), serial: "cronos-restart" });
    assert.notEqual(second, first);
    browser.unplug(first);
    await until(() => said(manager, root.id, /left the USB bus, as expected/));
    assert.ok(!["cancelled", "cancelling"].includes(manager.status(root.id).state), "the operation that asked for the restart is not cancelled");
    assert.equal(manager.hasShellAccess(info.id), false, "the disconnect still revokes the shell grant");

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

test("a disconnect nobody announced still cancels the operation on the real route, and shell access goes with it", { skip: !posix }, async () => {
  const device = fakeUsbAdbDevice({ adbd: sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } }), serial: "cronos-unplugged" });
  const { browser, manager, info, startRoot, close } = await page("lifecycle-unplugged", device);
  try {
    const root = await startRoot(10);
    // Still waiting for the user's approval: no restart was announced, so unplugging is just unplugging.
    browser.unplug(device);
    const done = await finished(manager, root.id);
    assert.equal(done.state, "cancelled");
    assert.equal(manager.hasShellAccess(info.id), false);
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
    root.confirm();
    await until(() => said(manager, root.id, /restarting adbd as root/));
    const stranger = fakeUsbAdbDevice({ adbd: sandboxDevice({ props: { "service.adb.root": "1" } }), serial: "someone-else" });
    browser.unplug(first);
    browser.plug(stranger);
    const done = await finished(manager, root.id);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.result.verified, false);
    assert.match(done.result.summary, /could not reconnect to check it \(The same USB device did not reappear within 1 seconds/);
    assert.equal(stranger.opened, false);
    assert.deepEqual(stranger.adbd.services, [], "nothing was asked of the other device");
  } finally {
    await close();
  }
});
