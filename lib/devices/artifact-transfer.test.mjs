import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";
import { setupFakeServer } from "./artifact-vault.test-helper.mjs";

/**
 * "Download all" and "Save to server" through the store, as the Devices panel and an agent call them: the real
 * uploader against the real vault handlers (with the faults a network produces), and the real zip writer into a
 * stand-in for the browser's file picker.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceArtifactError, DeviceArtifactStore } = await jiti.import("./artifacts.ts");
const { openZip } = await jiti.import("./zip-archive.ts");
const { UPLOAD_SLICE_BYTES } = await jiti.import("./artifact-upload.ts");
const server = await setupFakeServer();

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const NEVER_WAIT = [0, 0, 0];

function newStore(fake, sink) {
  const store = new DeviceArtifactStore({ fetch: fake?.fetch, sink, retryDelaysMs: NEVER_WAIT });
  const rows = new Map();
  store.persistence = {
    async put(sessionId, artifact) { rows.set(`${sessionId}:${artifact.id}`, { sessionId, artifact }); },
    async get(sessionId, id) { return rows.get(`${sessionId}:${id}`)?.artifact; },
    async list(sessionId) { return [...rows.values()].filter((row) => row.sessionId === sessionId).map((row) => row.artifact); },
    async delete(sessionId, id) { rows.delete(`${sessionId}:${id}`); },
  };
  return store;
}

const provenance = (operationId = "op-1") => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK" });

/** Saves outputs of one operation and returns what was saved: the file contents and the set they form. */
async function backup(store, sessionId, sizes, names) {
  const contents = [];
  for (const [index, size] of sizes.entries()) {
    const bytes = randomBytes(size);
    contents.push(bytes);
    await store.save(sessionId, names?.[index] ?? `edl-1a2b-set-p${index}-part${index}.bin`, new Blob([bytes]), provenance());
    // Files made in the same millisecond have no order; real ones are seconds apart.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const [set] = store.sets(sessionId);
  return { contents, set, ids: set.artifactIds };
}

function pickerInto(chunks) {
  return {
    async choose() {
      return new WritableStream({ write(chunk) { chunks.push(Buffer.from(chunk)); } });
    },
    hand() { assert.fail("the picker was available, so the browser's own download is not used"); },
  };
}

function downloadInto(handed) {
  return { async choose() { return undefined; }, hand(blob, fileName) { handed.push({ blob, fileName }); } };
}

async function readArchive(blob) {
  const archive = await openZip(blob);
  const files = new Map();
  for (const entry of archive.entries) files.set(entry.name, { entry, bytes: Buffer.from(await (await archive.open(entry)).arrayBuffer()) });
  return files;
}

// ---------------------------------------------------------------------------------------------------------------------
// Save to server
// ---------------------------------------------------------------------------------------------------------------------

test("saving a set uploads every file in slices, has the server re-check each one, and the set then shows as saved", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { contents, set, ids } = await backup(store, "chat-1", [UPLOAD_SLICE_BYTES * 2 + 123, 0, 5000]);
  const seen = [];
  const listed = [];
  store.subscribe("chat-1", (artifacts) => listed.push(artifacts.filter((artifact) => artifact.server).length));

  const result = await store.saveSetToServer("chat-1", set.id, { onProgress: (progress) => seen.push(progress) });

  assert.equal(result.files, 3);
  assert.equal(result.bytes, UPLOAD_SLICE_BYTES * 2 + 123 + 5000);
  assert.equal(result.verified, true);
  assert.equal(result.resumed, false);
  assert.match(result.path, /2026-\d\d-\d\d-Lenovo-QUSB__BULK-EDL-backup$|-Lenovo-QUSB__BULK-EDL-backup$/);
  assert.equal(result.manifestPath, join(result.path, "manifest.json"));
  for (const [index, name] of ["edl-1a2b-set-p0-part0.bin", "edl-1a2b-set-p1-part1.bin", "edl-1a2b-set-p2-part2.bin"].entries()) {
    assert.equal(sha256(readFileSync(join(result.path, name))), sha256(contents[index]), name);
  }
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.sessionId, "chat-1");
  assert.deepEqual(manifest.files[0].operation, { id: "op-1", deviceId: "usb-1", protocol: "edl", action: "exec", deviceLabel: "Lenovo QUSB__BULK", command: "backup" });

  assert.deepEqual(fake.log.filter((request) => request.method === "PUT").map((request) => request.search).slice(0, 3), ["?file=0&offset=0", `?file=0&offset=${UPLOAD_SLICE_BYTES}`, `?file=0&offset=${UPLOAD_SLICE_BYTES * 2}`], "a 4 MiB slice at a time");
  assert.ok(seen.some((progress) => progress.phase === "uploading") && seen.some((progress) => progress.phase === "verifying"));
  assert.deepEqual(seen.at(-1), { phase: "verifying", done: 3, total: 3, bytes: result.bytes, totalBytes: result.bytes });
  assert.ok(seen.every((progress, index) => index === 0 || progress.bytes >= seen[index - 1].bytes), "progress never goes backwards");

  const state = store.getSetSaveState("chat-1", set.id);
  assert.equal(state.state, "saved");
  assert.equal(state.path, result.path);
  assert.equal(state.verified, true);
  assert.equal(state.files, 3);
  assert.ok(store.list("chat-1").every((artifact) => artifact.server?.folder === result.path && artifact.server.verified), "each file now says where its copy is");
  assert.ok(listed.at(-1) === 3, "subscribers hear that the server copies changed");
  assert.deepEqual(ids.length, 3);
});

test("a transfer is listed for the whole session, with its progress, its result and who started it", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { set } = await backup(store, "chat-jobs", [3000, 4000]);
  const snapshots = [];
  const unsubscribe = store.subscribeJobs("chat-jobs", (jobs) => snapshots.push(jobs));
  assert.deepEqual(snapshots[0], [], "a listener is told the current list at once");

  const { jobId, begun, finished } = store.startServerSave("chat-jobs", set.artifactIds, { label: "Lenovo backup", setId: set.id, origin: "agent" });
  const learned = await begun;
  assert.equal(learned.files, 2);
  assert.equal(learned.alreadySaved, false);
  assert.ok(learned.folder.endsWith("-Lenovo-backup"));
  const running = store.jobs("chat-jobs").find((job) => job.id === jobId);
  assert.equal(running.origin, "agent");
  assert.equal(running.kind, "save");
  assert.equal(running.setId, set.id);
  assert.deepEqual(running.artifactIds, set.artifactIds);
  assert.equal(running.label, "Lenovo backup");

  const result = await finished;
  const done = store.jobs("chat-jobs").find((job) => job.id === jobId);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.result, result);
  assert.ok(done.endedAt >= done.startedAt);
  assert.equal(snapshots.at(-1).at(-1).state, "succeeded");
  assert.ok(snapshots.every((jobs) => Object.isFrozen(jobs) === false), "each notification is a fresh array");
  unsubscribe();
});

test("only the latest 20 finished transfers are kept listed, and a running one never drops off", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  await store.save("chat-cap", "a.bin", new Blob(["a"]), provenance());
  const [set] = store.sets("chat-cap");
  const first = await store.saveSetToServer("chat-cap", set.id);
  assert.equal(first.alreadySaved, undefined);
  for (let index = 0; index < 24; index += 1) assert.equal((await store.saveSetToServer("chat-cap", set.id)).alreadySaved, true);
  const jobs = store.jobs("chat-cap");
  assert.equal(jobs.length, 20);
  assert.ok(jobs.every((job) => job.state === "succeeded"));
  assert.ok(jobs.every((job, index) => index === 0 || job.startedAt >= jobs[index - 1].startedAt), "newest last");
});

test("saving the same files again finds them already on the server and sends nothing", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { set } = await backup(store, "chat-again", [6000, 7000]);
  const first = await store.saveSetToServer("chat-again", set.id);
  const puts = fake.log.filter((request) => request.method === "PUT").length;
  const second = await store.saveSetToServer("chat-again", set.id);
  assert.equal(second.alreadySaved, true);
  assert.equal(second.path, first.path);
  assert.equal(second.verified, true);
  assert.equal(fake.log.filter((request) => request.method === "PUT").length, puts, "no byte was sent the second time");
  assert.equal(readdirSync(fake.config.root).filter((name) => !name.startsWith(".")).length, 1, "and no second folder was made");
});

test("cancelling stops the upload and keeps what arrived, and saving again carries on from there", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { contents, set } = await backup(store, "chat-resume", [UPLOAD_SLICE_BYTES * 3]);
  const controller = new AbortController();
  let slices = 0;
  await assert.rejects(
    store.saveSetToServer("chat-resume", set.id, { signal: controller.signal, onProgress: (progress) => { if (progress.phase === "uploading" && progress.bytes >= UPLOAD_SLICE_BYTES && ++slices === 1) controller.abort(); } }),
    (error) => error instanceof DeviceArtifactError && error.code === "aborted" && /already arrived is kept/.test(error.message),
  );
  const job = store.jobs("chat-resume").at(-1);
  assert.equal(job.state, "cancelled");
  assert.equal(job.error, undefined, "a cancel is not a failure");
  assert.equal(store.getSetSaveState("chat-resume", set.id).state, "none");

  const before = fake.log.filter((request) => request.method === "PUT").length;
  const result = await store.saveSetToServer("chat-resume", set.id);
  assert.equal(result.resumed, true);
  const resumedOffsets = fake.log.filter((request) => request.method === "PUT").slice(before).map((request) => Number(/offset=(\d+)/.exec(request.search)[1]));
  assert.ok(resumedOffsets[0] > 0, `it carried on from ${resumedOffsets[0]}, not from the start`);
  assert.equal(sha256(readFileSync(join(result.path, "edl-1a2b-set-p0-part0.bin"))), sha256(contents[0]));
});

test("a dropped connection is retried, and so is an answer that never arrived, without duplicating or skipping a byte", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { contents, set } = await backup(store, "chat-flaky", [UPLOAD_SLICE_BYTES + 500]);
  fake.faults.network = 2;
  const result = await store.saveSetToServer("chat-flaky", set.id);
  assert.equal(result.verified, true);
  assert.equal(sha256(readFileSync(join(result.path, "edl-1a2b-set-p0-part0.bin"))), sha256(contents[0]));

  const lost = server.fakeServer();
  const lostStore = newStore(lost);
  const second = await backup(lostStore, "chat-lost", [UPLOAD_SLICE_BYTES + 500]);
  lost.faults.lostAnswers = 3;
  const finished = await lostStore.saveSetToServer("chat-lost", second.set.id);
  assert.equal(sha256(readFileSync(join(finished.path, "edl-1a2b-set-p0-part0.bin"))), sha256(second.contents[0]), "the slice whose answer was lost was not sent twice");
});

test("a file that arrives damaged is caught on the server's disk and sent again once; twice damaged is reported", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { contents, set } = await backup(store, "chat-damage", [8000]);
  fake.faults.corrupt = 1;
  const result = await store.saveSetToServer("chat-damage", set.id);
  assert.equal(sha256(readFileSync(join(result.path, "edl-1a2b-set-p0-part0.bin"))), sha256(contents[0]));
  assert.equal(fake.log.filter((request) => request.method === "PUT").length, 2, "the whole file was sent a second time");

  const bad = server.fakeServer();
  const badStore = newStore(bad);
  const second = await backup(badStore, "chat-damage-2", [8000]);
  bad.faults.corrupt = 2;
  await assert.rejects(badStore.saveSetToServer("chat-damage-2", second.set.id), (error) => error.code === "hash-mismatch" && /damaged/.test(error.message));
  assert.equal(badStore.jobs("chat-damage-2").at(-1).error.code, "hash-mismatch");
  assert.equal(badStore.getSetSaveState("chat-damage-2", second.set.id).state, "none");
});

test("what the server says is carried into an error code and a message that can be shown as it is", async () => {
  const cases = [
    [{ status: 401, code: "auth_required" }, "unauthorized", /no longer accepts this browser's sign-in/],
    [{ status: 403, code: "access_denied", error: "That chat belongs to another account." }, "unauthorized", /another account/],
    [{ status: 413, code: "too_large", error: "These files total too much." }, "too-large", /total too much/],
    [{ status: 507, code: "disk_full", error: "The server has 2 MB free." }, "disk-full", /2 MB free/],
    [{ status: 400, code: "invalid_request", error: "Nope." }, "server-refused", /Nope/],
  ];
  for (const [forced, code, message] of cases) {
    const fake = server.fakeServer();
    const store = newStore(fake);
    await store.save("chat-errors", "a.bin", new Blob(["a"]), provenance());
    const [set] = store.sets("chat-errors");
    fake.faults.status.push(forced);
    await assert.rejects(store.saveSetToServer("chat-errors", set.id), (error) => error instanceof DeviceArtifactError && error.code === code && message.test(error.message), JSON.stringify(forced));
    assert.equal(store.jobs("chat-errors").at(-1).state, "failed");
  }

  const down = server.fakeServer();
  const store = newStore(down);
  await store.save("chat-down", "a.bin", new Blob(["a"]), provenance());
  const [set] = store.sets("chat-down");
  down.faults.network = 99;
  await assert.rejects(store.saveSetToServer("chat-down", set.id), (error) => error.code === "unreachable" && /Could not reach the Cody server/.test(error.message) && /what already arrived is kept/.test(error.message));
});

test("which files the server holds is asked for, survives an unreachable server, and disappears with the server's copy", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { set } = await backup(store, "chat-refresh", [4000, 4001]);
  const result = await store.saveSetToServer("chat-refresh", set.id);
  assert.equal(store.getSetSaveState("chat-refresh", set.id).state, "saved");

  fake.faults.network = 1;
  await store.refreshServerCopies("chat-refresh");
  assert.equal(store.getSetSaveState("chat-refresh", set.id).state, "saved", "an unreachable server clears nothing");

  const { saveId } = (await (await fake.fetch("/api/devices/artifacts/saves?sessionId=chat-refresh")).json()).saves[0];
  assert.equal((await fake.fetch(`/api/devices/artifacts/saves/${saveId}`, { method: "DELETE" })).status, 200);
  assert.equal(existsSync(result.path), false);
  await store.refreshServerCopies("chat-refresh");
  assert.equal(store.getSetSaveState("chat-refresh", set.id).state, "none");
});

test("removing a set stops a save of it that is still running", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { set } = await backup(store, "chat-stop", [UPLOAD_SLICE_BYTES * 2]);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const slow = async (input, init) => {
    if ((init?.method ?? "GET") === "PUT") {
      started.resolve();
      await release.promise;
    }
    return fake.fetch(input, init);
  };
  const stalled = new DeviceArtifactStore({ fetch: slow, retryDelaysMs: NEVER_WAIT });
  stalled.persistence = store.persistence;
  for (const artifact of await store.persistence.list("chat-stop")) stalled.entries("chat-stop").set(artifact.id, artifact);
  const saving = stalled.saveSetToServer("chat-stop", stalled.sets("chat-stop")[0].id);
  const outcome = assert.rejects(saving, (error) => error.code === "aborted");
  await started.promise;
  assert.equal(await stalled.removeSet("chat-stop", stalled.sets("chat-stop")[0].id), 1);
  release.resolve();
  await outcome;
  assert.equal(stalled.jobs("chat-stop").at(-1).state, "cancelled");
  assert.deepEqual(stalled.list("chat-stop"), []);
  assert.ok(set.id);
});

// ---------------------------------------------------------------------------------------------------------------------
// Download all
// ---------------------------------------------------------------------------------------------------------------------

test("download all writes one zip through the picker, every file stored whole, with the checksums and the manifest inside", async () => {
  const chunks = [];
  const store = newStore(undefined, pickerInto(chunks));
  const hostile = ["edl-1a2b-set-p1-boot_a.bin", "../../etc/passwd", "same.bin", "SAME.bin", "manifest.json"];
  const { contents, set } = await backup(store, "chat-zip", [9000, 12, 0, 70_000, 5], hostile);
  const progress = [];
  const result = await store.downloadSet("chat-zip", set.id, { onProgress: (value) => progress.push(value) });

  assert.equal(result.method, "file-picker");
  assert.equal(result.files, 5);
  assert.equal(result.bytes, 9000 + 12 + 70_000 + 5);
  assert.match(result.fileName, /^Lenovo-QUSB__BULK-EDL-backup-\d{8}-\d{4}\.zip$/);

  const archive = Buffer.concat(chunks);
  const files = await readArchive(new Blob([archive]));
  const root = result.fileName.replace(/\.zip$/, "");
  const names = [...files.keys()];
  assert.ok(names.every((name) => name.startsWith(`${root}/`) && !name.slice(root.length + 1).includes("/")), "one folder, no path inside it");
  const stored = names.filter((name) => !/\/(SHA256SUMS|manifest\.json)$/.test(name) || /file-manifest/.test(name));
  assert.equal(stored.length, 5);
  for (const [index, name] of set.artifactIds.entries()) {
    const artifact = store.list("chat-zip").find((candidate) => candidate.id === name);
    const entry = [...files.entries()].find(([entryName, candidate]) => !/\/(SHA256SUMS|manifest\.json)$/.test(entryName) && sha256(candidate.bytes) === artifact.sha256 && candidate.bytes.length === artifact.size)?.[1];
    assert.ok(entry, `${artifact.name} is in the archive, byte for byte`);
    assert.equal(entry.entry.method, 0, "stored, not compressed");
    assert.ok(contents[index].equals(entry.bytes));
  }
  assert.ok(files.has(`${root}/file-manifest.json`), "an artifact called manifest.json cannot take the manifest's place");

  const manifest = JSON.parse(files.get(`${root}/manifest.json`).bytes.toString("utf8"));
  assert.equal(manifest.format, "cody-device-artifacts/1");
  assert.equal(manifest.files.length, 5);
  assert.equal(manifest.files[0].operation.deviceLabel, "Lenovo QUSB__BULK");
  const sums = files.get(`${root}/SHA256SUMS`).bytes.toString("utf8").trim().split("\n");
  assert.equal(sums.length, 6, "every file and the manifest");
  assert.ok(sums.includes(`${sha256(files.get(`${root}/manifest.json`).bytes)}  manifest.json`));
  for (const line of sums) {
    const [hash, name] = line.split("  ");
    assert.equal(sha256(files.get(`${root}/${name}`).bytes), hash, name);
  }

  assert.deepEqual(progress.at(-1), { phase: "writing", done: 5, total: 5, bytes: result.bytes, totalBytes: result.bytes });
  assert.equal(store.jobs("chat-zip").at(-1).state, "succeeded");
  assert.equal(store.jobs("chat-zip").at(-1).kind, "download");
  assert.equal(store.jobs("chat-zip").at(-1).setId, set.id);
});

test("the archive is one unzip -t and Python accept", { skip: spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === null || spawnSync("python3", ["--version"], { stdio: "ignore" }).status === null }, async () => {
  const chunks = [];
  const store = newStore(undefined, pickerInto(chunks));
  const { set } = await backup(store, "chat-unzip", [3 * 1024 * 1024 + 7, 100, 0]);
  const result = await store.downloadSet("chat-unzip", set.id);
  const file = join(mkdtempSync(join(tmpdir(), "cody-zip-")), result.fileName);
  writeFileSync(file, Buffer.concat(chunks));
  const tested = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
  assert.equal(tested.status, 0, tested.stdout + tested.stderr);
  assert.match(tested.stdout, /No errors detected/);
  const python = spawnSync("python3", ["-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))", file], { encoding: "utf8" });
  assert.equal(python.stdout.trim(), "5", python.stderr);
});

test("where the browser has no picker the archive is handed over whole, as one lazy Blob of the stored files", async () => {
  const handed = [];
  const store = newStore(undefined, downloadInto(handed));
  const { set, contents } = await backup(store, "chat-hand", [5000, 6000]);
  const result = await store.downloadArtifacts("chat-hand", set.artifactIds, { label: "My backup", archiveName: "my-backup.zip" });
  assert.equal(result.method, "browser-download");
  assert.equal(result.fileName, "my-backup.zip");
  assert.equal(handed.length, 1);
  assert.equal(handed[0].fileName, "my-backup.zip");
  const files = await readArchive(handed[0].blob);
  assert.ok([...files.values()].some((file) => file.bytes.equals(contents[0])));
  assert.ok([...files.values()].some((file) => file.bytes.equals(contents[1])));
});

test("a backup saved before checksums were recorded is read once for its CRC, shown as 'checking', and remembered", async () => {
  const chunks = [];
  const store = newStore(undefined, pickerInto(chunks));
  const { set, contents } = await backup(store, "chat-legacy", [30_000, 20_000]);
  for (const id of set.artifactIds) delete store.entries("chat-legacy").get(id).crc32;
  const phases = [];
  await store.downloadSet("chat-legacy", set.id, { onProgress: (progress) => phases.push(progress.phase) });
  assert.deepEqual([...new Set(phases)], ["checking", "writing"]);
  const files = await readArchive(new Blob([Buffer.concat(chunks)]));
  assert.ok([...files.values()].some((file) => file.bytes.equals(contents[0])));

  chunks.length = 0;
  phases.length = 0;
  await store.downloadSet("chat-legacy", set.id, { onProgress: (progress) => phases.push(progress.phase) });
  assert.deepEqual([...new Set(phases)], ["writing"], "the second time no file is read again first");
});

test("closing the picker is a cancel, not an error, and a download can be cancelled while it writes", async () => {
  const closed = { async choose() { throw new DeviceArtifactError("Saving the archive was cancelled.", "aborted"); }, hand() { assert.fail("not handed"); } };
  const store = newStore(undefined, closed);
  const { set } = await backup(store, "chat-closed", [1000]);
  await assert.rejects(store.downloadSet("chat-closed", set.id), (error) => error.code === "aborted");
  assert.equal(store.jobs("chat-closed").at(-1).state, "cancelled");

  const gate = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const slowSink = {
    async choose() {
      return new WritableStream({ async write() { reached.resolve(); await gate.promise; } });
    },
    hand() { assert.fail("not handed"); },
  };
  const slow = newStore(undefined, slowSink);
  const second = await backup(slow, "chat-slow", [UPLOAD_SLICE_BYTES * 2]);
  const writing = slow.downloadSet("chat-slow", second.set.id);
  const outcome = assert.rejects(writing, (error) => error.code === "aborted");
  await reached.promise;
  assert.equal(slow.cancelJob("chat-slow", slow.jobs("chat-slow").at(-1).id), true);
  gate.resolve();
  await outcome;
  assert.equal(slow.jobs("chat-slow").at(-1).state, "cancelled");
  assert.equal(slow.cancelJob("chat-slow", slow.jobs("chat-slow").at(-1).id), false, "a finished transfer cannot be cancelled again");
});

test("downloading nothing, or a file that is gone, says so", async () => {
  const store = newStore(undefined, downloadInto([]));
  await assert.rejects(store.downloadArtifacts("chat-none", []), (error) => error.code === "not-found" && /nothing to download/.test(error.message));
  await store.save("chat-none", "a.bin", new Blob(["a"]), provenance());
  await assert.rejects(store.downloadArtifacts("chat-none", ["no-such-id"]), (error) => error.code === "not-found" && /no longer in this session/.test(error.message));
  await assert.rejects(store.downloadSet("chat-none", "set:missing"), (error) => error.code === "not-found");
  assert.throws(() => store.startServerSave("chat-none", []), (error) => error.code === "not-found");
});
