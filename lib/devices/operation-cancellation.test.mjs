import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { flush } from "./trust.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ACQUIRE_STALL_MS, DeviceOperationManager } = await jiti.import("./operations.ts");
const { describeEvidence } = await jiti.import("./operation-evidence.ts");
const { UsbInterfaceClaimError } = await jiti.import("./usb-acquisition.ts");
const deviceId = "usb-1";
const detect = { deviceId, protocol: "adb", action: "detect" };
const verify = { deviceId, protocol: "adb", action: "verify", target: "/test-file" };
const artifacts = { async getInput() { return undefined; }, async save() { return "artifact-output"; } };

function inertLease(generation, release, write = async () => {}) {
  return { generation, transport: { kind: "usb", async read() { return null; }, write }, release };
}

test("Cancel finishes a stalled acquisition while its late connection is quarantined and closed unused", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const open = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const started = Promise.withResolvers();
  const firmware = new Blob(["fixture"]);
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", await firmware.arrayBuffer())).toString("hex");
  let runs = 0;
  let releases = 0;
  let writes = 0;
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport(_device, options) {
      options.onProgress({ step: "opening the device", generation: 7 });
      started.resolve(options);
      await open.promise;
      return inertLease(7, async () => { releases += 1; await cleanup.promise; }, async () => { writes += 1; });
    },
  }, { ...artifacts, async getInput() { return firmware; } }, [{
    protocol: "adb", actions: ["push"],
    async run(_request, context) {
      runs += 1;
      await context.transport.write(new Uint8Array([1]), context.signal);
      return { summary: "written" };
    },
  }]);
  const snapshots = [];
  manager.subscribe((snapshot) => snapshots.push(snapshot));

  const { id } = manager.startUser({ deviceId, protocol: "adb", action: "push", target: "/test-file", fileId: "test-artifact", sha256 });
  const { signal, onProgress } = await started.promise;
  const opening = snapshots.at(-1);
  assert.equal(opening.stage.waitingFor, "browser");
  assert.equal(opening.lease.step, "opening the device");
  onProgress({ step: "claiming interface 0", generation: 7 });
  assert.equal(snapshots.at(-1).lease.step, "claiming interface 0", "the stage is published before the claim returns");
  t.mock.timers.tick(ACQUIRE_STALL_MS);
  const stalled = snapshots.at(-1);
  assert.equal(stalled.lease.stalled, true);
  assert.match(describeEvidence(stalled).join("\n"), /looks stuck.*\n.*\n.*Unplug the USB cable/);

  const cancelling = manager.cancel(id);
  assert.equal(cancelling.state, "cancelling");
  assert.equal(cancelling.cancellation.at, Date.now());
  assert.equal(cancelling.cancellation.source, "user");
  assert.equal(cancelling.cancellation.stage, "acquiring");
  assert.match(cancelling.cancellation.reason, /Cancelled by the person/);
  assert.deepEqual(snapshots.at(-1).cancellation, cancelling.cancellation, "the event sent to the panel already says why");
  assert.equal(signal.aborted, true);
  await flush();
  const done = manager.status(id);
  assert.equal(done.state, "cancelled");
  assert.equal(done.stage, undefined);
  assert.equal(done.lease.state, "quarantined");
  assert.equal(done.lease.nativeGeneration, 7);
  assert.equal(done.lease.sent, undefined);
  assert.match(describeEvidence(done).join("\n"), /This operation sent nothing/);
  assert.deepEqual([runs, writes, releases], [0, 0, 0]);

  open.resolve();
  await flush();
  assert.equal(manager.status(id).lease.state, "quarantined", "opening late is not proof of cleanup");
  assert.deepEqual([runs, writes, releases], [0, 0, 1]);
  cleanup.resolve();
  await flush();
  assert.equal(manager.status(id).lease.state, "released");
  assert.deepEqual([runs, writes, releases], [0, 0, 1]);
});

test("ADB waiters cancel independently; the next verify does not join their abandoned claim", async () => {
  const claim = Promise.withResolvers();
  let borrows = 0;
  let occupancy = 0;
  let generation = 0;
  let openingSignal;
  const closed = [];
  const runs = [];
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport(_device, options) {
      borrows += 1;
      if (occupancy) throw new Error("Device is exclusively reserved by an active hardware operation.");
      occupancy += 1;
      const current = ++generation;
      if (current === 1) {
        openingSignal = options.signal;
        options.onProgress({ step: "claiming interface 0", generation: current });
        await claim.promise;
      }
      return inertLease(current, async () => { occupancy -= 1; closed.push(current); });
    },
  }, artifacts, [{ protocol: "adb", actions: ["detect", "verify"], async run(request) {
    runs.push(request.action);
    return { summary: "verified", verified: true };
  } }]);
  const opener = manager.startUser(detect).id;
  await flush();
  const waiter = manager.startUser(verify).id;
  await flush();
  assert.equal(borrows, 1);
  assert.equal(manager.status(waiter).stage.operationId, opener);
  assert.match(describeEvidence(manager.status(waiter)).join("\n"), /waiting behind operation/);

  manager.cancel(waiter, { source: "agent" });
  await flush();
  assert.equal(manager.status(waiter).state, "cancelled");
  assert.equal(manager.status(waiter).cancellation.source, "agent");
  assert.equal(openingSignal.aborted, false, "the opener still wants the shared connection");
  manager.cancel(opener);
  await flush();
  assert.equal(manager.status(opener).state, "cancelled");
  assert.equal(openingSignal.aborted, true);

  const blocked = manager.startUser(verify).id;
  await flush();
  const refusal = manager.status(blocked);
  assert.equal(refusal.state, "failed");
  assert.ok(refusal.error.includes(opener), "the refusal names the operation holding the abandoned claim");
  assert.match(refusal.error, /claiming interface 0.*Unplug the USB cable/);
  assert.equal(borrows, 2, "the next verify asks afresh instead of joining the old promise");
  claim.resolve();
  await flush();
  assert.deepEqual(closed, [1], "the one underlying lease for both cancelled operations was released once");
  assert.deepEqual(runs, []);
  assert.equal(occupancy, 0);

  const regranted = manager.startUser(verify).id;
  await flush();
  assert.equal(manager.status(regranted).state, "succeeded");
  assert.equal(manager.status(regranted).lease.nativeGeneration, 2);
  assert.deepEqual(runs, ["verify"], "only the independent verify runs");
  assert.deepEqual(closed, [1, 2]);
  assert.equal(occupancy, 0);
});

test("claim rejection, host replacement and device departure report distinct outcomes", async (t) => {
  for (const scenario of ["rejected", "host-authority", "device-left"]) {
    await t.test(scenario, async () => {
      const claim = Promise.withResolvers();
      const manager = new DeviceOperationManager("session-a", {
        async borrowHardwareTransport(_device, options) {
          options.onProgress({ step: "claiming interface 0", generation: 1 });
          if (scenario === "host-authority") {
            const cancelled = Promise.withResolvers();
            options.signal.addEventListener("abort", () => {
              const usbCleanup = claim.promise.catch(() => undefined);
              cancelled.reject(Object.assign(new DOMException("Cancelled", "AbortError"), { usbCleanup }));
            }, { once: true });
            return cancelled.promise;
          }
          return claim.promise;
        },
      }, artifacts);
      const { id } = manager.startUser(detect);
      await flush();
      assert.equal(manager.status(id).lease.step, "claiming interface 0");
      if (scenario !== "rejected") {
        const stopped = scenario === "host-authority"
          ? manager.revokeAuthority("Device host authority replaced.")
          : manager.deviceDisconnected(deviceId);
        const stopping = manager.status(id);
        assert.equal(stopping.cancellation.source, scenario);
        assert.match(stopping.cancellation.reason, /authority replaced|left the USB bus/);
        await flush();
        assert.equal(manager.status(id).state, "cancelled", "the browser has not finished the claim, but the operation has stopped");
        assert.equal(manager.status(id).lease.state, "quarantined", "an abort reply is not proof the native reservation is free");
        await stopped;
        assert.equal(manager.status(id).error, stopping.cancellation.reason);
      }
      claim.reject(new Error("Unable to claim interface"));
      await flush();
      const done = manager.status(id);
      assert.equal(done.lease.state, "failed");
      assert.equal(done.state, scenario === "rejected" ? "failed" : "cancelled");
      if (scenario === "rejected") assert.equal(done.error, "Unable to claim interface");
    });
  }
});

test("wait-for-device does not keep trying a refused browser claim", async () => {
  let attempts = 0;
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport() {
      attempts += 1;
      throw new UsbInterfaceClaimError({ interfaceNumber: 0 }, new DOMException("Unable to claim interface", "NetworkError"));
    },
  }, artifacts);
  const { id } = manager.startUser({ deviceId, protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds: 1 } });
  await flush();
  const done = manager.status(id);
  assert.equal(done.state, "failed", "the refusal ends the wait rather than scheduling another claim");
  assert.match(done.error, /Unable to claim interface.*will not retry/);
  assert.equal(attempts, 1);
});

test("transport evidence counts submitted bytes but never treats a rejected or unfinished write as sent", async () => {
  const transfer = Promise.withResolvers();
  const manager = new DeviceOperationManager("session-a", {
    async borrowHardwareTransport() {
      const lease = inertLease(1, async () => {}, async (data) => { if (data.length === 5) await transfer.promise; });
      lease.transport.controlOut = async () => { throw new Error("transfer status unknown"); };
      lease.transport.serialPort = {};
      return lease;
    },
  }, artifacts, [{ protocol: "adb", actions: ["verify"], async run(_request, { transport, signal }) {
    assert.ok(transport.serialPort);
    await transport.write(new Uint8Array(3), signal);
    await assert.rejects(transport.controlOut({}, new Uint8Array(4), signal), /unknown/);
    await transport.write(new Uint8Array(5), signal);
    return { summary: "verified", verified: true };
  } }]);
  const { id } = manager.startUser(verify);
  await flush();
  const live = manager.status(id);
  assert.deepEqual(live.lease.sent, { confirmed: { requests: 1, bytes: 3 }, unconfirmed: { requests: 2, bytes: 9 }, incomplete: true, shared: true });
  const text = describeEvidence(live).join("\n");
  assert.match(text, /3 bytes submitted.*not a file size/);
  assert.match(text, /2 further requests \(9 bytes\).*unknown/);
  assert.match(text, /totals are a minimum/);
  transfer.resolve();
  await flush();
  const done = manager.status(id);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(done.lease.sent.confirmed, { requests: 2, bytes: 8 });
  assert.deepEqual(done.lease.sent.unconfirmed, { requests: 1, bytes: 4 });
});
