import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The independent re-check of a finished archive, against archives other tools made (Python's zipfile, in every layout
 * it can produce) and against deliberately damaged copies: each kind of damage must be caught, and the message must
 * name the file.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ArchiveCheckError, readArchiveManifest, verifyArchiveFile } = await jiti.import("./artifact-archive-verify.ts");

const scratch = mkdtempSync(join(tmpdir(), "cody-archive-verify-"));
const python = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let counter = 0;
const fresh = (name) => join(scratch, `${(counter += 1)}-${name}`);

const MAKE_ARCHIVE = `
import sys, json, base64, zipfile

spec = json.load(sys.stdin)

class Unseekable:
    """Only write and flush, so zipfile has to put sizes in data descriptors after each entry."""
    def __init__(self, handle): self.handle = handle
    def write(self, data): return self.handle.write(data)
    def flush(self): self.handle.flush()

report = []
with open(spec["out"], "wb") as handle:
    target = Unseekable(handle) if spec.get("stream") else handle
    with zipfile.ZipFile(target, "w") as archive:
        for item in spec["entries"]:
            info = zipfile.ZipInfo(item["name"], date_time=(2026, 10, 6, 18, 31, 12))
            info.compress_type = zipfile.ZIP_STORED if item.get("stored") else zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with archive.open(info, "w", force_zip64=bool(spec.get("zip64"))) as entry:
                entry.write(base64.b64decode(item["data"]))
            report.append({"name": item["name"], "offset": info.header_offset, "packed": info.compress_size, "size": info.file_size})
print(json.dumps(report))
`;

/** Text that deflates to something worth flipping a byte in. */
const lines = (count, salt) => Buffer.from(Array.from({ length: count }, (_, index) => `line ${(index * 7919 + salt) % 10_007} of the dump\n`).join(""));

/** What a vault archive holds: device files, then SHA256SUMS, then manifest.json, all under one folder. */
function content(extra = {}) {
  const files = [
    { path: "boot_a.bin", data: lines(30_000, 1) },
    { path: "empty.bin", data: Buffer.alloc(0) },
    { path: "userdata.bin", data: Buffer.alloc(70_000) },
    { path: "tiny.bin", data: Buffer.from("x") },
  ];
  const manifest = Buffer.from(`${JSON.stringify({ format: "cody-device-artifacts/2", saveId: "a".repeat(32), files: files.map((file) => file.path), ...extra }, null, 2)}\n`);
  const sums = Buffer.from(`${[...files.map((file) => `${sha256(file.data)}  ${file.path}`), `${sha256(manifest)}  manifest.json`].join("\n")}\n`);
  return { folder: "Backup-2026-10-06", files, manifest, sums };
}

function expectation(made) {
  return {
    folder: made.folder,
    files: made.files.map((file) => ({ path: file.path, size: file.data.length, sha256: sha256(file.data) })),
    manifestSha256: sha256(made.manifest),
  };
}

/** Builds the archive with Python and returns where every entry lies, read from what Python reported and the file itself. */
function pythonArchive(made, options = {}) {
  const out = fresh("archive.zip");
  const entries = [
    ...(options.reverse ? [...made.files].reverse() : made.files).map((file) => ({ name: `${made.folder}/${file.path}`, data: file.data.toString("base64") })),
    ...(options.withoutSums ? [] : [{ name: `${made.folder}/SHA256SUMS`, data: (options.sums ?? made.sums).toString("base64"), stored: true }]),
    ...(options.withoutManifest ? [] : [{ name: `${made.folder}/manifest.json`, data: made.manifest.toString("base64"), stored: true }]),
    ...(options.extraEntries ?? []),
  ];
  const run = spawnSync("python3", ["-c", MAKE_ARCHIVE], { input: JSON.stringify({ out, entries, stream: options.stream === true, zip64: options.zip64 === true }), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const bytes = readFileSync(out);
  const report = JSON.parse(run.stdout);
  const where = new Map(report.map((entry) => {
    const nameLength = bytes.readUInt16LE(entry.offset + 26);
    const extraLength = bytes.readUInt16LE(entry.offset + 28);
    return [entry.name.slice(made.folder.length + 1), { ...entry, dataStart: entry.offset + 30 + nameLength + extraLength }];
  }));
  return { file: out, bytes, where };
}

function damagedCopy(archive, change) {
  const copy = Buffer.from(archive.bytes);
  const result = change(copy) ?? copy;
  const file = fresh("damaged.zip");
  writeFileSync(file, result);
  return file;
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ArchiveCheckError, `an ArchiveCheckError, got ${error}`);
    assert.equal(error.code, "damaged");
    return error.message;
  }
  return assert.fail("expected the archive to be refused");
}

const skipPython = { skip: !python && "python3 is not installed" };

for (const [label, options] of [
  ["classic records, written with the sizes known", {}],
  ["data descriptors after every entry", { stream: true }],
  ["ZIP64 entry headers and 8-byte data descriptors", { stream: true, zip64: true }],
  ["ZIP64 entry headers with the sizes known", { zip64: true }],
]) {
  test(`an archive Python wrote with ${label} passes, and the numbers it reports are the real ones`, skipPython, async () => {
    const made = content();
    const archive = pythonArchive(made, options);
    const result = await verifyArchiveFile(archive.file, expectation(made));
    assert.equal(result.archiveBytes, archive.bytes.length);
    assert.equal(result.files, 4);
    assert.equal(result.originalBytes, made.files.reduce((total, file) => total + file.data.length, 0));
    assert.equal(result.manifestSha256, sha256(made.manifest));
    const read = await readArchiveManifest(archive.file);
    assert.equal(read.folder, made.folder);
    assert.equal(read.manifest.saveId, "a".repeat(32));
  });
}

test("files may sit in any order in the archive: the check is on what is inside, not on the order", skipPython, async () => {
  const made = content();
  const archive = pythonArchive(made, { reverse: true });
  const result = await verifyArchiveFile(archive.file, expectation(made));
  assert.equal(result.files, 4);
});

test("a ZIP64 end record (more than 65,535 entries, which is when Python writes one) is read to find the manifest", skipPython, async () => {
  const manifest = Buffer.from(JSON.stringify({ format: "cody-device-artifacts/2", saveId: "b".repeat(32), files: [] }));
  const many = Array.from({ length: 65_536 }, (_, index) => ({ name: `Many-2026-10-06/f${index}`, data: "", stored: true }));
  const out = fresh("many.zip");
  const run = spawnSync("python3", ["-c", MAKE_ARCHIVE], { input: JSON.stringify({ out, entries: [...many, { name: "Many-2026-10-06/manifest.json", data: manifest.toString("base64"), stored: true }] }), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const read = await readArchiveManifest(out);
  assert.equal(read.folder, "Many-2026-10-06");
  assert.equal(read.manifest.saveId, "b".repeat(32));
  const bytes = readFileSync(out);
  assert.equal(bytes.readUInt16LE(bytes.length - 22 + 10), 0xffff, "the classic end record is saturated, so the ZIP64 one was needed");
});

test("each kind of damage is caught, and the message names the file", skipPython, async (t) => {
  const made = content();
  const expected = expectation(made);
  const plain = pythonArchive(made);
  const streamed = pythonArchive(made, { stream: true });
  const at = (archive, name) => archive.where.get(name);

  const cases = [
    ["a flipped byte inside a deflated file", plain, (copy) => { copy[at(plain, "boot_a.bin").dataStart + Math.floor(at(plain, "boot_a.bin").packed / 2)] ^= 0x55; }, /"boot_a\.bin"/],
    ["a flipped byte inside a file stored without packing", plain, (copy) => { copy[at(plain, "SHA256SUMS").dataStart + 5] ^= 0x01; }, /"SHA256SUMS"/],
    ["a flipped byte in the very first packed byte", plain, (copy) => { copy[at(plain, "userdata.bin").dataStart] ^= 0xff; }, /"userdata\.bin"/],
    ["a file cut short in the middle", plain, (copy) => copy.subarray(0, at(plain, "boot_a.bin").dataStart + 100), /ends early|no end record|directory/],
    ["the last bytes cut off, taking the end record", plain, (copy) => copy.subarray(0, copy.length - 10), /no end record|ends early|cut short/],
    ["bytes added after the end record", plain, (copy) => Buffer.concat([copy, Buffer.from("tail")]), /end record|stray|directory/],
    ["a local header that gives the file another name", plain, (copy) => { copy[at(plain, "tiny.bin").offset + 30 + made.folder.length + 1] ^= 0x01; }, /"tiny\.bin"|different name/],
    ["a data descriptor with another CRC-32", streamed, (copy) => { copy[at(streamed, "tiny.bin").dataStart + at(streamed, "tiny.bin").packed + 4] ^= 0x01; }, /"tiny\.bin".*data descriptor/],
    ["a data descriptor with another size", streamed, (copy) => { copy[at(streamed, "boot_a.bin").dataStart + at(streamed, "boot_a.bin").packed + 12] ^= 0x01; }, /"boot_a\.bin".*data descriptor/],
    ["a data descriptor that is not there", streamed, (copy) => { copy[at(streamed, "tiny.bin").dataStart + at(streamed, "tiny.bin").packed] ^= 0xff; }, /"tiny\.bin".*data descriptor/],
    ["a file that is stored under another CRC-32 in the directory", plain, (copy) => {
      const directory = copy.readUInt32LE(copy.length - 22 + 16);
      copy[directory + 16] ^= 0x01;
    }, /"boot_a\.bin"/],
  ];
  for (const [label, archive, change, pattern] of cases) {
    await t.test(label, async () => {
      const file = damagedCopy(archive, change);
      const message = await refusal(verifyArchiveFile(file, expected));
      assert.match(message, pattern, message);
    });
  }

  await t.test("a file whose SHA-256 is not the one that was announced", async () => {
    const wrong = { ...expected, files: expected.files.map((file) => (file.path === "tiny.bin" ? { ...file, sha256: sha256("another") } : file)) };
    assert.match(await refusal(verifyArchiveFile(plain.file, wrong)), /"tiny\.bin".*SHA-256/);
  });

  await t.test("a file whose size is not the one that was announced", async () => {
    const wrong = { ...expected, files: expected.files.map((file) => (file.path === "userdata.bin" ? { ...file, size: file.size + 1 } : file)) };
    assert.match(await refusal(verifyArchiveFile(plain.file, wrong)), /"userdata\.bin"/);
  });

  await t.test("an entry that should be there and is not", async () => {
    const wrong = { ...expected, files: [...expected.files, { path: "gone.bin", size: 1, sha256: sha256("g") }] };
    assert.match(await refusal(verifyArchiveFile(plain.file, wrong)), /missing "gone\.bin"/);
  });

  await t.test("an entry that should not be there", async () => {
    const extra = pythonArchive(made, { extraEntries: [{ name: `${made.folder}/stowaway.bin`, data: Buffer.from("hi").toString("base64") }] });
    assert.match(await refusal(verifyArchiveFile(extra.file, expected)), /"stowaway\.bin".*not one of this save's files/);
    const outside = pythonArchive(made, { extraEntries: [{ name: "elsewhere/other.bin", data: Buffer.from("hi").toString("base64") }] });
    assert.match(await refusal(verifyArchiveFile(outside.file, expected)), /"elsewhere\/other\.bin"/);
  });

  await t.test("the same name twice", async () => {
    const twice = pythonArchive(made, { extraEntries: [{ name: `${made.folder}/tiny.bin`, data: Buffer.from("other").toString("base64") }] });
    assert.match(await refusal(verifyArchiveFile(twice.file, expected)), /"tiny\.bin" twice/);
  });

  await t.test("a missing SHA256SUMS or manifest.json", async () => {
    assert.match(await refusal(verifyArchiveFile(pythonArchive(made, { withoutSums: true }).file, expected)), /missing "SHA256SUMS"/);
    assert.match(await refusal(verifyArchiveFile(pythonArchive(made, { withoutManifest: true }).file, expected)), /missing "manifest\.json"/);
  });

  await t.test("a SHA256SUMS that lists a different checksum, or too few lines", async () => {
    const lines = made.sums.toString("utf8").split("\n").filter(Boolean);
    const wrongLine = Buffer.from(`${[lines[0], `${sha256("other")}  empty.bin`, ...lines.slice(2)].join("\n")}\n`);
    assert.match(await refusal(verifyArchiveFile(pythonArchive(made, { sums: wrongLine }).file, expected)), /SHA256SUMS.*"empty\.bin"/);
    const short = Buffer.from(`${lines.slice(0, 2).join("\n")}\n`);
    assert.match(await refusal(verifyArchiveFile(pythonArchive(made, { sums: short }).file, expected)), /SHA256SUMS/);
    const crlf = Buffer.from(made.sums.toString("utf8").replaceAll("\n", "\r\n"));
    assert.match(await refusal(verifyArchiveFile(pythonArchive(made, { sums: crlf }).file, expected)), /SHA256SUMS/);
  });

  await t.test("a manifest.json that is not the one the server wrote", async () => {
    assert.match(await refusal(verifyArchiveFile(plain.file, { ...expected, manifestSha256: sha256("not it") })), /manifest\.json.*not the one the server wrote/);
  });
});

test("a check stopped by the caller is reported as stopped, not as damage", skipPython, async () => {
  const made = content();
  const archive = pythonArchive(made);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(verifyArchiveFile(archive.file, expectation(made), { signal: controller.signal }), (error) => error instanceof ArchiveCheckError && error.code === "aborted");
});

test("a file that is not a readable archive of ours is simply not one: no manifest, no throw", skipPython, async () => {
  const made = content();
  const notZip = fresh("notes.zip");
  writeFileSync(notZip, "this is not a zip file at all, just somebody's notes");
  const empty = fresh("empty.zip");
  writeFileSync(empty, "");
  const plain = pythonArchive(made, { withoutManifest: true });
  const deflatedManifest = fresh("deflated.zip");
  const run = spawnSync("python3", ["-c", MAKE_ARCHIVE], { input: JSON.stringify({ out: deflatedManifest, entries: [{ name: "x/manifest.json", data: Buffer.from("{\"a\":1}").toString("base64") }] }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const brokenManifest = fresh("broken.zip");
  const good = pythonArchive(made);
  writeFileSync(brokenManifest, (() => {
    const copy = Buffer.from(good.bytes);
    copy[good.where.get("manifest.json").dataStart + 3] ^= 0x20;
    return copy;
  })());
  for (const file of [notZip, empty, plain.file, deflatedManifest, brokenManifest, join(scratch, "does-not-exist.zip")]) {
    assert.equal(await readArchiveManifest(file), undefined, file);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Archives the vault's own writer makes
// ---------------------------------------------------------------------------------------------------------------------

const { buildArchiveManifest, metadataSources, writeArchive } = await jiti.import("./artifact-archive.ts");
const MODIFIED = Date.parse("2026-10-06T18:31:12Z");

/** The archive the vault writes for `made`: the files, then SHA256SUMS and manifest.json, as the shared writer lays them out. */
async function writerArchive(made, options = {}) {
  const prefix = `${made.folder}/`;
  const manifest = buildArchiveManifest({
    label: "Backup",
    sessionId: "chat-1",
    createdAt: MODIFIED,
    files: made.files.map((file) => ({ name: file.path, path: file.path, size: file.data.length, sha256: sha256(file.data), kind: "output", source: "device", createdAt: MODIFIED })),
    extra: { saveId: "c".repeat(32), owner: { id: null }, completedAt: new Date(MODIFIED).toISOString(), verified: true },
  });
  const sources = [
    ...made.files.map((file) => ({ name: `${prefix}${file.path}`, size: file.data.length, modified: MODIFIED, open: () => new Blob([file.data]).stream() })),
    ...metadataSources({ folder: made.folder, files: made.files.map((file) => ({ path: file.path, sha256: sha256(file.data) })), manifest: manifest.bytes, modified: MODIFIED }),
    ...(options.extraSources ?? []),
  ];
  const { stream, summary } = writeArchive(sources, options.write);
  const bytes = Buffer.from(await new Response(stream).arrayBuffer());
  const report = await summary;
  const file = fresh("written.zip");
  writeFileSync(file, bytes);
  const where = new Map(report.entries.map((entry) => [entry.name.slice(prefix.length), entry]));
  return { file, bytes, report, where, expected: { ...expectation(made), manifestSha256: sha256(manifest.bytes) } };
}

for (const [label, write, endRecords] of [
  ["the default layout", undefined, false],
  ["every ZIP64 record (forceZip64)", { forceZip64: true }, true],
  ["64-bit entries under classic end records", { wideEntryBytes: 1 }, false],
]) {
  test(`an archive the vault's own writer made in ${label} passes the independent re-check and is read back by every other reader`, async () => {
    const made = content();
    const archive = await writerArchive(made, { write });
    const result = await verifyArchiveFile(archive.file, archive.expected);
    assert.equal(result.files, 4);
    assert.equal(result.originalBytes, made.files.reduce((total, file) => total + file.data.length, 0));
    assert.equal(result.archiveBytes, archive.bytes.length);
    assert.equal(result.manifestSha256, archive.expected.manifestSha256);
    assert.equal(archive.bytes.readUInt32LE(archive.bytes.length - 22 - 20) === 0x07064b50, endRecords, "the ZIP64 end records are there exactly when they were asked for");
    assert.equal(archive.report.entries.filter((entry) => entry.size > 0).every((entry) => entry.zip64), write !== undefined, "and every file with bytes is 64-bit exactly when it was asked to be");
    assert.equal((await readArchiveManifest(archive.file)).manifest.saveId, "c".repeat(32));
    if (python) {
      const checked = spawnSync("python3", ["-m", "zipfile", "-t", archive.file], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
  });
}

test("damage to an archive the vault's own writer made is caught, and the message names the file", async (t) => {
  const made = content();
  const archive = await writerArchive(made);
  const entry = (name) => archive.where.get(name);
  const dataStart = (name) => entry(name).headerOffset + 30 + archive.bytes.readUInt16LE(entry(name).headerOffset + 26) + archive.bytes.readUInt16LE(entry(name).headerOffset + 28);

  const cases = [
    ["a flipped byte inside a packed file", (copy) => { copy[dataStart("boot_a.bin") + Math.floor(entry("boot_a.bin").compressedSize / 2)] ^= 0x42; }, /"boot_a\.bin"/],
    ["a flipped byte in the stored manifest", (copy) => { copy[dataStart("manifest.json") + 20] ^= 0x01; }, /"manifest\.json"/],
    ["a data descriptor with another CRC-32", (copy) => { copy[dataStart("userdata.bin") + entry("userdata.bin").compressedSize + 4] ^= 0x01; }, /"userdata\.bin".*data descriptor/],
    ["a data descriptor with another packed size", (copy) => { copy[dataStart("tiny.bin") + entry("tiny.bin").compressedSize + 8] ^= 0x01; }, /"tiny\.bin".*data descriptor/],
    ["a local header whose name differs from the directory's", (copy) => { copy[entry("tiny.bin").headerOffset + 30 + 2] ^= 0x01; }, /"tiny\.bin"/],
    ["the archive cut short", (copy) => copy.subarray(0, copy.length - 40), /end record|cut short/],
  ];
  for (const [label, change, pattern] of cases) {
    await t.test(label, async () => {
      const copy = Buffer.from(archive.bytes);
      const file = fresh("damaged.zip");
      writeFileSync(file, change(copy) ?? copy);
      assert.match(await refusal(verifyArchiveFile(file, archive.expected)), pattern);
    });
  }

  await t.test("an entry that was not announced, and one that is missing", async () => {
    const extra = await writerArchive(made, { extraSources: [{ name: `${made.folder}/stowaway.bin`, size: 3, modified: MODIFIED, open: () => new Blob(["abc"]).stream() }] });
    assert.match(await refusal(verifyArchiveFile(extra.file, extra.expected)), /"stowaway\.bin"/);
    const missing = { ...archive.expected, files: [...archive.expected.files, { path: "gone.bin", size: 1, sha256: sha256("g") }] };
    assert.match(await refusal(verifyArchiveFile(archive.file, missing)), /missing "gone\.bin"/);
  });

  await t.test("a file whose SHA-256 is not the one announced", async () => {
    const wrong = { ...archive.expected, files: archive.expected.files.map((file) => (file.path === "boot_a.bin" ? { ...file, sha256: sha256("other") } : file)) };
    assert.match(await refusal(verifyArchiveFile(archive.file, wrong)), /"boot_a\.bin".*SHA-256/);
  });
});
