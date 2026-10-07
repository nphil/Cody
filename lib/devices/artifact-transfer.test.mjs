import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { assertArchiveOpens, readArchive, setupFakeServer } from "./artifact-vault.test-helper.mjs";

/**
 * "Save to server" through the store, as the Devices panel and an agent call it: the real uploader against the real
 * vault handlers (with the faults a network produces), ending in the ONE archive the server packs the files into. (The
 * download half of the transfers has its own file, artifact-download.test.mjs.)
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceArtifactError, DeviceArtifactStore } = await jiti.import("./artifacts.ts");
const { UPLOAD_SLICE_BYTES, uploadToServer } = await jiti.import("./artifact-upload.ts");
const server = await setupFakeServer();
const { disk } = server;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const NEVER_WAIT = [0, 0, 0];
const MiB = 1024 * 1024;

function newStore(fake) {
  const store = new DeviceArtifactStore({ fetch: fake?.fetch, retryDelaysMs: NEVER_WAIT });
  const rows = new Map();
  store.persistence = {
    async put(sessionId, artifact) { rows.set(`${sessionId}:${artifact.id}`, { sessionId, artifact }); },
    async get(sessionId, id) { return rows.get(`${sessionId}:${id}`)?.artifact; },
    async list(sessionId) { return [...rows.values()].filter((row) => row.sessionId === sessionId).map((row) => row.artifact); },
    async delete(sessionId, id) { rows.delete(`${sessionId}:${id}`); },
  };
  return store;
}

const provenance = (operationId = "op-1", extra = {}) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK", ...extra });

/** Saves outputs of one operation and returns what was saved: the file contents and the set they form. */
async function backup(store, sessionId, sizes, names, extra) {
  const contents = [];
  for (const [index, size] of sizes.entries()) {
    const bytes = randomBytes(size);
    contents.push(bytes);
    await store.save(sessionId, names?.[index] ?? `edl-1a2b-set-p${index}-part${index}.bin`, new Blob([bytes]), provenance("op-1", extra));
    // Files made in the same millisecond have no order; real ones are seconds apart.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const [set] = store.sets(sessionId);
  return { contents, set, ids: set.artifactIds };
}

/** Files for the uploader itself, with no store in between. */
function uploadFiles(contents) {
  return contents.map((bytes, index) => ({ artifactId: `a-${index}`, name: `part${index}.bin`, size: bytes.length, sha256: sha256(bytes), kind: "output", source: "device", createdAt: Date.now(), blob: new Blob([bytes]) }));
}

const uploadOptions = (fake, extra = {}) => ({ sessionId: "chat-direct", label: "Big backup", fetch: fake.fetch, retryDelaysMs: NEVER_WAIT, pollMs: 10, sliceBytes: 512 * 1024, ...extra });
const completes = (fake) => fake.log.filter((request) => request.method === "POST" && request.body?.includes('"complete"')).length;
const puts = (fake) => fake.log.filter((request) => request.method === "PUT").length;
const statusPolls = (fake) => fake.log.filter((request) => request.method === "GET" && /\/saves\/[0-9a-f]{32}$/.test(request.path)).length;

async function until(condition, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`never happened: ${what}`);
}

const big = () => [randomBytes(3 * MiB), randomBytes(1 * MiB)];
const roomy = (extra = {}) => server.fakeServer({ maxChunkBytes: 1 * MiB, completeWaitMs: 20, ...extra });

// ---------------------------------------------------------------------------------------------------------------------
// Save to server
// ---------------------------------------------------------------------------------------------------------------------

test("saving a set uploads every file in slices, has the server re-check each one and pack them into ONE archive, and the set then shows as saved", async () => {
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
  assert.match(result.archive, /\/Lenovo-QUSB__BULK-EDL-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(result.archiveBytes, statSync(result.archive).size, "the size is the archive's own, as it is on the server's disk");
  assert.deepEqual(readdirSync(fake.config.root).sort(), [".incoming", result.archive.slice(fake.config.root.length + 1)], "one file in the vault for the whole set");
  assert.deepEqual(readdirSync(join(fake.config.root, ".incoming")), []);
  assertArchiveOpens(assert, result.archive);

  const inside = await readArchive(result.archive);
  const folder = result.archive.slice(fake.config.root.length + 1).replace(/\.zip$/, "");
  for (const [index, name] of ["edl-1a2b-set-p0-part0.bin", "edl-1a2b-set-p1-part1.bin", "edl-1a2b-set-p2-part2.bin"].entries()) {
    assert.ok(inside.get(`${folder}/${name}`).bytes.equals(contents[index]), name);
  }
  const manifest = JSON.parse(inside.get(`${folder}/manifest.json`).bytes.toString("utf8"));
  assert.equal(manifest.sessionId, "chat-1");
  assert.deepEqual(manifest.files[0].operation, { id: "op-1", deviceId: "usb-1", protocol: "edl", action: "exec", deviceLabel: "Lenovo QUSB__BULK", command: "backup" });

  assert.deepEqual(fake.log.filter((request) => request.method === "PUT").map((request) => request.search).slice(0, 3), ["?file=0&offset=0", `?file=0&offset=${UPLOAD_SLICE_BYTES}`, `?file=0&offset=${UPLOAD_SLICE_BYTES * 2}`], "a 4 MiB slice at a time");
  assert.deepEqual([...new Set(seen.map((progress) => progress.phase))], ["uploading", "verifying", "writing"]);
  assert.deepEqual(seen.at(-1), { phase: "writing", done: 3, total: 3, bytes: result.bytes, totalBytes: result.bytes });
  for (const phase of ["uploading", "verifying", "writing"]) {
    const bytes = seen.filter((progress) => progress.phase === phase).map((progress) => progress.bytes);
    assert.ok(bytes.every((value, index) => index === 0 || value >= bytes[index - 1]), `${phase} progress never goes backwards`);
  }

  const state = store.getSetSaveState("chat-1", set.id);
  assert.equal(state.state, "saved");
  assert.equal(state.path, result.archive);
  assert.equal(state.verified, true);
  assert.equal(state.files, 3);
  assert.equal(state.bytes, result.bytes);
  assert.equal(state.archiveBytes, result.archiveBytes);
  for (const artifact of store.list("chat-1")) {
    assert.equal(artifact.server?.archive, result.archive, "each file now says which archive holds it");
    assert.ok(artifact.server.entry.startsWith(`${folder}/`) && artifact.server.verified && artifact.server.originalBytes === result.bytes && artifact.server.archiveBytes === result.archiveBytes);
  }
  assert.ok(listed.at(-1) === 3, "subscribers hear that the server copies changed");
  assert.deepEqual(ids.length, 3);
});

test("what the page knows about an operation (when it started, the backup name, which partitions were chosen) goes with every file into the archive's manifest", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const scope = { chosen: ["boot_a", "persist"], all: ["boot_a", "boot_b", "persist"] };
  const { set } = await backup(store, "chat-op", [800, 900], ["edl-1a2b-set-p0-boot_a.bin", "edl-1a2b-set-p2-persist.bin"], { startedAt: Date.parse("2026-10-06T18:30:00Z"), set: "Cronos tablet 2026-10-06", scope });
  const result = await store.saveSetToServer("chat-op", set.id);
  const inside = await readArchive(result.archive);
  const manifest = JSON.parse([...inside.entries()].find(([name]) => name.endsWith("/manifest.json"))[1].bytes.toString("utf8"));
  assert.equal(manifest.files[0].operation.startedAt, "2026-10-06T18:30:00.000Z");
  assert.equal(manifest.files[0].operation.set, "Cronos tablet 2026-10-06");
  assert.deepEqual(manifest.files[0].operation.partitions, scope);
  assert.deepEqual(manifest.backups, [{ operationId: "op-1", kind: "partial", chosen: ["boot_a", "persist"], all: ["boot_a", "boot_b", "persist"] }]);
  assert.match(result.archive, /\/Cronos-tablet-2026-10-06-2-of-3-\d{4}-\d{2}-\d{2}\.zip$/, "and the archive is named for the backup, and says it holds 2 of 3 partitions");
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
  assert.match(learned.archive, /\/Lenovo-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(existsSync(learned.archive), false, "it is told where the archive will be before it exists");
  const running = store.jobs("chat-jobs").find((job) => job.id === jobId);
  assert.equal(running.origin, "agent");
  assert.equal(running.kind, "save");
  assert.equal(running.setId, set.id);
  assert.deepEqual(running.artifactIds, set.artifactIds);
  assert.equal(running.label, "Lenovo backup");

  const result = await finished;
  assert.equal(result.archive, learned.archive, "and that is where it ended up");
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
  const sent = puts(fake);
  const second = await store.saveSetToServer("chat-again", set.id);
  assert.equal(second.alreadySaved, true);
  assert.equal(second.archive, first.archive);
  assert.equal(second.archiveBytes, first.archiveBytes);
  assert.equal(second.verified, true);
  assert.equal(puts(fake), sent, "no byte was sent the second time");
  assert.equal(readdirSync(fake.config.root).filter((name) => !name.startsWith(".")).length, 1, "and no second archive was made");
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

  const before = puts(fake);
  const result = await store.saveSetToServer("chat-resume", set.id);
  assert.equal(result.resumed, true);
  const resumedOffsets = fake.log.filter((request) => request.method === "PUT").slice(before).map((request) => Number(/offset=(\d+)/.exec(request.search)[1]));
  assert.ok(resumedOffsets[0] > 0, `it carried on from ${resumedOffsets[0]}, not from the start`);
  const inside = await readArchive(result.archive);
  assert.ok([...inside.values()].some((entry) => entry.bytes.equals(contents[0])));
});

test("a dropped connection is retried, and so is an answer that never arrived, without duplicating or skipping a byte", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { contents, set } = await backup(store, "chat-flaky", [UPLOAD_SLICE_BYTES + 500]);
  fake.faults.network = 2;
  const result = await store.saveSetToServer("chat-flaky", set.id);
  assert.equal(result.verified, true);
  assert.ok([...(await readArchive(result.archive)).values()].some((entry) => entry.bytes.equals(contents[0])));

  const lost = server.fakeServer();
  const lostStore = newStore(lost);
  const second = await backup(lostStore, "chat-lost", [UPLOAD_SLICE_BYTES + 500]);
  lost.faults.lostAnswers = 3;
  const finished = await lostStore.saveSetToServer("chat-lost", second.set.id);
  assert.ok([...(await readArchive(finished.archive)).values()].some((entry) => entry.bytes.equals(second.contents[0])), "the slice whose answer was lost was not sent twice");
  assertArchiveOpens(assert, finished.archive);
});

test("an answer lost after the archive was written is recovered by asking again: the second complete finds the finished archive, not a second build", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { set } = await backup(store, "chat-lost-complete", [5000, 6000]);
  const original = fake.fetch;
  let lost = 0;
  const lossy = new DeviceArtifactStore({
    retryDelaysMs: NEVER_WAIT,
    fetch: async (input, init) => {
      const response = await original(input, init);
      if (init?.method === "POST" && typeof init.body === "string" && init.body.includes('"complete"') && lost === 0) {
        lost += 1;
        throw new TypeError("fetch failed: the answer never arrived");
      }
      return response;
    },
  });
  lossy.persistence = store.persistence;
  for (const artifact of await store.persistence.list("chat-lost-complete")) lossy.entries("chat-lost-complete").set(artifact.id, artifact);
  const result = await lossy.saveSetToServer("chat-lost-complete", lossy.sets("chat-lost-complete")[0].id);
  assert.equal(lost, 1);
  assert.equal(result.verified, true);
  assert.equal(readdirSync(fake.config.root).filter((name) => !name.startsWith(".")).length, 1);
  assert.equal(completes(fake), 2);
  assert.ok(set.id);
});

test("a file that arrives damaged is caught on the server's disk and sent again once; twice damaged is reported", async () => {
  const fake = server.fakeServer();
  const store = newStore(fake);
  const { contents, set } = await backup(store, "chat-damage", [8000]);
  fake.faults.corrupt = 1;
  const result = await store.saveSetToServer("chat-damage", set.id);
  assert.ok([...(await readArchive(result.archive)).values()].some((entry) => entry.bytes.equals(contents[0])));
  assert.equal(puts(fake), 2, "the whole file was sent a second time");

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
  assert.equal(existsSync(result.archive), false);
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
// While the server packs
// ---------------------------------------------------------------------------------------------------------------------

test("a build that takes a while is waited for: the uploader asks again, reports how much is packed, and finishes when the server does", async () => {
  disk.reset();
  const fake = roomy();
  const contents = big();
  const hold = disk.holdArchive(1_600_000);
  const seen = [];
  const saving = uploadToServer(uploadFiles(contents), uploadOptions(fake, { onProgress: (progress) => seen.push(progress) }));
  await hold.reached;
  await until(() => seen.some((progress) => progress.phase === "writing" && progress.bytes > 0), "a report of packing progress");
  const total = contents.reduce((sum, bytes) => sum + bytes.length, 0);
  const packing = seen.filter((progress) => progress.phase === "writing");
  assert.ok(packing.every((progress) => progress.done === 2 && progress.total === 2 && progress.totalBytes === total), "every file is done; the bytes are what is packed");
  assert.ok(packing.some((progress) => progress.bytes > 0 && progress.bytes < total), "and it is part of the way");
  await until(() => statusPolls(fake) >= 2, "the uploader asking about the build more than once");
  hold.release();

  const result = await saving;
  assert.equal(result.verified, true);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, total);
  assert.equal(result.archiveBytes, statSync(result.archive).size);
  assert.deepEqual(seen.at(-1), { phase: "writing", done: 2, total: 2, bytes: total, totalBytes: total });
  assert.equal(completes(fake), 1, "it asked for the archive once, then only asked how it was going");
  assert.equal(disk.archive.opened, 1);
  const inside = await readArchive(result.archive);
  assert.ok([...inside.values()].some((entry) => entry.bytes.equals(contents[0])));
  assert.ok([...inside.values()].some((entry) => entry.bytes.equals(contents[1])));
});

test("cancelling while the server packs stops the asking at once; the server carries on, and saving again finds the finished archive and sends nothing", async () => {
  disk.reset();
  const fake = roomy();
  const contents = big();
  const files = uploadFiles(contents);
  const hold = disk.holdArchive(1_000_000);
  const controller = new AbortController();
  const saving = uploadToServer(files, uploadOptions(fake, { signal: controller.signal }));
  const cancelled = assert.rejects(saving, (error) => error instanceof DeviceArtifactError && error.code === "aborted");
  await hold.reached;
  await until(() => statusPolls(fake) >= 1, "the first look at the build");
  controller.abort();
  await cancelled;
  const polls = statusPolls(fake);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(statusPolls(fake), polls, "it stopped asking");

  hold.release();
  const sent = puts(fake);
  let finished;
  await until(() => {
    finished = readdirSync(fake.config.root).filter((name) => name.endsWith(".zip"));
    return finished.length === 1;
  }, "the archive the server went on with");
  const again = await uploadToServer(files, uploadOptions(fake));
  assert.equal(again.alreadySaved, true);
  assert.equal(again.archive, join(fake.config.root, finished[0]));
  assert.equal(puts(fake), sent, "nothing was sent again");
  assert.equal(disk.archive.opened, 1);
});

test("a build that stops for want of room is reported in the server's own words as a full disk, the files stay, and saving again after making room sends nothing", async () => {
  disk.reset();
  const fake = roomy({ completeWaitMs: 20_000 });
  const contents = big();
  const files = uploadFiles(contents);
  disk.archive.fullAfter = 300_000;
  await assert.rejects(uploadToServer(files, uploadOptions(fake)), (error) => error instanceof DeviceArtifactError && error.code === "disk-full" && /disk is full/.test(error.message) && /nothing is uploaded twice/.test(error.message));
  assert.equal(completes(fake), 1, "a full disk is not asked again blindly");
  const sent = puts(fake);

  disk.reset();
  const result = await uploadToServer(files, uploadOptions(fake));
  assert.equal(result.resumed, true, "it carried on from the files the server kept");
  assert.equal(puts(fake), sent, "and sent nothing again");
  assert.ok([...(await readArchive(result.archive)).values()].some((entry) => entry.bytes.equals(contents[0])));
});

test("a build that fails while the uploader is already asking how it is going ends the save with the reason, as a full disk or as a refusal", async () => {
  disk.reset();
  const fake = roomy();
  const contents = big();
  const files = uploadFiles(contents);
  const hold = disk.holdArchive(600_000);
  disk.archive.fullAfter = 800_000;
  const saving = uploadToServer(files, uploadOptions(fake));
  const refused = assert.rejects(saving, (error) => error instanceof DeviceArtifactError && error.code === "disk-full" && /disk is full/.test(error.message));
  await hold.reached;
  await until(() => statusPolls(fake) >= 1, "the uploader asking about the build");
  hold.release();
  await refused;
  assert.equal(completes(fake), 1);

  disk.reset();
  const second = roomy();
  const secondFiles = uploadFiles(contents);
  const secondHold = disk.holdArchive(600_000);
  disk.archive.corruptAt = 700_000;
  const checking = uploadToServer(secondFiles, uploadOptions(second));
  const failed = assert.rejects(checking, (error) => error instanceof DeviceArtifactError && error.code === "server-refused" && /did not pass the server's own re-read/.test(error.message) && /part0\.bin|part1\.bin/.test(error.message));
  await secondHold.reached;
  await until(() => statusPolls(second) >= 1, "the uploader asking about the build");
  secondHold.release();
  await failed;
  disk.reset();
});

test("an archive the server could not make is not asked for again and again: a check that failed ends the save at once, and saving again then works", async () => {
  disk.reset();
  const fake = roomy({ completeWaitMs: 20_000 });
  const contents = big();
  const files = uploadFiles(contents);
  disk.archive.corruptAt = 400_000;
  await assert.rejects(uploadToServer(files, uploadOptions(fake)), (error) => error instanceof DeviceArtifactError && error.code === "server-refused" && /part0\.bin/.test(error.message));
  assert.equal(completes(fake), 1, "a second complete would only fail the same way");
  disk.reset();
  const sent = puts(fake);
  assert.equal((await uploadToServer(files, uploadOptions(fake))).verified, true);
  assert.equal(puts(fake), sent);
});

test("a server that forgot the build (it restarted) is asked to pack again, and one that keeps forgetting is given up on without losing anything", async () => {
  disk.reset();
  const fake = server.fakeServer();
  const contents = [randomBytes(3000), randomBytes(2000)];
  let forget = 1;
  const forgetful = async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string" && init.body.includes('"complete"') && forget > 0) {
      forget -= 1;
      // What a restarted server says about a save it still has every file of: uploaded, nobody building.
      return fake.fetch(new URL(typeof input === "string" ? input : input.url, "http://cody.test").pathname, { method: "GET" });
    }
    return fake.fetch(input, init);
  };
  const result = await uploadToServer(uploadFiles(contents), { ...uploadOptions(fake), fetch: forgetful });
  assert.equal(result.verified, true);
  assert.equal(fake.log.filter((request) => request.body?.includes('"complete"')).length, 1, "the real server saw one complete; the other never reached it");

  forget = Number.POSITIVE_INFINITY;
  const stubborn = server.fakeServer();
  const forgetsForever = async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string" && init.body.includes('"complete"')) {
      stubborn.log.push({ method: "COMPLETE" });
      return stubborn.fetch(new URL(typeof input === "string" ? input : input.url, "http://cody.test").pathname, { method: "GET" });
    }
    return stubborn.fetch(input, init);
  };
  await assert.rejects(
    uploadToServer(uploadFiles(contents), { ...uploadOptions(stubborn), fetch: forgetsForever }),
    (error) => error instanceof DeviceArtifactError && error.code === "server-refused" && /keeps stopping before it finishes packing/.test(error.message) && /nothing is sent twice/.test(error.message),
  );
  assert.equal(stubborn.log.filter((request) => request.method === "COMPLETE").length, 4, "the first ask and three more, then it stopped");
  assert.equal(puts(stubborn), 2, "and every file was only sent the once");
});

test("a save that the server deleted while it was packing is reported as gone, with what to do, instead of being asked about for ever", async () => {
  disk.reset();
  const fake = roomy();
  const files = uploadFiles(big());
  const hold = disk.holdArchive(1_000_000);
  const saving = uploadToServer(files, uploadOptions(fake));
  const gone = assert.rejects(saving, (error) => error instanceof DeviceArtifactError && /no longer has this save/.test(error.message) && /Press Save to server again/.test(error.message));
  await hold.reached;
  await until(() => statusPolls(fake) >= 1, "the uploader asking about the build");
  const saveId = /\/saves\/([0-9a-f]{32})/.exec(fake.log.find((request) => request.method === "PUT").path)[1];
  const removal = fake.fetch(`/api/devices/artifacts/saves/${saveId}`, { method: "DELETE" });
  await until(() => globalThis.__codyVaultBuilds.get(saveId)?.controller.signal.aborted === true, "the server telling the build to stop");
  hold.release();
  assert.equal((await removal).status, 200);
  await gone;
});

test("a stored file that went missing on the server before it was packed is named and not retried blindly, and saving again sends only that one file", async () => {
  disk.reset();
  const fake = server.fakeServer();
  const contents = [randomBytes(3000), randomBytes(2000), randomBytes(1000)];
  const files = uploadFiles(contents);
  let broken = false;
  const breaking = async (input, init) => {
    if (!broken && init?.method === "POST" && typeof init.body === "string" && init.body.includes('"complete"')) {
      broken = true;
      const saveId = /\/saves\/([0-9a-f]{32})/.exec(new URL(typeof input === "string" ? input : input.url, "http://cody.test").pathname)[1];
      rmSync(join(fake.config.root, ".incoming", saveId, ".1.part"));
    }
    return fake.fetch(input, init);
  };
  await assert.rejects(
    uploadToServer(files, { ...uploadOptions(fake), fetch: breaking }),
    (error) => error instanceof DeviceArtifactError && error.code === "server-refused" && /"part1\.bin" is missing or changed on the server/.test(error.message) && /only that file is sent again/.test(error.message),
  );
  assert.equal(completes(fake), 1, "the same answer would have come again, so it was not asked again");
  const sent = puts(fake);
  assert.equal(sent, 3);

  const result = await uploadToServer(files, uploadOptions(fake));
  assert.equal(result.resumed, true);
  assert.equal(puts(fake), sent + 1, "only the file the server lost was sent again");
  const inside = await readArchive(result.archive);
  for (const bytes of contents) assert.ok([...inside.values()].some((entry) => entry.bytes.equals(bytes)));
  assertArchiveOpens(assert, result.archive);
});
