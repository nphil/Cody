import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { fakeDfuDevice } from "./dfu.test-helper.mjs";
import { patterned } from "./sparse.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { dfuFlasher } = await jiti.import("./dfu.ts");
const { DeviceOperationManager } = await jiti.import("./operations.ts");
const { flashOverrideChoices } = await jiti.import("./ui-model.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function context(device, input, over = {}) {
  const ctx = {
    signal: new AbortController().signal,
    transport: device.transport,
    input: input && new Blob([input]),
    confirmations: [],
    saves: [],
    progress() {},
    save: async (name, blob) => {
      ctx.saves.push({ name, blob });
      return `saved:${name}`;
    },
    confirm: async (risk) => {
      ctx.confirmations.push(risk);
      await ctx.onConfirm?.(risk);
    },
    ...over,
  };
  return ctx;
}

const flash = (ctx, extra = {}) => dfuFlasher.run({ protocol: "dfu", action: "flash", target: "firmware", offset: 0, options: { protectedOverride: "allow-unknown" }, ...extra }, ctx);
const exec = (ctx, command) => dfuFlasher.run({ protocol: "dfu", action: "exec", command }, ctx);
const ops = (device, op) => device.log.filter((entry) => entry.op === op);

test("a plain DFU 1.1 download backs up the device, asks, writes numbered blocks, ends with the zero-length block, and reads the image back", async () => {
  const current = patterned(150, 9);
  const image = patterned(200, 5);
  const device = fakeDfuDevice({ firmware: current });
  const ctx = context(device, image);
  ctx.onConfirm = async (risk) => {
    assert.equal(ops(device, "DNLOAD").length, 0, "nothing is written before approval");
    assert.deepEqual(Buffer.from(await ctx.saves[0].blob.arrayBuffer()), current, "the device's own image is escrowed first");
    assert.match(risk.backup, /Saved the device's current image \(150 bytes\) as saved:firmware\.preflash\.bin/);
  };
  const result = await flash(ctx);

  assert.equal(result.verified, true);
  assert.equal(result.sha256, sha256(image));
  assert.deepEqual(device.firmware, image);
  assert.deepEqual(ops(device, "DNLOAD").map(({ block, length }) => [block, length]), [[0, 64], [1, 64], [2, 64], [3, 8], [4, 0]], "blocks count from 0; the final zero-length block starts manifestation");
  const [risk] = ctx.confirmations;
  assert.equal(risk.action, "dfu download");
  assert.equal(risk.protectedOverride, "allow-unknown");
  assert.equal(risk.sha256, sha256(image));
  assert.equal(risk.length, 200);
  assert.match(risk.details, /no addresses/);
  assert.equal(result.details.manifestation, "idle");
  assert.equal(device.state, 2, "the device is left in dfuIDLE, not reset");
  assert.equal(device.resets.length, 0);
});

test("the unknown role of a plain DFU image needs the typed override, and a name that implies a role needs that role's override", async () => {
  const image = patterned(100, 1);
  const device = fakeDfuDevice();
  await assert.rejects(flash(context(device, image), { options: {} }), /allow-unknown/);
  assert.equal(device.log.length, 0, "refused before any control transfer");
  await assert.rejects(flash(context(device, image), { options: { protectedOverride: "allow-fuses" } }), /allow-unknown/);
  const boot = fakeDfuDevice({ alternateName: "Bootloader" });
  await assert.rejects(dfuFlasher.run({ protocol: "dfu", action: "flash", target: "Bootloader", offset: 0, options: { protectedOverride: "allow-unknown" } }, context(boot, image)), /allow-bootloader/);
  const ok = await dfuFlasher.run({ protocol: "dfu", action: "flash", target: "Bootloader", offset: 0, options: { protectedOverride: "allow-bootloader" } }, context(boot, image));
  assert.equal(ok.verified, true);
});

test("a user flash of a plain DFU alternate runs through the manager with the override the form offers, and is approved only by typing it", async () => {
  assert.ok(flashOverrideChoices("dfu").includes("allow-unknown"), "the Devices form offers the override this flash needs");
  const image = patterned(100, 5);
  const imageDigest = sha256(image);
  const until = async (check) => {
    for (const end = Date.now() + 5000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) {
      const value = check();
      if (value) return value;
    }
    throw new Error("Expected state was not reached");
  };
  const run = async (options) => {
    const device = fakeDfuDevice({ firmware: patterned(60, 9) });
    const manager = new DeviceOperationManager("dfu-form", { async borrowHardwareTransport() { return { transport: device.transport, async release() {} }; } }, { async getInput() { return new Blob([image]); }, async save() { return "saved"; } }, [dfuFlasher]);
    const { id } = manager.startUser({ deviceId: "usb-1", protocol: "dfu", action: "flash", target: "firmware", offset: 0, fileId: "image", sha256: imageDigest, ...(options ? { options } : {}) });
    const settled = await until(() => ["awaiting-confirmation", "failed", "succeeded"].includes(manager.status(id).state) && manager.status(id));
    return { device, manager, id, settled };
  };

  const refused = await run(undefined);
  assert.equal(refused.settled.state, "failed", "without the override the flash is refused before any approval is asked");
  assert.match(refused.settled.error, /allow-unknown/);
  assert.equal(refused.device.log.length, 0);

  const { device, manager, id, settled } = await run({ protectedOverride: "allow-unknown" });
  assert.equal(settled.state, "awaiting-confirmation");
  const { confirmation } = settled;
  assert.equal(confirmation.binding.protectedOverride, "allow-unknown");
  assert.throws(() => manager.confirm(id, confirmation.id, confirmation.binding, ""), /Type the exact protected-target override/);
  assert.throws(() => manager.confirm(id, confirmation.id, confirmation.binding, "allow-lk"), /Type the exact protected-target override/);
  assert.equal(ops(device, "DNLOAD").length, 0, "no byte is written until the exact override is typed");
  manager.confirm(id, confirmation.id, confirmation.binding, "allow-unknown");
  const done = await until(() => ["failed", "succeeded"].includes(manager.status(id).state) && manager.status(id));
  assert.equal(done.state, "succeeded", done.error);
  assert.deepEqual(device.firmware, image);
});

test("a device that cannot upload is written after a plain warning and reported UNVERIFIED", async () => {
  const device = fakeDfuDevice({ attributes: 0x05, firmware: patterned(50, 3) });
  const ctx = context(device, patterned(100, 2));
  const result = await flash(ctx);
  assert.match(ctx.confirmations[0].backup, /Backup unavailable: this DFU interface cannot upload/);
  assert.equal(result.verified, false);
  assert.match(result.summary, /UNVERIFIED/);
  assert.equal(ops(device, "UPLOAD").length, 0);
  assert.equal(device.firmware.length, 100);
});

test("a device that stalls an upload is recovered, the write still proceeds, and nothing is claimed verified", async () => {
  const device = fakeDfuDevice({ uploadStalls: true, firmware: patterned(50, 3) });
  const ctx = context(device, patterned(100, 2));
  const result = await flash(ctx);
  assert.match(ctx.confirmations[0].backup, /Backup unavailable/);
  assert.ok(ops(device, "CLRSTATUS").length >= 1, "dfuERROR is cleared before the download starts");
  assert.equal(result.verified, false);
  assert.match(result.details.verification, /would not upload after manifesting|Not verified/);
  assert.equal(device.firmware.length, 100, "the download completed even though no readback was possible");
  assert.equal(ops(device, "DNLOAD").at(-1).length, 0);
});

test("an image the device uploaded but Cody could not keep is a refusal to write, not a no-backup warning", async () => {
  const current = patterned(150, 9);
  const device = fakeDfuDevice({ firmware: current });
  const ctx = context(device, patterned(100, 2), { save: async () => { throw new Error("QuotaExceededError: browser storage is full"); } });
  await assert.rejects(flash(ctx), /browser storage is full/);
  assert.equal(ctx.confirmations.length, 0, "the user is never asked to approve a write whose backup could not be kept");
  assert.equal(ops(device, "UPLOAD").length > 0, true, "the image really was read from the device");
  assert.equal(ops(device, "DNLOAD").length, 0, "nothing was downloaded to the device");
  assert.deepEqual(device.firmware, current);

  // Only a genuine failure to read the device downgrades to the permitted warning.
  const stalled = fakeDfuDevice({ uploadStalls: true, firmware: current });
  const warned = context(stalled, patterned(100, 2), { save: async () => { throw new Error("the device never produced a backup to save"); } });
  await flash(warned);
  assert.match(warned.confirmations[0].backup, /Backup unavailable: the device would not upload/);
});

test("a manifestation-intolerant device restarts itself, so the write is UNVERIFIED and nothing is read afterwards", async () => {
  const device = fakeDfuDevice({ attributes: 0x03, manifestation: "wait-reset", firmware: patterned(50, 3) });
  const result = await flash(context(device, patterned(100, 2)));
  assert.equal(result.verified, false);
  assert.equal(result.details.manifestation, "restarting");
  assert.equal(device.log.filter((entry) => entry.op === "UPLOAD").length, 1, "only the pre-write backup read the device");
  assert.match(result.summary, /restarts itself/);
});

test("a device that leaves the bus as it manifests is a completed, unverified write rather than a failure", async () => {
  const device = fakeDfuDevice({ attributes: 0x03, manifestation: "vanish", firmware: patterned(50, 3) });
  const result = await flash(context(device, patterned(100, 2)));
  assert.equal(result.verified, false);
  assert.equal(result.details.manifestation, "disconnected");
  assert.equal(device.firmware.length, 100, "the whole image was stored before the device left the bus");
});

test("an image the device rejects during manifestation fails with its DFU status", async () => {
  const device = fakeDfuDevice({ rejectImage: true, firmware: patterned(50, 3) });
  await assert.rejects(flash(context(device, patterned(100, 2))), /errFIRMWARE/);
});

test("a readback that differs from the written image is an error that names the saved backup", async () => {
  const device = fakeDfuDevice({ corruptStored: true, firmware: patterned(50, 3) });
  await assert.rejects(flash(context(device, patterned(100, 2))), /readback SHA-256 does not match.*saved:firmware\.preflash\.bin.*Nothing was retried/s);
});

test("a block that stalls mid-download is never retried", async () => {
  const device = fakeDfuDevice({ firmware: patterned(50, 3) });
  const original = device.transport.controlOut;
  let writes = 0;
  device.transport.controlOut = async (setup, bytes) => {
    if (setup.request === 1 && bytes.length > 0 && (writes += 1) === 2) throw new Error("USB control write failed: stall.");
    return original(setup, bytes);
  };
  await assert.rejects(flash(context(device, patterned(200, 2))), /stall/);
  assert.equal(ops(device, "DNLOAD").filter((entry) => entry.length > 0).length, 1, "the failed block is not sent again");
});

test("things a plain DFU download cannot honour are refused before anything is read or written", async () => {
  const image = patterned(100, 2);
  const withSuffix = Buffer.concat([image, Buffer.from([0xff, 0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x55, 0x46, 0x44, 0x10, 0x11, 0x22, 0x33, 0x44])]);
  const cases = [
    [context(fakeDfuDevice(), withSuffix), {}, /DFU suffix/],
    [context(fakeDfuDevice(), image), { target: "other" }, /exact selected alternate/],
    [context(fakeDfuDevice(), image), { offset: 64 }, /no addresses/],
    [context(fakeDfuDevice(), image), { length: 99 }, /length must match/],
    [context(fakeDfuDevice({ transferSize: 1 }), patterned(70_000, 1)), {}, /needs more blocks than a DFU download can number/],
    [context(fakeDfuDevice({ attributes: 0x02 }), image), {}, /does not advertise DFU_DNLOAD/],
    [context(fakeDfuDevice(), undefined), {}, /non-empty raw binary/],
  ];
  for (const [ctx, extra, message] of cases) {
    await assert.rejects(flash(ctx, extra), message);
    assert.equal(ctx.confirmations.length, 0);
    assert.equal(ctx.saves.length, 0);
    assert.equal(ctx.transport.dfu.interfaceNumber, 2);
  }
});

test("declining the download leaves the device's image untouched", async () => {
  const current = patterned(50, 3);
  const device = fakeDfuDevice({ firmware: current });
  const ctx = context(device, patterned(100, 2), { confirm: async () => { throw new DOMException("Declined", "AbortError"); } });
  await assert.rejects(flash(ctx), /Declined/);
  assert.equal(ops(device, "DNLOAD").length, 0);
  assert.deepEqual(device.firmware, current);
});

const dfuse = () => fakeDfuDevice({ version: 0x011a, attributes: 0x0b, alternateName: "@Internal Flash /0x08000000/02*008Bg" });

test("DfuSe leave sets the address pointer, aborts to idle, then sends the zero-length download, after approval", async () => {
  const device = dfuse();
  const ctx = context(device);
  ctx.onConfirm = () => assert.equal(device.log.length, 0, "nothing is sent before approval");
  const result = await exec(ctx, "leave 0x08000008");
  assert.equal(ctx.confirmations[0].action, "dfu leave");
  assert.equal(ctx.confirmations[0].offset, 0x08000008);
  assert.match(ctx.confirmations[0].details, /leaves DFU|leave DFU/);
  const downloads = ops(device, "DNLOAD");
  assert.deepEqual(downloads.map(({ block, length }) => [block, length]), [[0, 5], [2, 0]]);
  assert.deepEqual([...downloads[0].data], [0x21, 0x08, 0x00, 0x00, 0x08]);
  assert.equal(device.pointer, 0x08000008);
  assert.equal(device.left, true);
  const order = device.log.map((entry) => entry.op);
  assert.ok(order.indexOf("ABORT") > order.indexOf("DNLOAD") && order.lastIndexOf("DNLOAD") > order.indexOf("ABORT"), "set address, abort, then the leaving download");
  assert.equal(result.verified, false);
});

test("leave refuses an address outside the map, plain DFU 1.1, and a decline sends nothing", async () => {
  const device = dfuse();
  await assert.rejects(exec(context(device), "leave 0x08000010"), /must lie inside the selected flash map/);
  await assert.rejects(exec(context(device), "leave 0x20000000"), /must lie inside/);
  await assert.rejects(exec(context(fakeDfuDevice()), "leave 0x08000000"), /DfuSe command.*use reset/);
  const declined = context(device, undefined, { confirm: async () => { throw new DOMException("Declined", "AbortError"); } });
  await assert.rejects(exec(declined, "leave 0x08000000"), /Declined/);
  assert.equal(device.log.length, 0);
});

test("a leave the device answers with an error, with something that is not a DFU status, or not at all while it stays attached, is a failure; only a device that left the bus may stay silent", async () => {
  const leave = (options, adjust) => {
    const device = fakeDfuDevice({ version: 0x011a, attributes: 0x0b, alternateName: "@Internal Flash /0x08000000/02*008Bg", ...options });
    adjust?.(device);
    return { device, run: exec(context(device), "leave 0x08000008") };
  };

  // The leave request is accepted, then GETSTATUS reports an explicit DFU error: the device did not leave.
  const refused = leave({ leaveReply: "error" });
  await assert.rejects(refused.run, /DFU status errTARGET in state dfuERROR/);
  assert.equal(refused.device.left, false, "the device is still in DFU");
  assert.equal(refused.device.state, 10);

  // A reply that is not a six-byte DFU status is the device answering wrongly.
  await assert.rejects(leave({ leaveReply: "malformed" }).run, /DFU_GETSTATUS must return 6 bytes, received 3/);

  // A failed read from a device that is still attached is not a departure; neither is one from a transport that cannot say.
  const stalled = leave({ leaveReply: "stalls" });
  await assert.rejects(stalled.run, /accepted the leave request but then failed to answer DFU_GETSTATUS while still connected: USB control read failed: stall/);
  assert.equal(stalled.device.transport.connected(), true);
  await assert.rejects(leave({ leaveReply: "stalls" }, (device) => { device.transport.connected = undefined; }).run, /while still connected/);

  // A device that left before it could answer is the one accepted silence, and it is still not claimed verified.
  const gone = leave({ leaveReply: "vanishes" });
  const left = await gone.run;
  assert.equal(left.verified, false);
  assert.equal(left.details.leftTheBusBeforeAnswering, true);
  assert.equal(gone.device.transport.connected(), false);

  // A device that answers (and then leaves) says what it answered.
  const answered = await leave({}).run;
  assert.equal(answered.verified, false);
  assert.deepEqual([answered.details.status, answered.details.state, answered.details.leftTheBusBeforeAnswering], ["OK", "dfuMANIFEST", false]);
});

test("reset asks first and resets once; the device vanishing is the usual result, but a rejected reset from a device that is still attached is an error", async () => {
  const device = fakeDfuDevice();
  const ctx = context(device);
  ctx.onConfirm = () => assert.equal(device.resets.length, 0);
  const result = await exec(ctx, "reset");
  assert.equal(ctx.confirmations[0].action, "dfu reset");
  assert.equal(device.resets.length, 1);
  assert.equal(result.verified, false);
  assert.match(result.details.note, /The USB reset completed/);

  const vanishing = fakeDfuDevice({ resetFails: true });
  assert.equal(vanishing.transport.connected(), true);
  const gone = await exec(context(vanishing), "reset");
  assert.equal(vanishing.transport.connected(), false, "the bridge can see that the device left the bus");
  assert.match(gone.details.note, /left the bus during the reset/);

  const stays = fakeDfuDevice({ resetFails: "stays" });
  await assert.rejects(exec(context(stays), "reset"), /USB reset failed while the device remained connected: .*Unable to reset the device/);
  assert.equal(stays.resets.length, 1, "the failed reset is reported, never retried");

  const unobservable = fakeDfuDevice({ resetFails: "stays" });
  unobservable.transport.connected = undefined;
  await assert.rejects(exec(context(unobservable), "reset"), /USB reset failed while the device remained connected/, "a transport that cannot say whether the device left does not get the benefit of the doubt");

  const noReset = fakeDfuDevice();
  noReset.transport.reset = undefined;
  await assert.rejects(exec(context(noReset), "reset"), /cannot issue a USB reset/);
});

test("exec still refuses everything but abort, clear_status, reset and leave", async () => {
  for (const command of ["mass-erase", "unprotect", "set_address 0x08000000", "leave", "leave x", "detach"]) {
    await assert.rejects(exec(context(dfuse()), command), /permits abort, clear_status, reset, and \(DfuSe\) leave ADDRESS/, command);
  }
  const result = await exec(context(fakeDfuDevice()), "abort");
  assert.equal(result.verified, true);
});
