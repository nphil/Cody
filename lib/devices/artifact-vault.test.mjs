import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";
import { archiveTools, assertArchiveOpens, installFlakyDisk, readArchive } from "./artifact-vault.test-helper.mjs";

/**
 * The receiving end of "Save to server", driven directly: announce, slices, verify, complete, and everything that can
 * go wrong on the way, including the building of the one archive a save becomes. The HTTP layer over it has its own file.
 */
const scratch = mkdtempSync(join(tmpdir(), "cody-vault-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const disk = installFlakyDisk();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const vault = await jiti.import("./artifact-vault.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = process.platform !== "win32";
const NOW = Date.parse("2026-10-06T18:31:12Z");
const ME = { owner: "user-1", ownerName: "nphil" };
const MiB = 1024 * 1024;
let counter = 0;

function configWith(limits = {}) {
  counter += 1;
  return { root: join(scratch, `vault-${counter}`), limits: { ...vault.DEFAULT_VAULT_LIMITS, maxChunkBytes: 4096, minFreeBytes: 0, ...limits } };
}

function fileInput(name, bytes, extra = {}) {
  return { name, size: bytes.length, sha256: sha256(bytes), kind: "output", source: "device", createdAt: NOW - 5000, ...extra };
}

function request(files, extra = {}) {
  return { sessionId: "chat-1", label: "Lenovo EDL backup", timeZone: "UTC", files: files.map(([name, bytes, more]) => fileInput(name, bytes, more)), ...extra };
}

/** Sends every file of a save the way the page does: slices at the stored offset, then a verify. */
async function upload(config, status, contents, slice = 1500) {
  for (const [index, bytes] of contents.entries()) {
    for (let offset = status.files[index].received; offset < bytes.length; offset += slice) {
      await vault.appendChunk(config, status.saveId, index, offset, bytes.subarray(offset, Math.min(offset + slice, bytes.length)));
    }
    await vault.verifyFile(config, status.saveId, index);
  }
}

/** Announces, uploads and completes: the finished save. */
async function save(config, sources, extra = {}, at = NOW) {
  const begun = await vault.beginSave(config, ME, request(sources, extra), at);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  return { begun, done: await vault.completeSave(config, begun.saveId, at + 1000) };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof vault.VaultError, `a VaultError, got ${error}`);
    return error;
  }
  return assert.fail("expected the call to be refused");
}

async function untilComplete(config, saveId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await vault.saveStatus(config, saveId);
    if (status?.state === "complete") return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return assert.fail("the archive was never finished");
}

const visible = (config) => readdirSync(config.root).filter((name) => !name.startsWith("."));
const incomingOf = (config, saveId) => join(config.root, ".incoming", saveId);
const files = () => [["boot_a.bin", randomBytes(10_000)], ["empty.bin", Buffer.alloc(0)], ["exact.bin", randomBytes(4096)], ["one.bin", randomBytes(1)]];
/** A save big enough that the archive takes several writes and the writer reports progress while it goes. */
const large = () => [["system.bin", randomBytes(3 * MiB)], ["vendor.bin", randomBytes(1 * MiB)]];
const bigConfig = (limits = {}) => configWith({ maxChunkBytes: 1 * MiB, ...limits });
const bigUpload = (config, begun, sources) => upload(config, begun, sources.map(([, bytes]) => bytes), 512 * 1024);

// ---------------------------------------------------------------------------------------------------------------------
// One save, one archive
// ---------------------------------------------------------------------------------------------------------------------

test("a save is uploaded under .incoming and becomes ONE archive in the root: nothing else is left, the files inside are byte for byte what was sent, and the numbers are the real ones", async () => {
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources, { key: "ef".repeat(16) }), NOW);
  const archive = join(config.root, "Lenovo-EDL-backup-2026-10-06.zip");
  assert.equal(begun.state, "uploading");
  assert.equal(begun.archive, archive);
  assert.deepEqual(begun.files.map((file) => file.entry), ["boot_a.bin", "empty.bin", "exact.bin", "one.bin"].map((name) => `Lenovo-EDL-backup-2026-10-06/${name}`));
  assert.equal(existsSync(archive), false, "nothing is visible under the final name until the save is whole");
  assert.deepEqual(begun.files.map((file) => file.received), [0, 0, 0, 0]);

  await upload(config, begun, sources.map(([, bytes]) => bytes));
  assert.equal(existsSync(archive), false);
  assert.equal((await vault.saveStatus(config, begun.saveId)).state, "uploading", "every file is verified and the archive is still not there");
  const done = await vault.completeSave(config, begun.saveId, NOW + 60_000);

  assert.equal(done.state, "complete");
  assert.equal(done.verified, true);
  assert.equal(done.archive, archive);
  assert.equal(done.archiveBytes, statSync(archive).size);
  assert.equal(done.totalBytes, 10_000 + 4096 + 1);
  assert.equal(done.completedAt, NOW + 60_000);
  assert.equal(done.buildError, undefined);
  assert.equal(done.packedBytes, undefined);
  assert.deepEqual(readdirSync(config.root).sort(), [".incoming", "Lenovo-EDL-backup-2026-10-06.zip"], "the vault holds one file for the save");
  assert.deepEqual(readdirSync(join(config.root, ".incoming")), [], "and nothing is left in the incoming area");
  assertArchiveOpens(assert, archive);

  const inside = await readArchive(archive);
  const folder = "Lenovo-EDL-backup-2026-10-06";
  assert.deepEqual([...inside.keys()], [...sources.map(([name]) => `${folder}/${name}`), `${folder}/SHA256SUMS`, `${folder}/manifest.json`], "the files in the order they were given, then the checksums and the manifest");
  for (const [name, bytes] of sources) assert.ok(inside.get(`${folder}/${name}`).bytes.equals(bytes), `${name} is inside, byte for byte`);
  assert.equal(inside.get(`${folder}/manifest.json`).entry.method, 0, "the manifest is stored, so any tool reads it without inflating");
  assert.equal(inside.get(`${folder}/SHA256SUMS`).entry.method, 0);
  assert.equal(inside.get(`${folder}/boot_a.bin`).entry.method, 8, "a file is deflated");
  assert.equal(inside.get(`${folder}/empty.bin`).entry.method, 0, "an empty one is stored");

  const manifest = JSON.parse(inside.get(`${folder}/manifest.json`).bytes.toString("utf8"));
  assert.equal(manifest.format, "cody-device-artifacts/2");
  assert.equal(manifest.saveId, begun.saveId);
  assert.equal(manifest.key, "ef".repeat(16));
  assert.equal(manifest.sessionId, "chat-1");
  assert.deepEqual(manifest.owner, { id: "user-1", name: "nphil" });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.completedAt, new Date(NOW + 60_000).toISOString());
  assert.equal(manifest.totalBytes, done.totalBytes);
  assert.deepEqual(manifest.files[0], { name: "boot_a.bin", path: "boot_a.bin", size: 10_000, sha256: sha256(sources[0][1]), kind: "output", source: "device", createdAt: new Date(NOW - 5000).toISOString() });
  const sums = inside.get(`${folder}/SHA256SUMS`).bytes.toString("utf8");
  assert.equal(sums, `${[...sources.map(([name, bytes]) => `${sha256(bytes)}  ${name}`), `${sha256(inside.get(`${folder}/manifest.json`).bytes)}  manifest.json`].join("\n")}\n`);
});

test("the files unpack to what was sent with the tools people really use, and sha256sum -c SHA256SUMS passes on what comes out", { skip: !archiveTools.unzip && "unzip is not installed" }, async () => {
  const config = configWith();
  const sources = files();
  const { done } = await save(config, sources);
  const out = mkdtempSync(join(tmpdir(), "cody-unzipped-"));
  const unzipped = spawnSync("unzip", ["-q", done.archive, "-d", out], { encoding: "utf8" });
  assert.equal(unzipped.status, 0, unzipped.stderr);
  const folder = join(out, "Lenovo-EDL-backup-2026-10-06");
  assert.deepEqual(readdirSync(folder).sort(), ["SHA256SUMS", "boot_a.bin", "empty.bin", "exact.bin", "manifest.json", "one.bin"]);
  for (const [name, bytes] of sources) assert.ok(readFileSync(join(folder, name)).equals(bytes), name);
  if (archiveTools.sha256sum) {
    const checked = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: folder, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  }
  if (archiveTools.python) {
    const read = spawnSync("python3", ["-c", "import sys, zipfile, hashlib, json; z = zipfile.ZipFile(sys.argv[1]); print(json.dumps({n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}))", done.archive], { encoding: "utf8" });
    const hashes = JSON.parse(read.stdout);
    for (const [name, bytes] of sources) assert.equal(hashes[`Lenovo-EDL-backup-2026-10-06/${name}`], sha256(bytes), name);
  }
});

test("data that packs well takes far less room than the files, and data that does not costs only a little more than its own size", async () => {
  const config = configWith({ maxChunkBytes: 1 * MiB });
  const zeros = ["zeros.bin", Buffer.alloc(600_000)];
  const noise = ["noise.bin", randomBytes(100_000)];
  const { done } = await save(config, [zeros]);
  assert.equal(done.totalBytes, 600_000);
  assert.ok(done.archiveBytes < 6000, `600,000 zeros packed to ${done.archiveBytes} bytes`);
  const { done: second } = await save(config, [noise], { label: "noise" });
  assert.equal(second.totalBytes, 100_000);
  assert.ok(second.archiveBytes > 100_000 && second.archiveBytes < 100_000 + 3000, `100,000 random bytes became ${second.archiveBytes}`);
});

test("the extra facts the page announces about each file (start time, set name, which partitions were chosen) reach the manifest", async () => {
  const config = configWith();
  const operation = { id: "op-1", deviceId: "usb-1", deviceLabel: "Lenovo QUSB", protocol: "edl", action: "exec", command: "backup", target: "boot_a", startedAt: NOW - 90_000, set: "Cronos tablet 2026-10-07", partitions: { chosen: ["boot_a", "persist"], all: ["boot_a", "boot_b", "persist"] } };
  const { done } = await save(config, [["boot_a.bin", randomBytes(500), { operation }], ["persist.bin", randomBytes(300), { operation }]]);
  const inside = await readArchive(done.archive);
  const manifest = JSON.parse(inside.get("Lenovo-EDL-backup-2026-10-06/manifest.json").bytes.toString("utf8"));
  const { partitions, ...rest } = operation;
  assert.deepEqual(manifest.files[0].operation, { ...rest, startedAt: new Date(NOW - 90_000).toISOString() }, "the partition lists are in backups, once, not on every file");
  assert.deepEqual(manifest.backups, [{ operationId: "op-1", kind: "incomplete", complete: false, files: 2, chosen: partitions.chosen, all: partitions.all }], "two files of a backup are not the whole of it");
});

test("ZIP64 end to end: an archive written with every ZIP64 record passes the independent re-check and every real tool", async () => {
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  const done = await vault.completeSave(config, begun.saveId, NOW, { forceZip64: true });
  assert.equal(done.state, "complete");
  assert.equal(done.verified, true);
  const bytes = readFileSync(done.archive);
  assert.equal(bytes.readUInt32LE(bytes.length - 22 - 20), 0x07064b50, "the ZIP64 end locator is there");
  assertArchiveOpens(assert, done.archive);
  const inside = await readArchive(done.archive);
  for (const [name, original] of sources) assert.ok(inside.get(`Lenovo-EDL-backup-2026-10-06/${name}`).bytes.equals(original), name);
});

test("everything it makes is owner-only: directories 0700, the archive being written and the finished one 0600", { skip: !posix }, async () => {
  disk.reset();
  const config = bigConfig({ completeWaitMs: 20 });
  const sources = large();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  assert.equal(statSync(config.root).mode & 0o777, 0o700);
  assert.equal(statSync(join(config.root, ".incoming")).mode & 0o777, 0o700);
  assert.equal(statSync(incomingOf(config, begun.saveId)).mode & 0o777, 0o700);
  assert.equal(statSync(join(incomingOf(config, begun.saveId), ".state.json")).mode & 0o777, 0o600);
  await vault.appendChunk(config, begun.saveId, 0, 0, sources[0][1].subarray(0, 100));
  assert.equal(statSync(join(incomingOf(config, begun.saveId), ".0.part")).mode & 0o777, 0o600);
  await bigUpload(config, { ...begun, files: begun.files.map((file, index) => (index === 0 ? { ...file, received: 100 } : file)) }, sources);

  const hold = disk.holdArchive(0);
  const building = await vault.completeSave(config, begun.saveId, NOW);
  assert.equal(building.state, "building");
  await hold.reached;
  assert.equal(statSync(join(incomingOf(config, begun.saveId), ".archive.part")).mode & 0o777, 0o600, "the archive is owner-only while it is written");
  hold.release();
  const done = await untilComplete(config, begun.saveId);
  assert.equal(statSync(done.archive).mode & 0o777, 0o600);
  assert.equal(statSync(config.root).mode & 0o777, 0o700);
});

test("a root the owner prepared keeps its permissions; only a root this code makes is narrowed", { skip: !posix }, async () => {
  const config = configWith();
  mkdirSync(config.root, { mode: 0o750 });
  await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  assert.equal(statSync(config.root).mode & 0o777, 0o750);
});

// ---------------------------------------------------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------------------------------------------------

test("a dropped connection is carried on from what is stored, and the same save is found by its key", async () => {
  const config = configWith();
  const sources = files();
  const key = "ab".repeat(16);
  const first = await vault.beginSave(config, ME, request(sources, { key }), NOW);
  await vault.appendChunk(config, first.saveId, 0, 0, sources[0][1].subarray(0, 3000));
  await vault.appendChunk(config, first.saveId, 0, 3000, sources[0][1].subarray(3000, 4000));

  const again = await vault.beginSave(config, ME, request(sources, { key }), NOW + 1000);
  assert.equal(again.saveId, first.saveId);
  assert.equal(again.resumed, true);
  assert.equal(again.files[0].received, 4000);
  assert.equal(again.files[1].received, 0);
  await upload(config, again, sources.map(([, bytes]) => bytes));
  const done = await vault.completeSave(config, again.saveId, NOW + 2000);
  const inside = await readArchive(done.archive);
  assert.ok(inside.get("Lenovo-EDL-backup-2026-10-06/boot_a.bin").bytes.equals(sources[0][1]));

  const stranger = await vault.beginSave(config, { owner: "user-2" }, request(sources, { key }), NOW + 3000);
  assert.notEqual(stranger.saveId, first.saveId, "another account never picks up this one's save");
  assert.equal(stranger.state, "uploading");
});

test("asking for a save that is already complete gets that save back, with nothing to upload", async () => {
  const config = configWith();
  const sources = [["a.bin", randomBytes(2000)]];
  const key = "cd".repeat(16);
  const begun = await vault.beginSave(config, ME, request(sources, { key }), NOW);
  await upload(config, begun, [sources[0][1]]);
  const done = await vault.completeSave(config, begun.saveId, NOW);
  const again = await vault.beginSave(config, ME, request(sources, { key }), NOW + 1000);
  assert.equal(again.state, "complete");
  assert.equal(again.existing, true);
  assert.equal(again.archive, done.archive);
  assert.equal(again.archiveBytes, done.archiveBytes);
  assert.deepEqual(visible(config), ["Lenovo-EDL-backup-2026-10-06.zip"], "no second archive");
});

test("a slice is accepted only at the stored offset, and a repeat, a gap and an overrun are each refused with the stored length", async () => {
  const config = configWith();
  const bytes = randomBytes(5000);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  assert.deepEqual(await vault.appendChunk(config, begun.saveId, 0, 0, bytes.subarray(0, 1000)), { received: 1000 });
  const repeat = await rejection(vault.appendChunk(config, begun.saveId, 0, 0, bytes.subarray(0, 1000)));
  assert.equal(repeat.code, "offset_mismatch");
  assert.equal(repeat.details.received, 1000);
  assert.equal((await rejection(vault.appendChunk(config, begun.saveId, 0, 2000, bytes.subarray(2000, 3000)))).code, "offset_mismatch");
  const overrun = await rejection(vault.appendChunk(config, begun.saveId, 0, 1000, randomBytes(4096)));
  assert.equal(overrun.code, "too_long");
  assert.equal((await rejection(vault.appendChunk(config, begun.saveId, 0, 1000, randomBytes(5000)))).code, "chunk_too_large");
  assert.equal((await rejection(vault.appendChunk(config, begun.saveId, 9, 0, bytes.subarray(0, 10)))).code, "unknown_file");
  assert.equal(statSync(join(incomingOf(config, begun.saveId), ".0.part")).size, 1000, "none of the refused slices was written");
});

test("two slices for the same place arriving together: one is stored, the other is told the new length", async () => {
  const config = configWith();
  const bytes = randomBytes(3000);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  const results = await Promise.allSettled([
    vault.appendChunk(config, begun.saveId, 0, 0, bytes.subarray(0, 1500)),
    vault.appendChunk(config, begun.saveId, 0, 0, bytes.subarray(0, 1500)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(statSync(join(incomingOf(config, begun.saveId), ".0.part")).size, 1500);
});

test("a file that arrived damaged is caught by reading it back from disk, its partial copy is deleted, and it can be sent again", async () => {
  const config = configWith();
  const good = randomBytes(3000);
  const damaged = Buffer.from(good);
  damaged[1234] ^= 0xff;
  const begun = await vault.beginSave(config, ME, request([["a.bin", good]]), NOW);
  await vault.appendChunk(config, begun.saveId, 0, 0, damaged.subarray(0, 2000));
  await vault.appendChunk(config, begun.saveId, 0, 2000, damaged.subarray(2000));
  const error = await rejection(vault.verifyFile(config, begun.saveId, 0));
  assert.equal(error.status, 422);
  assert.equal(error.code, "hash_mismatch");
  assert.match(error.message, /a\.bin.*damaged/);
  assert.equal(error.details.expected, sha256(good));
  assert.equal(error.details.actual, sha256(damaged));
  assert.equal((await vault.saveStatus(config, begun.saveId)).files[0].received, 0);

  await vault.appendChunk(config, begun.saveId, 0, 0, good.subarray(0, 2000));
  await vault.appendChunk(config, begun.saveId, 0, 2000, good.subarray(2000));
  assert.deepEqual(await vault.verifyFile(config, begun.saveId, 0), { sha256: sha256(good) });
  assert.equal((await vault.completeSave(config, begun.saveId, NOW)).verified, true);
});

test("a save is not finished while a file is missing, short or unverified, and the message names the first one", async () => {
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await vault.appendChunk(config, begun.saveId, 0, 0, sources[0][1].subarray(0, 1000));
  const early = await rejection(vault.completeSave(config, begun.saveId, NOW));
  assert.equal(early.status, 409);
  assert.equal(early.code, "incomplete");
  assert.match(early.message, /4 of 4 files are not stored and verified yet, starting with "boot_a\.bin" \(1000 of 10000 bytes\)/);

  await vault.appendChunk(config, begun.saveId, 0, 1000, sources[0][1].subarray(1000, 4000));
  await vault.appendChunk(config, begun.saveId, 0, 4000, sources[0][1].subarray(4000, 8000));
  await vault.appendChunk(config, begun.saveId, 0, 8000, sources[0][1].subarray(8000));
  const unverified = await rejection(vault.completeSave(config, begun.saveId, NOW));
  assert.match(unverified.message, /boot_a\.bin/);
  const short = await rejection(vault.verifyFile(config, begun.saveId, 2));
  assert.equal(short.code, "incomplete");
  assert.deepEqual(visible(config), [], "no archive was started, and no archive is being built");
  assert.equal(existsSync(join(incomingOf(config, begun.saveId), ".archive.part")), false);
});

test("finishing twice returns the same finished save, so a lost answer can simply be asked for again", async () => {
  const config = configWith();
  const bytes = randomBytes(100);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  await upload(config, begun, [bytes]);
  const first = await vault.completeSave(config, begun.saveId, NOW);
  const second = await vault.completeSave(config, begun.saveId, NOW + 5000);
  assert.equal(second.archive, first.archive);
  assert.equal(second.archiveBytes, first.archiveBytes);
  assert.equal(second.completedAt, first.completedAt, "the second answer is the first save, not a new one");
  assert.equal(second.state, "complete");
  assert.deepEqual(visible(config), ["Lenovo-EDL-backup-2026-10-06.zip"]);
  const slice = await rejection(vault.appendChunk(config, begun.saveId, 0, 0, bytes));
  assert.equal(slice.code, "already_complete");
});

// ---------------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------------

test("a name the sender chose never becomes a path: no separator, drive, dot-dot, control character or reserved name survives, and the archive holds exactly the files sent", async () => {
  const config = configWith();
  const hostile = ["../../etc/passwd", "/abs/olute.bin", "C:\\Windows\\win.ini", "..", ".hidden", "trailing. . ", "nul\u0000byte", "manifest.json", "SHA256SUMS", "sha256sums", "CON.txt", "x".repeat(400) + ".bin", "a/b\\c:d.bin", "Same.bin", "same.BIN"];
  const sources = hostile.map((name, index) => [name, Buffer.from(`file ${index}`)]);
  const { done } = await save(config, sources);

  const folder = "Lenovo-EDL-backup-2026-10-06";
  const paths = done.files.map((file) => file.entry.slice(folder.length + 1));
  assert.equal(new Set(paths.map((name) => name.toLowerCase())).size, paths.length, "unique even ignoring case");
  for (const name of paths) {
    assert.ok(!/[\\/:\u0000]/.test(name), name);
    assert.ok(name !== "." && name !== ".." && !name.startsWith("."), name);
    assert.ok(Buffer.byteLength(name) <= 200, name);
  }
  const inside = await readArchive(done.archive);
  assert.ok([...inside.keys()].every((name) => name.startsWith(`${folder}/`) && !name.slice(folder.length + 1).includes("/")), "one folder, no path inside it");
  assert.equal([...inside.keys()].filter((name) => name === `${folder}/manifest.json`).length, 1, "only the manifest the save wrote");
  assert.equal([...inside.keys()].filter((name) => name === `${folder}/SHA256SUMS`).length, 1);
  assert.equal(inside.size, hostile.length + 2);
  assertArchiveOpens(assert, done.archive);
  // Nothing escaped the vault: no file anywhere below the test's scratch root, outside this vault, carries a hostile name.
  const stray = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!full.startsWith(config.root + sep)) stray.push(full);
    }
  };
  walk(scratch.replace(/\/$/, ""));
  assert.deepEqual(stray.filter((file) => file.includes("passwd") || file.includes("win.ini") || file.includes("olute")), []);
  const manifest = JSON.parse(inside.get(`${folder}/manifest.json`).bytes.toString("utf8"));
  assert.equal(manifest.files[0].name, "../../etc/passwd", "the manifest keeps the name the file had, as data");
  assert.notEqual(manifest.files[0].path, manifest.files[0].name);
});

test("the archive is the date in the person's time zone and a safe slug of the label, and a taken name (in any case) gets a number", async () => {
  const config = configWith();
  const late = Date.parse("2026-10-06T23:30:00Z");
  const tokyo = await vault.beginSave(config, ME, request([["a", Buffer.from("a")]], { label: "  Lenovo / Smart Display: EDL backup!! ", timeZone: "Asia/Tokyo" }), late);
  assert.equal(tokyo.archive, join(config.root, "Lenovo-Smart-Display-EDL-backup-2026-10-07.zip"));
  const la = await vault.beginSave(config, ME, request([["a", Buffer.from("b")]], { label: "../../etc", timeZone: "America/Los_Angeles" }), late);
  assert.equal(la.archive, join(config.root, "etc-2026-10-06.zip"));
  assert.equal(inRoot(config.root, la.archive), true);
  const unknownZone = await vault.beginSave(config, ME, request([["a", Buffer.from("c")]], { label: "☃", timeZone: "Not/AZone" }), late);
  assert.equal(unknownZone.archive, join(config.root, "artifacts-2026-10-06.zip"), "an unknown zone falls back to UTC and an empty slug to 'artifacts'");
  const twin = await vault.beginSave(config, ME, request([["a", Buffer.from("d")]], { label: "etc", timeZone: "America/Los_Angeles" }), late);
  assert.equal(twin.archive, join(config.root, "etc-2026-10-06-2.zip"));
  const shouting = await vault.beginSave(config, ME, request([["a", Buffer.from("e")]], { label: "ETC", timeZone: "America/Los_Angeles" }), late);
  assert.equal(shouting.archive, join(config.root, "ETC-2026-10-06-3.zip"), "names are compared ignoring case");
});

function inRoot(root, target) {
  return target.startsWith(root + sep) && !target.slice(root.length + 1).includes(sep);
}

test("an archive whose name was taken by somebody's own file in the meantime takes the next free one, and that file is not touched", async () => {
  const config = configWith();
  const sources = [["a.bin", randomBytes(300)]];
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  assert.equal(begun.archive, join(config.root, "Lenovo-EDL-backup-2026-10-06.zip"));
  writeFileSync(begun.archive, "keep");
  await upload(config, begun, [sources[0][1]]);
  const done = await vault.completeSave(config, begun.saveId, NOW);
  assert.equal(done.archive, join(config.root, "Lenovo-EDL-backup-2026-10-06-2.zip"));
  assert.equal(readFileSync(begun.archive, "utf8"), "keep");
  assertArchiveOpens(assert, done.archive);
  assert.equal(done.files[0].entry, "Lenovo-EDL-backup-2026-10-06/a.bin", "the folder inside is the one the archive was built with");
  assert.equal((await vault.saveStatus(config, begun.saveId)).archive, done.archive);
});

test("two saves of one label on one day, announced together and finished in the other order, each get their own archive", async () => {
  const config = configWith();
  const [first, second] = await Promise.all([
    vault.beginSave(config, ME, request([["a.bin", Buffer.from("one")]]), NOW),
    vault.beginSave(config, ME, request([["b.bin", Buffer.from("two")]]), NOW),
  ]);
  assert.notEqual(first.archive, second.archive, "they never reserve the same name");
  await upload(config, second, [Buffer.from("two")]);
  await upload(config, first, [Buffer.from("one")]);
  const [doneSecond, doneFirst] = [await vault.completeSave(config, second.saveId, NOW), await vault.completeSave(config, first.saveId, NOW)];
  assert.equal(doneSecond.archive, second.archive);
  assert.equal(doneFirst.archive, first.archive);
  assert.equal(visible(config).length, 2);
});

test("a label a slug keeps starting with an underscore saves like any other, and a state file that names an archive outside the vault is not believed", async () => {
  const config = configWith();
  const bytes = Buffer.from("underscore");
  const { begun, done } = await save(config, [["a.bin", bytes]], { label: "__init__" });
  assert.equal(done.archive, join(config.root, "__init__-2026-10-06.zip"));
  assert.equal(done.state, "complete");
  assert.equal(begun.archive, done.archive);

  const tampered = await vault.beginSave(config, ME, request([["b.bin", Buffer.from("b")]], { label: "tampered" }), NOW);
  const stateFile = join(incomingOf(config, tampered.saveId), ".state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  for (const archiveName of ["../../escaped.zip", "/tmp/escaped.zip", "sub/dir.zip", ".hidden.zip", "no-extension", "x\u0000.zip"]) {
    writeFileSync(stateFile, JSON.stringify({ ...state, archiveName }));
    assert.equal(await vault.saveStatus(config, tampered.saveId), undefined, `${JSON.stringify(archiveName)} is not an archive name this vault makes`);
    assert.equal((await rejection(vault.appendChunk(config, tampered.saveId, 0, 0, Buffer.from("b")))).status, 404);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Limits and requests
// ---------------------------------------------------------------------------------------------------------------------

test("limits: too many files, a file or a save that is too large, a full vault and a full disk are each refused up front, in plain words", async () => {
  const one = [["a.bin", Buffer.from("a")]];
  const many = Array.from({ length: 5 }, (_, index) => [`f${index}`, Buffer.from(`${index}`)]);
  assert.equal((await rejection(vault.beginSave(configWith({ maxFiles: 4 }), ME, request(many), NOW))).code, "too_many_files");
  const bigFile = await rejection(vault.beginSave(configWith({ maxFileBytes: 10 }), ME, request([["big.bin", Buffer.alloc(11)]]), NOW));
  assert.equal(bigFile.status, 413);
  assert.match(bigFile.message, /"big\.bin" is 11 bytes/);
  assert.equal((await rejection(vault.beginSave(configWith({ maxSaveBytes: 10 }), ME, request([["a", Buffer.alloc(6)], ["b", Buffer.alloc(6)]]), NOW))).code, "too_large");

  const capped = configWith({ maxVaultBytes: 100_000 });
  const first = await vault.beginSave(capped, ME, request([["a.bin", Buffer.alloc(60_000)]]), NOW);
  assert.equal(first.state, "uploading");
  const full = await rejection(vault.beginSave(capped, ME, request([["b.bin", Buffer.alloc(60_000, 1)]]), NOW));
  assert.equal(full.status, 507);
  assert.equal(full.code, "quota_exceeded");
  assert.match(full.message, /Delete an older save first/);
  const oversized = await rejection(vault.beginSave(configWith({ maxVaultBytes: 100 }), ME, request([["c.bin", Buffer.alloc(60)]]), NOW));
  assert.equal(oversized.code, "quota_exceeded");
  assert.match(oversized.message, /larger than the server's artifact folder allows/, "a save no cap would ever let finish says so, instead of pointing at older saves to delete");

  const noRoom = await rejection(vault.beginSave(configWith({ minFreeBytes: Number.MAX_SAFE_INTEGER }), ME, request(one), NOW));
  assert.equal(noRoom.status, 507);
  assert.equal(noRoom.code, "disk_full");
  assert.match(noRoom.message, /free and this save needs/);
});

test("the cap counts what a finished archive really is on the disk, not what the files were before packing", async () => {
  const config = configWith({ maxVaultBytes: 200_000, maxChunkBytes: 1 * MiB });
  const { done } = await save(config, [["zeros.bin", Buffer.alloc(150_000)]]);
  assert.ok(done.archiveBytes < 2000);
  // 150,000 files bytes would not fit twice in 200,000, but their archive takes next to nothing.
  const second = await vault.beginSave(config, ME, request([["more.bin", Buffer.alloc(150_000, 1)]], { label: "more" }), NOW);
  assert.equal(second.state, "uploading");
});

test("a request is checked before anything is written: bad sizes, hashes, names and keys name what is wrong", async () => {
  const config = configWith();
  const good = fileInput("a.bin", Buffer.from("a"));
  for (const [bad, pattern] of [
    [null, /not a JSON object/],
    [{ files: [good] }, /chat session/],
    [{ sessionId: "s", files: [] }, /no files/],
    [{ sessionId: "s", files: [{ ...good, size: -1 }] }, /valid size/],
    [{ sessionId: "s", files: [{ ...good, size: 1.5 }] }, /valid size/],
    [{ sessionId: "s", files: [{ ...good, sha256: "nope" }] }, /valid SHA-256/],
    [{ sessionId: "s", files: [{ ...good, name: "  " }] }, /has no name/],
    [{ sessionId: "s", key: "UPPER", files: [good] }, /key must be/],
    [{ sessionId: "s", files: ["a.bin"] }, /not an object/],
  ]) {
    const error = await rejection(vault.beginSave(config, ME, bad, NOW));
    assert.equal(error.status, 400, JSON.stringify(bad));
    assert.match(error.message, pattern, JSON.stringify(bad));
  }
  assert.equal(existsSync(config.root) ? readdirSync(join(config.root, ".incoming")).length : 0, 0, "nothing was created for a request that was refused");
});

test("what is announced about each file's operation is bounded: a time, a set name and a partition list are kept only when they are plausible", async () => {
  const limits = vault.DEFAULT_VAULT_LIMITS;
  const operation = { id: "op-1", deviceId: "usb-1", protocol: "edl", action: "exec" };
  const parse = (extra, fileExtra = {}) => vault.parseSaveRequest({ sessionId: "s", files: [{ ...fileInput("a.bin", Buffer.from("a")), ...fileExtra, operation: { ...operation, ...extra } }] }, limits, NOW).files[0];

  const full = parse({ startedAt: NOW - 90_000, set: "Cronos tablet", partitions: { chosen: ["boot_a"], all: ["boot_a", "boot_b"] } }).operation;
  assert.equal(full.startedAt, NOW - 90_000);
  assert.equal(full.set, "Cronos tablet");
  assert.deepEqual(full.partitions, { chosen: ["boot_a"], all: ["boot_a", "boot_b"] });

  for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, "yesterday", 1e20, -1e20, null]) assert.equal(parse({ startedAt }).operation.startedAt, undefined, String(startedAt));
  assert.equal(parse({ set: "x".repeat(100) }).operation.set.length, 80, "a set name is cut at 80 characters, like every other text");
  assert.equal(parse({ set: "   " }).operation.set, undefined);
  const names = (count, length = 10) => Array.from({ length: count }, (_, index) => `${index}`.padStart(length, "p"));
  assert.equal(parse({ partitions: { chosen: names(1024), all: names(1024) } }).operation.partitions.all.length, 1024);
  for (const partitions of [
    { chosen: names(1025), all: names(1025) },
    { chosen: ["a"], all: names(1025) },
    { chosen: ["x".repeat(81)], all: ["x".repeat(81)] },
    { chosen: [""], all: ["a"] },
    { chosen: ["a"] },
    { chosen: "a", all: "a" },
    { chosen: [1], all: ["a"] },
    "boot_a",
  ]) {
    assert.equal(parse({ partitions }).operation.partitions, undefined, "a partition list that is not plausible is dropped whole, never cut");
  }
  assert.equal(parse({ partitions: { chosen: names(2000), all: names(2000) } }).operation.id, "op-1", "the rest of the operation is kept");

  // A time no date can hold must not stop a save from ever being finished.
  assert.equal(parse({}, { createdAt: 1e20 }).createdAt, NOW);
  assert.equal(parse({}, { createdAt: Number.POSITIVE_INFINITY }).createdAt, NOW);
  const config = configWith();
  const bytes = Buffer.from("odd clock");
  const begun = await vault.beginSave(config, ME, { sessionId: "s", label: "odd", files: [{ ...fileInput("a.bin", bytes), createdAt: 1e20, operation: { ...operation, startedAt: 1e20 } }] }, NOW);
  await upload(config, begun, [bytes]);
  assert.equal((await vault.completeSave(config, begun.saveId, NOW)).state, "complete");
});

test("an unfinished save nobody touched for a week is deleted by the next save, and a recent one is left alone", async () => {
  const config = configWith();
  const old = await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  const recent = await vault.beginSave(config, ME, request([["b.bin", Buffer.from("b")]]), NOW);
  const week = 8 * 24 * 60 * 60 * 1000;
  const stale = new Date(NOW - week);
  const directory = incomingOf(config, old.saveId);
  for (const name of readdirSync(directory)) utimesSync(join(directory, name), stale, stale);
  await vault.beginSave(config, ME, request([["c.bin", Buffer.from("c")]]), NOW);
  assert.equal(await vault.saveStatus(config, old.saveId), undefined);
  assert.ok(await vault.saveStatus(config, recent.saveId));
});

test("a partial archive left behind by a build that died with its server is deleted once it is an hour old, and the save's own files stay", async () => {
  const config = configWith();
  const bytes = randomBytes(2000);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  await upload(config, begun, [bytes]);
  const partial = join(incomingOf(config, begun.saveId), ".archive.part");
  writeFileSync(partial, randomBytes(500));
  const fresh = new Date(NOW);
  utimesSync(partial, fresh, fresh);
  await vault.beginSave(config, ME, request([["b.bin", Buffer.from("b")]]), NOW + 30 * 60_000);
  assert.equal(existsSync(partial), true, "half an hour old: a build might still be writing it");
  await vault.beginSave(config, ME, request([["c.bin", Buffer.from("c")]]), NOW + 2 * 60 * 60_000);
  assert.equal(existsSync(partial), false, "two hours old: nobody is writing it");
  assert.equal((await vault.saveStatus(config, begun.saveId)).files[0].verified, true, "the uploaded file is still there and verified");
  assert.equal((await vault.completeSave(config, begun.saveId, NOW)).state, "complete", "and the save can still be finished");
});

// ---------------------------------------------------------------------------------------------------------------------
// Listing, owning, removing
// ---------------------------------------------------------------------------------------------------------------------

test("saves are listed newest first, by chat, and only the ones the caller may see", async () => {
  const config = configWith();
  const make = async (owner, sessionId, name, at) => {
    const bytes = Buffer.from(name);
    const begun = await vault.beginSave(config, { owner }, request([[name, bytes]], { sessionId, label: name }), at);
    await upload(config, begun, [bytes]);
    return vault.completeSave(config, begun.saveId, at);
  };
  const a = await make("user-1", "chat-1", "one", NOW);
  const b = await make("user-2", "chat-1", "two", NOW + 1000);
  const c = await make("user-1", "chat-2", "three", NOW + 2000);
  const open = await vault.beginSave(config, { owner: "user-1" }, request([["x", Buffer.from("x")]], { sessionId: "chat-1", label: "open" }), NOW);

  const accept = (save) => save.owner === null || save.owner === "user-1";
  assert.deepEqual((await vault.listSaves(config, {}, accept)).map((save) => save.saveId), [c.saveId, a.saveId]);
  assert.deepEqual((await vault.listSaves(config, { sessionId: "chat-1" }, accept)).map((save) => save.saveId), [a.saveId]);
  assert.deepEqual((await vault.listSaves(config, { sessionId: "chat-1" }, () => true)).map((save) => save.saveId), [b.saveId, a.saveId]);
  const withOpen = await vault.listSaves(config, { sessionId: "chat-1", unfinished: true }, accept);
  assert.ok(withOpen.some((save) => save.saveId === open.saveId && save.state === "uploading"));
  assert.deepEqual(await vault.saveOwnership(config, a.saveId), { owner: "user-1", sessionId: "chat-1" });
  assert.equal(await vault.saveOwnership(config, "../etc"), undefined);
  const listed = (await vault.listSaves(config, {}, () => true)).find((save) => save.saveId === a.saveId);
  assert.deepEqual(listed.files.map((file) => [file.name, file.entry, file.size, file.sha256]), [["one", "one-2026-10-06/one", 3, sha256("one")]]);
  assert.equal(listed.archive, a.archive);
  assert.equal(listed.archiveBytes, statSync(a.archive).size);
});

test("what is in the root that is not a finished archive is ignored: a person's files, folders saved by version 0.53.0, broken and foreign zips", async () => {
  const config = configWith();
  const { done } = await save(config, [["a.bin", Buffer.from("mine")]]);
  const legacy = join(config.root, "2026-10-01-Old-backup");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "manifest.json"), JSON.stringify({ format: "cody-device-artifacts/1", saveId: "a".repeat(32), label: "old", sessionId: "chat-1", owner: { id: "user-1" }, createdAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:00:00.000Z", totalBytes: 1, verified: true, files: [] }));
  writeFileSync(join(legacy, "a.bin"), "old bytes");
  writeFileSync(join(config.root, "notes.txt"), "my notes");
  writeFileSync(join(config.root, "broken.zip"), randomBytes(600));
  writeFileSync(join(config.root, "empty.zip"), "");
  mkdirSync(join(config.root, "folder.zip"));
  if (archiveTools.python) {
    const made = spawnSync("python3", ["-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], 'w'); z.writestr('holiday/manifest.json', '{\"format\": \"cody-device-artifacts/2\"}'); z.writestr('holiday/photo.jpg', 'x')", join(config.root, "holiday.zip")]);
    assert.equal(made.status, 0, String(made.stderr));
  }

  assert.deepEqual((await vault.listSaves(config, {}, () => true)).map((save) => save.saveId), [done.saveId], "only the archive the vault made is a save");
  assert.equal(await vault.saveStatus(config, "a".repeat(32)), undefined, "a 0.53.0 folder is not found by its id");
  assert.equal(await vault.saveOwnership(config, "a".repeat(32)), undefined);
  assert.equal(await vault.removeSave(config, "a".repeat(32)), false);
  assert.equal(await vault.removeSave(config, done.saveId), true);
  assert.equal(existsSync(done.archive), false);
  for (const kept of ["2026-10-01-Old-backup", "notes.txt", "broken.zip", "empty.zip", "folder.zip"]) assert.equal(existsSync(join(config.root, kept)), true, `${kept} is somebody's and was not touched`);
  assert.equal(readFileSync(join(legacy, "a.bin"), "utf8"), "old bytes");
});

test("a finished archive is read once, not every time somebody asks: its manifest is remembered until the file changes", async () => {
  disk.reset();
  const config = configWith();
  const { done } = await save(config, [["a.bin", Buffer.from("remembered")]]);
  const ask = async () => {
    await vault.saveStatus(config, done.saveId);
    await vault.saveOwnership(config, done.saveId);
    await vault.listSaves(config, {}, () => true);
  };
  disk.reads.length = 0;
  for (let round = 0; round < 5; round += 1) await ask();
  assert.deepEqual(disk.reads, [], "five rounds of questions opened nothing");
  const later = new Date(Date.now() + 5000);
  utimesSync(done.archive, later, later);
  await ask();
  await ask();
  assert.deepEqual(disk.reads, [done.archive], "a file that changed is read again, once");
});

test("a save id that is not one the vault made never reaches the filesystem", async () => {
  const config = configWith();
  await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  for (const id of ["../../etc", "..", "", "ABC", "x".repeat(32), "0".repeat(31), "0".repeat(33), "a/b"]) {
    assert.equal(await vault.saveStatus(config, id), undefined, JSON.stringify(id));
    assert.equal(await vault.removeSave(config, id), false, JSON.stringify(id));
    assert.equal((await rejection(vault.appendChunk(config, id, 0, 0, Buffer.from("x")))).status, 404, JSON.stringify(id));
  }
});

test("a save can be abandoned, and a finished one deleted, by id only", async () => {
  const config = configWith();
  const open = await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  assert.equal(await vault.removeSave(config, open.saveId), true);
  assert.equal(await vault.saveStatus(config, open.saveId), undefined);

  const bytes = Buffer.from("finished");
  const begun = await vault.beginSave(config, ME, request([["b.bin", bytes]]), NOW);
  await upload(config, begun, [bytes]);
  const done = await vault.completeSave(config, begun.saveId, NOW);
  writeFileSync(join(config.root, "someone-elses-file.txt"), "keep");
  assert.equal(await vault.removeSave(config, begun.saveId), true);
  assert.equal(existsSync(done.archive), false);
  assert.equal(readFileSync(join(config.root, "someone-elses-file.txt"), "utf8"), "keep", "only the save's own archive goes");
  assert.equal(await vault.removeSave(config, begun.saveId), false);
});

test("configuration: the default root is inside Cody's data directory, an override moves it, and the cap can be changed or lifted", () => {
  const home = vault.vaultConfig({});
  assert.equal(home.root, join(process.env.PI_CODING_AGENT_DIR, "cody-device-artifacts"));
  assert.equal(home.limits.maxVaultBytes, 256 * 1024 ** 3);
  const moved = vault.vaultConfig({ CODY_DEVICE_ARTIFACTS_DIR: join(scratch, "elsewhere", ".."), CODY_DEVICE_ARTIFACTS_MAX_GB: "0.5" });
  assert.equal(moved.root, scratch);
  assert.equal(moved.limits.maxVaultBytes, 512 * 1024 ** 2);
  assert.equal(vault.vaultConfig({ CODY_DEVICE_ARTIFACTS_MAX_GB: "0" }).limits.maxVaultBytes, 0);
  assert.equal(vault.vaultConfig({ CODY_DEVICE_ARTIFACTS_MAX_GB: "lots" }).limits.maxVaultBytes, 256 * 1024 ** 3);
  assert.equal(vault.vaultConfig({ OMP_WEB_DEVICE_ARTIFACTS_DIR: join(scratch, "legacy") }).root, join(scratch, "legacy"));
});

const partOf = (config, saveId) => {
  const directory = incomingOf(config, saveId);
  return join(directory, readdirSync(directory).find((name) => name.endsWith(".part") && name !== ".archive.part"));
};

const BOOKKEEPING_LOOKALIKES = ["state.json", "STATE.JSON", "0.part", "1.part", "2.part", ".state.json", ".0.part", ".1.part", "manifest.json", "SHA256SUMS", "normal.bin"];

test("files named like the vault's own bookkeeping (state.json, N.part, even the dotted forms) are saved whole, never deleted or mixed into another file", async () => {
  const config = configWith();
  const sources = BOOKKEEPING_LOOKALIKES.map((name, index) => [name, randomBytes(700 + index * 13)]);
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes), 300);
  const done = await vault.completeSave(config, begun.saveId, NOW + 1000);

  assert.equal(done.verified, true);
  const inside = await readArchive(done.archive);
  const folder = "Lenovo-EDL-backup-2026-10-06";
  const manifest = JSON.parse(inside.get(`${folder}/manifest.json`).bytes.toString("utf8"));
  assert.equal(manifest.files.length, sources.length);
  for (const [index, [name, bytes]] of sources.entries()) {
    const entry = manifest.files[index];
    assert.equal(entry.name, name, "the manifest keeps the name the file had");
    assert.ok(inside.get(`${folder}/${entry.path}`)?.bytes.equals(bytes), `${name} is in the archive as ${entry.path}, holding its own bytes`);
  }
  assert.equal(inside.size, sources.length + 2, "every file, the manifest and SHA256SUMS, and nothing else");
  assert.ok([...inside.keys()].every((name) => !name.slice(folder.length + 1).startsWith(".")), "no bookkeeping file went into the archive");
  assert.deepEqual(readdirSync(join(config.root, ".incoming")), [], "and none is left behind");

  // 'verified' is what the person is told; it has to hold when the sums are checked with the standard tool.
  const sums = inside.get(`${folder}/SHA256SUMS`).bytes.toString("utf8").trim().split("\n");
  assert.equal(sums.length, sources.length + 1);
  for (const line of sums) {
    const [hash, file] = line.split("  ");
    assert.equal(sha256(inside.get(`${folder}/${file}`).bytes), hash, file);
  }
  assertArchiveOpens(assert, done.archive);
});

// ---------------------------------------------------------------------------------------------------------------------
// Slices on a disk that misbehaves
// ---------------------------------------------------------------------------------------------------------------------

test("a slice the disk only took part of is written to the end, and the answer is the length that is really stored", { timeout: 20_000 }, async () => {
  disk.reset();
  const config = configWith();
  const bytes = randomBytes(5000);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  disk.appends.limit = 700;
  try {
    assert.deepEqual(await vault.appendChunk(config, begun.saveId, 0, 0, bytes.subarray(0, 4000)), { received: 4000 });
    assert.ok(disk.appends.calls >= 2, "the stand-in really did take the slice in pieces");
  } finally {
    disk.reset();
  }
  assert.equal(statSync(partOf(config, begun.saveId)).size, 4000, "all of the slice is on the disk, not just the first piece");
  await vault.appendChunk(config, begun.saveId, 0, 4000, bytes.subarray(4000));
  assert.deepEqual(await vault.verifyFile(config, begun.saveId, 0), { sha256: sha256(bytes) });
});

test("a disk that stops taking bytes ends the slice with a disk-full answer that says what is stored, instead of looping or claiming success", { timeout: 20_000 }, async () => {
  disk.reset();
  const config = configWith();
  const bytes = randomBytes(3000);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  disk.appends.limit = 1000;
  disk.appends.stallAfter = 1;
  try {
    const error = await rejection(vault.appendChunk(config, begun.saveId, 0, 0, bytes));
    assert.equal(error.status, 507);
    assert.equal(error.code, "disk_full");
    assert.equal(error.details.received, 1000);
  } finally {
    disk.reset();
  }
  assert.equal((await vault.saveStatus(config, begun.saveId)).files[0].received, 1000, "the server's own record agrees, so the sender carries on from there");
});

// ---------------------------------------------------------------------------------------------------------------------
// Building the archive: a long job that can fail, be joined, be stopped and be repeated
// ---------------------------------------------------------------------------------------------------------------------

/** What a failed build must always leave: the raw files and their state, no partial archive, nothing under a final name. */
function assertOnlyRawFilesLeft(config, saveId, count) {
  assert.deepEqual(visible(config), [], "nothing is under a final name");
  const left = readdirSync(incomingOf(config, saveId)).sort();
  assert.deepEqual(left, [".state.json", ...Array.from({ length: count }, (_, index) => `.${index}.part`)].sort(), "the raw files are kept and no partial archive is");
}

for (const [label, fault] of [
  ["a disk that fills up (the write fails)", () => { disk.archive.fullAfter = 300_000; }],
  ["a disk that just stops taking bytes", () => { disk.archive.stallAfter = 300_000; }],
]) {
  test(`${label} during the archive fails cleanly: no partial archive, the files kept and still verified, a 507 that says so, and trying again after room is made uploads nothing`, async () => {
    disk.reset();
    const config = bigConfig();
    const sources = large();
    const begun = await vault.beginSave(config, ME, request(sources), NOW);
    await bigUpload(config, begun, sources);
    fault();
    const error = await rejection(vault.completeSave(config, begun.saveId, NOW));
    assert.equal(error.status, 507);
    assert.equal(error.code, "disk_full");
    assert.match(error.message, /disk is full/);
    assert.match(error.message, /still on the server/);
    assert.match(error.message, /nothing is uploaded twice/);
    assert.ok(disk.archive.accepted > 0 && disk.archive.accepted <= 300_000, "the build really started writing before the disk gave out");
    assertOnlyRawFilesLeft(config, begun.saveId, 2);

    const status = await vault.saveStatus(config, begun.saveId);
    assert.equal(status.state, "uploading");
    assert.ok(status.files.every((file) => file.verified), "every file is still verified on the server");
    assert.equal(status.buildError.code, "disk_full");
    assert.match(status.buildError.message, /Free some space/);

    // A restarted server forgets the failure but still has the files, so the next complete simply tries again.
    globalThis.__codyVaultBuilds.clear();
    assert.equal((await vault.saveStatus(config, begun.saveId)).buildError, undefined);

    disk.reset();
    const writes = disk.archive.opened;
    const retried = await vault.completeSave(config, begun.saveId, NOW);
    assert.equal(retried.state, "complete");
    assert.equal(disk.archive.opened, writes + 1, "one more build, and not one more upload");
    const inside = await readArchive(retried.archive);
    for (const [name, bytes] of sources) assert.ok(inside.get(`Lenovo-EDL-backup-2026-10-06/${name}`).bytes.equals(bytes), name);
    assert.deepEqual(readdirSync(join(config.root, ".incoming")), []);
  });
}

test("a failed build is remembered with its reason until the sender tries again; announcing the save again is trying again, with every file still in place", async () => {
  disk.reset();
  const config = bigConfig();
  const sources = large();
  const key = "34".repeat(16);
  const begun = await vault.beginSave(config, ME, request(sources, { key }), NOW);
  await bigUpload(config, begun, sources);
  disk.archive.fullAfter = 100_000;
  await rejection(vault.completeSave(config, begun.saveId, NOW));
  for (let ask = 0; ask < 3; ask += 1) assert.equal((await vault.saveStatus(config, begun.saveId)).buildError.code, "disk_full", "every look at the save tells why it stopped");
  assert.equal((await vault.listSaves(config, { unfinished: true }, () => true)).find((save) => save.saveId === begun.saveId).buildError.code, "disk_full");

  // The page's Save button announces the same save again: it finds every file in place, and the failure is no longer
  // what the save says (somebody following it, like the agent, must not report a failure that is being put right).
  const again = await vault.beginSave(config, ME, request(sources, { key }), NOW);
  assert.equal(again.saveId, begun.saveId);
  assert.equal(again.resumed, true);
  assert.equal(again.state, "uploading");
  assert.ok(again.files.every((file) => file.verified));
  assert.equal(again.buildError, undefined);
  assert.equal((await vault.saveStatus(config, begun.saveId)).buildError, undefined);
  disk.reset();
  assert.equal((await vault.completeSave(config, begun.saveId, NOW)).state, "complete");
  assert.equal((await vault.saveStatus(config, begun.saveId)).buildError, undefined);
});

test("a save the cap admits always finishes, even one that packs no smaller; a cap lowered after it began still stops the packing cleanly with the quota's own message", async () => {
  disk.reset();
  const noise = [["noise.bin", randomBytes(1 * MiB)]];
  // Just enough for the file and the packing allowance: before, this save was admitted and then failed while packing, every time.
  const tight = bigConfig({ maxVaultBytes: 1 * MiB + 20_000 });
  const begun = await vault.beginSave(tight, ME, request(noise), NOW);
  await bigUpload(tight, begun, noise);
  const done = await vault.completeSave(tight, begun.saveId, NOW);
  assert.equal(done.state, "complete");
  assert.ok(done.archiveBytes > 1 * MiB && done.archiveBytes < 1 * MiB + 20_000, `an incompressible megabyte packs to about a megabyte (${done.archiveBytes})`);

  disk.reset();
  const lowered = bigConfig({ maxVaultBytes: 1 * MiB + 20_000 });
  const again = await vault.beginSave(lowered, ME, request(noise, { label: "again" }), NOW);
  await bigUpload(lowered, again, noise);
  const error = await rejection(vault.completeSave({ ...lowered, limits: { ...lowered.limits, maxVaultBytes: 400_000 } }, again.saveId, NOW));
  assert.equal(error.status, 507);
  assert.equal(error.code, "quota_exceeded");
  assert.match(error.message, /limited to/);
  assert.match(error.message, /still on the server/);
  assert.ok(disk.archive.accepted > 0 && disk.archive.accepted < 400_000, `it stopped part of the way (${disk.archive.accepted} bytes written), long before the whole megabyte`);
  assertOnlyRawFilesLeft(lowered, again.saveId, 1);
  assert.equal((await vault.saveStatus(lowered, again.saveId)).buildError.code, "quota_exceeded");
});

test("the room an unfinished save still needs is held only while someone is sending it: a save untouched for an hour no longer blocks a new one, and the refusal names the one that does", async () => {
  disk.reset();
  const MB = 1024 * 1024;
  const config = configWith({ minFreeBytes: 10 * MB });
  // A 40 MB save announced and then left: nothing of it has arrived.
  const started = Date.now();
  const left = await vault.beginSave(config, ME, request([["big.bin", Buffer.alloc(40 * MB)]], { label: "Left behind" }), started);
  // The disk has 50 MB: enough for a 1 MB save (1 MB of files, as much again for the zip, 10 MB to spare), not for that AND the 40 MB still owed.
  disk.availableBytes = 50 * MB;
  try {
    const refused = await rejection(vault.beginSave(config, ME, request([["small.bin", Buffer.alloc(1 * MB)]], { label: "Small" }), started + 60_000));
    assert.equal(refused.status, 507);
    assert.equal(refused.code, "disk_full");
    assert.match(refused.message, /40\.0 MB of that is still to arrive for another save: 40\.0 MB for "Left behind" \(save [a-f0-9]{32}, last sent to 1 minute ago\)/, "the person is told which save holds the room");
    assert.match(refused.message, /an hour after the last slice it stops holding the room/);
    assert.ok(refused.message.includes(left.saveId));

    // Two hours later nobody has sent another byte of it: it no longer holds the room, though its folder stays until the retention period.
    const later = await vault.beginSave(config, ME, request([["small.bin", Buffer.alloc(1 * MB)]], { label: "Small" }), started + 2 * 60 * 60_000);
    assert.equal(later.state, "uploading");
    assert.equal((await vault.saveStatus(config, left.saveId))?.state, "uploading", "the left-behind save is still there to be finished");

    // A slice sent to it brings it back into the reckoning.
    await vault.appendChunk(config, left.saveId, 0, 0, Buffer.alloc(4096));
    const again = await rejection(vault.beginSave(config, ME, request([["tiny.bin", Buffer.alloc(1 * MB)]], { label: "Tiny" }), Date.now() + 60_000));
    assert.equal(again.code, "disk_full");
    assert.match(again.message, /"Left behind"/);
  } finally {
    disk.reset();
  }
});

test("the disk's free-space floor is kept while the archive is written beside the raw files, and on every slice", async () => {
  disk.reset();
  const sources = [["zeros.bin", Buffer.alloc(300_000)]];
  const config = bigConfig({ minFreeBytes: 0 });
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await bigUpload(config, begun, sources);
  const floor = { ...config, limits: { ...config.limits, minFreeBytes: Number.MAX_SAFE_INTEGER } };
  const error = await rejection(vault.completeSave(floor, begun.saveId, NOW));
  assert.equal(error.status, 507);
  assert.equal(error.code, "disk_full");
  assert.match(error.message, /keeps .* to spare/);
  assert.match(error.message, /still on the server/);
  assertOnlyRawFilesLeft(config, begun.saveId, 1);
  const slice = await rejection(vault.appendChunk(floor, (await vault.beginSave(config, ME, request([["more.bin", Buffer.alloc(10)]], { label: "more" }), NOW)).saveId, 0, 0, Buffer.alloc(10)));
  assert.equal(slice.code, "disk_full");
  assert.match(slice.message, /what already arrived is kept/);
  assert.equal((await vault.completeSave(config, begun.saveId, NOW)).state, "complete", "with the floor back to normal the same files pack");
});

test("an archive that fails the independent re-read is thrown away and says which file, the files stay, and trying again can succeed", async () => {
  disk.reset();
  const config = bigConfig();
  const sources = [["boot_a.bin", randomBytes(400_000)], ["small.bin", randomBytes(2000)]];
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await bigUpload(config, begun, sources);
  disk.archive.corruptAt = 150_000;
  const error = await rejection(vault.completeSave(config, begun.saveId, NOW));
  assert.equal(error.status, 422);
  assert.equal(error.code, "archive_check_failed");
  assert.match(error.message, /boot_a\.bin/);
  assert.match(error.message, /thrown away/);
  assertOnlyRawFilesLeft(config, begun.saveId, 2);
  const status = await vault.saveStatus(config, begun.saveId);
  assert.equal(status.buildError.code, "archive_check_failed");
  assert.ok(status.files.every((file) => file.verified), "the stored files are fine and stay verified");

  disk.reset();
  const done = await vault.completeSave(config, begun.saveId, NOW);
  assert.equal(done.state, "complete");
  assertArchiveOpens(assert, done.archive);
});

test("a stored file that was damaged after it was verified is found when the archive is checked, and only that file is asked for again", async () => {
  disk.reset();
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  const part = join(incomingOf(config, begun.saveId), ".0.part");
  const rotten = readFileSync(part);
  rotten[4321] ^= 0x10;
  writeFileSync(part, rotten);

  const error = await rejection(vault.completeSave(config, begun.saveId, NOW));
  assert.equal(error.code, "archive_check_failed");
  assert.match(error.message, /boot_a\.bin/);
  const status = await vault.saveStatus(config, begun.saveId);
  assert.deepEqual(status.files.map((file) => file.verified), [false, true, true, true], "the damaged file lost its mark, the others kept theirs");
  assert.equal(status.files[0].received, 0, "and its copy was deleted so it can be sent again");

  await upload(config, status, sources.map(([, bytes]) => bytes));
  const done = await vault.completeSave(config, begun.saveId, NOW);
  assert.equal(done.state, "complete");
  const inside = await readArchive(done.archive);
  assert.ok(inside.get("Lenovo-EDL-backup-2026-10-06/boot_a.bin").bytes.equals(sources[0][1]));
});

test("a stored file that has gone missing before the archive starts is named, and only it is asked for again", async () => {
  disk.reset();
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  rmSync(join(incomingOf(config, begun.saveId), ".2.part"));
  const error = await rejection(vault.completeSave(config, begun.saveId, NOW));
  assert.equal(error.status, 409);
  assert.equal(error.code, "changed");
  assert.match(error.message, /"exact\.bin" is missing or changed/);
  assert.equal(disk.archive.opened, 0, "nothing was written");
  const status = await vault.saveStatus(config, begun.saveId);
  assert.deepEqual(status.files.map((file) => file.verified), [true, true, false, true]);
  await upload(config, status, sources.map(([, bytes]) => bytes));
  assert.equal((await vault.completeSave(config, begun.saveId, NOW)).state, "complete");
});

test("a build in progress is answered as building, with how much it has packed, to everyone who asks, and a second complete joins it instead of starting another", async () => {
  disk.reset();
  const quick = bigConfig({ completeWaitMs: 20 });
  const patient = { ...quick, limits: { ...quick.limits, completeWaitMs: 20_000 } };
  const sources = large();
  const begun = await vault.beginSave(quick, ME, request(sources), NOW);
  await bigUpload(quick, begun, sources);

  const hold = disk.holdArchive(1_600_000);
  const first = await vault.completeSave(quick, begun.saveId, NOW);
  assert.equal(first.state, "building", "a build that is not finished within the wait is answered as building");
  await hold.reached;

  const looked = await vault.saveStatus(quick, begun.saveId);
  assert.equal(looked.state, "building");
  assert.ok(looked.packedBytes > 0 && looked.packedBytes < looked.totalBytes, `${looked.packedBytes} of ${looked.totalBytes} bytes packed`);
  assert.equal(looked.archiveBytes, undefined, "there is no archive yet");
  assert.equal(looked.verified, false);
  assert.ok(looked.files.every((file) => file.verified && file.received === file.size));
  assert.equal(looked.buildError, undefined);
  assert.equal((await vault.listSaves(quick, { unfinished: true }, () => true)).find((save) => save.saveId === begun.saveId).state, "building");
  assert.deepEqual(await vault.saveOwnership(quick, begun.saveId), { owner: "user-1", sessionId: "chat-1" });
  assert.deepEqual(visible(quick), [], "nothing is under a final name while it builds");
  assert.equal(existsSync(join(incomingOf(quick, begun.saveId), ".archive.part")), true);

  const joined = await vault.completeSave(quick, begun.saveId, NOW);
  assert.equal(joined.state, "building", "a second complete is told the same");
  const waiting = [vault.completeSave(patient, begun.saveId, NOW), vault.completeSave(patient, begun.saveId, NOW)];
  hold.release();
  const [one, two] = await Promise.all(waiting);
  assert.equal(one.state, "complete");
  assert.equal(two.archive, one.archive, "both waiting callers got the one archive");
  assert.equal(disk.archive.opened, 1, "only one archive was ever written");
  assert.deepEqual(visible(quick), [one.archive.slice(quick.root.length + 1)]);
  assert.deepEqual(readdirSync(join(quick.root, ".incoming")), []);
});

test("a build is stopped by deleting the save: the writer lets go, nothing is left on the disk, and everyone waiting on it is told", async () => {
  disk.reset();
  const quick = bigConfig({ completeWaitMs: 20 });
  const patient = { ...quick, limits: { ...quick.limits, completeWaitMs: 20_000 } };
  const sources = large();
  const begun = await vault.beginSave(quick, ME, request(sources), NOW);
  await bigUpload(quick, begun, sources);

  const hold = disk.holdArchive(1_000_000);
  assert.equal((await vault.completeSave(quick, begun.saveId, NOW)).state, "building");
  await hold.reached;
  const waiter = vault.completeSave(patient, begun.saveId, NOW);
  const told = assert.rejects(waiter, (error) => error instanceof vault.VaultError && error.code === "aborted" && /deleted while its archive was being written/.test(error.message));
  const removal = vault.removeSave(quick, begun.saveId);
  hold.release();
  assert.equal(await removal, true);
  await told;
  assert.equal(await vault.saveStatus(quick, begun.saveId), undefined, "the save is gone");
  assert.deepEqual(readdirSync(quick.root).sort(), [".incoming"], "no archive, no partial one");
  assert.deepEqual(readdirSync(join(quick.root, ".incoming")), []);
  assert.equal(disk.archive.opened, 1);
});

test("a save whose archive is being written is never swept away, however old its files look", async () => {
  disk.reset();
  const quick = bigConfig({ completeWaitMs: 20 });
  const sources = large();
  const begun = await vault.beginSave(quick, ME, request(sources), NOW);
  await bigUpload(quick, begun, sources);
  const hold = disk.holdArchive(1_000_000);
  assert.equal((await vault.completeSave(quick, begun.saveId, NOW)).state, "building");
  await hold.reached;
  const directory = incomingOf(quick, begun.saveId);
  const ancient = new Date(NOW - 30 * 24 * 60 * 60 * 1000);
  for (const name of readdirSync(directory)) utimesSync(join(directory, name), ancient, ancient);
  await vault.beginSave(quick, ME, request([["other.bin", Buffer.from("o")]], { label: "other" }), NOW + 60 * 60_000);
  assert.equal(existsSync(directory), true, "the sweep left it alone");
  hold.release();
  assert.equal((await untilComplete(quick, begun.saveId)).state, "complete");
});

test("a restarted server forgets the build it was running, and the next complete simply starts it again over whatever the dead one left", async () => {
  disk.reset();
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  // What a server killed in the middle of a build leaves: every file verified, and half an archive that is not a zip.
  writeFileSync(join(incomingOf(config, begun.saveId), ".archive.part"), randomBytes(3000));
  const status = await vault.saveStatus(config, begun.saveId);
  assert.equal(status.state, "uploading");
  assert.equal(status.buildError, undefined);
  assert.ok(status.files.every((file) => file.verified));
  const done = await vault.completeSave(config, begun.saveId, NOW);
  assert.equal(done.state, "complete");
  assertArchiveOpens(assert, done.archive);
  assert.deepEqual(readdirSync(join(config.root, ".incoming")), []);
});

test("a crash between the archive's rename and the cleanup leaves raw files behind: they are recognised as the leftovers of a finished save and removed, whichever call sees them first", async () => {
  const config = configWith();
  const sources = files();
  const key = "12".repeat(16);
  const begun = await vault.beginSave(config, ME, request(sources, { key }), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  const kept = mkdtempSync(join(tmpdir(), "cody-leftover-"));
  const backup = join(kept, "incoming");
  cpSync(incomingOf(config, begun.saveId), backup, { recursive: true });
  const done = await vault.completeSave(config, begun.saveId, NOW);
  assert.deepEqual(readdirSync(join(config.root, ".incoming")), []);

  const leave = () => cpSync(backup, incomingOf(config, begun.saveId), { recursive: true });
  const leftovers = () => readdirSync(join(config.root, ".incoming"));

  leave();
  const again = await vault.completeSave(config, begun.saveId, NOW + 5000);
  assert.equal(again.state, "complete");
  assert.equal(again.archive, done.archive);
  assert.equal(again.completedAt, done.completedAt, "the same save, not a second build");
  assert.deepEqual(leftovers(), [], "complete removed the leftovers");
  assert.deepEqual(visible(config), [done.archive.slice(config.root.length + 1)], "and no second archive was made");

  leave();
  assert.equal((await vault.saveStatus(config, begun.saveId)).state, "complete", "a status call sees a finished save, not an unfinished one");
  assert.deepEqual((await vault.listSaves(config, { unfinished: true }, () => true)).map((save) => [save.saveId, save.state]), [[begun.saveId, "complete"]], "and so does a list");
  const sameKey = await vault.beginSave(config, ME, request(sources, { key }), NOW + 6000);
  assert.equal(sameKey.existing, true, "asking again finds the finished save");
  assert.deepEqual(leftovers(), [], "the next announcement swept the leftovers");
});

test("the leftovers of a finished save do not count against the vault's cap", async () => {
  const config = configWith({ maxVaultBytes: 120_000 });
  const sources = [["zeros.bin", Buffer.alloc(100_000)]];
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, [sources[0][1]], 4096);
  const kept = mkdtempSync(join(tmpdir(), "cody-leftover-"));
  cpSync(incomingOf(config, begun.saveId), join(kept, "incoming"), { recursive: true });
  await vault.completeSave(config, begun.saveId, NOW);
  cpSync(join(kept, "incoming"), incomingOf(config, begun.saveId), { recursive: true });
  const next = await vault.beginSave(config, ME, request([["more.bin", Buffer.alloc(100_000, 1)]], { label: "more" }), NOW);
  assert.equal(next.state, "uploading", "100,000 bytes of leftovers were not held against a second 100,000");
});
