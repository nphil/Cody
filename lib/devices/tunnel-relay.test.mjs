import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import test from "node:test";
import { fakeTunnelDevice } from "./adb-tunnel.test-helper.mjs";
import { connectPage, exchange, listen, refused, sha256, tool, until } from "./tunnel-page.test-helper.mjs";

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

test("a second reverse rule on the same device address is refused, and cancelling it never removes the first", async () => {
  const probe = await listen(() => {});
  const devicePort = probe.port;
  await probe.close();
  const hostA = await listen(() => {});
  const hostB = await listen(() => {});
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  try {
    const first = await page.start("device_reverse", { target: `tcp:${devicePort}`, local: `tcp:${hostA.port}` });
    await page.confirm(first);
    await until(() => daemon.reverseListeners.has(`tcp:${devicePort}`), "the first rule on the device");

    const second = await page.start("device_reverse", { target: `tcp:${devicePort}`, local: `tcp:${hostB.port}` });
    await page.confirm(second);
    const refused = await page.finished(second);
    assert.equal(refused.state, "failed");
    assert.match(refused.error, /already active on this device connection/);
    assert.equal(daemon.services.filter((service) => service.startsWith("reverse:forward:")).length, 1, "the device was asked once");
    assert.equal(page.state(first), "running");
    assert.deepEqual(daemon.killed, []);
    assert.ok(daemon.reverseListeners.has(`tcp:${devicePort}`), "the first rule still listens");

    // Once the first is gone the address is free again.
    await page.manager.cancel(first);
    await page.finished(first);
    assert.deepEqual(daemon.killed, [`tcp:${devicePort}`]);
    const third = await page.start("device_reverse", { target: `tcp:${devicePort}`, local: `tcp:${hostB.port}` });
    await page.confirm(third);
    await until(() => daemon.reverseListeners.has(`tcp:${devicePort}`), "the address to be reused");
    await page.manager.cancel(third);
    await page.finished(third);
  } finally {
    page.disconnect();
    daemon.close();
    await hostA.close();
    await hostB.close();
  }
});

test("cancelling a reverse rule whose registration the device never answers ends the operation and frees the lease", async () => {
  const host = await listen(() => {});
  const daemon = fakeTunnelDevice();
  daemon.withholdReverse = true;
  const page = connectPage(daemon);
  try {
    const id = await page.start("device_reverse", { target: "tcp:0", local: `tcp:${host.port}` });
    await page.confirm(id);
    await until(() => daemon.services.some((service) => service.startsWith("reverse:forward:")), "the registration to be sent");
    await until(() => page.bridge.tunnels.list()[0], "the server-side rule");
    await page.manager.cancel(id);
    const done = await page.finished(id);
    assert.equal(done.state, "cancelled");
    await until(() => page.bridge.tunnels.list().length === 0, "the server-side rule to be dropped");
    await until(() => page.stats.releases === 1, "the device lease to be released");
    assert.equal(page.stats.busy, false);
  } finally {
    page.disconnect();
    daemon.close();
    await host.close();
  }
});

test("an operation started while the previous ADB connection is closing waits for it instead of opening a second one", async () => {
  const sockets = new Set();
  const silent = await listen((socket) => { sockets.add(socket); socket.on("data", () => {}); });
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  let releaseClose;
  let client;
  try {
    const forwardId = await page.start("device_forward", { target: `tcp:${silent.port}`, local: "tcp:0" });
    await page.confirm(forwardId);
    const rule = await until(() => page.bridge.tunnels.list()[0], "the forward rule");
    client = net.connect({ host: "127.0.0.1", port: rule.port });
    client.on("error", () => {});
    client.write("hello");
    await until(() => daemon.openStreams === 1 && sockets.size === 1, "a stream open on the device");
    assert.equal(daemon.connects, 1);

    // The device stops answering CLSE, so closing the connection cannot finish.
    releaseClose = daemon.holdClose();
    await page.manager.cancel(forwardId);
    await new Promise((resolve) => setTimeout(resolve, 3500)); // past the bounded stream cleanup, into teardown
    assert.notEqual(page.state(forwardId), "cancelled", "the old connection is still closing");

    const next = await page.start("device_exec", { protocol: "adb", command: "id" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(daemon.connects, 1, "no second ADB connection while the first one is closing");
    assert.notEqual(page.manager.status(next).state, "succeeded");

    releaseClose();
    releaseClose = undefined;
    const result = await page.finished(next);
    assert.equal(result.state, "succeeded", result.error);
    assert.equal(daemon.connects, 2, "a fresh connection once the old one was gone");
    assert.equal((await page.finished(forwardId)).state, "cancelled");
    assert.equal(page.stats.borrows, 1);
  } finally {
    releaseClose?.();
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    page.disconnect();
    daemon.close();
    await silent.close();
  }
});

test("an abandoned reverse registration keeps its device address reserved until it has settled and been cleaned up", async () => {
  const probe = await listen(() => {});
  const devicePort = probe.port;
  await probe.close();
  const hostA = await listen(() => {});
  const hostB = await listen(() => {});
  const keepAlive = await listen((socket) => socket.pipe(socket));
  const daemon = fakeTunnelDevice();
  daemon.withholdReverse = true;
  const page = connectPage(daemon);
  try {
    // A second live operation keeps the shared ADB connection open past the cancel.
    const forwardId = await page.start("device_forward", { target: `tcp:${keepAlive.port}`, local: "tcp:0" });
    await page.confirm(forwardId);
    await until(() => page.bridge.tunnels.list()[0], "the keep-alive forward");

    const first = await page.start("device_reverse", { target: `tcp:${devicePort}`, local: `tcp:${hostA.port}` });
    await page.confirm(first);
    await until(() => daemon.services.some((service) => service.startsWith("reverse:forward:")), "the registration to be sent");
    await page.manager.cancel(first);
    assert.equal((await page.finished(first)).state, "cancelled");
    assert.equal(page.state(forwardId), "running", "the connection is still alive");

    // The device may still install the abandoned rule, so its address cannot be handed out yet.
    daemon.withholdReverse = false;
    const second = await page.start("device_reverse", { target: `tcp:${devicePort}`, local: `tcp:${hostB.port}` });
    await page.confirm(second);
    const refused = await page.finished(second);
    assert.equal(refused.state, "failed");
    assert.match(refused.error, /already active on this device connection/);

    // The slow daemon finally answers: the late rule is removed, and it is the abandoned one that goes.
    daemon.answerWithheld();
    await until(() => daemon.killed.includes(`tcp:${devicePort}`), "the late rule to be removed");
    assert.equal(daemon.reverseListeners.size, 0);
    const third = await page.start("device_reverse", { target: `tcp:${devicePort}`, local: `tcp:${hostB.port}` });
    await page.confirm(third);
    await until(() => daemon.reverseListeners.has(`tcp:${devicePort}`), "the freed address to be reusable");
    assert.equal(page.state(third), "running");
    assert.equal(daemon.killed.length, 1, "the replacement was not deleted by the old cleanup");
    await page.manager.cancel(third);
    await page.finished(third);
    await page.manager.cancel(forwardId);
    await page.finished(forwardId);
  } finally {
    page.disconnect();
    daemon.close();
    await hostA.close();
    await hostB.close();
    await keepAlive.close();
  }
});

test("an operation waiting for a closing ADB connection can be cancelled without starting any ADB work", async () => {
  const sockets = new Set();
  const silent = await listen((socket) => { sockets.add(socket); socket.on("data", () => {}); });
  const daemon = fakeTunnelDevice();
  const page = connectPage(daemon);
  let releaseClose;
  let client;
  try {
    const forwardId = await page.start("device_forward", { target: `tcp:${silent.port}`, local: "tcp:0" });
    await page.confirm(forwardId);
    const rule = await until(() => page.bridge.tunnels.list()[0], "the forward rule");
    client = net.connect({ host: "127.0.0.1", port: rule.port });
    client.on("error", () => {});
    client.write("hello");
    await until(() => daemon.openStreams === 1 && sockets.size === 1, "a stream open on the device");

    releaseClose = daemon.holdClose();
    await page.manager.cancel(forwardId);
    await new Promise((resolve) => setTimeout(resolve, 3500)); // into the stalled teardown

    const next = await page.start("device_exec", { protocol: "adb", command: "id" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.manager.cancel(next);
    // The teardown is still stalled; the waiting operation must not be stuck behind it.
    const cancelled = await page.finished(next);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(daemon.connects, 1, "no ADB work was started");
    assert.notEqual(page.state(forwardId), "cancelled", "the teardown is still stalled");

    releaseClose();
    releaseClose = undefined;
    assert.equal((await page.finished(forwardId)).state, "cancelled");
    await until(() => page.stats.releases === 1, "the lease to be released once both finished");
  } finally {
    releaseClose?.();
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    page.disconnect();
    daemon.close();
    await silent.close();
  }
});
