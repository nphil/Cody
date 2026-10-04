import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { createJiti } from "jiti";
import { buildZip } from "./zip.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { MAX_INFLATED_BYTES, ZipError, crc32, openZip } = await jiti.import("./zip-archive.ts");

const blobOf = (buffer) => new Blob([buffer]);
const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

const sample = [
  { name: "android-info.txt", data: "require board=cronos\nrequire version-bootloader=1.2|1.3\n", method: "store" },
  { name: "boot.img", data: Buffer.from(Array.from({ length: 20000 }, (_, index) => (index * 7) & 0xff)), method: "deflate" },
  { name: "system.img", data: Buffer.alloc(9000, 0x5a), method: "store" },
  { name: "dir/", data: "", method: "store" },
  { name: "ünï.txt", data: "unicode name", method: "store" },
];

test("stored and deflated entries read back byte for byte", async () => {
  const zip = await openZip(blobOf(buildZip(sample)));
  assert.deepEqual(zip.entries.map((entry) => entry.name), ["android-info.txt", "boot.img", "system.img", "dir/", "ünï.txt"]);
  assert.equal(await zip.text(zip.find("android-info.txt"), 1024), sample[0].data);
  assert.deepEqual(await bytesOf(await zip.open(zip.find("boot.img"))), sample[1].data);
  assert.deepEqual(await bytesOf(await zip.open(zip.find("system.img"))), sample[2].data);
  assert.equal(await zip.text(zip.find("ünï.txt"), 1024), "unicode name");
  assert.equal(zip.find("missing.img"), undefined);
  assert.equal(zip.find("boot.img").method, 8);
  assert.equal(zip.find("boot.img").size, 20000);
});

test("a stored entry is a slice of the archive, so a large image is never copied", async () => {
  const archive = blobOf(buildZip(sample));
  const zip = await openZip(archive);
  const system = await zip.open(zip.find("system.img"));
  assert.equal(system.size, 9000);
  assert.ok(system.size < archive.size);
});

test("ZIP64 sizes, offsets and end records are honoured", async () => {
  const zip = await openZip(blobOf(buildZip(sample, { zip64: true })));
  assert.equal(zip.entries.length, 5);
  assert.deepEqual(await bytesOf(await zip.open(zip.find("boot.img"))), sample[1].data);
  assert.equal(await zip.text(zip.find("android-info.txt"), 1024), sample[0].data);
});

test("an end-of-archive signature inside the comment does not fool the directory search", async () => {
  const zip = await openZip(blobOf(buildZip(sample, { comment: `${"x".repeat(100)}PK\x05\x06${"y".repeat(40)}` })));
  assert.equal(zip.entries.length, 5);
});

test("a damaged deflated entry is caught by its CRC-32, not flashed", async () => {
  const bad = buildZip([{ name: "boot.img", data: Buffer.alloc(5000, 1), method: "deflate", crc: 0x12345678 }]);
  const zip = await openZip(blobOf(bad));
  await assert.rejects(zip.open(zip.find("boot.img")), /CRC-32/);
});

test("a damaged stored entry is caught by its CRC-32 too, whether the recorded checksum or the data is wrong", async () => {
  const wrongRecord = buildZip([{ name: "boot.img", data: Buffer.alloc(5000, 1), method: "store", crc: 0x12345678 }]);
  const zip = await openZip(blobOf(wrongRecord));
  await assert.rejects(zip.open(zip.find("boot.img")), /boot\.img failed its CRC-32 check: the archive is damaged/);

  // The realistic damage: a flipped data byte under an intact central directory.
  const image = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 11) & 0xff));
  const damaged = Buffer.from(buildZip([{ name: "boot.img", data: image, method: "store" }]));
  const dataStart = 30 + "boot.img".length;
  damaged[dataStart + 2500] ^= 0x40;
  const archive = await openZip(blobOf(damaged));
  assert.equal(archive.find("boot.img").size, 5000, "the directory itself is intact");
  await assert.rejects(archive.open(archive.find("boot.img")), /CRC-32/);
  await assert.rejects(archive.text(archive.find("boot.img"), 1 << 20), /CRC-32/, "no reader path hands out the bytes unchecked");

  const intact = await openZip(blobOf(buildZip([{ name: "boot.img", data: image, method: "store" }])));
  assert.deepEqual(await bytesOf(await intact.open(intact.find("boot.img"))), image);
  const empty = await openZip(blobOf(buildZip([{ name: "empty.txt", data: "", method: "store" }])));
  assert.equal((await empty.open(empty.find("empty.txt"))).size, 0, "an empty stored member has the CRC of nothing and passes");
});

test("text() refuses an entry recorded as larger than its limit before opening it, stored or compressed", async () => {
  const info = Buffer.from("require board=cronos\n".repeat(100));
  const zip = await openZip(blobOf(buildZip([
    { name: "stored.txt", data: info, method: "store" },
    { name: "deflated.txt", data: info, method: "deflate" },
  ])));
  for (const name of ["stored.txt", "deflated.txt"]) {
    const entry = zip.find(name);
    assert.equal(entry.size, info.length);
    assert.equal(await zip.text(entry, info.length), info.toString(), `${name} at exactly the limit is read`);
    await assert.rejects(zip.text(entry, info.length - 1), new RegExp(`${name} is ${info.length} bytes, over the ${info.length - 1}-byte limit`), name);
  }
  for (const bad of [undefined, -1, 1.5, Number.NaN, Infinity]) await assert.rejects(zip.text(zip.find("stored.txt"), bad), /needs a byte limit/, String(bad));

  // The refusal comes first: a small compressed member that claims a huge size is never inflated.
  const bomb = Buffer.from(buildZip([{ name: "bomb.txt", data: Buffer.alloc(200_000), method: "deflate" }]));
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(0x7fffff00, central + 24);
  const bombArchive = await openZip(blobOf(bomb));
  const original = globalThis.DecompressionStream;
  let inflations = 0;
  globalThis.DecompressionStream = class extends original { constructor(...args) { inflations += 1; super(...args); } };
  try {
    await assert.rejects(bombArchive.text(bombArchive.find("bomb.txt"), 65536), /over the 65536-byte limit for metadata/);
    assert.equal(inflations, 0, "nothing was inflated");
  } finally {
    globalThis.DecompressionStream = original;
  }

  // A member that inflates past its recorded size cannot get around the bound either.
  const lying = Buffer.from(buildZip([{ name: "lie.txt", data: Buffer.alloc(200_000), method: "deflate" }]));
  lying.writeUInt32LE(100, lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  const lyingArchive = await openZip(blobOf(lying));
  await assert.rejects(lyingArchive.text(lyingArchive.find("lie.txt"), 1024), /more than its recorded 100 bytes/);
});

test("an entry that inflates to a different size than recorded is rejected", async () => {
  const forged = Buffer.from(buildZip([{ name: "a.img", data: Buffer.alloc(5000, 1), method: "deflate" }]));
  // The central directory's size field (offset 24 within the central entry) claims fewer bytes than the data inflates to.
  const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(100, central + 24);
  const zip = await openZip(blobOf(forged));
  await assert.rejects(zip.open(zip.find("a.img")), /more than its recorded 100 bytes/);
});

test("encrypted entries, unknown compression methods, and oversized inflates are refused with the reason", async () => {
  const zip = await openZip(blobOf(buildZip([
    { name: "secret.img", data: "x", method: "store", flags: 0x0801 },
    { name: "lzma.img", data: "x", method: "store", methodCode: 14 },
  ])));
  await assert.rejects(zip.open(zip.find("secret.img")), /encrypted/);
  await assert.rejects(zip.open(zip.find("lzma.img")), /method 14/);
  assert.equal(MAX_INFLATED_BYTES, 2 * 1024 * 1024 * 1024);
  const huge = Buffer.from(buildZip([{ name: "big.img", data: Buffer.alloc(100, 1), method: "deflate" }]));
  const central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(0xfffffff0, central + 24);
  const archive = await openZip(blobOf(huge));
  await assert.rejects(archive.open(archive.find("big.img")), /Re-pack the archive with that file stored/);
});

test("things that are not ZIP archives, and truncated ones, fail clearly", async () => {
  await assert.rejects(openZip(blobOf(Buffer.from("not a zip at all, just text of some length"))), ZipError);
  await assert.rejects(openZip(blobOf(Buffer.alloc(5))), /too short/);
  const whole = buildZip(sample);
  await assert.rejects(openZip(blobOf(whole.subarray(0, whole.length - 30))), ZipError);
  const noLocator = Buffer.from(buildZip(sample, { zip64: true }));
  // Cut the ZIP64 locator out of the tail: the end record still demands it.
  const withoutLocator = Buffer.concat([noLocator.subarray(0, noLocator.length - 22 - 20), noLocator.subarray(noLocator.length - 22)]);
  await assert.rejects(openZip(blobOf(withoutLocator)), /ZIP64/);
});

test("crc32 agrees with zlib's, chunked or whole", () => {
  const data = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 13) & 0xff));
  assert.equal(crc32(data), nodeCrc32(data));
  assert.equal(crc32(data.subarray(2500), crc32(data.subarray(0, 2500))), nodeCrc32(data));
  assert.equal(crc32(new Uint8Array()), 0);
});
