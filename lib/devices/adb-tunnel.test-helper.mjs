import net from "node:net";
import { AdbCommand, AdbPacketHeader, calculateChecksum } from "@yume-chan/adb";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PAYLOAD = 4096;

/**
 * A fake adbd at the USB packet boundary whose streams are backed by REAL
 * loopback TCP: `tcp:PORT` OPEN dials 127.0.0.1:PORT, and `reverse:forward:`
 * makes the "device" listen on a real loopback port whose clients are announced
 * to the host as device-initiated streams, exactly as adbd does. The packet
 * framing (legacy, no delayed ack) matches adb.test-helper.mjs.
 */
export function fakeTunnelDevice({ output = () => "result\n__CODY_ADB_STATUS__0\n" } = {}) {
  const chunks = [];
  const services = [];
  const streams = new Map();
  const reverseListeners = new Map();
  const killed = [];
  let waiting;
  let header;
  let closed = false;
  let nextId = 100;
  let connects = 0;
  let withholdReverse = false;
  let closeGate;

  const enqueue = (data) => {
    if (!data.length) return;
    if (waiting) {
      const pending = waiting;
      waiting = undefined;
      pending.resolve(data);
    } else chunks.push(data);
  };
  const send = (command, arg0, arg1, payload = new Uint8Array()) => {
    if (closed) return;
    if (typeof payload === "string") payload = encoder.encode(payload);
    const head = new Uint8Array(AdbPacketHeader.size);
    AdbPacketHeader.serialize({ command, arg0, arg1, payloadLength: payload.length, checksum: calculateChecksum(payload), magic: command ^ -1 }, head);
    enqueue(head);
    enqueue(payload);
  };

  const finishStream = (stream) => {
    if (!streams.delete(stream.id)) return;
    stream.socket?.destroy();
    if (stream.hostId) send(AdbCommand.Close, stream.id, stream.hostId);
  };
  const flush = (stream) => {
    if (!stream.opened || stream.waitingAck) return;
    if (stream.outbox.length) {
      const chunk = stream.outbox[0];
      const part = chunk.subarray(0, MAX_PAYLOAD);
      if (part.length === chunk.length) stream.outbox.shift();
      else stream.outbox[0] = chunk.subarray(part.length);
      stream.waitingAck = true;
      send(AdbCommand.Write, stream.id, stream.hostId, part);
    } else if (stream.ended) finishStream(stream);
  };
  const attachSocket = (stream, socket) => {
    stream.socket = socket;
    stream.outbox = [];
    socket.on("data", (data) => { stream.outbox.push(data); flush(stream); });
    socket.on("end", () => { stream.ended = true; flush(stream); });
    socket.on("error", () => { stream.ended = true; stream.outbox.length = 0; flush(stream); });
    socket.on("close", () => { stream.ended = true; flush(stream); });
  };
  const script = (hostId, text) => {
    const id = nextId++;
    const stream = { id, hostId, scripted: true, opened: true, sentText: text !== undefined };
    streams.set(id, stream);
    send(AdbCommand.Okay, id, hostId);
    if (stream.sentText) setTimeout(() => send(AdbCommand.Write, id, hostId, text), 0);
    else finishStream(stream);
  };
  const hex4 = (length) => length.toString(16).padStart(4, "0");

  const withheld = [];
  const startReverse = (hostId, request, lateStream) => {
    const [deviceAddress, hostAddress] = request.split(";");
    const requested = Number(deviceAddress.slice(4));
    if (withholdReverse && !lateStream) {
      // Accept the service, answer nothing: the host library waits for the reply forever.
      const id = nextId++;
      const stream = { id, hostId, scripted: true, opened: true };
      streams.set(id, stream);
      withheld.push({ stream, request });
      send(AdbCommand.Okay, id, hostId);
      return;
    }
    const reply = (text) => {
      if (!lateStream) return script(hostId, text);
      // The answer finally arrives on the stream the host has been waiting on.
      lateStream.sentText = true;
      if (streams.has(lateStream.id)) send(AdbCommand.Write, lateStream.id, hostId, text);
    };
    // adbd rebinds an address that is already listening.
    const previous = reverseListeners.get(`tcp:${requested}`);
    if (previous) {
      previous.server.close();
      reverseListeners.delete(`tcp:${requested}`);
    }
    const server = net.createServer((socket) => {
      const id = nextId++;
      const stream = { id, hostId: 0, opened: false, waitingAck: false };
      streams.set(id, stream);
      socket.pause();
      attachSocket(stream, socket);
      send(AdbCommand.Open, id, 0, `${hostAddress}\0`);
    });
    server.listen(requested, "127.0.0.1", () => {
      const port = server.address().port;
      reverseListeners.set(`tcp:${port}`, { server, hostAddress });
      reply(`OKAY${hex4(String(port).length)}${port}`);
    });
  };

  const process = async (head, payload) => {
    const { command, arg0, arg1 } = head;
    if (command === AdbCommand.Connect) {
      connects += 1;
      send(AdbCommand.Connect, 0x01000000, MAX_PAYLOAD, "device::features=;");
    } else if (command === AdbCommand.Open) {
      const service = decoder.decode(payload).replace(/\0$/, "");
      services.push(service);
      if (service.startsWith("tcp:")) {
        const socket = net.connect({ host: "127.0.0.1", port: Number(service.slice(4)) });
        socket.once("error", () => send(AdbCommand.Close, 0, arg0));
        socket.once("connect", () => {
          const id = nextId++;
          const stream = { id, hostId: arg0, opened: true, waitingAck: false };
          streams.set(id, stream);
          attachSocket(stream, socket);
          send(AdbCommand.Okay, id, arg0);
        });
      } else if (service.startsWith("reverse:forward:")) startReverse(arg0, service.slice("reverse:forward:".length));
      else if (service.startsWith("reverse:killforward:")) {
        const address = service.slice("reverse:killforward:".length);
        killed.push(address);
        const listener = reverseListeners.get(address);
        listener?.server.close();
        reverseListeners.delete(address);
        script(arg0, "OKAY");
      } else if (service === "reverse:list-forward") {
        const lines = [...reverseListeners].map(([address, rule]) => `fake-serial ${address} ${rule.hostAddress}\n`).join("");
        script(arg0, `${hex4(lines.length)}${lines}`);
      } else script(arg0, await output(service));
    } else if (command === AdbCommand.Okay) {
      const stream = streams.get(arg1);
      if (!stream) return;
      if (stream.scripted) {
        if (stream.sentText) finishStream(stream);
        return;
      }
      if (!stream.opened) {
        stream.opened = true;
        stream.hostId = arg0;
        stream.socket.resume();
      } else stream.waitingAck = false;
      flush(stream);
    } else if (command === AdbCommand.Write) {
      const stream = streams.get(arg1);
      if (!stream) return;
      if (stream.socket) {
        const ack = () => send(AdbCommand.Okay, stream.id, arg0);
        if (stream.socket.write(payload)) ack();
        else stream.socket.once("drain", ack);
      } else send(AdbCommand.Okay, stream.id, arg0);
    } else if (command === AdbCommand.Close) {
      const stream = streams.get(arg1);
      if (stream) {
        streams.delete(stream.id);
        stream.socket?.destroy();
        if (arg0 !== 0) send(AdbCommand.Close, stream.id, arg0);
      }
    }
  };
  return {
    kind: "usb",
    services,
    killed,
    reverseListeners,
    get openStreams() { return streams.size; },
    get connects() { return connects; },
    /** Answer every withheld reverse registration now, as a slow daemon would. */
    answerWithheld() {
      for (const { stream, request } of withheld.splice(0)) startReverse(stream.hostId, request, stream);
    },
    set withholdReverse(value) { withholdReverse = value; },
    /** Stall every CLSE the host sends until the returned function is called. */
    holdClose() {
      const { promise, resolve } = Promise.withResolvers();
      closeGate = promise;
      return () => { closeGate = undefined; resolve(); };
    },
    describeStreams() { return [...streams.values()].map((s) => ({ id: s.id, hostId: s.hostId, opened: s.opened, scripted: !!s.scripted, waitingAck: s.waitingAck, ended: s.ended, out: s.outbox?.length })); },
    /** Port the emulated device listens on for a `tcp:` reverse address. */
    devicePort(address) { return reverseListeners.get(address)?.server.address().port; },
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
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        header = { command: view.getUint32(0, true), arg0: view.getUint32(4, true), arg1: view.getUint32(8, true), length: view.getUint32(12, true) };
        if (header.length) return;
        const head = header;
        header = undefined;
        if (head.command === AdbCommand.Close && closeGate) await closeGate;
        await process(head, new Uint8Array());
      } else {
        const head = header;
        header = undefined;
        await process(head, bytes);
      }
    },
    close() {
      closed = true;
      waiting?.reject(new DOMException("Disconnected", "AbortError"));
      waiting = undefined;
      for (const stream of streams.values()) stream.socket?.destroy();
      streams.clear();
      for (const { server } of reverseListeners.values()) server.close();
      reverseListeners.clear();
    },
  };
}
