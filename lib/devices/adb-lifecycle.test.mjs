import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { bootingTransport, sandboxDevice } from "./adb-device.test-helper.mjs";
import { allowAgent } from "./trust.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { adbFlasher, adbTcpListeners } = await jiti.import("./adb.ts");
const { DeviceOperationManager } = await jiti.import("./operations.ts");
const { DeviceBridge } = await jiti.import("./bus.ts");
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

const posix = process.platform !== "win32";
const artifacts = { async getInput() {}, async save() { return "saved"; } };
const until = async (check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) {
    const value = check();
    if (value) return value;
  }
  throw new Error("Expected state was not reached");
};
const finished = (manager, id) => until(() => ["succeeded", "failed", "cancelled"].includes(manager.status(id).state) && manager.status(id));

function context(device, over = {}) {
  const ctx = {
    transport: device.transport,
    signal: new AbortController().signal,
    declared: [],
    outputs: [],
    events: [],
    progress: (event) => ctx.events.push(event),
    output: (text) => ctx.outputs.push(text),
    confirm: async (risk) => { ctx.declared.push(risk); },
    ...over,
  };
  return ctx;
}
const exec = (ctx, options) => adbFlasher.run({ protocol: "adb", action: "exec", options }, ctx);

/** Runs a restart request against a first adbd and the restarted one it reconnects to. */
async function restartRun(options, { answer, before = {}, after = {} }) {
  const first = sandboxDevice({ answers: answer, props: before });
  const second = sandboxDevice({ props: after });
  const ctx = context(first);
  ctx.reacquireTransport = async () => { ctx.transport = second.transport; return second.transport; };
  const outcome = await exec(ctx, options).then((result) => ({ result }), (error) => ({ error }));
  return { ...outcome, first, second, ctx };
}
const USB_ANSWER = { "usb:": "restarting in USB mode\n" };
const tcpAnswer = (port) => ({ [`tcpip:${port}`]: `restarting in TCP mode port: ${port}\n` });

// ---------------------------------------------------------------------------
// adbd's effective TCP listener configuration
// ---------------------------------------------------------------------------

const LISTENERS_OFF = { "service.adb.listen_addrs": "", "service.adb.tcp.port": "", "persist.adb.tcp.port": "", "persist.adb.tls_server.enable": "", "service.adb.tls.port": "" };

test("adbd's listener order is applied the way adbd applies it", () => {
  const effective = (properties) => adbTcpListeners({ ...LISTENERS_OFF, ...properties }).effective;
  assert.equal(effective({}), undefined, "nothing set: USB only");
  assert.deepEqual(effective({ "service.adb.tcp.port": "5555" }), { source: "service.adb.tcp.port", addresses: ["tcp:5555"] });
  assert.deepEqual(effective({ "persist.adb.tcp.port": "5555" }), { source: "persist.adb.tcp.port", addresses: ["tcp:5555"] });
  assert.equal(effective({ "service.adb.tcp.port": "0", "persist.adb.tcp.port": "5555" }), undefined, "an explicit 0 overrides the persisted port, which is how adb usb works");
  assert.deepEqual(effective({ "service.adb.tcp.port": "5556", "persist.adb.tcp.port": "5555" }), { source: "service.adb.tcp.port", addresses: ["tcp:5556"] });
  assert.deepEqual(effective({ "service.adb.listen_addrs": "tcp:5037, vsock:5037", "service.adb.tcp.port": "5555" }), { source: "service.adb.listen_addrs", addresses: ["tcp:5037", "vsock:5037"] }, "fixed addresses beat every port");
  assert.equal(effective({ "service.adb.tcp.port": "junk" }), undefined);
});

test("Wireless debugging is a listener of its own: the switch or the published TLS port says it is on, whatever the legacy port is", () => {
  const wireless = (properties) => adbTcpListeners({ ...LISTENERS_OFF, ...properties }).wireless;
  assert.equal(wireless({}), undefined);
  assert.equal(wireless({ "persist.adb.tls_server.enable": "0", "service.adb.tls.port": "0" }), undefined, "switched off and nothing published");
  assert.deepEqual(wireless({ "persist.adb.tls_server.enable": "1" }), { source: "persist.adb.tls_server.enable" });
  assert.deepEqual(wireless({ "service.adb.tls.port": "37099" }), { source: "service.adb.tls.port", port: 37099 });
  assert.deepEqual(wireless({ "persist.adb.tls_server.enable": "1", "service.adb.tls.port": "37099" }), { source: "service.adb.tls.port", port: 37099 }, "the port it really listens on is the better evidence");
  assert.equal(wireless({ "persist.adb.tls_server.enable": "true" }), undefined, "adbd starts its TLS server for the value 1 only");
  const usbMode = adbTcpListeners({ ...LISTENERS_OFF, "service.adb.tcp.port": "0", "persist.adb.tls_server.enable": "1", "service.adb.tls.port": "37099" });
  assert.equal(usbMode.effective, undefined, "adb usb leaves the legacy listener off");
  assert.ok(usbMode.wireless, "and does nothing to the wireless one");
});

test("usb and tcpip verify what adbd will really listen on, so an overriding property is never mistaken for success", { skip: !posix }, async () => {
  // usb: the fixed addresses stay, so the device is still reachable over the network.
  const fixed = await restartRun({ kind: "usb" }, { answer: USB_ANSWER, after: { "service.adb.tcp.port": "0", "service.adb.listen_addrs": "tcp:5555" } });
  assert.equal(fixed.result.verified, false);
  assert.match(fixed.result.summary, /still listens on TCP: tcp:5555 \(from service\.adb\.listen_addrs\)/);
  assert.equal(fixed.result.details.observed.effective.source, "service.adb.listen_addrs");
  // usb: a persisted port survives when the service port is merely unset, but not when it is an explicit 0.
  const persisted = await restartRun({ kind: "usb" }, { answer: USB_ANSWER, after: { "persist.adb.tcp.port": "5555" } });
  assert.equal(persisted.result.verified, false);
  assert.match(persisted.result.summary, /tcp:5555 \(from persist\.adb\.tcp\.port\)/);
  const overridden = await restartRun({ kind: "usb" }, { answer: USB_ANSWER, after: { "service.adb.tcp.port": "0", "persist.adb.tcp.port": "5555" } });
  assert.equal(overridden.result.verified, true);

  // tcpip: fixed addresses that do not include the port override it.
  const overriding = await restartRun({ kind: "tcpip", port: 5555 }, { answer: tcpAnswer(5555), after: { "service.adb.tcp.port": "5555", "service.adb.listen_addrs": "tcp:5037" } });
  assert.equal(overriding.result.verified, false);
  assert.match(overriding.result.summary, /fixed listener addresses tcp:5037 \(from service\.adb\.listen_addrs\) override the port adb tcpip sets/);
  const wrongPort = await restartRun({ kind: "tcpip", port: 5555 }, { answer: tcpAnswer(5555), after: { "service.adb.tcp.port": "5556" } });
  assert.equal(wrongPort.result.verified, false);
  assert.match(wrongPort.result.summary, /reports tcp:5556 \(from service\.adb\.tcp\.port\), not tcp:5555/);
  const included = await restartRun({ kind: "tcpip", port: 5555 }, { answer: tcpAnswer(5555), after: { "service.adb.listen_addrs": "tcp:5555" } });
  assert.equal(included.result.verified, true, "fixed addresses that include the port really do listen on it");
  const plain = await restartRun({ kind: "tcpip", port: 5555 }, { answer: tcpAnswer(5555), after: { "service.adb.tcp.port": "5555" } });
  assert.equal(plain.result.verified, true);
});

test("adb usb never claims the device is USB-only while Wireless debugging is on, whichever property says so, and the declared risk says the same", { skip: !posix }, async () => {
  const usb = (after, before) => restartRun({ kind: "usb" }, { answer: USB_ANSWER, after: { "service.adb.tcp.port": "0", ...after }, before });
  const reachable = [
    ["the switch and the TLS port adbd published", { "persist.adb.tls_server.enable": "1", "service.adb.tls.port": "37099" }, /TLS port 37099/],
    ["the Developer-options switch alone", { "persist.adb.tls_server.enable": "1" }, /persist\.adb\.tls_server\.enable=1/],
    ["a published port alone", { "service.adb.tls.port": "37099" }, /TLS port 37099/],
  ];
  for (const [name, properties, evidence] of reachable) {
    const run = await usb(properties);
    assert.equal(run.result.verified, false, name);
    assert.match(run.result.summary, /legacy TCP\/IP listener is off, but Wireless debugging is on/, name);
    assert.match(run.result.summary, evidence, name);
    assert.match(run.result.summary, /not USB-only/, name);
    assert.doesNotMatch(run.result.summary, /confirms it|no legacy TCP listener|no TCP listener/, name);
    assert.equal(run.result.details.observed.effective, null, `${name}: the legacy listener really is off`);
    assert.ok(run.result.details.observed.wireless, name);
  }

  // Both listeners: each is reported.
  const both = await usb({ "service.adb.tcp.port": "5555", "persist.adb.tls_server.enable": "1" });
  assert.equal(both.result.verified, false);
  assert.match(both.result.summary, /still listens on TCP: tcp:5555.*Wireless debugging is on/);

  // Wireless debugging really off (switch at 0, nothing published) is a USB-only device, and the result names what was checked.
  const clean = await usb({ "persist.adb.tls_server.enable": "0", "service.adb.tls.port": "0" });
  assert.equal(clean.result.verified, true);
  assert.match(clean.result.summary, /no legacy TCP listener, and Wireless debugging is off/);
  assert.equal(clean.result.details.observed.wireless, null);

  // The declared risk says so before anything is restarted.
  const warned = await usb({ "persist.adb.tls_server.enable": "1", "service.adb.tls.port": "37099" }, { "persist.adb.tls_server.enable": "1", "service.adb.tls.port": "37099" });
  assert.match(warned.ctx.declared[0].details, /Wireless debugging is on \(TLS port 37099\) and adb usb does not switch it off.*paired with this device can still connect over the network/);
  assert.match(clean.ctx.declared[0].details, /turning the legacy TCP\/IP listener \(adb tcpip\) off/);
  assert.match(clean.ctx.declared[0].details, /Wireless debugging is a separate TLS listener that adb usb does not change, and it is off now/);

  // tcpip is about the legacy listener: what it sets is what it verifies, and the wireless state is reported beside it.
  const tcpip = await restartRun({ kind: "tcpip", port: 5555 }, { answer: tcpAnswer(5555), after: { "service.adb.tcp.port": "5555", "persist.adb.tls_server.enable": "1" } });
  assert.equal(tcpip.result.verified, true);
  assert.equal(tcpip.result.details.observed.wireless.source, "persist.adb.tls_server.enable");
});

test("when fixed listener addresses already make the request impossible, it is refused before any risk is declared and nothing is restarted", { skip: !posix }, async () => {
  const usb = await restartRun({ kind: "usb" }, { answer: USB_ANSWER, before: { "service.adb.listen_addrs": "tcp:5555" } });
  assert.match(usb.error?.message ?? "", /adb usb cannot do what it says on this device: this device's adbd listens on the fixed addresses tcp:5555 \(service\.adb\.listen_addrs\).*Nothing was changed/);
  assert.equal(usb.ctx.declared.length, 0, "no risk is declared for something that cannot work");
  assert.equal(usb.first.services.includes("usb:"), false);

  const other = await restartRun({ kind: "tcpip", port: 5556 }, { answer: tcpAnswer(5556), before: { "service.adb.listen_addrs": "tcp:5555" } });
  assert.match(other.error?.message ?? "", /adb tcpip 5556 cannot do what it says/);
  assert.equal(other.first.services.includes("tcpip:5556"), false);

  const same = await restartRun({ kind: "tcpip", port: 5555 }, { answer: tcpAnswer(5555), before: { "service.adb.listen_addrs": "tcp:5555" }, after: { "service.adb.listen_addrs": "tcp:5555" } });
  assert.equal(same.result?.verified, true, "the port is already among the fixed addresses, so there is nothing to refuse");

  const bad = await restartRun({ kind: "root", timeoutSeconds: 0 }, { answer: { "root:": "restarting adbd as root\n" } });
  assert.match(bad.error?.message ?? "", /timeoutSeconds, how long to wait for the device to come back/);
  assert.equal(bad.ctx.declared.length, 0);
});

// ---------------------------------------------------------------------------
// An adbd restart makes the device leave the bus; the operation lives through that
// ---------------------------------------------------------------------------

function restartingProvider({ first, second, identity = "usb:18d1:4ee7:cronos", returns = identity }) {
  const calls = { borrow: 0, reacquire: [] };
  return {
    calls,
    async borrowHardwareTransport() {
      calls.borrow += 1;
      return { transport: first.transport, identity, async release() { first.transport.close(); } };
    },
    async reacquireHardwareTransport(deviceId, wanted, options) {
      calls.reacquire.push({ deviceId, wanted, timeoutMs: options.timeoutMs });
      if (wanted !== returns) throw new Error("USB recovery identity does not match the originally leased device.");
      return { transport: second.transport, identity: returns, async release() { second.transport.close(); } };
    },
  };
}

/** An agent restart: the person answers the one trust question, then the operation runs on its own. */
async function startRestart(provider, options) {
  const manager = new DeviceOperationManager("restart", provider, artifacts, [adbFlasher]);
  const { id } = manager.start({ deviceId: "usb-1", protocol: "adb", action: "exec", options });
  await allowAgent(manager);
  return { manager, id };
}

test("the disconnect an adbd restart causes does not cancel the operation that asked for it; the same device is taken again and checked", { skip: !posix }, async () => {
  const first = sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } });
  const second = sandboxDevice({ props: { "service.adb.root": "1" } });
  const provider = restartingProvider({ first, second });
  const { manager, id } = await startRestart(provider, { kind: "root", timeoutSeconds: 5 });
  await until(() => first.services.includes("root:"));
  await manager.deviceDisconnected("usb-1"); // what the browser's disconnect event does
  assert.equal(manager.trustLevel("usb-1"), "none", "the disconnect ends the connection's trust");
  assert.ok(!["cancelled", "cancelling"].includes(manager.status(id).state), "but the restart operation is not cancelled");
  assert.ok(manager.status(id).output.some((row) => /left the USB bus, as expected/.test(row.line)));

  const done = await finished(manager, id);
  assert.equal(done.state, "succeeded", done.error);
  assert.equal(done.result.verified, true);
  assert.equal(provider.calls.reacquire.length, 1);
  assert.deepEqual([provider.calls.reacquire[0].deviceId, provider.calls.reacquire[0].wanted], ["usb-1", "usb:18d1:4ee7:cronos"], "the same granted identity is asked for");
  assert.ok(provider.calls.reacquire[0].timeoutMs <= 5000);
});

test("a disconnect nobody announced, or one the user made on purpose, still cancels, and a different device never takes the place of the first", { skip: !posix }, async () => {
  // Before the restart is sent there is no window (here: during the visible countdown): the disconnect cancels as it always did.
  const waiting = sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } });
  const early = await startRestart(restartingProvider({ first: waiting, second: sandboxDevice() }), { kind: "root", sendDelaySeconds: 30 });
  await until(() => early.manager.status(early.id).state === "countdown");
  await early.manager.deviceDisconnected("usb-1");
  assert.equal((await finished(early.manager, early.id)).state, "cancelled");
  assert.equal(waiting.services.includes("root:"), false, "the restart was never sent");

  // The user disconnecting the device ends the operation even inside the window.
  const first = sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } });
  const forgotten = await startRestart(restartingProvider({ first, second: sandboxDevice({ props: { "service.adb.root": "1" } }) }), { kind: "root", timeoutSeconds: 5 });
  await until(() => first.services.includes("root:"));
  await forgotten.manager.deviceDisconnected("usb-1", "forgotten");
  assert.equal((await finished(forgotten.manager, forgotten.id)).state, "cancelled");

  // Another device (a different USB identity) coming back is refused: nothing is asked of it, and the result says so.
  const away = sandboxDevice({ answers: { "root:": "restarting adbd as root\n" } });
  const stranger = sandboxDevice({ props: { "service.adb.root": "1" } });
  const provider = restartingProvider({ first: away, second: stranger, returns: "usb:18d1:4ee7:someone-else" });
  const wrong = await startRestart(provider, { kind: "root", timeoutSeconds: 1 });
  await until(() => away.services.includes("root:"));
  await wrong.manager.deviceDisconnected("usb-1");
  const done = await finished(wrong.manager, wrong.id);
  assert.equal(done.state, "succeeded", done.error);
  assert.equal(done.result.verified, false);
  assert.match(done.result.summary, /could not reconnect to check it \(USB recovery identity does not match/);
  assert.deepEqual(stranger.services, [], "the other device was never talked to");
  assert.ok(provider.calls.reacquire.length >= 2, "the reconnect kept trying, without the lease the first attempt released");
});

// ---------------------------------------------------------------------------
// wait-for-device: a device that is absent, one deadline, recovery, cancellation
// ---------------------------------------------------------------------------

function silentTransport() {
  return {
    kind: "usb",
    async read(_length, timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), Math.min(timeoutMs, 20_000));
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    async write() {},
    close() {},
  };
}

test("a device that answers nothing ends the wait at its deadline, not after the 20 s quiet-read limit, however it is reached", { skip: !posix }, async () => {
  const started = Date.now();
  await assert.rejects(exec(context({ transport: silentTransport() }), { kind: "wait-for-device", timeoutSeconds: 1, pollMs: 100 }), /did not reach the device state within 1 s/);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);

  // Through the manager the one window also covers acquiring the lease of a device that is not attached yet.
  let borrows = 0;
  const provider = { async borrowHardwareTransport() { borrows += 1; if (borrows < 3) throw new Error("No such device: usb-1."); return { transport: silentTransport(), identity: "usb:1:2:wait", async release() {} }; } };
  const manager = new DeviceOperationManager("deadline", provider, artifacts, [adbFlasher]);
  const began = Date.now();
  const { id } = manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds: 1, pollMs: 100 } });
  const done = await finished(manager, id);
  assert.equal(done.state, "failed");
  assert.match(done.error, /did not reach the device state within 1 s/);
  assert.ok(Date.now() - began < 2500, `took ${Date.now() - began} ms for a 1 s window`);
});

test("a wait whose reacquisition failed keeps its identity and recovers when the same device is back, never authenticating on the released transport", { skip: !posix }, async () => {
  const booting = bootingTransport();
  let released = false;
  let readsAfterRelease = 0;
  const read = booting.read;
  booting.read = async (...args) => { if (released) readsAfterRelease += 1; return read(...args); };
  const good = sandboxDevice({ props: { "ro.product.model": "Cronos" } });
  const calls = [];
  const provider = {
    async borrowHardwareTransport() { return { transport: booting, identity: "usb:1:2:wait", async release() { released = true; } }; },
    async reacquireHardwareTransport(deviceId, identity) {
      calls.push({ deviceId, identity });
      if (calls.length < 3) throw new Error("The same USB device did not reappear within 30 seconds.");
      return { transport: good.transport, identity, async release() { good.transport.close(); } };
    },
  };
  const manager = new DeviceOperationManager("recover", provider, artifacts, [adbFlasher]);
  const { id } = manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds: 10, pollMs: 100 } });
  const done = await finished(manager, id);
  assert.equal(done.state, "succeeded", done.error);
  assert.equal(done.result.details.model, "Cronos");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.identity === "usb:1:2:wait" && call.deviceId === "usb-1"), "every attempt is for the identity captured with the first lease");
  assert.equal(readsAfterRelease, 0, "nothing was read from the transport once its lease was released");
});

test("cancelling a wait ends the pause at once and no further acquisition is attempted afterwards", { skip: !posix }, async () => {
  let borrows = 0;
  const provider = { async borrowHardwareTransport() { borrows += 1; throw new Error("No such device: usb-1."); } };
  const manager = new DeviceOperationManager("cancel", provider, artifacts, [adbFlasher]);
  const { id } = manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds: 60, pollMs: 5000 } });
  await until(() => borrows === 1);
  const cancelledAt = Date.now();
  manager.cancel(id);
  const done = await finished(manager, id);
  assert.equal(done.state, "cancelled");
  assert.ok(Date.now() - cancelledAt < 1000, `the 5 s poll was sat out for ${Date.now() - cancelledAt} ms`);
  const attempts = borrows;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(borrows, attempts, "no acquisition began after the cancel");
});

/** A provider that is still opening the device: an acquisition settles only when the gate is opened, as WebUSB open/configure/claim can take as long as it likes. */
function slowOpening({ reacquire = false } = {}) {
  const gate = Promise.withResolvers();
  const seen = { acquisitions: 0, released: 0, reads: 0 };
  const lease = () => {
    const transport = bootingTransport();
    transport.read = async () => { seen.reads += 1; throw new Error("device not ready"); };
    return { transport, identity: "usb:1:2:slow", async release() { seen.released += 1; } };
  };
  const provider = reacquire
    ? { async borrowHardwareTransport() { return lease(); }, async reacquireHardwareTransport() { seen.acquisitions += 1; await gate.promise; return lease(); } }
    : { async borrowHardwareTransport() { seen.acquisitions += 1; await gate.promise; return lease(); } };
  return { seen, gate, provider };
}

test("a wait is bounded by its deadline and by Cancel while the provider is still opening the device, and a lease that turns up afterwards is released unused", { skip: !posix }, async () => {
  const wait = (provider, timeoutSeconds) => {
    const manager = new DeviceOperationManager("slow-open", provider, artifacts, [adbFlasher]);
    return { manager, ...manager.startUser({ deviceId: "usb-1", protocol: "adb", action: "exec", options: { kind: "wait-for-device", timeoutSeconds, pollMs: 100 } }) };
  };

  // Deadline: a one-second wait ends at about one second although the acquisition has not settled.
  const slow = slowOpening();
  const began = Date.now();
  const first = wait(slow.provider, 1);
  const failed = await finished(first.manager, first.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /did not become available within 1 s: its USB connection was still being opened/);
  assert.ok(Date.now() - began < 2500, `took ${Date.now() - began} ms for a 1 s window`);
  assert.equal(slow.seen.acquisitions, 1, "no second acquisition was started on top of the one still pending");
  slow.gate.resolve();
  await until(() => slow.seen.released === 1);
  assert.equal(slow.seen.reads, 0, "nothing was read from a lease that arrived after the wait gave up");

  // Cancel: a long wait ends at once instead of after the open.
  const held = slowOpening();
  const second = wait(held.provider, 60);
  await until(() => held.seen.acquisitions === 1);
  const cancelledAt = Date.now();
  second.manager.cancel(second.id);
  assert.equal((await finished(second.manager, second.id)).state, "cancelled");
  assert.ok(Date.now() - cancelledAt < 1000, `Cancel took ${Date.now() - cancelledAt} ms`);
  held.gate.resolve();
  await until(() => held.seen.released === 1);
  assert.equal(held.seen.reads, 0);

  // A reacquisition that is still opening at the deadline ends the wait there too, naming why.
  const reopening = slowOpening({ reacquire: true });
  const reacquiring = wait(reopening.provider, 1);
  const startedReacquiring = Date.now();
  const stuck = await finished(reacquiring.manager, reacquiring.id);
  assert.equal(stuck.state, "failed");
  assert.match(stuck.error, /did not reach the device state within 1 s \(the device was still being opened when the deadline passed\)/);
  assert.ok(Date.now() - startedReacquiring < 2500, `took ${Date.now() - startedReacquiring} ms for a 1 s window`);
  const readsAtGiveUp = reopening.seen.reads;
  reopening.gate.resolve();
  // The first lease (released by the reacquisition) and every acquisition that arrived late.
  await until(() => reopening.seen.released === reopening.seen.acquisitions + 1);
  assert.equal(reopening.seen.reads, readsAtGiveUp, "no late lease was ever used");
});

// ---------------------------------------------------------------------------
// The device_exec tool: a device that left the page can be waited for
// ---------------------------------------------------------------------------

test("only a wait-for-device may name a device that left the page, and only by the exact id it had; a device the user disconnected or a stranger never qualifies", async () => {
  const waitTool = DEVICE_OPERATION_TOOLS.find((tool) => tool.name === "device_exec");
  const flashTool = DEVICE_OPERATION_TOOLS.find((tool) => tool.name === "device_flash");
  const bridge = new DeviceBridge();
  bridge.attach(() => {});
  const starts = [];
  bridge.startOperation = async (request) => { starts.push(request); return "operation-1"; };
  const roster = [
    { id: "usb-1", label: "Cronos tablet", kind: "usb", open: false, protocolCandidates: [{ protocol: "adb", interfaceNumber: 2, alternateSetting: 0 }] },
    { id: "usb-2", label: "Bench board", kind: "usb", open: false },
  ];
  bridge.setDevices(roster);
  bridge.removeDevice("usb-1"); // the page's gone frame: it is rebooting
  const wait = { protocol: "adb", options: { kind: "wait-for-device", timeoutSeconds: 30 } };

  assert.match(await waitTool.handler({ device: "usb-1", ...wait }, { bridge }), /operation-1.*accepted/);
  assert.deepEqual(starts[0], { protocol: "adb", action: "exec", deviceId: "usb-1", interfaceNumber: 2, alternateSetting: 0, options: { kind: "wait-for-device", timeoutSeconds: 30 } }, "the interface it had is resolved from the remembered roster entry");

  const refused = async (call) => assert.match(await call, /No device matches/);
  await refused(waitTool.handler({ device: "usb-1", protocol: "adb", command: "id" }, { bridge }));
  await refused(waitTool.handler({ device: "usb-1", protocol: "adb", options: { kind: "shell" }, command: "id" }, { bridge }));
  await refused(flashTool.handler({ device: "usb-1", protocol: "adb", fileId: "f", sha256: "a".repeat(64) }, { bridge }));
  await refused(waitTool.handler({ device: "usb-9", ...wait }, { bridge }));
  await refused(waitTool.handler({ device: "Cronos", ...wait }, { bridge }));
  assert.equal(starts.length, 1, "nothing but the one wait was started");

  // The roster simply dropping a device (the user disconnected it) does not make it addressable.
  bridge.setDevices([roster[0]]);
  await refused(waitTool.handler({ device: "usb-2", ...wait }, { bridge }));
  // And once the device is back it is an ordinary live device again.
  assert.equal(bridge.departedDevice("usb-1"), undefined);
  assert.match(await waitTool.handler({ device: "usb-1", ...wait }, { bridge }), /accepted/);

  // Another page taking over means none of the remembered ids mean anything.
  bridge.removeDevice("usb-1");
  assert.ok(bridge.departedDevice("usb-1"));
  bridge.attach(() => {});
  assert.equal(bridge.departedDevice("usb-1"), undefined);
});
