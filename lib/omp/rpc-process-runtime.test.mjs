import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { RpcProcess, RpcCommandError } = jiti("./rpc-process.ts");
const { encodeRpcFrames, MAX_RPC_FRAME_BYTES } = jiti("./rpc-frame.ts");

function makeTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const commands = [];
  const spawnCalls = [];
  let partial = "";
  let onCommand = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const command = JSON.parse(line);
      commands.push(command);
      onCommand(command);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`);
  });

  return {
    commands,
    spawnCalls,
    child,
    set onCommand(callback) { onCommand = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    sendFrames(frames) { for (const frame of frames) stdout.write(frame); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: process.cwd(),
    dependencies: {
      resolveOmpBin: () => "fake-omp",
      spawn: transport.spawn,
    },
  });
}

test("RpcProcess negotiates v2 and correlates out-of-order command responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  assert.equal(await proc.negotiateProtocol(ready), 2);

  const first = proc.sendCommand({ type: "first" });
  const second = proc.sendCommand({ type: "second" });
  // Writes are serialized through a FIFO queue (physical v2 chunk sequences
  // must not interleave), so the commands land asynchronously.
  while (transport.commands.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [firstCommand, secondCommand] = transport.commands.slice(-2);
  transport.send({ type: "response", id: secondCommand.id, command: "second", success: true, data: "second" });
  transport.send({ type: "response", id: firstCommand.id, command: "first", success: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await proc.dispose(0);
});

test("RpcProcess writes correlated host results without creating pending commands", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();

  const toolResult = {
    type: "host_tool_result",
    id: "host/tool:α\u0000-007",
    result: { content: [{ type: "text", text: "done" }] },
  };
  const uriResult = {
    type: "host_uri_result",
    id: "uri/request:β\u0000-042",
    content: "contents",
    contentType: "text/plain",
  };
  proc.sendFrame(toolResult);
  proc.sendFrame(uriResult);
  while (transport.commands.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(transport.commands, [toolResult, uriResult]);
  assert.equal(proc.pending.size, 0);

  const ordinaryResponse = proc.sendCommand({ type: "ordinary_command" });
  while (transport.commands.length < 3) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const ordinaryCommand = transport.commands[2];
  assert.equal(ordinaryCommand.id, "w1");
  assert.equal(proc.pending.size, 1);
  transport.send({
    type: "response",
    id: ordinaryCommand.id,
    command: ordinaryCommand.type,
    success: true,
    data: "ok",
  });
  assert.equal(await ordinaryResponse, "ok");
  assert.equal(proc.pending.size, 0);
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

/**
 * The wedge this guards against: a prompt carrying a base64 image exceeded the
 * 1 MiB line limit, protocol v2 chunked it toward omp — whose stdin reader has
 * no reassembly — and the command simply never existed as far as omp was
 * concerned. Nothing answered, sendCommand has no default timeout, and the chat
 * sat on "Waiting for model…" forever. It must now fail immediately, at BOTH
 * protocol versions, with a code the API layer can turn into a 400.
 */
for (const negotiate of [false, true]) {
  test(`an oversized command is rejected fast at protocol v${negotiate ? 2 : 1}, never written`, async () => {
    const transport = makeTransport();
    transport.onCommand = (command) => {
      if (command.type === "negotiate_protocol") {
        transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
      }
    };
    const proc = startProcess(transport);
    const ready = await proc.waitReady();
    if (negotiate) assert.equal(await proc.negotiateProtocol(ready), 2);
    const writtenBefore = transport.commands.length;

    // A real prompt shape: message plus one base64 image over the frame limit.
    const oversized = proc.sendCommand({
      type: "prompt",
      message: "what is in this photo?",
      images: [{ type: "image", mimeType: "image/jpeg", data: "A".repeat(MAX_RPC_FRAME_BYTES) }],
    });
    const error = await oversized.then(() => null, (thrown) => thrown);
    assert.ok(error instanceof RpcCommandError, "an oversized command must reject with RpcCommandError");
    assert.equal(error.code, "frame_too_large");
    assert.equal(error.command, "prompt");
    assert.match(error.message, new RegExp(String(MAX_RPC_FRAME_BYTES)));
    // Nothing reached omp — no chunk lines, no truncated command — and no
    // pending entry was left behind to wait forever.
    assert.equal(transport.commands.length, writtenBefore);
    assert.equal(proc.pending.size, 0);

    // The transport is still usable: the rejection is per-command.
    const ordinary = proc.sendCommand({ type: "get_state" });
    while (transport.commands.length < writtenBefore + 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const command = transport.commands[transport.commands.length - 1];
    assert.equal(command.type, "get_state");
    transport.send({ type: "response", id: command.id, command: command.type, success: true, data: "ok" });
    assert.equal(await ordinary, "ok");
    await proc.dispose(0);
  });
}

test("RpcProcess reassembles v2 events and rejects pending commands when the child crashes", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  const expected = { type: "message_update", content: "x".repeat(1024 * 1024) };
  transport.sendFrames(encodeRpcFrames(expected, 2, "event-1"));
  assert.deepEqual(frames, [expected]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /omp exited/);
});
