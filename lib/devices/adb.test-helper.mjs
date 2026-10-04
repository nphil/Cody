import { AdbCommand, AdbPacketHeader, calculateChecksum } from "@yume-chan/adb";

/**
 * Fake daemon at the USB packet boundary, including flow-control acknowledgements. `state` is what its
 * banner announces (device, recovery, sideload ...). `silentOpen(service)` returning true makes the daemon
 * record the OPEN and never acknowledge it, the way a daemon that stopped answering does.
 */
export function fakeAdb({ output = () => "result\n__CODY_ADB_STATUS__0\n", onInput, features = "", state = "device", silentOpen = () => false } = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const services = [], inputs = [], chunks = [], sockets = new Map();
  let waiting, header, closed = false;
  const enqueue = (data) => { if (!data.length) return; if (waiting) { const w = waiting; waiting = undefined; w.resolve(data); } else chunks.push(data); };
  const packet = (command, remote, local, payload = new Uint8Array()) => {
    if (typeof payload === "string") payload = encoder.encode(payload);
    const h = new Uint8Array(AdbPacketHeader.size);
    AdbPacketHeader.serialize({ command, arg0: remote, arg1: local, payloadLength: payload.length, checksum: calculateChecksum(payload), magic: command ^ -1 }, h);
    enqueue(h); enqueue(payload);
  };
  const process = async (h, payload) => {
    if (h.command === AdbCommand.Connect) packet(AdbCommand.Connect, 0x01000000, 4096, state + "::features=" + features + ";");
    else if (h.command === AdbCommand.Open) {
      const service = decoder.decode(payload).replace(/\0$/, "");
      services.push(service);
      if (silentOpen(service)) return;
      const persistent = service === "shell:" || service === "sync:" || service.startsWith("sideload-host:");
      sockets.set(h.local, { remote: h.local + 100, persistent, service });
      packet(AdbCommand.Okay, h.local + 100, h.local);
      const text = service === "shell:" ? "root@cronos:/ # " : await output(service);
      if (text !== undefined) setTimeout(() => packet(AdbCommand.Write, h.local + 100, h.local, text), 0);
    } else if (h.command === AdbCommand.Okay) {
      const socket = sockets.get(h.local);
      if (socket && !socket.persistent) { packet(AdbCommand.Close, socket.remote, h.local); sockets.delete(h.local); }
    } else if (h.command === AdbCommand.Write) {
      inputs.push(decoder.decode(payload));
      packet(AdbCommand.Okay, h.remote, h.local);
      const service = sockets.get(h.local)?.service;
      if (onInput) await onInput(service, payload, (data) => packet(AdbCommand.Write, h.remote, h.local, data));
      else packet(AdbCommand.Write, h.remote, h.local, "uid=0(root)\r\nroot@cronos:/ # ");
    } else if (h.command === AdbCommand.Close) { sockets.delete(h.local); packet(AdbCommand.Close, h.remote, h.local); }
  };
  return {
    kind: "usb", services, inputs,
    async read(_length, _timeout, signal) {
      signal.throwIfAborted();
      if (closed) throw new DOMException("Disconnected", "AbortError");
      if (chunks.length) return chunks.shift();
      return new Promise((resolve, reject) => {
        const abort = () => { waiting = undefined; reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        waiting = { resolve(value) { signal.removeEventListener("abort", abort); resolve(value); }, reject };
      });
    },
    async write(bytes, signal) {
      signal.throwIfAborted();
      if (!header) {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        header = { command: v.getUint32(0, true), local: v.getUint32(4, true), remote: v.getUint32(8, true), length: v.getUint32(12, true) };
        if (header.length) return;
        const h = header; header = undefined; await process(h, new Uint8Array());
      } else { const h = header; header = undefined; await process(h, bytes); }
    },
    close() { closed = true; waiting?.reject(new DOMException("Disconnected", "AbortError")); waiting = undefined; },
  };
}

export async function waitFor(getter) {
  for (let i = 0; i < 200; i++) { const value = getter(); if (value) return value; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("Expected operation state was not reached");
}
