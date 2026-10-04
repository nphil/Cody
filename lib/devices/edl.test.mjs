import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { buildDisk, edlContext, fakeEdlDevice, loaderImage, movePrimaryBackupPointer, patchGptHeader, SECTOR, sha256 } from "./edl.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { edlFlasher, parseEdlCommand } = await jiti.import("./edl.ts");
const { edlTimeouts, EdlError } = await jiti.import("./edl-link.ts");

// The emulator answers within the same tick, so every quiet window and first-contact wait can be short.
Object.assign(edlTimeouts, { greetingQuiet: 20, nopQuiet: 20, firstContact: 60, probe: 150, greeting: 200, nop: 400 });

const LOADER = loaderImage(9000);
const PARTITIONS = [
  { name: "boot_a", sectors: 64 },
  { name: "system_a", sectors: 300 },
  { name: "persist", sectors: 40 },
  { name: "userdata", sectors: 500 },
];
const built = (overrides = {}) => buildDisk({ sectors: 2048, partitions: PARTITIONS, ...overrides });
const device = (options = {}) => fakeEdlDevice({ loader: LOADER, disk: built().disk, ...options });
const loaderOf = (bytes = LOADER) => new Blob([bytes]);

const run = (hardware, request, options = {}) => {
  const env = edlContext(hardware, options);
  const promise = edlFlasher.run({ protocol: "edl", ...request }, env.context);
  return { promise, ...env };
};
const finish = async (hardware, request, options) => {
  const operation = run(hardware, request, options);
  return { result: await operation.promise, ...operation };
};
const exec = (hardware, command, options = {}) => finish(hardware, { action: "exec", command }, options);
const withLoader = { input: loaderOf() };
const said = (output, pattern) => output.some((line) => pattern.test(line));
const readsOf = (hardware) => hardware.commands.filter((entry) => entry.tag === "read").map((entry) => ({ start: Number(entry.attributes.start_sector), sectors: Number(entry.attributes.num_partition_sectors) }));

async function withTimeouts(overrides, body) {
  const saved = { ...edlTimeouts };
  Object.assign(edlTimeouts, overrides);
  try {
    return await body();
  } finally {
    Object.assign(edlTimeouts, saved);
  }
}

test("EDL declares the actions the panel and the tools can use", () => {
  assert.equal(edlFlasher.protocol, "edl");
  assert.deepEqual([...edlFlasher.actions], ["detect", "dump", "exec", "flash"]);
});

// ---- identify ----------------------------------------------------------------

test("identify reads the boot ROM's serial number, hardware id and key hash and asks for nothing", async () => {
  const hardware = device();
  const { result, confirmations, output } = await finish(hardware, { action: "detect" });
  assert.equal(result.details.mode, "sahara");
  assert.equal(result.details.sahara.serial, "1a2b3c4d");
  assert.equal(result.details.sahara.hardwareId, "000460e100020000");
  assert.equal(result.details.sahara.msmId, "0460e1");
  assert.equal(result.details.sahara.pkHash.length, 64);
  assert.match(result.summary, /chip serial 0x1a2b3c4d/);
  assert.match(result.summary, /waiting for a loader/);
  assert.equal(confirmations.length, 0, "reading an identity needs no approval");
  assert.ok(said(output, /Chip serial number: 0x1a2b3c4d/));
  assert.equal(hardware.loaderAccepted, false);
  assert.equal(hardware.mode, "sahara", "the device is left waiting for a loader");
});

test("identify of a device that already runs a programmer says so, and says what it cannot tell", async () => {
  const hardware = device({ mode: "firehose" });
  const { result, output } = await finish(hardware, { action: "detect" });
  assert.equal(result.details.mode, "firehose");
  assert.equal(result.details.programmer.chipSerial, "0x1a2b3c4d");
  assert.match(result.summary, /Firehose programmer is running/);
  assert.ok(said(output, /boot ROM's identity.*cannot be read/));
});

test("a device that never answers is reported with what to do, not left hanging", async () => {
  await withTimeouts({ firstContact: 30, probe: 60, nopQuiet: 10 }, async () => {
    const hardware = device({ mode: "firehose", nopAnswers: "silent", greeting: false });
    await assert.rejects(edlFlasher.run({ protocol: "edl", action: "detect" }, edlContext(hardware).context), (error) => error instanceof EdlError && /Unplug it and put it into EDL mode again/.test(error.message));
  });
});

test("a device that sends a stray byte and then nothing but empty packets ends the operation with advice instead of holding the device for ever", async () => {
  await withTimeouts({ firstContact: 60, probe: 100, nopQuiet: 10 }, async () => {
    let reads = 0;
    // The flood stops by itself after far more reads than any limit allows, so an unbounded drain would carry on and fail some other way.
    const transport = { kind: "usb", async read() { reads += 1; return reads === 1 ? Uint8Array.of(0x41, 0x42, 0x43) : reads < 100_000 ? new Uint8Array(0) : null; }, async write() {}, connected: () => true };
    await assert.rejects(
      edlFlasher.run({ protocol: "edl", action: "detect" }, edlContext({ transport }).context),
      (error) => error instanceof EdlError && /empty packets and never goes quiet.*Unplug it and put it into EDL mode again/s.test(error.message),
    );
    assert.ok(reads < 20_000, `${reads} reads: the recovery gave up`);
  });
});

// ---- loader upload -----------------------------------------------------------

test("connect sends the chosen loader only after the user confirms it, bound to the file's digest", async () => {
  const hardware = device();
  const { result, confirmations, output, progress } = await exec(hardware, "connect", withLoader);
  assert.equal(confirmations.length, 1);
  const [risk] = confirmations;
  assert.equal(risk.action, "edl load programmer");
  assert.equal(risk.sha256, sha256(LOADER));
  assert.equal(risk.target, "programmer");
  assert.match(risk.backup, /RAM/);
  assert.match(risk.details, /9000-byte file/);
  assert.match(risk.details, /chip serial 1a2b3c4d/);
  assert.match(risk.details, /ELF/);
  assert.equal(hardware.loaderAccepted, true);
  assert.ok(hardware.uploadedLoader.equals(LOADER));
  assert.ok(hardware.configured);
  assert.match(result.summary, /Programmer ready/);
  assert.equal(result.details.loaderSent, sha256(LOADER));
  assert.equal(result.details.storage.totalSectors, 2048);
  assert.equal(result.details.identity.serial, "1a2b3c4d");
  assert.ok(said(output, /The boot ROM accepted the loader/));
  assert.ok(progress.some((event) => event.phase === "loader" && event.completed === event.total));
  assert.deepEqual(hardware.forbidden, []);
});

test("declining the loader confirmation sends no loader and writes nothing", async () => {
  const hardware = device();
  const operation = run(hardware, { action: "exec", command: "connect" }, { ...withLoader, approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(hardware.uploadedLoader, undefined);
  assert.equal(hardware.saharaLog.filter((entry) => entry.command === 0x02 && entry.mode === 0).length, 0, "the image-transfer handshake was never started");
  assert.equal(hardware.commands.length, 0);
});

test("a device waiting for a loader that was not chosen is told so, and nothing is sent to it", async () => {
  const hardware = device();
  await assert.rejects(run(hardware, { action: "exec", command: "connect" }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /needs a programmer \(loader\) file/.test(error.message));
  assert.equal(hardware.loaderAccepted, false);
  assert.equal(hardware.saharaLog.filter((entry) => entry.command === 0x02 && entry.mode === 0).length, 0);
});

test("a loader for another device is refused by the boot ROM, reported in its words, and the device is still in the boot ROM", async () => {
  const hardware = device();
  const { promise, confirmations, output } = run(hardware, { action: "exec", command: "connect" }, { input: loaderOf(loaderImage(9000, 9)) });
  await assert.rejects(promise, (error) => error.name === "SaharaRejection" && /did not accept the loader/.test(error.message) && /was not run/.test(error.message));
  assert.equal(confirmations.length, 1, "it was the user's confirmed choice");
  assert.equal(hardware.mode, "sahara");
  assert.ok(said(output, /Chip serial number/), "the identity read before the upload is kept in the log");
});

test("an empty loader file is refused before anything is sent; a truncated one is called truncated; one of the right size that is not a loader is refused by the boot ROM", async () => {
  const empty = device();
  await assert.rejects(run(empty, { action: "exec", command: "connect" }, { input: new Blob([]) }).promise, /loader file is empty/);
  assert.equal(empty.saharaLog.length, 0, "the boot ROM was not even spoken to");
  const truncated = device();
  const short = run(truncated, { action: "exec", command: "connect" }, { input: loaderOf(LOADER.subarray(0, 640)) });
  await assert.rejects(short.promise, (error) => error instanceof EdlError && error.kind === "rejected" && /only 640 bytes long.*complete loader file/.test(error.message));
  assert.equal(truncated.loaderAccepted, false);
  const hardware = device();
  const wrong = run(hardware, { action: "exec", command: "connect" }, { input: loaderOf(Buffer.from("not a programmer".repeat(563)).subarray(0, 9000)) });
  await assert.rejects(wrong.promise, /did not accept the loader/);
  assert.match(wrong.confirmations[0].details, /WARNING: the file does not start like an ELF image/);
});

test("a programmer that is already running is used as it is, and the chosen loader is not sent again", async () => {
  const hardware = device({ mode: "firehose" });
  const { result, confirmations, output } = await exec(hardware, "connect", withLoader);
  assert.equal(confirmations.length, 0);
  assert.equal(result.details.loaderSent, null);
  assert.equal(hardware.saharaLog.length, 0);
  assert.ok(said(output, /already running, so the chosen loader file was not sent/));
});

test("an identify leaves the boot ROM's HELLO unread, so a connect right after finds an ordinary device", async () => {
  const hardware = device();
  const identified = await finish(hardware, { action: "detect" });
  assert.equal(identified.result.details.sahara.backInLoaderState, null);
  assert.match(identified.result.summary, /asked to go back to waiting for a loader/);
  assert.equal(hardware.pendingTransfers, 1, "the HELLO is still there to be read");
  const { result, output } = await exec(hardware, "connect", withLoader);
  assert.match(result.summary, /Programmer ready/);
  assert.equal(hardware.loaderAccepted, true);
  assert.equal(said(output, /start over/), false, "no recovery was needed");
});

test("a boot ROM that does not re-offer its HELLO after an identify is asked to start over, then the connect goes on", async () => {
  const hardware = device({ helloAfterSwitch: "silent" });
  await finish(hardware, { action: "detect" });
  assert.equal(hardware.pendingTransfers, 0);
  const { result, output } = await exec(hardware, "connect", withLoader);
  assert.match(result.summary, /Programmer ready/);
  assert.equal(hardware.loaderAccepted, true);
  assert.ok(said(output, /asking it to start over/));
  assert.ok(said(output, /answered with binary data/), "its refusal of the probe is what said so");
});

test("a boot ROM that cannot start over is reported with the way out, not retried forever", async () => {
  await withTimeouts({ firstContact: 40, probe: 80, packet: 80 }, async () => {
    const hardware = device({ helloAfterSwitch: "silent", resetStateMachine: false });
    await finish(hardware, { action: "detect" });
    await assert.rejects(run(hardware, { action: "exec", command: "connect" }, withLoader).promise, /Unplug it and put it into EDL mode again/);
    assert.equal(hardware.loaderAccepted, false);
  });
});

// ---- partition table ---------------------------------------------------------

test("printgpt lists the partitions and saves the primary table and the real backup table at the end of the disk", async () => {
  const hardware = device();
  const { result, output, saved } = await exec(hardware, "printgpt", withLoader);
  assert.equal(result.verified, true);
  assert.deepEqual(result.details.partitions.map((part) => part.name), ["boot_a", "system_a", "persist", "userdata"]);
  assert.equal(result.details.diskGuid, "12345678-ABCD-4321-9876-0123456789AB");
  assert.equal(result.details.measuredSectors, 2048);
  assert.equal(result.details.gptSpanSectors, 2048);
  assert.equal(result.details.backup.read, true);
  assert.ok(said(output, /system_a\s+sectors 98-397/));
  const primary = saved.find((file) => file.name === "edl-1a2b3c4d-gpt-primary.bin");
  const backup = saved.find((file) => file.name === "edl-1a2b3c4d-gpt-backup.bin");
  assert.ok(primary && backup, "both tables are saved");
  const disk = hardware.disk;
  const entrySectors = 32;
  assert.equal(primary.sha256, sha256(disk.subarray(0, (2 + entrySectors) * SECTOR)), "the primary region is sectors 0 to the end of its entry array, byte for byte");
  assert.equal(backup.sha256, sha256(disk.subarray((2048 - 1 - entrySectors) * SECTOR, 2048 * SECTOR)), "the backup region is its entry array and header at the end of the disk, byte for byte");
  assert.equal(result.details.files.primary.sha256, primary.sha256);
});

test("printgpt says plainly when the backup table is missing instead of calling the primary region a backup", async () => {
  const hardware = device({ disk: built({ badBackup: true }).disk });
  const { result, output, saved } = await exec(hardware, "printgpt", withLoader);
  assert.equal(result.details.backup.read, false);
  assert.match(result.details.backup.problem, /signature/);
  assert.ok(said(output, /backup table at the end of the disk could not be read/));
  assert.equal(saved.some((file) => /gpt-backup/.test(file.name)), false);
  assert.match(result.summary, /backup table not readable/);
});

test("a damaged primary table is reported as damaged, with the table still shown", async () => {
  const hardware = device({ disk: built({ badPrimaryCrc: true }).disk });
  const { result, output } = await exec(hardware, "printgpt", withLoader);
  assert.equal(result.verified, false);
  assert.match(result.summary, /DAMAGED/);
  assert.ok(said(output, /header's CRC does not match/));
});

// ---- span check --------------------------------------------------------------

test("the span check passes when table, capacity and the end of the disk agree", async () => {
  const hardware = device();
  const { result, output } = await exec(hardware, "check", withLoader);
  assert.equal(result.verified, true);
  assert.match(result.summary, /Span check passed.*2048 sectors.*allowed/s);
  assert.equal(output.filter((line) => /^PASS /.test(line)).length, 9);
  assert.ok(readsOf(hardware).some((entry) => entry.start === 2047 && entry.sectors === 1), "the last sector was really read");
});

test("the span check fails with the numbers when the chip is bigger than the table says", async () => {
  const hardware = device({ totalBlocks: 4096, disk: Buffer.concat([built().disk, Buffer.alloc(2048 * SECTOR, 0x33)]) });
  const { result, output } = await exec(hardware, "check", withLoader);
  assert.equal(result.verified, false);
  assert.match(result.summary, /Span check FAILED/);
  assert.match(result.summary, /spans 2048 sectors.*reports 4096/s);
  assert.ok(said(output, /^FAIL .*not in the last sector \(4095\)/));
  assert.equal(result.details.check.ok, false);
  assert.equal(result.details.check.measuredSectors, 4096);
  assert.equal(result.details.check.gptSpanSectors, 2048);
});

test("the backup table is read and saved from the last sector the programmer reports, whatever the primary header says about where it is", async () => {
  const tailRegion = (disk) => disk.subarray((2048 - 1 - 32) * SECTOR, 2048 * SECTOR);
  for (const [name, pointer, interiorCopy] of [["beyond the end of the disk", 5000, false], ["at an older copy inside the disk", 1999, true]]) {
    const disk = movePrimaryBackupPointer(built().disk, pointer, { interiorCopy });
    const hardware = device({ mode: "firehose", disk });
    const { result, output, saved } = await exec(hardware, "printgpt");
    assert.equal(result.details.backup.read, true, `${name}: the real backup is found`);
    assert.equal(result.details.backup.atLba, 2047, name);
    assert.equal(result.details.backup.firstLba, 2015, name);
    assert.equal(result.details.backup.sectors, 33, name);
    assert.deepEqual({ lba: result.details.backup.pointer.lba, agrees: result.details.backup.pointer.agrees }, { lba: pointer, agrees: false }, name);
    const file = saved.find((entry) => entry.name === "edl-1a2b3c4d-gpt-backup.bin");
    assert.ok(file, `${name}: a backup file was saved`);
    assert.equal(file.sha256, sha256(tailRegion(disk)), `${name}: the saved file is the table at the end of the disk, not the one the primary header names`);
    assert.ok(said(output, new RegExp(`primary header puts its backup table at sector ${pointer}, not at the last sector \\(2047\\)`)), name);
    assert.ok(said(output, /Saved the backup table at the end of the disk \(sectors 2015-2047\)/), name);
    assert.equal(interiorCopy ? said(output, /holds a GPT header too/) : said(output, /does not exist on this disk/), true, `${name}: what is at the pointer is described`);

    const checked = await exec(hardware, "check");
    assert.equal(checked.result.verified, false, `${name}: the primary header's pointer is still a failure`);
    assert.ok(said(checked.output, /^PASS .*valid backup partition table header sits in the last sector \(2047\)/), `${name}: the real backup is judged on its own`);
    assert.ok(said(checked.output, new RegExp(`^FAIL .*puts the backup at sector ${pointer}, not in the last sector \\(2047\\)`)), name);
    await assert.rejects(run(hardware, { action: "dump", target: "user-area", options: { sectors: 2048 } }, { approve: async () => undefined }).promise, (error) => error instanceof EdlError && /span check failed/.test(error.message), name);
  }
});

test("a damaged backup table at the end of the disk is reported as damaged, with what was read still saved", async () => {
  const disk = built().disk;
  disk.writeUInt32LE(0xdeadbeef, 2047 * SECTOR + 16);
  const { result, output, saved } = await exec(device({ mode: "firehose", disk }), "printgpt");
  assert.equal(result.details.backup.read, true);
  assert.ok(said(output, /backup table at the end of the disk is damaged/));
  assert.ok(saved.some((entry) => entry.name === "edl-1a2b3c4d-gpt-backup.bin"));
  assert.match(result.summary, /backup table DAMAGED/);
});

test("the span check fails when the programmer will not read the last sector it reports", async () => {
  const hardware = device({ totalBlocks: 2048 + 100 });
  const { result } = await exec(hardware, "check", withLoader);
  assert.equal(result.verified, false);
  assert.match(result.summary, /reports 2148/);
});

test("a table with an entry that runs past the end of the disk fails the span check and no whole-area read is offered", async () => {
  // Both tables are intact and agree with each other and with the chip (2048 sectors), but one entry runs through sector 3000.
  const disk = buildDisk({ sectors: 2048, partitions: [{ name: "boot_a", sectors: 64 }, { name: "overrun", first: 200, sectors: 2801 }] }).disk;
  const hardware = device({ mode: "firehose", disk });
  const { result, output } = await exec(hardware, "check");
  assert.equal(result.verified, false);
  assert.match(result.summary, /Span check FAILED/);
  assert.ok(said(output, /^FAIL .*"overrun" \(sectors 200-3000\).*outside the usable range/));
  assert.equal(result.details.check.ok, false);
  await assert.rejects(run(hardware, { action: "dump", target: "user-area", options: { sectors: 2048 } }, { approve: async () => undefined }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /span check failed.*"overrun"/s.test(error.message));
  assert.ok(readsOf(hardware).every((entry) => entry.sectors < 100), "no whole-area read was issued");
});

// ---- partition read ----------------------------------------------------------

test("a partition is read into a session file whose SHA-256 is that of the device's bytes, after a confirmation bound to its exact range", async () => {
  const hardware = device();
  const { result, confirmations, saved, progress } = await finish(hardware, { action: "dump", target: "system_a" }, withLoader);
  const expected = hardware.disk.subarray(98 * SECTOR, 398 * SECTOR);
  assert.equal(result.sha256, sha256(expected));
  assert.equal(result.verified, true);
  const file = saved.find((entry) => entry.name === "edl-1a2b3c4d-system_a.bin");
  assert.ok(file.bytes.equals(expected), "every byte, in order");
  assert.equal(result.fileId, file.id);
  assert.equal(confirmations.length, 2, "one for the loader, one for the read");
  const read = confirmations[1];
  assert.equal(read.action, "edl dump");
  assert.equal(read.target, "system_a");
  assert.equal(read.offset, 0);
  assert.equal(read.length, 300 * SECTOR);
  assert.match(read.details, /sectors 98-397 \(300 sectors, 153600 bytes\)/);
  assert.match(read.backup, /read-only/);
  assert.deepEqual(progress.filter((event) => event.phase === "read").at(-1), { phase: "read", completed: 153600, total: 153600, message: "Reading edl-1a2b3c4d-system_a.bin" });
  assert.deepEqual(hardware.forbidden, []);
});

test("a byte range inside a partition is read from the right sectors", async () => {
  const hardware = device({ mode: "firehose" });
  const { result, saved } = await finish(hardware, { action: "dump", target: "system_a", offset: 10 * SECTOR, length: 20 * SECTOR });
  assert.equal(result.sha256, sha256(hardware.disk.subarray(108 * SECTOR, 128 * SECTOR)));
  assert.equal(saved[0].name, "edl-1a2b3c4d-system_a-5120+10240.bin");
});

test("bad partition requests are refused before anything is read from it", async () => {
  const hardware = device({ mode: "firehose", disk: built({ sectors: 2048 }).disk });
  const refused = async (request, pattern) => {
    const before = readsOf(hardware).length;
    await assert.rejects(run(hardware, { action: "dump", ...request }).promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), JSON.stringify(request));
    const reads = readsOf(hardware).slice(before);
    assert.ok(reads.every((entry) => entry.start < 40), `${JSON.stringify(request)}: only the partition table was read`);
  };
  await refused({ target: "nope" }, /no partition named "nope".*boot_a, system_a, persist, userdata/);
  await refused({ target: "BOOT_A" }, /no partition named/);
  await refused({ target: "system_a", offset: 100 }, /multiples of the 512-byte sector/);
  await refused({ target: "system_a", offset: 0, length: 301 * SECTOR }, /does not lie within system_a/);
  await refused({ target: "system_a", offset: 300 * SECTOR, length: SECTOR }, /does not lie within/);
  await refused({ target: "", }, /exact name of a GPT partition/);
  await refused({ target: "x".repeat(100) }, /exact name of a GPT partition/);
});

test("a partition name two entries share, a damaged table and a partition beyond the chip all stop the read", async () => {
  const twice = device({ mode: "firehose", disk: buildDisk({ sectors: 2048, partitions: [{ name: "dup", sectors: 8 }, { name: "dup", sectors: 8 }] }).disk });
  await assert.rejects(run(twice, { action: "dump", target: "dup" }).promise, /Two partitions are named "dup"/);
  const damaged = device({ mode: "firehose", disk: built({ badPrimaryCrc: true }).disk });
  await assert.rejects(run(damaged, { action: "dump", target: "boot_a" }).promise, /partition table is damaged/);
  const beyond = device({ mode: "firehose", totalBlocks: 300, disk: built().disk });
  await assert.rejects(run(beyond, { action: "dump", target: "userdata" }).promise, /beyond the 300 sectors the programmer reports/);
});

test("declining the read confirmation reads nothing from the partition", async () => {
  const hardware = device({ mode: "firehose" });
  const operation = run(hardware, { action: "dump", target: "system_a" }, { approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.ok(readsOf(hardware).every((entry) => entry.start < 40));
  assert.equal(operation.saved.length, 0);
});

// ---- whole user area ---------------------------------------------------------

test("the whole user area is read only with the verified sector count, after the check passed in the same operation", async () => {
  const hardware = device({ mode: "firehose", rawChunk: 1 << 16 });
  const { result, confirmations, saved } = await finish(hardware, { action: "dump", target: "user-area", options: { sectors: 2048 } });
  assert.equal(result.sha256, sha256(hardware.disk));
  assert.equal(result.details.sectors, 2048);
  assert.match(result.summary, /does not include the eMMC boot areas or RPMB/);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].target, "user-area");
  assert.equal(confirmations[0].offset, 0);
  assert.equal(confirmations[0].length, 2048 * SECTOR);
  assert.match(confirmations[0].details, /ALL 2048 sectors/);
  assert.match(confirmations[0].details, /span check passed/);
  assert.match(confirmations[0].details, /does not include the eMMC boot areas or RPMB/);
  assert.equal(saved[0].name, "edl-1a2b3c4d-user-area.bin");
  assert.ok(saved[0].bytes.equals(hardware.disk));
});

test("a whole-area read without a sector count, or with another one, is refused and says which count is verified", async () => {
  const hardware = device({ mode: "firehose" });
  await assert.rejects(run(hardware, { action: "dump", target: "user-area" }).promise, /pass options\.sectors = 2048/);
  await assert.rejects(run(hardware, { action: "dump", target: "user-area", options: { sectors: 2047 } }).promise, /options\.sectors is 2047, but the verified user area is 2048/);
  await assert.rejects(run(hardware, { action: "dump", target: "user-area", options: { sectors: "2048" } }).promise, /pass options\.sectors = 2048/);
  await assert.rejects(run(hardware, { action: "dump", target: "user-area", options: { sectors: 2048 }, offset: 0 }).promise, /only from options\.sectors/);
  assert.ok(readsOf(hardware).every((entry) => entry.sectors < 100), "no large read was ever issued");
});

test("a span mismatch stops the whole-area read before it starts, however the count is chosen", async () => {
  const grown = device({ mode: "firehose", totalBlocks: 4096, disk: Buffer.concat([built().disk, Buffer.alloc(2048 * SECTOR, 0x33)]) });
  for (const sectors of [2048, 4096]) {
    await assert.rejects(run(grown, { action: "dump", target: "user-area", options: { sectors } }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /span check failed.*spans 2048 sectors.*reports 4096.*Nothing was read/s.test(error.message));
  }
  assert.ok(readsOf(grown).every((entry) => entry.sectors < 100), "no whole-area read was issued");
  const brokenBackup = device({ mode: "firehose", disk: built({ badBackup: true }).disk });
  await assert.rejects(run(brokenBackup, { action: "dump", target: "user-area", options: { sectors: 2048 } }).promise, /span check failed/);
  assert.ok(readsOf(brokenBackup).every((entry) => entry.sectors < 100));
});

test("declining the whole-area confirmation reads nothing", async () => {
  const hardware = device({ mode: "firehose" });
  const operation = run(hardware, { action: "dump", target: "user-area", options: { sectors: 2048 } }, { approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.ok(readsOf(hardware).every((entry) => entry.sectors < 100));
});

// ---- cancel, device loss, recovery -------------------------------------------

test("cancelling a read stops it, saves nothing, and the next operation finds the device usable", async () => {
  const hardware = device({ mode: "firehose", disk: buildDisk({ sectors: 4096, partitions: [{ name: "big", sectors: 3000 }] }).disk });
  const controller = new AbortController();
  // The cancel lands while the first chunks of the partition are arriving.
  const onProgress = (event) => { if (event.phase === "read" && event.completed > 0) controller.abort(); };
  const operation = run(hardware, { action: "dump", target: "big" }, { signal: controller.signal, approve: async () => undefined, onProgress });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(operation.saved.length, 0, "a cancelled read leaves no file");
  assert.ok(hardware.pendingTransfers > 0, "the device still had data in flight");
  const { result, output } = await exec(hardware, "printgpt");
  assert.equal(result.details.partitions.length, 1);
  assert.ok(said(output, /discarding it and looking again/), "the stale data was thrown away, not mistaken for an answer");
});

test("a device that goes away in the middle of a read ends the operation with an honest error and no file", async () => {
  const hardware = device({ mode: "firehose", readFault: { leaveAfter: 5000, atRead: 3 } });
  const { promise, saved, output } = run(hardware, { action: "dump", target: "system_a" }, { approve: async () => undefined });
  await assert.rejects(promise, (error) => error instanceof EdlError && /left the USB bus/.test(error.message));
  assert.equal(saved.length, 0);
  assert.ok(said(output, /The device left the USB bus/));
});

test("a device that stops sending in the middle of a read is reported as stalled with the byte count, not hung on", async () => {
  await withTimeouts({ dataInactivity: 120 }, async () => {
    const hardware = device({ mode: "firehose", readFault: { stallAfter: 3000, atRead: 3 } });
    const { promise, saved } = run(hardware, { action: "dump", target: "system_a" }, { approve: async () => undefined });
    await assert.rejects(promise, (error) => error instanceof EdlError && error.kind === "timeout" && /still to come/.test(error.message));
    assert.equal(saved.length, 0);
  });
});

test("the programmer's refusal of a read is passed on in its words", async () => {
  const hardware = device({ mode: "firehose", readFault: { nak: true, atRead: 3 } });
  await assert.rejects(run(hardware, { action: "dump", target: "system_a" }, { approve: async () => undefined }).promise, (error) => error.name === "FirehoseRejection" && /Failed to read from the device/.test(error.message));
});

test("a partition read that comes up short, with the closing answer standing in for the missing bytes, is not reported as verified and saves nothing", async () => {
  // Short by 39 bytes the stream swallows the closing answer's XML declaration as sector data and the rest still parses as an answer.
  const hardware = device({ mode: "firehose", readFault: { truncate: 39, atRead: 3 } });
  const { promise, saved, output } = run(hardware, { action: "dump", target: "system_a" }, { approve: async () => undefined });
  await assert.rejects(promise, (error) => error instanceof EdlError && /did not end where the programmer ended a transfer/.test(error.message));
  assert.equal(saved.length, 0, "no file for a read that was short");
  assert.equal(said(output, /Saved \d+ bytes/), false);
});

// ---- leaving EDL ---------------------------------------------------------------

test("reset asks first, and a declined reset sends nothing", async () => {
  const hardware = device({ mode: "firehose" });
  const operation = run(hardware, { action: "exec", command: "reset" }, { approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(operation.confirmations.length, 1);
  assert.equal(operation.confirmations[0].action, "edl reset");
  assert.equal(hardware.commands.length, 0);
  assert.equal(hardware.resets, 0);
});

test("a confirmed reset of a running programmer announces the departure and sends only power reset", async () => {
  const hardware = device({ mode: "firehose" });
  let announced = 0;
  const operation = edlContext(hardware);
  operation.context.expectDeviceRestart = () => { announced += 1; return () => undefined; };
  const result = await edlFlasher.run({ protocol: "edl", action: "exec", command: "reset" }, operation.context);
  assert.equal(announced, 1);
  assert.equal(hardware.resets, 1);
  assert.deepEqual(hardware.commands.map((entry) => entry.tag), ["power"], "a programmer that is already talking needs no probe, and reset is the only command sent");
  assert.equal(hardware.commands[0].attributes.value, "reset");
  assert.equal(result.verified, false);
  assert.match(result.summary, /cannot see what it boots into/);
});

test("a confirmed reset of a device still in the boot ROM uses the boot ROM's own reset", async () => {
  const hardware = device();
  const result = (await exec(hardware, "reset")).result;
  assert.equal(hardware.resets, 1);
  assert.equal(result.details.via, "sahara");
  assert.equal(hardware.onBus, false, "the device left the bus");
});

// ---- the commands Cody offers ---------------------------------------------------

test("EDL commands are a short fixed list, and anything else is refused before the device sees a byte", async () => {
  assert.deepEqual(["connect", "load", "getstorageinfo", "printgpt", "gpt", "check", "span", "reset", "reboot", "EDL connect", "  Connect ", "erase", "EDL Erase", "backup", "Restore", "setbootablestoragedrive", "EDL SetBootableStorageDrive"].map((word) => parseEdlCommand(word)), ["connect", "connect", "connect", "printgpt", "printgpt", "check", "check", "reset", "reset", "connect", "connect", "erase", "erase", "backup", "restore", "setbootablestoragedrive", "setbootablestoragedrive"]);
  for (const command of [
    "program boot_a", "erase boot_a", "patch", "setbootablestoragedrive 1", "power edl", "power off", "reset-to-edl", "flash boot_a", "write boot_a", "w boot_a x.bin", "rf disk.bin", "rl dir", "rs 0 10 x", "peek 0 4", "poke 0 1",
    "xml <data><erase /></data>", "<data><program /></data>", "connect; erase", "connect erase", "", undefined, "constructor", "__proto__", "toString",
  ]) {
    assert.throws(() => parseEdlCommand(command), (error) => error instanceof EdlError && error.kind === "refused" && /not an EDL command Cody offers/.test(error.message), String(command));
    const hardware = device({ mode: "firehose" });
    await assert.rejects(run(hardware, { action: "exec", command }).promise, (error) => error instanceof EdlError && error.kind === "refused");
    assert.equal(hardware.commands.length, 0, `${command}: nothing reached the programmer`);
    assert.equal(hardware.saharaLog.length, 0, `${command}: nothing reached the boot ROM`);
  }
});

test("push, pull and the other actions EDL does not have are refused", async () => {
  for (const action of ["push", "pull", "monitor", "sideload", "verify", "forward", "reverse", "install"]) {
    const hardware = device({ mode: "firehose" });
    await assert.rejects(run(hardware, { action }).promise, /EDL does not support/);
    assert.equal(hardware.commands.length, 0);
  }
});

test("a whole session, from the boot ROM to a partition read, sends nothing a read-only reader would not send", async () => {
  const hardware = device();
  await finish(hardware, { action: "detect" });
  await exec(hardware, "connect", withLoader);
  await exec(hardware, "printgpt");
  await exec(hardware, "check");
  await finish(hardware, { action: "dump", target: "boot_a" }, { approve: async () => undefined });
  await finish(hardware, { action: "dump", target: "user-area", options: { sectors: 2048 } }, { approve: async () => undefined });
  const tags = new Set(hardware.commands.map((entry) => entry.tag));
  assert.deepEqual([...tags].sort(), ["configure", "getstorageinfo", "nop", "read"]);
  assert.deepEqual(hardware.forbidden, []);
  assert.ok(hardware.disk.equals(built().disk), "the disk is exactly as it was");
  assert.deepEqual(hardware.writes, [], "no write of any kind was accepted");
});

// ---- flashing ------------------------------------------------------------------

const { classifyEdlPartition } = await jiti.import("./edl-protect.ts");

const imageOf = (bytes, seed = 9) => Buffer.from(Array.from({ length: bytes }, (_, index) => (index * 31 + seed + (index >> 8)) & 0xff));
const flashRequest = (target, image, extra = {}) => ({ action: "flash", target, fileId: "image", sha256: sha256(image), ...extra });
const flashRun = (hardware, target, image, options = {}, extra = {}) => run(hardware, flashRequest(target, image, extra), { input: new Blob([image]), ...options });
const flashFinish = async (hardware, target, image, options = {}, extra = {}) => {
  const operation = flashRun(hardware, target, image, options, extra);
  return { result: await operation.promise, ...operation };
};
const programsOf = (hardware) => hardware.writes.filter((entry) => entry.tag === "program");
const refusedBeforeWriting = async (hardware, operation, pattern, label) => {
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
  assert.deepEqual(hardware.writes, [], `${label}: nothing was written`);
  assert.equal(operation.confirmations.length, 0, `${label}: the user was never asked`);
};
const bigDisk = (extra = []) => buildDisk({ sectors: 8192, partitions: [{ name: "big", sectors: 5000 }, ...extra] }).disk;

test("flash writes an image the exact size of its partition: the partition is saved first, the user is asked once with the exact sectors, and the read-back verifies", async () => {
  const hardware = device({ mode: "firehose" });
  const before = Buffer.from(hardware.disk);
  const image = imageOf(64 * SECTOR);
  const saved = [];
  const seenWhenAsked = [];
  const { result, confirmations, output, progress } = await flashFinish(hardware, "boot_a", image, { saved, approve: async () => { seenWhenAsked.push(saved.map((file) => file.name)); } });

  assert.equal(result.verified, true);
  assert.equal(result.sha256, sha256(image));
  assert.match(result.summary, /Flashed boot_a: 32\.0 KiB, read back identical/);
  assert.ok(hardware.disk.subarray(34 * SECTOR, 98 * SECTOR).equals(image), "the partition holds the image");
  assert.ok(hardware.disk.subarray(0, 34 * SECTOR).equals(before.subarray(0, 34 * SECTOR)), "the partition table is untouched");
  assert.ok(hardware.disk.subarray(98 * SECTOR).equals(before.subarray(98 * SECTOR)), "so is everything after the partition");

  const copy = saved.find((file) => file.name === "edl-1a2b3c4d-boot_a.preflash.bin");
  assert.ok(copy.bytes.equals(before.subarray(34 * SECTOR, 98 * SECTOR)), "the saved copy is the partition as it was");
  assert.deepEqual(seenWhenAsked, [["edl-1a2b3c4d-boot_a.preflash.bin"]], "the copy existed before the user was asked");

  assert.equal(confirmations.length, 1, "one question, no separate one for the grant");
  const [risk] = confirmations;
  assert.equal(risk.action, "edl flash");
  assert.equal(risk.target, "boot_a");
  assert.equal(risk.sha256, sha256(image));
  assert.equal(risk.offset, 0);
  assert.equal(risk.length, 64 * SECTOR);
  assert.equal(risk.programSha256, sha256(image));
  assert.equal(risk.programOffset, 0);
  assert.equal(risk.programLength, 64 * SECTOR);
  assert.equal(risk.protectedOverride, undefined, "boot_a is not protected");
  assert.match(risk.backup, new RegExp(`Saved the whole boot_a partition \\(sectors 34-97 \\(64 sectors, 32768 bytes\\)\\) as ${copy.id}, SHA-256 ${copy.sha256}`));
  assert.match(risk.backup, /flash that file back to boot_a/);
  assert.match(risk.details, /Write grant for flash boot_a: Cody may write only sectors 34-97 of the eMMC user area \(physical partition 0; 64 sectors of 512 bytes in all\)/);
  assert.match(risk.details, /exactly the size of the partition/);

  assert.deepEqual(programsOf(hardware).map((entry) => [Number(entry.attributes.start_sector), Number(entry.attributes.num_partition_sectors)]), [[34, 64]]);
  assert.ok(hardware.writes.every((entry) => Number(entry.attributes.physical_partition_number) === 0));
  assert.deepEqual(hardware.forbidden, []);
  assert.deepEqual([...new Set(progress.map((event) => event.phase))].filter((phase) => ["escrow", "write", "verify"].includes(phase)), ["escrow", "write", "verify"]);
  assert.ok(said(output, /Reading boot_a back to check it/));
});

test("a programmer that waits for the zero-length packet that ends a block is written to as well", async () => {
  const hardware = device({ mode: "firehose", strictZlp: true });
  const image = imageOf(300 * SECTOR, 3);
  const { result } = await flashFinish(hardware, "system_a", image);
  assert.equal(result.verified, true);
  assert.ok(hardware.disk.subarray(98 * SECTOR, 398 * SECTOR).equals(image));
});

test("an image smaller than its partition needs an explicit pad; the partition is then written whole and read back whole", async () => {
  const image = imageOf(10 * SECTOR + 100, 5);
  const none = device({ mode: "firehose" });
  await refusedBeforeWriting(none, flashRun(none, "boot_a", image), /remaining 27548 bytes with 0x00 or 0xFF/, "no pad");
  assert.deepEqual(none.writes, []);

  for (const [pad, byte, text] of [["zero", 0x00, "0x00"], ["ff", 0xff, "0xFF"]]) {
    const hardware = device({ mode: "firehose" });
    const before = Buffer.from(hardware.disk);
    const padded = Buffer.concat([image, Buffer.alloc(64 * SECTOR - image.length, byte)]);
    const { result, confirmations } = await flashFinish(hardware, "boot_a", image, {}, { options: { pad } });
    assert.equal(result.verified, true, pad);
    assert.ok(hardware.disk.subarray(34 * SECTOR, 98 * SECTOR).equals(padded), `${pad}: image then the fill, to the end of the partition`);
    assert.ok(hardware.disk.subarray(98 * SECTOR).equals(before.subarray(98 * SECTOR)), pad);
    const [risk] = confirmations;
    assert.equal(risk.sha256, sha256(image));
    assert.equal(risk.length, image.length, `${pad}: the payload is the image`);
    assert.equal(risk.programSha256, sha256(padded), `${pad}: the final image is the padded one`);
    assert.equal(risk.programLength, 64 * SECTOR);
    assert.match(risk.details, new RegExp(`rest is filled with ${text}`));
    assert.equal(result.details.paddedBytes, 64 * SECTOR - image.length);
    assert.equal(result.details.pad, pad);
  }
});

test("an image bigger than its partition, odd options and a stray pad are refused before the device is spoken to", async () => {
  const hardware = device({ mode: "firehose" });
  const image = imageOf(64 * SECTOR);
  // Each case starts only when the one before it has ended: they share one device.
  const cases = [
    ["too big", () => flashRun(hardware, "boot_a", imageOf(65 * SECTOR)), /only 32768 bytes \(64 sectors\).*never writes past the end/s],
    ["empty", () => run(hardware, { action: "flash", target: "boot_a", fileId: "image", sha256: sha256(Buffer.alloc(0)) }, { input: new Blob([]) }), /needs an image/],
    ["no input at all", () => run(hardware, { action: "flash", target: "boot_a" }), /needs an image/],
    ["offset", () => flashRun(hardware, "boot_a", image, {}, { offset: 512 }), /offset and length are not accepted/],
    ["length", () => flashRun(hardware, "boot_a", image, {}, { length: 512 }), /offset and length are not accepted/],
    ["unknown option", () => flashRun(hardware, "boot_a", image, {}, { options: { force: true } }), /takes only options\.pad.*force is not accepted/],
    ["an approval smuggled in", () => flashRun(hardware, "boot_a", image, {}, { options: { approved: true, protectedOverride: "write:boot_a" } }), /Approvals are given in the panel, never in options/],
    ["bad pad", () => flashRun(hardware, "boot_a", imageOf(10 * SECTOR), {}, { options: { pad: "banana" } }), /options\.pad must be "zero" or "ff"/],
    ["no target", () => run(hardware, { action: "flash", fileId: "image", sha256: sha256(imageOf(512)) }, { input: new Blob([imageOf(512)]) }), /exact name of a GPT partition/],
    ["spaces around the name", () => flashRun(hardware, " boot_a", image), /exact name of a GPT partition/],
    ["a hash that is not the image's", () => run(hardware, { action: "flash", target: "boot_a", fileId: "image", sha256: sha256(Buffer.from("other")) }, { input: new Blob([image]) }), /SHA-256 is not the one the request names/],
  ];
  for (const [label, start, pattern] of cases) await refusedBeforeWriting(hardware, start(), pattern, label);
  const writesSent = hardware.commands.filter((entry) => ["program", "erase"].includes(entry.tag));
  assert.deepEqual(writesSent, []);
});

test("a pad on an image that already fills the partition changes nothing", async () => {
  const hardware = device({ mode: "firehose" });
  const image = imageOf(64 * SECTOR);
  const { result, confirmations } = await flashFinish(hardware, "boot_a", image, {}, { options: { pad: "zero" } });
  assert.equal(result.verified, true);
  assert.equal(result.details.paddedBytes, 0);
  assert.equal(confirmations[0].programSha256, sha256(image));
});

test("flash never sends a loader: a device still in the boot ROM is told to run Connect first, and is not spoken to", async () => {
  const hardware = device();
  const image = imageOf(64 * SECTOR);
  await refusedBeforeWriting(hardware, flashRun(hardware, "boot_a", image), /never sends a loader itself: run Connect with the loader file first/, "boot ROM");
  assert.equal(hardware.loaderAccepted, false);
  assert.equal(hardware.saharaLog.length, 0, "the boot ROM was not answered");
});

test("partitions on the protected list ask for a typed override, others do not", async () => {
  for (const [name, expected] of [["persist", "write:persist"], ["boot_a", undefined], ["system_a", undefined], ["userdata", undefined]]) {
    const hardware = device({ mode: "firehose" });
    const part = built().table.find((entry) => entry.name === name);
    const image = imageOf(part.sectors * SECTOR, 11);
    const { confirmations, result } = await flashFinish(hardware, name, image);
    assert.equal(confirmations[0].protectedOverride, expected, name);
    assert.equal(result.verified, true, name);
    if (expected) {
      assert.match(confirmations[0].details, /PROTECTED: .*Type write:persist to approve/s);
      assert.equal(result.details.protectedPartition, true);
    } else {
      assert.doesNotMatch(confirmations[0].details, /PROTECTED/, name);
    }
  }
});

test("the protected list, the partition-table names and the eMMC boot areas are told apart by name", () => {
  const levelOf = (name) => classifyEdlPartition(name).level;
  for (const name of ["sbl1", "SBL1", "sbl1_a", "sbl2", "sbl3", "xbl", "xbl_config", "xbl_a", "abl", "tz", "tz_b", "hyp", "rpm", "aop", "pmic", "aboot", "emmc_appsboot", "bootloader", "devcfg", "cmnlib", "cmnlib64", "cmnlib_a", "keymaster", "keymaster64", "modem", "modem_a", "fsg", "fsc", "modemst1", "modemst2", "persist", "devinfo", "sec", "DDR", "ddr", "misc", "gpt", "PGPT", "sgpt", "PrimaryGPT", "BackupGPT", "lk", "lk_a", "preloader", "tee1", "efuse", "dbi", "apdp", "msadp", "qupfw", "storsec"]) {
    assert.equal(levelOf(name), "protected", name);
  }
  for (const name of ["boot0", "boot1", "BOOT0", "rpmb", "RPMB", "rpmb_a", "boot0_x", "boot1:y", "mmcblk0boot0", "mmcblk0boot1", "mmcblk1boot0", "mmcblk0rpmb"]) {
    assert.equal(levelOf(name), "refused", name);
  }
  for (const name of ["boot", "boot_a", "boot_b", "recovery", "system", "system_a", "vendor", "vendor_b", "userdata", "cache", "dtbo", "vbmeta", "splash", "logo", "oem", "radio", "bootloader_img_not", "mdm", "cust"]) {
    // "bootloader_img_not" starts with a protected prefix on purpose: nothing that merely looks like the boot chain is waved through.
    assert.equal(levelOf(name), name === "bootloader_img_not" ? "protected" : "ordinary", name);
  }
});

test("a name that is an eMMC boot area or RPMB is refused whatever the table says, before the device is spoken to", async () => {
  for (const name of ["boot0", "boot1", "rpmb", "mmcblk0boot0", "mmcblk0boot1"]) {
    const hardware = device({ mode: "firehose", disk: buildDisk({ sectors: 2048, partitions: [{ name, sectors: 64 }] }).disk });
    await refusedBeforeWriting(hardware, flashRun(hardware, name, imageOf(64 * SECTOR)), /named like an eMMC boot area or RPMB.*no override for them/s, name);
    assert.equal(hardware.commands.length, 0, `${name}: nothing reached the programmer`);
  }
});

test("partitions the table cannot place safely are refused with no override: overlaps, ranges outside the table, a damaged or ambiguous table", async () => {
  const widen = (disk, firstUsable, lastUsable) => {
    for (const lba of [1, 2047]) patchGptHeader(disk, lba, (header) => { header.writeBigUInt64LE(BigInt(firstUsable), 40); header.writeBigUInt64LE(BigInt(lastUsable), 48); });
    return disk;
  };
  const cases = [
    ["another partition", buildDisk({ sectors: 2048, partitions: [{ name: "a", sectors: 100 }, { name: "b", first: 100, sectors: 50 }] }).disk, "b", /overlaps the partition a/],
    ["outside the usable range", buildDisk({ sectors: 2048, partitions: [{ name: "late", first: 2005, sectors: 20 }] }).disk, "late", /outside the table's usable range \(sectors 34-2014\)/],
    ["the primary table", widen(buildDisk({ sectors: 2048, partitions: [{ name: "low", first: 10, sectors: 40 }] }).disk, 2, 2014), "low", /overlaps the primary partition table \(sectors 0-33\)/],
    ["the backup table", widen(buildDisk({ sectors: 2048, partitions: [{ name: "high", first: 1990, sectors: 40 }] }).disk, 34, 2046), "high", /overlaps the backup partition table/],
    ["a name two entries share", buildDisk({ sectors: 2048, partitions: [{ name: "dup", sectors: 8 }, { name: "dup", sectors: 8 }] }).disk, "dup", /Two partitions are named "dup".*Nothing was written/s],
    ["no such partition", built().disk, "nope", /no partition named "nope".*boot_a, system_a, persist, userdata/s],
    ["a damaged table", built({ badPrimaryCrc: true }).disk, "boot_a", /partition table is damaged.*Nothing was written/s],
  ];
  for (const [label, disk, name, pattern] of cases) {
    const hardware = device({ mode: "firehose", disk });
    const operation = flashRun(hardware, name, imageOf(8 * SECTOR));
    await assert.rejects(operation.promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
    assert.deepEqual(hardware.writes, [], `${label}: nothing was written`);
    assert.equal(operation.confirmations.length, 0, label);
    assert.equal(operation.saved.length, 0, `${label}: nothing was even copied`);
  }
  const beyond = device({ mode: "firehose", totalBlocks: 300, disk: built().disk });
  await assert.rejects(flashRun(beyond, "userdata", imageOf(500 * SECTOR)).promise, /beyond the 300 sectors the programmer reports.*Nothing was written/s);
  assert.deepEqual(beyond.writes, []);
});

test("without a saved copy nothing is written: storage that fails, or that returns other bytes, refuses the write", async () => {
  const image = imageOf(64 * SECTOR);
  const failing = device({ mode: "firehose" });
  const env = edlContext(failing, { input: new Blob([image]) });
  env.context.saveStream = async () => { throw new Error("storage quota exceeded"); };
  await assert.rejects(edlFlasher.run({ protocol: "edl", ...flashRequest("boot_a", image) }, env.context), (error) => error instanceof EdlError && /could not be saved \(storage quota exceeded\)\. Nothing was written/.test(error.message));
  assert.deepEqual(failing.writes, []);
  assert.equal(env.confirmations.length, 0, "nobody was asked to approve a write that has no copy");

  const altering = device({ mode: "firehose" });
  const second = edlContext(altering, { input: new Blob([image]) });
  second.context.saveStream = async (_name, chunks) => {
    let length = 0;
    for await (const chunk of chunks) length += chunk.byteLength;
    return { fileId: "x", sha256: "0".repeat(64), length };
  };
  await assert.rejects(edlFlasher.run({ protocol: "edl", ...flashRequest("boot_a", image) }, second.context), /saved file's SHA-256.*differs from that of the bytes received.*Nothing was written/s);
  assert.deepEqual(altering.writes, []);
  assert.equal(second.confirmations.length, 0);
});

test("declining the question writes nothing and leaves the saved copy", async () => {
  const hardware = device({ mode: "firehose" });
  const before = Buffer.from(hardware.disk);
  const operation = flashRun(hardware, "boot_a", imageOf(64 * SECTOR), { approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(operation.confirmations.length, 1);
  assert.deepEqual(hardware.writes, []);
  assert.ok(hardware.disk.equals(before));
  assert.equal(operation.saved.length, 1, "the copy of the partition is still there");
});

test("a cancel lands between blocks even when it arrives during one: the block in flight is finished, the next is never started, and the programmer is left idle", async () => {
  const controller = new AbortController();
  const hardware = device({ mode: "firehose", disk: bigDisk(), writeFault: { slowWriteMs: 15 }, onProgram: (index) => { if (index === 2) controller.abort(); } });
  const before = Buffer.from(hardware.disk);
  const image = imageOf(5000 * SECTOR, 21);
  const operation = flashRun(hardware, "big", image, { signal: controller.signal });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(programsOf(hardware).length, 2, "the third block was never sent");
  assert.equal(hardware.sectorsProgrammed, 4096, "two whole blocks were written");
  assert.equal(hardware.awaitingRawData, false, "the programmer is idle, not waiting for data");
  assert.ok(hardware.disk.subarray(34 * SECTOR, 4130 * SECTOR).equals(image.subarray(0, 4096 * SECTOR)));
  assert.ok(hardware.disk.subarray(4130 * SECTOR).equals(before.subarray(4130 * SECTOR)), "nothing past the second block changed");
  const note = operation.output.find((line) => /POSSIBLY MODIFIED/.test(line));
  assert.match(note, /stopped \(the operation was cancelled\) after 4096 of 5000 sectors were acknowledged/);
  assert.match(note, new RegExp(`Its previous contents are saved as ${operation.saved[0].id} \\(SHA-256 ${operation.saved[0].sha256}\\)`));
  assert.equal(said(operation.output, /cut it off/), false, "no block was cut");
  // The device is usable straight away.
  const again = await exec(hardware, "printgpt");
  assert.equal(again.result.details.partitions[0].name, "big");
});

test("a block that does not finish within the grace period after a cancel is cut off, and the output says the programmer may be waiting for data", async () => {
  await withTimeouts({ cancelGrace: 80 }, async () => {
    const controller = new AbortController();
    const hardware = device({ mode: "firehose", disk: bigDisk(), writeFault: { slowWriteMs: 40 }, onProgram: (index) => { if (index === 2) controller.abort(); } });
    const operation = flashRun(hardware, "big", imageOf(5000 * SECTOR, 21), { signal: controller.signal });
    await assert.rejects(operation.promise, (error) => error.name === "AbortError");
    assert.equal(hardware.sectorsProgrammed, 2048, "only the first block was complete");
    assert.equal(hardware.awaitingRawData, true, "the second block was cut in two");
    assert.ok(said(operation.output, /did not finish within 0\.08 s, so it was cut off.*put it into EDL mode again/s));
    assert.match(operation.output.find((line) => /POSSIBLY MODIFIED/.test(line)), /a block of 2048 sector\(s\) was in flight, so it may be partly written/);
  });
});

test("a programmer that refuses a block part-way through the partition stops the write and says how far it got and where the old contents are", async () => {
  const hardware = device({ mode: "firehose", disk: bigDisk(), writeFault: { nakAfterData: 2 } });
  const before = Buffer.from(hardware.disk);
  const image = imageOf(5000 * SECTOR, 22);
  const operation = flashRun(hardware, "big", image);
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /POSSIBLY MODIFIED: the write to big stopped \(The programmer refused Firehose write of sectors 2082-4129: ERROR: Write verification failed\) after 2048 of 5000 sectors were acknowledged; a block of 2048 sector\(s\) was in flight/.test(error.message) && new RegExp(`saved as ${operation.saved[0].id}`).test(error.message) && /flash that file back to big/.test(error.message));
  assert.equal(hardware.sectorsProgrammed, 2048);
  assert.ok(hardware.disk.subarray(34 * SECTOR, 2082 * SECTOR).equals(image.subarray(0, 2048 * SECTOR)));
  assert.ok(hardware.disk.subarray(2082 * SECTOR).equals(before.subarray(2082 * SECTOR)), "the refused block changed nothing");
  assert.equal(hardware.awaitingRawData, false);
});

test("a first block the programmer refuses before any data is sent means nothing was written, and says so", async () => {
  const hardware = device({ mode: "firehose", writeFault: { nakAt: 1 } });
  const before = Buffer.from(hardware.disk);
  await assert.rejects(flashRun(hardware, "boot_a", imageOf(64 * SECTOR)).promise, (error) => error instanceof EdlError && /^Nothing was written to boot_a: The programmer refused Firehose write of sectors 34-97: ERROR: Failed to write to the device\. Its contents are as they were\.$/.test(error.message));
  assert.ok(hardware.disk.equals(before));
  assert.equal(hardware.zeroLengthPackets, 0, "no data was sent");
});

test("a device that leaves the bus part-way through says the partition is possibly modified and how many sectors it had acknowledged", async () => {
  const hardware = device({ mode: "firehose", disk: bigDisk(), writeFault: { dieAfterSectors: 3000 } });
  const operation = flashRun(hardware, "big", imageOf(5000 * SECTOR, 23));
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /POSSIBLY MODIFIED: the write to big stopped \(the device left the USB bus\) after 2048 of 5000 sectors were acknowledged; a block of 2048 sector\(s\) was in flight/.test(error.message));
  assert.equal(hardware.sectorsProgrammed, 3000);
  assert.ok(said(operation.output, /POSSIBLY MODIFIED/));
});

test("a write the programmer acknowledges but did not keep is caught by the read-back, with the backup id", async () => {
  for (const [label, fault] of [["a flipped byte", { corrupt: { atWrite: 1, offset: 100 } }], ["nothing stored", { ignore: true }]]) {
    const hardware = device({ mode: "firehose", writeFault: fault });
    const image = imageOf(64 * SECTOR, 31);
    const operation = flashRun(hardware, "boot_a", image);
    await assert.rejects(operation.promise, (error) => error instanceof EdlError && new RegExp(`READ-BACK MISMATCH on boot_a: the programmer acknowledged every block, but the partition reads back as SHA-256 [0-9a-f]{64}, not ${sha256(image)}\\. boot_a is POSSIBLY MODIFIED.*saved as ${operation.saved[0].id} \\(SHA-256 ${operation.saved[0].sha256}\\)\\. To undo this, flash that file back to boot_a\\. Nothing was retried`, "s").test(error.message), label);
  }
});

test("a programmer that will not read the partition back leaves the write honestly UNVERIFIED, not failed and not verified", async () => {
  const hardware = device({ mode: "firehose", readFault: { nak: true, atRead: 6, once: true } });
  const image = imageOf(64 * SECTOR, 41);
  const { result, output, saved } = await flashFinish(hardware, "boot_a", image);
  assert.equal(result.verified, false);
  assert.match(result.summary, /^UNVERIFIED: the programmer acknowledged the write to boot_a but would not read it back/);
  assert.match(result.summary, new RegExp(`previous contents are saved as ${saved[0].id}`));
  assert.ok(said(output, /UNVERIFIED/));
  assert.ok(hardware.disk.subarray(34 * SECTOR, 98 * SECTOR).equals(image), "the write itself did land");
});

test("a device that goes away during the read-back is an error that says UNVERIFIED and where the old contents are", async () => {
  const hardware = device({ mode: "firehose", readFault: { leaveAfter: 1000, atRead: 6 } });
  const operation = flashRun(hardware, "boot_a", imageOf(64 * SECTOR, 51));
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /acknowledged, but reading it back failed.*UNVERIFIED, and boot_a is POSSIBLY MODIFIED.*saved as file-1/s.test(error.message));
});

test("a cancel during the read-back is reported as an unverified write, not as success", async () => {
  const controller = new AbortController();
  const hardware = device({ mode: "firehose" });
  const operation = flashRun(hardware, "system_a", imageOf(300 * SECTOR, 61), { signal: controller.signal, onProgress: (event) => { if (event.phase === "verify" && event.completed === 0) controller.abort(); } });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.ok(said(operation.output, /Cancelled before the read-back finished: the write to system_a was acknowledged but is UNVERIFIED/));
});

test("everything a whole flash sends is a read, or a program inside the partition", async () => {
  const hardware = device({ mode: "firehose" });
  await flashFinish(hardware, "system_a", imageOf(300 * SECTOR, 71));
  const tags = new Set(hardware.commands.map((entry) => entry.tag));
  assert.deepEqual([...tags].sort(), ["configure", "getstorageinfo", "nop", "program", "read"]);
  for (const entry of programsOf(hardware)) {
    const first = Number(entry.attributes.start_sector);
    assert.ok(first >= 98 && first + Number(entry.attributes.num_partition_sectors) - 1 <= 397, "inside system_a");
  }
  assert.deepEqual(hardware.forbidden, []);
});

// ---- erasing -------------------------------------------------------------------

const eraseRun = (hardware, target, options = {}, extra = {}) => run(hardware, { action: "exec", command: "erase", target, ...extra }, options);
const eraseFinish = async (hardware, target, options = {}, extra = {}) => {
  const operation = eraseRun(hardware, target, options, extra);
  return { result: await operation.promise, ...operation };
};
const erasesOf = (hardware) => hardware.writes.filter((entry) => entry.tag === "erase");

test("erase saves the partition first, asks once with the exact sectors, erases, and reports what the partition reads as", async () => {
  for (const [fill, byte, state, wording] of [["zero", 0x00, "zero", /all zero bytes \(0x00\)/], ["ff", 0xff, "ff", /all 0xFF bytes/]]) {
    const hardware = device({ mode: "firehose", eraseFill: fill });
    const before = Buffer.from(hardware.disk);
    const saved = [];
    const seenWhenAsked = [];
    const { result, confirmations, output } = await eraseFinish(hardware, "system_a", { saved, approve: async () => { seenWhenAsked.push(saved.map((file) => file.name)); } });
    assert.equal(result.verified, true, fill);
    assert.equal(result.details.state, state);
    assert.match(result.summary, wording);
    assert.ok(hardware.disk.subarray(98 * SECTOR, 398 * SECTOR).every((value) => value === byte), fill);
    assert.ok(hardware.disk.subarray(0, 98 * SECTOR).equals(before.subarray(0, 98 * SECTOR)) && hardware.disk.subarray(398 * SECTOR).equals(before.subarray(398 * SECTOR)), `${fill}: nothing around it changed`);
    const copy = saved.find((file) => file.name === "edl-1a2b3c4d-system_a.preerase.bin");
    assert.ok(copy.bytes.equals(before.subarray(98 * SECTOR, 398 * SECTOR)), "the saved copy is the partition as it was");
    assert.deepEqual(seenWhenAsked, [["edl-1a2b3c4d-system_a.preerase.bin"]], "the copy existed before the user was asked");
    assert.equal(confirmations.length, 1);
    const [risk] = confirmations;
    assert.equal(risk.action, "edl erase");
    assert.equal(risk.target, "system_a");
    assert.equal(risk.offset, 0);
    assert.equal(risk.length, 300 * SECTOR);
    assert.equal(risk.sha256, undefined, "an erase has no payload");
    assert.equal(risk.protectedOverride, undefined);
    assert.match(risk.backup, new RegExp(`Saved the whole system_a partition \\(sectors 98-397.*as ${copy.id}, SHA-256 ${copy.sha256}`));
    assert.match(risk.details, /Write grant for erase system_a: Cody may erase only sectors 98-397/);
    assert.match(risk.details, /claims no particular value/);
    assert.deepEqual(erasesOf(hardware).map((entry) => [Number(entry.attributes.start_sector), Number(entry.attributes.num_partition_sectors)]), [[98, 300]]);
    assert.deepEqual(hardware.forbidden, []);
    assert.ok(said(output, /Reading system_a back to see what it holds now/));
  }
});

test("an erase that leaves the partition unchanged, or uneven, is reported as exactly that and not as verified", async () => {
  const unchanged = device({ mode: "firehose", eraseFault: "noop" });
  const first = await eraseFinish(unchanged, "boot_a");
  assert.equal(first.result.verified, false);
  assert.equal(first.result.details.state, "unchanged");
  assert.match(first.result.summary, /^UNCHANGED: the programmer acknowledged the erase of boot_a, but the partition still reads exactly as before/);
  const mixed = device({ mode: "firehose", eraseFill: "mixed" });
  const second = await eraseFinish(mixed, "boot_a");
  assert.equal(second.result.verified, false);
  assert.equal(second.result.details.state, "mixed");
  assert.match(second.result.summary, /mixed contents, neither all zero nor all 0xFF.*claims no particular erased value/s);
});

test("erasing a protected partition asks for the typed override; boot areas and RPMB are refused outright", async () => {
  const hardware = device({ mode: "firehose" });
  const { confirmations } = await eraseFinish(hardware, "persist");
  assert.equal(confirmations[0].protectedOverride, "write:persist");
  assert.match(confirmations[0].details, /PROTECTED: .*Type write:persist to approve/s);
  for (const name of ["boot0", "rpmb", "mmcblk0boot1"]) {
    const refused = device({ mode: "firehose", disk: buildDisk({ sectors: 2048, partitions: [{ name, sectors: 64 }] }).disk });
    await refusedBeforeWriting(refused, eraseRun(refused, name), /eMMC boot area or RPMB.*Nothing was erased/s, name);
    assert.equal(refused.commands.length, 0, `${name}: nothing reached the programmer`);
  }
});

test("an erase takes no file, no options and no byte range, never sends a loader, and refuses what the table cannot place", async () => {
  const hardware = device({ mode: "firehose" });
  const cases = [
    ["a file", () => eraseRun(hardware, "boot_a", { input: new Blob([imageOf(512)]) }, { fileId: "f", sha256: sha256(imageOf(512)) }), /takes no file.*Nothing was erased/s],
    ["an option", () => eraseRun(hardware, "boot_a", {}, { options: { approved: true } }), /takes no options.*never in options/s],
    ["a range", () => eraseRun(hardware, "boot_a", {}, { offset: 512, length: 512 }), /offset and length are not accepted/],
    ["no target", () => eraseRun(hardware, undefined), /exact name of a GPT partition/],
    ["no such partition", () => eraseRun(hardware, "nope"), /no partition named "nope"/],
  ];
  for (const [label, start, pattern] of cases) await refusedBeforeWriting(hardware, start(), pattern, label);
  const rom = device();
  await refusedBeforeWriting(rom, eraseRun(rom, "boot_a"), /never sends a loader itself/, "boot ROM");
  assert.equal(rom.saharaLog.length, 0);
  const overlapping = device({ mode: "firehose", disk: buildDisk({ sectors: 2048, partitions: [{ name: "a", sectors: 100 }, { name: "b", first: 100, sectors: 50 }] }).disk });
  await refusedBeforeWriting(overlapping, eraseRun(overlapping, "b"), /overlaps the partition a.*never erases across/s, "overlap");
  // A programmer that has no erase says so itself (Cody does not imitate an erase with writes); the partition is untouched.
  const noErase = device({ mode: "firehose", functions: ["configure", "program", "read", "getstorageinfo", "power", "nop"] });
  const before = Buffer.from(noErase.disk);
  await assert.rejects(eraseRun(noErase, "boot_a").promise, (error) => error instanceof EdlError && /^Nothing was erased in boot_a: The programmer refused Firehose erase of sectors 34-97: ERROR: Unsupported command erase\. Its contents are as they were\.$/.test(error.message));
  assert.ok(noErase.disk.equals(before));
});

test("an erase without a saved copy, or declined, changes nothing", async () => {
  const failing = device({ mode: "firehose" });
  const env = edlContext(failing);
  env.context.saveStream = async () => { throw new Error("storage quota exceeded"); };
  await assert.rejects(edlFlasher.run({ protocol: "edl", action: "exec", command: "erase", target: "boot_a" }, env.context), /could not be saved \(storage quota exceeded\)\. Nothing was erased: Cody never erases without a saved copy/);
  assert.deepEqual(failing.writes, []);
  assert.equal(env.confirmations.length, 0);
  const declined = device({ mode: "firehose" });
  const operation = eraseRun(declined, "boot_a", { approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.deepEqual(declined.writes, []);
  assert.equal(operation.saved.length, 1);
});

test("a refused first segment erased nothing; a failure or cancel between segments says how far it got and where the old contents are", async () => {
  const refusing = device({ mode: "firehose", eraseFault: "nak" });
  await assert.rejects(eraseRun(refusing, "boot_a").promise, (error) => error instanceof EdlError && /^Nothing was erased in boot_a: The programmer refused Firehose erase of sectors 34-97: ERROR: Failed to erase the device\. Its contents are as they were\.$/.test(error.message));

  // 70000 sectors need two erase commands (32 MiB = 65536 sectors each).
  const big = () => buildDisk({ sectors: 70100, partitions: [{ name: "huge", sectors: 70000 }] }).disk;
  const controller = new AbortController();
  const hardware = device({ mode: "firehose", disk: big(), onErase: (index) => { if (index === 1) controller.abort(); } });
  const operation = eraseRun(hardware, "huge", { signal: controller.signal });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(erasesOf(hardware).length, 1, "the second segment was never sent");
  const note = operation.output.find((line) => /POSSIBLY MODIFIED/.test(line));
  assert.match(note, /the erase of huge stopped \(the operation was cancelled\) after 65536 of 70000 sectors were erased\. huge now holds a mix of erased and original contents\./);
  assert.match(note, new RegExp(`saved as ${operation.saved[0].id}`));
  assert.ok(hardware.disk.subarray(34 * SECTOR, 65570 * SECTOR).every((value) => value === 0), "the first segment is erased");
});

test("a programmer that will not read an erased partition back leaves the erase UNVERIFIED", async () => {
  const hardware = device({ mode: "firehose", readFault: { nak: true, atRead: 6, once: true } });
  const { result, saved } = await eraseFinish(hardware, "boot_a");
  assert.equal(result.verified, false);
  assert.match(result.summary, /^UNVERIFIED: the programmer acknowledged the erase of boot_a but would not read it back/);
  assert.match(result.summary, new RegExp(`saved as ${saved[0].id}`));
});

// ---- setbootablestoragedrive ------------------------------------------------------------------------------------

const bootRequest = (target, extra = {}) => ({ action: "exec", command: "setbootablestoragedrive", target, ...extra });
const bootWrites = (hardware) => hardware.writes.filter((entry) => entry.tag === "setbootablestoragedrive");

test("setbootablestoragedrive asks once with the drive, the typed override and no saved copy, sends exactly that command, and is reported UNVERIFIED", async () => {
  const hardware = device({ mode: "firehose" });
  const before = Buffer.from(hardware.disk);
  const { result, confirmations, output } = await finish(hardware, bootRequest("1"));
  assert.equal(confirmations.length, 1);
  const [risk] = confirmations;
  assert.equal(risk.action, "edl setbootablestoragedrive");
  assert.equal(risk.target, "1");
  assert.equal(risk.protectedOverride, "set-bootable:1");
  assert.match(risk.backup, /^Backup unavailable: the programmer cannot report which drive the boot ROM starts from/);
  assert.match(risk.details, /set the bootable storage drive to 1.*UNVERIFIED and the previous value is unknown.*Type set-bootable:1 to approve.*Cody may set the bootable storage drive to 1 and nothing else/s);
  assert.deepEqual(bootWrites(hardware).map((entry) => entry.attributes), [{ value: "1" }]);
  assert.equal(hardware.bootableDrive, 1);
  assert.ok(hardware.disk.equals(before), "no sector was touched");
  assert.deepEqual(hardware.forbidden, []);
  assert.equal(result.verified, false);
  assert.match(result.summary, /^UNVERIFIED: the programmer acknowledged setbootablestoragedrive 1\. Cody cannot read this setting back/);
  assert.equal(result.details.previous, "unknown");
  assert.ok(said(output, /^UNVERIFIED/));
});

test("the drive is a single digit from 0 to 7 and the command takes nothing else; anything else is refused before the programmer is spoken to", async () => {
  for (const target of [undefined, "", "8", "-1", "1.5", "01", " 1", "1 ", "boot", "0x1", "١", "1;2"]) {
    const hardware = device({ mode: "firehose" });
    await assert.rejects(run(hardware, bootRequest(target)).promise, (error) => error instanceof EdlError && error.kind === "refused" && /needs the drive number, a single digit from 0 to 7.*Nothing was sent/.test(error.message), String(target));
    assert.equal(hardware.commands.length, 0, `${target}: nothing reached the programmer`);
  }
  const image = imageOf(512);
  for (const [label, request, options, pattern] of [
    ["a file", bootRequest("1", { fileId: "f", sha256: sha256(image) }), { input: new Blob([image]) }, /takes a drive number only: no file, offset or length/],
    ["an offset", bootRequest("1", { offset: 0 }), {}, /takes a drive number only/],
    ["a length", bootRequest("1", { length: 512 }), {}, /takes a drive number only/],
    ["options", bootRequest("1", { options: { value: 2 } }), {}, /takes no options.*never in options/],
  ]) {
    const hardware = device({ mode: "firehose" });
    await assert.rejects(run(hardware, request, options).promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
    assert.equal(hardware.commands.length, 0, `${label}: nothing reached the programmer`);
  }
  for (const target of ["0", "7"]) {
    const hardware = device({ mode: "firehose" });
    await finish(hardware, bootRequest(target));
    assert.equal(hardware.bootableDrive, Number(target));
  }
});

test("declining the boot drive question sends nothing, and a device still in the boot ROM is told to run Connect first", async () => {
  const declined = device({ mode: "firehose" });
  const operation = run(declined, bootRequest("1"), { approve: false });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.equal(operation.confirmations.length, 1);
  assert.deepEqual(declined.writes, []);
  assert.equal(declined.commands.some((entry) => entry.tag === "setbootablestoragedrive"), false);

  const inRom = device();
  await assert.rejects(run(inRom, bootRequest("1")).promise, (error) => error instanceof EdlError && error.kind === "refused" && /never sends a loader itself: run Connect with the loader file first/.test(error.message));
  assert.equal(inRom.saharaLog.length, 0);
});

test("a programmer that refuses the boot drive change is quoted, and the setting is said to be as it was", async () => {
  const hardware = device({ mode: "firehose", setBootableFault: "nak" });
  await assert.rejects(run(hardware, bootRequest("2")).promise, (error) => error instanceof EdlError && error.kind === "rejected" && /The programmer refused Firehose setbootablestoragedrive 2: ERROR: Failed to set the bootable storage drive\. The programmer did not apply it, so the boot drive setting is as it was\./.test(error.message));
  assert.equal(hardware.bootableDrive, undefined);
});

test("a verdict that never comes, or a device that leaves, after the command went out is POSSIBLY CHANGED; a cancel while waiting is still a cancel and says the same", async () => {
  await withTimeouts({ command: 80 }, async () => {
    const silent = device({ mode: "firehose", setBootableFault: "silent" });
    await assert.rejects(run(silent, bootRequest("2")).promise, (error) => error instanceof EdlError && /^POSSIBLY CHANGED: setbootablestoragedrive 2 was sent, but the programmer's answer did not arrive \(Firehose setbootablestoragedrive 2 timed out/.test(error.message) && /Cody cannot read it back/.test(error.message));
    assert.equal(silent.bootableDrive, 2, "the programmer did apply it");

    const leaving = device({ mode: "firehose", setBootableFault: "leave" });
    await assert.rejects(run(leaving, bootRequest("3")).promise, (error) => error instanceof EdlError && /^POSSIBLY CHANGED: setbootablestoragedrive 3 was sent, but the programmer's answer did not arrive \(the device left the USB bus\)/.test(error.message));

    const controller = new AbortController();
    const waiting = device({ mode: "firehose", setBootableFault: "silent" });
    const operation = run(waiting, bootRequest("4"), { signal: controller.signal });
    // The cancel lands while the programmer's verdict is being waited for: the command is already out.
    const watch = setInterval(() => { if (bootWrites(waiting).length > 0) controller.abort(); }, 5);
    try {
      await assert.rejects(operation.promise, (error) => error.name === "AbortError");
    } finally {
      clearInterval(watch);
    }
    assert.ok(said(operation.output, /POSSIBLY CHANGED: setbootablestoragedrive 4 was sent, but the programmer's answer did not arrive \(the operation was cancelled\)/));
  });
});

// ---- review 2: the live backup table, a message swallowed as data, and how far a write got ---------------------------

const tailDisk = (patch) => {
  const disk = buildDisk({ sectors: 2048, partitions: [{ name: "boot_a", sectors: 64 }, { name: "tailpart", first: 1980, sectors: 30 }] }).disk;
  patchGptHeader(disk, 2047, patch);
  return disk;
};

test("flash and erase protect the backup table where its own header says the entries are, not where the primary table implies", async () => {
  // An intact backup header in the last sector whose entry array is at 1980-2011; the primary table lists an ordinary partition at 1980-2009.
  const disk = tailDisk((header) => header.writeBigUInt64LE(1980n, 72));
  for (const [label, attempt] of [["flash", (hardware) => flashRun(hardware, "tailpart", imageOf(30 * SECTOR, 7))], ["erase", (hardware) => eraseRun(hardware, "tailpart")]]) {
    const hardware = device({ mode: "firehose", disk });
    await assert.rejects(attempt(hardware).promise, (error) => error instanceof EdlError && error.kind === "refused" && /tailpart \(sectors 1980-2009\) overlaps the backup partition table \(from sector 1980\)/.test(error.message), label);
    assert.deepEqual(hardware.writes, [], `${label}: nothing written`);
  }
});

test("a backup header in the last sector that puts its entries somewhere implausible is refused rather than guessed at; a missing one leaves the conventional place protected", async () => {
  const hardware = device({ mode: "firehose", disk: tailDisk((header) => header.writeBigUInt64LE(100n, 72)) });
  await assert.rejects(flashRun(hardware, "boot_a", imageOf(64 * SECTOR)).promise, (error) => error instanceof EdlError && error.kind === "refused" && /puts its entry array at sector 100, which is not just before it.*cannot tell which sectors it protects.*Nothing was written/s.test(error.message));
  assert.deepEqual(hardware.writes, []);

  const missing = device({ mode: "firehose", disk: built({ badBackup: true }).disk });
  const { result } = await flashFinish(missing, "boot_a", imageOf(64 * SECTOR, 8));
  assert.equal(result.verified, true, "no backup header to read: the old rule still applies and an ordinary partition can be written");
});

test("a read that comes up short by exactly a whole message from the programmer is refused, not saved or hashed as disk data; data that merely ends in markup is still data", async () => {
  const hardware = device({ mode: "firehose", readFault: { swallowLog: "INFO: Read done", atRead: 3 } });
  const { promise, saved } = run(hardware, { action: "dump", target: "system_a" }, { approve: async () => undefined });
  await assert.rejects(promise, (error) => error instanceof EdlError && /\d+ byte\(s\) of the sector data, starting at byte \d+ of \d+, are a complete message from the programmer/.test(error.message));
  assert.equal(saved.length, 0, "no file for a short read");

  // Ending in markup that is not one of the programmer's messages is just data.
  const disk = built().disk;
  Buffer.from("<data><program /></data>").copy(disk, 398 * SECTOR - 24);
  const markup = device({ mode: "firehose", disk });
  const { result } = await finish(markup, { action: "dump", target: "system_a" }, { approve: async () => undefined });
  assert.equal(result.sha256, sha256(disk.subarray(98 * SECTOR, 398 * SECTOR)));
});

test("a write whose closing answer never comes is POSSIBLY MODIFIED once its data went out, however small the block", async () => {
  await withTimeouts({ writeAck: 80 }, async () => {
    const disk = buildDisk({ sectors: 2048, partitions: [{ name: "tiny", sectors: 1 }, { name: "boot_a", sectors: 64 }] }).disk;
    const hardware = device({ mode: "firehose", disk, writeFault: { ackDelayMs: 400 } });
    const image = imageOf(SECTOR, 12);
    const operation = flashRun(hardware, "tiny", image);
    await assert.rejects(operation.promise, (error) => error instanceof EdlError && /^POSSIBLY MODIFIED: the write to tiny stopped \(.*timed out waiting for the programmer's answer\) after 0 of 1 sectors were acknowledged; a block of 1 sector\(s\) was in flight, so it may be partly written\. tiny now holds a mix of the new data and its previous contents\. Its previous contents are saved as file-1 /s.test(error.message));
    assert.ok(hardware.disk.subarray(34 * SECTOR, 35 * SECTOR).equals(image), "the sector did land, whatever the answer");
  });
});

test("a payload transfer that fails part-way is POSSIBLY MODIFIED even though none of its bytes count as sent", async () => {
  const hardware = device({ mode: "firehose" });
  const image = imageOf(64 * SECTOR, 13);
  const env = edlContext(hardware, { input: new Blob([image]) });
  const real = hardware.transport;
  let failed = false;
  env.context.transport = {
    ...real,
    async write(bytes, signal) {
      if (!failed && bytes.length === 64 * SECTOR) {
        failed = true;
        await real.write(bytes.subarray(0, 300), signal);
        throw new DOMException("The transfer failed.", "NetworkError");
      }
      return real.write(bytes, signal);
    },
  };
  await assert.rejects(edlFlasher.run({ protocol: "edl", ...flashRequest("boot_a", image) }, env.context), (error) => error instanceof EdlError && /^POSSIBLY MODIFIED: the write to boot_a stopped \(The transfer failed\) after 0 of 64 sectors were acknowledged; a block of 64 sector\(s\) was in flight/.test(error.message) && /saved as file-1 /.test(error.message));
});

test("a message swallowed as the last stretch of data is caught when the data before it ended exactly on a packet boundary, seen only as a zero-length packet", async () => {
  // 129 sectors: the first 65536 bytes fill a whole read request and end in a zero-length packet; the message is exactly one packet (512 bytes).
  const disk = buildDisk({ sectors: 2048, partitions: [{ name: "zlp", sectors: 129 }] }).disk;
  const hardware = device({ mode: "firehose", disk, readFault: { swallowLog: "INFO: ".padEnd(444, "x"), atRead: 3 } });
  const { promise, saved } = run(hardware, { action: "dump", target: "zlp" }, { approve: async () => undefined });
  await assert.rejects(promise, (error) => error instanceof EdlError && /512 byte\(s\) of the sector data, starting at byte 65536 of 66048, are a complete message from the programmer/.test(error.message));
  assert.equal(saved.length, 0);
});

// ---- review 3: a message larger than the tail, and a message that is all the "data" there is ------------------------

const smallDisk = (partitions) => buildDisk({ sectors: 2048, partitions }).disk;

test("a log message too long for the 1 KiB tail, swallowed as the last of the data, is refused: no saved copy is taken from it and nothing is written", async () => {
  const disk = smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]);
  // Flash reads the primary table (2 reads), the last sector (3rd) and then the partition (4th): the copy it saves first.
  const hardware = device({ mode: "firehose", disk, readFault: { swallowLog: "INFO: ".padEnd(1400, "x"), atRead: 4, once: true } });
  const operation = flashRun(hardware, "eight", imageOf(8 * SECTOR, 14));
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /1468 byte\(s\) of the sector data, starting at byte 2628 of 4096, are a complete message from the programmer/.test(error.message));
  assert.deepEqual(hardware.writes, []);
  assert.equal(operation.confirmations.length, 0, "the user was never asked to approve a write over a bad saved copy");
  assert.equal(operation.saved.length, 0);

  // The same read as a plain dump: the partition is the third read.
  const dumping = device({ mode: "firehose", disk, readFault: { swallowLog: "INFO: ".padEnd(1400, "x"), atRead: 3, once: true } });
  const dump = run(dumping, { action: "dump", target: "eight" }, { approve: async () => undefined });
  await assert.rejects(dump.promise, (error) => error instanceof EdlError && /are a complete message from the programmer/.test(error.message));
  assert.equal(dump.saved.length, 0);
});

test("a log message that is all the data there is - not one disk byte arrived - is refused, however its transfers are framed", async () => {
  const disk = smallDisk([{ name: "tiny", sectors: 1 }, { name: "boot_a", sectors: 64 }]);
  for (const [label, options] of [["a transfer of its own", {}], ["the same transfer as the announcing answer", { coalesceRaw: true }]]) {
    const hardware = device({ mode: "firehose", disk, readFault: { swallowLog: "INFO: ".padEnd(444, "x"), atRead: 4, once: true }, ...options });
    const operation = flashRun(hardware, "tiny", imageOf(SECTOR, 15));
    await assert.rejects(operation.promise, (error) => error instanceof EdlError && /512 byte\(s\) of the sector data, starting at byte 0 of 512, are a complete message from the programmer/.test(error.message), label);
    assert.deepEqual(hardware.writes, [], label);
    assert.equal(operation.saved.length, 0, label);
  }
});

// ---- review 4: a message with white space in front of it ---------------------------------------------------------------

test("a log message with white space in front of it, swallowed as data, is refused like the one without: no saved copy is taken from it and nothing is written", async () => {
  const leads = [["a newline", "\n"], ["a space", " "], ["a carriage return and a tab", "\r\t"], ["the eight white-space bytes a strict reader tolerates", " \n\r\t \n\r\t"]];
  for (const [label, lead] of leads) {
    // Nothing but the message arrives: a one-sector partition and a message exactly as long as the sector (the lead takes characters from its text).
    const tiny = smallDisk([{ name: "tiny", sectors: 1 }, { name: "boot_a", sectors: 64 }]);
    const alone = device({ mode: "firehose", disk: tiny, readFault: { swallowLog: "INFO: ".padEnd(444 - lead.length, "x"), swallowLead: lead, atRead: 4, once: true } });
    const first = flashRun(alone, "tiny", imageOf(SECTOR, 15));
    await assert.rejects(first.promise, (error) => error instanceof EdlError && /512 byte\(s\) of the sector data, starting at byte 0 of 512, are a complete message from the programmer/.test(error.message), `${label}, alone`);
    assert.deepEqual(alone.writes, [], label);
    assert.equal(first.saved.length, 0, label);

    // After real data, and longer than the 1 KiB tail.
    const eight = smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]);
    const after = device({ mode: "firehose", disk: eight, readFault: { swallowLog: "INFO: ".padEnd(1400 - lead.length, "x"), swallowLead: lead, atRead: 4, once: true } });
    const second = flashRun(after, "eight", imageOf(8 * SECTOR, 14));
    await assert.rejects(second.promise, (error) => error instanceof EdlError && /1468 byte\(s\) of the sector data, starting at byte 2628 of 4096, are a complete message from the programmer/.test(error.message), `${label}, after data`);
    assert.deepEqual(after.writes, [], label);
    assert.equal(second.confirmations.length, 0, label);
    assert.equal(second.saved.length, 0, label);
  }
});

test("padding that is a transfer of its own in front of a swallowed message does not hide it, and a partition of nothing but blanks is still data", async () => {
  const disk = smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]);
  const apart = device({ mode: "firehose", disk, readFault: { swallowLog: "INFO: ".padEnd(1398, "x"), swallowLead: "\n\n", swallowLeadApart: true, atRead: 4, once: true } });
  const operation = flashRun(apart, "eight", imageOf(8 * SECTOR, 16));
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /1466 byte\(s\) of the sector data, starting at byte 2630 of 4096, are a complete message from the programmer/.test(error.message));
  assert.deepEqual(apart.writes, []);

  const blanks = Buffer.from(smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]));
  blanks.fill(0x20, 34 * SECTOR, 38 * SECTOR);
  blanks.fill(0x0a, 38 * SECTOR, 42 * SECTOR);
  const { result } = await finish(device({ mode: "firehose", disk: blanks }), { action: "dump", target: "eight" }, { approve: async () => undefined });
  assert.equal(result.sha256, sha256(blanks.subarray(34 * SECTOR, 42 * SECTOR)));
});

// ---- review 5: the class, not the shape - where the data ends, and a second read of every copy ---------------------------

test("a read that is short by exactly the white space in front of its closing answer is refused: flash takes no copy from it and writes nothing", async () => {
  for (const [label, lead] of [["a newline", "\n"], ["a space", " "], ["eight white-space bytes", " \n\r\t \n\r\t"]]) {
    // One read that goes wrong (the reviewer's case), and a programmer that goes wrong every time.
    for (const persistent of [false, true]) {
      const disk = smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]);
      const hardware = device({ mode: "firehose", disk, readFault: { truncate: lead.length, closingLead: lead, atRead: 4, ...(persistent ? {} : { once: true }) } });
      const operation = flashRun(hardware, "eight", imageOf(8 * SECTOR, 17));
      const name = `${label}${persistent ? ", on every read" : ""}`;
      await assert.rejects(operation.promise, (error) => error instanceof EdlError && /did not end where the programmer ended a transfer/.test(error.message), name);
      assert.deepEqual(hardware.writes, [], name);
      assert.equal(operation.confirmations.length, 0, name);
      assert.equal(operation.saved.length, 0, name);
    }
  }
});

test("a copy that justifies a write is read twice and the two reads must agree: a flipped byte in the first read stops flash and erase before anything is asked or written", async () => {
  const disk = smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]);
  for (const [label, attempt, verb] of [["flash", (hardware) => flashRun(hardware, "eight", imageOf(8 * SECTOR, 18)), "written"], ["erase", (hardware) => eraseRun(hardware, "eight"), "erased"]]) {
    // The partition's first read is the 4th of the operation: the primary table (2) and the last sector (1) come first.
    const hardware = device({ mode: "firehose", disk, readFault: { flip: 100, atRead: 4, once: true } });
    const operation = attempt(hardware);
    await assert.rejects(operation.promise, (error) => error instanceof EdlError && new RegExp(`^eight read back as different bytes the second time \\(SHA-256 [0-9a-f]{64}, then [0-9a-f]{64}\\), so the saved copy cannot be trusted\\. Nothing was ${verb}\\.$`).test(error.message), label);
    assert.deepEqual(hardware.writes, [], label);
    assert.equal(operation.confirmations.length, 0, `${label}: the user was never asked`);
  }
});

test("a whole message that completes the byte count ends exactly on a transfer end and repeats on every read, so only the message check can refuse it", async () => {
  const disk = smallDisk([{ name: "eight", sectors: 8 }, { name: "boot_a", sectors: 64 }]);
  // No `once`: the programmer does this on every read from the 4th on, so a second read agrees with the first.
  const hardware = device({ mode: "firehose", disk, readFault: { swallowLog: "INFO: ".padEnd(1400, "x"), atRead: 4 } });
  const operation = flashRun(hardware, "eight", imageOf(8 * SECTOR, 19));
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /1468 byte\(s\) of the sector data, starting at byte 2628 of 4096, are a complete message from the programmer/.test(error.message));
  assert.deepEqual(hardware.writes, []);
  assert.equal(operation.confirmations.length, 0);
});
