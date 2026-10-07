import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { assertArchiveOpens, readArchive, setupFakeServer } from "./artifact-vault.test-helper.mjs";

/**
 * An agent saving a backup to the server, end to end: its tool, the bridge that carries the request to the page, the
 * page's own save (the same code the button runs) against the real vault handlers, the zip the server packs the files
 * into, and the status the agent reads back.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
// First, so the vault every module below loads finds the stand-in disk: the tool's own modules import the vault too.
const server = await setupFakeServer();
const { disk } = server;
const { DeviceBridge } = await jiti.import("./bus.ts");
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");
const { DeviceArtifactStore } = await jiti.import("./artifacts.ts");
const { parseArtifactSaveFrame, resolveSelection, runArtifactSave } = await jiti.import("./artifact-agent.ts");

const MiB = 1024 * 1024;
const tool = (name) => DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
const provenance = (operationId, extra = {}) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK", ...extra });
const SCOPE = { chosen: ["part0", "part1", "part2"], all: ["part0", "part1", "part2", "part3"] };

/**
 * A chat: a store holding a backup (three partitions of one operation, named "Cronos backup", one of four on the device), a
 * dump of one partition from another operation and a stray file, a bridge whose page is that store, and the fake server the
 * page uploads to.
 */
async function chat({ sizes = [6000, 0, 9000], limits = {}, wrapFetch } = {}) {
  const fake = server.fakeServer(limits);
  const store = new DeviceArtifactStore({ fetch: wrapFetch ? wrapFetch(fake.fetch) : fake.fetch, retryDelaysMs: [0, 0, 0] });
  const rows = new Map();
  store.persistence = {
    async put(sessionId, artifact) { rows.set(artifact.id, artifact); },
    async get(sessionId, id) { return rows.get(id); },
    async list() { return [...rows.values()]; },
    async delete(sessionId, id) { rows.delete(id); },
  };
  const contents = [];
  for (const [index, size] of sizes.entries()) {
    const bytes = randomBytes(size);
    contents.push(bytes);
    await store.save("chat-1", `edl-1a2b-set-p${index}-part${index}.bin`, new Blob([bytes]), provenance("op-backup", { set: "Cronos backup", scope: SCOPE }));
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  await store.save("chat-1", "userdata-dump.img", new Blob([randomBytes(700)]), provenance("op-dump", { command: "dump", action: "dump", target: "userdata" }));
  await store.save("chat-1", "other.bin", new Blob(["other"]), provenance("op-other"));
  const bridge = new DeviceBridge();
  const asked = [];
  bridge.attach((frame) => {
    if (frame.type !== "artifacts.save") return;
    asked.push(frame);
    const parsed = parseArtifactSaveFrame(JSON.stringify(frame));
    runArtifactSave(store, "chat-1", parsed).then(
      (value) => bridge.settle({ type: "result", id: frame.id, status: "ok", value }),
      (error) => bridge.settle({ type: "result", id: frame.id, status: "error", error: error.message }),
    );
  });
  process.env.CODY_DEVICE_ARTIFACTS_DIR = fake.config.root;
  return { fake, store, bridge, asked, contents };
}

const save = (bridge, args) => tool("device_artifacts_save").handler(args, { bridge });
const follow = (bridge, args = {}) => tool("device_artifacts_status").handler(args, { bridge });
const archiveOf = (answer) => /Saved to the server as ONE zip file: (.+)/.exec(answer)?.[1];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function until(read, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return assert.fail(`never happened: ${what}`);
}

test("an agent names an operation, the page uploads that operation's files, and the answer is the one zip: where it is, how much smaller it is, that the server re-read it, and how to check it", async () => {
  const { bridge, store, contents, asked, fake } = await chat();
  const answer = await save(bridge, { operationId: "op-backup" });

  assert.deepEqual(asked[0].selection, { operationIds: ["op-backup"] });
  assert.match(answer, /was started: 3 files, 15 KB/);
  const archive = archiveOf(answer);
  assert.ok(archive, answer);
  assert.match(archive, /\/Cronos-backup-incomplete-\d{4}-\d{2}-\d{2}\.zip$/, "named for the backup, and says it is not the whole of one: three partitions without the tables and the manifest the backup writes last");
  assert.match(answer, /3 files inside: 15 KB before packing, \d+ KB in the zip/);
  assert.match(answer, /re-read the finished zip from its own disk, and every file in it matched its SHA-256 and CRC-32/);
  assert.ok(answer.includes(`unzip -t '${archive}'`), "how to check it");
  assert.match(answer, /SHA256SUMS and manifest\.json/);
  assert.match(answer, /Files: edl-1a2b-set-p0-part0\.bin, edl-1a2b-set-p1-part1\.bin, edl-1a2b-set-p2-part2\.bin\./);
  assert.equal(statSync(archive).isFile(), true);
  assert.deepEqual(readdirSync(fake.config.root).filter((name) => !name.startsWith(".")), [archive.slice(fake.config.root.length + 1)], "one zip, nothing else in the vault");
  assertArchiveOpens(assert, archive);

  const inside = await readArchive(archive);
  for (const [index, bytes] of contents.entries()) assert.ok([...inside.entries()].find(([name]) => name.endsWith(`/edl-1a2b-set-p${index}-part${index}.bin`))[1].bytes.equals(bytes));
  assert.equal([...inside.keys()].some((name) => name.endsWith("/other.bin")), false, "only the named operation's files");

  const job = store.jobs("chat-1").at(-1);
  assert.equal(job.origin, "agent", "the panel lists it as the agent's");
  assert.equal(job.state, "succeeded");

  const status = await follow(bridge);
  assert.match(status, new RegExp(`Saved to the server as ONE zip file: ${escape(archive)}`));
});

test("a zip that packs well is reported with how much smaller it is", async () => {
  const fake = server.fakeServer();
  const store = new DeviceArtifactStore({ fetch: fake.fetch, retryDelaysMs: [0, 0, 0] });
  const rows = new Map();
  store.persistence = { async put(_, artifact) { rows.set(artifact.id, artifact); }, async get(_, id) { return rows.get(id); }, async list() { return [...rows.values()]; }, async delete(_, id) { rows.delete(id); } };
  await store.save("chat-1", "zeros.bin", new Blob([Buffer.alloc(500_000)]), provenance("op-zeros"));
  const bridge = new DeviceBridge();
  bridge.attach((frame) => {
    runArtifactSave(store, "chat-1", parseArtifactSaveFrame(JSON.stringify(frame))).then(
      (value) => bridge.settle({ type: "result", id: frame.id, status: "ok", value }),
      (error) => bridge.settle({ type: "result", id: frame.id, status: "error", error: error.message }),
    );
  });
  process.env.CODY_DEVICE_ARTIFACTS_DIR = fake.config.root;
  const answer = await save(bridge, { all: true });
  assert.match(answer, /1 file inside: 488 KB before packing, \d+(\.\d+)? KB in the zip \((99|100)% smaller\)/);
});

test("saving the same files again says they are already there, and a slow save is followed with the status tool", async () => {
  const gate = Promise.withResolvers();
  const { bridge } = await chat({
    wrapFetch: (realFetch) => async (input, init) => {
      if ((init?.method ?? "GET") === "PUT") await gate.promise;
      return realFetch(input, init);
    },
  });
  const running = await save(bridge, { all: true, waitSeconds: 0 });
  assert.match(running, /was started: 5 files/);
  assert.match(running, /is still uploading: 0 of 5 files verified/);
  assert.match(running, /only while the Cody tab stays open/);
  assert.match(running, /device_artifacts_status \(saveId [0-9a-f]{32}\)/);
  const saveId = /saveId ([0-9a-f]{32})/.exec(running)[1];
  assert.match(await follow(bridge, { saveId }), /is still uploading/);

  gate.resolve();
  const done = await until(async () => {
    const text = await follow(bridge, { saveId });
    return /Saved to the server as ONE zip file/.test(text) ? text : undefined;
  }, "the save finishing");
  assert.match(done, /5 files inside/);
  assert.match(await save(bridge, { all: true }), /was already on the server: 5 files/);
});

test("while the server packs, the status says so with a percentage, where the zip will appear, and that it is not there yet", async () => {
  disk.reset();
  const { bridge, fake } = await chat({ sizes: [3 * MiB, 1 * MiB], limits: { completeWaitMs: 20 } });
  const hold = disk.holdArchive(1_600_000);
  try {
    const started = await save(bridge, { operationId: "op-backup", waitSeconds: 0 });
    assert.match(started, /was started: 2 files, 4\.0 MB/);
    const saveId = /saveId ([0-9a-f]{32})/.exec(started)[1];
    await hold.reached;
    const text = await follow(bridge, { saveId });
    const percent = Number(/packing the archive: (\d+) %/.exec(text)?.[1]);
    assert.ok(percent > 0 && percent < 100, text);
    assert.match(text, /all 2 files are on the server and verified/);
    assert.match(text, /The zip appears at .+\.zip only when it is finished and the server has re-read it/);
    assert.match(text, new RegExp(`device_artifacts_status \\(saveId ${saveId}\\)`));
    assert.doesNotMatch(text, /Saved to the server/);
    assert.deepEqual(readdirSync(fake.config.root).filter((name) => !name.startsWith(".")), [], "and it is not there");

    // A call that waits while the server packs reports the progress when its wait is up, not before.
    const waited = await save(bridge, { operationId: "op-backup", waitSeconds: 1 });
    assert.match(waited, /was resumed/);
    assert.match(waited, /packing the archive: \d+ %/);
    hold.release();
    const done = await until(async () => {
      const answer = await follow(bridge, { saveId });
      return /Saved to the server as ONE zip file/.test(answer) ? answer : undefined;
    }, "the zip being finished");
    assert.match(done, /2 files inside/);
  } finally {
    hold.release();
    disk.reset();
  }
});

test("when packing fails the agent is told what happened, that the files are still on the server, and how to try again, without waiting out its time; calling again packs them without uploading anything twice", async () => {
  disk.reset();
  const { bridge, fake } = await chat({ sizes: [3 * MiB, 1 * MiB], limits: { completeWaitMs: 20_000 } });
  try {
    disk.archive.fullAfter = 300_000;
    const began = Date.now();
    const answer = await save(bridge, { operationId: "op-backup", waitSeconds: 60 });
    assert.ok(Date.now() - began < 20_000, "a failure does not mend by waiting, so the answer came as soon as it was known");
    assert.match(answer, /stopped before the zip was finished: The server's disk is full/);
    assert.match(answer, /still on the server, so nothing needs uploading again/);
    assert.match(answer, /call device_artifacts_save again with the same selection/);
    assert.doesNotMatch(answer, /Saved to the server/);
    const saveId = /Save ([0-9a-f]{32})/.exec(answer)[1];
    assert.match(await follow(bridge, { saveId }), /stopped before the zip was finished: The server's disk is full/, "and the status tool tells the same");
    assert.deepEqual(readdirSync(fake.config.root).filter((name) => !name.startsWith(".")), [], "no half-written zip is left to be mistaken for a backup");

    disk.reset();
    const sent = fake.log.filter((request) => request.method === "PUT").length;
    const again = await save(bridge, { operationId: "op-backup", waitSeconds: 60 });
    assert.match(again, /was resumed: 2 files/);
    assert.match(again, /Saved to the server as ONE zip file/);
    assert.equal(fake.log.filter((request) => request.method === "PUT").length, sent, "not one byte was uploaded again");
  } finally {
    disk.reset();
  }
});

test("an agent can name a backup by the name it gave it (set) and keep only some of its files, by file name or by partition", async () => {
  const { bridge, asked, contents } = await chat();
  const named = await save(bridge, { set: "Cronos backup" });
  assert.deepEqual(asked[0].selection, { set: "Cronos backup" });
  assert.match(named, /was started: 3 files/);
  assert.match(archiveOf(named), /\/Cronos-backup-incomplete-\d{4}-\d{2}-\d{2}\.zip$/, "the archive takes the backup's own name, and says the backup is not whole");

  const some = await save(bridge, { operationId: "op-backup", files: ["part0", "edl-1a2b-set-p2-part2.bin"], label: "Two partitions" });
  assert.deepEqual(asked[1].selection, { operationIds: ["op-backup"], only: ["part0", "edl-1a2b-set-p2-part2.bin"] });
  assert.match(some, /was started: 2 files/);
  assert.match(some, /Files: edl-1a2b-set-p0-part0\.bin, edl-1a2b-set-p2-part2\.bin\./, "the short partition name and the whole file name both work");
  const inside = await readArchive(archiveOf(some));
  assert.equal([...inside.keys()].filter((name) => !/\/(SHA256SUMS|manifest\.json)$/.test(name)).length, 2);
  assert.ok([...inside.entries()].find(([name]) => name.endsWith("/edl-1a2b-set-p0-part0.bin"))[1].bytes.equals(contents[0]));
  assert.match(archiveOf(some), /\/Two-partitions-\d{4}-\d{2}-\d{2}\.zip$/);

  const byTarget = await save(bridge, { all: true, files: ["userdata"] });
  assert.match(byTarget, /was started: 1 file,/);
  assert.match(byTarget, /Files: userdata-dump\.img\./, "a file is also found by the partition or path its operation named");
});

test("a name that matches no file is an error that lists it, and nothing is saved", async () => {
  const { bridge, fake, store } = await chat();
  const answer = await save(bridge, { operationId: "op-backup", files: ["part0", "bootloader", "part9"] });
  assert.match(answer, /Could not start the save: None of the selected files is called bootloader, part9\./);
  assert.match(answer, /The files selected so far are: part0, part1, part2\./);
  assert.match(answer, /Nothing was saved/);
  assert.deepEqual(fake.log.filter((request) => request.method !== "GET"), [], "nothing was announced or sent to the server");
  assert.equal(store.jobs("chat-1").length, 0);
  const unknownSet = await save(bridge, { set: "No such backup" });
  assert.match(unknownSet, /Could not start the save: Nothing saved in this chat matches set "No such backup"/);
});

test("the tool refuses what it cannot do in words an agent can act on", async () => {
  const { bridge } = await chat();
  assert.match(await save(bridge, {}), /Say what to save: operationId \(every file that operation made\), set \(every file filed under that backup name\), fileIds/);
  assert.match(await save(bridge, { files: ["part0"] }), /Say what to save/, "a list of names alone does not say which files to pick them from");
  assert.match(await save(bridge, { fileIds: "nope" }), /fileIds must be a list/);
  assert.match(await save(bridge, { operationId: "op-backup", files: "part0" }), /files must be a list of non-empty strings/);
  const missing = await save(bridge, { operationId: "op-nothing" });
  assert.match(missing, /Could not start the save: Nothing saved in this chat matches operation op-nothing/);
  assert.match(await save(bridge, { fileIds: ["no-such-file"] }), /matches file no-such-file/);

  assert.match(await follow(bridge), /No save has been started from this chat yet/);
  assert.match(await follow(bridge, { saveId: "0".repeat(32) }), /was not started by this chat's agent/);

  const detached = new DeviceBridge();
  assert.match(await save(detached, { all: true }), /No browser is attached to this session/);
});

test("the page names only what this chat holds, in the order it was saved, by operation, id, backup name or output, and narrows that by name; a frame that is not a save request is ignored", async () => {
  const { store } = await chat();
  const files = store.list("chat-1");
  const names = (selection) => resolveSelection(files, selection).map((file) => file.name);
  const backup = ["edl-1a2b-set-p0-part0.bin", "edl-1a2b-set-p1-part1.bin", "edl-1a2b-set-p2-part2.bin"];
  assert.deepEqual(names({ operationIds: ["op-backup"] }), backup);
  assert.deepEqual(names({ set: "Cronos backup" }), backup);
  assert.equal(names({ all: true }).length, 5);
  assert.deepEqual(names({ fileIds: [files.find((file) => file.name === "other.bin").id] }), ["other.bin"]);
  assert.deepEqual(names({ all: true, set: "Cronos backup" }).length, 5, "selectors add up");
  assert.deepEqual(names({ set: "Cronos backup", only: ["part1"] }), [backup[1]]);
  assert.deepEqual(names({ all: true, only: ["userdata", "other.bin"] }), ["userdata-dump.img", "other.bin"], "a name, a target or a partition each match, whichever selector chose the file");
  assert.deepEqual(names({ operationIds: ["op-backup"], only: ["part0", "part0", backup[0]] }), [backup[0]], "naming a file twice does not save it twice");
  assert.throws(() => names({ operationIds: ["op-backup"], only: ["userdata"] }), /None of the selected files is called userdata/, "only narrows what the other selectors chose");
  assert.throws(() => names({ all: true, only: ["PART0"] }), /None of the selected files is called PART0/, "names are exact");
  assert.throws(() => resolveSelection([], { all: true }), /no saved device files/);
  assert.throws(() => names({ set: "Nope" }), /matches set "Nope"/);
  // One name on two devices is two backups: the save refuses rather than packing both devices into one zip.
  const twoDevices = [
    ...files,
    { id: "tab-1", name: "edl-9-set-p0-boot_a.bin", size: 10, mime: "application/octet-stream", sha256: "9".repeat(64), kind: "output", source: "device", createdAt: 50, provenance: { operationId: "op-tablet", deviceId: "usb-2", protocol: "edl", action: "exec", command: "backup", label: "Other tablet", set: "Cronos backup" } },
  ];
  assert.throws(() => resolveSelection(twoDevices, { set: "Cronos backup" }), (error) => error.code === "not-found" && /"Cronos backup" names a backup on 2 devices \(Lenovo QUSB__BULK, Other tablet\)/.test(error.message) && /operationIds/.test(error.message) && /Nothing was saved/.test(error.message));
  assert.deepEqual(resolveSelection(twoDevices, { operationIds: ["op-tablet"] }).map((file) => file.id), ["tab-1"], "naming the operation still works");

  const frame = { type: "artifacts.save", id: "7", selection: { operationIds: ["a"], all: "yes", set: "  My set  ", only: ["part0", "boot_a"], extra: true }, label: "  My label  " };
  assert.deepEqual(parseArtifactSaveFrame(frame), { type: "artifacts.save", id: "7", selection: { operationIds: ["a"], set: "My set", only: ["part0", "boot_a"] }, label: "My label" });
  assert.equal(parseArtifactSaveFrame({ ...frame, selection: { ...frame.selection, fileIds: [1] } }).refused, "fileIds[0] must be a name of 1 to 200 characters. Nothing was saved.", "a list that is not names is refused, not dropped");
  assert.deepEqual(parseArtifactSaveFrame({ type: "artifacts.save", id: "8", selection: { set: "   ", only: [] } }), { type: "artifacts.save", id: "8", selection: {} });
  assert.deepEqual(parseArtifactSaveFrame({ type: "artifacts.save", id: "9", selection: { all: true, only: ["a", ""] } }), { type: "artifacts.save", id: "9", refused: "files[1] must be a name of 1 to 200 characters. Nothing was saved." }, "a list with a bad name is refused whole, never dropped (which would widen the save to everything)");
  assert.equal(parseArtifactSaveFrame({ type: "artifacts.save", id: "9", selection: { operationIds: ["op", "x".repeat(201)] } }).refused, "operationIds[1] must be a name of 1 to 200 characters. Nothing was saved.");
  assert.equal(parseArtifactSaveFrame({ type: "artifacts.save", id: "9", selection: { fileIds: Array.from({ length: 2000 }, (_, index) => `file-${index}`) } }).selection.fileIds.length, 2000, "a save of thousands of files is not cut down to a few");
  assert.equal(parseArtifactSaveFrame({ type: "op", id: "1" }), null);
  assert.equal(parseArtifactSaveFrame("{nope"), null);
  assert.equal(parseArtifactSaveFrame({ type: "artifacts.save", id: 7, selection: {} }), null);
});
