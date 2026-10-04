import { createHash } from "node:crypto";

/**
 * An ESP chip running esptool's flasher stub, emulated at the SLIP packet
 * boundary. The REAL esptool-js `ESPLoader` and Cody's REAL `EspTransport`
 * talk to it, so command encoding, response framing, status checks and
 * timeouts are exercised exactly as on the wire; only the silicon is faked.
 *
 * It keeps a flash image, so an erase really blanks it and a device-side MD5
 * really hashes what is there.
 */

const END = 0xc0;
const ESC = 0xdb;

export const OPS = { writeReg: 0x09, readReg: 0x0a, md5: 0x13, securityInfo: 0x14, eraseFlash: 0xd0, eraseRegion: 0xd1, readFlash: 0xd2 };

function slip(bytes) {
  const out = [END];
  for (const byte of bytes) {
    if (byte === END) out.push(ESC, 0xdc);
    else if (byte === ESC) out.push(ESC, 0xdd);
    else out.push(byte);
  }
  out.push(END);
  return Uint8Array.from(out);
}

function u32(bytes, at) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function le32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function fakeEspChip({ flashSize = 0x20000, flashFill = 0xa5, registers = {}, securityInfo, failErase = false, corruptReads = false, omitDigest = false, ignoreErase = false } = {}) {
  const flash = new Uint8Array(flashSize).fill(flashFill);
  for (let index = 0; index < flash.length; index += 251) flash[index] = index & 0xff;
  const regs = new Map(Object.entries(registers).map(([address, value]) => [Number(address), value >>> 0]));
  const commands = [];
  const outgoing = [];
  let waiting;
  let frame = [];
  let escaping = false;

  const deliver = (bytes) => {
    if (waiting) {
      const waiter = waiting;
      waiting = undefined;
      waiter.resolve(bytes);
    } else outgoing.push(bytes);
  };
  const respond = (op, { value = 0, data = [], status = [0, 0] } = {}) => {
    const payload = [...data, ...status];
    deliver(slip([0x01, op, payload.length & 0xff, payload.length >> 8, ...le32(value), ...payload]));
  };

  const handle = (packet) => {
    const op = packet[1];
    const data = packet.subarray(8);
    commands.push({ op, data: Uint8Array.from(data) });
    switch (op) {
      case OPS.readReg:
        respond(op, { value: regs.get(u32(data, 0)) ?? 0 });
        break;
      case OPS.writeReg:
        respond(op);
        break;
      case OPS.eraseFlash:
        if (failErase) respond(op, { status: [1, 0x07] });
        else {
          if (!ignoreErase) flash.fill(0xff);
          respond(op);
        }
        break;
      case OPS.eraseRegion: {
        const offset = u32(data, 0);
        const size = u32(data, 4);
        if (failErase || offset + size > flash.length) respond(op, { status: [1, 0x07] });
        else {
          if (!ignoreErase) flash.fill(0xff, offset, offset + size);
          respond(op);
        }
        break;
      }
      case OPS.readFlash: {
        const offset = u32(data, 0);
        const size = u32(data, 4);
        const block = u32(data, 8);
        respond(op);
        const slice = flash.slice(offset, offset + size);
        for (let at = 0; at < size; at += block) {
          const piece = slice.subarray(at, Math.min(size, at + block));
          const sent = corruptReads && at === 0 ? Uint8Array.from(piece, (byte, i) => (i === 0 ? byte ^ 0xff : byte)) : piece;
          deliver(slip(sent));
        }
        // The stub ends a read with the MD5 of what it sent; esptool.py checks it.
        if (!omitDigest) deliver(slip(createHash("md5").update(slice).digest()));
        break;
      }
      case OPS.md5: {
        const offset = u32(data, 0);
        const size = u32(data, 4);
        respond(op, { data: [...createHash("md5").update(flash.subarray(offset, offset + size)).digest()] });
        break;
      }
      case OPS.securityInfo:
        if (securityInfo) respond(op, { data: [...securityInfo] });
        else respond(op, { status: [1, 0x05] });
        break;
      default:
        respond(op, { status: [1, 0x05] });
    }
  };

  const accept = (bytes) => {
    for (const byte of bytes) {
      if (byte === END) {
        if (frame.length > 0) {
          const complete = Uint8Array.from(frame);
          frame = [];
          if (complete[0] === 0x00 && complete.length >= 8) handle(complete);
          // Anything else is the host acknowledging flash-read frames.
        }
        escaping = false;
      } else if (escaping) {
        frame.push(byte === 0xdc ? END : byte === 0xdd ? ESC : byte);
        escaping = false;
      } else if (byte === ESC) escaping = true;
      else frame.push(byte);
    }
  };

  const hardware = {
    kind: "serial",
    commands,
    async read(_length, timeoutMs, signal) {
      signal.throwIfAborted();
      if (outgoing.length) return outgoing.shift();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined;
          resolve(null);
        }, Math.min(timeoutMs, 50));
        const abort = () => {
          clearTimeout(timer);
          waiting = undefined;
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        waiting = {
          resolve: (value) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
        };
      });
    },
    async write(bytes, signal) {
      signal.throwIfAborted();
      accept(bytes);
    },
    async setBaudRate() {},
    async setSignals() {},
  };

  return { hardware, flash, regs, commands, md5: (offset, size) => createHash("md5").update(flash.subarray(offset, offset + size)).digest("hex") };
}

/** Packs `get_security_info`'s reply payload (flags, counter, seven purposes, optional chip id and API version). */
export function securityInfoPayload({ flags = 0, flashCryptCnt = 0, keyPurposes = [0, 0, 0, 0, 0, 0, 0], chipId, apiVersion } = {}) {
  return Uint8Array.from([...le32(flags), flashCryptCnt, ...keyPurposes, ...(chipId === undefined ? [] : [...le32(chipId), ...le32(apiVersion ?? 0)])]);
}
