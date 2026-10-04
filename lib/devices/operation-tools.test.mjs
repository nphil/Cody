import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { APPROVAL_TIMING_NOTE, DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

function tool(name) {
  const found = DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

function bridge() {
  const starts = [];
  const cancels = [];
  const sends = [];
  return {
    attached: true,
    list() { return [{ id: "serial-1", label: "Bench UART", kind: "serial", open: true }]; },
    async startOperation(request) { starts.push(request); return "operation-1"; },
    async cancelOperation(id) { cancels.push(id); },
    async sendOperation(id, text) { sends.push({ id, text }); },
    operationStatus() { return undefined; },
    starts,
    cancels,
    sends,
  };
}

test("flash starts a durable operation with a bound artifact and never accepts approval options", async () => {
  const fake = bridge();
  const flash = tool("device_flash");
  const text = await flash.handler({
    device: "serial-1",
    protocol: "esp",
    target: "factory",
    offset: 0,
    fileId: "artifact-input",
    sha256: "a".repeat(64),
    options: { safety: { chip: "esp32" } },
  }, { bridge: fake });
  assert.match(text, /operation-1.*accepted/i);
  assert.deepEqual(fake.starts, [{
    deviceId: "serial-1",
    protocol: "esp",
    action: "flash",
    target: "factory",
    offset: 0,
    fileId: "artifact-input",
    sha256: "a".repeat(64),
    options: { safety: { chip: "esp32" } },
  }]);

  const blocked = await flash.handler({
    device: "serial-1",
    protocol: "esp",
    fileId: "artifact-input",
    sha256: "a".repeat(64),
    options: { approved: true },
  }, { bridge: fake });
  assert.match(blocked, /cannot carry an approval/i);
  assert.equal(fake.starts.length, 1);
});

test("monitor send and cancellation address a specific durable operation", async () => {
  const fake = bridge();
  const send = tool("device_monitor_send");
  const cancel = tool("device_operation_cancel");
  assert.match(await send.handler({ operationId: "operation-1", text: "status\n" }, { bridge: fake }), /sent monitor input/i);
  assert.match(await cancel.handler({ operationId: "operation-1" }, { bridge: fake }), /cancellation was sent/i);
  assert.deepEqual(fake.sends, [{ id: "operation-1", text: "status\n" }]);
  assert.deepEqual(fake.cancels, ["operation-1"]);
});

function adbBridge() {
  const fake = bridge();
  fake.list = () => [{ id: "usb-1", label: "Phone", kind: "usb", open: true }];
  return fake;
}

test("port forwarding tools start ADB operations with validated addresses and no approval path", async () => {
  const fake = adbBridge();
  const forward = tool("device_forward");
  assert.match(await forward.handler({ device: "usb-1", target: "tcp:8080", local: "tcp:9000" }, { bridge: fake }), /operation-1.*accepted.*confirmation in the Devices panel/is);
  assert.match(await tool("device_reverse").handler({ device: "usb-1", target: "tcp:0", local: "tcp:3000" }, { bridge: fake }), /accepted/);
  assert.deepEqual(fake.starts, [
    { protocol: "adb", action: "forward", deviceId: "usb-1", target: "tcp:8080", options: { local: "tcp:9000" } },
    { protocol: "adb", action: "reverse", deviceId: "usb-1", target: "tcp:0", options: { local: "tcp:3000" } },
  ]);

  const before = fake.starts.length;
  assert.match(await forward.handler({ device: "usb-1", target: "tcp:8080", local: "tcp:80" }, { bridge: fake }), /1024 or above/);
  assert.match(await forward.handler({ device: "usb-1", target: "shell:", local: "tcp:9000" }, { bridge: fake }), /must start with/);
  assert.match(await forward.handler({ device: "usb-1", target: "tcp:8080", local: "localabstract:x" }, { bridge: fake }), /must be tcp:PORT/);
  assert.match(await forward.handler({ device: "usb-1", protocol: "fastboot", target: "tcp:8080", local: "tcp:9000" }, { bridge: fake }), /ADB feature/);
  assert.match(await forward.handler({ device: "usb-1", target: "tcp:8080", local: "tcp:9000", options: { approved: true } }, { bridge: fake }), /cannot carry an approval/);
  assert.equal(fake.starts.length, before, "nothing invalid reaches the browser");
});

test("device-side reverse rules are managed through exec kinds that need no shell command", async () => {
  const fake = adbBridge();
  const exec = tool("device_exec");
  await exec.handler({ device: "usb-1", protocol: "adb", options: { kind: "reverse-list" } }, { bridge: fake });
  await exec.handler({ device: "usb-1", protocol: "adb", target: "tcp:8081", options: { kind: "reverse-remove" } }, { bridge: fake });
  assert.deepEqual(fake.starts.map((request) => [request.action, request.options.kind]), [["exec", "reverse-list"], ["exec", "reverse-remove"]]);
  assert.match(await exec.handler({ device: "usb-1", protocol: "adb" }, { bridge: fake }), /requires command/);
});

test("device_tunnels lists, removes, and bulk-removes only this session's forward and reverse operations", async () => {
  const snapshot = (id, action, state, extra = {}) => ({ id, state, request: { protocol: "adb", action, deviceId: "usb-1", target: "tcp:8080", options: { local: "tcp:9000" } }, ...extra });
  const fake = adbBridge();
  const snapshots = [
    snapshot("op-live", "forward", "running"),
    snapshot("op-waiting", "reverse", "awaiting-confirmation", { confirmation: { id: "c", binding: {} } }),
    snapshot("op-done", "forward", "cancelled"),
    { id: "op-shell", state: "running", request: { protocol: "adb", action: "exec", deviceId: "usb-1" } },
  ];
  fake.tunnels = { list: () => [{ operationId: "op-live", port: 41000, connections: 2, bytesToDevice: 10, bytesFromDevice: 20 }] };
  fake.operationSnapshots = () => snapshots;
  fake.operationStatus = (id) => snapshots.find((entry) => entry.id === id);
  const tunnels = tool("device_tunnels");
  const listing = await tunnels.handler({}, { bridge: fake });
  assert.match(listing, /op-live.*forward tcp:41000 \(127\.0\.0\.1\) -> device tcp:8080.*2 open connection\(s\)/);
  assert.match(listing, /op-waiting.*waiting for the user's confirmation/);
  assert.doesNotMatch(listing, /op-done|op-shell/);

  assert.match(await tunnels.handler({ action: "remove", operationId: "op-shell" }, { bridge: fake }), /not a forward\/reverse rule/);
  assert.match(await tunnels.handler({ action: "remove", operationId: "op-done" }, { bridge: fake }), /already ended/);
  assert.match(await tunnels.handler({ action: "remove", operationId: "op-live" }, { bridge: fake }), /Removal was sent/);
  assert.match(await tunnels.handler({ action: "remove_all" }, { bridge: fake }), /Removal was sent for 2 rule/);
  assert.deepEqual(fake.cancels, ["op-live", "op-live", "op-waiting"]);
  assert.match(await tunnels.handler({ action: "explode" }, { bridge: fake }), /must be list, remove, or remove_all/);
});

test("options.sendDelaySeconds is checked before anything reaches the browser, is passed through untouched, and never counts as an approval", async () => {
  const fake = adbBridge();
  const exec = tool("device_exec");
  const reboot = (options) => ({ device: "usb-1", protocol: "fastboot", command: "reboot-bootloader", options });

  const accepted = await exec.handler(reboot({ sendDelaySeconds: 20 }), { bridge: fake });
  assert.match(accepted, /operation-1.*accepted/i);
  assert.match(accepted, /sends it 20 s after the user approves/, "the agent is told what will happen and what to tell the user");
  assert.match(accepted, /approve first and then get ready/);
  assert.deepEqual(fake.starts, [{ protocol: "fastboot", action: "exec", deviceId: "usb-1", command: "reboot-bootloader", options: { sendDelaySeconds: 20 } }]);
  assert.doesNotMatch(await exec.handler(reboot(undefined), { bridge: fake }), /after the user approves/, "without the option the answer says nothing about a wait");

  const before = fake.starts.length;
  for (const bad of [0, -5, 1.5, 301, "10", null, true, [20]]) {
    assert.match(await exec.handler(reboot({ sendDelaySeconds: bad }), { bridge: fake }), /options\.sendDelaySeconds must be a whole number of seconds from 1 to 300/, JSON.stringify(bad));
  }
  assert.equal(fake.starts.length, before, "no bad value reaches the browser");
  assert.match(await exec.handler(reboot({ sendDelaySeconds: 5, approved: true }), { bridge: fake }), /cannot carry an approval/);
  assert.match(await exec.handler(reboot({ sendDelaySeconds: 5, confirm: true }), { bridge: fake }), /cannot carry an approval/);
  assert.equal(fake.starts.length, before);
});

test("the wait is documented once, in every start tool that can ask for approval and in the shared options schema, and nowhere that never asks", () => {
  for (const name of ["device_exec", "device_flash", "device_dump", "device_push", "device_sideload", "device_install"]) {
    assert.ok(tool(name).description.endsWith(APPROVAL_TIMING_NOTE), `${name} carries the note`);
    assert.match(tool(name).parameters.properties.options.description, /sendDelaySeconds/, `${name}: the options schema names the key`);
  }
  for (const name of ["device_detect", "device_pull", "device_verify", "device_monitor"]) assert.doesNotMatch(tool(name).description, /sendDelaySeconds/, name);
  assert.match(APPROVAL_TIMING_NOTE, /1 to 300/);
  assert.match(APPROVAL_TIMING_NOTE, /does not time out/, "the agent is told an unanswered approval is not timed out");
  assert.match(APPROVAL_TIMING_NOTE, /refused if the device is no longer the one approved/);
});

test("the status an agent reads says an unanswered approval has no time limit, and what an approved one is waiting for", async () => {
  const fake = adbBridge();
  const binding = { action: "fastboot command", target: "reboot-bootloader", backup: "n/a" };
  const base = { id: "op-1", state: "awaiting-confirmation", request: { protocol: "fastboot", action: "exec", deviceId: "usb-1" }, output: [], events: [] };
  const status = tool("device_operation_status");

  fake.operationStatus = () => ({ ...base, confirmation: { id: "c", binding, sendDelaySeconds: 20 } });
  const waiting = await status.handler({ operationId: "op-1" }, { bridge: fake });
  assert.match(waiting, /Awaiting direct UI confirmation for fastboot command on reboot-bootloader/);
  assert.match(waiting, /no time limit.*until the user answers.*cancelled.*leaves the USB bus/);
  assert.match(waiting, /sent 20 s later/);

  fake.operationStatus = () => ({ ...base, state: "armed", armed: { approvedAt: 1_000, releaseAt: 31_000, expiresAt: 41_000, binding } });
  const armed = await status.handler({ operationId: "op-1" }, { bridge: fake });
  assert.match(armed, /Operation op-1: armed\./);
  assert.match(armed, /The user approved fastboot command on reboot-bootloader; it is sent 30 s after the approval/);
  assert.match(armed, /Nothing has been sent yet/);

  fake.operationStatus = () => ({ ...base, state: "cancelled", error: "The device left the USB bus during the countdown, so the approval was dropped and the command was not sent. Nothing was changed on the device." });
  assert.match(await status.handler({ operationId: "op-1" }, { bridge: fake }), /Error: The device left the USB bus during the countdown/, "a system cancel arrives with its reason");
});
