import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { MAX_TUNNELS_PER_SESSION, TUNNEL_CHUNK_BYTES, TUNNEL_WINDOW_BYTES, parseDeviceSpec, parseHostSpec, parseTunnelMessage } = await jiti.import("./tunnel.ts");
const { TunnelHost } = await jiti.import("./tunnel-host.ts");
const { TunnelClient } = await jiti.import("./tunnel-client.ts");

async function until(getter, what, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = getter();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

test("device and host addresses accept what adb accepts and refuse what the relay cannot reach", () => {
  assert.deepEqual(parseDeviceSpec("tcp:8080", "forward"), { kind: "tcp", text: "tcp:8080", port: 8080 });
  assert.equal(parseDeviceSpec("jdwp:4242", "forward").kind, "jdwp");
  assert.equal(parseDeviceSpec("dev:/dev/ttyGS0", "forward").kind, "dev");
  assert.equal(parseDeviceSpec("localabstract:chrome_devtools_remote", "reverse").kind, "localabstract");
  assert.equal(parseDeviceSpec("tcp:0", "reverse").port, 0, "a device may pick the reverse port");
  for (const [value, direction, pattern] of [
    ["tcp:0", "forward", /port must be 1-65535/],
    ["tcp:70000", "forward", /1-65535/],
    ["tcp:80;tcp:81", "reverse", /without ';'/],
    ["jdwp:abc", "forward", /process id/],
    ["dev:ttyGS0", "forward", /absolute path/],
    ["jdwp:42", "reverse", /must start with tcp:, localabstract:/],
    ["shell:", "forward", /must start with/],
    ["tcp:80\n", "forward", /single line/],
    ["", "forward", /required/],
    [undefined, "reverse", /required/],
  ]) assert.throws(() => parseDeviceSpec(value, direction), pattern, `${String(value)} ${direction}`);

  assert.deepEqual(parseHostSpec("tcp:9000", "forward"), { text: "tcp:9000", port: 9000 });
  assert.equal(parseHostSpec("tcp:0", "forward").port, 0);
  assert.equal(parseHostSpec("tcp:80", "reverse").port, 80, "a reverse rule may name any existing host service");
  for (const [value, direction, pattern] of [
    ["tcp:80", "forward", /1024 or above/],
    ["tcp:0", "reverse", /1-65535/],
    ["localabstract:x", "forward", /must be tcp:PORT/],
    ["tcp:abc", "forward", /port number/],
    [undefined, "forward", /required/],
  ]) assert.throws(() => parseHostSpec(value, direction), pattern, `${String(value)} ${direction}`);
});

test("relay messages from the far side are validated before they reach a socket", () => {
  const ok = { kind: "data", connectionId: "s-1", base64: Buffer.from("abc").toString("base64") };
  assert.deepEqual(parseTunnelMessage(ok), ok);
  assert.equal(parseTunnelMessage({ ...ok, base64: "not base64!" }), null);
  assert.equal(parseTunnelMessage({ ...ok, base64: "" }), null);
  assert.equal(parseTunnelMessage({ ...ok, base64: "A".repeat(TUNNEL_CHUNK_BYTES * 2) }), null, "oversized chunks are refused");
  assert.equal(parseTunnelMessage({ kind: "ack", connectionId: "s-1", bytes: 1.5 }), null);
  assert.equal(parseTunnelMessage({ kind: "ack", connectionId: "s-1", bytes: TUNNEL_CHUNK_BYTES + 1 }), null);
  assert.equal(parseTunnelMessage({ kind: "ack", connectionId: "s-1", bytes: 0 }), null);
  assert.equal(parseTunnelMessage({ kind: "listen", requestId: "r", operationId: "o", deviceId: "d", port: 70000 }), null);
  assert.equal(parseTunnelMessage({ kind: "listen", requestId: "r", operationId: "", deviceId: "d", port: 1 }), null);
  assert.equal(parseTunnelMessage({ kind: "launch-missiles" }), null);
  assert.equal(parseTunnelMessage("data"), null);
  assert.deepEqual(parseTunnelMessage({ kind: "reset", connectionId: "p-1", reason: "x".repeat(2000) }).reason.length, 512);
});

function host({ active = () => true, reserved = [] } = {}) {
  const sent = [];
  const traffic = [];
  const tunnels = new TunnelHost({
    send: (message) => { sent.push(message); },
    operationActive: (operationId, deviceId) => active(operationId, deviceId),
    traffic: (deviceId, direction, bytes) => traffic.push({ deviceId, direction, bytes }),
    reservedPorts: () => reserved,
    changed() {},
  });
  return { tunnels, sent, traffic, last: (kind) => sent.findLast((message) => message.kind === kind) };
}

test("the server host refuses ports it must never bind or dial, and says why", async () => {
  const taken = net.createServer();
  await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const { port } = taken.address();
  const { tunnels, sent } = host({ reserved: [4321] });
  try {
    const claim = (kind, requestId, operationId, p) => tunnels.receive({ kind, requestId, operationId, deviceId: "usb-1", port: p });
    claim("listen", "r1", "op-1", port);
    await until(() => sent.find((m) => m.requestId === "r1"), "answer r1");
    assert.match(sent.find((m) => m.requestId === "r1").error, /already in use/);
    claim("listen", "r2", "op-2", 80);
    await until(() => sent.find((m) => m.requestId === "r2"), "answer r2");
    assert.match(sent.find((m) => m.requestId === "r2").error, /privileged/);
    claim("listen", "r3", "op-3", 4321);
    await until(() => sent.find((m) => m.requestId === "r3"), "answer r3");
    assert.match(sent.find((m) => m.requestId === "r3").error, /Cody's own port/);
    claim("reverse", "r4", "op-4", 4321);
    await until(() => sent.find((m) => m.requestId === "r4"), "answer r4");
    assert.match(sent.find((m) => m.requestId === "r4").error, /Cody's own port/);
    claim("reverse", "r5", "op-5", 0);
    await until(() => sent.find((m) => m.requestId === "r5"), "answer r5");
    assert.match(sent.find((m) => m.requestId === "r5").error, /host port of an existing service/);
    assert.deepEqual(tunnels.list(), []);
  } finally {
    tunnels.closeAll("test over");
    taken.close();
  }
});

test("one operation holds one rule, and a session holds a bounded number", async () => {
  const { tunnels, sent } = host();
  try {
    tunnels.receive({ kind: "listen", requestId: "a", operationId: "op-same", deviceId: "usb-1", port: 0 });
    await until(() => sent.find((m) => m.requestId === "a" && m.kind === "ready"), "first rule");
    tunnels.receive({ kind: "listen", requestId: "b", operationId: "op-same", deviceId: "usb-1", port: 0 });
    await until(() => sent.find((m) => m.requestId === "b"), "second answer");
    assert.match(sent.find((m) => m.requestId === "b").error, /already holds a port rule/);
    for (let index = 1; index < MAX_TUNNELS_PER_SESSION; index += 1) {
      tunnels.receive({ kind: "listen", requestId: `n${index}`, operationId: `op-${index}`, deviceId: "usb-1", port: 0 });
    }
    await until(() => tunnels.list().length === MAX_TUNNELS_PER_SESSION, "the session limit");
    tunnels.receive({ kind: "listen", requestId: "over", operationId: "op-over", deviceId: "usb-1", port: 0 });
    await until(() => sent.find((m) => m.requestId === "over"), "over-limit answer");
    assert.match(sent.find((m) => m.requestId === "over").error, /at most 16 port rules/);
    // Ending the operation, or the device, takes its rule down.
    tunnels.closeOperation("op-same", "done");
    assert.equal(tunnels.list().length, MAX_TUNNELS_PER_SESSION - 1);
    assert.ok(sent.some((m) => m.kind === "released" && m.reason === "done"));
    tunnels.closeDevice("usb-1", "unplugged");
    assert.equal(tunnels.list().length, 0);
  } finally {
    tunnels.closeAll("test over");
  }
});

test("a reverse dial reports an unreachable host service and rejects ids the page cannot own", async () => {
  const dead = net.createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const { port } = dead.address();
  await new Promise((resolve) => dead.close(resolve));
  const { tunnels, sent, last } = host();
  try {
    tunnels.receive({ kind: "reverse", requestId: "r", operationId: "op-1", deviceId: "usb-1", port });
    const { tunnelId } = await until(() => last("ready"), "reverse rule");
    tunnels.receive({ kind: "connect", tunnelId, connectionId: "s-1" });
    assert.match(last("reset").reason, /Invalid connection id/);
    tunnels.receive({ kind: "connect", tunnelId, connectionId: "p-1" });
    await until(() => sent.find((m) => m.kind === "reset" && m.connectionId === "p-1"), "dial failure");
    assert.match(sent.find((m) => m.connectionId === "p-1").reason, /nothing is listening on that port/);
    tunnels.receive({ kind: "connect", tunnelId: "tunnel-unknown", connectionId: "p-2" });
    assert.match(last("reset").reason, /no longer active/);
    // Data for connections that do not exist is ignored, not an error.
    tunnels.receive({ kind: "data", connectionId: "s-404", base64: "AAAA" });
    tunnels.receive({ kind: "ack", connectionId: "s-404", bytes: 5 });
    assert.equal(tunnels.list().length, 1);
  } finally {
    tunnels.closeAll("test over");
  }
});

test("a sender stops at the credit window and resumes only as the far side acknowledges", async () => {
  const posted = [];
  const client = new TunnelClient((message) => posted.push(message));
  const lease = client.listen({ operationId: "op-1", deviceId: "usb-1", port: 0 }, new AbortController().signal);
  const request = posted.find((message) => message.kind === "listen");
  client.receive({ kind: "ready", requestId: request.requestId, tunnelId: "tunnel-1", port: 40000 });
  const forward = await lease;
  const connections = [];
  forward.onConnection((connection) => connections.push(connection));
  client.receive({ kind: "incoming", tunnelId: "tunnel-1", connectionId: "s-1" });
  const [connection] = connections;

  const total = TUNNEL_WINDOW_BYTES * 2;
  let finished = false;
  const writing = connection.write(new Uint8Array(total)).then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sentBytes = () => posted.filter((message) => message.kind === "data").reduce((sum, message) => sum + Buffer.from(message.base64, "base64").length, 0);
  assert.equal(finished, false, "the write waits for credit");
  assert.ok(sentBytes() >= TUNNEL_WINDOW_BYTES && sentBytes() < TUNNEL_WINDOW_BYTES + TUNNEL_CHUNK_BYTES, `stopped at the window, sent ${sentBytes()}`);

  for (let acknowledged = 0; !finished && acknowledged < total; acknowledged += TUNNEL_CHUNK_BYTES) {
    client.receive({ kind: "ack", connectionId: "s-1", bytes: TUNNEL_CHUNK_BYTES });
    await new Promise((resolve) => setImmediate(resolve));
  }
  await writing;
  assert.equal(sentBytes(), total);

  // A relay loss ends everything in flight with the reason, so nothing waits forever.
  const lost = forward.lost;
  client.dropAll("socket closed");
  assert.equal(await lost, "socket closed");
  await connection.closed;
  assert.equal(connection.failure, "socket closed");
  await assert.rejects(connection.write(new Uint8Array(1)), /socket closed/);
});

test("an abandoned port request is released if the server answers late", async () => {
  const posted = [];
  const client = new TunnelClient((message) => posted.push(message));
  const controller = new AbortController();
  const pending = client.reverse({ operationId: "op-1", deviceId: "usb-1", port: 9 }, controller.signal);
  const request = posted.find((message) => message.kind === "reverse");
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  client.receive({ kind: "ready", requestId: request.requestId, tunnelId: "tunnel-late", port: 9 });
  assert.deepEqual(posted.at(-1), { kind: "release", tunnelId: "tunnel-late" });
});

test("concurrent claims cannot slip past the operation and session limits while a listener is still binding", async () => {
  const { tunnels, sent } = host();
  try {
    // Same tick: nothing has finished binding when the later claims are checked.
    for (let index = 0; index <= MAX_TUNNELS_PER_SESSION; index += 1) {
      tunnels.receive({ kind: "listen", requestId: `q${index}`, operationId: `op-${index}`, deviceId: "usb-1", port: 0 });
    }
    await until(() => sent.filter((m) => m.kind === "ready" || m.kind === "failed").length === MAX_TUNNELS_PER_SESSION + 1, "every claim answered");
    assert.equal(sent.filter((m) => m.kind === "ready").length, MAX_TUNNELS_PER_SESSION);
    assert.equal(tunnels.list().length, MAX_TUNNELS_PER_SESSION);
    assert.match(sent.find((m) => m.kind === "failed").error, /at most 16 port rules/);
    tunnels.closeAll("test over");

    const before = sent.length;
    tunnels.receive({ kind: "listen", requestId: "twin-a", operationId: "op-twin", deviceId: "usb-1", port: 0 });
    tunnels.receive({ kind: "listen", requestId: "twin-b", operationId: "op-twin", deviceId: "usb-1", port: 0 });
    await until(() => sent.length - before === 2, "both twins answered");
    assert.equal(sent.slice(before).filter((m) => m.kind === "ready").length, 1, "one operation holds one listener");
    assert.equal(tunnels.list().length, 1);
    assert.match(sent.slice(before).find((m) => m.kind === "failed").error, /already holds a port rule/);
  } finally {
    tunnels.closeAll("test over");
  }
});

test("a claim whose operation ends while the listener binds leaves no listener or quota slot behind", async () => {
  let active = true;
  const { tunnels, sent } = host({ active: () => active });
  try {
    tunnels.receive({ kind: "listen", requestId: "gone", operationId: "op-1", deviceId: "usb-1", port: 0 });
    tunnels.closeOperation("op-1", "ended");
    active = false;
    await until(() => sent.find((m) => m.requestId === "gone"), "answer");
    assert.equal(sent.find((m) => m.requestId === "gone").kind, "failed");
    assert.deepEqual(tunnels.list(), []);
    active = true;
    tunnels.receive({ kind: "listen", requestId: "again", operationId: "op-1", deviceId: "usb-1", port: 0 });
    await until(() => sent.find((m) => m.requestId === "again"), "second answer");
    assert.equal(sent.find((m) => m.requestId === "again").kind, "ready", "the slot was released");
  } finally {
    tunnels.closeAll("test over");
  }
});

test("when the device closes first, the page still hears the host connection finish", async () => {
  const { tunnels, sent, last } = host();
  try {
    tunnels.receive({ kind: "listen", requestId: "r", operationId: "op-1", deviceId: "usb-1", port: 0 });
    const { port } = await until(() => last("ready"), "forward rule");
    const client = net.connect({ host: "127.0.0.1", port });
    client.on("error", () => {});
    const { connectionId } = await until(() => last("incoming"), "incoming client");
    tunnels.receive({ kind: "opened", connectionId });
    // The device finished its response (e.g. `Connection: close`) and ended its direction.
    tunnels.receive({ kind: "end", connectionId });
    // The client sees our FIN, closes, and the page must be told its host side is done too.
    const closed = await until(() => sent.find((m) => (m.kind === "end" || m.kind === "reset") && m.connectionId === connectionId), "a final notice for the page");
    assert.equal(closed.kind, "end", "an ordinary close is an end, not an error");
    await until(() => tunnels.list()[0].connections === 0, "server connection to be forgotten");
    client.destroy();
  } finally {
    tunnels.closeAll("test over");
  }
});

test("a client that closes before the device ends still gets a single end notice", async () => {
  const { tunnels, sent, last } = host();
  try {
    tunnels.receive({ kind: "listen", requestId: "r", operationId: "op-1", deviceId: "usb-1", port: 0 });
    const { port } = await until(() => last("ready"), "forward rule");
    const client = net.connect({ host: "127.0.0.1", port });
    const { connectionId } = await until(() => last("incoming"), "incoming client");
    tunnels.receive({ kind: "opened", connectionId });
    client.end();
    await until(() => sent.find((m) => m.kind === "end" && m.connectionId === connectionId), "end for the page");
    tunnels.receive({ kind: "end", connectionId });
    await until(() => tunnels.list()[0].connections === 0, "connection forgotten");
    assert.equal(sent.filter((m) => (m.kind === "end" || m.kind === "reset") && m.connectionId === connectionId).length, 1);
  } finally {
    tunnels.closeAll("test over");
  }
});
