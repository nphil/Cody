import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { planZip, zipBlob, zipStream, ZipPlanError } = await jiti.import("./artifact-zip.ts");
const { openZip } = await jiti.import("./zip-archive.ts");

const MODIFIED = Date.parse("2026-10-06T18:31:12Z");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = (name, bytes, extra = {}) => ({ name, data: new Blob([bytes]), crc32: nodeCrc32(bytes), modified: MODIFIED, ...extra });

async function bytesOf(readable) {
  const chunks = [];
  const reader = readable.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return Buffer.concat(chunks);
    chunks.push(Buffer.from(next.value));
  }
}

async function sample(options = {}) {
  const small = randomBytes(1234);
  const big = randomBytes(9 * 1024 * 1024 + 17);
  const sources = [
    source("backup/edl-1-set-p1-boot_a.bin", small),
    source("backup/empty.bin", new Uint8Array(0)),
    source("backup/edl-1-set-p2-userdata.bin", big),
    source("backup/データ-π.txt", Buffer.from("non-ascii name")),
  ];
  return { plan: planZip(sources, options), contents: [small, new Uint8Array(0), big, Buffer.from("non-ascii name")], sources };
}

test("a plan knows the archive's exact size before any byte is written, and the lazy Blob has exactly that size", async () => {
  const { plan } = await sample();
  assert.equal(zipBlob(plan).size, plan.size);
  assert.equal(plan.entries, 4);
  assert.equal(plan.zip64, false, "a normal backup stays a classic archive every unzip opens");
});

test("what the streaming writer produces is, byte for byte, what the lazy Blob holds", async () => {
  const { plan } = await sample();
  const streamed = await bytesOf(zipStream(plan, { verify: true }));
  const composed = Buffer.from(await zipBlob(plan).arrayBuffer());
  assert.equal(streamed.length, plan.size);
  assert.equal(sha256(streamed), sha256(composed));
});

test("Cody's own ZIP reader opens the archive and every entry comes back with its name, CRC and bytes", async () => {
  const { plan, contents } = await sample();
  const archive = await openZip(zipBlob(plan));
  assert.deepEqual(archive.entries.map((entry) => entry.name), plan.layout.map((entry) => entry.name));
  for (const [index, entry] of archive.entries.entries()) {
    assert.equal(entry.method, 0, "stored, never deflated");
    assert.equal(entry.size, contents[index].length);
    assert.equal(entry.crc32, nodeCrc32(contents[index]));
    assert.equal(sha256(Buffer.from(await (await archive.open(entry)).arrayBuffer())), sha256(contents[index]));
  }
});

test("ZIP64 records, forced on small data, are read back the same", async () => {
  const { plan, contents } = await sample({ forceZip64: true });
  assert.equal(plan.zip64, true);
  assert.ok(plan.layout.every((entry) => entry.zip64));
  const archive = await openZip(zipBlob(plan));
  for (const [index, entry] of archive.entries.entries()) {
    assert.equal(entry.size, contents[index].length);
    assert.equal(entry.compressedSize, contents[index].length);
    assert.equal(sha256(Buffer.from(await (await archive.open(entry)).arrayBuffer())), sha256(contents[index]));
  }
});

/** A Blob that claims a size without holding the bytes: enough to plan an archive of any size, never to write one. */
function pretendBlob(size) {
  return Object.create(Blob.prototype, { size: { value: size } });
}

/** An independent reading of the archive's metadata: the tail parts of a plan whose data was never real. */
function readTail(plan, firstTailPart) {
  const tail = Buffer.concat(plan.parts.slice(firstTailPart));
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const records = [];
  let at = 0;
  while (at < tail.length) {
    const signature = view.getUint32(at, true);
    if (signature === 0x02014b50) {
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const extra = tail.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      const fields = [];
      for (let cursor = 0; cursor < extra.length;) {
        const id = extra.readUInt16LE(cursor);
        const length = extra.readUInt16LE(cursor + 2);
        fields.push({ id, data: extra.subarray(cursor + 4, cursor + 4 + length) });
        cursor += 4 + length;
      }
      records.push({
        kind: "central",
        versionNeeded: view.getUint16(at + 6, true),
        compressed: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        offset: view.getUint32(at + 42, true),
        name: tail.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
        zip64: fields.find((field) => field.id === 0x0001)?.data,
      });
      at += 46 + nameLength + extraLength;
    } else if (signature === 0x06064b50) {
      records.push({ kind: "end64", entries: Number(view.getBigUint64(at + 32, true)), size: Number(view.getBigUint64(at + 40, true)), offset: Number(view.getBigUint64(at + 48, true)) });
      at += 56;
    } else if (signature === 0x07064b50) {
      records.push({ kind: "locator", recordOffset: Number(view.getBigUint64(at + 8, true)) });
      at += 20;
    } else if (signature === 0x06054b50) {
      records.push({ kind: "end", entries: view.getUint16(at + 10, true), size: view.getUint32(at + 12, true), offset: view.getUint32(at + 16, true) });
      at += 22;
    } else {
      assert.fail(`unknown record ${signature.toString(16)} at ${at}`);
    }
  }
  return records;
}

test("an entry of 4 GiB or more gets 64-bit sizes in its headers, and the classic fields say so", () => {
  const huge = 5 * 2 ** 30;
  const plan = planZip([{ name: "userdata.bin", data: pretendBlob(huge), crc32: 0xdeadbeef, modified: MODIFIED }]);
  assert.equal(plan.zip64, true);
  assert.equal(plan.size > huge, true);
  const records = readTail(plan, plan.layout[0].dataPart + 1);
  const central = records.find((record) => record.kind === "central");
  const end = records.find((record) => record.kind === "end");
  assert.deepEqual(records.map((record) => record.kind), ["central", "end64", "locator", "end"], "the directory starts past 4 GiB, so the ZIP64 end records are there too");
  assert.equal(central.size, 0xffffffff);
  assert.equal(central.compressed, 0xffffffff);
  assert.equal(central.versionNeeded, 45);
  assert.equal(central.offset, 0, "the offset still fits, so it is not widened");
  assert.equal(central.zip64.length, 16);
  assert.equal(Number(central.zip64.readBigUInt64LE(0)), huge);
  assert.equal(Number(central.zip64.readBigUInt64LE(8)), huge);
  assert.equal(end.entries, 1);
  assert.equal(end.offset, 0xffffffff);
  assert.equal(plan.layout[0].zip64, true);

  const local = Buffer.from(plan.parts[0]);
  assert.equal(local.readUInt32LE(18), 0xffffffff);
  assert.equal(local.readUInt32LE(22), 0xffffffff);
  assert.equal(local.readUInt16LE(4), 45);
});

test("past 4 GiB the header offsets and the directory use ZIP64 too, and the end records point at each other", () => {
  const each = Math.floor(2.5 * 2 ** 30);
  const plan = planZip([1, 2, 3].map((n) => ({ name: `part-${n}.bin`, data: pretendBlob(each), crc32: n, modified: MODIFIED })));
  const records = readTail(plan, plan.layout[2].dataPart + 1);
  const centrals = records.filter((record) => record.kind === "central");
  assert.equal(centrals.length, 3);
  assert.equal(centrals[0].offset, 0);
  assert.equal(centrals[0].size, each, "2.5 GiB still fits a classic size field");
  assert.equal(centrals[0].zip64, undefined);
  assert.equal(centrals[2].offset, 0xffffffff, "the third header starts past 4 GiB");
  assert.equal(Number(centrals[2].zip64.readBigUInt64LE(0)), plan.layout[2].headerOffset);
  assert.equal(centrals[2].zip64.length, 8, "only the offset is widened");

  const end64 = records.find((record) => record.kind === "end64");
  const locator = records.find((record) => record.kind === "locator");
  const end = records.find((record) => record.kind === "end");
  const directoryOffset = plan.layout[2].dataOffset + each;
  assert.equal(end64.entries, 3);
  assert.equal(end64.offset, directoryOffset);
  assert.equal(end.offset, 0xffffffff);
  assert.equal(end.entries, 3);
  assert.equal(locator.recordOffset, plan.size - 22 - 20 - 56);
});

test("65,535 entries or more also needs the ZIP64 end records", () => {
  const entries = Array.from({ length: 65_535 }, (_, index) => ({ name: `f${index}`, data: new Uint8Array(0), crc32: 0, modified: MODIFIED }));
  const plan = planZip(entries);
  assert.equal(plan.zip64, true);
  const end = readTail(plan, plan.parts.length - 3).find((record) => record.kind === "end");
  assert.equal(end.entries, 0xffff);
});

test("a name that could write outside the folder it is extracted into is refused, and so is one used twice", () => {
  const entry = (name) => ({ name, data: new Uint8Array(1), crc32: 0, modified: MODIFIED });
  for (const name of ["../escape.bin", "/etc/passwd", "a/../../b", "a\\b", "a/./b", "", "dir/", "a//b", "bad\u0000name", "line\nbreak"]) {
    assert.throws(() => planZip([entry(name)]), ZipPlanError, JSON.stringify(name));
  }
  assert.throws(() => planZip([entry("x"), entry("x")]), /appears twice/);
  assert.throws(() => planZip([{ ...entry("x"), crc32: -1 }]), /CRC-32/);
  assert.throws(() => planZip([{ ...entry("x"), crc32: 2 ** 32 }]), /CRC-32/);
  assert.doesNotThrow(() => planZip([entry("backup/boot_a.bin"), entry("データ.bin")]));
});

test("a file whose bytes are not the ones the plan was made for stops the write instead of producing a bad archive", async () => {
  const bytes = randomBytes(5000);
  const wrongChecksum = planZip([{ name: "a.bin", data: new Blob([bytes]), crc32: (nodeCrc32(bytes) ^ 1) >>> 0, modified: MODIFIED }]);
  await assert.rejects(() => bytesOf(zipStream(wrongChecksum, { verify: true })), /no longer matches the checksum recorded for it/);
  assert.equal((await bytesOf(zipStream(wrongChecksum))).length, wrongChecksum.size, "without verify it is written as asked");

  const wrongSize = planZip([{ name: "a.bin", data: Object.assign(new Blob([bytes]), {}), crc32: nodeCrc32(bytes), modified: MODIFIED }]);
  const lying = { ...wrongSize, parts: wrongSize.parts.map((part) => (part instanceof Blob ? new Blob([bytes.subarray(0, 100)]) : part)) };
  await assert.rejects(() => bytesOf(zipStream(lying, { verify: true })), /changed size/);
});

test("cancelling stops the writer and the reading behind it", async () => {
  const controller = new AbortController();
  const bytes = randomBytes(9 * 1024 * 1024);
  const plan = planZip([source("a.bin", bytes), source("b.bin", bytes)]);
  const reader = zipStream(plan, { signal: controller.signal }).getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(async () => {
    for (let guard = 0; guard < 100; guard += 1) {
      const next = await reader.read();
      if (next.done) return;
    }
  }, (error) => error?.name === "AbortError");
});

test("progress counts every byte of the archive exactly once", async () => {
  const { plan } = await sample();
  let counted = 0;
  const written = await bytesOf(zipStream(plan, { onBytes: (bytes) => { counted += bytes; } }));
  assert.equal(counted, written.length);
});

const hasTool = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status !== null;

test("unzip -t and Python's zipfile accept the archive, classic and ZIP64, with matching contents", { skip: !hasTool("unzip", ["-v"]) || !hasTool("python3", ["--version"]) }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "cody-zip-"));
  for (const forceZip64 of [false, true]) {
    const { plan, contents } = await sample({ forceZip64 });
    const file = join(directory, forceZip64 ? "zip64.zip" : "classic.zip");
    writeFileSync(file, await bytesOf(zipStream(plan, { verify: true })));
    const tested = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.equal(tested.status, 0, `unzip -t (${forceZip64 ? "zip64" : "classic"}): ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /No errors detected/);
    const script = [
      "import hashlib, json, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "print(json.dumps({i.filename: [i.file_size, i.compress_type, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()}))",
    ].join("\n");
    const python = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    const seen = JSON.parse(python.stdout);
    for (const [index, entry] of plan.layout.entries()) {
      assert.deepEqual(seen[entry.name], [contents[index].length, 0, sha256(contents[index])], entry.name);
    }
  }
});
