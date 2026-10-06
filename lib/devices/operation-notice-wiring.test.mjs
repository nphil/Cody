import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { allowAgent, flush, untilTrustRequest } from "./trust.test-helper.mjs";

/**
 * The whole chain a pop-up travels, with nothing stubbed between the page's operation manager and the frames the
 * browser receives: operation manager -> page delegate (the frames it would put on the socket, checked by the same
 * validator the server uses) -> the session's device bridge -> the session wrapper -> the `notice` frames the chat
 * shows. An agent running ten reads must produce none, and neither must the question "Let the agent control this
 * device?" nor a countdown (the chat's input dock and the Devices panel show those); a failure, a finished dump and
 * a device that leaves while a question waits must each produce one.
 */

const root = mkdtempSync(join(tmpdir(), "cody-device-notices-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { getDeviceBridge } = await jiti.import("./bus.ts");
const { createPageOperationDelegate } = await jiti.import("./operations.ts");
const { isDeviceClientFrame } = await jiti.import("./protocol.ts");

function rig() {
  const proc = {
    isAlive: true,
    dispose: async () => {},
    onFrame() { return () => {}; },
    sendFrame() {},
    sendCommand: async () => ({}),
    sendCommandWithId: () => ({ id: "rpc-1", result: Promise.resolve({}) }),
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), { rpcUi: {}, label: "omp", relaunch: () => ({}) });
  wrapper.start();
  const sessionId = `notice-wiring-${randomUUID()}`;
  wrapper.setSessionId(sessionId);
  const bridge = getDeviceBridge(sessionId);
  bridge.setDevices([{ id: "usb-1", kind: "usb", label: "Lenovo Smart Display", open: false }]);

  const notices = [];
  wrapper.observeEvents((event) => { if (event.type === "notice" && event.source === "device") notices.push(event); });

  const state = { identity: "usb:18d1:4ee0:UNIT1" };
  const provider = {
    async borrowHardwareTransport() {
      return { transport: { kind: "usb", async read() { return null; }, async write() {} }, identity: state.identity, async release() {} };
    },
    currentIdentity: () => state.identity,
    describeDevice: () => ({ label: "Lenovo Smart Display" }),
  };
  const flasher = {
    protocol: "fastboot",
    actions: ["exec", "dump"],
    async run(request, context) {
      context.progress({ phase: "talking", message: "to the device" });
      for (let line = 0; line < 5; line += 1) context.output?.(`(bootloader) line ${line}`);
      if (request.command?.startsWith("fail")) throw new Error(`the device refused ${request.command}`);
      if (request.command === "reboot-bootloader") {
        await context.confirm({ action: "fastboot command", target: "reboot-bootloader", backup: "Not applicable: reboot changes mode." });
        return { summary: "Fastboot accepted reboot-bootloader." };
      }
      if (request.action === "dump") return { summary: "Saved boot_a (64 MiB)" };
      return { summary: `${request.command} ok` };
    },
  };
  const delegate = createPageOperationDelegate(sessionId, provider, { async getInput() { return undefined; }, async save() { return "artifact"; } }, [flasher]);
  // What the page's socket does with every frame: the server checks it is well formed, then files it with the bridge.
  const page = {
    ...provider,
    sendOperationProgress(frame) { assert.ok(isDeviceClientFrame(frame), `a well-formed ${frame.type} frame`); bridge.receiveOperationProgress(frame); },
    sendOperationSnapshot(frame) { assert.ok(isDeviceClientFrame(frame), `a well-formed ${frame.type} frame`); bridge.receiveOperationSnapshot(frame); },
    sendOperationResult(frame) { assert.ok(isDeviceClientFrame(frame), `a well-formed ${frame.type} frame`); bridge.receiveOperationResult(frame); },
  };
  let next = 0;
  const run = async (request) => {
    const operationId = `op-${next += 1}`;
    await delegate.start({ type: "operation.start", id: String(next), operationId, request: { deviceId: "usb-1", protocol: "fastboot", action: "exec", ...request } }, page);
    return operationId;
  };
  const finish = async (operationId) => {
    for (let turn = 0; turn < 60; turn += 1) {
      const current = delegate.manager.status(operationId);
      if (current && ["succeeded", "failed", "cancelled"].includes(current.state)) return current;
      await flush();
    }
    throw new Error(`operation ${operationId} never finished`);
  };
  return { wrapper, bridge, delegate, notices, run, finish, page };
}

test("ten routine reads from an agent raise no pop-up at all - not for the question, starting, progress, output or finishing", async () => {
  const { wrapper, delegate, notices, run, finish } = rig();
  try {
    const ids = [];
    for (let index = 0; index < 10; index += 1) ids.push(await run({ command: `getvar var${index}` }));
    const asked = await untilTrustRequest(delegate.manager, "usb-1");
    assert.equal(asked.waiting, 10, "ten reads, one question");
    assert.deepEqual(notices, [], "the question is shown in the chat's input dock, not as a pop-up");
    await allowAgent(delegate.manager, { deviceId: "usb-1" });
    for (const id of ids) assert.equal((await finish(id)).state, "succeeded");
    await flush();
    assert.deepEqual(notices.map((notice) => notice.message), [], "the Devices panel groups them; the chat stays quiet");
  } finally { await wrapper.destroyAndWait(); }
});

test("the trust question and the countdown are no pop-up, and a command that is allowed, counted down and succeeds adds none", async (t) => {
  const { wrapper, delegate, notices, run, finish } = rig();
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
    const id = await run({ command: "reboot-bootloader", options: { sendDelaySeconds: 1 } });
    await untilTrustRequest(delegate.manager, "usb-1");
    assert.deepEqual(notices, [], "waiting for the person's answer is not announced");

    await allowAgent(delegate.manager, { deviceId: "usb-1" });
    for (let turn = 0; turn < 60 && delegate.manager.status(id).state !== "countdown"; turn += 1) await flush();
    assert.equal(delegate.manager.status(id).state, "countdown");
    assert.deepEqual(notices, [], "counting down is not announced either");
    t.mock.timers.tick(1_000);
    assert.equal((await finish(id)).state, "succeeded");
    assert.deepEqual(notices, [], "a command the person allowed that then succeeds quickly is not news");
  } finally {
    t.mock.timers.reset(); // a mocked clearTimeout cannot clear the wrapper's real timers
    await wrapper.destroyAndWait();
  }
});

test("a failure is a pop-up, and a run of failures is one pop-up and one summary", async (t) => {
  const { wrapper, delegate, notices, run, finish } = rig();
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
    const ids = [];
    for (let index = 0; index < 6; index += 1) ids.push(await run({ command: `fail${index}` }));
    await allowAgent(delegate.manager, { deviceId: "usb-1" });
    for (const id of ids) assert.equal((await finish(id)).state, "failed");
    assert.equal(notices.length, 1, "the first failure is shown at once, the other five are held");
    assert.match(notices[0].message, /^fastboot fail0 on Lenovo Smart Display failed: the device refused fail0$/);

    t.mock.timers.tick(5_000);
    assert.equal(notices.length, 2);
    assert.match(notices[1].message, /^5 more device operations failed or were cancelled\. Latest: fastboot fail5/);
  } finally {
    t.mock.timers.reset();
    await wrapper.destroyAndWait();
  }
});

test("saying no is not a pop-up: every operation the agent had queued fails with the sentence, and the chat stays quiet", async () => {
  const { wrapper, delegate, notices, run, finish } = rig();
  try {
    const ids = [];
    for (let index = 0; index < 4; index += 1) ids.push(await run({ command: `getvar var${index}` }));
    const asked = await untilTrustRequest(delegate.manager, "usb-1");
    await delegate.manager.answerTrust(asked.id, { allow: false });
    for (const id of ids) {
      const refused = await finish(id);
      assert.equal(refused.state, "failed");
      assert.equal(refused.error, "The user declined control of Lenovo Smart Display; do not ask again until they reconnect it");
    }
    await flush();
    assert.deepEqual(notices.map((notice) => notice.message), [], "the person knows: they just said it");
  } finally { await wrapper.destroyAndWait(); }
});

test("a device that leaves while the question waits is one warning that says why, and a finished dump is one success pop-up", async () => {
  const { wrapper, delegate, notices, run, finish } = rig();
  try {
    const reboot = await run({ command: "reboot-bootloader" });
    await untilTrustRequest(delegate.manager, "usb-1");
    await delegate.manager.deviceDisconnected("usb-1");
    assert.equal((await finish(reboot)).state, "cancelled");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "warning");
    assert.match(notices[0].message, /was cancelled: The device left the USB bus before the question about it was answered/);

    const dump = await run({ action: "dump", target: "boot_a", command: undefined });
    await allowAgent(delegate.manager, { deviceId: "usb-1" });
    assert.equal((await finish(dump)).state, "succeeded");
    assert.equal(notices.length, 2);
    assert.equal(notices[1].level, "success");
    assert.match(notices[1].message, /^fastboot dump boot_a on Lenovo Smart Display finished: Saved boot_a \(64 MiB\)$/);
  } finally { await wrapper.destroyAndWait(); }
});

test("a page that reconnects and replays every finished operation it remembers announces none of them", async () => {
  const source = rig();
  const restarted = rig();
  try {
    const failed = await source.run({ command: "fail-old" });
    await allowAgent(source.delegate.manager, { deviceId: "usb-1" });
    await source.finish(failed);
    const dump = await source.run({ action: "dump", target: "boot_a", command: undefined });
    await source.finish(dump);
    assert.equal(source.notices.length, 2, "while they happened, the first server did announce them");

    // The restarted server has no memory of these operations; the page re-sends every one it remembers when its socket opens.
    source.delegate.snapshot({
      ...source.page,
      sendOperationProgress: (frame) => restarted.bridge.receiveOperationProgress(frame),
      sendOperationSnapshot: (frame) => restarted.bridge.receiveOperationSnapshot(frame),
      sendOperationResult: (frame) => restarted.bridge.receiveOperationResult(frame),
    });
    assert.equal(restarted.bridge.operationSnapshots().length, 2, "the replay did reach the new server");
    assert.deepEqual(restarted.notices, [], "and none of it was mistaken for news");
  } finally {
    await source.wrapper.destroyAndWait();
    await restarted.wrapper.destroyAndWait();
  }
});

test("a dump whose browser went silent is filed as failed, and its real finish arriving on reconnect is announced", async (t) => {
  const { wrapper, bridge, delegate, notices, run, finish, page } = rig();
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
    const hostLeaves = bridge.attach(() => {});
    const dump = await run({ action: "dump", target: "boot_a", command: undefined });
    await untilTrustRequest(delegate.manager, "usb-1");

    // The browser goes quiet for longer than the bridge waits, so the bridge can only file "completion unknown".
    hostLeaves();
    t.mock.timers.tick(65_000);
    assert.equal(bridge.operationStatus(dump).state, "failed");
    assert.match(bridge.operationStatus(dump).error, /completion is unknown/);

    // The page never stopped: its socket was just down, so what it says is lost. The person answers and the dump finishes.
    await delegate.status({ type: "operation.status", id: "s" }, { ...page, sendOperationProgress() {}, sendOperationSnapshot() {}, sendOperationResult() {} });
    await allowAgent(delegate.manager, { deviceId: "usb-1" });
    assert.equal((await finish(dump)).state, "succeeded");
    assert.equal(bridge.operationStatus(dump).state, "failed", "the server still holds the placeholder");

    // The socket comes back: hello with the devices, then every operation the page remembers.
    bridge.attach(() => {});
    bridge.setDevices([{ id: "usb-1", kind: "usb", label: "Lenovo Smart Display", open: false }]);
    delegate.snapshot(page);
    assert.equal(bridge.operationStatus(dump).state, "succeeded", "the real outcome replaced the placeholder");

    const told = notices.filter((notice) => /^device:(failed|done)/.test(notice.dedupeKey)).map((notice) => notice.message);
    assert.equal(told.length, 2, told.join(" | "));
    assert.match(told[0], /^fastboot dump boot_a failed: .*completion is unknown/);
    assert.match(told[1], /^fastboot dump boot_a on Lenovo Smart Display finished: Saved boot_a \(64 MiB\)$/, "the correction is not swallowed because a failure was already filed");
    assert.deepEqual(notices.filter((notice) => /approv|trust|control of|answer/i.test(notice.message)), [], "the question that was open all that time raised no pop-up");
  } finally {
    t.mock.timers.reset();
    await wrapper.destroyAndWait();
  }
});
