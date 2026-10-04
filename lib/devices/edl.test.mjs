import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { buildDisk, edlContext, fakeEdlDevice, loaderImage, SECTOR, sha256 } from "./edl.test-helper.mjs";

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
  assert.deepEqual([...edlFlasher.actions], ["detect", "dump", "exec"]);
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
  assert.equal(output.filter((line) => /^PASS /.test(line)).length, 6);
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

test("the span check fails when the programmer will not read the last sector it reports", async () => {
  const hardware = device({ totalBlocks: 2048 + 100 });
  const { result } = await exec(hardware, "check", withLoader);
  assert.equal(result.verified, false);
  assert.match(result.summary, /reports 2148/);
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
  assert.deepEqual(["connect", "load", "getstorageinfo", "printgpt", "gpt", "check", "span", "reset", "reboot", "EDL connect", "  Connect "].map((word) => parseEdlCommand(word)), ["connect", "connect", "connect", "printgpt", "printgpt", "check", "check", "reset", "reset", "connect", "connect"]);
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

test("flash, push and the other actions EDL does not have are refused", async () => {
  for (const action of ["flash", "push", "pull", "monitor", "sideload", "verify", "forward", "reverse", "install"]) {
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
});
