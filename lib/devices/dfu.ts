import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import { assessFlashWritePolicy, bindIntrinsicFlashSafety, classifyProtectedRegionName, PROTECTED_REGION_OVERRIDES, runVerifiedFlash, sha256Blob, type ProtectedRegionKind } from "./hardware-safety";
import { throwIfAborted } from "./serial";

const MAX_STATUS_POLLS = 1_024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
/** A DFU device that never ends an UPLOAD is not given more than this for a backup or readback. */
const MAX_IMAGE_BACKUP_BYTES = 64 * 1024 * 1024;
const DFU_CAN_DOWNLOAD = 0x01;
const DFU_CAN_UPLOAD = 0x02;
const DFU_MANIFESTATION_TOLERANT = 0x04;

const DfuRequest = {
  DNLOAD: 1,
  UPLOAD: 2,
  GETSTATUS: 3,
  CLRSTATUS: 4,
  GETSTATE: 5,
  ABORT: 6,
} as const;

const DfuState = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,
} as const;

type DfuStateName = keyof typeof DfuState;
type DfuStatusCode =
  | "OK"
  | "errTARGET"
  | "errFILE"
  | "errWRITE"
  | "errERASE"
  | "errCHECK_ERASED"
  | "errPROG"
  | "errVERIFY"
  | "errADDRESS"
  | "errNOTDONE"
  | "errFIRMWARE"
  | "errVENDOR"
  | "errUSBR"
  | "errPOR"
  | "errUNKNOWN"
  | "errSTALLEDPKT";

const statusNames: readonly DfuStatusCode[] = [
  "OK",
  "errTARGET",
  "errFILE",
  "errWRITE",
  "errERASE",
  "errCHECK_ERASED",
  "errPROG",
  "errVERIFY",
  "errADDRESS",
  "errNOTDONE",
  "errFIRMWARE",
  "errVENDOR",
  "errUSBR",
  "errPOR",
  "errUNKNOWN",
  "errSTALLEDPKT",
];

export class DfuProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DfuProtocolError";
  }
}

export interface DfuFunctionalDescriptor {
  readonly attributes: number;
  readonly transferSize: number;
  readonly version: number;
}

export interface DfuStatus {
  readonly status: DfuStatusCode;
  readonly pollTimeoutMs: number;
  readonly state: DfuStateName;
  readonly statusStringIndex: number;
}

interface DfuMetadata {
  readonly descriptor: DfuFunctionalDescriptor;
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly alternateName?: string;
}

interface DfuSeMap { start: number; end: number; sectors: { offset: number; length: number }[] }

// ST AN3156 / DfuSe UM0412: only the selected Internal Flash descriptor is authority.
function dfuseMap(metadata: DfuMetadata): DfuSeMap {
  if (metadata.descriptor.version !== 0x011a) throw new DfuProtocolError("Generic DFU flash is unsupported; STM32 DfuSe 1.1a is required.");
  const fields = metadata.alternateName?.split("/");
  if (!fields || fields[0].trim() !== "@Internal Flash" || fields.length < 3 || fields.length % 2 !== 1) throw new DfuProtocolError("DfuSe requires a complete @Internal Flash memory descriptor.");
  const sectors: DfuSeMap["sectors"] = [];
  let start = 0, end = 0;
  for (let index = 1; index < fields.length; index += 2) {
    if (!/^\s*0x[0-9a-f]{1,8}\s*$/i.test(fields[index])) throw new DfuProtocolError("Invalid DfuSe flash address.");
    let address = Number(fields[index].trim());
    if (index === 1) start = address;
    else if (address !== end) throw new DfuProtocolError("DfuSe flash map must be contiguous and nonoverlapping.");
    if (address < 0x08000000 || address >= 0x10000000) throw new DfuProtocolError("DfuSe map is outside STM32 program flash; system memory and option bytes are excluded.");
    for (const run of fields[index + 1].split(",")) {
      const match = /^\s*(\d+)\s*\*\s*(\d+)\s*([BKM ])\s*g\s*$/.exec(run);
      if (!match) throw new DfuProtocolError("Every DfuSe flash sector must be readable, erasable and writable (g).");
      const count = Number(match[1]), length = Number(match[2]) * ({ B: 1, " ": 1, K: 1024, M: 1048576 }[match[3]]!);
      const next = address + count * length;
      if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(next) || next > 0x10000000 || next - start > MAX_ARTIFACT_BYTES || sectors.length + count > 65536) throw new DfuProtocolError("DfuSe sector map exceeds supported bounds.");
      for (let sector = 0; sector < count; sector += 1) { sectors.push({ offset: address, length }); address += length; }
    }
    end = address;
  }
  if (!sectors.length) throw new DfuProtocolError("DfuSe flash map is empty.");
  return { start, end, sectors };
}

function checkedDfuSeRange(map: DfuSeMap, offset: number | undefined, length: number): number {
  if (offset === undefined || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0 || length > MAX_ARTIFACT_BYTES || offset < map.start || offset + length > map.end) throw new DfuProtocolError("DfuSe requires an explicit absolute address and a bounded range inside the selected flash map.");
  return offset + length;
}

function binaryBlob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes.buffer]);
}

/** Parses the standard nine-byte DFU functional descriptor (USB descriptor type
 * 0x21). A DfuSe memory-map string is deliberately not treated as an address
 * map: generic DFU block numbers are not DfuSe addresses. */
export function parseDfuFunctionalDescriptor(bytes: Uint8Array): DfuFunctionalDescriptor {
  if (bytes.length < 9 || bytes[0] !== 9 || bytes[1] !== 0x21) {
    throw new DfuProtocolError("A nine-byte USB DFU functional descriptor is required.");
  }
  const transferSize = bytes[5]! | (bytes[6]! << 8);
  if (transferSize === 0) throw new DfuProtocolError("DFU functional descriptor reports a zero transfer size.");
  return {
    attributes: bytes[2]!,
    transferSize,
    version: bytes[7]! | (bytes[8]! << 8),
  };
}

/** Parses the exact six-byte DFU_GETSTATUS reply. */
export function parseDfuStatus(bytes: Uint8Array): DfuStatus {
  if (bytes.length !== 6) throw new DfuProtocolError(`DFU_GETSTATUS must return 6 bytes, received ${bytes.length}.`);
  const status = statusNames[bytes[0]!];
  if (!status) throw new DfuProtocolError(`DFU returned unknown status code ${bytes[0]}.`);
  const stateNumber = bytes[4]!;
  const state = (Object.keys(DfuState) as DfuStateName[]).find((name) => DfuState[name] === stateNumber);
  if (!state) throw new DfuProtocolError(`DFU returned unknown state ${stateNumber}.`);
  return {
    status,
    pollTimeoutMs: bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16),
    state,
    statusStringIndex: bytes[5]!,
  };
}
async function metadata(context: HardwareContext): Promise<DfuMetadata> {
  const { transport } = context;
  if (transport.kind !== "usb" || !transport.controlIn || transport.interfaceNumber === undefined || transport.alternateSetting === undefined || !transport.dfu) {
    throw new DfuProtocolError("DFU requires a descriptor-selected USB interface and alternate setting on the leased transport.");
  }
  const { dfu } = transport;
  if (dfu.interfaceNumber !== transport.interfaceNumber || dfu.alternateSetting !== transport.alternateSetting) {
    throw new DfuProtocolError("DFU leased interface and alternate setting disagree with the descriptor-selected target.");
  }
  const bytes = await transport.controlIn(
    { requestType: "standard", recipient: "interface", request: 6, value: 0x2100, index: dfu.interfaceNumber },
    9,
    context.signal,
  );
  const descriptor = parseDfuFunctionalDescriptor(bytes);
  if (descriptor.version !== 0x0110 && descriptor.version !== 0x011a) {
    throw new DfuProtocolError("Only standard DFU 1.1 and STM32 DfuSe 1.1a are supported.");
  }
  return { descriptor, interfaceNumber: dfu.interfaceNumber, alternateSetting: dfu.alternateSetting, alternateName: dfu.alternateName };
}

function target(metadata: DfuMetadata): string {
  return metadata.alternateName ?? `dfu-interface-${metadata.interfaceNumber}-alternate-${metadata.alternateSetting}`;
}

function requireUsb(context: HardwareContext): void {
  if (context.transport.kind !== "usb" || !context.transport.controlIn || !context.transport.controlOut) {
    throw new DfuProtocolError("DFU 1.1 requires a USB transport with control IN and OUT transfers.");
  }
}

function statusFailure(status: DfuStatus): never {
  throw new DfuProtocolError(`DFU status ${status.status} in state ${status.state}${status.statusStringIndex ? ` (device string ${status.statusStringIndex})` : ""}.`);
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted.", "AbortError"));
    };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

class DfuSession {
  constructor(
    private readonly context: HardwareContext,
    private readonly metadata: DfuMetadata,
  ) {}

  private get transport(): Required<Pick<HardwareTransport, "controlIn" | "controlOut">> {
    const { controlIn, controlOut } = this.context.transport;
    if (!controlIn || !controlOut) throw new DfuProtocolError("DFU control transfers are unavailable.");
    return { controlIn, controlOut };
  }

  private setup(request: number, value = 0): USBControlTransferParameters {
    return { requestType: "class", recipient: "interface", request, value, index: this.metadata.interfaceNumber };
  }

  async status(): Promise<DfuStatus> {
    const bytes = await this.transport.controlIn(this.setup(DfuRequest.GETSTATUS), 6, this.context.signal);
    return parseDfuStatus(bytes);
  }

  async state(): Promise<DfuStateName> {
    const bytes = await this.transport.controlIn(this.setup(DfuRequest.GETSTATE), 1, this.context.signal);
    if (bytes.length !== 1) throw new DfuProtocolError(`DFU_GETSTATE must return 1 byte, received ${bytes.length}.`);
    const state = (Object.keys(DfuState) as DfuStateName[]).find((name) => DfuState[name] === bytes[0]!);
    if (!state) throw new DfuProtocolError(`DFU returned unknown state ${bytes[0]}.`);
    return state;
  }

  async requireIdle(): Promise<void> {
    const status = await this.status();
    if (status.status !== "OK") statusFailure(status);
    if (status.state !== "dfuIDLE") throw new DfuProtocolError(`DFU must be in dfuIDLE; device is in ${status.state}.`);
  }

  async abort(): Promise<void> {
    await this.transport.controlOut(this.setup(DfuRequest.ABORT), new Uint8Array(0), this.context.signal);
    const status = await this.status();
    if (status.status !== "OK") statusFailure(status);
    if (status.state !== "dfuIDLE") throw new DfuProtocolError(`DFU_ABORT did not return the device to dfuIDLE (now ${status.state}).`);
  }

  async clearStatus(): Promise<void> {
    await this.transport.controlOut(this.setup(DfuRequest.CLRSTATUS), new Uint8Array(0), this.context.signal);
    const status = await this.status();
    if (status.status !== "OK") statusFailure(status);
    if (status.state !== "dfuIDLE") throw new DfuProtocolError(`DFU_CLRSTATUS did not return the device to dfuIDLE (now ${status.state}).`);
  }

  private async waitDownloadIdle(): Promise<void> {
    for (let polls = 0; polls < MAX_STATUS_POLLS; polls += 1) {
      const status = await this.status();
      if (status.status !== "OK") statusFailure(status);
      if (status.state === "dfuDNLOAD_IDLE") return;
      if (status.state !== "dfuDNLOAD_SYNC" && status.state !== "dfuDNBUSY") {
        throw new DfuProtocolError(`DFU download entered unexpected state ${status.state}.`);
      }
      await delay(status.pollTimeoutMs, this.context.signal);
    }
    throw new DfuProtocolError("DFU download did not reach dfuDNLOAD_IDLE within the status-poll limit.");
  }

  async addressCommand(command: 0x21 | 0x41, address: number): Promise<void> {
    const payload = new Uint8Array(5);
    payload[0] = command;
    new DataView(payload.buffer).setUint32(1, address, true);
    await this.transport.controlOut(this.setup(DfuRequest.DNLOAD, 0), payload, this.context.signal);
    await this.waitDownloadIdle();
  }

  async readMemory(address: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    await this.requireIdle();
    const bytes = new Uint8Array(length);
    const size = this.metadata.descriptor.transferSize;
    let completed = 0;
    while (completed < length) {
      await this.addressCommand(0x21, address + completed);
      await this.abort();
      for (let block = 2; block <= 0xffff && completed < length; block += 1) {
        const wanted = Math.min(size, length - completed);
        const received = await this.transport.controlIn(this.setup(DfuRequest.UPLOAD, block), wanted, this.context.signal);
        if (received.length !== wanted) throw new DfuProtocolError("DfuSe readback ended before the complete requested range.");
        bytes.set(received, completed); completed += wanted;
        this.context.progress({ phase: "readback", completed, total: length });
      }
      await this.abort();
    }
    return bytes;
  }

  async writeMemory(address: number, image: Blob): Promise<void> {
    await this.requireIdle();
    const bytes = new Uint8Array(await image.arrayBuffer());
    const size = this.metadata.descriptor.transferSize;
    let completed = 0;
    while (completed < bytes.length) {
      await this.addressCommand(0x21, address + completed);
      for (let block = 2; block <= 0xffff && completed < bytes.length; block += 1) {
        const chunk = bytes.subarray(completed, Math.min(completed + size, bytes.length));
        await this.transport.controlOut(this.setup(DfuRequest.DNLOAD, block), chunk, this.context.signal);
        await this.waitDownloadIdle(); completed += chunk.length;
        this.context.progress({ phase: "write", completed, total: bytes.length });
      }
      await this.abort();
    }
    // Deliberately do not manifest/reset: verification must read the stored image first.
  }

  async upload(length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(length) || length <= 0) throw new DfuProtocolError("DFU upload length must be a positive safe integer.");
    if (length > MAX_ARTIFACT_BYTES) {
      throw new DfuProtocolError(`DFU upload of ${length} bytes exceeds the ${MAX_ARTIFACT_BYTES}-byte browser artifact limit; streaming storage is required.`);
    }
    const blocks = Math.ceil(length / this.metadata.descriptor.transferSize);
    if (blocks > 0xffff) throw new DfuProtocolError("DFU upload exceeds the 16-bit transfer-block range.");
    await this.requireIdle();
    const data = new Uint8Array(length);
    let written = 0;
    for (let block = 0; block < blocks; block += 1) {
      const wanted = Math.min(this.metadata.descriptor.transferSize, length - written);
      const received = await this.transport.controlIn(this.setup(DfuRequest.UPLOAD, block), wanted, this.context.signal);
      if (received.length !== wanted) {
        throw new DfuProtocolError(`DFU upload ended after ${written + received.length} bytes; ${length} were required for this operation.`);
      }
      data.set(received, written);
      written += received.length;
      this.context.progress({ phase: "upload", completed: written, total: length });
    }
    await this.abort();
    return data;
  }

  /**
   * DFU_UPLOAD from block 0 until the device ends the transfer with a short
   * packet, or until `enough` bytes are read (then the upload is aborted).
   */
  async uploadImage(options: { limit: number; enough?: number }): Promise<Uint8Array<ArrayBuffer>> {
    await this.requireIdle();
    const size = this.metadata.descriptor.transferSize;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let block = 0; block <= 0xffff; block += 1) {
      const received = await this.transport.controlIn(this.setup(DfuRequest.UPLOAD, block), size, this.context.signal);
      if (received.length > size) throw new DfuProtocolError("DFU_UPLOAD returned more than the transfer size.");
      total += received.length;
      parts.push(Uint8Array.from(received));
      this.context.progress({ phase: "readback", completed: total, message: `Read ${total} bytes from the device.` });
      if (received.length < size || (options.enough !== undefined && total >= options.enough)) {
        await this.abort();
        const image = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
          image.set(part, at);
          at += part.length;
        }
        return image;
      }
      if (total > options.limit) throw new DfuProtocolError(`The device kept uploading past ${options.limit} bytes without ending the transfer.`);
    }
    throw new DfuProtocolError("The upload exceeded the 16-bit block range.");
  }

  /** DFU_DNLOAD of every block (numbered from 0, each polled to dfuDNLOAD-IDLE), then the zero-length block that starts manifestation. */
  async downloadImage(image: Blob): Promise<void> {
    await this.requireIdle();
    const size = this.metadata.descriptor.transferSize;
    let block = 0;
    for (let offset = 0; offset < image.size; offset += size, block += 1) {
      const chunk = new Uint8Array(await image.slice(offset, offset + size).arrayBuffer());
      await this.transport.controlOut(this.setup(DfuRequest.DNLOAD, block), chunk, this.context.signal);
      await this.waitDownloadIdle();
      this.context.progress({ phase: "write", completed: Math.min(offset + size, image.size), total: image.size });
    }
    await this.transport.controlOut(this.setup(DfuRequest.DNLOAD, block), new Uint8Array(0), this.context.signal);
  }

  /**
   * After the zero-length block: read the status once (a device that rejects
   * the image says so here). A manifestation-tolerant device then returns to
   * dfuIDLE; an intolerant one restarts itself, so nothing more is read.
   */
  async manifest(tolerant: boolean): Promise<"idle" | "restarting"> {
    let status = await this.status();
    if (status.status !== "OK") statusFailure(status);
    if (!tolerant) return "restarting";
    for (let polls = 0; status.state !== "dfuIDLE" && polls < MAX_STATUS_POLLS; polls += 1) {
      if (status.state !== "dfuMANIFEST_SYNC" && status.state !== "dfuMANIFEST") throw new DfuProtocolError(`DFU manifestation entered unexpected state ${status.state}.`);
      await delay(Math.max(status.pollTimeoutMs, 10), this.context.signal);
      status = await this.status();
      if (status.status !== "OK") statusFailure(status);
    }
    if (status.state !== "dfuIDLE") throw new DfuProtocolError("DFU manifestation did not finish within the status-poll limit.");
    return "idle";
  }

  /** DfuSe leave: the zero-length download that makes the device exit DFU (dfu-util sends it as block 2). */
  async leave(): Promise<void> {
    await this.transport.controlOut(this.setup(DfuRequest.DNLOAD, 2), new Uint8Array(0), this.context.signal);
    try {
      await this.status();
    } catch {
      throwIfAborted(this.context.signal);
    }
  }

  /** Returns a device left in dfuERROR or mid-transfer by a refused upload to dfuIDLE. */
  async recover(): Promise<void> {
    const status = await this.status();
    if (status.state === "dfuERROR") await this.clearStatus();
    else if (status.state !== "dfuIDLE") await this.abort();
    await this.requireIdle();
  }
}

function requireCapability(metadata: DfuMetadata, capability: number, name: string): void {
  if ((metadata.descriptor.attributes & capability) === 0) throw new DfuProtocolError(`DFU descriptor does not advertise ${name}.`);
}

async function detect(metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  const session = new DfuSession(context, metadata);
  await context.confirm({ action: "dfu detect", target: target(metadata), backup: "not applicable: diagnostic DFU control transfers only" });
  const state = await session.state();
  const status = await session.status();
  return {
    summary: `DFU 1.1 interface ${metadata.interfaceNumber}, alternate ${metadata.alternateSetting} detected in ${state}.`,
    details: { descriptor: metadata.descriptor, state, status, alternateSetting: metadata.alternateSetting },
  };
}

async function dump(request: HardwareRequest, metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  requireCapability(metadata, 0x02, "DFU_UPLOAD");
  const length = request.length;
  if (!length || !Number.isSafeInteger(length) || length <= 0 || length > MAX_ARTIFACT_BYTES) throw new DfuProtocolError("DFU dump requires an explicit bounded positive length.");
  const isDfuSe = metadata.descriptor.version === 0x011a;
  if (isDfuSe) checkedDfuSeRange(dfuseMap(metadata), request.offset, length);
  else if ((request.offset ?? 0) !== 0) throw new DfuProtocolError("Generic DFU offset must be zero.");
  const namedTarget = target(metadata);
  if (request.target && request.target !== namedTarget && !(isDfuSe && request.target === "internal-flash")) throw new DfuProtocolError("DFU dump target must match the selected alternate.");
  await context.confirm({ action: "dfu dump", target: namedTarget, offset: request.offset ?? 0, length, backup: "not applicable: read-only DFU_UPLOAD" });
  const session = new DfuSession(context, metadata);
  const data = isDfuSe ? await session.readMemory(request.offset!, length) : await session.upload(length);
  const file = binaryBlob(data);
  const fileId = await context.save(isDfuSe ? "dfuse-" + request.offset!.toString(16) + ".bin" : namedTarget + ".bin", file);
  return { summary: "Read " + data.length + " bytes from " + namedTarget + ".", verified: true, sha256: await sha256Blob(file), fileId, details: { alternateSetting: metadata.alternateSetting } };
}

/** Whether a file ends with the 16-byte suffix of a .dfu container (signature "UFD", length 16). */
async function hasDfuSuffix(image: Blob): Promise<boolean> {
  if (image.size < 16) return false;
  const suffix = new Uint8Array(await image.slice(image.size - 16).arrayBuffer());
  return suffix[8] === 0x55 && suffix[9] === 0x46 && suffix[10] === 0x44 && suffix[11] === 16;
}

interface ImageBackup {
  readonly id?: string;
  readonly note: string;
}

/** Escrows the device's current image when it can upload one; a device that will not is not a reason to refuse the write. */
async function backupCurrentImage(metadata: DfuMetadata, context: HardwareContext, session: DfuSession): Promise<ImageBackup> {
  if ((metadata.descriptor.attributes & DFU_CAN_UPLOAD) === 0) return { note: "Backup unavailable: this DFU interface cannot upload (bitCanUpload is 0), so the write is UNVERIFIED." };
  let image: Uint8Array<ArrayBuffer>;
  try {
    image = await session.uploadImage({ limit: MAX_IMAGE_BACKUP_BYTES });
  } catch (error) {
    throwIfAborted(context.signal);
    await session.recover();
    return { note: `Backup unavailable: the device would not upload its image (${error instanceof Error ? error.message : String(error)}), so the write is UNVERIFIED.` };
  }
  if (image.length === 0) {
    await session.recover();
    return { note: "Backup unavailable: the device answered an upload with no data, so the write is UNVERIFIED." };
  }
  const file = binaryBlob(image);
  // Storage failure is not an upload failure: do not let a write continue when
  // Cody has already read a backup but could not preserve it.
  const id = await context.save(`${target(metadata)}.preflash.bin`, file);
  return { id, note: `Saved the device's current image (${image.length} bytes) as ${id} (sha256 ${await sha256Blob(file)}).` };
}

/**
 * Plain DFU 1.1 download (`dfu-util -D`). There are no addresses: the device
 * replaces the selected alternate's whole image when manifestation finishes, so
 * the role of that image is unknown and the write needs the typed `allow-unknown`
 * override (or the name-derived one). The current image is escrowed when the
 * device can upload it, and the new one is read back only when the device
 * returns to DFU idle after manifesting; otherwise the write is reported
 * UNVERIFIED, never as proven.
 */
async function flashDfu11(request: HardwareRequest, metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  requireCapability(metadata, DFU_CAN_DOWNLOAD, "DFU_DNLOAD");
  const input = context.input;
  if (!input || !input.size) throw new DfuProtocolError("DFU flash requires a non-empty raw binary artifact.");
  const alternate = target(metadata);
  if ((request.offset ?? 0) !== 0) throw new DfuProtocolError("Generic DFU has no addresses: a download replaces the selected alternate's whole image, so the offset must be 0.");
  if (request.target !== alternate) throw new DfuProtocolError(`Generic DFU flash needs the exact selected alternate as its target: ${alternate}.`);
  if (request.length !== undefined && request.length !== input.size) throw new DfuProtocolError("DFU length must match the raw binary artifact.");
  if (input.size > MAX_ARTIFACT_BYTES) throw new DfuProtocolError(`DFU images over ${MAX_ARTIFACT_BYTES} bytes are not supported.`);
  const transferSize = metadata.descriptor.transferSize;
  if (Math.ceil(input.size / transferSize) > 0xffff) throw new DfuProtocolError(`A ${input.size}-byte image needs more blocks than a DFU download can number (65535) at this device's ${transferSize}-byte transfer size.`);
  if (await hasDfuSuffix(input)) throw new DfuProtocolError("This file ends with a DFU suffix (a .dfu container). Cody downloads raw binaries: remove the final 16 bytes and select the raw image.");
  const digest = await sha256Blob(input);
  const kind: ProtectedRegionKind = classifyProtectedRegionName(alternate) ?? "unknown";
  const safety = bindIntrinsicFlashSafety({ ...request, offset: 0 }, request.options, {
    protocol: "dfu", chip: "USB DFU 1.1", region: alternate, offset: 0, eraseOffset: 0, eraseLength: input.size,
    layout: {
      protocol: "dfu", chip: "USB DFU 1.1", storage: "logical",
      regions: [{ name: alternate, offset: 0, length: input.size, protection: kind }],
      protections: Object.fromEntries(Object.keys(PROTECTED_REGION_OVERRIDES).map((name) => [name, name === kind ? "present" : "absent"])) as Record<ProtectedRegionKind, "present" | "absent">,
    },
  });
  assessFlashWritePolicy(safety, input.size);
  const tolerant = (metadata.descriptor.attributes & DFU_MANIFESTATION_TOLERANT) !== 0;
  const canUpload = (metadata.descriptor.attributes & DFU_CAN_UPLOAD) !== 0;
  const session = new DfuSession(context, metadata);
  await session.requireIdle();
  const backup = await backupCurrentImage(metadata, context, session);
  await context.confirm({
    action: "dfu download",
    target: alternate,
    offset: 0,
    length: input.size,
    sha256: digest,
    protectedOverride: safety.protectedOverride,
    backup: backup.note,
    details: [
      `Generic DFU 1.1 replaces the whole firmware image of ${alternate}; there are no addresses. What that image is on this device is unknown.`,
      tolerant ? "The device finishes manifestation and returns to DFU idle, so Cody reads the image back when the device can upload it." : "The device restarts itself to finish the download, so Cody cannot read it back and the write stays UNVERIFIED.",
      "Cody does not reset the device afterwards; use dfu reset when you want it to run the new firmware.",
    ].join(" "),
  });
  await session.downloadImage(input);
  let manifestation: "idle" | "restarting" | "disconnected";
  try {
    manifestation = await session.manifest(tolerant);
  } catch (error) {
    throwIfAborted(context.signal);
    if (error instanceof DfuProtocolError) throw error;
    manifestation = "disconnected";
  }
  let readback: Uint8Array<ArrayBuffer> | undefined;
  let verification: string;
  if (manifestation !== "idle") {
    verification = manifestation === "restarting" ? "Not verified: this device restarts itself to finish the download, so it cannot be read back." : "Not verified: the device left the bus as it began manifesting.";
  } else if (!canUpload) {
    verification = "Not verified: this DFU interface cannot upload.";
  } else {
    try {
      readback = await session.uploadImage({ limit: MAX_IMAGE_BACKUP_BYTES, enough: input.size });
      verification = readback.length < input.size ? `Not verified: the device returned only ${readback.length} of the ${input.size} bytes written.` : "Readback matched the written image.";
    } catch (error) {
      throwIfAborted(context.signal);
      readback = undefined;
      verification = `Not verified: the device would not upload after manifesting (${error instanceof Error ? error.message : String(error)}).`;
    }
  }
  const verified = readback !== undefined && readback.length >= input.size;
  if (verified && (await sha256Blob(binaryBlob(readback!.slice(0, input.size)))) !== digest) {
    throw new DfuProtocolError(`DFU readback SHA-256 does not match the written image. ${backup.id ? `The previous image is saved as ${backup.id}.` : "No backup was possible."} Nothing was retried.`);
  }
  return {
    summary: verified ? "DFU image written and read back; the device stays in DFU mode." : `DFU image sent. UNVERIFIED: ${verification}`,
    verified,
    sha256: digest,
    details: { alternate, bytes: input.size, backupId: backup.id, manifestation, verification, manifestationTolerant: tolerant },
  };
}

async function flash(request: HardwareRequest, metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  return metadata.descriptor.version === 0x011a ? flashDfuSe(request, metadata, context) : flashDfu11(request, metadata, context);
}

async function flashDfuSe(request: HardwareRequest, metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  const map = dfuseMap(metadata);
  requireCapability(metadata, 0x01, "DFU_DNLOAD");
  requireCapability(metadata, 0x02, "DFU_UPLOAD");
  if (!context.input || !context.input.size) throw new DfuProtocolError("DfuSe flash requires a non-empty raw binary artifact.");
  const offset = request.offset;
  const end = checkedDfuSeRange(map, offset, context.input.size);
  if (request.target !== "internal-flash" && request.target !== metadata.alternateName) throw new DfuProtocolError("DfuSe target must be internal-flash or the exact selected alternate name.");
  if (request.length !== undefined && request.length !== context.input.size) throw new DfuProtocolError("DfuSe length must match the raw binary artifact.");
  const sectors = map.sectors.filter((sector) => sector.offset < end && sector.offset + sector.length > offset!);
  const first = sectors[0]!, last = sectors[sectors.length - 1]!;
  const eraseLength = last.offset + last.length - first.offset;
  const chip = "STM32 DfuSe", region = request.target!;
  const safety = bindIntrinsicFlashSafety(request, request.options, {
    protocol: "dfu", chip, region, offset: offset!, eraseOffset: first.offset, eraseLength,
    layout: { protocol: "dfu", chip, storage: "nor",
      regions: [{ name: region, offset: map.start, length: map.end - map.start, protection: "bootloader" }],
      protections: { preloader: "absent", lk: "absent", tee: "absent", fuses: "absent", bootloader: "present", "spi-boot": "absent", unknown: "absent" },
    },
  });
  const session = new DfuSession(context, metadata);
  const original = await session.readMemory(first.offset, eraseLength);
  const backup = binaryBlob(original), backupHash = await sha256Blob(backup);
  const backupId = await context.save("dfuse-" + first.offset.toString(16) + ".preflash.bin", backup);
  const merged = original.slice();
  merged.set(new Uint8Array(await context.input.arrayBuffer()), offset! - first.offset);
  const result = await runVerifiedFlash({ request, context, safety,
    backup: "Saved full erase footprint as " + backupId + " (sha256 " + backupHash + "). Internal flash may contain a bootloader.",
    programImage: binaryBlob(merged),
    write: async (image) => {
      await session.requireIdle();
      for (const sector of sectors) {
        await session.addressCommand(0x41, sector.offset);
        context.progress({ phase: "erase", completed: sector.offset + sector.length - first.offset, total: eraseLength });
      }
      await session.abort();
      await session.writeMemory(first.offset, image);
    },
    readback: async () => binaryBlob(await session.readMemory(first.offset, eraseLength)),
  });
  return { ...result, summary: "DfuSe internal flash written and readback verified; device remains in DFU mode.", details: { backupId, interfaceNumber: metadata.interfaceNumber, alternateSetting: metadata.alternateSetting, eraseOffset: first.offset, eraseLength } };
}
async function leaveDfuSe(metadata: DfuMetadata, context: HardwareContext, address: number): Promise<HardwareResult> {
  if (metadata.descriptor.version !== 0x011a) throw new DfuProtocolError("leave ADDRESS is a DfuSe command. Plain DFU 1.1 has no address to jump to; use reset.");
  const map = dfuseMap(metadata);
  if (!Number.isSafeInteger(address) || address < map.start || address >= map.end) throw new DfuProtocolError(`The leave address must lie inside the selected flash map 0x${map.start.toString(16)}..0x${map.end.toString(16)}.`);
  await context.confirm({
    action: "dfu leave",
    target: target(metadata),
    offset: address,
    backup: "not applicable: nothing is written, but the device leaves DFU mode and starts the application at this address",
    details: `Set the address pointer to 0x${address.toString(16)} and send the zero-length download that makes the device leave DFU. It re-enumerates; Cody's connection to it ends and the result cannot be checked from here.`,
  });
  const session = new DfuSession(context, metadata);
  await session.requireIdle();
  await session.addressCommand(0x21, address);
  await session.abort();
  await session.leave();
  return { summary: `DFU leave requested at 0x${address.toString(16)}; the device should start its application and re-enumerate.`, verified: false, details: { address } };
}

async function resetDevice(metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  const reset = context.transport.reset;
  if (!reset) throw new DfuProtocolError("This browser transport cannot issue a USB reset.");
  await context.confirm({
    action: "dfu reset",
    target: target(metadata),
    backup: "not applicable: nothing is written",
    details: "Issue a USB reset (dfu-util -R). A DFU bootloader normally restarts and runs the application; the device re-enumerates and Cody's connection to it ends.",
  });
  throwIfAborted(context.signal);
  let note = "The USB reset completed.";
  try {
    await reset.call(context.transport, context.signal);
  } catch (error) {
    throwIfAborted(context.signal);
    note = `The device left the bus during the reset (${error instanceof Error ? error.message : String(error)}), which is the usual result.`;
  }
  return { summary: "USB reset requested; the device re-enumerates and may need a fresh grant.", verified: false, details: { note } };
}

async function execute(request: HardwareRequest, metadata: DfuMetadata, context: HardwareContext): Promise<HardwareResult> {
  const command = request.command?.trim() ?? "";
  const leave = /^leave\s+(0x[0-9a-f]+|\d+)$/i.exec(command);
  if (command === "reset") return resetDevice(metadata, context);
  if (leave) return leaveDfuSe(metadata, context, Number(leave[1]));
  if (command !== "abort" && command !== "clear_status") {
    throw new DfuProtocolError("DFU exec permits abort, clear_status, reset, and (DfuSe) leave ADDRESS; it does not expose DfuSe address commands.");
  }
  const namedTarget = target(metadata);
  await context.confirm({ action: `dfu ${command}`, target: namedTarget, backup: "not applicable: DFU state transition only" });
  const session = new DfuSession(context, metadata);
  if (command === "abort") await session.abort();
  else await session.clearStatus();
  return { summary: `DFU ${command} completed.`, verified: true, details: { state: await session.state() } };
}
async function runDfu(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  requireUsb(context);
  const selected = await metadata(context);
  switch (request.action) {
    case "detect": return detect(selected, context);
    case "dump": return dump(request, selected, context);
    case "flash": return flash(request, selected, context);
    case "exec": return execute(request, selected, context);
    default: throw new DfuProtocolError(`DFU does not support ${request.action}.`);
  }
}

export const dfuFlasher: Flasher = {
  protocol: "dfu",
  actions: ["detect", "dump", "flash", "exec"],
  run: runDfu,
};
