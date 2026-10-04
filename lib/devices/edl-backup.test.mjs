import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
import { buildDisk, DISK_GUID, edlContext, fakeEdlDevice, loaderImage, patchGptHeader, SECTOR, sha256 } from "./edl.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { edlFlasher } = await jiti.import("./edl.ts");
const { edlTimeouts, EdlError } = await jiti.import("./edl-link.ts");
const manifestModule = await jiti.import("./edl-manifest.ts");

Object.assign(edlTimeouts, { greetingQuiet: 20, nopQuiet: 20, firstContact: 60, probe: 150, greeting: 200, nop: 400 });

const LOADER = loaderImage(9000);
const PARTITIONS = [
  { name: "boot_a", sectors: 64 },
  { name: "system_a", sectors: 300 },
  { name: "persist", sectors: 40 },
  { name: "userdata", sectors: 500 },
];
// Sectors: boot_a 34-97, system_a 98-397, persist 398-437, userdata 438-937; primary table 0-33; backup table 2015-2047.
const built = (overrides = {}) => buildDisk({ sectors: 2048, partitions: PARTITIONS, ...overrides });
const device = (options = {}) => fakeEdlDevice({ loader: LOADER, disk: built().disk, ...options });
const withLoader = { input: new Blob([LOADER]) };
const PK_HASH = createHash("sha256").update("oem root key").digest("hex");

const run = (hardware, request, options = {}) => {
  const env = edlContext(hardware, options);
  const promise = edlFlasher.run({ protocol: "edl", ...request }, env.context);
  return { promise, ...env };
};
const finish = async (hardware, request, options) => {
  const operation = run(hardware, request, options);
  return { result: await operation.promise, ...operation };
};
const said = (output, pattern) => output.some((line) => pattern.test(line));
const slice = (disk, first, sectors) => disk.subarray(first * SECTOR, (first + sectors) * SECTOR);
const programsOf = (hardware) => hardware.writes.filter((entry) => entry.tag === "program");
const startOf = (entry) => Number(entry.attributes.start_sector);

const BACKUP = { action: "exec", command: "backup", fileId: "loader", sha256: sha256(LOADER) };
const restoreRequest = (manifestSha256, extra = {}) => ({ action: "exec", command: "restore", fileId: "loader", sha256: sha256(LOADER), options: { manifestSha256 }, ...extra });

/** A backup set taken from a healthy unit, and the session files it left. */
async function takeSet(options = {}) {
  const hardware = device(options);
  const saved = [];
  const taken = await finish(hardware, BACKUP, { ...withLoader, saved });
  const manifestFile = saved.find((file) => file.name.endsWith(".manifest.json"));
  return { hardware, saved, result: taken.result, confirmations: taken.confirmations, output: taken.output, manifestSha: taken.result.sha256, manifest: JSON.parse(manifestFile.bytes.toString()), original: Buffer.from(hardware.disk) };
}

/** The same unit after something went wrong with it: boot_a overwritten, part of system_a overwritten, both tables altered but intact. */
function damage(original) {
  const disk = Buffer.from(original);
  disk.fill(0xee, 34 * SECTOR, 98 * SECTOR);
  disk.fill(0xdd, 100 * SECTOR, 120 * SECTOR);
  for (const lba of [1, 2047]) patchGptHeader(disk, lba, (header) => header.writeUInt32LE(7, 20));
  return disk;
}

// ---- backup ----------------------------------------------------------------------------------------------------------

test("a backup set saves both partition tables and every partition, and a manifest that names each by SHA-256 and says which unit they came from", async () => {
  const { hardware, saved, result, confirmations, manifest, manifestSha } = await takeSet();
  const disk = hardware.disk;

  assert.equal(result.verified, true);
  const manifestFile = saved.find((file) => file.name.endsWith(".manifest.json"));
  assert.equal(result.fileId, manifestFile.id);
  assert.equal(result.sha256, sha256(manifestFile.bytes));
  assert.equal(manifestFile.name, `edl-1a2b3c4d-set-${manifestSha.slice(0, 8)}.manifest.json`);
  assert.match(result.summary, new RegExp(`Backup set ${manifestSha.slice(0, 8)} saved: 4 partition\\(s\\) and both partition tables of disk ${DISK_GUID}`));
  assert.ok(result.summary.includes(manifestSha));

  assert.deepEqual(confirmations.map((risk) => risk.action), ["edl load programmer", "edl backup"]);
  assert.equal(confirmations[1].target, `backup set of disk ${DISK_GUID}`);
  assert.match(confirmations[1].backup, /^Not applicable: read-only/);
  assert.match(confirmations[1].details, new RegExp(`Read both partition tables and 4 partition\\(s\\) of disk ${DISK_GUID}, 485\\.5 KiB`));

  const file = (name) => saved.find((entry) => entry.name === `edl-1a2b3c4d-set-${name}.bin`);
  assert.ok(file("gpt-primary").bytes.equals(slice(disk, 0, 34)));
  assert.ok(file("gpt-backup").bytes.equals(slice(disk, 2015, 33)));
  for (const [index, name, first, sectors] of [[0, "boot_a", 34, 64], [1, "system_a", 98, 300], [2, "persist", 398, 40], [3, "userdata", 438, 500]]) {
    assert.ok(file(`p${index}-${name}`).bytes.equals(slice(disk, first, sectors)), name);
  }

  assert.equal(manifest.format, "cody-edl-backup-set");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.unit, { chipSerial: "1a2b3c4d", chipSerialSource: "boot-rom", hardwareId: "000460e100020000", pkHash: PK_HASH, emmcSerial: "3731524394", emmcProduct: "HBG4a2", diskGuid: DISK_GUID });
  assert.deepEqual(manifest.geometry, { sectorSize: 512, measuredSectors: 2048 });
  assert.equal(manifest.programmer.loaderSha256, sha256(LOADER));
  assert.deepEqual({ ...manifest.gpt.primary, fileName: undefined }, { firstLba: 0, sectors: 34, sha256: sha256(slice(disk, 0, 34)), fileName: undefined });
  assert.deepEqual({ ...manifest.gpt.backup, fileName: undefined }, { firstLba: 2015, sectors: 33, sha256: sha256(slice(disk, 2015, 33)), fileName: undefined });
  assert.deepEqual(manifest.partitions.map((part) => [part.index, part.name, part.firstLba, part.sectors, part.sha256]), [
    [0, "boot_a", 34, 64, sha256(slice(disk, 34, 64))],
    [1, "system_a", 98, 300, sha256(slice(disk, 98, 300))],
    [2, "persist", 398, 40, sha256(slice(disk, 398, 40))],
    [3, "userdata", 438, 500, sha256(slice(disk, 438, 500))],
  ]);
  assert.equal(manifest.restorable, true);
  assert.deepEqual(manifest.notRestorableBecause, []);

  assert.deepEqual(hardware.writes, [], "a backup only reads");
  assert.deepEqual(hardware.forbidden, []);
  assert.equal(manifestModule.parseManifest(manifestFile.bytes.toString()).unit.diskGuid, DISK_GUID, "what is saved is what a restore parses");
});

test("a set taken while a programmer was already running is saved but says it cannot be restored, and a restore refuses it before touching the device", async () => {
  const taken = await takeSet({ mode: "firehose" });
  assert.equal(taken.manifest.restorable, false);
  assert.equal(taken.manifest.unit.pkHash, null);
  assert.equal(taken.manifest.unit.chipSerial, "1a2b3c4d");
  assert.equal(taken.manifest.unit.chipSerialSource, "programmer");
  assert.match(taken.manifest.notRestorableBecause.join(" "), /public-key hash was not read/);
  assert.match(taken.result.summary, /NOT RESTORABLE by Cody: .*public-key hash/);
  assert.match(taken.confirmations[0].details, /WARNING: a programmer was already running.*Cody will NOT restore/s);

  const unit = device();
  const attempt = run(unit, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  await assert.rejects(attempt.promise, (error) => error instanceof EdlError && error.kind === "refused" && /does not record the boot ROM's public-key hash.*will not restore it/s.test(error.message));
  assert.equal(unit.saharaLog.length, 0, "the device was never spoken to");
  assert.deepEqual(unit.writes, []);
});

test("a backup set is refused when the partition tables are damaged or disagree with the disk, and saves nothing", async () => {
  const hardware = device({ disk: built({ badBackup: true }).disk });
  const operation = run(hardware, BACKUP, { ...withLoader });
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && error.kind === "refused" && /Refusing the backup set: the span check failed.*Nothing was saved/s.test(error.message));
  assert.deepEqual(operation.saved, []);
  assert.deepEqual(operation.confirmations.map((risk) => risk.action), ["edl load programmer"], "the user was never asked about a set");
});

test("a backup set takes no target, offset, length or options, and says so before reading anything", async () => {
  const hardware = device({ mode: "firehose" });
  for (const extra of [{ target: "boot_a" }, { offset: 0 }, { length: 512 }, { options: { sectors: 2048 } }]) {
    await assert.rejects(run(hardware, { action: "exec", command: "backup", ...extra }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /Nothing was read/.test(error.message));
  }
  assert.equal(hardware.commands.filter((entry) => entry.tag === "read").length, 0);
});

test("declining the backup question saves no partition; cancelling part-way leaves no manifest and says what was kept", async () => {
  const declined = device({ mode: "firehose" });
  const refusal = run(declined, { action: "exec", command: "backup" }, { approve: false });
  await assert.rejects(refusal.promise, (error) => error.name === "AbortError");
  assert.deepEqual(refusal.saved, []);

  const controller = new AbortController();
  const hardware = device({ mode: "firehose" });
  const operation = run(hardware, { action: "exec", command: "backup" }, { signal: controller.signal, onProgress: (event) => { if (event.phase === "read" && /Reading system_a/.test(event.message ?? "")) controller.abort(); } });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.ok(operation.saved.some((file) => file.name.endsWith("-set-gpt-primary.bin")));
  assert.ok(operation.saved.some((file) => file.name.endsWith("-set-p0-boot_a.bin")), "a part that was read completely stays");
  assert.ok(!operation.saved.some((file) => file.name.endsWith(".manifest.json")), "no manifest, so no set");
  assert.ok(!operation.saved.some((file) => /system_a/.test(file.name)), "the part that was being read left nothing");
  assert.ok(said(operation.output, /Stopped after saving 2 file\(s\)\. There is no manifest, so there is no usable set/));
});

test("a partition Cody would never write makes the set not restorable, and the restore refuses it by name", async () => {
  const disk = buildDisk({ sectors: 2048, partitions: [{ name: "boot_a", sectors: 64 }, { name: "boot0", sectors: 32 }] }).disk;
  const taken = await takeSet({ disk });
  assert.equal(taken.manifest.restorable, false);
  assert.match(taken.manifest.notRestorableBecause.join(" "), /named like an eMMC boot area or RPMB.*A restore would have to write boot0/s);
  const unit = fakeEdlDevice({ loader: LOADER, disk });
  await assert.rejects(run(unit, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /named like an eMMC boot area or RPMB.*would write boot0.*Nothing was written/s.test(error.message));
  assert.equal(unit.saharaLog.length, 0);
});

// ---- restore: the whole thing ---------------------------------------------------------------------------------------------

test("a restore puts a damaged unit back byte for byte: identity first, what it overwrites saved before the one typed approval, partitions then the backup table then the primary table, each read back", async () => {
  const taken = await takeSet();
  const broken = damage(taken.original);
  const hardware = device({ disk: broken });
  const askedWith = [];
  const { result, confirmations, output, progress } = await finish(hardware, restoreRequest(taken.manifestSha), {
    ...withLoader,
    saved: taken.saved,
    approve: async (risk) => { askedWith.push([risk.action, taken.saved.map((file) => file.name).filter((name) => name.includes("-restore-"))]); },
  });

  assert.equal(result.verified, true);
  assert.ok(hardware.disk.equals(taken.original), "the disk is exactly what the set holds");
  assert.deepEqual(hardware.forbidden, []);
  assert.equal(hardware.loaderAccepted, true);

  assert.deepEqual(confirmations.map((risk) => risk.action), ["edl load programmer", "edl restore"], "the loader, then ONE restore approval");
  const [, risk] = confirmations;
  const short = taken.manifestSha.slice(0, 8);
  assert.equal(risk.protectedOverride, `restore:${short}`);
  assert.equal(risk.target, `disk ${DISK_GUID}`);
  assert.equal(risk.sha256, undefined, "the request's own digest (the loader's) is the only payload digest");
  assert.match(risk.details, new RegExp(`Restore backup set ${short} \\(manifest SHA-256 ${taken.manifestSha}`));
  assert.match(risk.details, /Cody will OVERWRITE 4 of 6 region\(s\)/);
  assert.match(risk.details, /boot_a, system_a, the backup partition table, the primary partition table/);
  assert.match(risk.details, /Already identical and left alone: persist, userdata/);
  assert.match(risk.details, /Order: partitions first, then the backup partition table, then the primary partition table last/);
  assert.match(risk.details, new RegExp(`Type restore:${short} to approve`));
  assert.match(risk.details, /Write grant for restore set .*: Cody may write only sectors 0-397, 2015-2047 of the eMMC user area \(physical partition 0; 431 sectors of 512 bytes in all\)/);
  assert.match(risk.backup, /Saved the current contents of the 4 region\(s\) it will overwrite/);
  assert.equal(risk.details.length < 8 * 1024, true);

  const pre = (slug) => taken.saved.find((file) => file.name === `edl-1a2b3c4d-restore-${short}-${slug}.pre.bin`);
  assert.ok(pre("p0-boot_a").bytes.equals(slice(broken, 34, 64)), "the saved copy is what the device held");
  assert.ok(pre("p1-system_a").bytes.equals(slice(broken, 98, 300)));
  assert.ok(pre("gpt-primary").bytes.equals(slice(broken, 0, 34)));
  assert.ok(pre("gpt-backup").bytes.equals(slice(broken, 2015, 33)));
  assert.deepEqual(askedWith.find(([action]) => action === "edl restore")[1].length, 4, "every region that differs was saved BEFORE the user was asked");
  assert.equal(taken.saved.some((file) => /-restore-.*-(p2-persist|p3-userdata)\./.test(file.name)), false, "a region that already matches needs no copy: the set is its copy");

  // Partitions in disk order, the backup table next, the primary table last; identical regions are not touched.
  assert.deepEqual(programsOf(hardware).map(startOf), [34, 98, 2015, 0]);
  // Each region was read back right after it was written, before the next one began.
  const sequence = hardware.commands.filter((entry) => entry.tag === "program" || entry.tag === "read");
  const afterEscrow = sequence.slice(sequence.findIndex((entry) => entry.tag === "program"));
  assert.deepEqual(afterEscrow.map((entry) => `${entry.tag}:${entry.attributes.start_sector}:${entry.attributes.num_partition_sectors}`), [
    "program:34:64", "read:34:64", "program:98:300", "read:98:300", "program:2015:33", "read:2015:33", "program:0:34", "read:0:34",
  ]);

  assert.match(result.summary, new RegExp(`Restored backup set ${short} to disk ${DISK_GUID}: 4 region\\(s\\) written and read back identical \\(boot_a, system_a, the backup partition table, the primary partition table\\), 2 already identical and left alone\\. The partition tables were written last`));
  assert.deepEqual(result.details.written.map((entry) => entry.label), ["boot_a", "system_a", "the backup partition table", "the primary partition table"]);
  assert.deepEqual(result.details.alreadyIdentical, ["persist", "userdata"]);
  assert.ok(said(output, /Unit check passed/));
  assert.ok(said(output, /Wrote boot_a \(sectors 34-97.*\) and read it back identical/));
  assert.ok(said(output, /Already identical, left alone: persist, userdata/));
  const phases = new Set(progress.map((event) => event.phase));
  for (const phase of ["check", "escrow", "write", "verify"]) assert.ok(phases.has(phase), `progress reports ${phase}`);
});

test("a restore that finds the unit already matching the set writes nothing and asks nothing beyond the loader", async () => {
  const taken = await takeSet();
  const hardware = device();
  const { result, confirmations } = await finish(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  assert.equal(result.verified, true);
  assert.match(result.summary, /^Nothing to restore: all 6 region\(s\) the set covers already hold exactly the set's bytes/);
  assert.deepEqual(confirmations.map((risk) => risk.action), ["edl load programmer"]);
  assert.deepEqual(hardware.writes, []);
  assert.equal(taken.saved.some((file) => file.name.includes("-restore-")), false, "nothing differed, so nothing was copied");
});

test("declining the restore approval leaves the unit as it was, with the saved copies in the session", async () => {
  const taken = await takeSet();
  const broken = damage(taken.original);
  const hardware = device({ disk: broken });
  const operation = run(hardware, restoreRequest(taken.manifestSha), {
    ...withLoader,
    saved: taken.saved,
    approve: async (risk) => { if (risk.action === "edl restore") throw new DOMException("Operation cancelled.", "AbortError"); },
  });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.deepEqual(hardware.writes, []);
  assert.ok(hardware.disk.equals(broken));
  assert.ok(taken.saved.some((file) => file.name.includes("-restore-")), "the copies were already saved");
});

test("a unit whose primary table is damaged is identified by its intact backup table and restored", async () => {
  const taken = await takeSet();
  const broken = Buffer.from(taken.original);
  broken.fill(0, SECTOR, 2 * SECTOR);
  broken.fill(0xaa, 34 * SECTOR, 98 * SECTOR);
  const hardware = device({ disk: broken });
  const { result, output } = await finish(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  assert.equal(result.verified, true);
  assert.ok(hardware.disk.equals(taken.original));
  assert.ok(said(output, /Note: The primary partition table on the device cannot be read.*The other table identifies the disk/));
  assert.deepEqual(programsOf(hardware).map(startOf), [34, 0]);
});

test("a protected partition among those overwritten is named in the question; the approval is the typed set digest either way", async () => {
  const taken = await takeSet();
  const broken = Buffer.from(taken.original);
  broken.fill(0x55, 398 * SECTOR, 438 * SECTOR);
  const { confirmations } = await finish(device({ disk: broken }), restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  const risk = confirmations.find((entry) => entry.action === "edl restore");
  assert.match(risk.details, /PROTECTED partitions among them \(boot chain, radio or identity data\): persist\./);
  assert.equal(risk.protectedOverride, `restore:${taken.manifestSha.slice(0, 8)}`);
});

// ---- restore: the wrong unit -------------------------------------------------------------------------------------------------

test("a set from another unit is refused for each identity that differs, naming both values; the boot ROM's two are checked before any loader is sent", async () => {
  const taken = await takeSet();
  const guidElsewhere = (disk) => {
    for (const lba of [1, 2047]) patchGptHeader(disk, lba, (header) => Buffer.from("AAAAAAAAAAAAAAAA").copy(header, 56));
    return disk;
  };
  const cases = [
    ["chip serial", { serial: 0x11111111 }, /another unit - chip serial number: the set is from 0x1a2b3c4d, this device reports 0x11111111\. No loader was sent/, false],
    ["public-key hash", { pkHash: Buffer.alloc(32, 7) }, /another unit - public-key hash: the set is from [0-9a-f]{64}, this device reports 0707070707/, false],
    ["public-key hash the boot ROM will not give", { refuseExecute: [3] }, /another unit - public-key hash: the boot ROM did not report one, so it cannot be compared\. No loader was sent/, false],
    ["eMMC serial", { emmcSerial: 42 }, /does not match the unit Cody is talking to - eMMC serial number: the set is from 3731524394, this device reports 42\. The programmer is running .* nothing was written/, true],
    ["disk GUID", { disk: guidElsewhere(Buffer.from(taken.original)) }, /disk GUID: the set is from 12345678-ABCD-4321-9876-0123456789AB, the device's partition tables say 41414141-4141-4141-4141-414141414141/, true],
    ["capacity", { totalBlocks: 4096, disk: Buffer.concat([taken.original, Buffer.alloc(2048 * SECTOR, 0x33)]) }, /capacity: the set is from a disk of 2048 sectors, this device reports 4096/, true],
  ];
  for (const [label, options, pattern, loaderSent] of cases) {
    const hardware = device(options);
    const before = taken.saved.length;
    const operation = run(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
    await assert.rejects(operation.promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
    assert.deepEqual(hardware.writes, [], `${label}: nothing written`);
    assert.equal(hardware.loaderAccepted, loaderSent, `${label}: loader sent or not`);
    assert.equal(operation.confirmations.some((risk) => risk.action === "edl load programmer"), loaderSent, `${label}: loader confirmation`);
    assert.equal(operation.confirmations.some((risk) => risk.action === "edl restore"), false, `${label}: never asked to restore`);
    assert.equal(taken.saved.length, before, `${label}: nothing was even saved from the device`);
  }
});

test("a unit whose partition tables are both unusable cannot be confirmed as the set's, so it is refused with nothing written", async () => {
  const taken = await takeSet();
  const broken = Buffer.from(taken.original);
  broken.fill(0, SECTOR, 2 * SECTOR);
  broken.fill(0, 2047 * SECTOR, 2048 * SECTOR);
  const hardware = device({ disk: broken });
  await assert.rejects(run(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /disk GUID: neither partition table on the device is intact, so whose disk this is cannot be confirmed/.test(error.message));
  assert.deepEqual(hardware.writes, []);
});

test("a restore needs a boot ROM it can identify: a programmer that is already running is refused, and a request without a loader never starts", async () => {
  const taken = await takeSet();
  const running = device({ mode: "firehose", disk: damage(taken.original) });
  await assert.rejects(run(running, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved }).promise, (error) => error instanceof EdlError && error.kind === "refused" && /A programmer is already running, so the boot ROM's identity.*Put the device into EDL mode again/s.test(error.message));
  assert.deepEqual(running.writes, []);
  const bare = device();
  await assert.rejects(run(bare, { ...restoreRequest(taken.manifestSha), fileId: undefined }, { saved: taken.saved }).promise, /needs the programmer \(loader\) file/);
  assert.equal(bare.saharaLog.length, 0);
});

// ---- restore: the set itself -------------------------------------------------------------------------------------------------

test("a restore is refused before the device is touched when the request is malformed or the set is not all in the session", async () => {
  const taken = await takeSet();
  const hardware = device({ disk: damage(taken.original) });
  const refuses = async (request, options, pattern, label) => {
    await assert.rejects(run(hardware, request, { ...withLoader, saved: taken.saved, ...options }).promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
  };
  await refuses({ ...restoreRequest(taken.manifestSha), target: "boot_a" }, {}, /takes no target, offset or length/, "target");
  await refuses({ ...restoreRequest(taken.manifestSha), options: { manifestSha256: taken.manifestSha, approved: true } }, {}, /takes only options\.manifestSha256; approved is not accepted/, "extra option");
  await refuses({ ...restoreRequest("abc") }, {}, /options\.manifestSha256 must be the SHA-256/, "short digest");
  await refuses({ action: "exec", command: "restore", fileId: "loader", sha256: sha256(LOADER) }, {}, /options\.manifestSha256 must be/, "no manifest");
  await refuses(restoreRequest("0".repeat(64)), {}, /This session has no file with SHA-256 0{64}/, "unknown manifest");
  const noLookup = edlContext(hardware, { ...withLoader, saved: taken.saved });
  delete noLookup.context.findArtifact;
  await assert.rejects(edlFlasher.run({ protocol: "edl", ...restoreRequest(taken.manifestSha) }, noLookup.context), /cannot look up the saved files of a backup set/);

  // One saved part gone from the session.
  const without = taken.saved.filter((file) => !file.name.includes("-set-p1-system_a"));
  await refuses(restoreRequest(taken.manifestSha), { saved: without }, /The session is missing 1 file\(s\) of this backup set: system_a \([0-9a-f]{12}…\)/, "missing part");
  assert.equal(hardware.saharaLog.length, 0, "none of these reached the device");
  assert.deepEqual(hardware.writes, []);
});

test("a saved file whose bytes no longer match the manifest is refused, and so is a manifest that disagrees with the saved partition tables", async () => {
  const taken = await takeSet();
  const hardware = device({ disk: damage(taken.original) });
  const env = edlContext(hardware, { ...withLoader, saved: taken.saved });
  const lookup = env.context.findArtifact;
  const target = taken.manifest.partitions[0];
  env.context.findArtifact = async (digest) => (digest === target.sha256 ? new Blob([Buffer.alloc(target.sectors * SECTOR, 0x99)]) : lookup(digest));
  await assert.rejects(edlFlasher.run({ protocol: "edl", ...restoreRequest(taken.manifestSha) }, env.context), /The saved file for boot_a no longer has the SHA-256 the manifest names/);

  // A hand-edited manifest is another file with another digest; the saved tables still say what they say.
  const edit = (change) => {
    const copy = JSON.parse(JSON.stringify(taken.manifest));
    change(copy);
    const bytes = Buffer.from(JSON.stringify(copy, null, 2));
    taken.saved.push({ id: `edited-${taken.saved.length}`, name: "edited.manifest.json", bytes, sha256: sha256(bytes) });
    return sha256(bytes);
  };
  const refuses = (digest, pattern, label) => assert.rejects(run(hardware, restoreRequest(digest), { ...withLoader, saved: taken.saved }).promise, (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
  await refuses(edit((m) => { m.partitions[2].name = "persist_renamed"; }), /manifest's partition list is not the one in the saved partition table/, "a renamed partition");
  await refuses(edit((m) => { m.partitions[1].firstLba += 1; m.partitions[1].sectors -= 1; }), /The saved file for system_a is 153600 bytes, but the set describes 153088/, "a partition resized in the manifest only");
  await refuses(edit((m) => { m.unit.diskGuid = "AAAAAAAA-0000-4000-8000-000000000001"; }), /manifest names disk AAAAAAAA-0000-4000-8000-000000000001 but the saved partition table belongs to disk 12345678-ABCD/, "another disk's GUID");
  await refuses(edit((m) => { m.gpt.primary.sectors -= 1; }), /The saved file for the primary partition table is 17408 bytes, but the set describes 16896/, "a table region cut short in the manifest");
  await refuses(edit((m) => { m.geometry.measuredSectors = 4096; m.gpt.backup.firstLba = 4096 - 33; }), /do not describe a disk of 4096 sectors consistently/, "a disk of another size");
  assert.deepEqual(hardware.writes, []);
  assert.equal(hardware.saharaLog.length, 0, "none of these reached the device");
});

test("a manifest that is not one, or that cannot be trusted, is refused with the reason", () => {
  const { parseManifest } = manifestModule;
  const good = JSON.stringify({
    format: "cody-edl-backup-set", version: 1, createdAt: "2026-10-04T00:00:00Z",
    unit: { chipSerial: "1a2b3c4d", chipSerialSource: "boot-rom", hardwareId: null, pkHash: PK_HASH, emmcSerial: "1", emmcProduct: null, diskGuid: DISK_GUID },
    geometry: { sectorSize: 512, measuredSectors: 2048 }, programmer: { target: null, loaderSha256: null },
    gpt: { primary: { firstLba: 0, sectors: 34, sha256: "a".repeat(64), fileName: "p" }, backup: { firstLba: 2015, sectors: 33, sha256: "b".repeat(64), fileName: "b" } },
    partitions: [{ index: 0, name: "boot_a", firstLba: 34, sectors: 64, sha256: "c".repeat(64), fileName: "x" }],
    restorable: true, notRestorableBecause: [],
  });
  assert.equal(parseManifest(good).partitions[0].name, "boot_a");
  const change = (edit) => { const copy = JSON.parse(good); edit(copy); return JSON.stringify(copy); };
  const refused = (text, pattern, label) => assert.throws(() => parseManifest(text), (error) => error instanceof EdlError && error.kind === "refused" && pattern.test(error.message), label);
  refused("not json", /not valid JSON/, "text");
  refused("{}", /not a Cody EDL backup set manifest/, "format");
  refused(change((m) => { m.version = 2; }), /version 2, which this Cody does not understand/, "version");
  refused(change((m) => { m.partitions = []; }), /partitions must be a list of 1 to 1024 partitions/, "no partitions");
  refused(change((m) => { m.partitions[0].sha256 = "xyz"; }), /partitions\[0\]\.sha256 must be a SHA-256/, "digest");
  refused(change((m) => { m.partitions.push({ ...m.partitions[0], firstLba: 200 }); }), /partitions\[1\]\.index must be unique/, "duplicate index");
  refused(change((m) => { m.partitions[0].sectors = 5000; }), /partitions\[0\] must be inside the disk/, "beyond the disk");
  refused(change((m) => { m.gpt.backup.firstLba = 2000; }), /gpt\.backup must be the region that ends at the disk's last sector/, "backup not at the end");
  refused(change((m) => { m.gpt.primary.firstLba = 1; }), /gpt\.primary\.firstLba must be 0/, "primary not at the start");
  refused(change((m) => { m.unit.diskGuid = "nope"; }), /unit\.diskGuid must be a GUID/, "guid");
  refused(change((m) => { m.unit.pkHash = "zz"; }), /unit\.pkHash must be hex digits/, "hash");
  refused(change((m) => { m.geometry.sectorSize = 1024; }), /geometry\.sectorSize must be 512 or 4096/, "sector size");
  refused(change((m) => { m.partitions[0].name = "a\nb"; }), /partitions\[0\]\.name must be text of 0 to 80 characters without control characters/, "control characters in a name");
  refused(`${" ".repeat(1024 * 1024)}{}`, /far smaller/, "size");
  assert.equal(parseManifest(change((m) => { m.partitions[0].name = ""; })).partitions[0].name, "", "an unnamed partition is allowed");
});

// ---- restore: when it goes wrong half-way ------------------------------------------------------------------------------------

test("a device that leaves the bus part-way through a restore says which regions are done, which is in doubt, which were never started, and that the tables were not written", async () => {
  const taken = await takeSet();
  const broken = damage(taken.original);
  const hardware = device({ disk: broken, writeFault: { dieAfterSectors: 100 } });
  const operation = run(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  await assert.rejects(operation.promise, (error) => error instanceof EdlError
    && /POSSIBLY MODIFIED: the write to disk 12345678-ABCD-4321-9876-0123456789AB stopped \(the device left the USB bus\) after 64 of 431 sectors were acknowledged; a block of 300 sector\(s\) was in flight/.test(error.message)
    && /Written and read back identical: boot_a\. POSSIBLY MODIFIED \(being written\): system_a\. Not started: the backup partition table, the primary partition table\. Neither partition table was written\./.test(error.message)
    && /The previous contents of every region this restore overwrites are saved: boot_a → file-\d+, system_a → file-\d+, the backup partition table → file-\d+, the primary partition table → file-\d+\./.test(error.message)
    && /Nothing was retried\. To undo a partition, flash its saved copy back/.test(error.message));
  assert.ok(hardware.disk.subarray(SECTOR, 2 * SECTOR).equals(broken.subarray(SECTOR, 2 * SECTOR)), "the primary table was never touched");
  assert.deepEqual(programsOf(hardware).map(startOf), [34, 98]);
});

test("a region that reads back different stops the restore there: nothing after it is written, and the partition tables stay as they were", async () => {
  const taken = await takeSet();
  const broken = damage(taken.original);
  const hardware = device({ disk: broken, writeFault: { corrupt: { atWrite: 2, offset: 100 } } });
  const operation = run(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && error.kind === "protocol"
    && new RegExp(`READ-BACK MISMATCH on system_a: the programmer acknowledged every block, but the region reads back as SHA-256 [0-9a-f]{64}, not ${taken.manifest.partitions[1].sha256}`).test(error.message)
    && /Written and read back identical: boot_a\. POSSIBLY MODIFIED \(written, but read back different\): system_a\. Not started: the backup partition table, the primary partition table\. Neither partition table was written/.test(error.message));
  assert.deepEqual(programsOf(hardware).map(startOf), [34, 98], "the tables were not written");
  assert.ok(hardware.disk.subarray(SECTOR, 2 * SECTOR).equals(broken.subarray(SECTOR, 2 * SECTOR)));
  assert.ok(said(operation.output, /READ-BACK MISMATCH on system_a/));
});

test("a programmer that will not read a region back stops the restore as UNVERIFIED rather than carrying on to the tables", async () => {
  const taken = await takeSet();
  // Reads so far: 4 for the identity (both tables), 6 to see which regions differ and 4 saved copies; read 15 is the first read-back.
  const hardware = device({ disk: damage(taken.original), readFault: { nak: true, atRead: 15, once: true } });
  const operation = run(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /UNVERIFIED: the programmer would not read boot_a back .*so the restore stopped there.*POSSIBLY MODIFIED \(written, being read back\): boot_a\. Not started: system_a/s.test(error.message));
  assert.deepEqual(programsOf(hardware).map(startOf), [34], "nothing after the unverified region was written");
});

test("a programmer that gives different bytes for the same region on two reads is not trusted to supply the saved copy: nothing is written and the user is never asked", async () => {
  const taken = await takeSet();
  // Reads 1-4 are the identity, 5-10 the check of every region; read 11 is the first saved copy.
  const hardware = device({ disk: damage(taken.original), readFault: { flip: 100, atRead: 11, once: true } });
  const operation = run(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  await assert.rejects(operation.promise, (error) => error instanceof EdlError && /boot_a read back as different bytes the second time \(SHA-256 [0-9a-f]{64}, then [0-9a-f]{64}\), so the saved copy cannot be trusted\. Nothing was written\./.test(error.message));
  assert.deepEqual(hardware.writes, []);
  assert.equal(operation.confirmations.some((risk) => risk.action === "edl restore"), false);
});

test("cancelling between two regions stops cleanly after the one that was verified; cancelling during a read-back is reported as unverified, not as success", async () => {
  const taken = await takeSet();
  const broken = damage(taken.original);

  const between = new AbortController();
  const first = device({ disk: broken });
  const operation = run(first, restoreRequest(taken.manifestSha), {
    ...withLoader,
    saved: taken.saved,
    signal: between.signal,
    onOutput: (line) => { if (/^Wrote boot_a /.test(line)) between.abort(); },
  });
  await assert.rejects(operation.promise, (error) => error.name === "AbortError");
  assert.deepEqual(programsOf(first).map(startOf), [34], "the second region was never started");
  assert.ok(said(operation.output, /POSSIBLY MODIFIED: the write to disk .* stopped \(the operation was cancelled\) after 64 of 431 sectors were acknowledged/));
  assert.ok(said(operation.output, /Written and read back identical: boot_a\..*Not started: system_a, the backup partition table, the primary partition table\. Neither partition table was written/));
  assert.equal(first.awaitingRawData, false, "the programmer is idle");

  const during = new AbortController();
  const second = device({ disk: broken });
  const readingBack = run(second, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved, signal: during.signal, onProgress: (event) => { if (event.phase === "verify" && event.completed === 0) during.abort(); } });
  await assert.rejects(readingBack.promise, (error) => error.name === "AbortError");
  assert.ok(said(readingBack.output, /POSSIBLY MODIFIED \(written, being read back\): boot_a/));
  assert.deepEqual(programsOf(second).map(startOf), [34]);
});

test("everything a whole restore sends is a read, or a program inside the ranges the user approved", async () => {
  const taken = await takeSet();
  const hardware = device({ disk: damage(taken.original) });
  await finish(hardware, restoreRequest(taken.manifestSha), { ...withLoader, saved: taken.saved });
  const tags = new Set(hardware.commands.map((entry) => entry.tag));
  assert.deepEqual([...tags].filter((tag) => !["nop", "configure", "getstorageinfo", "read", "program"].includes(tag)), []);
  for (const entry of programsOf(hardware)) assert.ok([34, 98, 2015, 0].includes(startOf(entry)), `program at ${startOf(entry)}`);
  assert.deepEqual(hardware.forbidden, []);
  assert.ok(hardware.writes.every((entry) => Number(entry.attributes.physical_partition_number) === 0));
});
