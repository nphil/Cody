import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { crc32 as nodeCrc32, inflateRawSync } from "node:zlib";
import { createJiti } from "jiti";

/**
 * The shared zip writer, proven the way a stranger would use its output: the real `unzip -t`, Python's `zipfile`
 * and `sha256sum -c` (each skipped politely when it is missing), Cody's own reader, and an independent parser written
 * here that reads every header, descriptor and end record straight from the bytes.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const archive = await jiti.import("./artifact-archive.ts");
const { openZip } = await jiti.import("./zip-archive.ts");
const { writeArchive, blobSource, bytesSource, ArchiveError, encodeLocalHeader, encodeDataDescriptor, encodeCentralRecord, encodeEndRecords } = archive;

const MODIFIED = Date.parse("2026-10-06T18:31:12Z");
const MiB = 1024 * 1024;
const scratch = mkdtempSync(join(tmpdir(), "cody-archive-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const hasTool = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status !== null;
const HAS_UNZIP = hasTool("unzip", ["-v"]);
const HAS_PYTHON = hasTool("python3", ["--version"]);
/** 7-Zip, under any of the names its Linux and p7zip builds go by, or the one `CODY_TEST_7Z` points at; absent on most machines. */
const SEVEN_ZIP = [process.env.CODY_TEST_7Z, "7zz", "7z", "7za"].find((command) => command && hasTool(command, ["i"]));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The whole stream, or the error it ends with; `partial` is what had been delivered by then. */
async function drain(stream) {
  const chunks = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks);
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    error.partial = Buffer.concat(chunks);
    throw error;
  }
}

async function write(sources, options) {
  const { stream, summary } = writeArchive(sources, options);
  const bytes = await drain(stream);
  return { bytes, summary: await summary };
}

/** A stream of `bytes` in slices, pulled one at a time. */
function sliced(bytes, slice = 64 * 1024) {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + slice));
      at += slice;
    },
  }, { highWaterMark: 0 });
}

const source = (name, bytes, extra = {}) => ({ name, size: bytes.length, modified: MODIFIED, open: () => sliced(bytes), ...extra });

/** What the sample archive holds, in order: three deflated files, an empty one, and two stored entries. */
function sample() {
  const small = randomBytes(1234);
  const big = Buffer.concat([randomBytes(256 * 1024), Buffer.alloc(3 * MiB), randomBytes(1000)]);
  const text = Buffer.from("non-ascii name");
  const sums = Buffer.from(`${"0".repeat(64)}  boot_a.bin\n`);
  const manifest = Buffer.from(`${JSON.stringify({ files: Array.from({ length: 40 }, (_, index) => ({ index, note: "x".repeat(30) })) }, null, 2)}\n`);
  const items = [
    { name: "backup/edl-1-set-p1-boot_a.bin", bytes: small, stored: false },
    { name: "backup/empty.bin", bytes: Buffer.alloc(0), stored: true },
    { name: "backup/edl-1-set-p2-userdata.bin", bytes: big, stored: false },
    { name: "backup/データ-π.txt", bytes: text, stored: false },
    { name: "backup/SHA256SUMS", bytes: sums, stored: true },
    { name: "backup/manifest.json", bytes: manifest, stored: true },
  ];
  const sources = items.map((item) => (item.stored && item.bytes.length > 0 ? bytesSource(item.name, item.bytes, MODIFIED) : blobSource(item.name, new Blob([item.bytes]), MODIFIED)));
  return { items, sources };
}

// ---------------------------------------------------------------------------------------------------------------------
// An independent reading of the bytes
// ---------------------------------------------------------------------------------------------------------------------

function extraFields(extra) {
  const fields = [];
  for (let at = 0; at + 4 <= extra.length; ) {
    const length = extra.readUInt16LE(at + 2);
    fields.push({ id: extra.readUInt16LE(at), data: extra.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return fields;
}

/** The records of an archive's tail (central records, ZIP64 end record and locator, end record), one after the other. */
function readTail(buffer) {
  const records = [];
  for (let at = 0; at < buffer.length; ) {
    const signature = buffer.readUInt32LE(at);
    if (signature === 0x02014b50) {
      const nameLength = buffer.readUInt16LE(at + 28);
      const extraLength = buffer.readUInt16LE(at + 30);
      const commentLength = buffer.readUInt16LE(at + 32);
      records.push({
        kind: "central",
        versionMadeBy: buffer.readUInt16LE(at + 4),
        versionNeeded: buffer.readUInt16LE(at + 6),
        flags: buffer.readUInt16LE(at + 8),
        method: buffer.readUInt16LE(at + 10),
        time: buffer.readUInt16LE(at + 12),
        date: buffer.readUInt16LE(at + 14),
        crc: buffer.readUInt32LE(at + 16),
        compressed: buffer.readUInt32LE(at + 20),
        size: buffer.readUInt32LE(at + 24),
        external: buffer.readUInt32LE(at + 38),
        offset: buffer.readUInt32LE(at + 42),
        name: buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
        fields: extraFields(buffer.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)),
      });
      at += 46 + nameLength + extraLength + commentLength;
    } else if (signature === 0x06064b50) {
      records.push({
        kind: "end64",
        recordSize: Number(buffer.readBigUInt64LE(at + 4)),
        versionNeeded: buffer.readUInt16LE(at + 14),
        entries: Number(buffer.readBigUInt64LE(at + 32)),
        size: Number(buffer.readBigUInt64LE(at + 40)),
        offset: Number(buffer.readBigUInt64LE(at + 48)),
      });
      at += 56;
    } else if (signature === 0x07064b50) {
      records.push({ kind: "locator", recordOffset: Number(buffer.readBigUInt64LE(at + 8)), disks: buffer.readUInt32LE(at + 16) });
      at += 20;
    } else if (signature === 0x06054b50) {
      records.push({ kind: "end", entries: buffer.readUInt16LE(at + 10), size: buffer.readUInt32LE(at + 12), offset: buffer.readUInt32LE(at + 16), commentLength: buffer.readUInt16LE(at + 20) });
      at += 22;
    } else {
      assert.fail(`unknown record ${signature.toString(16)} at ${at}`);
    }
  }
  return records;
}

/** The three values a central record may keep in its ZIP64 field, in the order the format fixes. */
function wideValues(central) {
  const field = central.fields.find((candidate) => candidate.id === 0x0001);
  const taken = {};
  let at = 0;
  for (const [key, saturated] of [["size", central.size === 0xffffffff], ["compressed", central.compressed === 0xffffffff], ["offset", central.offset === 0xffffffff]]) {
    if (!saturated) continue;
    taken[key] = Number(field.data.readBigUInt64LE(at));
    at += 8;
  }
  assert.equal(field?.data.length ?? 0, at, `${central.name}: the ZIP64 field holds exactly the values the classic fields could not`);
  return taken;
}

/** Every entry of a whole archive: central record, local header, data, descriptor and the inflated content. */
function inspect(bytes) {
  const endAt = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(endAt), 0x06054b50, "the archive ends with the end record, no comment");
  let directoryOffset = bytes.readUInt32LE(endAt + 16);
  const locatorAt = endAt - 20;
  const locator = locatorAt >= 0 && bytes.readUInt32LE(locatorAt) === 0x07064b50 ? locatorAt : undefined;
  if (locator !== undefined) {
    const end64At = Number(bytes.readBigUInt64LE(locator + 8));
    assert.equal(bytes.readUInt32LE(end64At), 0x06064b50, "the locator points at the ZIP64 end record");
    directoryOffset = Number(bytes.readBigUInt64LE(end64At + 48));
  }
  const tail = readTail(bytes.subarray(directoryOffset));
  const centrals = tail.filter((record) => record.kind === "central");
  const entries = [];
  let expectedNext = 0;
  for (const central of centrals) {
    const wide = wideValues(central);
    const size = wide.size ?? central.size;
    const compressed = wide.compressed ?? central.compressed;
    const offset = wide.offset ?? central.offset;
    assert.equal(offset, expectedNext, `${central.name}: entries follow one another with nothing between them`);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50, `${central.name}: a local header is there`);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const local = {
      versionNeeded: bytes.readUInt16LE(offset + 4),
      flags: bytes.readUInt16LE(offset + 6),
      method: bytes.readUInt16LE(offset + 8),
      time: bytes.readUInt16LE(offset + 10),
      date: bytes.readUInt16LE(offset + 12),
      crc: bytes.readUInt32LE(offset + 14),
      compressed: bytes.readUInt32LE(offset + 18),
      size: bytes.readUInt32LE(offset + 22),
      name: bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"),
      fields: extraFields(bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + extraLength)),
    };
    const dataAt = offset + 30 + nameLength + extraLength;
    const data = bytes.subarray(dataAt, dataAt + compressed);
    let descriptor;
    let end = dataAt + compressed;
    if (central.flags & 0x0008) {
      const wideSizes = central.size === 0xffffffff;
      assert.equal(bytes.readUInt32LE(end), 0x08074b50, `${central.name}: the data descriptor follows the data`);
      descriptor = wideSizes
        ? { crc: bytes.readUInt32LE(end + 4), compressed: Number(bytes.readBigUInt64LE(end + 8)), size: Number(bytes.readBigUInt64LE(end + 16)), length: 24 }
        : { crc: bytes.readUInt32LE(end + 4), compressed: bytes.readUInt32LE(end + 8), size: bytes.readUInt32LE(end + 12), length: 16 };
      end += descriptor.length;
    }
    expectedNext = end;
    const content = central.method === 8 ? inflateRawSync(data) : data;
    entries.push({ central, local, name: central.name, offset, size, compressed, descriptor, data, content, wide });
  }
  assert.equal(expectedNext, directoryOffset, "the central directory starts right after the last entry");
  return { entries, tail, directoryOffset, locator };
}

/** What real readers say about an archive on disk. */
function proveWithTools(file, items) {
  if (HAS_UNZIP) {
    const tested = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.equal(tested.status, 0, `unzip -t: ${tested.stdout}${tested.stderr}`);
    assert.match(tested.stdout, /No errors detected/);
  }
  if (SEVEN_ZIP) {
    // 7-Zip 18.05 to 21.03 only warn ("Headers Error", exit 0) about a ZIP64 field beside an unsaturated classic field: the words are the proof.
    const tested = spawnSync(SEVEN_ZIP, ["t", file], { encoding: "utf8" });
    assert.equal(tested.status, 0, `${SEVEN_ZIP} t: ${tested.stdout}${tested.stderr}`);
    assert.doesNotMatch(`${tested.stdout}${tested.stderr}`, /Headers Error|Warning/, `${SEVEN_ZIP} t: every header must be to its liking`);
    assert.match(tested.stdout, /Everything is Ok/);
  }
  if (HAS_PYTHON) {
    const zipModule = spawnSync("python3", ["-m", "zipfile", "-t", file], { encoding: "utf8" });
    assert.equal(zipModule.status, 0, `python3 -m zipfile -t: ${zipModule.stdout}${zipModule.stderr}`);
    const script = [
      "import hashlib, json, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "print(json.dumps([[i.filename, i.file_size, i.compress_size, i.compress_type, hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]))",
    ].join("\n");
    const python = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    const seen = JSON.parse(python.stdout);
    assert.deepEqual(seen.map((row) => row[0]), items.map((item) => item.name), "names, in order");
    for (const [index, item] of items.entries()) {
      assert.equal(seen[index][1], item.bytes.length, `${item.name}: size`);
      assert.equal(seen[index][3], item.stored || item.bytes.length === 0 ? 0 : 8, `${item.name}: method`);
      assert.equal(seen[index][4], sha256(item.bytes), `${item.name}: contents are byte for byte what went in`);
    }
    return seen;
  }
  return undefined;
}

async function proveWithOwnReader(bytes, items) {
  const zip = await openZip(new Blob([bytes]));
  assert.deepEqual(zip.entries.map((entry) => entry.name), items.map((item) => item.name));
  for (const [index, entry] of zip.entries.entries()) {
    assert.equal(entry.size, items[index].bytes.length);
    assert.equal(entry.crc32, nodeCrc32(items[index].bytes));
    assert.equal(sha256(Buffer.from(await (await zip.open(entry)).arrayBuffer())), sha256(items[index].bytes), items[index].name);
  }
}

async function proveEverywhere(label, options, expectations) {
  const { items, sources } = sample();
  const { bytes, summary } = await write(sources, options);
  const file = join(scratch, `${label}.zip`);
  writeFileSync(file, bytes);
  proveWithTools(file, items);
  await proveWithOwnReader(bytes, items);
  const inspected = inspect(bytes);
  for (const [index, entry] of inspected.entries.entries()) {
    assert.ok(items[index].bytes.equals(entry.content), `${entry.name}: inflated by node:zlib, byte for byte`);
    assert.equal(entry.central.crc, nodeCrc32(items[index].bytes), `${entry.name}: CRC-32`);
    assert.equal(entry.central.versionMadeBy >> 8, 3, "made on UNIX");
    assert.equal(entry.central.external >>> 16, 0o100644, "a regular file, 0644");
    assert.equal(summary.entries[index].headerOffset, entry.offset, `${entry.name}: the summary knows where the entry starts`);
    assert.equal(summary.entries[index].compressedSize, entry.compressed);
    assert.equal(summary.entries[index].size, entry.size);
    assert.equal(summary.entries[index].crc32, entry.central.crc);
  }
  assert.equal(summary.bytes, bytes.length, "the summary's archive length is the real one");
  assert.equal(summary.originalBytes, items.reduce((total, item) => total + item.bytes.length, 0));
  expectations({ bytes, summary, inspected, items });
}

// ---------------------------------------------------------------------------------------------------------------------
// The archive, classic and ZIP64
// ---------------------------------------------------------------------------------------------------------------------

test("a classic archive deflates the data, stores the empty and the metadata entries, and every reader gets the bytes back", async () => {
  await proveEverywhere("classic", {}, ({ summary, inspected, items }) => {
    assert.equal(summary.zip64, false, "a normal backup stays a classic archive every unzip opens");
    assert.equal(inspected.locator, undefined);
    for (const [index, entry] of inspected.entries.entries()) {
      const deflated = !items[index].stored;
      assert.equal(entry.central.method, deflated ? 8 : 0, `${entry.name}: method`);
      assert.equal(entry.local.method, entry.central.method);
      assert.equal(summary.entries[index].method, entry.central.method);
      assert.equal(entry.central.versionNeeded, 20);
      assert.equal(entry.local.versionNeeded, 20);
      if (deflated) {
        assert.equal(entry.central.flags & 0x0008, 0x0008, `${entry.name}: the CRC and sizes follow the data`);
        assert.deepEqual([entry.local.crc, entry.local.compressed, entry.local.size], [0, 0, 0], `${entry.name}: the local header cannot know them yet`);
        assert.deepEqual([entry.descriptor.crc, entry.descriptor.compressed, entry.descriptor.size, entry.descriptor.length], [entry.central.crc, entry.compressed, entry.size, 16]);
      } else {
        assert.equal(entry.central.flags & 0x0008, 0, `${entry.name}: stored with everything in the local header`);
        assert.deepEqual([entry.local.crc, entry.local.compressed, entry.local.size], [entry.central.crc, entry.size, entry.size], `${entry.name}: any tool can read it without inflating`);
        assert.equal(entry.descriptor, undefined);
        assert.equal(entry.compressed, entry.size);
      }
      assert.equal(entry.local.flags & 0x0800, entry.name.includes("データ") ? 0x0800 : 0, `${entry.name}: the UTF-8 flag only where the name needs it`);
      assert.equal(entry.central.flags, entry.local.flags);
    }
  });
});

test("an empty list is a valid, empty zip: just the end record", async () => {
  const { bytes, summary } = await write([]);
  assert.equal(bytes.length, 22);
  assert.deepEqual(readTail(bytes).map((entry) => entry.kind), ["end"]);
  assert.deepEqual([summary.entries.length, summary.bytes, summary.originalBytes, summary.zip64], [0, 22, 0, false]);
  if (HAS_PYTHON) {
    const file = join(scratch, "empty.zip");
    writeFileSync(file, bytes);
    const python = spawnSync("python3", ["-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(len(z.namelist()), z.testzip())", file], { encoding: "utf8" });
    assert.equal(python.stdout.trim(), "0 None", python.stderr);
  }
});

test("forcing ZIP64 on small data writes 64-bit records everywhere, and unzip, Python, 7-Zip and Cody's reader still read it", async () => {
  await proveEverywhere("zip64", { forceZip64: true }, ({ summary, inspected, items }) => {
    assert.equal(summary.zip64, true);
    assert.ok(summary.entries.every((entry) => entry.zip64));
    assert.deepEqual(inspected.tail.filter((record) => record.kind !== "central").map((record) => record.kind), ["end64", "locator", "end"]);
    const [end64, , end] = inspected.tail.filter((record) => record.kind !== "central");
    assert.equal(end64.entries, items.length);
    assert.deepEqual([end.entries, end.size, end.offset], [0xffff, 0xffffffff, 0xffffffff], "the classic end record says 'look in the ZIP64 record', as it does in an archive that really needs it");
    for (const [index, entry] of inspected.entries.entries()) {
      assert.equal(entry.central.versionNeeded, 45);
      assert.equal(entry.local.versionNeeded, 45);
      assert.deepEqual([entry.central.size, entry.central.compressed, entry.central.offset], [0xffffffff, 0xffffffff, 0xffffffff], "the classic fields say: look at the ZIP64 field");
      assert.deepEqual(entry.wide, { size: entry.size, compressed: entry.compressed, offset: entry.offset });
      const local64 = entry.local.fields.find((field) => field.id === 0x0001);
      assert.equal(local64.data.length, 16);
      if (items[index].stored) {
        assert.deepEqual([entry.local.compressed, entry.local.size], [0xffffffff, 0xffffffff]);
        assert.deepEqual([Number(local64.data.readBigUInt64LE(0)), Number(local64.data.readBigUInt64LE(8))], [entry.size, entry.size], "a stored entry's real sizes");
      } else {
        assert.deepEqual([entry.local.compressed, entry.local.size], [0xffffffff, 0xffffffff], "the classic fields are saturated wherever a ZIP64 field is present: 7-Zip 18.05 to 21.03 refuse zeros beside one");
        assert.deepEqual([Number(local64.data.readBigUInt64LE(0)), Number(local64.data.readBigUInt64LE(8))], [0, 0], "placeholders: a 64-bit descriptor follows");
        assert.equal(entry.descriptor.length, 24);
        assert.deepEqual([entry.descriptor.compressed, entry.descriptor.size], [entry.compressed, entry.size]);
      }
    }
  });
});

test("an entry at or over the wide threshold takes 64-bit sizes and the others stay classic, in one archive", async () => {
  await proveEverywhere("wide", { wideEntryBytes: 1000 }, ({ summary, inspected, items }) => {
    assert.equal(summary.zip64, true);
    for (const [index, entry] of inspected.entries.entries()) {
      const wide = items[index].bytes.length >= 1000;
      assert.equal(entry.central.size === 0xffffffff, wide, `${entry.name} (${items[index].bytes.length} bytes)`);
      assert.equal(entry.central.versionNeeded, wide ? 45 : 20);
      assert.equal(entry.central.offset === 0xffffffff, false, "offsets are far below 4 GiB");
      assert.equal(summary.entries[index].zip64, wide);
      if (wide && !items[index].stored) assert.equal(entry.descriptor.length, 24, `${entry.name}: 8-byte descriptor sizes`);
      if (!wide && !items[index].stored && items[index].bytes.length > 0) assert.equal(entry.descriptor.length, 16);
    }
    assert.ok(items.some((item) => item.stored && item.bytes.length >= 1000), "the sample has a stored entry over the threshold too");
    assert.equal(inspected.locator, undefined, "no entry count or offset needs ZIP64 end records");
  });
});

test("65,535 stored empty entries are really written, with ZIP64 end records, and Python reads every one", { timeout: 60_000 }, async () => {
  const names = Array.from({ length: 65_535 }, (_, index) => `folder/file-${index}`);
  const { bytes, summary } = await write(names.map((name) => bytesSource(name, new Uint8Array(0), MODIFIED)));
  assert.equal(summary.entries.length, 65_535);
  assert.equal(summary.zip64, true);
  const tail = readTail(bytes.subarray(bytes.length - (22 + 20 + 56)));
  assert.deepEqual(tail.map((record) => record.kind), ["end64", "locator", "end"]);
  assert.equal(tail[0].entries, 65_535);
  assert.equal(tail[2].entries, 0xffff, "the classic count is saturated");
  const file = join(scratch, "many.zip");
  writeFileSync(file, bytes);
  if (HAS_PYTHON) {
    const script = "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(len(z.namelist()), z.testzip(), z.namelist()[0], z.namelist()[-1])";
    const python = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(python.stdout.trim(), "65535 None folder/file-0 folder/file-65534");
  }
  if (HAS_UNZIP) {
    const listed = spawnSync("unzip", ["-tqq", file], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  }
  const zip = await openZip(new Blob([bytes]));
  assert.equal(zip.entries.length, 65_535);
});

test("modification times are written in both clocks: Info-ZIP's UTC field and DOS time in the reader's zone", async () => {
  const moment = new Date(MODIFIED);
  const { bytes } = await write([source("a.bin", Buffer.from("x"), { modified: MODIFIED })]);
  const [entry] = inspect(bytes).entries;
  const utc = entry.local.fields.find((field) => field.id === 0x5455);
  assert.equal(utc.data[0], 1, "the modification time is present");
  assert.equal(utc.data.readUInt32LE(1), Math.floor(MODIFIED / 1000));
  assert.deepEqual(entry.central.fields.find((field) => field.id === 0x5455).data, utc.data, "the central record carries it too");
  for (const record of [entry.local, entry.central]) {
    assert.equal(record.date, ((moment.getFullYear() - 1980) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate());
    assert.equal(record.time, (moment.getHours() << 11) | (moment.getMinutes() << 5) | (moment.getSeconds() >> 1));
  }
  if (HAS_PYTHON) {
    const file = join(scratch, "times.zip");
    writeFileSync(file, bytes);
    const python = spawnSync("python3", ["-c", "import json, sys, zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).infolist()[0].date_time))", file], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(python.stdout), [moment.getFullYear(), moment.getMonth() + 1, moment.getDate(), moment.getHours(), moment.getMinutes(), moment.getSeconds() - (moment.getSeconds() % 2)]);
  }
  // Before 1980 and after 2107 a DOS date cannot say it: the nearest it can.
  const early = Buffer.from(encodeLocalHeader({ name: "a", modified: 0, method: 0, descriptor: false, wideSizes: false, crc32: 0, compressedSize: 0, size: 0, headerOffset: 0, wideOffset: false }));
  assert.deepEqual([early.readUInt16LE(10), early.readUInt16LE(12)], [0, (1 << 5) | 1], "1980-01-01 00:00");
  const late = Buffer.from(encodeLocalHeader({ name: "a", modified: Date.UTC(2200, 5, 1), method: 0, descriptor: false, wideSizes: false, crc32: 0, compressedSize: 0, size: 0, headerOffset: 0, wideOffset: false }));
  assert.deepEqual([late.readUInt16LE(10), late.readUInt16LE(12)], [(23 << 11) | (59 << 5) | 29, (127 << 9) | (12 << 5) | 31], "2107-12-31 23:59:58");
});

// ---------------------------------------------------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------------------------------------------------

/** A file that is zeros but for a little random data, produced a megabyte at a time, so a 20 MB file never sits in memory. */
function mostlyZeros(total, randomAt) {
  let sent = 0;
  const noise = randomBytes(64 * 1024);
  const zeros = new Uint8Array(MiB);
  const digest = createHash("sha256");
  let crc = 0;
  const open = () =>
    new ReadableStream({
      pull(controller) {
        if (sent >= total) return controller.close();
        const chunk = randomAt.includes(sent / MiB) ? Buffer.concat([noise, zeros.subarray(0, MiB - noise.length)]) : zeros;
        sent += chunk.length;
        digest.update(chunk);
        crc = nodeCrc32(chunk, crc);
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
  return { open, size: total, digest: () => digest.digest("hex"), crc: () => crc };
}

test("a 20 MB file that is mostly zeros packs to a small fraction of its size and reads back identical", async () => {
  const file = mostlyZeros(20 * MiB, [0, 10]);
  const { bytes, summary } = await write([{ name: "dump/userdata.bin", size: file.size, modified: MODIFIED, open: file.open }]);
  const [entry] = summary.entries;
  assert.ok(entry.compressedSize < file.size / 50, `20 MiB packed to ${entry.compressedSize} bytes`);
  assert.ok(bytes.length < file.size / 50, "the whole archive is that small");
  assert.equal(entry.crc32, file.crc(), "the CRC-32 was taken on the way through");
  const [inspected] = inspect(bytes).entries;
  assert.equal(inspected.content.length, file.size);
  assert.equal(sha256(inspected.content), file.digest());
  if (HAS_UNZIP) {
    const target = join(scratch, "zeros.zip");
    writeFileSync(target, bytes);
    assert.equal(spawnSync("unzip", ["-t", target], { encoding: "utf8" }).status, 0);
  }
});

test("data that does not compress is written as it is, a hair larger, and still reads back identical", async () => {
  const random = randomBytes(3 * MiB + 11);
  const { bytes, summary } = await write([blobSource("dump/random.bin", new Blob([random]), MODIFIED)]);
  const [entry] = summary.entries;
  assert.ok(entry.compressedSize >= random.length * 0.999 && entry.compressedSize <= random.length * 1.005, `${random.length} became ${entry.compressedSize}`);
  assert.ok(random.equals(inspect(bytes).entries[0].content));
});

// ---------------------------------------------------------------------------------------------------------------------
// The record encoders, with sizes and offsets no test could write
// ---------------------------------------------------------------------------------------------------------------------

const record = (extra = {}) => ({ name: "userdata.bin", modified: MODIFIED, method: 8, descriptor: true, wideSizes: false, crc32: 0xdeadbeef, compressedSize: 1000, size: 2000, headerOffset: 0, wideOffset: false, ...extra });

test("an entry of 5 GiB gets 64-bit sizes: all ones in the classic fields, the real numbers in the ZIP64 field, a 64-bit descriptor", () => {
  const huge = 5 * 2 ** 30;
  const packed = 3 * 2 ** 30;
  const entry = record({ wideSizes: true, size: huge, compressedSize: packed });

  const [central] = readTail(Buffer.from(encodeCentralRecord(entry)));
  assert.equal(central.versionNeeded, 45);
  assert.equal(central.versionMadeBy, (3 << 8) | 45);
  assert.deepEqual([central.size, central.compressed, central.offset], [0xffffffff, 0xffffffff, 0]);
  const field = central.fields.find((candidate) => candidate.id === 0x0001);
  assert.equal(field.data.length, 16, "just the two sizes: the offset still fits, so it is not widened");
  assert.equal(Number(field.data.readBigUInt64LE(0)), huge, "uncompressed size first");
  assert.equal(Number(field.data.readBigUInt64LE(8)), packed, "then the compressed size");

  const descriptor = Buffer.from(encodeDataDescriptor(entry));
  assert.equal(descriptor.length, 24);
  assert.equal(descriptor.readUInt32LE(0), 0x08074b50);
  assert.equal(descriptor.readUInt32LE(4), 0xdeadbeef);
  assert.equal(Number(descriptor.readBigUInt64LE(8)), packed, "compressed size, 8 bytes");
  assert.equal(Number(descriptor.readBigUInt64LE(16)), huge, "uncompressed size, 8 bytes");

  const local = Buffer.from(encodeLocalHeader(entry));
  assert.equal(local.readUInt16LE(4), 45);
  assert.equal(local.readUInt16LE(6) & 0x0008, 0x0008);
  assert.deepEqual([local.readUInt32LE(14), local.readUInt32LE(18), local.readUInt32LE(22)], [0, 0xffffffff, 0xffffffff], "a descriptor entry's header holds no CRC yet, and sizes that point at the ZIP64 field");
  const localField = extraFields(local.subarray(30 + 12, 30 + 12 + local.readUInt16LE(28))).find((candidate) => candidate.id === 0x0001);
  assert.equal(localField.data.length, 16, "the ZIP64 field is there, as the sign that a 64-bit descriptor follows");
  assert.ok(localField.data.every((byte) => byte === 0));

  const stored = Buffer.from(encodeLocalHeader(record({ method: 0, descriptor: false, wideSizes: true, size: huge, compressedSize: huge })));
  assert.deepEqual([stored.readUInt32LE(18), stored.readUInt32LE(22)], [0xffffffff, 0xffffffff]);
  const storedField = extraFields(stored.subarray(30 + 12, 30 + 12 + stored.readUInt16LE(28))).find((candidate) => candidate.id === 0x0001);
  assert.deepEqual([Number(storedField.data.readBigUInt64LE(0)), Number(storedField.data.readBigUInt64LE(8))], [huge, huge], "a stored entry's real sizes are known up front");
});

test("a header offset past 4 GiB widens only the offset, and the end records point at each other", () => {
  const gib = 2 ** 30;
  const offset = 4 * gib + 123;
  const [central] = readTail(Buffer.from(encodeCentralRecord(record({ headerOffset: offset, wideOffset: true }))));
  assert.deepEqual([central.size, central.compressed, central.offset], [2000, 1000, 0xffffffff], "the sizes still fit");
  assert.equal(central.versionNeeded, 45);
  const field = central.fields.find((candidate) => candidate.id === 0x0001);
  assert.equal(field.data.length, 8, "only the offset is in the ZIP64 field");
  assert.equal(Number(field.data.readBigUInt64LE(0)), offset);
  const both = readTail(Buffer.from(encodeCentralRecord(record({ headerOffset: offset, wideOffset: true, wideSizes: true, size: 5 * gib, compressedSize: gib }))))[0];
  assert.deepEqual(wideValues(both), { size: 5 * gib, compressed: gib, offset }, "sizes first, then the offset");

  const directoryOffset = 6 * gib;
  const directorySize = 300;
  const records = readTail(Buffer.from(encodeEndRecords({ entries: 3, offset: directoryOffset, size: directorySize })));
  assert.deepEqual(records.map((entry) => entry.kind), ["end64", "locator", "end"]);
  const [end64, locator, end] = records;
  assert.deepEqual([end64.entries, end64.size, end64.offset, end64.recordSize, end64.versionNeeded], [3, directorySize, directoryOffset, 44, 45]);
  assert.equal(locator.recordOffset, directoryOffset + directorySize, "the ZIP64 end record sits right after the directory");
  assert.equal(locator.disks, 1);
  assert.deepEqual([end.entries, end.size, end.offset], [3, directorySize, 0xffffffff], "only the field that overflowed is saturated");
});

test("the ZIP64 end records come at 65,535 entries or a 4 GiB directory, and not a step before", () => {
  const kinds = (directory) => readTail(Buffer.from(encodeEndRecords(directory))).map((entry) => entry.kind);
  assert.deepEqual(kinds({ entries: 65_534, offset: 1000, size: 500 }), ["end"]);
  assert.deepEqual(kinds({ entries: 65_535, offset: 1000, size: 500 }), ["end64", "locator", "end"]);
  assert.deepEqual(kinds({ entries: 3, offset: 0xfffffffe, size: 500 }), ["end"]);
  assert.deepEqual(kinds({ entries: 3, offset: 0xffffffff, size: 500 }), ["end64", "locator", "end"]);
  assert.deepEqual(kinds({ entries: 3, offset: 1000, size: 0xffffffff }), ["end64", "locator", "end"]);
  assert.deepEqual(kinds({ entries: 3, offset: 1000, size: 500, forceZip64: true }), ["end64", "locator", "end"]);
  const [, , forced] = readTail(Buffer.from(encodeEndRecords({ entries: 3, offset: 1000, size: 500, forceZip64: true })));
  assert.deepEqual([forced.entries, forced.size, forced.offset], [0xffff, 0xffffffff, 0xffffffff], "forced: all three fields point at the ZIP64 record");
  const [, , end] = readTail(Buffer.from(encodeEndRecords({ entries: 70_000, offset: 1000, size: 500 })));
  assert.deepEqual([end.entries, end.size, end.offset], [0xffff, 500, 1000], "overflowing: only the field that overflowed");
});

test("Python and unzip read an archive whose first entry is 5 GiB and whose second starts past 4 GiB", { skip: !HAS_PYTHON }, (t) => {
  // A sparse file: the 5 GiB between the two entries is a hole, so this costs no disk.
  const huge = 5 * 2 ** 30;
  const tailBytes = Buffer.from("the end of the backup\n");
  const hugeEntry = record({ name: "userdata.bin", method: 0, descriptor: false, wideSizes: true, size: huge, compressedSize: huge, crc32: 0 });
  const first = Buffer.from(encodeLocalHeader(hugeEntry));
  const tailEntry = record({ name: "tail.txt", method: 0, descriptor: false, size: tailBytes.length, compressedSize: tailBytes.length, crc32: nodeCrc32(tailBytes), headerOffset: first.length + huge, wideOffset: true });
  const second = Buffer.from(encodeLocalHeader(tailEntry));
  const directoryOffset = first.length + huge + second.length + tailBytes.length;
  const central = Buffer.concat([encodeCentralRecord(hugeEntry), encodeCentralRecord(tailEntry)]);
  const end = Buffer.from(encodeEndRecords({ entries: 2, offset: directoryOffset, size: central.length }));
  const file = join(scratch, "sparse.zip");
  const handle = openSync(file, "w+");
  try {
    ftruncateSync(handle, directoryOffset);
    if (statSync(file).blocks * 512 > 64 * MiB) return t.skip("this filesystem does not keep holes in files");
    for (const [bytes, at] of [[first, 0], [second, first.length + huge], [tailBytes, first.length + huge + second.length], [central, directoryOffset], [end, directoryOffset + central.length]]) writeSync(handle, bytes, 0, bytes.length, at);
  } catch (error) {
    return t.skip(`cannot make a 5 GiB sparse file here: ${error.message}`);
  } finally {
    closeSync(handle);
  }
  const script = [
    "import json, sys, zipfile",
    "z = zipfile.ZipFile(sys.argv[1])",
    "big, tail = z.infolist()",
    "print(json.dumps([big.filename, big.file_size, big.compress_size, big.header_offset, tail.filename, tail.header_offset, z.read('tail.txt').decode()]))",
  ].join("\n");
  const python = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), ["userdata.bin", huge, huge, 0, "tail.txt", first.length + huge, tailBytes.toString()]);
  if (HAS_UNZIP) {
    const listed = spawnSync("unzip", ["-l", file], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, new RegExp(`${huge}\\s.*userdata\\.bin`));
    const extracted = spawnSync("unzip", ["-p", file, "tail.txt"], { encoding: "utf8" });
    assert.equal(extracted.stdout, tailBytes.toString(), "unzip finds the entry that starts past 4 GiB");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------------------

test("a name that could write outside the folder it is extracted into is refused, and so is one used twice", async () => {
  const entry = (name) => source(name, Buffer.from("x"));
  for (const name of ["../escape.bin", "/etc/passwd", "a/../../b", "a\\b", "a/./b", "", "dir/", "a//b", "bad\u0000name", "line\nbreak", "x".repeat(65_536)]) {
    assert.throws(() => writeArchive([entry(name)]), (error) => error instanceof ArchiveError && error.code === "unsafe-name", JSON.stringify(name.slice(0, 20)));
  }
  assert.throws(() => writeArchive([entry("x"), entry("x")]), (error) => error instanceof ArchiveError && error.code === "duplicate-name" && /"x" appears twice/.test(error.message));
  const fine = writeArchive([entry("backup/boot_a.bin"), entry("データ.bin"), entry("Backup/boot_a.bin")]);
  await fine.stream.cancel();
});

test("a source that cannot be written truthfully is refused before anything is read", () => {
  let opened = 0;
  const open = () => { opened += 1; return sliced(Buffer.from("x")); };
  const base = { name: "a", size: 1, modified: MODIFIED, open };
  assert.throws(() => writeArchive([{ ...base, crc32: -1 }]), RangeError);
  assert.throws(() => writeArchive([{ ...base, crc32: 2 ** 32 }]), /CRC-32/);
  assert.throws(() => writeArchive([{ ...base, crc32: 1.5 }]), /CRC-32/);
  assert.throws(() => writeArchive([{ ...base, size: -1 }]), RangeError);
  assert.throws(() => writeArchive([{ ...base, size: 1.5 }]), RangeError);
  assert.throws(() => writeArchive([{ ...base, modified: Number.NaN }]), RangeError);
  assert.throws(() => writeArchive([{ ...base, stored: true }]), /CRC-32 is needed up front/);
  assert.equal(opened, 0, "no source was opened for any of them");
});

// ---------------------------------------------------------------------------------------------------------------------
// A write that fails never produces a plausible archive
// ---------------------------------------------------------------------------------------------------------------------

/** Writes, expects it to fail, and proves the partial output is not an archive any reader opens. */
async function failsWith(sources, code, pattern, options) {
  const { stream, summary } = writeArchive(sources, options);
  let failure;
  await assert.rejects(drain(stream), (error) => { failure = error; return error instanceof ArchiveError && error.code === code && pattern.test(error.message); });
  await assert.rejects(summary, (error) => error === failure, "the summary rejects with the very error the stream failed with");
  assert.equal(failure.partial.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false, "no end record was written");
  if (HAS_PYTHON) {
    const file = join(scratch, `partial-${code}.zip`);
    writeFileSync(file, failure.partial);
    const python = spawnSync("python3", ["-c", "import sys, zipfile; sys.exit(0 if zipfile.is_zipfile(sys.argv[1]) else 3)", file]);
    assert.equal(python.status, 3, "Python does not take what was written for a zip");
  }
  return failure;
}

test("bytes that no longer match the CRC recorded for them fail the write and say the stored copy may be damaged", async () => {
  const bytes = randomBytes(5000);
  const wrong = (nodeCrc32(bytes) ^ 1) >>> 0;
  const failure = await failsWith([source("backup/a.bin", bytes, { crc32: wrong })], "damaged", /"backup\/a\.bin" no longer matches the checksum recorded for it.*stored copy may be damaged/);
  assert.equal(failure.name, "ArchiveError");
  await failsWith([source("backup/a.bin", bytes, { crc32: wrong, stored: true })], "damaged", /may be damaged/);
  await failsWith([source("backup/first.bin", randomBytes(100)), source("backup/zero.bin", Buffer.alloc(0), { crc32: 1 })], "damaged", /zero\.bin/);
  const right = await write([source("backup/a.bin", bytes, { crc32: nodeCrc32(bytes) })]);
  assert.ok(bytes.equals(inspect(right.bytes).entries[0].content), "the right CRC is simply checked and passes");
});

test("a source shorter or longer than it announced fails the write, naming the file", async () => {
  const bytes = randomBytes(5000);
  for (const stored of [false, true]) {
    const extra = stored ? { stored: true, crc32: nodeCrc32(bytes) } : {};
    await failsWith([source("backup/short.bin", bytes, { ...extra, size: 5001 })], "changed", /"backup\/short\.bin" changed while the archive was being written: it had 5001 bytes and only 5000 could be read/);
    await failsWith([source("backup/long.bin", bytes, { ...extra, size: 4999 })], "changed", /"backup\/long\.bin" changed .* it had 4999 bytes and more than that was read/);
  }
  await failsWith([source("backup/empty.bin", bytes, { size: 0 })], "changed", /"backup\/empty\.bin" changed/);
});

test("a source that fails while it is read fails the write with its own error", async () => {
  const broken = new Error("the disk went away");
  const sources = [{
    name: "backup/a.bin",
    size: 3 * MiB,
    modified: MODIFIED,
    open: () => {
      let pulls = 0;
      return new ReadableStream({ pull(controller) { pulls += 1; if (pulls > 3) throw broken; controller.enqueue(randomBytes(64 * 1024)); } }, { highWaterMark: 0 });
    },
  }];
  const { stream, summary } = writeArchive(sources);
  await assert.rejects(drain(stream), (error) => error === broken);
  await assert.rejects(summary, (error) => error === broken);
});

test("an entry that would pack to more than a classic field holds is refused, never written with a wrong descriptor", async () => {
  // The compressor misbehaves: four 1 GiB pieces for a 10-byte file. (One buffer, four views: nothing is touched.)
  const real = globalThis.CompressionStream;
  const buffer = new ArrayBuffer(2 ** 30);
  globalThis.CompressionStream = class {
    constructor() {
      let sent = 0;
      this.writable = new WritableStream();
      this.readable = new ReadableStream({ pull(controller) { if (sent < 4) { sent += 1; controller.enqueue(new Uint8Array(buffer)); } else controller.close(); } }, { highWaterMark: 0 });
    }
  };
  try {
    const { stream, summary } = writeArchive([source("backup/a.bin", Buffer.from("0123456789"))]);
    const reader = stream.getReader();
    await assert.rejects(async () => { for (;;) if ((await reader.read()).done) return; }, (error) => error instanceof ArchiveError && error.code === "too-large" && /"backup\/a\.bin"/.test(error.message));
    await assert.rejects(summary, (error) => error.code === "too-large");
    // The same pieces for an entry written wide are fine.
    const wide = writeArchive([source("backup/b.bin", Buffer.from("0123456789"))], { wideEntryBytes: 5 });
    const total = await (async () => { let bytes = 0; const wideReader = wide.stream.getReader(); for (;;) { const next = await wideReader.read(); if (next.done) return bytes; bytes += next.value.length; } })();
    assert.ok(total > 4 * 2 ** 30, "wide entries take the pieces");
    assert.equal((await wide.summary).entries[0].compressedSize, 4 * 2 ** 30);
  } finally {
    globalThis.CompressionStream = real;
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Cancelling and backpressure
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A source that never ends by itself, counts what was taken from it and notes when it is closed. Each 64 KiB chunk is
 * `noise` bytes of random data and zeros for the rest, so a test can choose how well it compresses.
 */
function endless(size = 64 * MiB, noise = 64 * 1024) {
  const chunk = Buffer.concat([randomBytes(noise), Buffer.alloc(64 * 1024 - noise)]);
  const state = { delivered: 0, closed: Promise.withResolvers(), cancelled: false };
  state.source = {
    name: "backup/endless.bin",
    size,
    modified: MODIFIED,
    open: () => new ReadableStream({
      pull(controller) { state.delivered += chunk.length; controller.enqueue(chunk); },
      cancel() { state.cancelled = true; state.closed.resolve(); },
    }, { highWaterMark: 0 }),
  };
  return state;
}

const within = (promise, milliseconds, what) => Promise.race([promise, sleep(milliseconds).then(() => assert.fail(`${what} did not happen within ${milliseconds} ms`))]);

/**
 * Stops pulling after the first chunk, waits for the chunk the writer makes ahead, and shows that the source is then
 * left alone: it stays below `limit` bytes of the 64 MiB it has, and does not move while the consumer keeps waiting.
 */
async function stalledReading({ noise, limit }) {
  const counted = endless(64 * MiB, noise);
  const { stream } = writeArchive([counted.source]);
  const reader = stream.getReader();
  const first = await reader.read();
  assert.ok(first.value.length >= 256 * 1024, "output comes in big chunks");
  let stalled = -1;
  for (let wait = 0; wait < 100 && counted.delivered !== stalled; wait += 1) {
    stalled = counted.delivered;
    await sleep(100);
  }
  assert.ok(stalled < limit, `${stalled} bytes were read while nobody was pulling, of ${64 * MiB}`);
  await sleep(400);
  assert.equal(counted.delivered, stalled, "and no more was read while the consumer kept waiting");
  for (let chunk = 0; chunk < 3; chunk += 1) await reader.read();
  assert.ok(counted.delivered > stalled, "pulling again resumes the reading");
  await reader.cancel();
  await within(counted.closed.promise, 2000, "closing the source");
}

// A plain pipe into the real compressor reads far ahead of a consumer that has stopped: Node's CompressionStream counts
// its queue in chunks, not bytes. (Random data fills the real compressor's own queues at once; data that packs 16 to 1
// does not.)
test("a consumer that stops pulling stops the reading (incompressible data)", () => stalledReading({ noise: 64 * 1024, limit: 4 * MiB }));
test("a consumer that stops pulling stops the reading (data that packs 16 to 1)", () => stalledReading({ noise: 4 * 1024, limit: 16 * MiB }));

test("a consumer that stops pulling stops the reading even when the compressor never pushes back", async () => {
  // The writer must not lean on the compressor's own queue: this one takes everything, instantly, and buffers without limit.
  const real = globalThis.CompressionStream;
  globalThis.CompressionStream = class {
    constructor() {
      let output;
      this.readable = new ReadableStream({ start(controller) { output = controller; } }, { highWaterMark: Number.POSITIVE_INFINITY });
      this.writable = new WritableStream({ write(chunk) { output.enqueue(chunk.slice()); }, close() { output.close(); }, abort(reason) { output.error(reason); } });
    }
  };
  try {
    await stalledReading({ noise: 64 * 1024, limit: 2 * MiB });
  } finally {
    globalThis.CompressionStream = real;
  }
});

test("a consumer that cancels closes the source and the summary rejects as cancelled", async () => {
  const counted = endless();
  const { stream, summary } = writeArchive([counted.source]);
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(counted.cancelled, true, "the source was closed by the time cancel() returned");
  await assert.rejects(summary, (error) => error.name === "AbortError" && error.code === "aborted");
  const delivered = counted.delivered;
  await sleep(100);
  assert.equal(counted.delivered, delivered, "nothing is read after the cancel");
});

test("an abort mid-entry ends the stream with an AbortError and closes the source, whether or not the consumer is waiting", async () => {
  // The consumer is waiting on the next chunk when the abort comes.
  const waiting = endless();
  const first = new AbortController();
  const run = writeArchive([waiting.source], { signal: first.signal });
  const reader = run.stream.getReader();
  await reader.read();
  const pending = reader.read();
  first.abort();
  await assert.rejects(pending, (error) => error instanceof ArchiveError && error.name === "AbortError" && error.code === "aborted");
  await assert.rejects(run.summary, (error) => error.code === "aborted");
  await within(waiting.closed.promise, 2000, "closing the source");
  await assert.rejects(reader.read(), (error) => error.name === "AbortError");

  // The consumer is not pulling at all (a stalled disk): the stream still ends, and the source is still closed.
  const idle = endless();
  const second = new AbortController();
  const stalled = writeArchive([idle.source], { signal: second.signal });
  await sleep(50);
  second.abort();
  await assert.rejects(stalled.stream.getReader().read(), (error) => error.name === "AbortError");
  await within(idle.closed.promise, 2000, "closing the source");
  await assert.rejects(stalled.summary, (error) => error.code === "aborted");
  const delivered = idle.delivered;
  await sleep(100);
  assert.equal(idle.delivered, delivered, "nothing is read after the abort");
});

test("an abort before the write starts opens nothing", async () => {
  let opened = 0;
  const controller = new AbortController();
  controller.abort();
  const { stream, summary } = writeArchive([{ ...source("a.bin", Buffer.from("x")), open: () => { opened += 1; return sliced(Buffer.from("x")); } }], { signal: controller.signal });
  await assert.rejects(drain(stream), (error) => error.name === "AbortError");
  await assert.rejects(summary, (error) => error.code === "aborted");
  assert.equal(opened, 0);
});

test("a source is opened only when its entry's turn comes, one at a time", async () => {
  const log = [];
  const tracked = (name) => ({
    ...source(name, randomBytes(70_000)),
    open() {
      log.push(`open ${name}`);
      const stream = sliced(randomBytes(70_000));
      const reader = stream.getReader();
      return new ReadableStream({
        async pull(controller) { const next = await reader.read(); if (next.done) { log.push(`end ${name}`); controller.close(); } else controller.enqueue(next.value); },
      }, { highWaterMark: 0 });
    },
  });
  await write([tracked("a"), tracked("b"), tracked("c")]);
  assert.deepEqual(log, ["open a", "end a", "open b", "end b", "open c", "end c"]);
});

test("a failed write raises no unhandled rejection, whether or not anyone looks at the summary", async () => {
  const raised = [];
  const listener = (reason) => raised.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const bytes = randomBytes(3000);
    for (const stored of [false, true]) {
      const { stream } = writeArchive([source("a.bin", bytes, { size: 2999, ...(stored ? { stored: true, crc32: nodeCrc32(bytes) } : {}) })]);
      await assert.rejects(drain(stream), ArchiveError);
    }
    const controller = new AbortController();
    const { stream } = writeArchive([endless().source], { signal: controller.signal });
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read(), ArchiveError);
    const dropped = writeArchive([endless().source]);
    await dropped.stream.cancel();
    await sleep(50);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(raised, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------------------------------

test("progress names each entry, only moves forward, and ends with everything read and written", async () => {
  const { items, sources } = sample();
  const reports = [];
  const { bytes, summary } = await write(sources, { onProgress: (progress) => reports.push(progress) });
  assert.ok(reports.length >= items.length * 2, "at the start and end of every entry at least");
  for (let index = 1; index < reports.length; index += 1) {
    assert.ok(reports[index].readBytes >= reports[index - 1].readBytes, "read bytes never go back");
    assert.ok(reports[index].writtenBytes >= reports[index - 1].writtenBytes, "written bytes never go back");
    assert.ok(reports[index].entriesDone >= reports[index - 1].entriesDone, "entries done never go back");
    assert.ok(reports[index].entry >= reports[index - 1].entry);
  }
  for (const progress of reports.slice(0, -1)) assert.equal(progress.name, items[progress.entry].name);
  assert.ok(reports.some((progress) => progress.entry === 2 && progress.readBytes > 0 && progress.readBytes < summary.originalBytes && progress.entriesDone === 2), "the big file reports while it is read");
  assert.deepEqual(reports.at(-1), { entry: items.length - 1, name: items.at(-1).name, entriesDone: items.length, readBytes: summary.originalBytes, writtenBytes: bytes.length });
});

test("a progress callback that throws stops the write with that error", async () => {
  const boom = new Error("the screen is gone");
  const { stream } = writeArchive(sample().sources, { onProgress: () => { throw boom; } });
  await assert.rejects(drain(stream), (error) => error === boom);
});

// ---------------------------------------------------------------------------------------------------------------------
// The manifest and the checksums
// ---------------------------------------------------------------------------------------------------------------------

const SCOPE = { chosen: ["boot_a", "userdata"], all: ["boot_a", "boot_b", "userdata"] };
const provenance = (extra = {}) => ({ operationId: "op-1", deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo Tab", ...extra });
const file = (name, extra = {}) => ({ name, path: name, size: 10, sha256: sha256(name), kind: "output", source: "device", createdAt: MODIFIED, artifactId: `id-${name}`, ...extra });

test("operationInfo carries what the operation said, and nothing it did not", () => {
  assert.deepEqual(archive.operationInfo(provenance()), { id: "op-1", deviceId: "usb-1", deviceLabel: "Lenovo Tab", protocol: "edl", action: "exec", command: "backup" });
  const full = archive.operationInfo(provenance({ target: "boot_a", startedAt: 1_700_000_000_000, set: "Tab backup 6 Oct", scope: SCOPE }));
  assert.deepEqual(full, { id: "op-1", deviceId: "usb-1", deviceLabel: "Lenovo Tab", protocol: "edl", action: "exec", target: "boot_a", command: "backup", startedAt: 1_700_000_000_000, set: "Tab backup 6 Oct", partitions: SCOPE });
  assert.notEqual(full.partitions.chosen, SCOPE.chosen, "a copy: the manifest cannot change the file's own record");
  assert.deepEqual(Object.keys(archive.operationInfo({ operationId: "o", deviceId: "d", protocol: "adb", action: "pull" })), ["id", "deviceId", "protocol", "action"]);
});

test("the manifest lists every file in a stable, readable order, with times as ISO strings", () => {
  const { json, bytes } = archive.buildArchiveManifest({
    label: "Lenovo Tab backup",
    sessionId: "session-1",
    createdAt: Date.parse("2026-10-06T18:31:12Z"),
    files: [
      file("boot_a.bin", { size: 100, operation: archive.operationInfo(provenance({ startedAt: Date.parse("2026-10-06T18:00:00Z"), set: "Tab backup" })) }),
      file("notes.txt", { size: 50, artifactId: undefined }),
    ],
  });
  assert.equal(json.format, "cody-device-artifacts/2");
  assert.deepEqual(Object.keys(json), ["format", "createdAt", "label", "sessionId", "totalBytes", "compression", "files"]);
  assert.equal(json.createdAt, "2026-10-06T18:31:12.000Z");
  assert.equal(json.totalBytes, 150, "the files before packing");
  assert.equal(json.compression, "deflate");
  assert.equal("backups" in json, false, "no backup said which partitions it took");
  const [boot, notes] = json.files;
  assert.deepEqual(Object.keys(boot), ["name", "path", "size", "sha256", "kind", "source", "createdAt", "artifactId", "operation"]);
  assert.equal(boot.createdAt, "2026-10-06T18:31:12.000Z");
  assert.deepEqual(boot.operation, { id: "op-1", deviceId: "usb-1", deviceLabel: "Lenovo Tab", protocol: "edl", action: "exec", command: "backup", startedAt: "2026-10-06T18:00:00.000Z", set: "Tab backup" });
  assert.deepEqual(Object.keys(notes), ["name", "path", "size", "sha256", "kind", "source", "createdAt"], "no artifact id, no operation");
  const text = Buffer.from(bytes).toString("utf8");
  assert.ok(text.endsWith("}\n"), "a trailing newline");
  assert.ok(text.startsWith('{\n  "format": "cody-device-artifacts/2",\n'), "two-space pretty JSON");
  assert.deepEqual(JSON.parse(text), json);
});

test("the manifest records which partitions each backup chose and the full list known then", () => {
  const partial = archive.operationInfo(provenance({ operationId: "op-partial", scope: SCOPE }));
  const full = archive.operationInfo(provenance({ operationId: "op-full", scope: { chosen: ["a", "b"], all: ["a", "b"] } }));
  const silent = archive.operationInfo(provenance({ operationId: "op-printgpt" }));
  const { json } = archive.buildArchiveManifest({
    label: "x",
    sessionId: "s",
    createdAt: MODIFIED,
    files: [file("one", { operation: partial }), file("two", { operation: partial }), file("three", { operation: full }), file("four", { operation: silent }), file("five")],
  });
  assert.deepEqual(json.backups, [
    { operationId: "op-partial", kind: "incomplete", complete: false, files: 2, chosen: SCOPE.chosen, all: SCOPE.all },
    { operationId: "op-full", kind: "incomplete", complete: false, files: 1, chosen: ["a", "b"], all: ["a", "b"] },
  ], "one entry per operation that said, in the order they first appear; a few loose files of a backup are not the backup, whatever it chose");
  assert.equal(json.files[0].operation.partitions, undefined, "the lists are in backups once, not on every file: a backup of N partitions would otherwise carry 2N names N times");
  const whole = archive.operationInfos([provenance({ operationId: "op-whole", scope: { chosen: ["boot_a"], all: ["boot_a", "boot_b"] } })])[0];
  const names = ["edl-1-set-gpt-primary.bin", "edl-1-set-p0-boot_a.bin", "edl-1-set-gpt-backup.bin", "edl-1-set-0123abcd.manifest.json"];
  const finished = archive.buildArchiveManifest({ label: "x", sessionId: "s", createdAt: MODIFIED, files: names.map((name) => file(name, { operation: whole })) }).json;
  assert.deepEqual(finished.backups, [{ operationId: "op-whole", kind: "partial", complete: true, files: 4, chosen: ["boot_a"], all: ["boot_a", "boot_b"] }], "every file of a backup of chosen partitions, manifest included: a partial backup, held whole");
  const trimmed = archive.buildArchiveManifest({ label: "x", sessionId: "s", createdAt: MODIFIED, files: names.slice(0, 3).map((name) => file(name, { operation: whole })) }).json;
  assert.deepEqual(trimmed.backups[0].kind, "incomplete", "without its manifest it is not the whole backup, whatever it chose");
  const [second] = archive.operationInfos([provenance({ operationId: "op-whole", scope: SCOPE }), provenance({ operationId: "op-whole", scope: SCOPE })]).slice(1);
  assert.equal(second.partitions, undefined, "the announcement carries a backup's lists on its first file only");
  assert.deepEqual(Object.keys(json).slice(0, 6), ["format", "createdAt", "label", "sessionId", "totalBytes", "compression"]);
  assert.equal(Object.keys(json)[6], "backups", "backups come before the files");
});

test("extra facts are added after the manifest's own and can never replace one of them", () => {
  const input = { label: "x", sessionId: "s", createdAt: MODIFIED, files: [file("one")] };
  const { json } = archive.buildArchiveManifest({ ...input, extra: { saveId: "abc", owner: { id: "u1", name: "Nitin" }, completedAt: "2026-10-06T19:00:00.000Z", verified: true } });
  assert.deepEqual(Object.keys(json).slice(-4), ["saveId", "owner", "completedAt", "verified"]);
  assert.deepEqual(json.owner, { id: "u1", name: "Nitin" });
  for (const key of ["format", "files", "createdAt", "compression", "totalBytes"]) {
    assert.throws(() => archive.buildArchiveManifest({ ...input, extra: { [key]: "replaced" } }), /already has/, key);
  }
});

test("SHA256SUMS lists every file and then the manifest itself, and sha256sum -c accepts it after extracting", { skip: !HAS_UNZIP || !hasTool("sha256sum", ["--version"]) }, async () => {
  const contents = [randomBytes(3000), Buffer.from("second file\n"), Buffer.alloc(0)];
  const folder = "pixel-backup-20261006-1831";
  const files = contents.map((bytes, index) => file(`part-${index}.bin`, { path: `part-${index}.bin`, size: bytes.length, sha256: sha256(bytes) }));
  const manifest = archive.buildArchiveManifest({ label: "Pixel", sessionId: "s", createdAt: MODIFIED, files });
  const sources = [
    ...contents.map((bytes, index) => blobSource(`${folder}/part-${index}.bin`, new Blob([bytes]), MODIFIED)),
    ...archive.metadataSources({ folder, files, manifest: manifest.bytes, modified: MODIFIED }),
  ];
  assert.deepEqual(sources.slice(-2).map((entry) => entry.name), [`${folder}/SHA256SUMS`, `${folder}/manifest.json`]);
  assert.ok(sources.slice(-2).every((entry) => entry.stored === true), "both are stored, so any tool reads them without inflating");
  const { bytes } = await write(sources);
  const zip = join(scratch, "sums.zip");
  writeFileSync(zip, bytes);
  const out = join(scratch, "sums");
  mkdirSync(out);
  assert.equal(spawnSync("unzip", ["-q", zip, "-d", out]).status, 0);
  const sums = readFileSync(join(out, folder, "SHA256SUMS"), "utf8");
  assert.equal(sums, [...files.map((entry) => `${entry.sha256}  ${entry.path}\n`), `${sha256(manifest.bytes)}  manifest.json\n`].join(""));
  const checked = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: join(out, folder), encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /manifest\.json: OK/);
  writeFileSync(join(out, folder, "part-1.bin"), "tampered\n");
  assert.notEqual(spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: join(out, folder), encoding: "utf8" }).status, 0, "and it notices a changed file");
});
