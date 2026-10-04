import { EdlError, edlTimeouts, type EdlLink } from "./edl-link";

/**
 * Sahara: the boot ROM's side of Qualcomm emergency download (USB 05c6:9008).
 * Little-endian packets, each `command, total length, payload`. The ROM speaks
 * first (HELLO); the host answers with the mode it wants:
 *
 *   image transfer  -> the ROM asks for the programmer in pieces (READ_DATA),
 *                      authenticates it, and a DONE exchange starts it
 *   command mode    -> a few read-only questions (serial number, hardware id,
 *                      public-key hash), then a mode switch back
 *
 * This module only ever sends: HELLO_RSP, SWITCH_MODE, EXECUTE_REQ/DATA for the
 * three read-only identity commands, the bytes of the loader the user chose,
 * DONE_REQ, RESET_REQ and RESET_STATE_MACHINE. Memory-debug and every other
 * execute command (modes that dump or switch the chip) are not offered.
 */

export const SAHARA = {
  HELLO_REQ: 0x01,
  HELLO_RSP: 0x02,
  READ_DATA: 0x03,
  END_TRANSFER: 0x04,
  DONE_REQ: 0x05,
  DONE_RSP: 0x06,
  RESET_REQ: 0x07,
  RESET_RSP: 0x08,
  CMD_READY: 0x0b,
  SWITCH_MODE: 0x0c,
  EXECUTE_REQ: 0x0d,
  EXECUTE_RSP: 0x0e,
  EXECUTE_DATA: 0x0f,
  READ_DATA_64: 0x12,
  RESET_STATE_MACHINE: 0x13,
} as const;

export const SAHARA_MODE = { IMAGE_TX_PENDING: 0, IMAGE_TX_COMPLETE: 1, MEMORY_DEBUG: 2, COMMAND: 3 } as const;
export const SAHARA_EXECUTE = { SERIAL_NUMBER: 0x01, MSM_HW_ID: 0x02, OEM_PK_HASH: 0x03 } as const;

/** The highest Sahara version this host speaks. A device that needs a newer host is refused, not guessed at. */
export const SAHARA_HOST_VERSION = 2;
const SAHARA_HOST_MIN_VERSION = 1;
const HELLO_BYTES = 0x30;
/** No Sahara message but a loader's data is longer than this; a bigger "length" is not Sahara. */
const MAX_PACKET_BYTES = 4096;
const MAX_EXECUTE_BYTES = 256;
// Waits: see `edlTimeouts` in edl-link.ts.
const MAX_LOADER_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_LOADER_REQUESTS = 20_000;
/** A request that runs past the end of the loader is padded with 0xFF, but only this far. */
const MAX_PAD_BYTES = 64 * 1024;
const MAX_HELLO_REPEATS = 3;

const STATUS_NAMES: Readonly<Record<number, string>> = {
  0x01: "invalid command for the current state",
  0x02: "protocol mismatch between host and device",
  0x03: "the device does not accept this target protocol version",
  0x04: "the device does not accept this host protocol version",
  0x05: "invalid packet size",
  0x06: "unexpected image id",
  0x07: "invalid image header size",
  0x08: "invalid image data size",
  0x09: "invalid image type",
  0x0a: "invalid transmission length",
  0x0b: "invalid reception length",
  0x0c: "general transmit/receive error",
  0x0d: "the device could not send its READ_DATA request",
  0x0e: "the image has an unsupported number of program headers",
  0x0f: "invalid program header size",
  0x10: "multiple shared segments in the image",
  0x11: "uninitialized program header location",
  0x12: "invalid destination address",
  0x13: "invalid image header data size",
  0x14: "invalid ELF header",
  0x15: "the device reported an unknown host error",
  0x16: "timeout receiving data",
  0x17: "timeout transmitting data",
  0x18: "the device does not support the mode the host asked for",
  0x19: "invalid memory read",
  0x1a: "the host cannot handle the data size the device asked for",
  0x1b: "memory debug is not supported",
  0x1c: "invalid mode switch",
  0x1d: "the device failed to execute the command",
  0x1e: "invalid parameter for the command",
  0x1f: "the device does not support that command",
  0x20: "invalid client command for a data response",
  0x21: "the hash table failed authentication",
  0x22: "hash verification failed for a segment of the image",
  0x23: "no hash table found in the image",
  0x24: "the device failed to initialize its target",
  0x25: "the image failed authentication",
  0x26: "invalid image hash table size",
  0x27: "enumeration failed",
  0x28: "hardware bulk transfer error",
};

/** Statuses that mean "the boot ROM looked at this loader and did not accept it". */
const LOADER_REJECTED: Readonly<Record<number, true>> = { 0x13: true, 0x14: true, 0x20: true, 0x21: true, 0x22: true, 0x23: true, 0x25: true, 0x26: true };

export class SaharaRejection extends EdlError {
  constructor(readonly status: number, what: string) {
    super(describeSaharaStatus(status, what), "rejected");
    this.name = "SaharaRejection";
  }
}

export function describeSaharaStatus(status: number, what: string): string {
  const name = STATUS_NAMES[status] ?? "unknown status";
  const code = `0x${status.toString(16).padStart(2, "0")}`;
  if (LOADER_REJECTED[status]) {
    return `The device's boot ROM did not accept the loader (${what}; Sahara status ${code}: ${name}). It was not run. A programmer only starts on the device it was signed for.`;
  }
  return `The device refused ${what} (Sahara status ${code}: ${name}).`;
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function u64(bytes: Uint8Array, offset: number): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new EdlError("The device sent a 64-bit value that is far outside any real image or address.");
  return Number(value);
}

function packet(command: number, ...fields: number[]): Uint8Array {
  const out = new Uint8Array(8 + 4 * fields.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, command, true);
  view.setUint32(4, out.byteLength, true);
  fields.forEach((field, index) => view.setUint32(8 + 4 * index, field >>> 0, true));
  return out;
}

export interface SaharaHello {
  /** Sahara version the device speaks. */
  readonly version: number;
  /** The oldest host version it accepts. */
  readonly minVersion: number;
  /** Longest command packet the device sends. */
  readonly maxPacketBytes: number;
  /** The mode the device is in (0: waiting for an image). */
  readonly mode: number;
}

export type SaharaPacket =
  | { readonly kind: "hello"; readonly hello: SaharaHello }
  | { readonly kind: "read-data"; readonly imageId: number; readonly offset: number; readonly length: number }
  | { readonly kind: "end-transfer"; readonly imageId: number; readonly status: number }
  | { readonly kind: "done-response"; readonly status: number }
  | { readonly kind: "command-ready" }
  | { readonly kind: "reset-response" }
  | { readonly kind: "execute-response"; readonly command: number; readonly length: number }
  | { readonly kind: "other"; readonly command: number };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads one Sahara message. Anything that is not framed like one is an error, not a guess. */
export async function readSaharaPacket(link: EdlLink, timeoutMs: number, label: string): Promise<SaharaPacket> {
  const head = await link.read(8, timeoutMs, label);
  const command = u32(head, 0);
  const length = u32(head, 4);
  if (length < 8 || length > MAX_PACKET_BYTES || command === 0 || command > SAHARA.RESET_STATE_MACHINE) {
    throw new EdlError(`${label}: the device sent something that is not a Sahara packet (starts ${hex(head)}).`);
  }
  const body = length > 8 ? await link.read(length - 8, timeoutMs, label) : new Uint8Array(0);
  const need = (count: number): void => {
    if (body.byteLength < count) throw new EdlError(`${label}: a Sahara packet of type 0x${command.toString(16)} was ${length} bytes, ${8 + count} are needed.`);
  };
  switch (command) {
    case SAHARA.HELLO_REQ:
      need(HELLO_BYTES - 8);
      return { kind: "hello", hello: { version: u32(body, 0), minVersion: u32(body, 4), maxPacketBytes: u32(body, 8), mode: u32(body, 12) } };
    case SAHARA.READ_DATA:
      need(12);
      return { kind: "read-data", imageId: u32(body, 0), offset: u32(body, 4), length: u32(body, 8) };
    case SAHARA.READ_DATA_64:
      need(24);
      return { kind: "read-data", imageId: u64(body, 0), offset: u64(body, 8), length: u64(body, 16) };
    case SAHARA.END_TRANSFER:
      need(8);
      return { kind: "end-transfer", imageId: u32(body, 0), status: u32(body, 4) };
    case SAHARA.DONE_RSP:
      need(4);
      return { kind: "done-response", status: u32(body, 0) };
    case SAHARA.CMD_READY:
      return { kind: "command-ready" };
    case SAHARA.RESET_RSP:
      return { kind: "reset-response" };
    case SAHARA.EXECUTE_RSP:
      need(8);
      return { kind: "execute-response", command: u32(body, 0), length: u32(body, 4) };
    default:
      return { kind: "other", command };
  }
}

/** True when the buffered bytes start like a Sahara HELLO request (so a probe knows whom it is talking to). */
export function looksLikeSaharaHello(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && u32(bytes, 0) === SAHARA.HELLO_REQ && u32(bytes, 4) === HELLO_BYTES;
}

/** Validates a HELLO the device sent and says whether this host can talk to it. */
export function checkHello(hello: SaharaHello): void {
  if (hello.mode === SAHARA_MODE.MEMORY_DEBUG) {
    throw new EdlError("The device is in Sahara memory-debug (crash dump) mode. Cody does not read crash dumps; power-cycle the device into EDL.", "refused");
  }
  if (hello.minVersion > SAHARA_HOST_VERSION) {
    throw new EdlError(`The device needs Sahara protocol version ${hello.minVersion} or newer; Cody speaks versions ${SAHARA_HOST_MIN_VERSION}-${SAHARA_HOST_VERSION}. Newer devices request their images by id from a multi-file configuration, which is not implemented.`, "refused");
  }
  if (hello.version < 1) throw new EdlError(`The device reported Sahara version ${hello.version}, which does not exist.`);
}

async function sendHelloResponse(link: EdlLink, hello: SaharaHello, mode: number): Promise<void> {
  // Fields: version, oldest compatible version, status (success), mode, six reserved words.
  await link.write(packet(SAHARA.HELLO_RSP, Math.min(hello.version, SAHARA_HOST_VERSION), SAHARA_HOST_MIN_VERSION, 0, mode, 0, 0, 0, 0, 0, 0));
}

/** Waits for the HELLO the device sends when a session (re)starts. */
export async function awaitHello(link: EdlLink, timeoutMs: number, label: string): Promise<SaharaHello> {
  const next = await readSaharaPacket(link, timeoutMs, label);
  if (next.kind === "hello") {
    checkHello(next.hello);
    return next.hello;
  }
  if (next.kind === "end-transfer" && next.status !== 0) throw new SaharaRejection(next.status, label);
  throw new EdlError(`${label}: expected the device's Sahara HELLO, got ${next.kind}.`);
}

/** Starts Sahara over: the device answers with a fresh HELLO. Supported by newer boot ROMs only. */
export async function resetSaharaStateMachine(link: EdlLink): Promise<void> {
  await link.write(packet(SAHARA.RESET_STATE_MACHINE));
}

/** Asks the device to switch to image-transfer mode again; it answers with a fresh HELLO. */
export async function switchToImageTransfer(link: EdlLink): Promise<void> {
  await link.write(packet(SAHARA.SWITCH_MODE, SAHARA_MODE.IMAGE_TX_PENDING));
}

export interface SaharaIdentity {
  readonly saharaVersion: number;
  readonly minHostVersion: number;
  /** Chip serial number, 8 hex digits. */
  readonly serial: string;
  /** The 64-bit hardware id as 16 hex digits, and the three fields Qualcomm packs into it. */
  readonly hardwareId: string | null;
  readonly msmId: string | null;
  readonly oemId: string | null;
  readonly modelId: string | null;
  /** The OEM root public key hash exactly as the ROM returned it (usually 32 or 48 bytes). */
  readonly pkHash: string | null;
  readonly pkHashBytes: number | null;
  /** What could not be read, and anything odd about it. */
  readonly warnings: readonly string[];
  /** True when the device sent a fresh HELLO after the switch back, i.e. it is waiting for a loader again. */
  readonly backInLoaderState: boolean;
}

async function executeCommand(link: EdlLink, command: number, label: string): Promise<Uint8Array | { rejected: number }> {
  await link.write(packet(SAHARA.EXECUTE_REQ, command));
  const response = await readSaharaPacket(link, edlTimeouts.packet, label);
  if (response.kind === "end-transfer") return { rejected: response.status };
  if (response.kind !== "execute-response" || response.command !== command) throw new EdlError(`${label}: unexpected ${response.kind} in answer to the command.`);
  if (response.length === 0 || response.length > MAX_EXECUTE_BYTES) throw new EdlError(`${label}: the device announced ${response.length} bytes, which is not a plausible answer.`);
  await link.write(packet(SAHARA.EXECUTE_DATA, command));
  return link.read(response.length, edlTimeouts.packet, `${label} data`);
}

/**
 * Command mode: read the chip serial number, hardware id and public-key hash,
 * then ask the device to go back to waiting for a loader. Nothing here changes
 * the device.
 */
export async function saharaIdentify(link: EdlLink, hello: SaharaHello): Promise<SaharaIdentity> {
  await sendHelloResponse(link, hello, SAHARA_MODE.COMMAND);
  const ready = await readSaharaPacket(link, edlTimeouts.packet, "Sahara command mode");
  if (ready.kind === "end-transfer" && ready.status !== 0) throw new SaharaRejection(ready.status, "command mode");
  if (ready.kind !== "command-ready") throw new EdlError(`Sahara command mode: expected CMD_READY, got ${ready.kind}.`);

  const warnings: string[] = [];
  const serialReply = await executeCommand(link, SAHARA_EXECUTE.SERIAL_NUMBER, "Sahara serial number");
  if ("rejected" in serialReply) throw new SaharaRejection(serialReply.rejected, "the serial number request");
  if (serialReply.byteLength !== 4) throw new EdlError(`Sahara serial number: ${serialReply.byteLength} bytes came back, 4 were expected.`);
  const serial = u32(serialReply, 0).toString(16).padStart(8, "0");

  let hardwareId: string | null = null;
  let msmId: string | null = null;
  let oemId: string | null = null;
  let modelId: string | null = null;
  let pkHash: string | null = null;
  let pkHashBytes: number | null = null;
  let stopped = false;

  const hardware = await executeCommand(link, SAHARA_EXECUTE.MSM_HW_ID, "Sahara hardware id");
  if ("rejected" in hardware) {
    warnings.push(`The device would not give its hardware id (${describeSaharaStatus(hardware.rejected, "that request")}).`);
    stopped = true;
  } else if (hardware.byteLength === 8) {
    // Little-endian 64-bit id: [63:56] reserved, [55:32] MSM id, [31:16] OEM id, [15:0] model id.
    const low = u32(hardware, 0);
    const high = u32(hardware, 4);
    hardwareId = high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
    msmId = (high & 0xffffff).toString(16).padStart(6, "0");
    oemId = (low >>> 16).toString(16).padStart(4, "0");
    modelId = (low & 0xffff).toString(16).padStart(4, "0");
  } else {
    warnings.push(`The hardware id came back as ${hardware.byteLength} bytes instead of 8, so it is not interpreted.`);
  }

  if (!stopped) {
    const key = await executeCommand(link, SAHARA_EXECUTE.OEM_PK_HASH, "Sahara public-key hash");
    if ("rejected" in key) {
      warnings.push(`The device would not give its public-key hash (${describeSaharaStatus(key.rejected, "that request")}).`);
      stopped = true;
    } else {
      pkHash = hex(key);
      pkHashBytes = key.byteLength;
    }
  }

  let backInLoaderState = false;
  if (!stopped) {
    await switchToImageTransfer(link);
    try {
      const again = await awaitHello(link, edlTimeouts.packet, "Sahara return to loader mode");
      backInLoaderState = again.mode === SAHARA_MODE.IMAGE_TX_PENDING || again.mode === SAHARA_MODE.COMMAND;
    } catch (error) {
      // A silent or confused device is a finding to report; a failed USB transfer or a cancel is not ours to swallow.
      if (!(error instanceof EdlError)) throw error;
      warnings.push(`The device did not say HELLO again after the switch back (${error.message}). It may need to be put into EDL again before a loader is sent.`);
    }
  } else {
    warnings.push("The device was left in command mode; put it into EDL again before sending a loader.");
  }
  return { saharaVersion: hello.version, minHostVersion: hello.minVersion, serial, hardwareId, msmId, oemId, modelId, pkHash, pkHashBytes, warnings, backInLoaderState };
}

export interface SaharaUploadResult {
  readonly requests: number;
  readonly bytesSent: number;
  readonly paddedBytes: number;
  readonly imageId: number | null;
  /** The status the device put in its DONE answer (1: image transfer complete). */
  readonly doneStatus: number;
  /** Times the device restarted the handshake during the upload. */
  readonly rehandshakes: number;
}

export interface SaharaUploadHooks {
  progress(sent: number, total: number): void;
  note(line: string): void;
}

/**
 * Image-transfer mode: serve the loader to the boot ROM as it asks for pieces,
 * wait for its verdict, and finish with DONE. The ROM authenticates the loader;
 * a loader it does not accept ends in a rejection that is passed on verbatim.
 */
export async function saharaUpload(link: EdlLink, hello: SaharaHello, loader: Blob, hooks: SaharaUploadHooks): Promise<SaharaUploadResult> {
  if (loader.size <= 0) throw new EdlError("The loader file is empty.", "refused");
  await sendHelloResponse(link, hello, SAHARA_MODE.IMAGE_TX_PENDING);
  let requests = 0;
  let bytesSent = 0;
  let paddedBytes = 0;
  let imageId: number | null = null;
  let rehandshakes = 0;
  const budget = Math.max(64 * 1024 * 1024, loader.size * 4);
  for (;;) {
    const next = await readSaharaPacket(link, requests === 0 ? edlTimeouts.packet : edlTimeouts.authentication, "Sahara image transfer");
    if (next.kind === "read-data") {
      requests += 1;
      imageId ??= next.imageId;
      if (requests > MAX_LOADER_REQUESTS) throw new EdlError("The device kept asking for loader data without ever finishing.");
      if (next.length <= 0 || next.length > MAX_LOADER_REQUEST_BYTES) throw new EdlError(`The device asked for ${next.length} bytes of the loader in one piece, which is not a plausible request.`);
      if (next.offset > loader.size) throw new EdlError(`The device asked for loader data at offset ${next.offset}, but the file is only ${loader.size} bytes long. Choose the complete loader file.`, "rejected");
      const available = Math.min(next.length, loader.size - next.offset);
      const pad = next.length - available;
      if (pad > MAX_PAD_BYTES) throw new EdlError(`The device asked for ${pad} bytes beyond the end of the loader file. Choose the complete loader file.`, "rejected");
      const piece = new Uint8Array(next.length).fill(0xff);
      piece.set(new Uint8Array(await loader.slice(next.offset, next.offset + available).arrayBuffer()));
      if (bytesSent + piece.byteLength > budget) throw new EdlError("The device asked for far more loader data than the file holds.");
      await link.write(piece);
      bytesSent += piece.byteLength;
      paddedBytes += pad;
      if (pad > 0) hooks.note(`The device asked for ${pad} byte(s) past the end of the loader; they were padded with 0xFF.`);
      hooks.progress(Math.min(bytesSent, loader.size), loader.size);
      continue;
    }
    if (next.kind === "hello") {
      rehandshakes += 1;
      if (rehandshakes > MAX_HELLO_REPEATS) throw new EdlError("The device restarted the Sahara handshake over and over.");
      checkHello(next.hello);
      await sendHelloResponse(link, next.hello, SAHARA_MODE.IMAGE_TX_PENDING);
      continue;
    }
    if (next.kind === "end-transfer") {
      if (next.status !== 0) throw new SaharaRejection(next.status, "the loader");
      await link.write(packet(SAHARA.DONE_REQ));
      const done = await readSaharaPacket(link, edlTimeouts.packet, "Sahara DONE");
      if (done.kind === "end-transfer" && done.status !== 0) throw new SaharaRejection(done.status, "finishing the transfer");
      if (done.kind !== "done-response") throw new EdlError(`Sahara DONE: expected the device's DONE answer, got ${done.kind}.`);
      return { requests, bytesSent, paddedBytes, imageId, doneStatus: done.status, rehandshakes };
    }
    throw new EdlError(`Sahara image transfer: the device sent an unexpected ${next.kind} packet.`);
  }
}

/** Sahara RESET: the device restarts, leaving EDL. It may be gone before it answers. */
export async function saharaReset(link: EdlLink): Promise<boolean> {
  await link.write(packet(SAHARA.RESET_REQ));
  try {
    const answer = await readSaharaPacket(link, 3_000, "Sahara reset");
    return answer.kind === "reset-response";
  } catch (error) {
    if (error instanceof EdlError && error.kind === "timeout") return false;
    throw error;
  }
}
