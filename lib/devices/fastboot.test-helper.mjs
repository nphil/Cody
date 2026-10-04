import { applySparse, isSparse } from "./sparse.test-helper.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frame = (type, payload = "") => Buffer.concat([Buffer.from(type), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);

/**
 * A fastboot bootloader at the bulk-transfer boundary: it keeps real partition
 * bytes, applies raw and Android sparse downloads the way a bootloader does,
 * enforces its own max-download-size, and serves fetch/upload. Cody's real
 * fastboot flasher talks to it, so command order, DATA framing, and what ends up
 * on the partitions are all observable.
 */
export function fakeFastboot({
  variables = {},
  partitions = {},
  slotted = [],
  logical = [],
  fetch = true,
  fetchSize = 0x100000,
  maxDownload,
  failFlash = () => false,
  corruptFetchOf,
  staged,
} = {}) {
  const store = Object.fromEntries(Object.entries(partitions).map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const queue = [];
  const log = [];
  const flashed = [];
  let incoming;
  let downloaded;
  let stagedData = staged ? Buffer.from(staged) : undefined;
  let flashCount = 0;

  const reply = (...frames) => queue.push(...frames);
  const fail = (message) => reply(frame("FAIL", message));
  const hex = (value) => `0x${value.toString(16)}`;

  const getvar = (name) => {
    if (name in variables) return variables[name];
    if (name === "max-download-size" && maxDownload !== undefined) return maxDownload;
    if (name === "fetch-size" && fetch) return hex(fetchSize);
    let match = /^partition-size:(.+)$/.exec(name);
    if (match && store[match[1]]) return hex(store[match[1]].length);
    match = /^has-slot:(.+)$/.exec(name);
    if (match) return slotted.includes(match[1]) ? "yes" : store[match[1]] ? "no" : undefined;
    match = /^is-logical:(.+)$/.exec(name);
    if (match) return logical.includes(match[1]) ? "yes" : "no";
    return undefined;
  };

  const handle = (text) => {
    log.push(text);
    if (text.startsWith("getvar:")) {
      const value = getvar(text.slice(7));
      if (value === undefined) fail("Unknown variable");
      else reply(frame("OKAY", value));
    } else if (text.startsWith("download:")) {
      const size = Number.parseInt(text.slice(9), 16);
      if (maxDownload !== undefined && size > Number(maxDownload)) fail("data too large");
      else {
        incoming = { size, chunks: [], received: 0 };
        reply(frame("DATA", size.toString(16).padStart(8, "0")));
      }
    } else if (text.startsWith("flash:")) {
      const name = text.slice(6);
      flashCount += 1;
      if (!downloaded) fail("no data downloaded");
      else if (!store[name]) fail("no such partition");
      else if (failFlash(name, flashCount)) fail("write failed");
      else {
        if (applyDownload(store[name], downloaded)) {
          flashed.push({ partition: name, sparse: isSparse(downloaded), bytes: downloaded.length });
          reply(frame("OKAY"));
        } else fail("image too large for partition");
        downloaded = undefined;
      }
    } else if (text.startsWith("fetch:")) {
      const [, name, offset, length] = text.split(":");
      if (!fetch) fail("unknown command");
      else if (!store[name]) fail("no such partition");
      else {
        const start = Number.parseInt(offset, 16);
        const size = Number.parseInt(length, 16);
        const data = Buffer.from(store[name].subarray(start, start + size));
        if (corruptFetchOf === name && flashed.some((entry) => entry.partition === name)) data[0] ^= 1;
        reply(frame("DATA", size.toString(16).padStart(8, "0")), data, frame("OKAY"));
      }
    } else if (text === "upload") {
      if (!stagedData) fail("no staged data");
      else reply(frame("DATA", stagedData.length.toString(16).padStart(8, "0")), stagedData, frame("OKAY"));
    } else if (text.startsWith("erase:")) {
      const name = text.slice(6);
      if (!store[name]) fail("no such partition");
      else {
        store[name].fill(0xff);
        reply(frame("OKAY"));
      }
    } else if (text === "boot" || text.startsWith("reboot") || text.startsWith("set_active:")) {
      reply(frame("OKAY"));
    } else if (text.startsWith("oem ")) {
      stagedData = Buffer.from(`output of ${text}`);
      reply(frame("OKAY"));
    } else fail("unknown command");
  };

  const transport = {
    kind: "usb",
    async read(length) {
      const head = queue[0];
      if (!head) return null;
      if (head.length <= length) {
        queue.shift();
        return Uint8Array.from(head);
      }
      queue[0] = head.subarray(length);
      return Uint8Array.from(head.subarray(0, length));
    },
    async write(bytes) {
      if (incoming) {
        incoming.chunks.push(Buffer.from(bytes));
        incoming.received += bytes.length;
        if (incoming.received > incoming.size) throw new Error("host sent more than the announced download");
        if (incoming.received === incoming.size) {
          downloaded = Buffer.concat(incoming.chunks);
          incoming = undefined;
          reply(frame("OKAY"));
        }
        return;
      }
      handle(decoder.decode(bytes));
    },
  };

  return { transport, log, flashed, partitions: store, get staged() { return stagedData; } };

  /** A bootloader writes a raw image at offset 0, or applies a sparse one chunk by chunk. */
  function applyDownload(partition, data) {
    if (!isSparse(data)) {
      if (data.length > partition.length) return false;
      partition.set(data, 0);
      return true;
    }
    const blockSize = data.readUInt32LE(12);
    if (data.readUInt32LE(16) * blockSize > partition.length) return false;
    applySparse(partition, data);
    return true;
  }
}

export const text = (bytes) => decoder.decode(bytes);
export { encoder };
