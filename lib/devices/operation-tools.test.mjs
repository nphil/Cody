import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_TRUST_NOTE, DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

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

test("flash starts a durable operation with a bound artifact, and the request carries nothing that could grant control", async () => {
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
  assert.doesNotMatch(text, /approv|confirm/i, "there is no approval step to tell the agent about");
  const parameters = Object.keys(flash.parameters.properties);
  for (const name of parameters) assert.doesNotMatch(name, /trust|approv|allow|remember|consent|confirm/i, `no tool argument can answer the question: ${name}`);
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

test("port forwarding tools start ADB operations with validated addresses and say nothing about approval", async () => {
  const fake = adbBridge();
  const forward = tool("device_forward");
  const accepted = await forward.handler({ device: "usb-1", target: "tcp:8080", local: "tcp:9000" }, { bridge: fake });
  assert.match(accepted, /operation-1.*accepted/i);
  assert.match(accepted, /device_operation_status shows the bound host port/);
  assert.doesNotMatch(accepted, /confirmation|approv/i, "a port rule asks nothing of the user beyond the device's one trust question");
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
    snapshot("op-waiting", "reverse", "awaiting-trust"),
    snapshot("op-done", "forward", "cancelled"),
    { id: "op-shell", state: "running", request: { protocol: "adb", action: "exec", deviceId: "usb-1" } },
  ];
  fake.tunnels = { list: () => [{ operationId: "op-live", port: 41000, connections: 2, bytesToDevice: 10, bytesFromDevice: 20 }] };
  fake.operationSnapshots = () => snapshots;
  fake.operationStatus = (id) => snapshots.find((entry) => entry.id === id);
  const tunnels = tool("device_tunnels");
  const listing = await tunnels.handler({}, { bridge: fake });
  assert.match(listing, /op-live.*forward tcp:41000 \(127\.0\.0\.1\) -> device tcp:8080.*2 open connection\(s\)/);
  assert.match(listing, /op-waiting.*waiting for the user to trust the device/);
  assert.doesNotMatch(listing, /op-done|op-shell/);

  assert.match(await tunnels.handler({ action: "remove", operationId: "op-shell" }, { bridge: fake }), /not a forward\/reverse rule/);
  assert.match(await tunnels.handler({ action: "remove", operationId: "op-done" }, { bridge: fake }), /already ended/);
  assert.match(await tunnels.handler({ action: "remove", operationId: "op-live" }, { bridge: fake }), /Removal was sent/);
  assert.match(await tunnels.handler({ action: "remove_all" }, { bridge: fake }), /Removal was sent for 2 rule/);
  assert.deepEqual(fake.cancels, ["op-live", "op-live", "op-waiting"]);
  assert.match(await tunnels.handler({ action: "explode" }, { bridge: fake }), /must be list, remove, or remove_all/);
});

test("options.sendDelaySeconds is checked before anything reaches the browser, is passed through untouched, and is described as a countdown, never an approval", async () => {
  const fake = adbBridge();
  const exec = tool("device_exec");
  const reboot = (options) => ({ device: "usb-1", protocol: "fastboot", command: "reboot-bootloader", options });

  const accepted = await exec.handler(reboot({ sendDelaySeconds: 20 }), { bridge: fake });
  assert.match(accepted, /operation-1.*accepted/i);
  assert.match(accepted, /counts down 20 s, visibly and with a Cancel button, before it sends the first command/, "the agent is told what will happen and what to tell the user");
  assert.match(accepted, /so they can get ready/);
  assert.doesNotMatch(accepted, /approv/i);
  assert.deepEqual(fake.starts, [{ protocol: "fastboot", action: "exec", deviceId: "usb-1", command: "reboot-bootloader", options: { sendDelaySeconds: 20 } }]);
  assert.doesNotMatch(await exec.handler(reboot(undefined), { bridge: fake }), /counts down/, "without the option the answer says nothing about a wait");

  const before = fake.starts.length;
  for (const bad of [0, -5, 1.5, 301, "10", null, true, [20]]) {
    assert.match(await exec.handler(reboot({ sendDelaySeconds: bad }), { bridge: fake }), /options\.sendDelaySeconds must be a whole number of seconds from 1 to 300/, JSON.stringify(bad));
  }
  assert.equal(fake.starts.length, before, "no bad value reaches the browser");
});

test("the trust note is written once: on every start tool that takes control of a device, on none that only reads, and the options schema calls the wait a countdown", () => {
  const controlling = ["device_exec", "device_flash", "device_dump", "device_push", "device_pull", "device_sideload", "device_install", "device_verify", "device_monitor", "device_forward", "device_reverse"];
  for (const name of controlling) {
    assert.ok(tool(name).description.endsWith(DEVICE_TRUST_NOTE), `${name} carries the note`);
    assert.equal(tool(name).description.split(DEVICE_TRUST_NOTE).length, 2, `${name} carries it once`);
  }
  for (const name of ["device_detect", "device_operation_status", "device_operation_cancel", "device_tunnels", "device_monitor_send"]) {
    assert.doesNotMatch(tool(name).description, /one-time trust|declined control/, `${name} asks nothing, so it says nothing`);
  }
  for (const name of ["device_detect", "device_exec", "device_flash", "device_dump", "device_push", "device_pull", "device_sideload", "device_install", "device_verify", "device_monitor"]) {
    const schema = tool(name).parameters.properties.options.description;
    assert.match(schema, /sendDelaySeconds \(1-300\)/, `${name}: the options schema names the key`);
    assert.match(schema, /countdown, with a Cancel button/, `${name}: and calls it a countdown`);
    assert.match(schema, /It is not an approval/, `${name}: and not an approval`);
  }
  assert.match(DEVICE_TRUST_NOTE, /once in the chat/, "one question, in the chat");
  assert.match(DEVICE_TRUST_NOTE, /others queue behind that one question/);
  assert.match(DEVICE_TRUST_NOTE, /nothing else asks for approval afterwards/);
  assert.match(DEVICE_TRUST_NOTE, /The user declined control of <device>; do not ask again until they reconnect it/, "the agent is told the exact refusal and what to do about it");
  assert.match(DEVICE_TRUST_NOTE, /no time limit/, "an unanswered question is not timed out");
  for (const { name, description } of DEVICE_OPERATION_TOOLS) {
    assert.doesNotMatch(description, /Devices panel to (review|approve)|typed override|shell grant|direct (browser )?(UI )?confirmation|requires direct approval|write:NAME|restore:</i, `${name} describes no approval step`);
  }
});

test("the status an agent reads says an unanswered question has no time limit, what a countdown is waiting for, and why the system cancelled", async () => {
  const fake = adbBridge();
  const binding = { action: "fastboot command", target: "reboot-bootloader", backup: "n/a" };
  const base = { id: "op-1", state: "awaiting-trust", request: { protocol: "fastboot", action: "exec", deviceId: "usb-1" }, output: [], events: [] };
  const status = tool("device_operation_status");

  fake.operationStatus = () => base;
  const waiting = await status.handler({ operationId: "op-1" }, { bridge: fake });
  assert.match(waiting, /Operation op-1: awaiting-trust\./);
  assert.match(waiting, /Waiting for the user to trust this device: Cody asked them once, in the chat/);
  assert.match(waiting, /every operation on it queues behind that one answer/);
  assert.match(waiting, /no time limit.*when they answer.*when you cancel it.*leaves the USB bus/);
  assert.match(waiting, /Nothing has been sent to the device/);

  fake.operationStatus = () => ({ ...base, state: "countdown", riskDeclared: true, countdown: { startedAt: 1_000, releaseAt: 31_000, binding } });
  const counting = await status.handler({ operationId: "op-1" }, { bridge: fake });
  assert.match(counting, /Operation op-1: countdown\./);
  assert.match(counting, /Counting down to fastboot command on reboot-bootloader: it is sent 30 s after the countdown started unless the user cancels it or the device changes/);
  assert.match(counting, /Nothing has been sent yet/);
  assert.doesNotMatch(counting, /approv/i);

  fake.operationStatus = () => ({ ...base, state: "failed", error: "The user declined control of Phone; do not ask again until they reconnect it" });
  assert.match(await status.handler({ operationId: "op-1" }, { bridge: fake }), /Error: The user declined control of Phone; do not ask again until they reconnect it/, "a refusal reaches the agent in the words it must act on");

  fake.operationStatus = () => ({ ...base, state: "cancelled", error: "The device left the USB bus during the countdown, so the command was not sent. Nothing was changed on the device." });
  assert.match(await status.handler({ operationId: "op-1" }, { bridge: fake }), /Error: The device left the USB bus during the countdown/, "a system cancel arrives with its reason");
});

const START_TOOLS = ["device_detect", "device_flash", "device_dump", "device_exec", "device_push", "device_pull", "device_sideload", "device_install", "device_verify", "device_monitor"];

test("set names the backup an operation belongs to: it is trimmed and put on the request, and one that cannot be used is refused before anything reaches the browser", async () => {
  const fake = adbBridge();
  const dump = tool("device_dump");
  const base = { device: "usb-1", protocol: "edl", target: "boot_a" };

  assert.match(await dump.handler({ ...base, set: "  Cronos tablet 2026-10-07  " }, { bridge: fake }), /operation-1.*accepted/i);
  assert.match(await dump.handler({ ...base, set: "x".repeat(80) }, { bridge: fake }), /accepted/, "eighty characters is the longest");
  assert.match(await dump.handler(base, { bridge: fake }), /accepted/);
  assert.deepEqual(fake.starts.map((request) => request.set), ["Cronos tablet 2026-10-07", "x".repeat(80), undefined]);
  assert.equal("set" in fake.starts[2], false, "without a name the request carries no key for it");

  const before = fake.starts.length;
  for (const bad of ["", "   ", "x".repeat(81), "two\nlines", "tab\there", "\u0001combined-1", 7, ["a"], { name: "a" }, true]) {
    assert.equal(await dump.handler({ ...base, set: bad }, { bridge: fake }), "set must be 1 to 80 characters without control characters.", JSON.stringify(bad));
  }
  assert.equal(fake.starts.length, before, "no unusable name reaches the browser");
});

test("a backup of chosen partitions reaches the browser as the agent wrote it, under the name it gave", async () => {
  const fake = adbBridge();
  await tool("device_exec").handler({ device: "usb-1", protocol: "edl", command: "backup", set: "Cronos tablet 2026-10-07", options: { partitions: ["boot_a", "partition 4"] } }, { bridge: fake });
  assert.deepEqual(fake.starts, [{ protocol: "edl", action: "exec", deviceId: "usb-1", command: "backup", options: { partitions: ["boot_a", "partition 4"] }, set: "Cronos tablet 2026-10-07" }]);
});

test("every tool that starts an operation takes the backup name; the port-rule tools take none", () => {
  for (const name of START_TOOLS) {
    const set = tool(name).parameters.properties.set;
    assert.equal(set?.type, "string", `${name} takes set`);
  }
  for (const name of ["device_forward", "device_reverse"]) assert.equal("set" in tool(name).parameters.properties, false, `${name} makes no backup`);
});
