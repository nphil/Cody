import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { setupFakeServer } from "./artifact-vault.test-helper.mjs";

/**
 * An agent saving a backup to the server, end to end: its tool, the bridge that carries the request to the page, the
 * page's own save (the same code the button runs) against the real vault handlers, and the status the agent reads back.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceBridge } = await jiti.import("./bus.ts");
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");
const { DeviceArtifactStore } = await jiti.import("./artifacts.ts");
const { parseArtifactSaveFrame, resolveSelection, runArtifactSave } = await jiti.import("./artifact-agent.ts");
const server = await setupFakeServer();

const tool = (name) => DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
const provenance = (operationId) => ({ operationId, deviceId: "usb-1", protocol: "edl", action: "exec", command: "backup", label: "Lenovo QUSB__BULK" });

/** A chat: a store holding a backup, a bridge whose page is that store, and the fake server the page uploads to. */
async function chat(fetchWrapper) {
  const fake = server.fakeServer();
  const store = new DeviceArtifactStore({ fetch: fetchWrapper ? fetchWrapper(fake.fetch) : fake.fetch, retryDelaysMs: [0, 0, 0] });
  const rows = new Map();
  store.persistence = {
    async put(sessionId, artifact) { rows.set(artifact.id, artifact); },
    async get(sessionId, id) { return rows.get(id); },
    async list() { return [...rows.values()]; },
    async delete(sessionId, id) { rows.delete(id); },
  };
  const contents = [];
  for (const [index, size] of [6000, 0, 9000].entries()) {
    const bytes = randomBytes(size);
    contents.push(bytes);
    await store.save("chat-1", `edl-1a2b-set-p${index}-part${index}.bin`, new Blob([bytes]), provenance("op-backup"));
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
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

test("an agent names an operation, the page uploads that operation's files, and the answer is the folder and how to check it", async () => {
  const { bridge, store, contents, asked } = await chat();
  const answer = await tool("device_artifacts_save").handler({ operationId: "op-backup" }, { bridge });

  assert.deepEqual(asked[0].selection, { operationIds: ["op-backup"] });
  assert.match(answer, /was started: 3 files, 14\.6 KB|was started: 3 files/);
  const folder = /Saved to the server: (.+)/.exec(answer)?.[1];
  assert.ok(folder, answer);
  assert.match(folder, /-Lenovo-QUSB__BULK-EDL-backup$/, "labelled by the device and what ran");
  assert.match(answer, /each SHA-256 matched/);
  assert.ok(answer.includes(`cd '${folder}' && sha256sum -c SHA256SUMS`));
  assert.ok(answer.includes(join(folder, "manifest.json")));
  for (const [index, bytes] of contents.entries()) assert.ok(readFileSync(join(folder, `edl-1a2b-set-p${index}-part${index}.bin`)).equals(bytes));
  assert.equal(existsSync(join(folder, "other.bin")), false, "only the named operation's files");

  const job = store.jobs("chat-1").at(-1);
  assert.equal(job.origin, "agent", "the panel lists it as the agent's");
  assert.equal(job.state, "succeeded");

  const status = await tool("device_artifacts_status").handler({}, { bridge });
  assert.match(status, new RegExp(`Saved to the server: ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("saving the same files again says they are already there, and a slow save is followed with the status tool", async () => {
  const gate = Promise.withResolvers();
  const { bridge } = await chat((realFetch) => async (input, init) => {
    if ((init?.method ?? "GET") === "PUT") await gate.promise;
    return realFetch(input, init);
  });
  const running = await tool("device_artifacts_save").handler({ all: true, waitSeconds: 0 }, { bridge });
  assert.match(running, /was started: 4 files/);
  assert.match(running, /is still uploading: 0 of 4 files verified/);
  assert.match(running, /only while the Cody tab stays open/);
  assert.match(running, /device_artifacts_status \(saveId [0-9a-f]{32}\)/);
  const saveId = /saveId ([0-9a-f]{32})/.exec(running)[1];
  assert.match(await tool("device_artifacts_status").handler({ saveId }, { bridge }), /is still uploading/);

  gate.resolve();
  let done = "";
  for (let attempt = 0; attempt < 100 && !/Saved to the server/.test(done); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    done = await tool("device_artifacts_status").handler({ saveId }, { bridge });
  }
  assert.match(done, /Saved to the server: /);
  assert.match(await tool("device_artifacts_save").handler({ all: true }, { bridge }), /was already on the server: 4 files/);
});

test("the tool refuses what it cannot do in words an agent can act on", async () => {
  const { bridge } = await chat();
  assert.match(await tool("device_artifacts_save").handler({}, { bridge }), /Say what to save: operationId/);
  assert.match(await tool("device_artifacts_save").handler({ fileIds: "nope" }, { bridge }), /fileIds must be a list/);
  const missing = await tool("device_artifacts_save").handler({ operationId: "op-nothing" }, { bridge });
  assert.match(missing, /Could not start the save: Nothing saved in this chat matches operation op-nothing/);
  assert.match(await tool("device_artifacts_save").handler({ fileIds: ["no-such-file"] }, { bridge }), /matches file no-such-file/);

  assert.match(await tool("device_artifacts_status").handler({}, { bridge }), /No save has been started from this chat yet/);
  assert.match(await tool("device_artifacts_status").handler({ saveId: "0".repeat(32) }, { bridge }), /was not started by this chat's agent/);

  const detached = new DeviceBridge();
  assert.match(await tool("device_artifacts_save").handler({ all: true }, { bridge: detached }), /No browser is attached to this session/);
});

test("the page names only what this chat holds, in the order it was saved, and a frame that is not a save request is ignored", async () => {
  const { store } = await chat();
  const files = store.list("chat-1");
  const names = (selection) => resolveSelection(files, selection).map((file) => file.name);
  assert.deepEqual(names({ operationIds: ["op-backup"] }), ["edl-1a2b-set-p0-part0.bin", "edl-1a2b-set-p1-part1.bin", "edl-1a2b-set-p2-part2.bin"]);
  assert.equal(names({ all: true }).length, 4);
  assert.deepEqual(names({ fileIds: [files.find((file) => file.name === "other.bin").id] }), ["other.bin"]);
  assert.throws(() => resolveSelection([], { all: true }), /no saved device files/);

  const frame = { type: "artifacts.save", id: "7", selection: { operationIds: ["a"], fileIds: [1], all: "yes", extra: true }, label: "  My label  " };
  assert.deepEqual(parseArtifactSaveFrame(frame), { type: "artifacts.save", id: "7", selection: { operationIds: ["a"] }, label: "My label" });
  assert.equal(parseArtifactSaveFrame({ type: "op", id: "1" }), null);
  assert.equal(parseArtifactSaveFrame("{nope"), null);
  assert.equal(parseArtifactSaveFrame({ type: "artifacts.save", id: 7, selection: {} }), null);
});
