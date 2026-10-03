import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import test from "node:test";
import { createJiti } from "jiti";
import { fakeTunnelDevice } from "./adb-tunnel.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getDeviceBridge } = await jiti.import("./bus.ts");
const { attachDeviceSocket } = await jiti.import("./socket.ts");
const { createPageOperationDelegate } = await jiti.import("./operations.ts");
const { adbFlasher } = await jiti.import("./adb.ts");
const { TunnelClient } = await jiti.import("./tunnel-client.ts");
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

const tool = (name) => DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
let sessionCounter = 0;

async function until(getter, what = "condition", ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await getter();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A loopback TCP server standing in for "a service" on either side. */
async function listen(onConnection) {
  const server = net.createServer(onConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

/** Send `payload`, read until `expected` bytes arrive (or the peer closes). */
function exchange(port, payload, expected = payload.length) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const received = [];
    let total = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`exchange timed out after ${total}/${expected} bytes`)); }, 15000);
    socket.on("data", (data) => {
      received.push(data);
      total += data.length;
      if (total >= expected) { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(received)); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(received)); });
    socket.write(payload);
  });
}

function refused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("connect", () => { socket.destroy(); resolve(false); });
    socket.on("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });
}

/**
 * Wire a real server-side bridge (DeviceBridge + attachDeviceSocket) to a
 * page-side operation runner and relay client over an in-memory socket, with a
 * fake adbd at the USB boundary. Everything between the two is production code.
 */
function connectPage(daemon, sessionId = `tunnel-session-${Date.now()}-${sessionCounter++}`) {
  const listeners = {};
  let toPage = [];
  const serverSocket = {
    readyState: 1,
    send(data) {
      const frame = JSON.parse(data);
      setImmediate(() => { void handleServerFrame(frame); });
    },
    close() {},
    on(event, listener) { listeners[event] = listener; },
  };
  attachDeviceSocket(sessionId, serverSocket);
  const sendToServer = (frame) => listeners.message(JSON.stringify(frame), false);
  const tunnels = new TunnelClient((message) => sendToServer({ type: "tunnel", message }));
  const stats = { borrows: 0, releases: 0, busy: false };
  const provider = {
    tunnels,
    async borrowHardwareTransport() {
      if (stats.busy) throw new Error("Device usb-1 is exclusively reserved by an active hardware operation.");
      stats.busy = true;
      stats.borrows += 1;
      return { transport: daemon, async release() { stats.busy = false; stats.releases += 1; } };
    },
  };
  const delegate = createPageOperationDelegate(sessionId, provider, { async getInput() {}, async save() { return "saved"; } }, [adbFlasher]);
  const pageBridge = {
    ...provider,
    sendOperationProgress: sendToServer,
    sendOperationSnapshot: sendToServer,
    sendOperationResult: sendToServer,
  };
  async function handleServerFrame(frame) {
    toPage.push(frame.type);
    if (frame.type === "tunnel") {
      tunnels.receive(frame.message);
      return;
    }
    if (frame.type !== "operation") return;
    const command = frame.command;
    try {
      if (command.type === "operation.start") await delegate.start(command, pageBridge);
      else if (command.type === "operation.cancel") await delegate.cancel(command, pageBridge);
      else if (command.type === "operation.send") await delegate.send(command, pageBridge);
      else await delegate.status(command, pageBridge);
      sendToServer({ type: "result", id: command.id, status: "ok" });
    } catch (error) {
      sendToServer({ type: "result", id: command.id, status: "error", error: error.message });
    }
  }
  sendToServer({ type: "hello", capabilities: { usb: true, secureContext: true }, devices: [{ id: "usb-1", label: "Test phone", kind: "usb", open: true }] });
  const bridge = getDeviceBridge(sessionId);
  const manager = delegate.manager;
  return {
    sessionId, bridge, manager, tunnels, stats, sendToServer,
    framesToPage: () => toPage,
    disconnect() { listeners.close(); },
    async start(toolName, args) {
      const text = await tool(toolName).handler({ device: "usb-1", ...args }, { bridge });
      const id = /Operation (\S+) was accepted/.exec(text)?.[1];
      assert.ok(id, text);
      return id;
    },
    /** What the user's tap on the confirmation card does. */
    async confirm(id) {
      const pending = await until(() => manager.status(id)?.confirmation, "a confirmation request");
      manager.confirm(id, pending.id, pending.binding);
      return pending;
    },
    state: (id) => manager.status(id)?.state,
    output: (id) => manager.status(id)?.output.map((row) => row.line).join("\n") ?? "",
    async finished(id) {
      return until(() => { const snapshot = manager.status(id); return ["succeeded", "failed", "cancelled"].includes(snapshot?.state) && snapshot; }, `operation ${id} to finish`);
    },
  };
}

test("forward relays real bytes both ways through the page, then removal closes everything", async () => {
  const echo = await listen((socket) => socket.pipe(socket));
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  try {
    const id = await page.start("device_forward", { target: `tcp:${echo.port}`, local: "tcp:0" });
    const pending = await until(() => page.manager.status(id)?.confirmation, "the confirmation card");
    // Nothing listens and nothing touches the device until the user confirms.
    assert.deepEqual(page.bridge.tunnels.list(), []);
    assert.deepEqual(daemon.services, []);
    assert.equal(pending.binding.action, "adb.forward");
    assert.equal(pending.binding.target, `tcp:${echo.port}`);
    assert.match(pending.binding.details, /Cody server loopback a free port -> device tcp:/);
    assert.throws(() => page.manager.confirm(id, pending.id, { ...pending.binding, target: "tcp:1" }), /no longer matches/);
    page.manager.confirm(id, pending.id, pending.binding);

    const rule = await until(() => page.bridge.tunnels.list()[0], "the forward rule");
    assert.equal(rule.kind, "forward");
    assert.ok(rule.port > 1023);
    assert.equal(page.state(id), "running");

    assert.equal((await exchange(rule.port, Buffer.from("hello through adb"))).toString(), "hello through adb");

    // 3 MiB of random bytes, both directions, through a 512 KiB credit window.
    const big = randomBytes(3 * 1024 * 1024);
    const [a, b] = await Promise.all([exchange(rule.port, big), exchange(rule.port, Buffer.from("second concurrent client"))]);
    assert.equal(sha256(a), sha256(big));
    assert.equal(b.toString(), "second concurrent client");
    await until(() => page.bridge.tunnels.list()[0]?.bytesToDevice >= big.length && page.bridge.tunnels.list()[0]?.bytesFromDevice >= big.length, "byte counters");

    const removed = await tool("device_tunnels").handler({ action: "remove", operationId: id }, { bridge: page.bridge });
    assert.match(removed, /Removal was sent/);
    const done = await page.finished(id);
    assert.equal(done.state, "cancelled");
    assert.equal(await refused(rule.port), true, "the listener is gone");
    await until(() => page.bridge.tunnels.list().length === 0, "the rule to be dropped");
    await until(() => daemon.openStreams === 0, "device streams to close " + JSON.stringify(daemon.describeStreams()));
    await until(() => page.stats.releases === 1, "the device lease to be released");
    assert.equal(page.stats.busy, false);
  } finally {
    page.disconnect();
    daemon.close();
    await echo.close();
  }
});

test("forward to a service the device refuses closes that client and keeps the rule alive", async () => {
  const closed = await listen(() => {});
  const deadPort = closed.port;
  await closed.close();
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  try {
    const id = await page.start("device_forward", { target: `tcp:${deadPort}`, local: "tcp:0" });
    await page.confirm(id);
    const rule = await until(() => page.bridge.tunnels.list()[0], "the forward rule");
    // The device refuses the stream, so the client is dropped without ever receiving a byte.
    const received = await exchange(rule.port, Buffer.from("anyone there?"), 1).catch((error) => (error.code === "ECONNRESET" ? Buffer.alloc(0) : Promise.reject(error)));
    assert.equal(received.length, 0);
    await until(() => page.bridge.tunnels.list()[0].connections === 0, "the refused client to be dropped");
    assert.equal(page.state(id), "running");
    await page.manager.cancel(id);
    await page.finished(id);
  } finally {
    page.disconnect();
    daemon.close();
  }
});

test("reverse lets a device-side client reach a real host service, and removal tells the device", async () => {
  // Greets each connection once, then echoes: proves the host side sees the device's bytes first.
  const host = await listen((socket) => {
    let greeted = false;
    socket.on("data", (data) => { socket.write(greeted ? data : Buffer.concat([Buffer.from("host:"), data])); greeted = true; });
  });
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  try {
    const id = await page.start("device_reverse", { target: "tcp:0", local: `tcp:${host.port}` });
    const pending = await until(() => page.manager.status(id)?.confirmation, "the confirmation card");
    assert.equal(pending.binding.action, "adb.reverse");
    assert.equal(daemon.services.length, 0, "the device is untouched before confirmation");
    page.manager.confirm(id, pending.id, pending.binding);

    await until(() => daemon.reverseListeners.size === 1, "the device to accept the reverse rule");
    const [address] = daemon.reverseListeners.keys();
    const devicePort = daemon.devicePort(address);
    assert.ok(daemon.services.some((service) => service === `reverse:forward:tcp:0;tcp:${host.port}`));
    await until(() => page.bridge.tunnels.list()[0], "the reverse rule");
    await until(() => page.output(id).includes(`Reverse: device ${address} -> Cody server 127.0.0.1:${host.port}`), "the rule to be reported running");

    // An app on the "device" connects to its own loopback port; the bytes reach the host service and come back.
    const reply = await exchange(devicePort, Buffer.from("ping"), "host:ping".length);
    assert.equal(reply.toString(), "host:ping");
    const big = randomBytes(1024 * 1024);
    const echoed = await exchange(devicePort, big, big.length + 5);
    assert.equal(echoed.subarray(0, 5).toString(), "host:");
    assert.equal(sha256(echoed.subarray(5)), sha256(big));

    await page.manager.cancel(id);
    const done = await page.finished(id);
    assert.equal(done.state, "cancelled");
    assert.deepEqual(daemon.killed, [address]);
    assert.equal(daemon.reverseListeners.size, 0);
    assert.equal(await refused(devicePort), true);
    await until(() => page.bridge.tunnels.list().length === 0, "the rule to be dropped");
    await until(() => page.stats.releases === 1, "the device lease to be released");
  } finally {
    page.disconnect();
    daemon.close();
    await host.close();
  }
});

test("the server refuses rules the user never confirmed or that point at Cody itself", async () => {
  const host = await listen(() => {});
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  const previous = process.env.CODY_INTERNAL_DISPLAY_ORIGIN;
  try {
    const signal = new AbortController().signal;
    await assert.rejects(page.tunnels.listen({ operationId: "operation-never-started", deviceId: "usb-1", port: 0 }, signal), /No running confirmed operation/);

    // A real operation that is still waiting for the user's tap has no rule yet.
    const waiting = await page.start("device_forward", { target: "tcp:9", local: "tcp:0" });
    await until(() => page.manager.status(waiting)?.confirmation, "the confirmation card");
    await assert.rejects(page.tunnels.listen({ operationId: waiting, deviceId: "usb-1", port: 0 }, signal), /No running confirmed operation/);
    await page.manager.cancel(waiting);
    await page.finished(waiting);

    process.env.CODY_INTERNAL_DISPLAY_ORIGIN = `http://127.0.0.1:${host.port}`;
    const own = await page.start("device_reverse", { target: "tcp:0", local: `tcp:${host.port}` });
    await page.confirm(own);
    const failed = await page.finished(own);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /Cody's own port/);
    assert.deepEqual(daemon.services.filter((service) => service.startsWith("reverse:")), [], "the device was never asked to listen");
  } finally {
    if (previous === undefined) delete process.env.CODY_INTERNAL_DISPLAY_ORIGIN;
    else process.env.CODY_INTERNAL_DISPLAY_ORIGIN = previous;
    page.disconnect();
    daemon.close();
    await host.close();
  }
});

test("rules belong to one session and die with the browser that owns the device", async () => {
  const echo = await listen((socket) => socket.pipe(socket));
  const daemonA = fakeTunnelDevice();
  const daemonB = fakeTunnelDevice();
  const a = connectPage(daemonA);
  const b = connectPage(daemonB);
  try {
    const idA = await a.start("device_forward", { target: `tcp:${echo.port}`, local: "tcp:0" });
    await a.confirm(idA);
    const ruleA = await until(() => a.bridge.tunnels.list()[0], "session A's rule");
    assert.deepEqual(b.bridge.tunnels.list(), []);
    assert.match(await tool("device_tunnels").handler({}, { bridge: b.bridge }), /No adb forward or reverse rules/);
    assert.match(await tool("device_tunnels").handler({ action: "remove", operationId: idA }, { bridge: b.bridge }), /not a forward\/reverse rule in this session/);
    assert.match(await tool("device_tunnels").handler({}, { bridge: a.bridge }), new RegExp(`tcp:${ruleA.port} \\(127\\.0\\.0\\.1\\) -> device tcp:${echo.port}`));

    // Session B's page cannot claim A's operation either.
    await assert.rejects(b.tunnels.listen({ operationId: idA, deviceId: "usb-1", port: 0 }, new AbortController().signal), /No running confirmed operation/);

    // The browser holding session A's device goes away: the listener goes with it.
    assert.equal((await exchange(ruleA.port, Buffer.from("alive"))).toString(), "alive");
    a.disconnect();
    await until(() => a.bridge.tunnels.list().length === 0, "the rule to be dropped");
    assert.equal(await refused(ruleA.port), true);
    // The page learns its relay is gone and ends the operation instead of pretending to forward.
    a.tunnels.dropAll("The connection to the Cody server closed.");
    const done = await a.finished(idA);
    assert.equal(done.state, "failed");
    assert.match(done.error, /Forward 127\.0\.0\.1:\d+ -> tcp:\d+ ended: The connection to the Cody server closed\./);
    await until(() => a.stats.releases === 1, "the lease to be released");
  } finally {
    a.disconnect();
    b.disconnect();
    daemonA.close();
    daemonB.close();
    await echo.close();
  }
});

test("port rules, shells and pulls share one device connection; cancelling one never drops the others", async () => {
  const echo = await listen((socket) => socket.pipe(socket));
  const host = await listen((socket) => socket.on("data", (data) => socket.write(data)));
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  try {
    const forwardId = await page.start("device_forward", { target: `tcp:${echo.port}`, local: "tcp:0" });
    await page.confirm(forwardId);
    const forwardRule = await until(() => page.bridge.tunnels.list()[0], "the forward rule");

    const reverseId = await page.start("device_reverse", { target: "tcp:0", local: `tcp:${host.port}` });
    await page.confirm(reverseId);
    await until(() => daemon.reverseListeners.size === 1, "the reverse rule");
    const [address] = daemon.reverseListeners.keys();

    // A read-only diagnostic runs while both rules are live.
    const execId = await page.start("device_exec", { protocol: "adb", command: "id" });
    assert.equal((await page.finished(execId)).state, "succeeded");
    assert.equal(page.stats.borrows, 1, "every operation joined the one lease");

    // Listing the device's own reverse rules needs no command and no confirmation.
    const listId = await page.start("device_exec", { protocol: "adb", options: { kind: "reverse-list" } });
    const listed = await page.finished(listId);
    assert.equal(listed.state, "succeeded");
    assert.match(page.output(listId), new RegExp(`fake-serial ${address} tcp:${host.port}`));

    // Cancelling the forward leaves the reverse rule and the connection working.
    await page.manager.cancel(forwardId);
    assert.equal((await page.finished(forwardId)).state, "cancelled");
    assert.equal(await refused(forwardRule.port), true);
    assert.equal(page.stats.releases, 0, "the device lease is still held by the reverse rule");
    assert.equal((await exchange(daemon.devicePort(address), Buffer.from("still up"))).toString(), "still up");

    await page.manager.cancel(reverseId);
    assert.equal((await page.finished(reverseId)).state, "cancelled");
    assert.deepEqual(daemon.killed, [address]);
    await until(() => page.stats.releases === 1, "the lease to be released once, by the last operation");
    assert.equal(page.stats.borrows, 1);
  } finally {
    page.disconnect();
    daemon.close();
    await echo.close();
    await host.close();
  }
});

test("operations that rewrite the device still need the lease alone while a rule is live", async () => {
  const echo = await listen((socket) => socket.pipe(socket));
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  try {
    const forwardId = await page.start("device_forward", { target: `tcp:${echo.port}`, local: "tcp:0" });
    await page.confirm(forwardId);
    await until(() => page.bridge.tunnels.list()[0], "the forward rule");
    const reboot = await page.start("device_exec", { protocol: "adb", command: "reboot", options: { kind: "reboot" } });
    const failed = await page.finished(reboot);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /exclusively reserved/);
    assert.equal(page.state(forwardId), "running", "the rule is unaffected");
    await page.manager.cancel(forwardId);
    await page.finished(forwardId);
  } finally {
    page.disconnect();
    daemon.close();
    await echo.close();
  }
});
