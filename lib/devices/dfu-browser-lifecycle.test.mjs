import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { fakeBrowser } from "./usb-adb.test-helper.mjs";
import { fakeUsbDfuDevice } from "./usb-dfu.test-helper.mjs";
import { fakeDfuDevice } from "./dfu.test-helper.mjs";
import { patterned } from "./sparse.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { dfuFlasher } = await jiti.import("./dfu.ts");
const { createPageOperationDelegate } = await jiti.import("./operations.ts");
const { DeviceBridgeConnection, forgetDevice } = await jiti.import("./client.ts");

const IMAGE = patterned(200, 5);
const DIGEST = createHash("sha256").update(IMAGE).digest("hex");
const DFUSE = { version: 0x011a, attributes: 0x0b, alternateName: "@Internal Flash /0x08000000/02*008Bg" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) {
    const value = check();
    if (value) return value;
  }
  throw new Error("Expected state was not reached");
};
const finished = (manager, id) => until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));
const said = (manager, id, pattern) => manager.status(id).output.some((row) => pattern.test(row.line));

/**
 * A page with one granted DFU device, driven through `DeviceBridgeConnection`: the registry, the
 * lease book, the USB lifecycle listeners and the operation manager are the shipped ones. When
 * the device's state machine says it leaves the bus, WebUSB fails the transfer in flight and the
 * device stops being open at once; the browser's `disconnect` event comes with it (`now`) or
 * `lateMs` after it (`late`), which is how it can trail an operation that has already seen the
 * failed transfer.
 */
async function dfuPage(sessionId, modelOptions = {}, { when = "now", lateMs = 40 } = {}) {
  const browser = fakeBrowser();
  const saves = [];
  const artifacts = { async getInput() { return new Blob([IMAGE]); }, async save(_session, name) { saves.push(name); return `saved:${name}`; } };
  let usb;
  const leave = () => browser.unplug(usb);
  const model = fakeDfuDevice({ ...modelOptions, onDeparture: () => { if (when === "now") leave(); else { usb.leaveBus(); setTimeout(leave, lateMs); } } });
  usb = fakeUsbDfuDevice({ dfu: model, serial: `dfu-${sessionId}` });
  browser.plug(usb);
  const connection = new DeviceBridgeConnection(sessionId);
  connection.setOperationDelegate(createPageOperationDelegate(sessionId, connection, artifacts, [dfuFlasher]));
  const info = await connection.requestDevice("usb");
  const manager = connection.operationManager;
  const device = { deviceId: info.id, protocol: "dfu", interfaceNumber: 0, alternateSetting: 0 };
  const approve = async (id, typed) => {
    const waiting = await until(() => manager.status(id).state === "awaiting-confirmation" && manager.status(id));
    manager.confirm(id, waiting.confirmation.id, waiting.confirmation.binding, typed);
  };
  return {
    browser, connection, manager, info, model, usb, saves,
    /** A flash of the image to the selected alternate, approved the way the form approves it: by typing the override. */
    async flash() {
      const { id } = manager.startUser({ ...device, action: "flash", target: model.alternateName, offset: 0, fileId: "image", sha256: DIGEST, options: { protectedOverride: "allow-unknown" } });
      await approve(id, "allow-unknown");
      return id;
    },
    async exec(command) {
      const { id } = manager.startUser({ ...device, action: "exec", command });
      await approve(id);
      return id;
    },
    /** Makes releasing the device take a while, as closing a real USB device can. */
    slowRelease(ms) {
      const close = usb.close;
      usb.close = async () => { await sleep(ms); await close.call(usb); };
    },
    async close() {
      await forgetDevice(info.id);
      connection.destroy();
      browser.restore();
    },
  };
}

const timings = [
  ["the disconnect event arrives before the failing transfer reports", { when: "now" }],
  ["the disconnect event trails the operation, arriving while it is finishing", { when: "late", lateMs: 40 }],
];

test("a plain DFU download whose device leaves the bus as it manifests is a completed, unverified write on the real route, not a cancelled one", async () => {
  for (const [name, timing] of timings) {
    const page = await dfuPage(`dfu-manifest-${timing.when}`, { attributes: 0x03, manifestation: "vanish", firmware: patterned(50, 3) }, timing);
    try {
      if (timing.when === "late") page.slowRelease(150);
      const id = await page.flash();
      const done = await finished(page.manager, id);
      assert.equal(done.state, "succeeded", `${name}: ${done.error}`);
      assert.equal(done.result.verified, false, name);
      assert.equal(done.result.details.manifestation, "disconnected", name);
      assert.equal(page.model.firmware.length, IMAGE.length, `${name}: the whole image was stored before the device left`);
      assert.ok(said(page.manager, id, /left the USB bus, as expected/), `${name}: the operation was told, and went on`);
    } finally {
      await page.close();
    }
  }
});

test("a DfuSe leave and a USB reset live through the re-enumeration they cause, whichever way the browser reports it", async () => {
  for (const [name, timing] of timings) {
    const leaving = await dfuPage(`dfu-leave-${timing.when}`, DFUSE, timing);
    try {
      if (timing.when === "late") leaving.slowRelease(150);
      const id = await leaving.exec("leave 0x08000008");
      const done = await finished(leaving.manager, id);
      assert.equal(done.state, "succeeded", `leave, ${name}: ${done.error}`);
      assert.equal(done.result.verified, false);
      assert.equal(done.result.details.address, 0x08000008);
      assert.ok(said(leaving.manager, id, /left the USB bus, as expected/), `leave, ${name}`);
    } finally {
      await leaving.close();
    }

    const silent = await dfuPage(`dfu-leave-silent-${timing.when}`, { ...DFUSE, leaveReply: "vanishes" }, timing);
    try {
      const id = await silent.exec("leave 0x08000008");
      const done = await finished(silent.manager, id);
      assert.equal(done.state, "succeeded", `leave that left before answering, ${name}: ${done.error}`);
      assert.equal(done.result.details.leftTheBusBeforeAnswering, true);
    } finally {
      await silent.close();
    }

    for (const [how, options] of [["a reset that completes", { resetLeaves: true }], ["a reset the browser reports as failed because the device vanished", { resetFails: true }]]) {
      const resetting = await dfuPage(`dfu-reset-${timing.when}-${Object.keys(options)[0]}`, options, timing);
      try {
        if (timing.when === "late") resetting.slowRelease(150);
        const id = await resetting.exec("reset");
        const done = await finished(resetting.manager, id);
        assert.equal(done.state, "succeeded", `${how}, ${name}: ${done.error}`);
        assert.equal(done.result.verified, false);
        assert.equal(resetting.model.resets.length, 1, "the reset was sent once and never retried");
        assert.ok(said(resetting.manager, id, /left the USB bus, as expected/), `${how}, ${name}`);
      } finally {
        await resetting.close();
      }
    }
  }
});

test("only the departure the operation asked for is expected: an unplug before it, during the download or the readback of an idle device, or the user's own Disconnect still cancels", async () => {
  // Unplugged while the approval is still pending: nothing was asked of the device yet.
  const early = await dfuPage("dfu-unplug-early", { firmware: patterned(50, 3) });
  try {
    const { id } = early.manager.startUser({ deviceId: early.info.id, protocol: "dfu", interfaceNumber: 0, alternateSetting: 0, action: "flash", target: early.model.alternateName, offset: 0, fileId: "image", sha256: DIGEST, options: { protectedOverride: "allow-unknown" } });
    await until(() => early.manager.status(id).state === "awaiting-confirmation");
    early.browser.unplug(early.usb);
    assert.equal((await finished(early.manager, id)).state, "cancelled");
    assert.equal(early.model.log.filter((entry) => entry.op === "DNLOAD").length, 0, "no byte was sent");
  } finally {
    await early.close();
  }

  // Unplugged part-way through the download blocks: that is not manifestation, so it is not expected.
  const mid = await dfuPage("dfu-unplug-mid", { firmware: patterned(50, 3) });
  try {
    const controlOut = mid.model.transport.controlOut;
    let blocks = 0;
    mid.model.transport.controlOut = async (setup, bytes) => {
      if (setup.request === 1 && bytes.length > 0 && (blocks += 1) === 2) mid.browser.unplug(mid.usb);
      return controlOut(setup, bytes);
    };
    const id = await mid.flash();
    const done = await finished(mid.manager, id);
    assert.equal(done.state, "cancelled", done.error);
    assert.equal(said(mid.manager, id, /as expected/), false);
  } finally {
    await mid.close();
  }

  // The user disconnecting the device while it is manifesting ends the operation even inside the window.
  const user = await dfuPage("dfu-user-disconnect", { firmware: patterned(50, 3) });
  try {
    const gate = Promise.withResolvers();
    const controlIn = user.model.transport.controlIn;
    let held = false;
    user.model.transport.controlIn = async (setup, length) => {
      if (setup.request === 3 && user.model.state === 6 && !held) {
        held = true;
        await gate.promise;
      }
      return controlIn(setup, length);
    };
    const id = await user.flash();
    await until(() => held);
    await user.connection.disconnectDevice(user.info.id);
    assert.equal((await finished(user.manager, id)).state, "cancelled");
    gate.resolve();
  } finally {
    await user.close();
  }

  // A manifestation-tolerant device that came back to idle ended the departure window: an unplug during the readback is not expected.
  const idle = await dfuPage("dfu-unplug-readback", { firmware: patterned(50, 3) });
  try {
    const controlIn = idle.model.transport.controlIn;
    let unplugged = false;
    idle.model.transport.controlIn = async (setup, length) => {
      if (setup.request === 2 && !unplugged && idle.model.log.some((entry) => entry.op === "DNLOAD")) {
        unplugged = true;
        idle.browser.unplug(idle.usb);
      }
      return controlIn(setup, length);
    };
    const id = await idle.flash();
    const done = await finished(idle.manager, id);
    assert.equal(unplugged, true, "the unplug happened after the image was written, during the readback");
    assert.equal(done.state, "cancelled", done.error);
    assert.equal(said(idle.manager, id, /as expected/), false);
  } finally {
    await idle.close();
  }
});
