import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceArtifactError, DeviceArtifactStore, artifactsFromRows, authorizedArtifactDownloadUrl } = await jiti.import("./artifacts.ts");
const { olderSetOf } = await jiti.import("./artifact-sets.ts");
/** The id of the older backup the card offers for `set`, as the card passes it along. */
const olderOf = (store, set) => olderSetOf(store.sets("s"), set)?.id ?? "set:none";

test("artifact escrow fails closed when this runtime has no IndexedDB", { skip: typeof indexedDB !== "undefined" }, async () => {
  const store = new DeviceArtifactStore();
  await assert.rejects(
    () => store.save("session-a", "flash-backup.bin", new Blob(["backup"])),
    (error) => error instanceof DeviceArtifactError && /Persistent browser storage/.test(error.message),
  );
  assert.deepEqual(store.list("session-a"), []);
});

test("authorized file imports use only Cody's guarded per-session file route", () => {
  assert.equal(
    authorizedArtifactDownloadUrl("session-a", "/workspace/firmware image.bin"),
    "/api/files/workspace/firmware%20image.bin?type=download&sessionId=session-a",
  );
  assert.throws(() => authorizedArtifactDownloadUrl("", "/workspace/firmware.bin"), DeviceArtifactError);
  assert.throws(() => authorizedArtifactDownloadUrl("session-a", ""), DeviceArtifactError);
});

test("a session file is found by its SHA-256 in any case, in memory first and then in the persisted escrow, and only in its own session", async () => {
  const store = new DeviceArtifactStore();
  const stored = (id, sha256, text) => ({ id, name: `${id}.bin`, size: text.length, mime: "application/octet-stream", sha256, kind: "output", source: "device", createdAt: 1, blob: new Blob([text]) });
  store.entries("session-a").set("a", stored("a", "ab".repeat(32), "aaa"));
  store.persistence = { list: async (sessionId) => (sessionId === "session-a" ? [stored("b", "cd".repeat(32), "bbb")] : []) };

  assert.equal(await (await store.findBySha256("session-a", "AB".repeat(32))).text(), "aaa");
  assert.equal(await (await store.findBySha256("session-a", "cd".repeat(32))).text(), "bbb");
  assert.deepEqual(store.list("session-a").map((artifact) => artifact.id).sort(), ["a", "b"], "a file found in the escrow joins the session's list");
  assert.equal(await store.findBySha256("session-a", "ef".repeat(32)), undefined);
  assert.equal(await store.findBySha256("session-b", "ab".repeat(32)), undefined);
});

/** A store whose escrow is a Map, so the rest of the store is exercised without a browser database. A set name is kept apart from its file, as the real escrow keeps it, and put back on when the file is read. */
function memoryStore() {
  const store = new DeviceArtifactStore();
  const rows = new Map();
  const names = new Map();
  const named = (sessionId, artifact) => (artifact && names.has(`${sessionId}:${artifact.id}`) ? { ...artifact, setName: names.get(`${sessionId}:${artifact.id}`) } : artifact);
  store.persistence = {
    async put(sessionId, artifact) { rows.set(`${sessionId}:${artifact.id}`, { sessionId, artifact }); },
    async get(sessionId, id) { return named(sessionId, rows.get(`${sessionId}:${id}`)?.artifact); },
    async list(sessionId) { return [...rows.values()].filter((row) => row.sessionId === sessionId).map((row) => named(sessionId, row.artifact)); },
    async putSetNames(sessionId, entries) { for (const [id, name] of entries) names.set(`${sessionId}:${id}`, name); },
    async delete(sessionId, id) { rows.delete(`${sessionId}:${id}`); names.delete(`${sessionId}:${id}`); },
  };
  return { store, rows, names };
}

const provenance = (operationId, extra = {}) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK", ...extra });

test("a saved output keeps which operation made it and the CRC-32 a download checks its bytes against, and an input keeps neither", async () => {
  const { store, rows } = memoryStore();
  const bytes = Buffer.from("partition bytes");
  const id = await store.save("s", "edl-1-set-p1-boot.bin", new Blob([bytes]), provenance("op-1", { target: "boot" }));
  const input = await store.addInput("s", new File([bytes], "firmware.bin"));

  const listed = store.list("s");
  assert.deepEqual(listed.find((artifact) => artifact.id === id).provenance, provenance("op-1", { target: "boot" }));
  assert.equal(listed.find((artifact) => artifact.id === input.id).provenance, undefined);
  assert.equal(rows.get(`s:${id}`).artifact.crc32, nodeCrc32(bytes));
  assert.equal(rows.get(`s:${id}`).artifact.provenance.operationId, "op-1", "provenance is persisted with the Blob, not only held in memory");
});

test("provenance is bounded, trimmed to its known fields, and dropped when it is not about an operation on a device", async () => {
  const { store } = memoryStore();
  const long = "x".repeat(500);
  const a = await store.save("s", "a.bin", new Blob(["a"]), { ...provenance("op-1"), label: long, junk: "ignored" });
  const b = await store.save("s", "b.bin", new Blob(["b"]), { ...provenance("") });
  const c = await store.save("s", "c.bin", new Blob(["c"]));
  const byId = new Map(store.list("s").map((artifact) => [artifact.id, artifact]));
  assert.equal(byId.get(a).provenance.label.length, 200);
  assert.equal("junk" in byId.get(a).provenance, false);
  assert.equal(byId.get(b).provenance, undefined, "no operation id, no provenance");
  assert.equal(byId.get(c).provenance, undefined);
});

test("a store groups a session's outputs into sets, removes a whole set, and says what it removed", async () => {
  const { store, rows } = memoryStore();
  for (const name of ["a.bin", "b.bin", "c.bin"]) await store.save("s", name, new Blob([name]), provenance("op-1"));
  const keep = await store.save("s", "other.bin", new Blob(["other"]), provenance("op-2", { deviceId: "usb-2" }));
  await store.save("t", "elsewhere.bin", new Blob(["x"]), provenance("op-9"));

  const sets = store.sets("s");
  assert.equal(sets.length, 2);
  const backup = sets.find((set) => set.count === 3);
  assert.equal(await store.removeSet("s", backup.id), 3);
  assert.deepEqual(store.list("s").map((artifact) => artifact.id), [keep]);
  assert.equal([...rows.keys()].filter((key) => key.startsWith("s:")).length, 1, "the escrow is emptied too");
  assert.equal(store.list("t").length, 1, "another session is untouched");
  await assert.rejects(() => store.removeSet("s", backup.id), (error) => error instanceof DeviceArtifactError && error.code === "not-found");
});

test("removeMany ignores ids that are not there, counts each file once, and tells listeners once", async () => {
  const { store } = memoryStore();
  const ids = [];
  for (const name of ["a.bin", "b.bin"]) ids.push(await store.save("s", name, new Blob([name]), provenance("op-1")));
  let notified = 0;
  const unsubscribe = store.subscribe("s", () => { notified += 1; });
  notified = 0;
  assert.equal(await store.removeMany("s", [ids[0], ids[0], "missing", ids[1]]), 2);
  assert.equal(notified, 1);
  assert.equal(await store.removeMany("s", ids), 0);
  assert.equal(notified, 1, "nothing removed, nothing announced");
  unsubscribe();
});

test("a hydrate that was reading the escrow when a file was removed does not bring the file back, and a filing made meanwhile stays", async () => {
  const { store } = memoryStore();
  const { backupId, dumpId } = await twoSetsOnOneDevice(store);
  const dumpSet = store.sets("s").find((set) => set.artifactIds.includes(dumpId));
  // The escrow answers slowly, as a real IndexedDB does with gigabytes in it; the person acts in the meantime.
  const list = store.persistence.list.bind(store.persistence);
  let release;
  store.persistence.list = async (sessionId) => {
    const rows = await list(sessionId);
    await new Promise((resolve) => { release = resolve; });
    return rows;
  };
  const fresh = new DeviceArtifactStore();
  fresh.persistence = store.persistence;
  const first = fresh.hydrate("s");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fresh.persistence.list = list;
  await fresh.hydrate("s");
  assert.equal(await fresh.removeMany("s", [backupId]), 1);
  await fresh.combineWithOlder("s", fresh.sets("s").find((set) => set.artifactIds.includes(dumpId)).id, olderOf(fresh, fresh.sets("s").find((set) => set.artifactIds.includes(dumpId)))).catch(() => undefined);
  release();
  await first;
  assert.equal(fresh.list("s").some((artifact) => artifact.id === backupId), false, "the stale snapshot does not undo the Remove");
  assert.ok(dumpSet, "the fixture's dump set exists");
});

test("an error carries a code the panel can act on and a message it can show as it is", () => {
  const error = new DeviceArtifactError("The server has no room.", "disk-full");
  assert.equal(error.code, "disk-full");
  assert.equal(new DeviceArtifactError("plain").code, "unknown");
  assert.ok(error instanceof Error && error.name === "DeviceArtifactError");
});

test("the start time, the set name and the scope an operation hands over are kept, bounded, and dropped when they are not what they claim", async () => {
  const { store } = memoryStore();
  const all = Array.from({ length: 5 }, (_, index) => `part${index}`);
  const ok = await store.save("s", "a.bin", new Blob(["a"]), provenance("op-1", { startedAt: 1_780_000_000_123.9, set: "  Lenovo tablet  ", scope: { chosen: all.slice(0, 2), all } }));
  const bad = await store.save("s", "b.bin", new Blob(["b"]), provenance("op-2", { startedAt: Number.NaN, set: "x".repeat(81), scope: { chosen: all, all: all.slice(0, 2) } }));
  const control = await store.save("s", "c.bin", new Blob(["c"]), provenance("op-3", { startedAt: -5, set: "bad\u0001name", scope: { chosen: [], all } }));
  const long = await store.save("s", "d.bin", new Blob(["d"]), provenance("op-4", { scope: { chosen: ["y".repeat(200)], all: ["y".repeat(200)] } }));
  const byId = new Map(store.list("s").map((artifact) => [artifact.id, artifact.provenance]));
  assert.equal(byId.get(ok).startedAt, 1_780_000_000_123);
  assert.equal(byId.get(ok).set, "Lenovo tablet");
  assert.deepEqual(byId.get(ok).scope, { chosen: ["part0", "part1"], all });
  for (const id of [bad, control]) for (const key of ["startedAt", "set", "scope"]) assert.equal(key in byId.get(id), false, `${key} of a bad value is dropped`);
  assert.equal(byId.get(long).scope.chosen[0].length, 80, "a name in a scope is cut to what a partition name may be");
});

/** Three files on two devices: a backup and a dump on usb-1 (two sets of different kinds) and a dump on usb-2. */
async function twoSetsOnOneDevice(store, olderExtra = {}) {
  const backupId = await store.save("s", "a.bin", new Blob(["a"]), provenance("op-1", olderExtra));
  await new Promise((resolve) => setTimeout(resolve, 3));
  const dumpId = await store.save("s", "b.bin", new Blob(["b"]), provenance("op-2", { action: "dump", command: undefined, target: "boot" }));
  await new Promise((resolve) => setTimeout(resolve, 3));
  const otherId = await store.save("s", "c.bin", new Blob(["c"]), provenance("op-3", { deviceId: "usb-2", action: "dump", command: undefined }));
  return { backupId, dumpId, otherId };
}

test("combining a set with the older one of its device files both under one set name that survives a reload, and leaves other devices alone", async () => {
  const { store, names } = memoryStore();
  const { backupId, dumpId, otherId } = await twoSetsOnOneDevice(store);
  const sets = store.sets("s");
  assert.equal(sets.length, 3);
  const dumpSet = sets.find((set) => set.artifactIds.includes(dumpId));

  const heard = [];
  store.subscribe("s", (artifacts) => heard.push(artifacts.filter((artifact) => artifact.setName).length));
  await assert.rejects(store.combineWithOlder("s", dumpSet.id, "set:stale"), (error) => error.code === "not-found" && /no longer the one that was offered/.test(error.message), "the older backup the card offered must still be the older backup");
  const combined = await store.combineWithOlder("s", dumpSet.id, olderOf(store, dumpSet));
  assert.deepEqual([...combined.artifactIds].sort(), [backupId, dumpId].sort());
  assert.equal(combined.name, undefined, "a name nobody chose is not shown");
  assert.equal(store.sets("s").length, 2);
  assert.equal(store.sets("s").find((set) => set.artifactIds.includes(otherId)).count, 1, "the other device's file is untouched");
  assert.equal(heard.at(-1), 2, "the panel is told");
  assert.equal(names.size, 2, "one small record per file, not a rewritten file");

  // A fresh page reading the same escrow sees the same sets.
  const reloaded = new DeviceArtifactStore();
  reloaded.persistence = store.persistence;
  await reloaded.hydrate("s");
  const again = reloaded.sets("s");
  assert.equal(again.length, 2);
  assert.deepEqual(again.find((set) => set.artifactIds.includes(dumpId)).artifactIds.sort(), [backupId, dumpId].sort());
  assert.equal(await reloaded.combineWithOlder("s", again.find((set) => set.artifactIds.includes(otherId)).id, "set:none").then(() => "combined", (error) => error.code), "not-found", "nothing older on that device to combine with");
});

test("combining into a set an agent named keeps the agent's name and files only the newer files under it", async () => {
  const { store, names } = memoryStore();
  const { backupId, dumpId } = await twoSetsOnOneDevice(store, { set: "weekend backup", startedAt: Date.now() - 60_000 });
  const dumpSet = store.sets("s").find((set) => set.artifactIds.includes(dumpId));
  const combined = await store.combineWithOlder("s", dumpSet.id, olderOf(store, dumpSet));
  assert.equal(combined.name, "weekend backup");
  assert.deepEqual([...names.keys()], [`s:${dumpId}`], "the older file already carried that name");
  assert.equal(store.list("s").find((artifact) => artifact.id === backupId).setName, undefined);
  assert.equal(store.sets("s").find((set) => set.artifactIds.includes(dumpId)).count, 2);
});

test("a set cannot be combined while a transfer is reading it, and removing a file takes its filing with it", async () => {
  const { store, names } = memoryStore();
  // A server that never answers; a cancel still ends the request, as it does for a real fetch.
  store.fetchImpl = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true }));
  const { backupId, dumpId } = await twoSetsOnOneDevice(store);
  const dumpSet = store.sets("s").find((set) => set.artifactIds.includes(dumpId));
  const running = store.startServerSave("s", [backupId], { label: "backup" });
  running.finished.catch(() => undefined);
  await assert.rejects(store.combineWithOlder("s", dumpSet.id, olderOf(store, dumpSet)), (error) => error instanceof DeviceArtifactError && error.code === "busy" && /Wait until the transfer/.test(error.message));
  assert.equal(names.size, 0, "nothing was filed");
  assert.equal(store.cancelJob("s", running.jobId), true);
  await running.finished.catch(() => undefined);

  await store.combineWithOlder("s", dumpSet.id, olderOf(store, dumpSet));
  assert.equal(names.size, 2);
  assert.equal(await store.removeMany("s", [backupId]), 1);
  assert.deepEqual([...names.keys()], [`s:${dumpId}`], "the removed file's filing is gone");
  await assert.rejects(store.combineWithOlder("s", "set:missing", "set:none"), (error) => error.code === "not-found");
});

test("a session's list survives rows of another shape in the artifacts store, and a filing an earlier 0.54 build left there still names its set until it is moved", () => {
  const file = (id, name) => ({ key: `s:${id}`, sessionId: "s", artifact: { id, name, size: 1, mime: "application/octet-stream", sha256: "0".repeat(64), kind: "output", source: "device", createdAt: 1, blob: new Blob(["x"]) } });
  const stray = { key: "\u0000set-name:s:a", sessionId: "s", artifactId: "a", setName: "weekend backup" };
  const rows = [file("a", "a.bin"), stray, { key: "s:junk", sessionId: "s", something: "a later build might keep" }, null, file("b", "b.bin")];

  const { artifacts, strays } = artifactsFromRows(rows, []);
  assert.deepEqual(artifacts.map((artifact) => [artifact.id, artifact.setName]), [["a", "weekend backup"], ["b", undefined]], "every file is listed; the stray filing still applies");
  assert.deepEqual(strays, [{ key: "\u0000set-name:s:a", artifactId: "a", setName: "weekend backup" }], "only the known stray shape is handed over to be moved; unknown rows are left alone");

  const newer = artifactsFromRows(rows, [{ key: "s:a", sessionId: "s", artifactId: "a", setName: "renamed since" }, { key: "s:gone", sessionId: "s", artifactId: "gone", setName: "x" }]);
  assert.deepEqual(newer.artifacts.map((artifact) => artifact.setName), ["renamed since", undefined], "a filing in the set-names database wins over the stray, and one whose file is gone names nothing");
  assert.deepEqual(artifactsFromRows([stray], []).artifacts, [], "a filing alone is no file");
});
