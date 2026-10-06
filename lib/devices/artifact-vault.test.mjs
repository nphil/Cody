import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The receiving end of "Save to server", driven directly: announce, slices, verify, complete, and everything that can
 * go wrong on the way. The HTTP layer over it has its own file.
 */
const scratch = mkdtempSync(join(tmpdir(), "cody-vault-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const vault = await jiti.import("./artifact-vault.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = process.platform !== "win32";
const NOW = Date.parse("2026-10-06T18:31:12Z");
const ME = { owner: "user-1", ownerName: "nphil" };
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

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof vault.VaultError, `a VaultError, got ${error}`);
    return error;
  }
  return assert.fail("expected the call to be refused");
}

const files = () => [["boot_a.bin", randomBytes(10_000)], ["empty.bin", Buffer.alloc(0)], ["exact.bin", randomBytes(4096)], ["one.bin", randomBytes(1)]];

test("a save goes in under .incoming, and appears as one finished folder with its manifest and checksums, every file verified", async () => {
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  assert.equal(begun.state, "uploading");
  assert.equal(begun.folder, join(config.root, "2026-10-06-Lenovo-EDL-backup"));
  assert.equal(existsSync(begun.folder), false, "nothing is visible under the final name until the save is whole");
  assert.deepEqual(begun.files.map((file) => file.received), [0, 0, 0, 0]);

  await upload(config, begun, sources.map(([, bytes]) => bytes));
  assert.equal(existsSync(begun.folder), false);
  const done = await vault.completeSave(config, begun.saveId, NOW + 60_000);

  assert.equal(done.state, "complete");
  assert.equal(done.verified, true);
  assert.equal(done.folder, begun.folder);
  assert.equal(done.totalBytes, 10_000 + 4096 + 1);
  assert.match(done.manifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(join(config.root, ".incoming")), [], "nothing is left in the incoming area");
  assert.deepEqual(readdirSync(done.folder).sort(), ["SHA256SUMS", "boot_a.bin", "empty.bin", "exact.bin", "manifest.json", "one.bin"]);
  for (const [name, bytes] of sources) assert.equal(sha256(readFileSync(join(done.folder, name))), sha256(bytes), name);

  const manifest = JSON.parse(readFileSync(join(done.folder, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "cody-device-artifacts/1");
  assert.equal(manifest.saveId, begun.saveId);
  assert.equal(manifest.sessionId, "chat-1");
  assert.deepEqual(manifest.owner, { id: "user-1", name: "nphil" });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.completedAt, new Date(NOW + 60_000).toISOString());
  assert.deepEqual(manifest.files[0], { name: "boot_a.bin", path: "boot_a.bin", size: 10_000, sha256: sha256(sources[0][1]), kind: "output", source: "device", createdAt: new Date(NOW - 5000).toISOString() });

  const sums = readFileSync(join(done.folder, "SHA256SUMS"), "utf8");
  assert.equal(sums.split("\n").filter(Boolean).length, 5, "every file and the manifest");
  assert.ok(sums.includes(`${done.manifestSha256}  manifest.json`));
  if (spawnSync("sha256sum", ["--version"], { stdio: "ignore" }).status === 0) {
    const checked = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: done.folder, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  }
});

test("everything it makes is owner-only: directories 0700, files 0600", { skip: !posix }, async () => {
  const config = configWith();
  const sources = files();
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  assert.equal(statSync(config.root).mode & 0o777, 0o700);
  assert.equal(statSync(join(config.root, ".incoming")).mode & 0o777, 0o700);
  assert.equal(statSync(join(config.root, ".incoming", begun.saveId)).mode & 0o777, 0o700);
  assert.equal(statSync(join(config.root, ".incoming", begun.saveId, "state.json")).mode & 0o777, 0o600);
  await vault.appendChunk(config, begun.saveId, 0, 0, sources[0][1].subarray(0, 100));
  assert.equal(statSync(join(config.root, ".incoming", begun.saveId, "0.part")).mode & 0o777, 0o600);
  await upload(config, { ...begun, files: begun.files.map((file, index) => (index === 0 ? { ...file, received: 100 } : file)) }, sources.map(([, bytes]) => bytes));
  const done = await vault.completeSave(config, begun.saveId, NOW);
  assert.equal(statSync(done.folder).mode & 0o777, 0o700);
  for (const name of readdirSync(done.folder)) assert.equal(statSync(join(done.folder, name)).mode & 0o777, 0o600, name);
});

test("a root the owner prepared keeps its permissions; only a root this code makes is narrowed", { skip: !posix }, async () => {
  const config = configWith();
  mkdirSync(config.root, { mode: 0o750 });
  await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  assert.equal(statSync(config.root).mode & 0o777, 0o750);
});

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
  assert.equal(sha256(readFileSync(join(done.folder, "boot_a.bin"))), sha256(sources[0][1]));

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
  assert.equal(again.folder, done.folder);
  assert.equal(readdirSync(config.root).filter((name) => !name.startsWith(".")).length, 1, "no second folder");
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
  assert.equal(statSync(join(config.root, ".incoming", begun.saveId, "0.part")).size, 1000, "none of the refused slices was written");
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
  assert.equal(statSync(join(config.root, ".incoming", begun.saveId, "0.part")).size, 1500);
});

test("a file that arrived damaged is caught by reading it back from disk, its partial copy is deleted, and it can be sent again", async () => {
  const config = configWith();
  const good = randomBytes(3000);
  const damaged = Buffer.from(good);
  damaged[1234] ^= 0xff;
  const begun = await vault.beginSave(config, ME, request([["a.bin", good]]), NOW);
  await vault.appendChunk(config, begun.saveId, 0, 0, damaged.subarray(0, 3000).subarray(0, 2000));
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
  assert.equal(existsSync(join(config.root, "2026-10-06-Lenovo-EDL-backup")), false);
});

test("finishing twice returns the same finished save, so a lost answer can simply be asked for again", async () => {
  const config = configWith();
  const bytes = randomBytes(100);
  const begun = await vault.beginSave(config, ME, request([["a.bin", bytes]]), NOW);
  await upload(config, begun, [bytes]);
  const first = await vault.completeSave(config, begun.saveId, NOW);
  const second = await vault.completeSave(config, begun.saveId, NOW + 5000);
  assert.equal(second.folder, first.folder);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.equal(second.state, "complete");
  const slice = await rejection(vault.appendChunk(config, begun.saveId, 0, 0, bytes));
  assert.equal(slice.code, "already_complete");
});

test("a name the sender chose never becomes a path: no separator, drive, dot-dot, control character or reserved name survives", async () => {
  const config = configWith();
  const hostile = ["../../etc/passwd", "/abs/olute.bin", "C:\\Windows\\win.ini", "..", ".hidden", "trailing. . ", "nul\u0000byte", "manifest.json", "SHA256SUMS", "sha256sums", "CON.txt", "x".repeat(400) + ".bin", "a/b\\c:d.bin", "Same.bin", "same.BIN"];
  const sources = hostile.map((name, index) => [name, Buffer.from(`file ${index}`)]);
  const begun = await vault.beginSave(config, ME, request(sources), NOW);
  await upload(config, begun, sources.map(([, bytes]) => bytes));
  const done = await vault.completeSave(config, begun.saveId, NOW);

  const names = done.files.map((file) => file.path);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length, "unique even ignoring case");
  for (const name of names) {
    assert.ok(!/[\\/:\u0000]/.test(name), name);
    assert.ok(name !== "." && name !== ".." && !name.startsWith("."), name);
    assert.ok(Buffer.byteLength(name) <= 200, name);
  }
  const listing = readdirSync(done.folder);
  assert.equal(listing.filter((name) => name === "manifest.json").length, 1, "only the manifest the save wrote");
  assert.equal(listing.filter((name) => name === "SHA256SUMS").length, 1);
  assert.equal(listing.length, hostile.length + 2);
  // Nothing escaped the vault: every file below the test's scratch root is inside this vault's folders.
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
  const manifest = JSON.parse(readFileSync(join(done.folder, "manifest.json"), "utf8"));
  assert.equal(manifest.files[0].name, "../../etc/passwd", "the manifest keeps the name the file had, as data");
  assert.notEqual(manifest.files[0].path, manifest.files[0].name);
});

test("the folder is the date in the person's time zone and a safe slug of the label, and a taken name gets a number", async () => {
  const config = configWith();
  const late = Date.parse("2026-10-06T23:30:00Z");
  const tokyo = await vault.beginSave(config, ME, request([["a", Buffer.from("a")]], { label: "  Lenovo / Smart Display: EDL backup!! ", timeZone: "Asia/Tokyo" }), late);
  assert.equal(tokyo.folder, join(config.root, "2026-10-07-Lenovo-Smart-Display-EDL-backup"));
  const la = await vault.beginSave(config, ME, request([["a", Buffer.from("b")]], { label: "../../etc", timeZone: "America/Los_Angeles" }), late);
  assert.equal(la.folder, join(config.root, "2026-10-06-etc"));
  assert.equal(path_inside(config.root, la.folder), true);
  const unknownZone = await vault.beginSave(config, ME, request([["a", Buffer.from("c")]], { label: "☃", timeZone: "Not/AZone" }), late);
  assert.equal(unknownZone.folder, join(config.root, "2026-10-06-artifacts"), "an unknown zone falls back to UTC and an empty slug to 'artifacts'");
  const twin = await vault.beginSave(config, ME, request([["a", Buffer.from("d")]], { label: "etc", timeZone: "America/Los_Angeles" }), late);
  assert.equal(twin.folder, join(config.root, "2026-10-06-etc-2"));
});

function path_inside(root, target) {
  return target.startsWith(root + sep) && !target.slice(root.length + 1).includes(sep);
}

test("a finished folder whose name was taken in the meantime takes the next free one", async () => {
  const config = configWith();
  const a = await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  mkdirSync(a.folder, { recursive: true });
  writeFileSync(join(a.folder, "somebody-elses.txt"), "keep");
  await upload(config, a, [Buffer.from("a")]);
  const done = await vault.completeSave(config, a.saveId, NOW);
  assert.equal(done.folder, `${a.folder}-2`);
  assert.equal(readFileSync(join(a.folder, "somebody-elses.txt"), "utf8"), "keep");
});

test("limits: too many files, a file or a save that is too large, a full vault and a full disk are each refused up front, in plain words", async () => {
  const one = [["a.bin", Buffer.from("a")]];
  const many = Array.from({ length: 5 }, (_, index) => [`f${index}`, Buffer.from(`${index}`)]);
  assert.equal((await rejection(vault.beginSave(configWith({ maxFiles: 4 }), ME, request(many), NOW))).code, "too_many_files");
  const bigFile = await rejection(vault.beginSave(configWith({ maxFileBytes: 10 }), ME, request([["big.bin", Buffer.alloc(11)]]), NOW));
  assert.equal(bigFile.status, 413);
  assert.match(bigFile.message, /"big\.bin" is 11 bytes/);
  assert.equal((await rejection(vault.beginSave(configWith({ maxSaveBytes: 10 }), ME, request([["a", Buffer.alloc(6)], ["b", Buffer.alloc(6)]]), NOW))).code, "too_large");

  const capped = configWith({ maxVaultBytes: 100 });
  const first = await vault.beginSave(capped, ME, request([["a.bin", Buffer.alloc(60)]]), NOW);
  assert.equal(first.state, "uploading");
  const full = await rejection(vault.beginSave(capped, ME, request([["b.bin", Buffer.alloc(60, 1)]]), NOW));
  assert.equal(full.status, 507);
  assert.equal(full.code, "quota_exceeded");
  assert.match(full.message, /Delete an older save first/);

  const noRoom = await rejection(vault.beginSave(configWith({ minFreeBytes: Number.MAX_SAFE_INTEGER }), ME, request(one), NOW));
  assert.equal(noRoom.status, 507);
  assert.equal(noRoom.code, "disk_full");
  assert.match(noRoom.message, /free and this save needs/);
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

test("an unfinished save nobody touched for a week is deleted by the next save, and a recent one is left alone", async () => {
  const config = configWith();
  const old = await vault.beginSave(config, ME, request([["a.bin", Buffer.from("a")]]), NOW);
  const recent = await vault.beginSave(config, ME, request([["b.bin", Buffer.from("b")]]), NOW);
  const week = 8 * 24 * 60 * 60 * 1000;
  const stale = new Date(NOW - week);
  const directory = join(config.root, ".incoming", old.saveId);
  for (const name of readdirSync(directory)) utimesSync(join(directory, name), stale, stale);
  await vault.beginSave(config, ME, request([["c.bin", Buffer.from("c")]]), NOW);
  assert.equal(await vault.saveStatus(config, old.saveId), undefined);
  assert.ok(await vault.saveStatus(config, recent.saveId));
});

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
  mkdirSync(join(config.root, "someone-elses-folder"));
  assert.equal(await vault.removeSave(config, begun.saveId), true);
  assert.equal(existsSync(done.folder), false);
  assert.equal(existsSync(join(config.root, "someone-elses-folder")), true, "only the save's own folder goes");
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
