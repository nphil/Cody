import assert from "node:assert/strict";
import test from "node:test";
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
