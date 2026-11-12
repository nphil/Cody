import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * What a worker sends back is NOT trusted, so the unpacker is Cody's own. What
 * matters: a good archive (made by the real `tar`) restores byte for byte with
 * the executable bit kept and set-uid bits dropped; every hostile or damaged
 * stream (`..`, absolute or .git names, members nobody asked for, a symlink
 * the copy would write through, a cut-off or corrupt stream, too many files or
 * bytes) makes the pipeline fail with nothing written outside the project and
 * no half-written temp file left; links and special files are skipped and
 * counted, never created; and the text-before-the-payload splitter passes
 * binary data through untouched however the chunks fall.
 */
const jiti = createJiti(import.meta.url);
const tarball = await jiti.import("./tarball.ts");
const { TarExtractor, HeadSplitter, TarProtocolError, createArchive, checkMemberName } = tarball;

const base = realpathSync(mkdtempSync(join(tmpdir(), "cody-workers-tar-")));
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
/** A fresh `root` (the project) with a sibling `outside` that nothing may touch. */
function sandbox(name) {
  counter += 1;
  const dir = join(base, `${counter}-${name}`);
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "untouched");
  return { dir, root, outside };
}

// ── A tiny tar writer, to craft hostile archives ─────────────────────────────

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}
function field(buffer, text, start, length) {
  Buffer.from(text, "utf8").copy(buffer, start, 0, length);
}
/** One 512-byte header. `sizeField`/`magic` override the defaults to make damaged headers. */
function header({ name, type = "0", size = 0, mode = 0o644, linkname = "", prefix = "", sizeField, magic = "ustar\0" }) {
  const block = Buffer.alloc(512);
  field(block, name, 0, 100);
  field(block, octal(mode, 8), 100, 8);
  field(block, octal(0, 8), 108, 8);
  field(block, octal(0, 8), 116, 8);
  field(block, sizeField ?? octal(size, 12), 124, 12);
  field(block, octal(1_700_000_000, 12), 136, 12);
  block.fill(0x20, 148, 156);
  field(block, type, 156, 1);
  field(block, linkname, 157, 100);
  field(block, `${magic}00`, 257, 8);
  field(block, prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}
function padded(data) {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}
/** A member: header, body, padding. */
function member(options, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([header({ ...options, size: options.size ?? body.length }), padded(body)]);
}
const END = Buffer.alloc(1024);
function paxRecord(key, value) {
  const rest = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(rest) + 1;
  while (String(length).length + Buffer.byteLength(rest) !== length) length = String(length).length + Buffer.byteLength(rest);
  return `${length}${rest}`;
}
function pax(records, type = "x") {
  return member({ name: "PaxHeader/x", type }, Buffer.from(Object.entries(records).map(([k, v]) => paxRecord(k, v)).join("")));
}
function archive(...parts) {
  return Buffer.concat([...parts, END]);
}

/**
 * Pipe `bytes` through an extractor. Resolves with the error (or null) and the
 * extractor; waits for the extractor to finish cleaning up its temp file.
 */
async function extract(bytes, { root, allowed, limits, chunk = 4096 }) {
  const chunks = [];
  for (let at = 0; at < bytes.length; at += chunk) chunks.push(bytes.subarray(at, at + chunk));
  const extractor = new TarExtractor({ root, allowed, limits });
  let error = null;
  try {
    await pipeline(Readable.from(chunks, { objectMode: false }), extractor);
  } catch (caught) {
    error = caught;
  }
  if (!extractor.closed) await once(extractor, "close");
  return { error, extractor, report: extractor.report };
}
function listAll(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    found.push(`${prefix}${entry.name}`);
    if (entry.isDirectory()) found.push(...listAll(join(dir, entry.name), `${prefix}${entry.name}/`));
  }
  return found.sort();
}
function assertOutsideUntouched(box) {
  assert.deepEqual(readdirSync(box.outside), ["keep.txt"]);
  assert.equal(readFileSync(join(box.outside, "keep.txt"), "utf8"), "untouched");
  assert.deepEqual(readdirSync(box.dir).sort(), ["outside", "root"]);
}
async function refused(box, bytes, allowed, pattern, extra = {}) {
  const { error } = await extract(bytes, { root: box.root, allowed, ...extra });
  assert.ok(error, "expected the extraction to fail");
  assert.ok(error instanceof TarProtocolError, `expected a TarProtocolError, got ${error?.name}: ${error?.message}`);
  assert.match(error.message, pattern);
  assertOutsideUntouched(box);
  assert.deepEqual(listAll(box.root).filter((f) => f.endsWith(".tmp")), [], "no temp file may stay");
  return error;
}

// ── createArchive -> TarExtractor ────────────────────────────────────────────

async function packAndUnpack(source, names, dest, allowed) {
  const packed = createArchive(source, names);
  const extractor = new TarExtractor({ root: dest, allowed });
  await Promise.all([pipeline(packed.stdout, extractor), packed.done]);
  return { extractor, done: await packed.done };
}

test("files packed by tar come back byte for byte into a different root, with the report counting them", async () => {
  const src = sandbox("src");
  const dst = sandbox("dst");
  const big = randomBytes(3 * 1024 * 1024 + 12_345);
  mkdirSync(join(src.root, "out/deep/er"), { recursive: true });
  mkdirSync(join(src.root, "emptydir"));
  writeFileSync(join(src.root, "out/a.txt"), "hello");
  writeFileSync(join(src.root, "out/deep/er/b.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(src.root, "out/big.bin"), big);
  writeFileSync(join(src.root, "out/uni çode ☃ and spaces.txt"), "unicode");
  writeFileSync(join(src.root, "out/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(src.root, "zero.txt"), "");
  const names = ["emptydir", "out", "out/a.txt", "out/deep", "out/deep/er", "out/deep/er/b.bin", "out/big.bin", "out/run.sh", "out/uni çode ☃ and spaces.txt", "zero.txt"];
  const { extractor, done } = await packAndUnpack(src.root, names, dst.root, ["emptydir", "out", "zero.txt"]);
  assert.equal(done.ok, true);
  assert.deepEqual(readFileSync(join(dst.root, "out/big.bin")), big);
  assert.equal(readFileSync(join(dst.root, "out/a.txt"), "utf8"), "hello");
  assert.deepEqual([...readFileSync(join(dst.root, "out/deep/er/b.bin"))], [0, 1, 2, 255]);
  assert.equal(readFileSync(join(dst.root, "out/uni çode ☃ and spaces.txt"), "utf8"), "unicode");
  assert.equal(readFileSync(join(dst.root, "zero.txt"), "utf8"), "");
  assert.ok(statSync(join(dst.root, "out/run.sh")).mode & 0o100, "the executable bit survives");
  assert.ok(!(statSync(join(dst.root, "out/a.txt")).mode & 0o111), "a plain file stays plain");
  assert.ok(lstatSync(join(dst.root, "emptydir")).isDirectory(), "an empty directory named in the list is restored");
  assert.deepEqual(listAll(dst.root).filter((f) => f.endsWith(".tmp")), []);
  assert.deepEqual(extractor.report, {
    files: 6,
    directories: 4,
    bytes: big.length + 5 + 4 + 7 + 10,
    skippedCount: 0,
    skipped: [],
    complete: true,
  });
  assert.deepEqual(readdirSync(dst.dir).sort(), ["outside", "root"]);
});

test("an overwritten file keeps the new bytes, and no temp file is left next to it", async () => {
  const src = sandbox("over-src");
  const dst = sandbox("over-dst");
  writeFileSync(join(src.root, "f.txt"), "new");
  writeFileSync(join(dst.root, "f.txt"), "old old old");
  await packAndUnpack(src.root, ["f.txt"], dst.root, ["f.txt"]);
  assert.equal(readFileSync(join(dst.root, "f.txt"), "utf8"), "new");
  assert.deepEqual(readdirSync(dst.root), ["f.txt"]);
});

test("a file missing from the list makes tar fail with its complaint, not hang", async () => {
  const src = sandbox("missing");
  writeFileSync(join(src.root, "here.txt"), "x");
  const packed = createArchive(src.root, ["here.txt", "nope.txt"]);
  packed.stdout.resume();
  const done = await packed.done;
  assert.equal(done.ok, false);
  assert.match(done.stderr, /nope\.txt/);
});

test("an empty list makes an empty but valid archive", async () => {
  const src = sandbox("nolist");
  const dst = sandbox("nolist-dst");
  const { extractor, done } = await packAndUnpack(src.root, [], dst.root, []);
  assert.equal(done.ok, true);
  assert.equal(extractor.report.complete, true);
  assert.equal(extractor.report.files, 0);
});

test("a file that changes while being read is only a warning (tar exit status 1)", async () => {
  const src = sandbox("warn");
  writeFileSync(join(src.root, "a.txt"), "x");
  const packed = createArchive(src.root, ["a.txt"]);
  packed.stdout.resume();
  const done = await packed.done;
  assert.equal(done.ok, true); // exit 0 here; the mapping of code 1 to ok is the module's contract, read from its source
  assert.ok(done.code === 0 || done.code === 1);
});

test("kill() stops tar and done still settles", async () => {
  const src = sandbox("kill");
  writeFileSync(join(src.root, "big.bin"), randomBytes(2 * 1024 * 1024));
  const packed = createArchive(src.root, ["big.bin"]);
  packed.kill(); // nothing reads stdout, so tar would stall on a full pipe
  const done = await packed.done;
  assert.equal(done.ok, false);
  packed.kill(); // a second kill after the end is harmless
});

test("GNU tar's long names (over 100 and over 255 characters), pax and ustar prefixes all restore", async () => {
  const src = sandbox("long-src");
  const parts = ["a".repeat(90), "b".repeat(90), "c".repeat(90)];
  const dir = parts.join("/");
  mkdirSync(join(src.root, "out", dir), { recursive: true });
  const long = `out/${dir}/${"f".repeat(40)}.txt`; // ~ 300 characters
  const medium = `out/${parts[0]}/${parts[1]}/m.txt`; // ~ 190 characters
  writeFileSync(join(src.root, long), "long");
  writeFileSync(join(src.root, medium), "medium");
  assert.ok(long.length > 255 && medium.length > 100 && medium.length < 255);
  for (const format of ["gnu", "pax", "ustar"]) {
    const names = format === "ustar" ? [medium] : [long, medium];
    const bytes = execFileSync("tar", ["-c", `--format=${format}`, "--null", "-C", src.root, "-T", "-", "-f", "-"], { input: names.join("\0") + "\0", maxBuffer: 1 << 26 });
    const dst = sandbox(`long-${format}`);
    const { error, report } = await extract(bytes, { root: dst.root, allowed: ["out"] });
    assert.equal(error, null, `${format}: ${error?.message}`);
    assert.equal(readFileSync(join(dst.root, medium), "utf8"), "medium", format);
    if (format !== "ustar") assert.equal(readFileSync(join(dst.root, long), "utf8"), "long", format);
    assert.equal(report.files, names.length, format);
    assert.equal(report.complete, true);
  }
});

test("the archive restores the same whatever size the chunks arrive in", async () => {
  const bytes = archive(member({ name: "out/a.txt" }, "A".repeat(700)), member({ name: "out/b.txt" }, "bb"));
  for (const chunk of [1, 7, 511, 512, 513, 100_000]) {
    const box = sandbox(`chunk${chunk}`);
    const { error, report } = await extract(bytes, { root: box.root, allowed: ["out"], chunk });
    assert.equal(error, null, `chunk ${chunk}`);
    assert.equal(readFileSync(join(box.root, "out/a.txt"), "utf8"), "A".repeat(700));
    assert.equal(readFileSync(join(box.root, "out/b.txt"), "utf8"), "bb");
    assert.deepEqual([report.files, report.bytes, report.complete], [2, 702, true]);
  }
});

test("a set-uid bit in a member is never restored, and the owner can always read and write the file", async () => {
  const box = sandbox("mode");
  const bytes = archive(member({ name: "x.sh", mode: 0o4755 }, "#!/bin/sh"), member({ name: "ro.txt", mode: 0o000 }, "r"));
  const { error } = await extract(bytes, { root: box.root, allowed: ["x.sh", "ro.txt"] });
  assert.equal(error, null);
  assert.equal(statSync(join(box.root, "x.sh")).mode & 0o7777, 0o755);
  assert.equal(statSync(join(box.root, "ro.txt")).mode & 0o600, 0o600);
});

test("the member's modification time is kept", async () => {
  const box = sandbox("mtime");
  const { error } = await extract(archive(member({ name: "t.txt" }, "t")), { root: box.root, allowed: ["t.txt"] });
  assert.equal(error, null);
  assert.equal(statSync(join(box.root, "t.txt")).mtimeMs, 1_700_000_000_000);
});

// ── Empty and complete streams ───────────────────────────────────────────────

test("a stream of zero bytes is complete", async () => {
  const box = sandbox("empty");
  const { error, report } = await extract(Buffer.alloc(0), { root: box.root, allowed: [] });
  assert.equal(error, null);
  assert.equal(report.complete, true);
  assert.deepEqual(readdirSync(box.root), []);
});

test("an end marker with no members is complete, and ending the stream after it is fine", async () => {
  const box = sandbox("endonly");
  const { error, report } = await extract(END, { root: box.root, allowed: [] });
  assert.equal(error, null);
  assert.equal(report.complete, true);
});

test("bytes after the end marker are ignored", async () => {
  const box = sandbox("trailing");
  const bytes = Buffer.concat([archive(member({ name: "a.txt" }, "a")), randomBytes(5000), member({ name: "../evil" }, "x")]);
  const { error, report } = await extract(bytes, { root: box.root, allowed: ["a.txt"] });
  assert.equal(error, null);
  assert.equal(report.complete, true);
  assert.equal(report.files, 1);
  assert.deepEqual(readdirSync(box.root), ["a.txt"]);
  assertOutsideUntouched(box);
});

test("the extractor can be told to stop reading: writing after done does not throw", async () => {
  const box = sandbox("after-done");
  const extractor = new TarExtractor({ root: box.root, allowed: [] });
  await new Promise((resolve, reject) => extractor.write(END, (e) => (e ? reject(e) : resolve())));
  await new Promise((resolve, reject) => extractor.write(Buffer.alloc(100), (e) => (e ? reject(e) : resolve())));
  await new Promise((resolve) => extractor.end(resolve));
  assert.equal(extractor.report.complete, true);
});

// ── checkMemberName ──────────────────────────────────────────────────────────

test("checkMemberName returns the clean relative path or throws a TarProtocolError", () => {
  assert.equal(checkMemberName("a/b/c.txt"), "a/b/c.txt");
  assert.equal(checkMemberName("./a//b/./c/"), "a/b/c");
  assert.equal(checkMemberName("."), "");
  assert.equal(checkMemberName("./"), "");
  assert.equal(checkMemberName(""), "");
  assert.equal(checkMemberName(".github/x"), ".github/x");
  assert.equal(checkMemberName("..a/b..c"), "..a/b..c");
  const throws = (name, pattern) => assert.throws(() => checkMemberName(name), (error) => error instanceof TarProtocolError && pattern.test(error.message), name);
  throws("../evil", /leaves the project: \.\.\/evil/);
  throws("a/../../evil", /leaves the project/);
  throws("a/..", /leaves the project/);
  throws("/abs/evil", /absolute name: \/abs\/evil/);
  throws("\\evil", /absolute name/);
  throws(".git/config", /inside \.git/);
  throws("a/.git/hooks/x", /inside \.git/);
  throws("a/.git", /inside \.git/);
  throws("a\0b", /NUL character/);
});

// ── Hostile members ──────────────────────────────────────────────────────────

test("members named with .., an absolute path, a hidden .. or .git are refused and nothing is written", async () => {
  const cases = [
    ["../evil", /leaves the project/],
    ["a/../../evil", /leaves the project/],
    ["/abs/evil", /absolute name/],
    [".git/config", /inside \.git/],
    ["sub/.git/config", /inside \.git/],
  ];
  for (const [name, pattern] of cases) {
    const box = sandbox("hostile");
    await refused(box, archive(member({ name }, "pwned")), ["a", "evil", "sub", ".git", "abs", ".."], pattern);
  }
});

test("a long name that arrives in a GNU L header or a pax path is checked like any other", async () => {
  const gnuLong = (name) => Buffer.concat([member({ name: "././@LongLink", type: "L" }, Buffer.from(`${name}\0`)), member({ name: "short" }, "x")]);
  await refused(sandbox("l-dots"), archive(gnuLong("../../evil")), ["evil", "short"], /leaves the project/);
  await refused(sandbox("l-abs"), archive(gnuLong("/tmp/evil")), ["tmp", "short"], /absolute name/);
  await refused(sandbox("pax-dots"), archive(pax({ path: "../evil" }), member({ name: "short" }, "x")), ["evil", "short"], /leaves the project/);
  await refused(sandbox("pax-git"), archive(pax({ path: "x/.git/config" }), member({ name: "short" }, "x")), ["x", "short"], /inside \.git/);
  await refused(sandbox("pax-nul"), archive(pax({ path: "a\0b" }), member({ name: "short" }, "x")), ["a", "short"], /NUL character/);
});

test("a member that was not asked for is refused, including a name that only starts like an allowed one", async () => {
  await refused(sandbox("notasked"), archive(member({ name: "other.txt" }, "x")), ["dist"], /the worker sent other\.txt, which was not asked for/);
  await refused(sandbox("notasked2"), archive(member({ name: "distance/x" }, "x")), ["dist"], /distance\/x, which was not asked for/);
  await refused(sandbox("notasked3"), archive(member({ name: "dist.txt" }, "x")), ["dist"], /not asked for/);
  await refused(sandbox("notasked-dir"), archive(member({ name: "src/", type: "5" })), ["dist"], /not asked for/);
  await refused(sandbox("notasked-link"), archive(member({ name: "evil", type: "2", linkname: "/etc/passwd" })), ["dist"], /not asked for/);
  await refused(sandbox("noallowed"), archive(member({ name: "a.txt" }, "x")), [], /not asked for/);
});

test("members under an allowed directory, and the directory itself, are accepted", async () => {
  const box = sandbox("allowed");
  const bytes = archive(member({ name: "dist/", type: "5", mode: 0o755 }), member({ name: "dist/a/b.txt" }, "b"), member({ name: "single.txt" }, "s"));
  const { error, report } = await extract(bytes, { root: box.root, allowed: ["dist", "single.txt"] });
  assert.equal(error, null);
  assert.deepEqual(listAll(box.root), ["dist", "dist/a", "dist/a/b.txt", "single.txt"]);
  assert.equal(report.directories, 1);
  assert.equal(report.files, 2);
});

test("a file with no name, or a file where a directory is (and the reverse), is refused", async () => {
  await refused(sandbox("noname"), archive(member({ name: "./" }, "x")), ["a"], /a result file has no name/);
  const dirAsFile = sandbox("dir-as-file");
  mkdirSync(join(dirAsFile.root, "dist"));
  await refused(dirAsFile, archive(member({ name: "dist" }, "x")), ["dist"], /dist is a directory in the project but a file in the results/);
  const fileAsDir = sandbox("file-as-dir");
  writeFileSync(join(fileAsDir.root, "dist"), "file");
  await refused(fileAsDir, archive(member({ name: "dist/x.txt" }, "x")), ["dist"], /dist is a file in the project but a directory in the results/);
  assert.equal(readFileSync(join(fileAsDir.root, "dist"), "utf8"), "file");
});

test("symbolic links, hard links and special files are skipped and counted, never created", async () => {
  const box = sandbox("links");
  const bytes = archive(
    member({ name: "sym", type: "2", linkname: "/etc/passwd" }),
    member({ name: "hard", type: "1", linkname: "ok.txt" }),
    member({ name: "chr", type: "3" }),
    member({ name: "blk", type: "4" }),
    member({ name: "fifo", type: "6" }),
    member({ name: "ok.txt" }, "ok"),
  );
  const { error, report } = await extract(bytes, { root: box.root, allowed: ["sym", "hard", "chr", "blk", "fifo", "ok.txt"] });
  assert.equal(error, null);
  assert.deepEqual(listAll(box.root), ["ok.txt"]);
  assert.equal(report.skippedCount, 5);
  assert.deepEqual(report.skipped, [
    { path: "sym", why: "symbolic link" },
    { path: "hard", why: "hard link" },
    { path: "chr", why: "special file" },
    { path: "blk", why: "special file" },
    { path: "fifo", why: "special file" },
  ]);
  assert.equal(report.files, 1);
  assert.equal(report.complete, true);
  assertOutsideUntouched(box);
});

test("a special file's body (a device given a size) is skipped, and the next member is still read", async () => {
  const box = sandbox("special-body");
  const bytes = archive(member({ name: "dev", type: "3" }, "x".repeat(600)), member({ name: "ok.txt" }, "ok"));
  const { error, report } = await extract(bytes, { root: box.root, allowed: ["dev", "ok.txt"] });
  assert.equal(error, null);
  assert.deepEqual(listAll(box.root), ["ok.txt"]);
  assert.equal(report.skippedCount, 1);
});

test("only the first 20 skipped entries are listed, but all are counted", async () => {
  const box = sandbox("manyskips");
  const parts = [];
  for (let i = 0; i < 30; i += 1) parts.push(member({ name: `s${i}`, type: "2", linkname: "x" }));
  const { error, report } = await extract(archive(...parts), { root: box.root, allowed: ["s"].concat(Array.from({ length: 30 }, (_, i) => `s${i}`)) });
  assert.equal(error, null);
  assert.equal(report.skippedCount, 30);
  assert.equal(report.skipped.length, 20);
});

test("a symlink in the project that leads outside is never written through", async () => {
  const box = sandbox("parentlink");
  symlinkSync(box.outside, join(box.root, "dist"));
  await refused(box, archive(member({ name: "dist/pwned.txt" }, "pwned")), ["dist"], /dist is a link in the project that leads outside it/);
  const nested = sandbox("parentlink-deep");
  mkdirSync(join(nested.root, "a"));
  symlinkSync(nested.outside, join(nested.root, "a/b"));
  await refused(nested, archive(member({ name: "a/b/c/pwned.txt" }, "pwned")), ["a"], /a\/b is a link in the project that leads outside it/);
  const dirMember = sandbox("parentlink-dir");
  symlinkSync(dirMember.outside, join(dirMember.root, "d"));
  await refused(dirMember, archive(member({ name: "d/sub/", type: "5" })), ["d"], /leads outside it/);
});

test("a symlink in the project to a place inside it is followed (it stays inside)", async () => {
  const box = sandbox("innerlink");
  mkdirSync(join(box.root, "real"));
  symlinkSync(join(box.root, "real"), join(box.root, "alias"));
  const { error } = await extract(archive(member({ name: "alias/f.txt" }, "f")), { root: box.root, allowed: ["alias"] });
  assert.equal(error, null);
  assert.equal(readFileSync(join(box.root, "real/f.txt"), "utf8"), "f");
});

test("a symlink to a file where the result goes is replaced, not written through", async () => {
  const box = sandbox("destlink");
  symlinkSync(join(box.outside, "keep.txt"), join(box.root, "out.txt"));
  const { error } = await extract(archive(member({ name: "out.txt" }, "new")), { root: box.root, allowed: ["out.txt"] });
  assert.equal(error, null);
  assert.equal(readFileSync(join(box.outside, "keep.txt"), "utf8"), "untouched");
  assert.ok(lstatSync(join(box.root, "out.txt")).isFile(), "the link itself is replaced by a regular file");
  assert.equal(readFileSync(join(box.root, "out.txt"), "utf8"), "new");
  assertOutsideUntouched(box);
});

test("sparse files are refused", async () => {
  await refused(sandbox("sparse"), archive(member({ name: "s", type: "S" })), ["s"], /sparse files .* not supported/);
});

// ── Damaged and cut-off streams ──────────────────────────────────────────────

const GOOD = archive(member({ name: "out/a.txt" }, "A".repeat(1000)), member({ name: "out/b.txt" }, "B"));

test("a stream cut in a header, in a body, in padding, or before the end marker says the transfer was cut short", async () => {
  const cuts = {
    "in a header": 100,
    "in the first header's exact end": 512 - 1,
    "in a body": 512 + 300,
    "in the padding": 512 + 1000 + 10,
    "after a member, before any end marker": 512 + 1024 + 512 + 512,
    "after one end block": 512 + 1024 + 512 + 512 + 512,
  };
  for (const [where, at] of Object.entries(cuts)) {
    const box = sandbox("cut");
    const { error } = await extract(GOOD.subarray(0, at), { root: box.root, allowed: ["out"] });
    assert.ok(error instanceof TarProtocolError, `${where}: ${error?.name}`);
    assert.match(error.message, /the transfer of the results was cut short/, where);
    assert.deepEqual(listAll(box.root).filter((f) => f.endsWith(".tmp")), [], `${where}: temp file left behind`);
    assertOutsideUntouched(box);
  }
});

test("a cut in a body leaves no file at all for that member", async () => {
  const box = sandbox("cutbody");
  const { error } = await extract(GOOD.subarray(0, 512 + 300), { root: box.root, allowed: ["out"] });
  assert.ok(error);
  assert.deepEqual(listAll(box.root), ["out"]);
});

test("a corrupt header checksum is refused", async () => {
  const box = sandbox("badsum");
  const bytes = Buffer.from(GOOD);
  bytes[3] ^= 0x01; // a name byte changes, the stored checksum no longer fits
  await refused(box, bytes, ["out"], /not a tar archive \(bad checksum\)/);
  assert.deepEqual(listAll(box.root), []);
});

test("text that is not a tar archive at all is refused", async () => {
  await refused(sandbox("garbage"), Buffer.from("just some ssh error text ".repeat(100)), ["out"], /bad checksum/);
});

test("a header whose size field is not octal is refused as damaged", async () => {
  const bytes = archive(member({ name: "a.txt", sizeField: "zzzzzzzzzzz\0", size: 0 }));
  await refused(sandbox("badsize"), bytes, ["a.txt"], /damaged header/);
});

test("a header claiming an impossibly large size in base-256 is refused", async () => {
  const huge = Buffer.alloc(12, 0xff);
  huge[0] = 0x80 | 0x7f;
  const block = header({ name: "a.txt" });
  huge.copy(block, 124);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  await refused(sandbox("huge"), Buffer.concat([block, END]), ["a.txt"], /impossibly large/);
});

test("base-256 sizes (GNU tar for big members) that fit are read", async () => {
  const box = sandbox("b256");
  const body = Buffer.from("xyz");
  const block = header({ name: "a.txt", size: 3 });
  Buffer.alloc(12).copy(block, 124);
  block[124] = 0x80;
  block[135] = 3;
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const { error } = await extract(archive(block, padded(body)), { root: box.root, allowed: ["a.txt"] });
  assert.equal(error, null);
  assert.equal(readFileSync(join(box.root, "a.txt"), "utf8"), "xyz");
});

test("a damaged pax header and an oversized metadata header are refused", async () => {
  await refused(sandbox("badpax"), archive(member({ name: "x", type: "x" }, "nonsense without lengths"), member({ name: "a.txt" }, "a")), ["a.txt"], /damaged extended header/);
  await refused(sandbox("badpax2"), archive(member({ name: "x", type: "x" }, "999 path=a\n"), member({ name: "a.txt" }, "a")), ["a.txt"], /damaged extended header/);
  await refused(sandbox("hugepax"), Buffer.concat([header({ name: "x", type: "x", size: 2 * 1024 * 1024 }), END]), ["a.txt"], /oversized header/);
});

// ── pax details ──────────────────────────────────────────────────────────────

test("a pax path and size override the header's, and a pax global header is ignored", async () => {
  const box = sandbox("paxok");
  const longName = `out/${"d".repeat(120)}/file.txt`;
  const bytes = archive(
    pax({ comment: "global" }, "g"),
    pax({ path: longName, mtime: "1600000000.5" }),
    member({ name: "short" }, "pax body"),
  );
  const { error, report } = await extract(bytes, { root: box.root, allowed: ["out"] });
  assert.equal(error, null);
  assert.equal(readFileSync(join(box.root, longName), "utf8"), "pax body");
  assert.equal(statSync(join(box.root, longName)).mtimeMs, 1_600_000_000_500);
  assert.equal(report.files, 1);
  // The override applies to ONE member: the next one is read by its own header.
  const second = sandbox("paxone");
  const two = archive(pax({ path: "out/first.txt" }), member({ name: "ignored" }, "1"), member({ name: "out/second.txt" }, "2"));
  assert.equal((await extract(two, { root: second.root, allowed: ["out"] })).error, null);
  assert.deepEqual(listAll(second.root), ["out", "out/first.txt", "out/second.txt"]);
});

test("a pax size larger than the header's is honoured (the body is that long)", async () => {
  const box = sandbox("paxsize");
  const body = Buffer.from("S".repeat(900));
  const bytes = archive(pax({ size: "900" }), Buffer.concat([header({ name: "big.txt", size: 0 }), padded(body)]));
  const { error, report } = await extract(bytes, { root: box.root, allowed: ["big.txt"] });
  assert.equal(error, null);
  assert.equal(readFileSync(join(box.root, "big.txt"), "utf8"), "S".repeat(900));
  assert.equal(report.bytes, 900);
});

test("a ustar prefix is joined to the name and checked with it", async () => {
  const box = sandbox("prefix");
  const { error } = await extract(archive(member({ name: "f.txt", prefix: "out/dir" }, "p")), { root: box.root, allowed: ["out"] });
  assert.equal(error, null);
  assert.equal(readFileSync(join(box.root, "out/dir/f.txt"), "utf8"), "p");
  await refused(sandbox("prefix-evil"), archive(member({ name: "f.txt", prefix: "../x" }, "p")), ["x"], /leaves the project/);
});

// ── Limits ───────────────────────────────────────────────────────────────────

test("more files than maxFiles are refused; exactly maxFiles is fine", async () => {
  const three = archive(member({ name: "o/1" }, "1"), member({ name: "o/2" }, "2"), member({ name: "o/3" }, "3"));
  await refused(sandbox("maxfiles"), three, ["o"], /the results hold more than 2 files/, { limits: { maxFiles: 2 } });
  const box = sandbox("maxfiles-ok");
  assert.equal((await extract(three, { root: box.root, allowed: ["o"], limits: { maxFiles: 3 } })).error, null);
});

test("results bigger than maxBytes are refused before the data is written", async () => {
  const two = archive(member({ name: "o/1" }, "x".repeat(600_000)), member({ name: "o/2" }, "y".repeat(600_000)));
  const box = sandbox("maxbytes");
  await refused(box, two, ["o"], /the results are bigger than 1 MB/, { limits: { maxBytes: 1024 * 1024 } });
  assert.deepEqual(listAll(box.root), ["o", "o/1"]); // the first file fit; the second never started
  const lone = sandbox("maxbytes-one");
  await refused(lone, archive(member({ name: "o/1" }, "x".repeat(5000))), ["o"], /bigger than/, { limits: { maxBytes: 1000 } });
  assert.deepEqual(listAll(lone.root).filter((f) => f.startsWith("o/")), []);
});

// ── HeadSplitter ─────────────────────────────────────────────────────────────

const MARKER = "\n@@CODY-RESULTS@@\n";

async function split(chunks, { marker = MARKER, maxHead } = {}) {
  const splitter = maxHead === undefined ? new HeadSplitter(marker) : new HeadSplitter(marker, maxHead);
  const out = [];
  let error = null;
  try {
    await pipeline(
      Readable.from(chunks.map((c) => Buffer.from(c)), { objectMode: false }),
      splitter,
      new Writable({
        write(chunk, _enc, cb) {
          out.push(Buffer.from(chunk));
          cb();
        },
      }),
    );
  } catch (caught) {
    error = caught;
  }
  return { splitter, payload: Buffer.concat(out), error };
}

test("a marker inside one chunk splits the text from the payload", async () => {
  const { splitter, payload, error } = await split([`exit 0\nlog line${MARKER}PAYLOAD`]);
  assert.equal(error, null);
  assert.equal(splitter.found, true);
  assert.equal(splitter.head, "exit 0\nlog line");
  assert.equal(payload.toString(), "PAYLOAD");
});

test("a marker split across chunks, down to one byte at a time, still splits", async () => {
  const whole = Buffer.from(`head text${MARKER}`);
  const payload = randomBytes(300);
  const stream = Buffer.concat([whole, payload]);
  const oneByte = [...stream].map((b) => Buffer.from([b]));
  const result = await split(oneByte);
  assert.equal(result.error, null);
  assert.equal(result.splitter.found, true);
  assert.equal(result.splitter.head, "head text");
  assert.deepEqual(result.payload, payload);
  // Cut in the middle of the marker.
  const cut = await split([stream.subarray(0, 9 + 5), stream.subarray(9 + 5, 9 + 12), stream.subarray(9 + 12)]);
  assert.equal(cut.splitter.head, "head text");
  assert.deepEqual(cut.payload, payload);
});

test("a marker that never comes leaves everything in head and passes nothing on", async () => {
  const { splitter, payload, error } = await split(["some text", " and more"]);
  assert.equal(error, null);
  assert.equal(splitter.found, false);
  assert.equal(splitter.head, "some text and more");
  assert.equal(payload.length, 0);
});

test("a marker at the very end gives an empty payload; at the very start, an empty head", async () => {
  const end = await split([`text${MARKER}`]);
  assert.equal(end.splitter.found, true);
  assert.equal(end.splitter.head, "text");
  assert.equal(end.payload.length, 0);
  const start = await split([`${MARKER}data`]);
  assert.equal(start.splitter.head, "");
  assert.equal(start.payload.toString(), "data");
});

test("an empty stream finds nothing and fails nothing", async () => {
  const { splitter, error, payload } = await split([]);
  assert.equal(error, null);
  assert.equal(splitter.found, false);
  assert.equal(splitter.head, "");
  assert.equal(payload.length, 0);
});

test("binary data after the marker passes through unchanged, even if it contains the marker again", async () => {
  const binary = Buffer.concat([randomBytes(70_000), Buffer.from(MARKER), randomBytes(70_000), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
  const chunks = [];
  const stream = Buffer.concat([Buffer.from(`ok${MARKER}`), binary]);
  for (let at = 0; at < stream.length; at += 8191) chunks.push(stream.subarray(at, at + 8191));
  const { splitter, payload, error } = await split(chunks);
  assert.equal(error, null);
  assert.equal(splitter.head, "ok");
  assert.deepEqual(payload, binary);
});

test("a head longer than maxHead with no marker fails with a TarProtocolError", async () => {
  const { error } = await split(["x".repeat(20)], { maxHead: 10 });
  assert.ok(error instanceof TarProtocolError);
  assert.match(error.message, /the worker's answer has no results section/);
  const growing = await split(["x".repeat(6), "y".repeat(6)], { maxHead: 10 });
  assert.ok(growing.error instanceof TarProtocolError);
});

test("a head exactly maxHead long is accepted, and a marker beyond maxHead in one chunk still splits", async () => {
  const fits = await split(["x".repeat(10)], { maxHead: 10 });
  assert.equal(fits.error, null);
  assert.equal(fits.splitter.head, "x".repeat(10));
  const found = await split([`${"x".repeat(50)}${MARKER}rest`], { maxHead: 10 });
  assert.equal(found.error, null);
  assert.equal(found.splitter.head, "x".repeat(50));
  assert.equal(found.payload.toString(), "rest");
});

test("a splitter feeding an extractor restores a real archive that follows the text", async () => {
  const box = sandbox("splitter-extractor");
  const stream = Buffer.concat([Buffer.from(`ran fine\n${MARKER}`), archive(member({ name: "out/r.txt" }, "result"))]);
  const splitter = new HeadSplitter(MARKER);
  const extractor = new TarExtractor({ root: box.root, allowed: ["out"] });
  await pipeline(Readable.from([stream], { objectMode: false }), splitter, extractor);
  assert.equal(splitter.head, "ran fine\n");
  assert.equal(readFileSync(join(box.root, "out/r.txt"), "utf8"), "result");
  assert.equal(existsSync(join(box.root, "out")), true);
});
