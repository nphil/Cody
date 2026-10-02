import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceOperationManager } = await jiti.import("./operations.ts");

async function waitFor(getter, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = getter();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

test("operation confirmation is one-use and bound to its exact target", async () => {
  let releases = 0;
  const firmware = new Blob(["firmware"]);
  const firmwareSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", await firmware.arrayBuffer())).toString("hex");
  const flasher = {
    protocol: "esp",
    actions: ["flash"],
    async run(_request, context) {
      context.progress({ phase: "preflight", completed: 1, total: 2 });
      await context.confirm({ action: "flash", target: "boot", offset: 0, backup: "verified backup" });
      return { summary: "verified" };
    },
  };
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport() {
      return {
        transport: {
          kind: "serial",
          async read() { return null; },
          async write() {},
        },
        async release() { releases += 1; },
      };
    },
  }, {
    async getInput() { return firmware; },
    async save() { return "artifact-output"; },
  }, [flasher]);

  const { id } = manager.start({ protocol: "esp", action: "flash", deviceId: "serial-1", target: "boot", offset: 0, fileId: "firmware", sha256: firmwareSha256 });
  const awaiting = await waitFor(() => manager.status(id)?.confirmation, "operation never requested confirmation");
  assert.throws(() => manager.confirm(id, awaiting.id, { ...awaiting.binding, target: "system" }), /no longer matches/);
  manager.confirm(id, awaiting.id, awaiting.binding);
  const complete = await waitFor(() => manager.status(id)?.state === "succeeded", "operation never completed");
  assert.equal(complete, true);
  assert.equal(releases, 1);
  assert.throws(() => manager.confirm(id, awaiting.id, awaiting.binding), /not awaiting/);
});

test("artifact digest mismatch fails before obtaining an exclusive hardware lease", async () => {
  let borrowed = false;
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport() {
      borrowed = true;
      throw new Error("must not borrow");
    },
  }, {
    async getInput() { return new Blob(["different bytes"]); },
    async save() { return "artifact-output"; },
  });

  const { id } = manager.start({
    protocol: "esp",
    action: "flash",
    deviceId: "serial-1",
    fileId: "artifact-input",
    sha256: "0".repeat(64),
  });
  const failed = await waitFor(() => manager.status(id)?.state === "failed", "operation did not fail on a stale artifact");
  assert.equal(failed, true);
  assert.equal(borrowed, false);
  assert.match(manager.status(id)?.error ?? "", /changed after/i);
});


test("cancelling while lease release is pending reaches a terminal cancelled state", async () => {
  let finishRelease;
  let releaseStarted = false;
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport() {
      return {
        transport: { kind: "serial", async read() { return null; }, async write() {} },
        async release() {
          releaseStarted = true;
          await new Promise((resolve) => { finishRelease = resolve; });
        },
      };
    },
  }, {
    async getInput() { return undefined; },
    async save() { return "artifact-output"; },
  }, [{
    protocol: "esp",
    actions: ["detect"],
    async run() { return { summary: "detected" }; },
  }]);

  const { id } = manager.start({ protocol: "esp", action: "detect", deviceId: "serial-1" });
  await waitFor(() => releaseStarted, "operation never began lease release");
  manager.cancel(id);
  finishRelease();
  assert.equal(await waitFor(() => manager.status(id)?.state === "cancelled", "operation was left cancelling"), true);
});

test("monitor cancellation never replays queued input", async () => {
  let releaseFirstWrite;
  const writes = [];
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport() {
      return {
        transport: {
          kind: "serial",
          async read(_length, _timeout, signal) {
            return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
          },
          async write(bytes) {
            writes.push(new TextDecoder().decode(bytes));
            await new Promise((resolve) => { releaseFirstWrite = resolve; });
          },
        },
        async release() {},
      };
    },
  }, {
    async getInput() { return undefined; },
    async save() { return "artifact-output"; },
  });

  const { id } = manager.start({ protocol: "serial", action: "monitor", deviceId: "serial-1" });
  await waitFor(() => manager.status(id)?.state === "running", "monitor never started");
  const first = manager.send(id, "first\n");
  const queued = manager.send(id, "second\n");
  await waitFor(() => writes.length === 1, "first monitor input was not sent");
  manager.cancel(id);
  releaseFirstWrite();
  await first;
  await assert.rejects(queued, /cancelled/i);
  assert.deepEqual(writes, ["first\n"]);
});


test("a protected operation cannot confirm without the exact typed override", async () => {
  let writes = 0;
  const flasher = { protocol: "adb", actions: ["exec"], async run(_request, context) {
    await context.confirm({action:"adb.push.raw",target:"/dev/block/mmcblk0p9",protectedOverride:"write:/dev/block/mmcblk0p9",backup:"saved full partition backup"});
    writes++; return {summary:"written"};
  }};
  const manager = new DeviceOperationManager("test", {async borrowHardwareTransport(){return {transport:{kind:"usb"},async release(){}};}}, {async getInput(){},async save(){}}, [flasher]);
  const {id} = manager.start({deviceId:"usb",protocol:"adb",action:"exec",command:"push"});
  const confirmation = await waitFor(() => manager.status(id)?.confirmation, "no confirmation");
  assert.throws(() => manager.confirm(id,confirmation.id,confirmation.binding), /exact protected-target/);
  assert.throws(() => manager.confirm(id,confirmation.id,confirmation.binding,"write:/dev/block/mmcblk0p1"), /exact protected-target/);
  assert.equal(writes,0);
  manager.confirm(id,confirmation.id,confirmation.binding,"write:/dev/block/mmcblk0p9");
  await waitFor(()=>manager.status(id)?.state === "succeeded", "not completed");
  assert.equal(writes,1);
});