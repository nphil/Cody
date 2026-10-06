// Shared harness: a real server-side bridge wired to a page-side runner over an in-memory socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { createJiti } from "jiti";
import { allowAgent } from "./trust.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getDeviceBridge } = await jiti.import("./bus.ts");
const { attachDeviceSocket } = await jiti.import("./socket.ts");
const { createPageOperationDelegate } = await jiti.import("./operations.ts");
const { adbFlasher } = await jiti.import("./adb.ts");
const { TunnelClient } = await jiti.import("./tunnel-client.ts");
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

export const tool = (name) => DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
let sessionCounter = 0;

export async function until(getter, what = "condition", ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await getter();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A loopback TCP server standing in for "a service" on either side. */
export async function listen(onConnection) {
  const server = net.createServer(onConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

/** Send `payload`, read until `expected` bytes arrive (or the peer closes). */
export function exchange(port, payload, expected = payload.length) {
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

export function refused(port) {
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
export function connectPage(daemon, sessionId = `tunnel-session-${Date.now()}-${sessionCounter++}`) {
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
    /**
     * Starts an AGENT operation through the tool, the way the chat does. The first one on the device raises the trust question,
     * which is answered Allow unless `allow` is false (the operation then stays `awaiting-trust`).
     */
    async start(toolName, args, { allow = true } = {}) {
      const text = await tool(toolName).handler({ device: "usb-1", ...args }, { bridge });
      const id = /Operation (\S+) was accepted/.exec(text)?.[1];
      assert.ok(id, text);
      if (allow && manager.trustLevel("usb-1") === "none") await allowAgent(manager, { deviceId: "usb-1" });
      return id;
    },
    state: (id) => manager.status(id)?.state,
    output: (id) => manager.status(id)?.output.map((row) => row.line).join("\n") ?? "",
    async finished(id) {
      return until(() => { const snapshot = manager.status(id); return ["succeeded", "failed", "cancelled"].includes(snapshot?.state) && snapshot; }, `operation ${id} to finish`);
    },
  };
}

