import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { allowAgent, flush, untilTrustRequest } from "./trust.test-helper.mjs";

/**
 * What the store is told about an operation with every file it saves: when the flasher began working with the device,
 * the name the agent gave the backup, and which partitions the backup holds once it has said. The real operation manager
 * runs a fake flasher against a store that remembers what each save was given, so the grouping of backups into one set
 * has the facts it needs after a reload, when no operation snapshot exists any more.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceOperationManager } = await jiti.import("./operations.ts");

const START = 1_000_000;
const MINUTE = 60_000;
const DEVICE = "usb-device-1";

/** A flasher that does whatever `script` says with its context, a store that remembers every save, and the manager between them. */
function rig(script) {
  const saves = [];
  const provider = {
    async borrowHardwareTransport() {
      return { transport: { kind: "usb", async read() { return null; }, async write() {} }, async release() {} };
    },
    describeDevice: () => ({ label: "Lenovo Smart Display" }),
  };
  const artifacts = {
    async getInput() { return undefined; },
    async save(_session, name, _blob, provenance) {
      saves.push({ name, provenance });
      return `file-${saves.length}`;
    },
    async saveStream(_session, name, chunks, _signal, provenance) {
      let length = 0;
      for await (const chunk of chunks) length += chunk.byteLength;
      saves.push({ name, provenance });
      return { fileId: `file-${saves.length}`, sha256: "0".repeat(64), length };
    },
  };
  const flasher = { protocol: "edl", actions: ["exec", "dump"], async run(_request, context) { await script(context); return { summary: "done" }; } };
  return { manager: new DeviceOperationManager("session-a", provider, artifacts, [flasher]), saves };
}

const request = (extra = {}) => ({ protocol: "edl", action: "exec", deviceId: DEVICE, command: "backup", ...extra });

/** Waits (without timers, which a test may have stopped) until the operation is over. */
async function settled(manager, id) {
  for (let turn = 0; turn < 200; turn += 1) {
    const snapshot = manager.status(id);
    if (["succeeded", "failed", "cancelled"].includes(snapshot.state)) return snapshot;
    await flush(2);
  }
  throw new Error(`the operation never ended (${manager.status(id).state})`);
}

async function* bytes() {
  yield new Uint8Array([1, 2, 3]);
}

test("every file records when the flasher began working with the device: not when the operation was asked for, and not when the file arrived", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  let secondReadDone;
  const { manager, saves } = rig(async (context) => {
    await context.save("first.bin", new Blob(["a"]));
    await new Promise((resolve) => { secondReadDone = resolve; });
    await context.save("second.bin", new Blob(["b"]));
  });
  const { id } = manager.start(request());
  await untilTrustRequest(manager, DEVICE);
  t.mock.timers.tick(10 * MINUTE);
  await allowAgent(manager, { deviceId: DEVICE });
  await flush();
  assert.equal(saves.length, 1, "the first file is saved as soon as the flasher is let in");

  t.mock.timers.tick(25 * MINUTE);
  secondReadDone();
  const done = await settled(manager, id);
  assert.equal(done.state, "succeeded", done.error);
  assert.equal(done.createdAt, START, "the operation was asked for at the start");
  assert.deepEqual(saves.map((save) => save.provenance.startedAt), [START + 10 * MINUTE, START + 10 * MINUTE], "the person answered ten minutes later, and the second file arrived twenty-five minutes after that");
});

test("a file's provenance is exactly the operation, the device, the command, the start time and the device's name, and nothing about a name or scope nobody gave", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { manager, saves } = rig(async (context) => { await context.save("a.bin", new Blob(["a"])); });
  const dump = manager.startUser({ protocol: "edl", action: "dump", deviceId: DEVICE, target: "boot_a" });
  const backup = manager.startUser(request());
  await settled(manager, dump.id);
  await settled(manager, backup.id);
  assert.deepEqual(saves.map((save) => save.provenance), [
    { operationId: dump.id, deviceId: DEVICE, protocol: "edl", action: "dump", target: "boot_a", label: "Lenovo Smart Display", startedAt: START },
    { operationId: backup.id, deviceId: DEVICE, protocol: "edl", action: "exec", command: "backup", label: "Lenovo Smart Display", startedAt: START },
  ]);
});

test("the agent's set name is on every file the operation saves, whichever way it saves it, and on the operation's own request; without one, no file carries a name", async () => {
  const saveBoth = async (context) => {
    await context.save("a.bin", new Blob(["a"]));
    await context.saveStream("b.bin", bytes());
  };
  const named = rig(saveBoth);
  const { id } = named.manager.startUser(request({ set: "Cronos tablet 2026-10-07" }));
  const done = await settled(named.manager, id);
  assert.equal(done.request.set, "Cronos tablet 2026-10-07", "the snapshot the panel and the agent read carries it");
  assert.deepEqual(named.saves.map((save) => [save.name, save.provenance.set]), [["a.bin", "Cronos tablet 2026-10-07"], ["b.bin", "Cronos tablet 2026-10-07"]]);

  const plain = rig(saveBoth);
  const unnamed = plain.manager.startUser(request());
  const finished = await settled(plain.manager, unnamed.id);
  assert.equal("set" in finished.request, false);
  assert.deepEqual(plain.saves.map((save) => "set" in save.provenance), [false, false]);
});

test("a declared scope is on the files saved after the declaration and on none saved before it; a later declaration replaces it, and another operation never inherits it", async () => {
  const first = { chosen: ["boot_a"], all: ["boot_a", "system_a"] };
  const second = { chosen: ["boot_a", "system_a"], all: ["boot_a", "system_a"] };
  const { manager, saves } = rig(async (context) => {
    await context.save("before.bin", new Blob(["1"]));
    if (context.operation.id === declaring) {
      context.declareScope(first);
      await context.save("after.bin", new Blob(["2"]));
      await context.saveStream("streamed.bin", bytes());
      context.declareScope(second);
    }
    await context.save("last.bin", new Blob(["3"]));
  });
  let declaring;
  const one = manager.startUser(request());
  declaring = one.id;
  await settled(manager, one.id);
  assert.deepEqual(saves.map((save) => [save.name, save.provenance.scope]), [["before.bin", undefined], ["after.bin", first], ["streamed.bin", first], ["last.bin", second]]);
  assert.equal("scope" in saves[0].provenance, false, "a file saved before the declaration has no scope at all");

  const other = manager.startUser(request());
  await settled(manager, other.id);
  assert.deepEqual(saves.slice(4).map((save) => [save.name, "scope" in save.provenance]), [["before.bin", false], ["last.bin", false]], "a scope belongs to the operation that declared it");
});

test("a scope that is not a list of 1 to 1024 names of 1 to 80 characters, with no more chosen than listed, fails the operation and files nothing under it", async () => {
  const names = (count) => Array.from({ length: count }, (_, index) => `p${index}`);
  const listRule = /^A backup's (chosen|listed) partitions must be a list of 1 to 1024 names of 1 to 80 characters\.$/;
  for (const [what, scope, pattern] of [
    ["no scope at all", undefined, listRule],
    ["an empty list", { chosen: [], all: ["a"] }, listRule],
    ["names that are not text", { chosen: [5], all: ["a"] }, listRule],
    ["an empty name", { chosen: [""], all: ["a"] }, listRule],
    ["a name that is too long", { chosen: ["x".repeat(81)], all: ["a"] }, listRule],
    ["something that is not a list", { chosen: "a", all: ["a"] }, listRule],
    ["more than 1024 names", { chosen: ["a"], all: names(1025) }, listRule],
    ["more chosen than listed", { chosen: ["a", "b"], all: ["a"] }, /^A backup cannot take more partitions than the device listed\.$/],
  ]) {
    const { manager, saves } = rig(async (context) => {
      context.declareScope(scope);
      await context.save("after.bin", new Blob(["x"]));
    });
    const { id } = manager.startUser(request());
    const done = await settled(manager, id);
    assert.equal(done.state, "failed", what);
    assert.match(done.error, pattern, what);
    assert.deepEqual(saves, [], what);
  }

  const widest = { chosen: ["x".repeat(80)], all: [...names(1023), "x".repeat(80)] };
  const { manager, saves } = rig(async (context) => {
    context.declareScope(widest);
    await context.save("after.bin", new Blob(["x"]));
  });
  const { id } = manager.startUser(request());
  assert.equal((await settled(manager, id)).state, "succeeded");
  assert.deepEqual(saves[0].provenance.scope, widest, "1024 names of 80 characters is the most there can be");
});

test("the manager refuses a set name that is not usable even when the tools were bypassed, and leaves no operation behind", () => {
  const { manager } = rig(async () => {});
  for (const bad of ["", "   ", " padded ", "x".repeat(81), "two\nlines", "\u0001combined-1", 5, ["a"], null]) {
    assert.throws(() => manager.startUser(request({ set: bad })), /^Error: set must be 1 to 80 characters without control characters\.$/, JSON.stringify(bad));
    assert.throws(() => manager.start(request({ set: bad })), /set must be 1 to 80 characters without control characters\./, JSON.stringify(bad));
  }
  assert.deepEqual(manager.snapshots(), [], "a refused request leaves nothing behind");
  assert.equal(manager.startUser(request({ set: "x".repeat(80) })).snapshot.request.set, "x".repeat(80), "eighty characters is the longest");
});
