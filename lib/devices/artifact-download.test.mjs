import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { createJiti } from "jiti";

/**
 * "Download all" as the Devices panel runs it, minus the store: `exportArchive` with a stand-in for the browser's
 * Save-as picker (a writable stream that remembers what it was given and whether it was closed or discarded) and with
 * the plain-download fallback, and the browser sink's own choices. The archives are opened by Cody's reader and by the
 * real `unzip -t` and Python when those are installed.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { archiveFileName, blobFromStream, browserDownloadSink, exportArchive, openForWriting } = await jiti.import("./artifact-download.ts");
const { DeviceArtifactError } = await jiti.import("./artifact-model.ts");
const { uniqueFileNames } = await jiti.import("./artifact-names.ts");
const { openZip } = await jiti.import("./zip-archive.ts");

const MiB = 1024 * 1024;
const NOW = Date.parse("2026-10-06T18:31:12Z");
const FILE_NAME = "Lenovo-QUSB__BULK-EDL-backup-20261006-1831.zip";
const ROOT = FILE_NAME.replace(/\.zip$/, "");
const scratch = mkdtempSync(join(tmpdir(), "cody-download-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const hasTool = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status !== null;
const HAS_UNZIP = hasTool("unzip", ["-v"]);
const HAS_PYTHON = hasTool("python3", ["--version"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const within = (promise, milliseconds, what) => Promise.race([promise, sleep(milliseconds).then(() => assert.fail(`${what} did not happen within ${milliseconds} ms`))]);

const provenance = { operationId: "op-1", deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK" };

/** One stored file, as the store hands it over. */
function entry(name, bytes, extra = {}) {
  return { id: `id-${name}`, name, size: bytes.length, sha256: sha256(bytes), kind: "output", source: "device", createdAt: NOW - 60_000, provenance, blob: new Blob([bytes]), crc32: nodeCrc32(bytes), ...extra };
}

/** A stand-in for the file the picker opens: it keeps what it was given and notes whether it was finished or thrown away. */
function picker() {
  const log = { chunks: [], closed: false, aborted: false };
  const target = new WritableStream({
    write(chunk) { log.chunks.push(Buffer.from(chunk)); },
    close() { log.closed = true; },
    abort() { log.aborted = true; },
  });
  const sink = {
    async choose() { return target; },
    hand() { assert.fail("the picker was available, so the browser's own download is not used"); },
  };
  return { sink, target, log, written: () => Buffer.concat(log.chunks) };
}

/** A browser with no picker: the archive is handed over as a Blob. */
function plainDownload() {
  const handed = [];
  return { sink: { async choose() { return undefined; }, hand(blob, fileName) { handed.push({ blob, fileName }); } }, handed };
}

const exportOptions = (sink, extra = {}) => ({ sessionId: "chat-1", label: "Lenovo QUSB__BULK", fileName: FILE_NAME, sink, chosen: sink.choose(FILE_NAME), now: NOW, ...extra });

async function readArchive(bytes) {
  const zip = await openZip(new Blob([bytes]));
  const files = new Map();
  for (const item of zip.entries) files.set(item.name, { entry: item, bytes: Buffer.from(await (await zip.open(item)).arrayBuffer()) });
  return files;
}

function proveWithTools(bytes, name, files) {
  const file = join(scratch, name);
  writeFileSync(file, bytes);
  if (HAS_UNZIP) {
    const tested = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    assert.match(tested.stdout, /No errors detected/);
  }
  if (HAS_PYTHON) {
    const python = spawnSync("python3", ["-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))", file], { encoding: "utf8" });
    assert.equal(python.stdout.trim(), String(files), python.stderr);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One compressed zip, either way
// ---------------------------------------------------------------------------------------------------------------------

/** Five files with awkward names, one of them empty and one mostly zeros, and what is expected of the archive. */
function backup() {
  const names = ["edl-1a2b-set-p1-boot_a.bin", "../../etc/passwd", "same.bin", "SAME.bin", "manifest.json"];
  const contents = [randomBytes(9000), randomBytes(12), Buffer.alloc(0), Buffer.concat([randomBytes(5000), Buffer.alloc(6 * MiB)]), randomBytes(5)];
  return { entries: names.map((name, index) => entry(name, contents[index])), contents, names };
}

test("download through the picker writes ONE compressed zip with every file, the checksums and the manifest inside", async () => {
  const { entries, contents, names } = backup();
  const target = picker();
  const progress = [];
  const result = await exportArchive(entries, exportOptions(target.sink, { onProgress: (value) => progress.push(value) }));
  const bytes = target.written();

  const totalBytes = contents.reduce((total, item) => total + item.length, 0);
  assert.equal(result.method, "file-picker");
  assert.equal(result.fileName, FILE_NAME);
  assert.equal(result.files, 5);
  assert.equal(result.bytes, totalBytes);
  assert.equal(result.archiveBytes, bytes.length, "archiveBytes is what was written to the file");
  assert.ok(result.archiveBytes < totalBytes / 20, `${totalBytes} bytes of mostly zeros packed to ${result.archiveBytes}`);
  assert.equal(target.log.closed, true, "the chosen file was finished");
  assert.equal(target.log.aborted, false);

  const files = await readArchive(bytes);
  const safe = uniqueFileNames(names);
  assert.deepEqual([...files.keys()], [...safe.map((name) => `${ROOT}/${name}`), `${ROOT}/SHA256SUMS`, `${ROOT}/manifest.json`], "the files in the order given, then the checksums, then the manifest, all in one folder");
  assert.ok([...files.keys()].every((name) => name.startsWith(`${ROOT}/`) && !name.slice(ROOT.length + 1).includes("/")), "one folder, no path inside it");
  assert.ok(safe.includes("file-manifest.json"), "an artifact called manifest.json cannot take the manifest's place");
  assert.equal(new Set(safe.map((name) => name.toLowerCase())).size, 5, "SAME.bin and same.bin are told apart");
  for (const [index, name] of safe.entries()) {
    const file = files.get(`${ROOT}/${name}`);
    assert.ok(contents[index].equals(file.bytes), `${names[index]} is in the archive, byte for byte`);
    assert.equal(file.entry.method, contents[index].length === 0 ? 0 : 8, `${name}: deflated, except for the empty one`);
  }
  assert.equal(files.get(`${ROOT}/SHA256SUMS`).entry.method, 0, "the checksums are stored, readable without inflating");
  assert.equal(files.get(`${ROOT}/manifest.json`).entry.method, 0);

  const manifest = JSON.parse(files.get(`${ROOT}/manifest.json`).bytes.toString("utf8"));
  assert.equal(manifest.format, "cody-device-artifacts/2");
  assert.equal(manifest.compression, "deflate");
  assert.equal(manifest.createdAt, new Date(NOW).toISOString());
  assert.equal(manifest.label, "Lenovo QUSB__BULK");
  assert.equal(manifest.sessionId, "chat-1");
  assert.equal(manifest.totalBytes, totalBytes);
  assert.deepEqual(manifest.files.map((file) => [file.name, file.path, file.size, file.sha256]), names.map((name, index) => [name, safe[index], contents[index].length, sha256(contents[index])]));
  assert.equal(manifest.files[0].operation.deviceLabel, "Lenovo QUSB__BULK");
  assert.equal(manifest.files[0].artifactId, "id-edl-1a2b-set-p1-boot_a.bin");
  const sums = files.get(`${ROOT}/SHA256SUMS`).bytes.toString("utf8").trim().split("\n");
  assert.equal(sums.length, 6, "every file and the manifest");
  assert.equal(sums.at(-1), `${sha256(files.get(`${ROOT}/manifest.json`).bytes)}  manifest.json`);
  for (const [index, line] of sums.slice(0, 5).entries()) assert.equal(line, `${sha256(contents[index])}  ${safe[index]}`);

  assert.ok(progress.length >= 3);
  assert.ok(progress.every((value) => value.phase === "writing" && value.total === 5 && value.totalBytes === totalBytes));
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index].done >= progress[index - 1].done && progress[index].bytes >= progress[index - 1].bytes, "progress only moves forward");
  }
  assert.ok(progress.every((value) => value.done <= 5 && value.bytes <= totalBytes), "the checksums and the manifest are not counted as the person's files");
  assert.deepEqual(progress.at(-1), { phase: "writing", done: 5, total: 5, bytes: totalBytes, totalBytes });
  assert.ok(progress.some((value) => value.bytes > 0 && value.bytes < totalBytes), "it reports while a long file is read, not only at the ends");

  proveWithTools(bytes, "picker.zip", 7);
});

test("where the browser has no picker the same archive is handed over as ONE Blob", async () => {
  const { entries, contents } = backup();
  const viaPicker = picker();
  const picked = await exportArchive(entries, exportOptions(viaPicker.sink));

  const plain = plainDownload();
  const progress = [];
  const result = await exportArchive(entries.map((item, index) => ({ ...item, blob: new Blob([contents[index]]) })), exportOptions(plain.sink, { onProgress: (value) => progress.push(value) }));
  assert.equal(result.method, "browser-download");
  assert.equal(result.fileName, FILE_NAME);
  assert.equal(plain.handed.length, 1, "handed over once");
  assert.equal(plain.handed[0].fileName, FILE_NAME);
  const { blob } = plain.handed[0];
  assert.equal(blob.type, "application/zip");
  assert.equal(result.archiveBytes, blob.size, "archiveBytes is the Blob's size");
  assert.equal(result.bytes, contents.reduce((total, item) => total + item.length, 0));
  assert.ok(result.archiveBytes < result.bytes / 20);
  assert.ok(Buffer.from(await blob.arrayBuffer()).equals(viaPicker.written()), "the same bytes the picker would have received");
  assert.equal(picked.archiveBytes, result.archiveBytes);
  assert.deepEqual(progress.at(-1), { phase: "writing", done: 5, total: 5, bytes: result.bytes, totalBytes: result.bytes });
  proveWithTools(Buffer.from(await blob.arrayBuffer()), "blob.zip", 7);
});

test("a backup of many small files and a few big ones is one zip, however the browser takes it", async () => {
  const contents = [...Array.from({ length: 40 }, (_, index) => randomBytes(100 + index)), Buffer.alloc(8 * MiB, 7), randomBytes(2 * MiB)];
  const entries = contents.map((bytes, index) => entry(`part-${index}.bin`, bytes));
  const plain = plainDownload();
  const result = await exportArchive(entries, exportOptions(plain.sink));
  assert.equal(result.files, 42);
  const files = await readArchive(Buffer.from(await plain.handed[0].blob.arrayBuffer()));
  assert.equal(files.size, 44);
  for (const [index, bytes] of contents.entries()) assert.ok(bytes.equals(files.get(`${ROOT}/part-${index}.bin`).bytes), `part-${index}.bin`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Cancelling and failing
// ---------------------------------------------------------------------------------------------------------------------

test("closing the picker is a cancel: nothing is read, written or handed over", async () => {
  const closed = { async choose() { throw new DeviceArtifactError("Saving the archive was cancelled.", "aborted"); }, hand() { assert.fail("not handed"); } };
  const bytes = randomBytes(1000);
  let reads = 0;
  const blob = new Blob([bytes]);
  const stream = blob.stream.bind(blob);
  blob.stream = () => { reads += 1; return stream(); };
  const chosen = closed.choose();
  chosen.catch(() => undefined);
  const progress = [];
  await assert.rejects(exportArchive([entry("a.bin", bytes, { blob })], { sessionId: "s", label: "x", fileName: FILE_NAME, sink: closed, chosen, now: NOW, onProgress: (value) => progress.push(value) }), (error) => error instanceof DeviceArtifactError && error.code === "aborted");
  assert.equal(reads, 0, "no file was read");
  assert.deepEqual(progress, []);
});

test("a signal that is already aborted writes nothing and discards the chosen file", async () => {
  const target = picker();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exportArchive([entry("a.bin", randomBytes(1000))], exportOptions(target.sink, { signal: controller.signal })), (error) => error.code === "aborted");
  assert.equal(target.log.chunks.length, 0);
  assert.equal(target.log.closed, false);
  assert.equal(target.log.aborted, true, "the file the person chose is not left half-open");
});

test("a download cancelled while its sink is stuck in a write ends as cancelled at once, and the file is discarded", async () => {
  const gate = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const log = { closed: false, aborted: false };
  const target = new WritableStream({
    async write() { reached.resolve(); await gate.promise; },
    close() { log.closed = true; },
    abort() { log.aborted = true; },
  });
  const sink = { async choose() { return target; }, hand() { assert.fail("not handed"); } };
  const controller = new AbortController();
  const outcome = exportArchive([entry("big.bin", randomBytes(2 * MiB))], exportOptions(sink, { signal: controller.signal })).then(() => undefined, (error) => error);
  await reached.promise;
  controller.abort();
  const error = await within(outcome, 3000, "the cancel");
  assert.ok(error instanceof DeviceArtifactError && error.code === "aborted", `${error}`);
  gate.resolve();
  await within((async () => { while (!log.aborted) await sleep(10); })(), 3000, "discarding the file");
  assert.equal(log.closed, false, "a cancelled download is never finished");
});

test("a cancel while the archive is built for the plain download hands nothing over", async () => {
  const plain = plainDownload();
  const controller = new AbortController();
  const progress = [];
  const entries = [entry("a.bin", randomBytes(4 * MiB)), entry("b.bin", randomBytes(4 * MiB))];
  await assert.rejects(
    exportArchive(entries, exportOptions(plain.sink, { signal: controller.signal, onProgress: (value) => { progress.push(value); if (value.bytes >= MiB) controller.abort(); } })),
    (error) => error instanceof DeviceArtifactError && error.code === "aborted",
  );
  assert.equal(plain.handed.length, 0);
  assert.ok(progress.at(-1).bytes < 8 * MiB, "the reading stopped");
});

test("a stored copy that no longer matches its checksum stops the write, names the file, and discards the half-written file", async () => {
  const good = randomBytes(700 * 1024);
  const bad = randomBytes(5000);
  const target = picker();
  const entries = [entry("good.bin", good), entry("bad.bin", bad, { crc32: (nodeCrc32(bad) ^ 1) >>> 0 })];
  await assert.rejects(exportArchive(entries, exportOptions(target.sink)), (error) => {
    assert.ok(error instanceof DeviceArtifactError);
    assert.equal(error.code, "hash-mismatch");
    assert.match(error.message, new RegExp(`"${ROOT}/bad\\.bin" no longer matches the checksum recorded for it.*may be damaged`));
    return true;
  });
  assert.ok(target.log.chunks.length > 0, "the first file had already gone into the chosen file");
  assert.equal(target.log.aborted, true, "so the half-written file is thrown away");
  assert.equal(target.log.closed, false, "never finished");
  if (HAS_PYTHON) {
    const file = join(scratch, "half.zip");
    writeFileSync(file, target.written());
    assert.equal(spawnSync("python3", ["-c", "import sys, zipfile; sys.exit(3 if zipfile.is_zipfile(sys.argv[1]) else 0)", file]).status, 0, "what was written is not mistaken for a zip");
  }

  const nothing = picker();
  await assert.rejects(exportArchive([entry("bad.bin", bad, { crc32: (nodeCrc32(bad) ^ 1) >>> 0 })], exportOptions(nothing.sink)), (error) => error.code === "hash-mismatch");
  assert.equal(nothing.log.aborted, true, "the file is discarded even when nothing had been written to it");
});

test("a file that is not the size it was saved with stops the write", async () => {
  const bytes = randomBytes(3000);
  for (const size of [2999, 3001]) {
    const target = picker();
    await assert.rejects(exportArchive([entry("a.bin", bytes, { size })], exportOptions(target.sink)), (error) => error.code === "hash-mismatch" && /changed while the archive was being written/.test(error.message));
    assert.equal(target.log.aborted, true);
  }
  const plain = plainDownload();
  await assert.rejects(exportArchive([entry("a.bin", bytes, { size: 2999 })], exportOptions(plain.sink)), (error) => error.code === "hash-mismatch");
  assert.equal(plain.handed.length, 0, "nothing is handed over for an archive that was not finished");
});

test("a sink that fails to write says so in plain words", async () => {
  const sink = { async choose() { return new WritableStream({ write() { throw new Error("the disk is full"); } }); }, hand() { assert.fail("not handed"); } };
  await assert.rejects(exportArchive([entry("a.bin", randomBytes(2000))], exportOptions(sink)), (error) => error.code === "unknown" && error.message === "The archive could not be written: the disk is full");
});

test("downloading nothing says so", async () => {
  const plain = plainDownload();
  await assert.rejects(exportArchive([], exportOptions(plain.sink)), (error) => error.code === "not-found" && /nothing to download/.test(error.message));
  assert.equal(plain.handed.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------------------------------------------------

test("archive names are the label, the day and the minute, in the person's own clock", () => {
  const moment = new Date(NOW);
  const pad = (value) => String(value).padStart(2, "0");
  assert.equal(archiveFileName("Lenovo QUSB__BULK EDL backup", NOW), `Lenovo-QUSB__BULK-EDL-backup-${moment.getFullYear()}${pad(moment.getMonth() + 1)}${pad(moment.getDate())}-${pad(moment.getHours())}${pad(moment.getMinutes())}.zip`);
  assert.match(archiveFileName("???", NOW), /^artifacts-\d{8}-\d{4}\.zip$/);
});

test("chunks are folded into the Blob without losing their order or a byte, however the folds fall", async () => {
  const chunks = Array.from({ length: 10 }, (_, index) => Buffer.alloc(7, 65 + index));
  const expected = Buffer.concat(chunks);
  for (const fold of [1, 7, 20, 22, 69, 70, 1000]) {
    const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const blob = await blobFromStream(stream, fold);
    assert.ok(Buffer.from(await blob.arrayBuffer()).equals(expected), `fold every ${fold} bytes`);
    assert.equal(blob.type, "application/zip");
  }
  const empty = await blobFromStream(new ReadableStream({ start(controller) { controller.close(); } }));
  assert.equal(empty.size, 0);
  await assert.rejects(blobFromStream(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("x")); controller.error(new Error("broken")); } })), /broken/);
});

test("the browser sink offers a Save-as picker, reads a closed picker as a cancel and a blocked one as 'use the plain download'", async () => {
  const hadWindow = "window" in globalThis;
  const saved = globalThis.window;
  try {
    delete globalThis.window;
    assert.equal(await browserDownloadSink.choose("a.zip"), undefined, "not a page at all");

    const writable = new WritableStream();
    let asked;
    globalThis.window = { showSaveFilePicker: async (options) => { asked = options; return { createWritable: async () => writable }; } };
    assert.equal(await browserDownloadSink.choose("backup.zip"), writable);
    assert.equal(asked.suggestedName, "backup.zip");
    assert.deepEqual(asked.types, [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }]);

    globalThis.window = { showSaveFilePicker: async () => { throw new DOMException("The user aborted a request.", "AbortError"); } };
    await assert.rejects(browserDownloadSink.choose("backup.zip"), (error) => error instanceof DeviceArtifactError && error.code === "aborted");

    globalThis.window = { showSaveFilePicker: async () => { throw new DOMException("Not allowed here.", "SecurityError"); } };
    assert.equal(await browserDownloadSink.choose("backup.zip"), undefined, "blocked: the browser's own download still works");

    globalThis.window = {};
    assert.equal(await browserDownloadSink.choose("backup.zip"), undefined, "no picker in this browser");
  } finally {
    if (hadWindow) globalThis.window = saved;
    else delete globalThis.window;
  }
});

test("a file the picker gave but that cannot be opened for writing is reported and removed, never replaced by a second copy through the browser's download", async () => {
  let removed = 0;
  const refusing = { createWritable: async () => { throw new DOMException("The file is locked by another program.", "NoModificationAllowedError"); }, remove: async () => { removed += 1; } };
  await assert.rejects(openForWriting(refusing), (error) => error instanceof DeviceArtifactError && /cannot be written to \(The file is locked by another program\.\)/.test(error.message));
  assert.equal(removed, 1, "the empty file the picker created is removed where the browser allows");
  const stubborn = { createWritable: async () => { throw new Error("no"); }, remove: async () => { throw new Error("cannot remove either"); } };
  await assert.rejects(openForWriting(stubborn), (error) => error instanceof DeviceArtifactError, "a remove that fails changes nothing about the answer");
  const plain = { createWritable: async () => "a stream" };
  assert.equal(await openForWriting(plain), "a stream", "a handle without remove, or one that opens, is just opened");
});
