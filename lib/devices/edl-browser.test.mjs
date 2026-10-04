import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { buildDisk, fakeEdlDevice, loaderImage, SECTOR, sha256 } from "./edl.test-helper.mjs";
import { fakeBrowser } from "./usb-adb.test-helper.mjs";
import { fakeUsbEdlDevice } from "./usb-edl.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { edlFlasher } = await jiti.import("./edl.ts");
const { edlTimeouts } = await jiti.import("./edl-link.ts");
const { createPageOperationDelegate } = await jiti.import("./operations.ts");
const { DeviceBridgeConnection, forgetDevice } = await jiti.import("./client.ts");

Object.assign(edlTimeouts, { greetingQuiet: 20, nopQuiet: 20, firstContact: 80, probe: 200, greeting: 200, nop: 500, dataInactivity: 400 });

const LOADER = loaderImage(7000);
const DISK = buildDisk({ sectors: 2048, partitions: [{ name: "boot_a", sectors: 64 }, { name: "system_a", sectors: 300 }, { name: "userdata", sectors: 500 }] }).disk;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) {
    const value = check();
    if (value) return value;
  }
  throw new Error("Expected state was not reached");
};
const terminal = (manager, id) => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state);
const finished = (manager, id) => until(() => terminal(manager, id) && manager.status(id));
const said = (manager, id, pattern) => manager.status(id).output.some((row) => pattern.test(row.line));

/**
 * A page with one granted Qualcomm 9008 device, driven through the shipped
 * `DeviceBridgeConnection`: the registry, lease book, quiet-read gate and USB
 * lifecycle listeners are the real ones; only the browser and the device are fakes.
 */
async function edlPage(sessionId, deviceOptions = {}) {
  const browser = fakeBrowser();
  const inputs = new Map([["loader", new Blob([LOADER])]]);
  const saved = [];
  const keep = (name, bytes) => {
    const id = `saved-${saved.length + 1}`;
    saved.push({ id, name, bytes, sha256: sha256(bytes) });
    return id;
  };
  const artifacts = {
    async getInput(_session, fileId) { return inputs.get(fileId); },
    async save(_session, name, blob) { return keep(name, Buffer.from(await blob.arrayBuffer())); },
    async saveStream(_session, name, chunks, signal) {
      const parts = [];
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        parts.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(parts);
      return { fileId: keep(name, bytes), sha256: sha256(bytes), length: bytes.length };
    },
  };
  let usb;
  const edl = fakeEdlDevice({ loader: LOADER, disk: DISK, onReset: () => browser.unplug(usb), ...deviceOptions });
  usb = fakeUsbEdlDevice({ edl, serial: `edl-${sessionId}` });
  browser.plug(usb);
  const connection = new DeviceBridgeConnection(sessionId);
  connection.setOperationDelegate(createPageOperationDelegate(sessionId, connection, artifacts, [edlFlasher]));
  const info = await connection.requestDevice("usb");
  const manager = connection.operationManager;
  const base = { deviceId: info.id, protocol: "edl", interfaceNumber: 0, alternateSetting: 0 };
  const withLoader = { fileId: "loader", sha256: sha256(LOADER) };
  /** Starts an operation and approves each confirmation the way the panel's card does, until it ends. */
  const run = async (request, { approve = true } = {}) => {
    const { id } = manager.startUser({ ...base, ...request });
    const confirmations = [];
    for (const end = Date.now() + 10_000; Date.now() < end; await sleep(5)) {
      const snapshot = manager.status(id);
      if (terminal(manager, id)) return { id, confirmations, snapshot };
      if (snapshot.state === "awaiting-confirmation") {
        confirmations.push(snapshot.confirmation.binding);
        if (!approve) manager.cancel(id);
        else manager.confirm(id, snapshot.confirmation.id, snapshot.confirmation.binding);
      }
    }
    throw new Error("The operation never ended");
  };
  return {
    browser, connection, manager, info, edl, usb, saved, run, withLoader, base,
    async close() {
      await forgetDevice(info.id);
      connection.destroy();
      browser.restore();
    },
  };
}

test("a Qualcomm 9008 device is recognised, identified, given the loader after a confirmation, and a partition is read, all through the browser's real USB route", async () => {
  const page = await edlPage("edl-route-1");
  try {
    assert.deepEqual(page.info.protocolCandidates, [{ protocol: "edl", interfaceNumber: 0, alternateSetting: 0 }]);

    const identify = await page.run({ action: "detect" });
    assert.equal(identify.snapshot.state, "succeeded", identify.snapshot.error);
    assert.equal(identify.snapshot.result.details.sahara.serial, "1a2b3c4d");
    assert.equal(identify.confirmations.length, 0);

    const connect = await page.run({ action: "exec", command: "connect", ...page.withLoader });
    assert.equal(connect.snapshot.state, "succeeded", connect.snapshot.error);
    assert.equal(connect.confirmations.length, 1);
    assert.equal(connect.confirmations[0].action, "edl load programmer");
    assert.equal(connect.confirmations[0].sha256, sha256(LOADER));
    assert.equal(page.edl.loaderAccepted, true);

    const dump = await page.run({ action: "dump", target: "system_a" });
    assert.equal(dump.snapshot.state, "succeeded", dump.snapshot.error);
    const expected = DISK.subarray(98 * SECTOR, 398 * SECTOR);
    assert.equal(dump.snapshot.result.sha256, sha256(expected));
    const file = page.saved.find((entry) => entry.name === "edl-1a2b3c4d-system_a.bin");
    assert.ok(file.bytes.equals(expected));
    assert.equal(dump.confirmations.length, 1);
    assert.equal(dump.confirmations[0].target, "system_a");
    assert.ok(page.usb.opens >= 3, "each operation opened the device again");
    assert.deepEqual(page.edl.forbidden, []);
  } finally {
    await page.close();
  }
});

test("the same reads are exact when the programmer sends no zero-length packets, pads its answers, or sends huge transfers", async () => {
  for (const [name, options] of [
    ["no zero-length packets, one big transfer", { zlp: false, rawChunk: 1 << 20 }],
    ["newline padding after every document", { padding: "\n" }],
    ["the answer and the first data in one transfer", { coalesceRaw: true, zlp: false }],
  ]) {
    const page = await edlPage(`edl-route-variants-${name.length}`, { ...options });
    try {
      const connect = await page.run({ action: "exec", command: "connect", ...page.withLoader });
      assert.equal(connect.snapshot.state, "succeeded", `${name}: ${connect.snapshot.error}`);
      for (const target of ["boot_a", "userdata"]) {
        const dump = await page.run({ action: "dump", target });
        assert.equal(dump.snapshot.state, "succeeded", `${name}/${target}: ${dump.snapshot.error}`);
        const part = target === "boot_a" ? DISK.subarray(34 * SECTOR, 98 * SECTOR) : DISK.subarray(398 * SECTOR, 898 * SECTOR);
        assert.equal(dump.snapshot.result.sha256, sha256(part), `${name}/${target}`);
      }
      const whole = await page.run({ action: "dump", target: "user-area", options: { sectors: 2048 } });
      assert.equal(whole.snapshot.state, "succeeded", `${name}: ${whole.snapshot.error}`);
      assert.equal(whole.snapshot.result.sha256, sha256(DISK), name);
    } finally {
      await page.close();
    }
  }
});

test("declining at the confirmation (Cancel) ends the operation with the loader unsent and the partition unread", async () => {
  const page = await edlPage("edl-route-decline");
  try {
    const refused = await page.run({ action: "exec", command: "connect", ...page.withLoader }, { approve: false });
    assert.equal(refused.snapshot.state, "cancelled");
    assert.equal(page.edl.uploadedLoader, undefined);
    assert.equal(page.edl.commands.length, 0);
  } finally {
    await page.close();
  }
});

test("cancelling a read in progress closes the device, saves no file, and the next operation opens it again and carries on", async () => {
  const page = await edlPage("edl-route-cancel", { readFault: { stallAfter: 20_000, atRead: 3, once: true } });
  try {
    await page.run({ action: "exec", command: "connect", ...page.withLoader });
    const { id } = page.manager.startUser({ ...page.base, action: "dump", target: "system_a" });
    const confirming = await until(() => page.manager.status(id).state === "awaiting-confirmation" && page.manager.status(id));
    page.manager.confirm(id, confirming.confirmation.id, confirming.confirmation.binding);
    await until(() => (page.manager.status(id).progress?.completed ?? 0) > 0);
    const opensBefore = page.usb.opens;
    page.manager.cancel(id);
    const done = await finished(page.manager, id);
    assert.equal(done.state, "cancelled");
    assert.equal(page.saved.some((entry) => entry.name.includes("system_a")), false, "no file for a cancelled read");
    // The programmer was left with nothing more to say (it stalled on purpose); the next operation re-opens the device and works.
    const gpt = await page.run({ action: "exec", command: "printgpt" });
    assert.equal(gpt.snapshot.state, "succeeded", gpt.snapshot.error);
    assert.ok(page.usb.opens > opensBefore, "the device was opened again");
    assert.equal(gpt.snapshot.result.details.partitions.length, 3);
  } finally {
    await page.close();
  }
});

test("unplugging the device in the middle of a read ends the operation, says why, and keeps no file", async () => {
  const page = await edlPage("edl-route-unplug", { readFault: { stallAfter: 20_000, atRead: 3, once: true } });
  try {
    await page.run({ action: "exec", command: "connect", ...page.withLoader });
    const { id } = page.manager.startUser({ ...page.base, action: "dump", target: "system_a" });
    const confirming = await until(() => page.manager.status(id).state === "awaiting-confirmation" && page.manager.status(id));
    page.manager.confirm(id, confirming.confirmation.id, confirming.confirmation.binding);
    await until(() => (page.manager.status(id).progress?.completed ?? 0) > 0);
    page.browser.unplug(page.usb);
    const done = await finished(page.manager, id);
    assert.equal(done.state, "cancelled");
    assert.ok(said(page.manager, id, /The device left the USB bus/), "the operation says the device went, not that the user cancelled");
    assert.equal(page.saved.some((entry) => entry.name.includes("system_a")), false);
  } finally {
    await page.close();
  }
});

test("a confirmed reset is a completed operation even though the device leaves the bus, because the departure was announced", async () => {
  const page = await edlPage("edl-route-reset", { mode: "firehose" });
  try {
    const reset = await page.run({ action: "exec", command: "reset" });
    assert.equal(reset.snapshot.state, "succeeded", reset.snapshot.error);
    assert.equal(reset.snapshot.result.verified, false);
    assert.equal(reset.confirmations[0].action, "edl reset");
    assert.equal(page.edl.resets, 1);
    assert.ok(said(page.manager, reset.id, /left the USB bus, as expected/));
  } finally {
    await page.close();
  }
});

test("a device that leaves the bus while an operation did not announce it is a cancelled operation, not a hang", async () => {
  const page = await edlPage("edl-route-early-unplug");
  try {
    const { id } = page.manager.startUser({ ...page.base, action: "exec", command: "connect", ...page.withLoader });
    await until(() => page.manager.status(id).state === "awaiting-confirmation");
    page.browser.unplug(page.usb);
    const done = await finished(page.manager, id);
    assert.equal(done.state, "cancelled");
    assert.equal(page.edl.uploadedLoader, undefined, "the loader was never sent");
  } finally {
    await page.close();
  }
});
