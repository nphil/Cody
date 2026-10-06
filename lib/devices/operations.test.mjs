import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { allowAgent } from "./trust.test-helper.mjs";

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

const serialProvider = (counts = {}) => ({
  async borrowHardwareTransport() {
    return {
      transport: { kind: "serial", async read() { return null; }, async write() {} },
      async release() { counts.releases = (counts.releases ?? 0) + 1; },
    };
  },
});

test("a flasher declares what it is about to send: the manager checks it against the request, logs it, and asks nobody", async () => {
  const counts = {};
  const firmware = new Blob(["firmware"]);
  const firmwareSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", await firmware.arrayBuffer())).toString("hex");
  const flasher = {
    protocol: "esp",
    actions: ["flash"],
    async run(_request, context) {
      context.progress({ phase: "preflight", completed: 1, total: 2 });
      await context.confirm({ action: "flash", target: "boot", offset: 0, backup: "verified backup" });
      counts.sent = (counts.sent ?? 0) + 1;
      return { summary: "verified" };
    },
  };
  const manager = new DeviceOperationManager("session-a", serialProvider(counts), {
    async getInput() { return firmware; },
    async save() { return "artifact-output"; },
  }, [flasher]);

  const { id } = manager.startUser({ protocol: "esp", action: "flash", deviceId: "serial-1", target: "boot", offset: 0, fileId: "firmware", sha256: firmwareSha256 });
  const done = await waitFor(() => { const snapshot = manager.status(id); return snapshot?.state === "succeeded" && snapshot; }, "operation never completed");
  assert.equal(counts.releases, 1);
  assert.equal(counts.sent, 1);
  assert.equal(done.riskDeclared, true);
  assert.deepEqual(done.events.filter((event) => event.type === "declared").map((event) => event.declared), [
    { action: "flash", target: "boot", sha256: firmwareSha256, offset: 0, length: undefined, programSha256: undefined, programOffset: undefined, programLength: undefined, details: undefined, backup: "verified backup" },
  ], "the exact action, target, range and digest are on the record before anything is sent");
  assert.match(done.output.map((row) => row.line).join("\n"), /Starting flash on boot\. Backup: verified backup/);
  assert.deepEqual(manager.trustRequests(), [], "declaring a risk asked nobody");
});

test("a declaration that differs from the request fails the operation before anything is sent", async () => {
  const firmware = new Blob(["firmware"]);
  const firmwareSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", await firmware.arrayBuffer())).toString("hex");
  const base = { action: "flash", target: "boot", offset: 0, length: 8, backup: "verified backup" };
  const attempts = [
    ["a different target", { ...base, target: "system" }, /declared target differs from the requested target/],
    ["a different offset", { ...base, offset: 4096 }, /declared payload offset differs/],
    ["a different length", { ...base, length: 16 }, /declared payload length differs/],
    ["a different digest", { ...base, sha256: "b".repeat(64) }, /declared payload digest differs from the verified artifact/],
    ["no backup status", { ...base, backup: " " }, /needs an action, target, and backup status/],
    ["a widened footprint without its digest", { ...base, programOffset: 0, programLength: 16 }, /requires its image digest, offset, and length/],
    ["a footprint that does not contain the payload", { ...base, programSha256: "c".repeat(64), programOffset: 4, programLength: 2 }, /must contain the exact requested payload range/],
  ];
  for (const [what, risk, pattern] of attempts) {
    let sent = 0;
    const flasher = { protocol: "esp", actions: ["flash"], async run(_request, context) { await context.confirm(risk); sent += 1; return { summary: "written" }; } };
    const manager = new DeviceOperationManager("session-a", serialProvider(), { async getInput() { return firmware; }, async save() { return "artifact-output"; } }, [flasher]);
    const { id } = manager.startUser({ protocol: "esp", action: "flash", deviceId: "serial-1", target: "boot", offset: 0, length: 8, fileId: "firmware", sha256: firmwareSha256 });
    const failed = await waitFor(() => { const snapshot = manager.status(id); return snapshot?.state === "failed" && snapshot; }, `${what}: the operation did not fail`);
    assert.match(failed.error, pattern, what);
    assert.equal(sent, 0, `${what}: nothing was sent`);
    assert.equal(failed.riskDeclared, undefined, `${what}: it declared nothing the manager accepted`);
  }
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

  const { id } = manager.startUser({
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
  await allowAgent(manager, { deviceId: "serial-1" });
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
