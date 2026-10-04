import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fakeBrowser } from "./usb-adb.test-helper.mjs";
import { fakeUsbDfuDevice } from "./usb-dfu.test-helper.mjs";
import { fakeDfuDevice } from "./dfu.test-helper.mjs";

/**
 * The page's answer to "which device is attached under this grant right now", which an approval that waits asks at
 * the moment of sending. It is the shipped client over a fake browser, not a stub: the identity must be the full
 * vendor:product:serial of the granted device, and must vanish with the device.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceBridgeConnection, forgetDevice } = await jiti.import("./client.ts");

test("currentIdentity names the granted USB device by vendor, product and serial, and is gone when the device is", async () => {
  const browser = fakeBrowser();
  const usb = fakeUsbDfuDevice({ dfu: fakeDfuDevice({}), serial: "unit-one" });
  browser.plug(usb);
  const connection = new DeviceBridgeConnection("identity-session");
  try {
    const info = await connection.requestDevice("usb");
    const identity = connection.currentIdentity(info.id);
    assert.match(identity, /^usb:[0-9a-f]+:[0-9a-f]+:unit-one$/, "the full identity, serial included");
    assert.equal(connection.currentIdentity("usb-never-granted"), undefined, "an id this page never granted has no identity");
    assert.equal(connection.currentIdentity(info.id), identity, "asking does not change it");

    browser.unplug(usb);
    for (let turn = 0; turn < 50 && connection.currentIdentity(info.id) !== undefined; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(connection.currentIdentity(info.id), undefined, "a device that left the bus no longer answers to its identity");
    await forgetDevice(info.id);
  } finally {
    connection.destroy();
    browser.restore();
  }
});
