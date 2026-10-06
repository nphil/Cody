import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceArtifactError, DeviceArtifactStore, authorizedArtifactDownloadUrl } = await jiti.import("./artifacts.ts");

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

/** A store whose escrow is a Map, so the rest of the store is exercised without a browser database. */
function memoryStore() {
  const store = new DeviceArtifactStore();
  const rows = new Map();
  store.persistence = {
    async put(sessionId, artifact) { rows.set(`${sessionId}:${artifact.id}`, { sessionId, artifact }); },
    async get(sessionId, id) { return rows.get(`${sessionId}:${id}`)?.artifact; },
    async list(sessionId) { return [...rows.values()].filter((row) => row.sessionId === sessionId).map((row) => row.artifact); },
    async delete(sessionId, id) { rows.delete(`${sessionId}:${id}`); },
  };
  return { store, rows };
}

const provenance = (operationId, extra = {}) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK", ...extra });

test("a saved output keeps which operation made it and the CRC-32 a zip entry needs, and an input keeps neither", async () => {
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

test("an error carries a code the panel can act on and a message it can show as it is", () => {
  const error = new DeviceArtifactError("The server has no room.", "disk-full");
  assert.equal(error.code, "disk-full");
  assert.equal(new DeviceArtifactError("plain").code, "unknown");
  assert.ok(error instanceof Error && error.name === "DeviceArtifactError");
});
