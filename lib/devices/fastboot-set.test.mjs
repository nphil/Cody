import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { fakeFastboot } from "./fastboot.test-helper.mjs";
import { patterned, sparseFile } from "./sparse.test-helper.mjs";
import { buildZip } from "./zip.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { fastbootFlasher } = await jiti.import("./fastboot.ts");
const { DeviceOperationManager } = await jiti.import("./operations.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function context(device, input, over = {}) {
  const ctx = {
    signal: new AbortController().signal,
    transport: device.transport,
    input,
    confirmations: [],
    saves: [],
    streams: [],
    outputs: [],
    events: [],
    progress: (event) => ctx.events.push(event),
    output: (text) => ctx.outputs.push(text),
    save: async (name, blob) => {
      ctx.saves.push({ name, blob });
      return `saved:${name}`;
    },
    saveStream: async (name, chunks) => {
      const parts = [];
      for await (const chunk of chunks) parts.push(Buffer.from(chunk));
      const bytes = Buffer.concat(parts);
      ctx.streams.push({ name, bytes });
      return { fileId: `stream:${name}`, sha256: sha256(bytes), length: bytes.length };
    },
    confirm: async (risk) => {
      ctx.confirmations.push(risk);
      await ctx.onConfirm?.(risk);
    },
    ...over,
  };
  return ctx;
}

const flash = (target, ctx, options) => fastbootFlasher.run({ protocol: "fastboot", action: "flash", target, options }, ctx);
const exec = (command, ctx) => fastbootFlasher.run({ protocol: "fastboot", action: "exec", command }, ctx);
const downloads = (device) => device.log.filter((entry) => entry.startsWith("download:")).map((entry) => Number.parseInt(entry.slice(9), 16));
const wrote = (device) => device.log.some((entry) => entry.startsWith("download:") || entry.startsWith("flash:") || entry.startsWith("erase:"));

// ---------------------------------------------------------------------------
// Automatic sparse splitting above max-download-size
// ---------------------------------------------------------------------------

test("an image larger than max-download-size is flashed as sparse pieces that each fit, then verified by readback", async () => {
  const image = patterned(10 * 4096, 7);
  const device = fakeFastboot({ variables: { product: "cronos" }, partitions: { boot: Buffer.alloc(0x10000, 0xaa) }, maxDownload: "0x3000" });
  const ctx = context(device, new Blob([image]));
  const result = await flash("boot", ctx);

  assert.equal(result.verified, true);
  assert.equal(result.details.pieces, 5);
  assert.equal(downloads(device).length, 5);
  assert.ok(downloads(device).every((size) => size <= 0x3000), "every download fits the limit the device reported");
  assert.deepEqual(device.log.filter((entry) => entry.startsWith("flash:")), Array(5).fill("flash:boot"));
  assert.ok(device.flashed.every((entry) => entry.sparse));
  assert.deepEqual(device.partitions.boot.subarray(0, image.length), image);
  assert.deepEqual(device.partitions.boot.subarray(image.length), Buffer.alloc(0x10000 - image.length, 0xaa), "blocks no piece carries are left alone");
  assert.match(ctx.confirmations[0].details, /sent as 5 sparse pieces/);
  assert.equal(ctx.confirmations[0].sha256, sha256(image), "the approval binds the original image, not a piece");
  assert.ok(device.log.indexOf("getvar:max-download-size") < device.log.indexOf("getvar:partition-size:boot"));
  assert.equal(device.log.at(-1), "fetch:boot:0:a000", "the readback compares the whole expanded image");
});

test("an image that fits max-download-size is still one plain download", async () => {
  const image = patterned(8192, 3);
  const device = fakeFastboot({ partitions: { boot: Buffer.alloc(0x10000, 0xaa) }, maxDownload: "0x3000" });
  const result = await flash("boot", context(device, new Blob([image])));
  assert.equal(result.details.pieces, 1);
  assert.deepEqual(downloads(device), [8192]);
  assert.equal(device.flashed[0].sparse, false);
});

test("max-download-size is read as fastboot reads it: hex with 0x, otherwise decimal, whitespace ignored", async () => {
  for (const reported of ["0x3000", "0X3000", "12288", " 0x3000\n"]) {
    const device = fakeFastboot({ variables: { "max-download-size": reported }, partitions: { boot: Buffer.alloc(0x10000, 0xaa) }, maxDownload: "0x3000" });
    const result = await flash("boot", context(device, new Blob([patterned(10 * 4096, 7)])));
    assert.equal(result.details.pieces, 5, `limit ${JSON.stringify(reported)}`);
  }
});

test("a limit Cody cannot read is treated as unreported, so the device's own refusal is what the user sees", async () => {
  const device = fakeFastboot({ variables: { "max-download-size": "huge" }, partitions: { boot: Buffer.alloc(0x10000, 0xaa) }, maxDownload: "0x3000" });
  await assert.rejects(flash("boot", context(device, new Blob([patterned(10 * 4096, 7)]))), /data too large/);
  assert.equal(downloads(device).length, 1, "one whole-image download was attempted, not a guess at a split");
});

test("a sparse image over the limit is resparsed, keeping its holes and fills", async () => {
  const image = sparseFile(4096, [
    { type: "raw", blocks: 5, data: patterned(5 * 4096, 11) },
    { type: "skip", blocks: 3 },
    { type: "fill", blocks: 2, pattern: Buffer.from([9, 8, 7, 6]) },
    { type: "raw", blocks: 2, data: patterned(2 * 4096, 12) },
  ]);
  assert.ok(image.length > 0x3000);
  const device = fakeFastboot({ partitions: { system: Buffer.alloc(0x10000, 0xcc) }, maxDownload: "0x3000" });
  const result = await flash("system", context(device, new Blob([image])));
  assert.equal(result.verified, true);
  assert.ok(result.details.pieces >= 3);
  const expected = Buffer.alloc(0x10000, 0xcc);
  expected.set(patterned(5 * 4096, 11), 0);
  for (let offset = 0; offset < 2 * 4096; offset += 4) expected.set([9, 8, 7, 6], 8 * 4096 + offset);
  expected.set(patterned(2 * 4096, 12), 10 * 4096);
  assert.deepEqual(device.partitions.system, expected);
});

test("a piece the device rejects stops the flash, says how far it got, and is never retried", async () => {
  const device = fakeFastboot({ partitions: { boot: Buffer.alloc(0x10000, 0xaa) }, maxDownload: "0x3000", failFlash: (_name, count) => count === 3 });
  await assert.rejects(flash("boot", context(device, new Blob([patterned(10 * 4096, 7)]))), /Sparse piece 3 of 5 failed after 2 piece\(s\) were written to boot.*write failed.*nothing was retried/s);
  assert.equal(device.log.filter((entry) => entry.startsWith("flash:")).length, 3);
  assert.equal(downloads(device).length, 3);
});

test("a limit too small to carry a block is refused before the partition is backed up or touched", async () => {
  const device = fakeFastboot({ partitions: { boot: Buffer.alloc(0x10000, 0xaa) }, maxDownload: "0x1000" });
  const ctx = context(device, new Blob([patterned(10 * 4096, 7)]));
  await assert.rejects(flash("boot", ctx), /needs at least 4160 bytes/);
  assert.equal(ctx.streams.length, 0, "no backup is made for a flash that cannot proceed");
  assert.equal(ctx.confirmations.length, 0);
  assert.equal(wrote(device), false);
});

// ---------------------------------------------------------------------------
// stage / get_staged
// ---------------------------------------------------------------------------

test("stage sends the chosen file to the bootloader's buffer and asks first", async () => {
  const device = fakeFastboot();
  const ctx = context(device, new Blob(["payload"]));
  const result = await exec("stage", ctx);
  assert.deepEqual(device.log, ["download:00000007"]);
  assert.equal(ctx.confirmations[0].action, "fastboot stage");
  assert.equal(ctx.confirmations[0].target, "fastboot-staging-buffer");
  assert.equal(ctx.confirmations[0].sha256, sha256("payload"));
  assert.equal(result.verified, false);
  await assert.rejects(exec("stage", context(device)), /needs an image artifact/);
});

test("get_staged reads back what the last command left, and reports a bootloader with nothing staged", async () => {
  const device = fakeFastboot();
  await exec("oem device-info", context(device));
  const ctx = context(device);
  const result = await exec("get_staged", ctx);
  assert.equal(ctx.streams[0].bytes.toString(), "output of oem device-info");
  assert.equal(result.sha256, sha256("output of oem device-info"));
  assert.equal(result.details.length, 25);
  assert.equal(ctx.confirmations[0].action, "fastboot get_staged");
  assert.deepEqual(device.log.slice(-1), ["upload"]);

  const empty = fakeFastboot();
  await assert.rejects(exec("get_staged", context(empty)), /no staged data to read: no staged data/);
});

test("a large staged upload streams in megabyte pieces and arrives byte for byte", async () => {
  const staged = patterned(2 * 1024 * 1024 + 123_456, 5);
  const device = fakeFastboot({ staged });
  const ctx = context(device);
  const result = await exec("upload", ctx);
  assert.deepEqual(ctx.streams[0].bytes, staged);
  assert.equal(result.sha256, sha256(staged));
  assert.equal(ctx.events.filter((event) => event.phase === "upload").length, 3);
});

// ---------------------------------------------------------------------------
// update / flashall
// ---------------------------------------------------------------------------

const SYSTEM_SPARSE = sparseFile(4096, [
  { type: "raw", blocks: 6, data: patterned(6 * 4096, 3) },
  { type: "skip", blocks: 4 },
  { type: "fill", blocks: 2, pattern: Buffer.from([7, 7, 7, 7]) },
]);
const BOOT = patterned(8192, 1);
const VENDOR_BOOT = patterned(12000, 2);

function packageZip({ info = "require board=cronos\nrequire version-bootloader=1.0|1.1*\n", extra = [], without = [] } = {}) {
  const entries = [
    ...(info === null ? [] : [{ name: "android-info.txt", data: info, method: "store" }]),
    { name: "boot.img", data: BOOT, method: "store" },
    { name: "vendor_boot.img", data: VENDOR_BOOT, method: "deflate" },
    { name: "system.img", data: SYSTEM_SPARSE, method: "store" },
    { name: "bootloader.img", data: Buffer.alloc(100, 1), method: "store" },
    { name: "userdata.img", data: Buffer.alloc(100, 2), method: "store" },
    ...extra,
  ].filter((entry) => !without.includes(entry.name));
  return buildZip(entries);
}

function updateDevice({ variables = {}, ...rest } = {}) {
  return fakeFastboot({
    variables: { product: "cronos", "version-bootloader": "1.1b", "current-slot": "a", "is-userspace": "no", ...variables },
    partitions: { boot_a: Buffer.alloc(0x4000, 0xaa), vendor_boot_a: Buffer.alloc(0x4000, 0xbb), system: Buffer.alloc(0x10000, 0xcc) },
    slotted: ["boot", "vendor_boot"],
    ...rest,
  });
}

const updateOf = (zip, device, over) => context(device, new Blob([zip]), over);

test("update flashes every image of the package after one typed approval, backing each partition up first", async () => {
  const zip = packageZip();
  const device = updateDevice();
  const ctx = updateOf(zip, device);
  const before = Object.fromEntries(Object.entries(device.partitions).map(([name, bytes]) => [name, Buffer.from(bytes)]));
  ctx.onConfirm = () => {
    assert.equal(wrote(device), false, "nothing is written before the single approval");
    assert.deepEqual(ctx.streams.map((stream) => stream.name), ["boot_a.preflash.bin", "vendor_boot_a.preflash.bin", "system.preflash.bin"]);
    assert.deepEqual(ctx.streams[2].bytes, before.system);
  };
  const result = await exec("update", ctx);

  assert.equal(ctx.confirmations.length, 1);
  const [risk] = ctx.confirmations;
  assert.equal(risk.action, "fastboot update");
  assert.equal(risk.sha256, sha256(zip));
  assert.equal(risk.protectedOverride, `update:${sha256(zip).slice(0, 8)}`, "the typed text names this exact package");
  assert.match(risk.target, /3 partition\(s\): boot_a, vendor_boot_a, system/);
  assert.match(risk.details, /requirements \(2\) are all met/);
  assert.match(risk.details, /system: 49152 bytes.*readback verified/);
  assert.match(risk.details, /Not flashed by update: bootloader\.img, userdata\.img/);

  assert.deepEqual(device.flashed.map((entry) => entry.partition), ["boot_a", "vendor_boot_a", "system"], "boot-critical images first, then the operating system");
  assert.deepEqual(device.partitions.boot_a.subarray(0, BOOT.length), BOOT);
  assert.deepEqual(device.partitions.boot_a.subarray(BOOT.length), before.boot_a.subarray(BOOT.length));
  assert.deepEqual(device.partitions.vendor_boot_a.subarray(0, VENDOR_BOOT.length), VENDOR_BOOT, "a deflated entry is inflated and flashed");
  const system = Buffer.alloc(0x10000, 0xcc);
  system.set(patterned(6 * 4096, 3), 0);
  for (let offset = 0; offset < 2 * 4096; offset += 4) system.set([7, 7, 7, 7], 10 * 4096 + offset);
  assert.deepEqual(device.partitions.system, system);
  assert.equal(result.verified, true);
  assert.equal(result.sha256, sha256(zip));
  assert.deepEqual(result.details.notFlashed, ["bootloader.img", "userdata.img"]);
  assert.equal(result.details.partitions.length, 3);
  assert.equal(device.log.includes("flash:bootloader"), false);
});

test("flashall takes the same path as update, an underscore slot name is understood, and slotless partitions keep their name", async () => {
  const zip = packageZip();
  const device = updateDevice({ variables: { "current-slot": "_a" } });
  const result = await exec("flashall", updateOf(zip, device));
  assert.equal(result.verified, true);
  assert.deepEqual(device.flashed.map((entry) => entry.partition), ["boot_a", "vendor_boot_a", "system"]);
});

test("images larger than max-download-size are sent in pieces inside an update", async () => {
  const device = updateDevice({ maxDownload: "0x3000" });
  const result = await exec("update", updateOf(packageZip(), device));
  assert.equal(result.verified, true);
  assert.ok(device.flashed.filter((entry) => entry.partition === "system").length >= 2, "the sparse system image is split");
  assert.equal(device.flashed.filter((entry) => entry.partition === "boot_a").length, 1);
});

test("a package for another device is refused before anything is downloaded, flashed, backed up or erased", async () => {
  for (const info of ["require board=other\n", "reject board=cronos\n", "require version-bootloader=2.0\n", "require partition-exists=nonexistent\n"]) {
    const device = updateDevice();
    const ctx = updateOf(packageZip({ info }), device);
    const failure = await exec("update", ctx).then(() => undefined, (error) => error);
    assert.match(failure?.message ?? "", /is not for this device, so nothing was written/, info);
    assert.equal(ctx.confirmations.length, 0);
    assert.equal(ctx.streams.length, 0);
    assert.equal(wrote(device), false);
    assert.equal(device.log.some((entry) => entry.startsWith("fetch:")), false);
  }
  const device = updateDevice();
  await assert.rejects(exec("update", updateOf(packageZip({ info: "require board=other\n" }), device)), /product is 'cronos'; the package requires 'other'/);
  await assert.rejects(exec("update", updateOf(packageZip({ info: "require partition-exists=nonexistent\n" }), device)), /does not have the required partition nonexistent/);
});

test("a partition the package requires has to be in the package: the device knowing the partition does not excuse a missing image", async () => {
  const partitions = () => ({ boot_a: Buffer.alloc(0x4000, 0xaa), vendor_boot_a: Buffer.alloc(0x4000, 0xbb), system: Buffer.alloc(0x10000, 0xcc), vendor: Buffer.alloc(0x4000, 0xdd), cache: Buffer.alloc(0x1000, 0xee) });
  const info = (extra) => `require board=cronos\n${extra}\n`;
  const vendorImage = { name: "vendor.img", data: patterned(5000, 8), method: "store" };

  // The device answers has-slot:vendor, so the requirement is met on the device, yet the package has no vendor.img.
  const missing = updateDevice({ partitions: partitions() });
  const refused = updateOf(packageZip({ info: info("require partition-exists=vendor") }), missing);
  await assert.rejects(exec("update", refused), /requires partition vendor, but contains no vendor\.img; nothing was written/);
  assert.equal(refused.confirmations.length, 0);
  assert.equal(refused.streams.length, 0, "nothing is backed up either");
  assert.equal(wrote(missing), false);
  assert.equal(missing.log.some((entry) => entry.startsWith("fetch:")), false);

  // With the image present the same requirement is satisfied and vendor is flashed after system, as fastboot orders it.
  const present = updateDevice({ partitions: partitions() });
  const result = await exec("update", updateOf(packageZip({ info: info("require partition-exists=vendor"), extra: [vendorImage] }), present));
  assert.equal(result.verified, true);
  assert.deepEqual(present.flashed.map((entry) => entry.partition), ["boot_a", "vendor_boot_a", "system", "vendor"]);

  // A required partition this update does not know how to flash is refused, not skipped, as fastboot refuses one it does not know.
  const unsupported = updateDevice({ partitions: partitions() });
  await assert.rejects(exec("update", updateOf(packageZip({ info: info("require partition-exists=cache") }), unsupported)), /requires unsupported partition cache; nothing was written/);
  assert.equal(wrote(unsupported), false);

  // Like fastboot, only the first value names the partition: a second alternative adds no requirement of its own.
  const first = updateDevice({ partitions: partitions() });
  const alternatives = await exec("update", updateOf(packageZip({ info: info("require partition-exists=vendor|odm"), extra: [vendorImage] }), first));
  assert.equal(alternatives.verified, true);
});

test("package metadata is read under its own small bound, before any approval and before the device is asked anything", async () => {
  const refuse = async (entries, pattern) => {
    const device = updateDevice();
    const ctx = updateOf(buildZip(entries), device);
    await assert.rejects(exec("update", ctx), pattern);
    assert.deepEqual(device.log, [], "the bootloader was not even asked for its product");
    assert.equal(ctx.confirmations.length, 0);
    return device;
  };
  const boot = { name: "boot.img", data: BOOT, method: "store" };

  // Stored: a manifest one byte over the 64 KiB bound is refused from its recorded size.
  await refuse([{ name: "android-info.txt", data: Buffer.alloc(64 * 1024 + 1, 0x20), method: "store" }, boot], /android-info\.txt cannot be read: android-info\.txt is 65537 bytes, over the 65536-byte limit/);

  // Compressed: a tiny member that claims gigabytes is refused without inflating anything.
  const bomb = Buffer.from(buildZip([{ name: "android-info.txt", data: Buffer.alloc(300_000, 0x20), method: "deflate" }, boot]));
  bomb.writeUInt32LE(0x7fffff00, bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  const original = globalThis.DecompressionStream;
  let inflations = 0;
  globalThis.DecompressionStream = class extends original { constructor(...args) { inflations += 1; super(...args); } };
  try {
    const device = updateDevice();
    await assert.rejects(exec("update", updateOf(bomb, device)), /android-info\.txt cannot be read: android-info\.txt is 2147483392 bytes, over the 65536-byte limit/);
    assert.equal(inflations, 0, "no inflater was even created");
    assert.deepEqual(device.log, []);
  } finally {
    globalThis.DecompressionStream = original;
  }

  // Parsing is bounded as well: a manifest of endless requirements would be endless round trips to the bootloader.
  await refuse([{ name: "android-info.txt", data: "require board=cronos\n".repeat(257), method: "store" }, boot], /lists 257 requirements; Cody reads at most 256/);

  // A manifest at the bounds still works, compressed or not.
  const sizeable = "require board=cronos\n".repeat(256);
  assert.ok(sizeable.length < 64 * 1024);
  for (const method of ["store", "deflate"]) {
    const device = updateDevice();
    const result = await exec("update", updateOf(buildZip([{ name: "android-info.txt", data: sizeable, method }, boot, { name: "vendor_boot.img", data: VENDOR_BOOT, method: "store" }, { name: "system.img", data: SYSTEM_SPARSE, method: "store" }]), device));
    assert.equal(result.verified, true, method);
  }
});

test("a stored image damaged under an intact directory is rejected as a damaged package before anything is approved or written", async () => {
  for (const [member, firstBackedUp] of [["boot.img", false], ["system.img", true]]) {
    const zip = Buffer.from(packageZip());
    // The first occurrence of the name is the member's own local header; flip a data byte just past it.
    zip[zip.indexOf(Buffer.from(member)) + member.length + 100] ^= 0x01;
    const device = updateDevice();
    const ctx = updateOf(zip, device);
    await assert.rejects(exec("update", ctx), new RegExp(`${member.replace(".", "\\.")} failed its CRC-32 check: the archive is damaged`), member);
    assert.equal(ctx.confirmations.length, 0, `${member}: nothing was offered for approval`);
    assert.equal(wrote(device), false, `${member}: nothing was downloaded, flashed or erased`);
    assert.equal(device.log.some((entry) => entry.startsWith("fetch:")), firstBackedUp, `${member}: ${firstBackedUp ? "earlier partitions had already been backed up (read-only)" : "the first image is checked before any backup is taken"}`);
  }
});

test("a requirement for a different product is ignored, as fastboot ignores it", async () => {
  const device = updateDevice();
  const result = await exec("update", updateOf(packageZip({ info: "require board=cronos\nrequire-for-product:other version-bootloader=99\n" }), device));
  assert.equal(result.verified, true);
});

test("a package without android-info.txt cannot be proven to match the device and is refused", async () => {
  const device = updateDevice();
  await assert.rejects(exec("update", updateOf(packageZip({ info: null }), device)), /no android-info\.txt.*device_flash/);
  assert.equal(wrote(device), false);
});

test("a file that is not a package, a package of nothing flashable, and a factory bundle are each explained", async () => {
  const device = updateDevice();
  await assert.rejects(exec("update", context(device, new Blob(["definitely not a zip file but long enough to try"]))), /not an update package/);
  await assert.rejects(exec("update", context(device)), /needs a package artifact/);
  const empty = buildZip([{ name: "android-info.txt", data: "require board=cronos\n", method: "store" }, { name: "notes.txt", data: "hi", method: "store" }]);
  await assert.rejects(exec("update", updateOf(empty, device)), /none of the images fastboot update flashes/);
  const bundle = buildZip([{ name: "android-info.txt", data: "require board=cronos\n", method: "store" }, { name: "image-cronos-123.zip", data: "inner", method: "store" }]);
  await assert.rejects(exec("update", updateOf(bundle, device)), /image-cronos-123\.zip: that inner ZIP is what fastboot update flashes/);
  assert.equal(wrote(device), false);
});

test("update takes no arguments: options that would widen it are refused rather than ignored", async () => {
  const device = updateDevice();
  for (const command of ["update -w", "flashall --force", "update other.zip", "flashall -S 100M"]) {
    await assert.rejects(exec(command, updateOf(packageZip(), device)), /take no arguments here/, command);
  }
  assert.equal(device.log.length, 0);
});

test("a logical partition cannot be written from the bootloader but can from userspace fastboot", async () => {
  const bootloader = updateDevice({ logical: ["system"] });
  const refused = updateOf(packageZip(), bootloader);
  await assert.rejects(exec("update", refused), /system is a logical partition.*fastbootd.*Nothing was written/);
  assert.equal(wrote(bootloader), false);
  assert.equal(refused.streams.length, 0);

  const fastbootd = updateDevice({ logical: ["system"], variables: { "is-userspace": "yes" } });
  const result = await exec("update", updateOf(packageZip(), fastbootd));
  assert.equal(result.verified, true);
});

test("a slotted partition on a device that reports no current slot is refused, not guessed", async () => {
  const quiet = fakeFastboot({ variables: { product: "cronos", "version-bootloader": "1.1b" }, partitions: { boot_a: Buffer.alloc(0x4000) }, slotted: ["boot"] });
  await assert.rejects(exec("update", updateOf(packageZip(), quiet)), /boot has A\/B slots but the device did not report current-slot/);
  assert.equal(wrote(quiet), false);
});

/** What a failed update says about each partition, split the way the message splits them. */
function accounting(error) {
  const part = (label) => new RegExp(`${label}: (.*?)\\.(?: |$)`).exec(error.message)?.[1];
  return {
    stoppedAt: /The update stopped at (\S+?):/.exec(error.message)?.[1],
    verified: part("Written and verified"),
    unverifiable: part("Written but not verifiable \\(no fetch readback\\)"),
    suspect: /POSSIBLY MODIFIED \(a flash command was sent and the result is not verified\): (\S+?); (.*?)\. (?:Untouched|Nothing)/s.exec(error.message)?.slice(1),
    untouched: part("Untouched"),
  };
}

test("a partition that rejects its image stops the update there; it was sent a flash command, so it is reported as possibly modified, not as untouched", async () => {
  const device = updateDevice({ failFlash: (name) => name === "vendor_boot_a" });
  const before = Buffer.from(device.partitions.system);
  const error = await exec("update", updateOf(packageZip(), device)).then(() => undefined, (caught) => caught);
  assert.match(error?.message ?? "", /Nothing was retried/);
  assert.deepEqual(accounting(error), {
    stoppedAt: "vendor_boot_a",
    verified: "boot_a",
    unverifiable: undefined,
    suspect: ["vendor_boot_a", "its previous contents are saved as stream:vendor_boot_a.preflash.bin"],
    untouched: "system",
  });
  assert.deepEqual(device.flashed.map((entry) => entry.partition), ["boot_a"]);
  assert.deepEqual(device.partitions.system, before, "the later partitions are untouched");
});

test("a failed readback leaves the partition that was just written in the possibly-modified list with its backup, and the later ones untouched", async () => {
  const first = updateDevice({ corruptFetchOf: "boot_a" });
  const failure = await exec("update", updateOf(packageZip(), first)).then(() => undefined, (caught) => caught);
  assert.match(failure?.message ?? "", /The update stopped at boot_a: .*readback SHA-256 mismatch/s);
  assert.deepEqual(accounting(failure), {
    stoppedAt: "boot_a",
    verified: "none",
    unverifiable: undefined,
    suspect: ["boot_a", "its previous contents are saved as stream:boot_a.preflash.bin"],
    untouched: "vendor_boot_a, system",
  });
  assert.deepEqual(first.flashed.map((entry) => entry.partition), ["boot_a"], "the next partition is not written");
  assert.doesNotMatch(failure.message, /Not written/, "the partition that was written is never filed under not-written");

  // Failing on the second partition: the first stays verified, the second is the suspect.
  const second = updateDevice({ corruptFetchOf: "vendor_boot_a" });
  const later = await exec("update", updateOf(packageZip(), second)).then(() => undefined, (caught) => caught);
  assert.deepEqual(accounting(later), {
    stoppedAt: "vendor_boot_a",
    verified: "boot_a",
    unverifiable: undefined,
    suspect: ["vendor_boot_a", "its previous contents are saved as stream:vendor_boot_a.preflash.bin"],
    untouched: "system",
  });
});

test("a later sparse piece that fails after earlier pieces were written leaves its partition possibly modified, with its backup", async () => {
  // Flash commands, in order: boot_a (1), vendor_boot_a (2), then the pieces of system (3, 4, ...). Fail the second piece.
  const device = updateDevice({ maxDownload: "0x3000", failFlash: (name, count) => name === "system" && count === 4 });
  const error = await exec("update", updateOf(packageZip(), device)).then(() => undefined, (caught) => caught);
  assert.match(error?.message ?? "", /Sparse piece 2 of \d+ failed after 1 piece\(s\) were written to system/);
  assert.deepEqual(accounting(error), {
    stoppedAt: "system",
    verified: "boot_a, vendor_boot_a",
    unverifiable: undefined,
    suspect: ["system", "its previous contents are saved as stream:system.preflash.bin"],
    untouched: "none",
  });
  assert.equal(device.flashed.filter((entry) => entry.partition === "system").length, 1, "exactly one piece reached the partition");
});

test("a transfer that dies before any flash command was sent leaves its partition untouched, and a bootloader without readback names what it could not verify and cannot back up", async () => {
  const device = updateDevice();
  const send = device.transport.write;
  let downloads = 0;
  device.transport.write = async (bytes, signal) => {
    if (Buffer.from(bytes).toString().startsWith("download:") && (downloads += 1) === 2) throw new Error("USB cable pulled");
    return send(bytes, signal);
  };
  const error = await exec("update", updateOf(packageZip(), device)).then(() => undefined, (caught) => caught);
  assert.deepEqual(accounting(error), {
    stoppedAt: "vendor_boot_a",
    verified: "boot_a",
    unverifiable: undefined,
    suspect: undefined,
    untouched: "vendor_boot_a, system",
  });
  assert.doesNotMatch(error.message, /POSSIBLY MODIFIED/);

  const blind = updateDevice({ fetch: false, failFlash: (name) => name === "vendor_boot_a" });
  const unread = await exec("update", updateOf(packageZip(), blind)).then(() => undefined, (caught) => caught);
  assert.deepEqual(accounting(unread), {
    stoppedAt: "vendor_boot_a",
    verified: "none",
    unverifiable: "boot_a",
    suspect: ["vendor_boot_a", "no backup of it exists, because this bootloader cannot read partitions"],
    untouched: "system",
  });
});

test("without fetch readback the update still runs, but says plainly that nothing was backed up or verified", async () => {
  const device = updateDevice({ fetch: false });
  const ctx = updateOf(packageZip(), device);
  const result = await exec("update", ctx);
  assert.match(ctx.confirmations[0].backup, /Backup unavailable for 3 of 3 partition\(s\) \(boot_a, vendor_boot_a, system\)/);
  assert.match(ctx.confirmations[0].details, /NO BACKUP, UNVERIFIED/);
  assert.equal(ctx.streams.length, 0);
  assert.equal(result.verified, false);
  assert.match(result.summary, /UNVERIFIED/);
  assert.equal(device.flashed.length, 3);
});

test("declining the update approval leaves the device untouched even though backups were taken", async () => {
  const device = updateDevice();
  const ctx = updateOf(packageZip(), device, { confirm: async () => { throw new DOMException("Declined", "AbortError"); } });
  await assert.rejects(exec("update", ctx), /Declined/);
  assert.equal(wrote(device), false);
});

const until = async (check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) {
    const value = check();
    if (value) return value;
  }
  throw new Error("Expected state was not reached");
};

/**
 * An update run through the operation manager (a cancelled operation keeps no error, only the output
 * it published). `watch` sees every command the host sends and may cancel, or report the device
 * gone the way the browser does, at the moment it chooses; the command it sees is still delivered.
 */
async function managedUpdate(device, watch) {
  const zip = packageZip();
  const digest = sha256(zip);
  const write = device.transport.write;
  let manager;
  let id;
  device.transport.write = async (bytes, signal) => {
    watch(Buffer.from(bytes).toString(), { cancel: () => manager.cancel(id), disconnect: () => { void manager.deviceDisconnected("usb-1"); } });
    return write(bytes, signal);
  };
  const artifacts = {
    async getInput() { return new Blob([zip]); },
    async save() { return "saved"; },
    async saveStream(_session, name, chunks) {
      const parts = [];
      for await (const chunk of chunks) parts.push(Buffer.from(chunk));
      const bytes = Buffer.concat(parts);
      return { fileId: `stream:${name}`, sha256: sha256(bytes), length: bytes.length };
    },
  };
  manager = new DeviceOperationManager("update-cancel", { async borrowHardwareTransport() { return { transport: device.transport, async release() {} }; } }, artifacts, [fastbootFlasher]);
  ({ id } = manager.startUser({ deviceId: "usb-1", protocol: "fastboot", action: "exec", command: "update", fileId: "package", sha256: digest }));
  const waiting = await until(() => manager.status(id).state === "awaiting-confirmation" && manager.status(id));
  manager.confirm(id, waiting.confirmation.id, waiting.confirmation.binding, `update:${digest.slice(0, 8)}`);
  const done = await until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));
  return { done, lines: done.output.map((row) => row.line) };
}

test("cancelling an update after a partition was flashed keeps the written / possibly modified / untouched accounting, and no write is retried", async () => {
  // During the readback of the second partition: it was sent a flash command and is not verified.
  const reading = updateDevice();
  const system = Buffer.from(reading.partitions.system);
  const duringReadback = await managedUpdate(reading, (command, { cancel }) => {
    if (command.startsWith("fetch:vendor_boot_a") && reading.flashed.some((entry) => entry.partition === "vendor_boot_a")) cancel();
  });
  assert.equal(duringReadback.done.state, "cancelled");
  assert.equal(duringReadback.done.error, undefined);
  assert.deepEqual(duringReadback.lines.slice(-5), [
    "The update was cancelled while vendor_boot_a was being flashed or verified.",
    "Written and verified: boot_a.",
    "POSSIBLY MODIFIED (a flash command was sent and the result is not verified): vendor_boot_a; its previous contents are saved as stream:vendor_boot_a.preflash.bin.",
    "Untouched: system.",
    "Nothing was retried.",
  ]);
  assert.deepEqual(reading.flashed.map((entry) => entry.partition), ["boot_a", "vendor_boot_a"], "nothing was written after the cancel, and nothing twice");
  assert.deepEqual(reading.partitions.system, system);

  // The browser reporting the USB device gone while the last partition's flash command is in flight is the same thing.
  const flashing = updateDevice();
  const duringFlash = await managedUpdate(flashing, (command, { disconnect }) => { if (command === "flash:system") disconnect(); });
  assert.equal(duringFlash.done.state, "cancelled");
  assert.deepEqual(duringFlash.lines.slice(-5), [
    "The update was cancelled while system was being flashed or verified.",
    "Written and verified: boot_a, vendor_boot_a.",
    "POSSIBLY MODIFIED (a flash command was sent and the result is not verified): system; its previous contents are saved as stream:system.preflash.bin.",
    "Untouched: none.",
    "Nothing was retried.",
  ]);
  assert.equal(flashing.flashed.filter((entry) => entry.partition === "system").length, 1, "the command that was in flight reached the device once");

  // Before any flash command was sent nothing is suspect, and the output says the device was not touched.
  const downloading = updateDevice();
  const before = Object.fromEntries(Object.entries(downloading.partitions).map(([name, bytes]) => [name, Buffer.from(bytes)]));
  let cancelledDownload = false;
  const early = await managedUpdate(downloading, (command, { cancel }) => { if (command.startsWith("download:") && !cancelledDownload) { cancelledDownload = true; cancel(); } });
  assert.equal(early.done.state, "cancelled");
  assert.deepEqual(early.lines.slice(-4), [
    "The update was cancelled before boot_a was flashed.",
    "Written and verified: none.",
    "Untouched: boot_a, vendor_boot_a, system.",
    "Nothing was retried.",
  ]);
  assert.equal(early.lines.some((line) => /POSSIBLY MODIFIED/.test(line)), false);
  assert.deepEqual(downloading.flashed, []);
  assert.deepEqual(downloading.partitions, before);

  // A bootloader that cannot read partitions says what it could not verify or back up.
  const blind = updateDevice({ fetch: false });
  const unreadable = await managedUpdate(blind, (command, { cancel }) => { if (command === "flash:vendor_boot_a") cancel(); });
  assert.equal(unreadable.done.state, "cancelled");
  assert.deepEqual(unreadable.lines.slice(-6), [
    "The update was cancelled while vendor_boot_a was being flashed or verified.",
    "Written and verified: none.",
    "Written but not verifiable (no fetch readback): boot_a.",
    "POSSIBLY MODIFIED (a flash command was sent and the result is not verified): vendor_boot_a; no backup of it exists, because this bootloader cannot read partitions.",
    "Untouched: system.",
    "Nothing was retried.",
  ]);
});
