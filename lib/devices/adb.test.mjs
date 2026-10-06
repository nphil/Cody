import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { adbFlasher, calculateAdbChecksum, createAdbHardwareConnection, resumeVerifiedStagedPush } = await jiti.import("./adb.ts");
const { AdbAuthType, AdbCommand, AdbPacketHeader, AdbSignatureAuthenticator } = await import("@yume-chan/adb");
const { Consumable } = await import("@yume-chan/stream-extra");

function fakeTransport(reads = [], onWrite) {
  const writes = [];
  let waiting;
  const enqueue = (chunk) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(chunk);
      return;
    }
    reads.push(chunk);
  };
  return {
    kind: "usb",
    writes,
    async read(_length, _timeout, signal) {
      if (reads.length > 0) return reads.shift();
      return new Promise((resolve, reject) => {
        const abort = () => {
          if (waiting) waiting = undefined;
          reject(signal.reason);
        };
        waiting = (chunk) => {
          signal.removeEventListener("abort", abort);
          resolve(chunk);
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
    async write(bytes) {
      const copy = new Uint8Array(bytes);
      writes.push(copy);
      await onWrite?.(copy, { enqueue, writes });
    },
  };
}

function packet(command, arg0, arg1, payload) {
  const header = new Uint8Array(AdbPacketHeader.size);
  AdbPacketHeader.serialize({ command, arg0, arg1, payloadLength: payload.length, checksum: calculateAdbChecksum(payload), magic: command ^ -1 }, header);
  return [header, payload];
}

test("ADB HardwareTransport adapter uses installed packet framing and checksum", async () => {
  const payload = new TextEncoder().encode("device::");
  const transport = fakeTransport(packet(AdbCommand.Connect, 0x01000001, 4096, payload));
  const connection = createAdbHardwareConnection(transport, new AbortController().signal);
  const inbound = await connection.readable.getReader().read();
  assert.equal(inbound.done, false);
  assert.equal(inbound.value.command, AdbCommand.Connect);
  assert.deepEqual(inbound.value.payload, payload);
  const writer = connection.writable.getWriter();
  const outbound = new Uint8Array([1, 2, 3, 4]);
  await writer.write(new Consumable({ command: AdbCommand.Okay, arg0: 7, arg1: 8, payload: outbound, checksum: calculateAdbChecksum(outbound), magic: AdbCommand.Okay ^ -1 }));
  await writer.close();
  assert.equal(transport.writes.length, 2);
  assert.equal(new DataView(transport.writes[0].buffer).getUint32(16, true), calculateAdbChecksum(outbound));
});

test("ADB quiet reads after the first packet preserve the established connection", async () => {
  const first = packet(AdbCommand.Connect, 0x01000000, 4096, new TextEncoder().encode("device::"));
  const second = packet(AdbCommand.Okay, 7, 8, new Uint8Array());
  const connection = createAdbHardwareConnection(fakeTransport([...first, null, ...second]), new AbortController().signal);
  const reader = connection.readable.getReader();
  assert.equal((await reader.read()).value.command, AdbCommand.Connect);
  assert.equal((await reader.read()).value.command, AdbCommand.Okay);
  await reader.cancel();
});

test("ADB rejects malformed frame magic before ya-webadb authentication", async () => {
  const payload = new TextEncoder().encode("device::");
  const [header] = packet(AdbCommand.Connect, 0x01000000, 4096, payload);
  new DataView(header.buffer).setInt32(20, 0, true);
  const connection = createAdbHardwareConnection(fakeTransport([header, payload]), new AbortController().signal);
  await assert.rejects(() => connection.readable.getReader().read(), /magic/);
});

test("ADB CNXN probe fails rather than inventing a daemon handshake", async () => {
  const transport = fakeTransport([null, null]);
  await assert.rejects(() => adbFlasher.run({ protocol: "adb", action: "detect" }, { transport, signal: new AbortController().signal, progress() {}, async save() { return "unused"; }, async confirm() {} }), /ADB connection was not established/);
  assert.equal(new DataView(transport.writes[0].buffer).getUint32(0, true), AdbCommand.Connect);
});

test("ADB falls back through the legacy OPEN probe with conservative v1 semantics", async () => {
  const openedServices = [];
  let pendingOpen;
  let remoteId = 40;
    const awaitingClose = new Map();
  const transport = fakeTransport([null], async (bytes, { enqueue }) => {
      if (bytes.length === AdbPacketHeader.size) {
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const command = header.getUint32(0, true);
        const localId = header.getUint32(4, true);
        const peerId = header.getUint32(8, true);
        if (command === AdbCommand.Open) pendingOpen = localId;
        else if (command === AdbCommand.Okay && awaitingClose.get(localId) === peerId) {
          awaitingClose.delete(localId);
          enqueue(packet(AdbCommand.Close, peerId, localId, new Uint8Array())[0]);
        }
        return;
      }
      if (pendingOpen === undefined) return;
      const localId = pendingOpen;
      pendingOpen = undefined;
      const service = new TextDecoder().decode(bytes);
      openedServices.push(service);
      const peerId = remoteId++;
      enqueue(packet(AdbCommand.Okay, peerId, localId, new Uint8Array())[0]);
      const output = new TextEncoder().encode(service.startsWith("shell:printf cody-adb-probe") ? "probe" : "Cody\n");
      const write = packet(AdbCommand.Write, peerId, localId, output);
      awaitingClose.set(localId, peerId);
      setTimeout(() => {
        enqueue(write[0]);
        enqueue(write[1]);
      }, 0);
    });
  const result = await adbFlasher.run(
    { protocol: "adb", action: "detect" },
    { transport, signal: new AbortController().signal, progress() {}, async save() { return "unused"; }, async confirm() {} },
  );
  assert.equal(result.details.serial, "cody-browser-existing");
  assert.equal(result.details.shellProtocol, false);
  assert.ok(openedServices.includes("shell:printf cody-adb-probe\0"));
  assert.equal(openedServices.filter((service) => service.startsWith("exec:getprop ")).length, 3);
  assert.ok(openedServices.every((service) => !service.startsWith("shell,v2,")));
  for (let index = 0; index < transport.writes.length;) {
    const header = transport.writes[index++];
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const payloadLength = view.getUint32(12, true);
    const payload = payloadLength === 0 ? new Uint8Array() : transport.writes[index++];
    assert.equal(view.getUint32(16, true), calculateAdbChecksum(payload));
  }
});

test("ADB AUTH signature uses the installed authenticator with a real RSA key", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-1", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const token = crypto.getRandomValues(new Uint8Array(20));
  const auth = AdbSignatureAuthenticator({ async *iterateKeys() { yield { buffer: privateKey }; }, async generateKey() { throw new Error("unexpected"); } }, async () => ({ command: AdbCommand.Auth, arg0: AdbAuthType.Token, arg1: 0, payload: token }));
  const response = (await auth.next()).value;
  assert.equal(response.command, AdbCommand.Auth);
  assert.equal(response.arg0, AdbAuthType.Signature);
  assert.equal(response.payload.length, 256);
});

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

class FakeStagingIo {
  files = new Map();
  writes = [];
  disconnectAfterSecondWrite = true;
  async writeFile(path, data) { this.writes.push(path); this.files.set(path, new Uint8Array(data)); if (this.disconnectAfterSecondWrite && this.writes.length === 2) { this.disconnectAfterSecondWrite = false; throw new Error("device disconnected after sync write"); } }
  async exists(path) { return this.files.has(path); }
  async length(path) { return this.files.get(path)?.length ?? 0; }
  async sha256(path) { return sha256(this.files.get(path)); }
  async makeDirectory() {}
  async concatenate(parts, destination) { const data = new Uint8Array(parts.reduce((n, path) => n + this.files.get(path).length, 0)); let offset = 0; for (const path of parts) { data.set(this.files.get(path), offset); offset += this.files.get(path).length; } this.files.set(destination, data); }
  async moveReplace(source, destination) { this.files.set(destination, this.files.get(source)); this.files.delete(source); }
}

test("verified chunk staging resumes only a hash-validated prefix after disconnect", async () => {
  const bytes = new TextEncoder().encode("abcdefghij");
  const chunks = await Promise.all([{ index: 0, offset: 0, length: 3 }, { index: 1, offset: 3, length: 3 }, { index: 2, offset: 6, length: 4 }].map(async (chunk) => ({ ...chunk, sha256: await sha256(bytes.slice(chunk.offset, chunk.offset + chunk.length)), path: `/stage/chunk-${chunk.index}` })));
  const state = { target: "/sdcard/result.bin", sha256: await sha256(bytes), length: bytes.length, stagingDirectory: "/stage", assembledPath: "/stage/assembled", chunks, reconnects: 0 };
  const io = new FakeStagingIo();
  let reconnects = 0;
  await resumeVerifiedStagedPush({ input: new Blob([bytes]), state, io, progress() {}, async reconnect() { reconnects += 1; return io; }, isConnectionFailure(error) { return String(error).includes("disconnected"); } });
  assert.equal(reconnects, 1);
  assert.deepEqual(io.files.get(state.target), bytes);
});
