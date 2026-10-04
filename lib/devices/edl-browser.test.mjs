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
// The same, with a partition on the protected list (sectors 398-437).
const PERSIST_DISK = buildDisk({ sectors: 2048, partitions: [{ name: "boot_a", sectors: 64 }, { name: "system_a", sectors: 300 }, { name: "persist", sectors: 40 }, { name: "userdata", sectors: 500 }] }).disk;
const patterned = (length, seed) => Buffer.from(Array.from({ length }, (_, index) => (index * 31 + seed + (index >> 8)) & 0xff));
const WRONG_TEXT = "Type the exact protected-target override shown in the panel.";

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

/** What a page's session holds: the files the operations saved, and the files the user chose. Two pages can share one, as one browser session does across a device being re-plugged. */
function sessionStore() {
  return { saved: [], inputs: new Map([["loader", new Blob([LOADER])]]) };
}

/**
 * A page with one granted Qualcomm 9008 device, driven through the shipped
 * `DeviceBridgeConnection`: the registry, lease book, quiet-read gate and USB
 * lifecycle listeners are the real ones; only the browser and the device are fakes.
 */
async function edlPage(sessionId, deviceOptions = {}, store = sessionStore()) {
  const browser = fakeBrowser();
  const { saved, inputs } = store;
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
    async findBySha256(_session, digest) {
      const found = [...saved].reverse().find((entry) => entry.sha256 === digest.toLowerCase());
      return found ? new Blob([found.bytes]) : undefined;
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
  /**
   * Starts an operation and answers each confirmation the way the panel's card does, until it ends. The card passes the typed
   * text to `manager.confirm`; `tries(binding)` is the sequence of texts a user types (the first accepted one ends it), by
   * default exactly the override the card asks for. When none is accepted the user gives up and presses Cancel.
   */
  const run = async (request, { approve = true, tries } = {}) => {
    const { id } = manager.startUser({ ...base, ...request });
    const confirmations = [];
    const rejections = [];
    const answered = new Set();
    for (const end = Date.now() + 10_000; Date.now() < end; await sleep(5)) {
      const snapshot = manager.status(id);
      if (terminal(manager, id)) return { id, confirmations, rejections, snapshot };
      if (snapshot.state === "awaiting-confirmation" && !answered.has(snapshot.confirmation.id)) {
        answered.add(snapshot.confirmation.id);
        const { binding } = snapshot.confirmation;
        confirmations.push(binding);
        if (!approve) {
          manager.cancel(id);
          continue;
        }
        let accepted = false;
        for (const typed of tries?.(binding) ?? [binding.protectedOverride]) {
          try {
            manager.confirm(id, snapshot.confirmation.id, binding, typed);
            accepted = true;
            break;
          } catch (error) {
            rejections.push({ typed, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!accepted) manager.cancel(id);
      }
    }
    throw new Error("The operation never ended");
  };
  /** Puts a file in the session the way choosing it in Files & backups does. */
  const addInput = (fileId, bytes) => {
    inputs.set(fileId, new Blob([bytes]));
    return { fileId, sha256: sha256(bytes) };
  };
  return {
    browser, connection, manager, info, edl, usb, saved, store, run, addInput, withLoader, base,
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

// ---- changing the device through the real route: the typed approvals the operation manager enforces -----------------------

test("a flash through the real route: an ordinary partition needs no typed text, a protected one needs exactly write:<name>, and the manager rejects anything else", async () => {
  const page = await edlPage("edl-route-flash", { disk: PERSIST_DISK });
  try {
    const connect = await page.run({ action: "exec", command: "connect", ...page.withLoader });
    assert.equal(connect.snapshot.state, "succeeded", connect.snapshot.error);

    const bootImage = patterned(64 * SECTOR, 3);
    const boot = await page.run({ action: "flash", target: "boot_a", ...page.addInput("boot-image", bootImage) });
    assert.equal(boot.snapshot.state, "succeeded", boot.snapshot.error);
    assert.deepEqual(boot.rejections, []);
    assert.equal(boot.confirmations.length, 1);
    assert.equal(boot.confirmations[0].action, "edl flash");
    assert.equal(boot.confirmations[0].target, "boot_a");
    assert.equal(boot.confirmations[0].sha256, sha256(bootImage), "the card is bound to the request's own digest");
    assert.equal(boot.confirmations[0].protectedOverride, undefined);
    assert.equal(boot.snapshot.result.verified, true);
    assert.ok(page.edl.disk.subarray(34 * SECTOR, 98 * SECTOR).equals(bootImage));

    const persistImage = patterned(40 * SECTOR, 5);
    const chosen = page.addInput("persist-image", persistImage);
    const before = Buffer.from(page.edl.disk);
    const writesBefore = page.edl.writes.length;

    // Typing nothing, or something else, never gets past the manager; at last the user presses Cancel and the partition is left alone.
    const wrong = await page.run({ action: "flash", target: "persist", ...chosen }, { tries: () => [undefined, "", "write:Persist", "write:persist ", "write:boot_a"] });
    assert.equal(wrong.snapshot.state, "cancelled");
    assert.equal(wrong.confirmations[0].protectedOverride, "write:persist");
    assert.deepEqual(wrong.rejections.map((entry) => entry.message), Array(5).fill(WRONG_TEXT));
    assert.equal(page.edl.writes.length, writesBefore, "nothing was programmed");
    assert.ok(page.edl.disk.equals(before));
    assert.ok(page.saved.some((entry) => entry.name === "edl-1a2b3c4d-persist.preflash.bin"), "the partition was saved before the question was asked");

    const right = await page.run({ action: "flash", target: "persist", ...chosen }, { tries: () => [undefined, "write:persist"] });
    assert.equal(right.snapshot.state, "succeeded", right.snapshot.error);
    assert.equal(right.rejections.length, 1);
    assert.equal(right.confirmations[0].target, "persist");
    assert.equal(right.confirmations[0].sha256, chosen.sha256);
    assert.equal(right.confirmations[0].programSha256, chosen.sha256);
    assert.equal(right.snapshot.result.verified, true);
    assert.ok(page.edl.disk.subarray(398 * SECTOR, 438 * SECTOR).equals(persistImage));
    assert.deepEqual(page.edl.forbidden, []);
  } finally {
    await page.close();
  }
});

test("an erase through the real route asks for the same typed override for a protected partition, and reports what it reads as afterwards", async () => {
  const page = await edlPage("edl-route-erase", { disk: PERSIST_DISK, mode: "firehose" });
  try {
    const erase = await page.run({ action: "exec", command: "erase", target: "persist" }, { tries: () => ["write:boot_a", "write:persist"] });
    assert.equal(erase.snapshot.state, "succeeded", erase.snapshot.error);
    assert.equal(erase.rejections.length, 1);
    assert.equal(erase.confirmations[0].action, "edl erase");
    assert.equal(erase.confirmations[0].target, "persist");
    assert.equal(erase.confirmations[0].protectedOverride, "write:persist");
    assert.match(erase.snapshot.result.summary, /Erased persist: it now reads as all zero bytes/);
    assert.ok(page.edl.disk.subarray(398 * SECTOR, 438 * SECTOR).every((byte) => byte === 0));
    assert.ok(page.edl.disk.subarray(34 * SECTOR, 98 * SECTOR).equals(PERSIST_DISK.subarray(34 * SECTOR, 98 * SECTOR)), "the neighbour is untouched");
  } finally {
    await page.close();
  }
});

test("the boot drive change through the real route needs set-bootable:<N> for that very N, is reported UNVERIFIED, and a declined one sends nothing", async () => {
  const page = await edlPage("edl-route-bootdrive", { mode: "firehose" });
  try {
    const set = await page.run({ action: "exec", command: "setbootablestoragedrive", target: "3" }, { tries: () => ["set-bootable:2", "set-bootable", "set-bootable:3"] });
    assert.equal(set.snapshot.state, "succeeded", set.snapshot.error);
    assert.deepEqual(set.rejections.map((entry) => entry.message), [WRONG_TEXT, WRONG_TEXT]);
    assert.equal(set.confirmations[0].action, "edl setbootablestoragedrive");
    assert.equal(set.confirmations[0].target, "3");
    assert.equal(set.confirmations[0].protectedOverride, "set-bootable:3");
    assert.match(set.confirmations[0].backup, /^Backup unavailable/);
    assert.equal(set.snapshot.result.verified, false);
    assert.match(set.snapshot.result.summary, /^UNVERIFIED:/);
    assert.equal(page.edl.bootableDrive, 3);

    const declined = await page.run({ action: "exec", command: "setbootablestoragedrive", target: "5" }, { approve: false });
    assert.equal(declined.snapshot.state, "cancelled");
    assert.equal(page.edl.bootableDrive, 3, "the declined change was never sent");
  } finally {
    await page.close();
  }
});

/** A backup set taken through a page of its own, which then goes away; returns the manifest's SHA-256. */
async function backupThroughRoute(store, sessionId) {
  const page = await edlPage(sessionId, {}, store);
  try {
    const backup = await page.run({ action: "exec", command: "backup", ...page.withLoader });
    assert.equal(backup.snapshot.state, "succeeded", backup.snapshot.error);
    assert.deepEqual(backup.confirmations.map((entry) => entry.action), ["edl load programmer", "edl backup"]);
    return backup.snapshot.result.sha256;
  } finally {
    await page.close();
  }
}

test("a backup set and its restore go through the real route: the set is found in the session by digest, the restore asks for restore:<sha8>, and anything else typed is rejected", async () => {
  const store = sessionStore();
  const manifestSha = await backupThroughRoute(store, "edl-route-backup");
  const short = manifestSha.slice(0, 8);

  const damaged = Buffer.from(DISK);
  damaged.fill(0xee, 34 * SECTOR, 98 * SECTOR);
  const page = await edlPage("edl-route-restore", { disk: damaged }, store);
  try {
    const restore = await page.run({ action: "exec", command: "restore", ...page.withLoader, options: { manifestSha256: manifestSha } }, {
      tries: (binding) => (binding.action === "edl restore" ? [undefined, "restore:", `restore:${short.slice(0, 7)}`, `restore:${manifestSha.slice(0, 9)}`, binding.protectedOverride] : undefined),
    });
    assert.equal(restore.snapshot.state, "succeeded", restore.snapshot.error);
    assert.deepEqual(restore.confirmations.map((entry) => entry.action), ["edl load programmer", "edl restore"]);
    assert.equal(restore.rejections.length, 4);
    assert.ok(restore.rejections.every((entry) => entry.message === WRONG_TEXT));
    const risk = restore.confirmations[1];
    assert.equal(risk.protectedOverride, `restore:${short}`);
    assert.equal(risk.sha256, sha256(LOADER), "the only digest a confirmation may carry is the request's own: the loader's");
    assert.match(risk.target, /^disk [0-9A-F-]{36}$/);
    assert.equal(restore.snapshot.result.verified, true);
    assert.ok(page.edl.disk.equals(DISK), "the unit is exactly what the set holds");
    assert.deepEqual(page.edl.forbidden, []);
  } finally {
    await page.close();
  }
});

test("a restore whose approval is never typed correctly leaves the unit untouched with the copies of what it would have overwritten", async () => {
  const store = sessionStore();
  const manifestSha = await backupThroughRoute(store, "edl-route-backup-2");
  const damaged = Buffer.from(DISK);
  damaged.fill(0xee, 34 * SECTOR, 98 * SECTOR);
  const page = await edlPage("edl-route-restore-giveup", { disk: damaged }, store);
  try {
    const restore = await page.run({ action: "exec", command: "restore", ...page.withLoader, options: { manifestSha256: manifestSha } }, {
      tries: (binding) => (binding.action === "edl restore" ? [undefined, "restore"] : undefined),
    });
    assert.equal(restore.snapshot.state, "cancelled");
    assert.equal(restore.rejections.length, 2);
    assert.deepEqual(page.edl.writes, []);
    assert.ok(page.edl.disk.equals(damaged));
    assert.ok(store.saved.some((entry) => entry.name.includes("-restore-") && entry.name.endsWith("-p0-boot_a.pre.bin")), "the copy of boot_a was saved first");
  } finally {
    await page.close();
  }
});
