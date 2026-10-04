import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import { bindIntrinsicFlashSafety, parseFlashSafety, runVerifiedFlash, sha256Blob, type FlashLayout, type FlashSafetyContext, type ProtectedRegionOverride } from "./hardware-safety";
import { describeEfuseBlock, formatEfuseBlock, readEfuseBlocks, readEfuseKeyPurposes, readEspSecurity, type EspSecurityState } from "./esp-efuse";
import { requireLength, requireOffset, requireSerial, stringOption, throwIfAborted } from "./serial";

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;
const ROM_BAUD_RATE = 115200;
const DEFAULT_STUB_BAUD_RATE = 921600;
const READ_CHUNK_BYTES = 4096;
const READ_POLL_TIMEOUT_MS = 1000;
const ESP_RESET_MODES: Record<string, true> = {
  default_reset: true,
  usb_reset: true,
  no_reset: true,
  no_reset_no_sync: true,
};

/** Explicitly reviewed NOR erase geometry per detected esptool-js target. */
const ESP_SPI_ERASE_BLOCK_BYTES: Readonly<Record<string, number>> = {
  ESP8266: 0x1000,
  ESP32: 0x1000,
  "ESP32-C2": 0x1000,
  "ESP32-C3": 0x1000,
  "ESP32-C5": 0x1000,
  "ESP32-C6": 0x1000,
  "ESP32-C61": 0x1000,
  "ESP32-H2": 0x1000,
  "ESP32-P4": 0x1000,
  "ESP32-S2": 0x1000,
  "ESP32-S3": 0x1000,
};
const ESP_APPLICATION_OFFSET = 0x10000;
/** esptool's ESP_ERASE_REGION and ESP_GET_SECURITY_INFO command codes (a chip erase goes through loader.eraseFlash(), which owns ESP_ERASE_FLASH). */
const ESP_ERASE_REGION_COMMAND = 0xd1;
const ESP_GET_SECURITY_INFO_COMMAND = 0x14;
/** esptool's chip-erase timeout (CHIP_ERASE_TIMEOUT) and per-megabyte region-erase timeout. */
const ESP_ERASE_REGION_TIMEOUT_MS_PER_MB = 40_000;
const ESP_MIN_COMMAND_TIMEOUT_MS = 3_000;
/** Flash is escrowed and checked in pieces so a 16 MB chip never needs one 16 MB buffer. */
const ESP_FLASH_PIECE_BYTES = 0x100000;
const ESP_FLASH_SECTOR_BYTES = 0x1000;
/** How long to wait for the digest frame that follows a flash read. */
const ESP_READ_DIGEST_WAIT_MS = 250;
export class EspProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EspProtocolError";
  }
}

export interface EspChip {
  readonly CHIP_NAME?: string;
  readonly BOOTLOADER_FLASH_OFFSET?: number;
  readonly FLASH_WRITE_SIZE?: number;
  /** Read-only identity probes; esptool-js implements each per chip. */
  getChipDescription?(loader: EspLoader): Promise<string>;
  getChipFeatures?(loader: EspLoader): Promise<string[]>;
  getCrystalFreq?(loader: EspLoader): Promise<number>;
  /** ESP32 reports its major revision here; other chips a family revision. */
  getChipRevision?(loader: EspLoader): Promise<number>;
  readMac?(loader: EspLoader): Promise<string>;
}

export interface EspFlashOptions {
  readonly fileArray: readonly { readonly data: Uint8Array; readonly address: number }[];
  readonly flashMode: "keep";
  readonly flashFreq: "keep";
  readonly flashSize: "keep";
  readonly eraseAll: false;
  readonly compress: true;
  readonly reportProgress: (fileIndex: number, written: number, total: number) => void;
  readonly calculateMD5Hash: (image: Uint8Array) => string;
}

export interface EspLoader {
  chip: EspChip;
  IS_STUB: boolean;
  /** esptool-js defaults this to three. Set it to one before every write: an
   * acknowledgement loss leaves a destructive write's state unknown. */
  WRITE_BLOCK_ATTEMPTS: number;
  /** SPI flash ID byte to capacity, as esptool-js recognises it. */
  DETECTED_FLASH_SIZES?: Readonly<Record<number, string>>;
  /** The packet transport; esptool-js leaves the stub's trailing MD5 frame of a flash read unread. */
  transport: { read(timeoutMs: number): Promise<Uint8Array | null> };
  main(mode?: string): Promise<string>;
  readFlash(address: number, length: number, onPacketReceived?: (packet: Uint8Array, progress: number, total: number) => void): Promise<Uint8Array>;
  writeFlash(options: EspFlashOptions): Promise<void>;
  detectFlashSize(): Promise<string>;
  readReg(address: number, timeout?: number): Promise<number>;
  readFlashId(): Promise<number>;
  /** Stub-only chip erase (ESP_ERASE_FLASH). */
  eraseFlash(): Promise<unknown>;
  /** Device-side MD5 of a flash range (ESP_SPI_FLASH_MD5), lowercase hex. */
  flashMd5sum(address: number, size: number): Promise<string>;
  /** One bootloader command; returns the response payload when `responseDataLength` is positive. */
  checkCommand(description: string, command: number, data?: Uint8Array, checksum?: number, responseDataLength?: number, timeoutMs?: number): Promise<number | Uint8Array>;
}

export interface EspLoaderOptions {
  readonly transport: EspTransport;
  readonly baudrate: number;
  readonly terminal: {
    clean(): void;
    write(data: string): void;
    writeLine(data: string): void;
  };
}

export interface EspToolModule {
  readonly ESPLoader: new (options: EspLoaderOptions) => EspLoader;
}

export type EspToolImporter = () => Promise<EspToolModule>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("ESP operation aborted.", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/** esptool-js 0.6.1's `Transport.slipWriter` framing, kept structural so the
 * browser's WebUSB serial polyfill works without pretending it is a native
 * SerialPort. */
export function encodeEspSlip(data: Uint8Array): Uint8Array {
  let escaped = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === SLIP_END || data[index] === SLIP_ESC) escaped += 1;
  }
  const framed = new Uint8Array(data.length + escaped + 2);
  let output = 0;
  framed[output++] = SLIP_END;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    if (value === SLIP_END) {
      framed[output++] = SLIP_ESC;
      framed[output++] = SLIP_ESC_END;
    } else if (value === SLIP_ESC) {
      framed[output++] = SLIP_ESC;
      framed[output++] = SLIP_ESC_ESC;
    } else {
      framed[output++] = value;
    }
  }
  framed[output] = SLIP_END;
  return framed;
}

/**
 * Structural equivalent of esptool-js 0.6.1's public Transport surface.
 *
 * It owns no browser port: HardwareTransport is already an exclusive lease
 * whose read/write calls work for both native Web Serial and WebUSB polyfills.
 * This is deliberately not an `instanceof Transport` adapter; ESPLoader only
 * calls this public structural surface.
 */
export class EspTransport {
  tracing = false;
  private readonly packets: Uint8Array[] = [];
  private frame: number[] = [];
  private escaping = false;
  private currentRead?: { resolve: (packet: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> };
  private loop?: Promise<void>;
  private loopController?: AbortController;
  private readFailure?: Error;
  private baudRate?: number;

  constructor(
    private readonly hardware: HardwareTransport,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", () => {
      void this.stopLoop();
    }, { once: true });
  }

  getInfo(): string {
    return `Cody ${this.hardware.kind} hardware transport`;
  }

  getPid(): number | undefined {
    return undefined;
  }

  hexify(data: Uint8Array): string {
    let text = "";
    for (let index = 0; index < data.length; index += 1) text += data[index]!.toString(16).padStart(2, "0");
    return text;
  }

  hexConvert(data: Uint8Array): string {
    return this.hexify(data);
  }

  trace(message: string): void {
    // The operation progress feed is intentionally aggregate-only; binary
    // transport traces would expose firmware contents and allocate heavily.
    void message;
  }

  slipWriter(data: Uint8Array): Uint8Array {
    return encodeEspSlip(data);
  }

  async write(data: Uint8Array): Promise<void> {
    assertNotAborted(this.signal);
    await this.hardware.write(encodeEspSlip(data), this.signal);
    assertNotAborted(this.signal);
  }

  async connect(baudRate = ROM_BAUD_RATE): Promise<void> {
    assertNotAborted(this.signal);
    if (!Number.isSafeInteger(baudRate) || baudRate < ROM_BAUD_RATE) {
      throw new EspProtocolError(`Invalid ESP serial baud rate ${baudRate}.`);
    }
    if (baudRate === this.baudRate) return;
    if (!this.hardware.setBaudRate) {
      throw new EspProtocolError(`This ${this.hardware.kind} serial transport cannot configure ${baudRate} baud.`);
    }
    await this.hardware.setBaudRate(baudRate);
    this.baudRate = baudRate;
  }

  async disconnect(): Promise<void> {
    await this.stopLoop();
  }

  async setDTR(state: boolean): Promise<void> {
    await this.setSignals({ dtr: state });
  }

  async setRTS(state: boolean): Promise<void> {
    await this.setSignals({ rts: state });
  }

  private async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    assertNotAborted(this.signal);
    if (!this.hardware.setSignals) {
      throw new EspProtocolError(
        "ESP automatic reset requires DTR/RTS signal control. This browser transport does not expose it; put the device in the bootloader and use reset=no_reset.",
      );
    }
    await this.hardware.setSignals(signals);
    assertNotAborted(this.signal);
  }

  /** Starts exactly one lease-owned reader. esptool-js invokes this after each
   * connect/reconnect; a duplicated loop would steal acknowledgements. */
  readLoop(): Promise<void> {
    if (this.loop) return this.loop;
    const controller = new AbortController();
    this.loopController = controller;
    const onAbort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener("abort", onAbort, { once: true });
    this.loop = this.pump(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.readFailure = error instanceof Error ? error : new EspProtocolError(String(error));
          this.resolveRead(null);
        }
      })
      .finally(() => {
        this.signal.removeEventListener("abort", onAbort);
        if (this.loopController === controller) this.loopController = undefined;
        this.loop = undefined;
      });
    return this.loop;
  }

  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const bytes = await this.hardware.read(READ_CHUNK_BYTES, READ_POLL_TIMEOUT_MS, signal);
      if (bytes) this.accept(bytes);
    }
  }

  private accept(bytes: Uint8Array): void {
    for (let index = 0; index < bytes.length; index += 1) {
      const value = bytes[index]!;
      if (value === SLIP_END) {
        if (this.frame.length !== 0) {
          this.enqueue(new Uint8Array(this.frame));
          this.frame = [];
        }
        this.escaping = false;
      } else if (this.escaping) {
        if (value === SLIP_ESC_END) this.frame.push(SLIP_END);
        else if (value === SLIP_ESC_ESC) this.frame.push(SLIP_ESC);
        else throw new EspProtocolError(`Invalid ESP SLIP escape byte 0x${value.toString(16)}.`);
        this.escaping = false;
      } else if (value === SLIP_ESC) {
        this.escaping = true;
      } else {
        this.frame.push(value);
      }
    }
  }

  private enqueue(packet: Uint8Array): void {
    if (this.currentRead) {
      this.resolveRead(packet);
      return;
    }
    this.packets.push(packet);
  }

  private resolveRead(packet: Uint8Array | null): void {
    const waiting = this.currentRead;
    if (!waiting) return;
    this.currentRead = undefined;
    clearTimeout(waiting.timer);
    waiting.resolve(packet);
  }

  flushInput(): void {
    this.packets.length = 0;
    this.frame = [];
    this.escaping = false;
  }

  peek(): Uint8Array {
    if (this.packets.length === 0) return new Uint8Array(0);
    let size = 0;
    for (const packet of this.packets) size += packet.length;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const packet of this.packets) {
      result.set(packet, offset);
      offset += packet.length;
    }
    return result;
  }

  async read(timeout: number): Promise<Uint8Array | null> {
    assertNotAborted(this.signal);
    if (this.readFailure) throw this.readFailure;
    const packet = this.packets.shift();
    if (packet) return packet;
    if (this.currentRead) throw new EspProtocolError("Concurrent ESP transport reads are not supported.");
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const onAbort = () => {
        if (!this.currentRead) return;
        this.currentRead = undefined;
        clearTimeout(timer);
        reject(abortError(this.signal));
      };
      const timer = setTimeout(() => {
        if (this.currentRead) this.currentRead = undefined;
        this.signal.removeEventListener("abort", onAbort);
        resolve(null);
      }, Math.max(0, timeout));
      this.currentRead = {
        resolve: (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        timer,
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async dispose(): Promise<void> {
    await this.stopLoop();
  }

  private async stopLoop(): Promise<void> {
    const controller = this.loopController;
    if (controller && !controller.signal.aborted) controller.abort(this.signal.reason);
    this.resolveRead(null);
    const loop = this.loop;
    if (loop) await loop;
  }
}

function md5LeftRotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

const MD5_SHIFT = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_TABLE = Uint32Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0);

/** Browser Web Crypto intentionally omits MD5. esptool-js needs MD5 to invoke
 * its device-side SPI flash verification, so retain a small local MD5 only for
 * that protocol check; SHA-256 remains the approval/readback integrity hash. */
export function md5Hex(data: Uint8Array): string {
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  const process = (block: Uint8Array, start: number): void => {
    for (let index = 0; index < 16; index += 1) {
      const offset = start + index * 4;
      words[index] = (block[offset]! | (block[offset + 1]! << 8) | (block[offset + 2]! << 16) | (block[offset + 3]! << 24)) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      b = (b + md5LeftRotate((a + f + MD5_TABLE[index]! + words[g]!) >>> 0, MD5_SHIFT[index]!)) >>> 0;
      a = previousD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  };

  const completeBlocks = data.length - (data.length % 64);
  for (let offset = 0; offset < completeBlocks; offset += 64) process(data, offset);

  const tail = new Uint8Array(64);
  const tailLength = data.length - completeBlocks;
  tail.set(data.subarray(completeBlocks));
  tail[tailLength] = 0x80;
  if (tailLength >= 56) {
    process(tail, 0);
    tail.fill(0);
  }
  const bitLength = data.length * 8;
  if (!Number.isSafeInteger(bitLength)) throw new EspProtocolError("Firmware is too large for MD5 verification.");
  let value = bitLength;
  for (let index = 0; index < 8; index += 1) {
    tail[56 + index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  process(tail, 0);

  let result = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let index = 0; index < 4; index += 1) result += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return result;
}


function requireInput(context: HardwareContext): Blob {
  if (!context.input) throw new EspProtocolError("ESP flash requires a firmware artifact.");
  if (context.input.size === 0) throw new EspProtocolError("Refusing to flash an empty ESP firmware artifact.");
  return context.input;
}

function optionResetMode(request: HardwareRequest): string {
  const reset = stringOption(request.options ?? {}, "reset") ?? "default_reset";
  if (!ESP_RESET_MODES[reset]) throw new EspProtocolError(`Unsupported ESP reset mode ${reset}.`);
  return reset;
}

function optionBaudRate(request: HardwareRequest): number {
  const baudRate = request.baudRate ?? DEFAULT_STUB_BAUD_RATE;
  if (!Number.isSafeInteger(baudRate) || baudRate < ROM_BAUD_RATE || baudRate > 2_000_000) {
    throw new EspProtocolError("ESP baudRate must be an integer from 115200 through 2000000.");
  }
  return baudRate;
}

function chipInfo(loader: EspLoader, detectedName: string): { chip: string; bootOffset: number } {
  const chip = loader.chip;
  const name = chip?.CHIP_NAME?.trim() || detectedName.trim();
  if (!name) throw new EspProtocolError("esptool-js did not report a chip name.");
  const bootOffset = chip?.BOOTLOADER_FLASH_OFFSET;
  if (typeof bootOffset !== "number" || !Number.isSafeInteger(bootOffset) || bootOffset < 0) {
    throw new EspProtocolError(`esptool-js did not report a safe SPI boot offset for ${name}.`);
  }
  return { chip: name, bootOffset };
}

function flashCapacityBytes(value: string): number {
  const match = /^(\d+)\s*(KB|MB)$/i.exec(value.trim());
  if (!match) throw new EspProtocolError(`esptool-js reported unrecognized flash capacity ${value}.`);
  const amount = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === "KB" ? 1024 : 1024 * 1024;
  const capacity = amount * multiplier;
  if (!Number.isSafeInteger(capacity) || capacity <= ESP_APPLICATION_OFFSET) {
    throw new EspProtocolError(`esptool-js reported unsafe flash capacity ${value}.`);
  }
  return capacity;
}

function intrinsicEspSafety(
  request: HardwareRequest,
  chip: string,
  bootOffset: number,
  flashCapacity: number,
  payloadLength: number,
): FlashSafetyContext {
  const eraseBlock = ESP_SPI_ERASE_BLOCK_BYTES[chip];
  if (!eraseBlock) throw new EspProtocolError(`No reviewed SPI erase geometry exists for detected ${chip}.`);
  if (!Number.isSafeInteger(payloadLength) || payloadLength <= 0) {
    throw new EspProtocolError("ESP firmware must contain at least one byte.");
  }
  const offset = requireOffset(request.offset, "ESP flash offset");
  const payloadEnd = offset + payloadLength;
  const eraseOffset = Math.floor(offset / eraseBlock) * eraseBlock;
  const eraseEnd = Math.ceil(payloadEnd / eraseBlock) * eraseBlock;
  if (!Number.isSafeInteger(payloadEnd) || !Number.isSafeInteger(eraseEnd) || eraseEnd > flashCapacity) {
    throw new EspProtocolError("ESP payload escapes the detected flash capacity.");
  }
  if (request.target !== "flash" && request.target !== "factory" && request.target !== "firmware" && request.target !== "spi-boot") {
    throw new EspProtocolError(`ESP target ${request.target} is not an intrinsic flash target.`);
  }

  // Zero is a reviewed boot boundary on several chips (ESP8266, and the RISC-V
  // ESP32-C2/C3/C6/H2 and ESP32-S3): they have no separate second-stage
  // boundary, and their offset-zero images still contain boot material. The
  // initial application-sized range is therefore protected from offset zero.
  if (bootOffset < 0 || bootOffset >= ESP_APPLICATION_OFFSET || bootOffset % eraseBlock !== 0) {
    throw new EspProtocolError(`Detected ${chip} SPI boot boundary is not a known erase-aligned profile.`);
  }
  const protectedBootStart = bootOffset;
  const regions: FlashLayout["regions"] = [
    ...(protectedBootStart > 0 ? [{ name: "flash-prefix", offset: 0, length: protectedBootStart }] : []),
    { name: "spi-boot", offset: protectedBootStart, length: ESP_APPLICATION_OFFSET - protectedBootStart, protection: "spi-boot" },
    { name: "firmware", offset: ESP_APPLICATION_OFFSET, length: flashCapacity - ESP_APPLICATION_OFFSET },
  ];
  const layout: FlashLayout = {
    protocol: "esp",
    chip,
    storage: "spi",
    regions,
    protections: {
      preloader: "absent",
      lk: "absent",
      tee: "absent",
      fuses: "absent",
      bootloader: "absent",
      "spi-boot": "present",
      unknown: "absent",
    },
  };
  return bindIntrinsicFlashSafety(request, request.options, {
    protocol: "esp",
    chip,
    region: request.target,
    offset,
    eraseOffset,
    eraseLength: eraseEnd - eraseOffset,
    layout,
  });
}

function blobFromBytes(data: Uint8Array): Blob {
  // BlobPart excludes SharedArrayBuffer-backed views. Make one owned snapshot
  // before persisting bytes received from the browser hardware lease.
  const snapshot = new Uint8Array(data.byteLength);
  snapshot.set(data);
  return new Blob([snapshot.buffer]);
}

function artifactName(chip: string, offset: number, length: number, kind: "backup" | "dump"): string {
  const name = chip.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "esp";
  return `${name}-${kind}-${offset.toString(16).padStart(8, "0")}-${length.toString(16)}.bin`;
}

function progressReader(context: HardwareContext, phase: string): (packet: Uint8Array, completed: number, total: number) => void {
  return (packet, completed, total) => {
      context.progress({ phase, completed, total, message: `${phase} ${completed}/${total} bytes (${packet.length}-byte chunk)` });
    };
}

function terminal(context: HardwareContext): EspLoaderOptions["terminal"] {
  const report = (message: string) => {
    const clean = message.trim();
    if (clean) context.progress({ phase: "esp", message: clean });
  };
  return { clean: () => undefined, write: report, writeLine: report };
}

function isEspToolModule(value: unknown): value is EspToolModule {
  return typeof value === "object" && value !== null && "ESPLoader" in value && typeof value.ESPLoader === "function";
}

async function loadBrowserEspTool(): Promise<EspToolModule> {
  // 0.6.1's package root has extensionless imports that Node cannot load. Its
  // published bundle is self-contained and exposes the same ESPLoader API.
  const bundle: unknown = await import("esptool-js/bundle.js");
  if (!isEspToolModule(bundle)) throw new EspProtocolError("The installed esptool-js bundle does not export ESPLoader.");
  return bundle;
}

interface EspSession {
  readonly loader: EspLoader;
  readonly transport: EspTransport;
  readonly chip: string;
  readonly bootOffset: number;
}

async function openSession(
  request: HardwareRequest,
  context: HardwareContext,
  importEspTool: EspToolImporter,
): Promise<EspSession> {
  requireSerial(context.transport);
  throwIfAborted(context.signal);
  const transport = new EspTransport(context.transport, context.signal);
  try {
    const { ESPLoader } = await importEspTool();
    throwIfAborted(context.signal);
    context.progress({ phase: "connect", message: "Connecting to ESP ROM bootloader." });
    const loader = new ESPLoader({ transport, baudrate: optionBaudRate(request), terminal: terminal(context) });
    const detectedName = await loader.main(optionResetMode(request));
    throwIfAborted(context.signal);
    const { chip, bootOffset } = chipInfo(loader, detectedName);
    context.progress({ phase: "stub", message: `Detected ${chip}; esptool-js stub ${loader.IS_STUB ? "is active" : "is unavailable"}.` });
    return { loader, transport, chip, bootOffset };
  } catch (error) {
    await transport.dispose();
    throw error;
  }
}

async function withSession(
  request: HardwareRequest,
  context: HardwareContext,
  importEspTool: EspToolImporter,
  operation: (session: EspSession) => Promise<HardwareResult>,
): Promise<HardwareResult> {
  const session = await openSession(request, context, importEspTool);
  try {
    return await operation(session);
  } finally {
    await session.transport.dispose();
  }
}

interface EspIdentity {
  readonly chip: string;
  readonly description?: string;
  /** ESP32 reports its major silicon revision; other chips a family revision. */
  readonly revision?: number;
  readonly features?: readonly string[];
  readonly crystalMHz?: number;
  readonly mac?: string;
}

/**
 * The probes esptool prints for `chip_id`. They are the same read-register
 * commands `loader.main()` already ran to connect, so a failure here is a real
 * link fault and is reported rather than hidden.
 */
async function readIdentity({ loader, chip }: EspSession, context: HardwareContext): Promise<EspIdentity> {
  throwIfAborted(context.signal);
  const probes = loader.chip;
  const description = await probes.getChipDescription?.(loader);
  const revision = await probes.getChipRevision?.(loader);
  const features = await probes.getChipFeatures?.(loader);
  const crystalMHz = await probes.getCrystalFreq?.(loader);
  const mac = await probes.readMac?.(loader);
  throwIfAborted(context.signal);
  return { chip, description, revision, features, crystalMHz, mac };
}

/** Secure-boot and flash-encryption state from the eFuse registers esptool reads; never throws on a register fault. */
async function readSecurity({ loader, chip }: EspSession, context: HardwareContext): Promise<EspSecurityState> {
  let majorRevision: number | undefined;
  try {
    majorRevision = await loader.chip.getChipRevision?.(loader);
  } catch {
    throwIfAborted(context.signal);
  }
  const state = await readEspSecurity(chip, (address) => loader.readReg(address), majorRevision);
  throwIfAborted(context.signal);
  return state;
}

function securityWord(value: boolean | undefined): string {
  return value === undefined ? "unknown" : value ? "enabled" : "disabled";
}

async function detect(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  return withSession(request, context, importEspTool, async (session) => {
    const { loader, chip, bootOffset } = session;
    throwIfAborted(context.signal);
    const flashSize = await loader.detectFlashSize();
    const identity = await readIdentity(session, context);
    const security = await readSecurity(session, context);
    return {
      summary: `Detected ${identity.description ?? chip} ESP ROM bootloader${identity.mac ? `, MAC ${identity.mac}` : ""}.`,
      details: {
        chip,
        description: identity.description,
        revision: identity.revision,
        features: identity.features,
        crystalMHz: identity.crystalMHz,
        mac: identity.mac,
        flashSize,
        stub: loader.IS_STUB,
        spiBootOffset: bootOffset,
        capabilities: {
          resetSignals: Boolean(context.transport.setSignals),
          baudEscalation: Boolean(context.transport.setBaudRate),
          compressedWrite: true,
          deviceMd5: true,
          readFlash: true,
          postWriteReadback: true,
          eraseFlash: loader.IS_STUB,
          eFuseRead: true,
        },
        security: {
          eFuseOperations: "read-only",
          secureBoot: securityWord(security.secureBoot),
          secureBootVersion: security.secureBootVersion,
          flashEncryption: securityWord(security.flashEncryption),
          flashCryptCnt: security.flashCryptCnt,
          basis: security.basis,
          note: security.note,
          protectedSpiBootStart: bootOffset,
        },
      },
    };
  });
}

// ============================================================================
// esptool-style commands through device_exec
// ============================================================================

type EspCommand =
  | { readonly kind: "chip_id" | "read_mac" | "flash_id" | "get_security_info" | "efuse_summary" | "efuse_dump" }
  | { readonly kind: "erase_flash" }
  | { readonly kind: "erase_region"; readonly offset: number; readonly length: number };

const ESP_COMMANDS_HELP = "chip_id, read_mac, flash_id, get_security_info, efuse_summary, efuse_dump, erase_flash, erase_region ADDRESS SIZE";

/** esptool's address and size argument grammar: decimal or 0x hex, and sizes may end in k or m. */
function parseEspNumber(token: string | undefined, label: string, sizeSuffix: boolean): number {
  const match = token === undefined ? null : /^(0x[0-9a-f]+|\d+)([km])?$/i.exec(token);
  if (!match || (match[2] && !sizeSuffix)) throw new EspProtocolError(`${label} must be a decimal or 0x hexadecimal number${sizeSuffix ? " (a size may end in k or m)" : ""}; received ${JSON.stringify(token ?? "")}.`);
  const scale = match[2]?.toLowerCase() === "k" ? 1024 : match[2]?.toLowerCase() === "m" ? 1024 * 1024 : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isSafeInteger(value)) throw new EspProtocolError(`${label} is too large.`);
  return value;
}

/**
 * Parses the esptool/espefuse command line a person already knows. Options
 * (`--chip`, `--port`, `--force`) are refused: the connected device comes from
 * the Devices panel and the safety override is typed in the confirmation.
 */
export function parseEspCommand(text: string | undefined): EspCommand {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  let tool: "esptool" | "espefuse" = "esptool";
  if (/^esptool(?:\.py)?$/i.test(words[0] ?? "")) words.shift();
  else if (/^espefuse(?:\.py)?$/i.test(words[0] ?? "")) {
    tool = "espefuse";
    words.shift();
  }
  if (words.some((word) => word.startsWith("-"))) {
    throw new EspProtocolError("ESP command options are not accepted: the device comes from the Devices panel and a protected erase is approved by typing its override in the confirmation.");
  }
  const verb = words.shift()?.toLowerCase().replaceAll("-", "_");
  if (!verb) throw new EspProtocolError(`An ESP command is required: ${ESP_COMMANDS_HELP}.`);
  if (tool === "espefuse") {
    if (/^(?:burn|write_protect|read_protect|set_flash_voltage|execute_scripts)/.test(verb)) {
      throw new EspProtocolError("eFuse programming is irreversible, so Cody does not offer it. It reads eFuses: efuse_summary, efuse_dump.");
    }
    if (verb === "summary" || verb === "dump") {
      if (words.length > 0) throw new EspProtocolError(`espefuse ${verb} takes no arguments here.`);
      return { kind: verb === "summary" ? "efuse_summary" : "efuse_dump" };
    }
    throw new EspProtocolError(`espefuse ${verb} is not offered. Supported: summary, dump.`);
  }
  switch (verb) {
    case "chip_id":
    case "read_mac":
    case "flash_id":
    case "get_security_info":
    case "efuse_summary":
    case "efuse_dump":
    case "erase_flash":
      if (words.length > 0) throw new EspProtocolError(`${verb} takes no arguments.`);
      return { kind: verb };
    case "erase_region": {
      if (words.length !== 2) throw new EspProtocolError("erase_region needs exactly an ADDRESS and a SIZE, for example: erase_region 0x10000 0x20000.");
      const offset = parseEspNumber(words[0], "erase_region address", false);
      const length = parseEspNumber(words[1], "erase_region size", true);
      if (length <= 0) throw new EspProtocolError("erase_region size must be greater than zero.");
      if (offset % ESP_FLASH_SECTOR_BYTES !== 0) throw new EspProtocolError(`Offset to erase from must be a multiple of ${ESP_FLASH_SECTOR_BYTES}.`);
      if (length % ESP_FLASH_SECTOR_BYTES !== 0) throw new EspProtocolError(`Size of data to erase must be a multiple of ${ESP_FLASH_SECTOR_BYTES}.`);
      return { kind: "erase_region", offset, length };
    }
    case "read_flash":
    case "write_flash":
    case "verify_flash":
      throw new EspProtocolError(`${verb} is device_dump / device_flash, not an exec command.`);
    default:
      throw new EspProtocolError(`Unsupported ESP command ${JSON.stringify(verb)}. Supported: ${ESP_COMMANDS_HELP}.`);
  }
}

const SECURITY_INFO_FLAGS = [
  "SECURE_BOOT_EN",
  "SECURE_BOOT_AGGRESSIVE_REVOKE",
  "SECURE_DOWNLOAD_ENABLE",
  "SECURE_BOOT_KEY_REVOKE0",
  "SECURE_BOOT_KEY_REVOKE1",
  "SECURE_BOOT_KEY_REVOKE2",
  "SOFT_DIS_JTAG",
  "HARD_DIS_JTAG",
  "DIS_USB",
  "DIS_DOWNLOAD_DCACHE",
  "DIS_DOWNLOAD_ICACHE",
] as const;

export interface EspSecurityInfo {
  readonly flags: number;
  readonly parsedFlags: Readonly<Record<(typeof SECURITY_INFO_FLAGS)[number], boolean>>;
  readonly flashCryptCnt: number;
  readonly keyPurposes: readonly number[];
  /** Absent on ESP32-S2, whose reply is the short form. */
  readonly chipId?: number;
  readonly apiVersion?: number;
}

/** ESP_GET_SECURITY_INFO's payload: 32-bit flags, flash-encryption counter, seven key purposes, then (all but ESP32-S2) chip id and ROM API version. */
export function parseEspSecurityInfo(bytes: Uint8Array): EspSecurityInfo {
  if (bytes.length !== 12 && bytes.length !== 20) throw new EspProtocolError(`ESP security info must be 12 or 20 bytes; received ${bytes.length}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(0, true);
  const parsedFlags = Object.fromEntries(SECURITY_INFO_FLAGS.map((name, bit) => [name, (flags & (1 << bit)) !== 0])) as EspSecurityInfo["parsedFlags"];
  return {
    flags,
    parsedFlags,
    flashCryptCnt: bytes[4]!,
    keyPurposes: [...bytes.subarray(5, 12)],
    ...(bytes.length === 20 ? { chipId: view.getUint32(12, true), apiVersion: view.getUint32(16, true) } : {}),
  };
}

async function requestSecurityInfo(loader: EspLoader, context: HardwareContext): Promise<EspSecurityInfo> {
  for (const length of [20, 12]) {
    try {
      const reply = await loader.checkCommand("get security info", ESP_GET_SECURITY_INFO_COMMAND, new Uint8Array(0), 0, length);
      if (reply instanceof Uint8Array) return parseEspSecurityInfo(reply);
    } catch (error) {
      throwIfAborted(context.signal);
      if (error instanceof EspProtocolError) throw error;
    }
  }
  throw new EspProtocolError("This chip's loader does not answer get_security_info (ESP32 and ESP8266 have no such ROM command); efuse_summary reads the same facts from the eFuses.");
}

function reportLines(context: HardwareContext, lines: readonly string[]): void {
  for (const line of lines) context.output?.(line);
}

async function chipIdCommand(session: EspSession, context: HardwareContext): Promise<HardwareResult> {
  const identity = await readIdentity(session, context);
  reportLines(context, [
    `Chip: ${identity.description ?? identity.chip}${identity.revision === undefined ? "" : ` (revision ${identity.revision})`}`,
    ...(identity.features ? [`Features: ${identity.features.join(", ")}`] : []),
    ...(identity.crystalMHz === undefined ? [] : [`Crystal: ${identity.crystalMHz} MHz`]),
    ...(identity.mac ? [`MAC: ${identity.mac}`] : []),
  ]);
  return { summary: `${identity.description ?? identity.chip}${identity.mac ? `, MAC ${identity.mac}` : ""}.`, details: { ...identity } };
}

async function readMacCommand(session: EspSession, context: HardwareContext): Promise<HardwareResult> {
  throwIfAborted(context.signal);
  const mac = await session.loader.chip.readMac?.(session.loader);
  if (!mac) throw new EspProtocolError(`esptool-js cannot read the MAC address of ${session.chip}.`);
  context.output?.(`MAC: ${mac}`);
  return { summary: `MAC ${mac}.`, details: { chip: session.chip, mac } };
}

async function flashIdCommand({ loader, chip }: EspSession, context: HardwareContext): Promise<HardwareResult> {
  throwIfAborted(context.signal);
  const id = (await loader.readFlashId()) >>> 0;
  const sizeByte = (id >>> 16) & 0xff;
  const manufacturer = (id & 0xff).toString(16).padStart(2, "0");
  const device = `${((id >>> 8) & 0xff).toString(16).padStart(2, "0")}${sizeByte.toString(16).padStart(2, "0")}`;
  const flashSize = loader.DETECTED_FLASH_SIZES?.[sizeByte];
  reportLines(context, [`Manufacturer: ${manufacturer}`, `Device: ${device}`, `Detected flash size: ${flashSize ?? "unknown"}`]);
  return { summary: `Flash manufacturer ${manufacturer}, device ${device}, ${flashSize ?? "size not recognised"}.`, details: { chip, manufacturer, device, flashSize } };
}

async function securityInfoCommand({ loader }: EspSession, context: HardwareContext): Promise<HardwareResult> {
  const info = await requestSecurityInfo(loader, context);
  const set = SECURITY_INFO_FLAGS.filter((name) => info.parsedFlags[name]);
  reportLines(context, [
    `Flags: 0x${info.flags.toString(16).padStart(8, "0")} (${set.length > 0 ? set.join(", ") : "none set"})`,
    `Flash encryption counter: ${info.flashCryptCnt}`,
    `Key purposes: ${info.keyPurposes.join(", ")}`,
    ...(info.chipId === undefined ? [] : [`Chip ID: ${info.chipId}`, `ROM API version: ${info.apiVersion}`]),
  ]);
  return { summary: set.length > 0 ? `Security flags set: ${set.join(", ")}.` : "No ROM security flags are set.", details: { ...info } };
}

async function efuseSummaryCommand(session: EspSession, context: HardwareContext): Promise<HardwareResult> {
  const { loader, chip } = session;
  const identity = await readIdentity(session, context);
  const security = await readSecurity(session, context);
  const keyPurposes = await readEfuseKeyPurposes(chip, (address) => loader.readReg(address)).catch((error: unknown) => {
    throwIfAborted(context.signal);
    context.output?.(`Key purposes could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  throwIfAborted(context.signal);
  reportLines(context, [
    `Chip: ${identity.description ?? chip}${identity.mac ? `, MAC ${identity.mac}` : ""}`,
    `Secure boot: ${securityWord(security.secureBoot)}${security.secureBootVersion ? ` (${security.secureBootVersion})` : ""}`,
    `Flash encryption: ${securityWord(security.flashEncryption)}${security.flashCryptCnt === undefined ? "" : ` (counter ${security.flashCryptCnt})`}`,
    ...(security.note ? [security.note] : []),
    ...(keyPurposes ? keyPurposes.map((entry) => `${entry.block} key purpose: ${entry.name} (${entry.purpose})`) : []),
  ]);
  return {
    summary: `Secure boot ${securityWord(security.secureBoot)}, flash encryption ${securityWord(security.flashEncryption)} on ${chip}.`,
    details: { chip, mac: identity.mac, revision: identity.revision, security, keyPurposes },
  };
}

async function efuseDumpCommand(session: EspSession, context: HardwareContext): Promise<HardwareResult> {
  const { loader, chip } = session;
  await context.confirm({
    action: "esp efuse_dump",
    target: `${chip} eFuse read registers`,
    backup: "not applicable: read-only register reads",
    details: "Reads every eFuse block, including key blocks that are not read-protected. Key contents are saved only in this session's Files & backups; they are not written to the operation log. User-data blocks are shown in the log and may hold secrets you stored there.",
  });
  const blocks = await readEfuseBlocks(chip, (address) => loader.readReg(address), (completed, total) => context.progress({ phase: "efuse", completed, total, message: `Read ${completed}/${total} eFuse words.` }));
  if (!blocks) throw new EspProtocolError(`Cody has no reviewed eFuse block map for ${chip}, so it cannot dump its eFuses.`);
  throwIfAborted(context.signal);
  reportLines(context, blocks.map(describeEfuseBlock));
  const text = [
    `# Raw eFuse read registers of ${chip} (Cody esp efuse_dump).`,
    "# Words are the read registers as the chip exposes them; a read-protected block reads as zero.",
    ...blocks.map(formatEfuseBlock),
    "",
  ].join("\n");
  const file = new Blob([text], { type: "text/plain" });
  const name = `${chip.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-efuse-dump.txt`;
  const fileId = await context.save(name, file);
  return {
    summary: `Read ${blocks.length} eFuse blocks of ${chip}; the full dump is in ${name}.`,
    fileId,
    sha256: await sha256Blob(file),
    details: { chip, blocks: blocks.map(({ block, words }) => ({ name: block.name, role: block.role, address: block.address, words: words.length, secret: block.secret })) },
  };
}

// ---------------------------------------------------------------------------
// Flash erase
// ---------------------------------------------------------------------------

function describeSecurity(security: EspSecurityState): string {
  const secureBoot = `Secure boot: ${securityWord(security.secureBoot)}${security.secureBootVersion ? ` (${security.secureBootVersion})` : ""}`;
  const encryption = `Flash encryption: ${securityWord(security.flashEncryption)}${security.flashCryptCnt === undefined ? "" : ` (counter ${security.flashCryptCnt})`}`;
  return `${secureBoot}. ${encryption}.${security.note ? ` ${security.note}` : ""}`;
}

/**
 * The flash capacity, but only when the chip's SPI flash ID maps to a size
 * esptool-js recognises. esptool-js silently assumes 4 MB for an ID it does not
 * know; a chip erase removes every byte of the real flash, so Cody must not
 * back up "4 MB" and then erase 16.
 */
async function recognisedFlashCapacity(loader: EspLoader): Promise<{ capacity: number; label: string }> {
  const id = (await loader.readFlashId()) >>> 0;
  const label = loader.DETECTED_FLASH_SIZES?.[(id >>> 16) & 0xff];
  if (!label) {
    throw new EspProtocolError(`The SPI flash ID 0x${id.toString(16)} does not map to a flash size Cody recognises. Cody will not erase a chip it cannot size, because it could not back up everything the erase removes.`);
  }
  return { capacity: flashCapacityBytes(label), label };
}

/**
 * The stub ends every flash read with the MD5 of the bytes it sent. esptool.py
 * checks it; esptool-js leaves the frame unread. Checking it here proves the
 * backup arrived intact before anything is erased, and keeps a stale frame out
 * of the next command's reply.
 */
async function checkReadDigest(loader: EspLoader, data: Uint8Array, position: number): Promise<void> {
  const frame = await loader.transport.read(ESP_READ_DIGEST_WAIT_MS);
  if (!frame || frame.length !== 16) return;
  const sent = Array.from(frame, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sent !== md5Hex(data)) {
    throw new EspProtocolError(`The stub's MD5 of the flash bytes it sent at 0x${position.toString(16)} does not match what Cody received, so the read was corrupted. Nothing was erased.`);
  }
}

/** Reads flash in bounded pieces so neither the escrow nor the read buffer is ever the whole chip. */
async function* flashPieces(loader: EspLoader, context: HardwareContext, offset: number, length: number, phase: string): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for (let position = offset; position < offset + length; position += ESP_FLASH_PIECE_BYTES) {
    throwIfAborted(context.signal);
    const size = Math.min(ESP_FLASH_PIECE_BYTES, offset + length - position);
    const base = position - offset;
    const data = await loader.readFlash(position, size, (_packet, completed) => context.progress({ phase, completed: base + completed, total: length, message: `${phase} ${base + completed}/${length} bytes` }));
    throwIfAborted(context.signal);
    if (data.length !== size) throw new EspProtocolError(`ESP read_flash returned ${data.length} bytes at 0x${position.toString(16)}; expected ${size}.`);
    await checkReadDigest(loader, data, position);
    yield new Uint8Array(data);
  }
}

async function escrowFlash(loader: EspLoader, context: HardwareContext, chip: string, offset: number, length: number): Promise<{ fileId: string; sha256: string }> {
  const name = artifactName(chip, offset, length, "backup");
  const pieces = flashPieces(loader, context, offset, length, "backup");
  if (context.saveStream) return context.saveStream(name, pieces);
  const parts: Blob[] = [];
  for await (const piece of pieces) parts.push(new Blob([piece]));
  const file = new Blob(parts);
  return { fileId: await context.save(name, file), sha256: await sha256Blob(file) };
}

/**
 * Proof that a range is blank: the device hashes the flash itself
 * (ESP_SPI_FLASH_MD5) and the hash must equal that of the same number of 0xFF
 * bytes. This is `esptool verify_flash`'s own check, applied to erased flash.
 */
async function verifyBlank(loader: EspLoader, context: HardwareContext, offset: number, length: number): Promise<void> {
  const blank = new Uint8Array(Math.min(ESP_FLASH_PIECE_BYTES, length)).fill(0xff);
  for (let position = offset; position < offset + length; position += ESP_FLASH_PIECE_BYTES) {
    throwIfAborted(context.signal);
    const size = Math.min(ESP_FLASH_PIECE_BYTES, offset + length - position);
    const actual = (await loader.flashMd5sum(position, size)).toLowerCase();
    if (actual !== md5Hex(blank.subarray(0, size))) {
      throw new EspProtocolError(`Erase verification failed: the device's MD5 of 0x${position.toString(16)}..0x${(position + size).toString(16)} is not that of blank flash. The device has been modified; nothing was retried.`);
    }
    context.progress({ phase: "verify", completed: position + size - offset, total: length, message: `Verified blank to 0x${(position + size).toString(16)}.` });
  }
}

function regionPayload(offset: number, length: number): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, offset, true);
  view.setUint32(4, length, true);
  return payload;
}

async function eraseCommand(command: Extract<EspCommand, { kind: "erase_flash" | "erase_region" }>, request: HardwareRequest, session: EspSession, context: HardwareContext): Promise<HardwareResult> {
  const { loader, chip, bootOffset } = session;
  if (!loader.IS_STUB) {
    throw new EspProtocolError("ESP flash erase needs esptool's flasher stub, and this connection is using the ROM loader only. Reconnect with the default reset so the stub is uploaded.");
  }
  const requested = parseFlashSafety(request.options);
  if (requested.expectedChip && requested.expectedChip.trim().toLowerCase() !== chip.toLowerCase()) {
    throw new EspProtocolError(`Refusing erase: expected chip ${requested.expectedChip} does not match detected chip ${chip}.`);
  }
  const eraseBlock = ESP_SPI_ERASE_BLOCK_BYTES[chip];
  if (!eraseBlock) throw new EspProtocolError(`No reviewed SPI erase geometry exists for detected ${chip}.`);
  // The SPI boot area runs from the chip's second-stage bootloader offset to the
  // application offset. Zero is a real answer here (ESP32-S3, C3, C2, C6, H2 and
  // ESP8266 boot from offset 0), so the whole area below the application is guarded.
  if (bootOffset >= ESP_APPLICATION_OFFSET || bootOffset % eraseBlock !== 0) {
    throw new EspProtocolError(`Detected ${chip} SPI boot boundary is not a known erase-aligned profile.`);
  }
  const bootStart = bootOffset;
  const { capacity, label: flashLabel } = await recognisedFlashCapacity(loader);
  const offset = command.kind === "erase_flash" ? 0 : command.offset;
  const length = command.kind === "erase_flash" ? capacity : command.length;
  if (offset % eraseBlock !== 0 || length % eraseBlock !== 0) throw new EspProtocolError(`An erase must start and end on a ${eraseBlock}-byte flash sector boundary.`);
  if (!Number.isSafeInteger(offset + length) || offset + length > capacity) {
    throw new EspProtocolError(`The range 0x${offset.toString(16)}..0x${(offset + length).toString(16)} escapes the detected ${flashLabel} flash.`);
  }

  const security = await readSecurity(session, context);
  const touchesBoot = offset < ESP_APPLICATION_OFFSET && offset + length > bootStart;
  const securityActive = security.secureBoot === true || security.flashEncryption === true;
  const securityUnknown = security.secureBoot === undefined || security.flashEncryption === undefined;
  // Each named override is typed in the confirmation; the flasher decides which apply, as it does for a Fastboot erase.
  const overrides: ProtectedRegionOverride[] = [
    ...(touchesBoot ? (["allow-spi-boot"] as const) : []),
    ...(securityActive ? (["allow-fuses"] as const) : securityUnknown ? (["allow-unknown"] as const) : []),
  ];

  context.progress({ phase: "backup", completed: 0, total: length, message: "Escrowing every byte this erase removes." });
  const saved = await escrowFlash(loader, context, chip, offset, length);
  throwIfAborted(context.signal);
  const range = `0x${offset.toString(16)}..0x${(offset + length).toString(16)}`;
  await context.confirm({
    action: command.kind === "erase_flash" ? "esp erase_flash" : "esp erase_region",
    target: "flash",
    offset,
    length,
    backup: `Saved ${length} bytes of ${range} as ${saved.fileId} (sha256 ${saved.sha256}).`,
    ...(overrides.length > 0 ? { protectedOverride: overrides.join(" ") } : {}),
    details: [
      `${command.kind === "erase_flash" ? "Erase the whole" : "Erase flash range"} ${command.kind === "erase_flash" ? `${flashLabel} flash` : range} of ${chip}. Every erased byte reads 0xFF afterwards; the backup above is the only copy, and restoring it is a device_flash.`,
      "After the erase the device's own MD5 of every erased byte must equal that of blank flash.",
      describeSecurity(security),
      ...(touchesBoot ? [`This range includes the SPI boot area 0x${bootStart.toString(16)}..0x${ESP_APPLICATION_OFFSET.toString(16)}: the chip cannot boot until a bootloader is flashed again. ROM download mode stays available.`] : []),
      ...(securityActive ? ["Erasing a chip with secure boot or flash encryption burned can leave it unable to boot, and recovery needs the original keys. esptool refuses this unless forced."] : []),
      ...(!securityActive && securityUnknown ? ["Cody could not establish this chip's security state, so it is treated as possibly secured."] : []),
    ].join(" "),
  });

  context.progress({ phase: "erase", message: `Erasing ${range}; this can take a while and cannot be cancelled on the chip.` });
  if (command.kind === "erase_flash") {
    await loader.eraseFlash();
  } else {
    const timeout = Math.max(ESP_MIN_COMMAND_TIMEOUT_MS, (ESP_ERASE_REGION_TIMEOUT_MS_PER_MB * length) / 1_000_000);
    await loader.checkCommand("erase region", ESP_ERASE_REGION_COMMAND, regionPayload(offset, length), 0, 0, timeout);
  }
  throwIfAborted(context.signal);
  await verifyBlank(loader, context, offset, length);
  return {
    summary: command.kind === "erase_flash" ? `Erased the whole ${flashLabel} flash of ${chip} and verified it blank.` : `Erased ${range} of ${chip} flash and verified it blank.`,
    verified: true,
    details: { chip, offset, length, backupId: saved.fileId, backupSha256: saved.sha256, verification: "device MD5 equals the MD5 of blank flash over every erased byte", security },
  };
}

async function execute(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  const command = parseEspCommand(request.command);
  return withSession(request, context, importEspTool, async (session) => {
    switch (command.kind) {
      case "chip_id": return chipIdCommand(session, context);
      case "read_mac": return readMacCommand(session, context);
      case "flash_id": return flashIdCommand(session, context);
      case "get_security_info": return securityInfoCommand(session, context);
      case "efuse_summary": return efuseSummaryCommand(session, context);
      case "efuse_dump": return efuseDumpCommand(session, context);
      case "erase_flash":
      case "erase_region": return eraseCommand(command, request, session, context);
    }
  });
}

async function dump(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  const offset = requireOffset(request.offset, "ESP dump offset");
  const length = requireLength(request.length, "ESP dump length");
  return withSession(request, context, importEspTool, async ({ loader, chip }) => {
    context.progress({ phase: "dump", completed: 0, total: length, message: `Reading ${length} bytes from ESP flash.` });
    const data = await loader.readFlash(offset, length, progressReader(context, "dump"));
    throwIfAborted(context.signal);
    if (data.length !== length) throw new EspProtocolError(`ESP read_flash returned ${data.length} bytes; expected ${length}.`);
    const blob = blobFromBytes(data);
    const fileId = await context.save(artifactName(chip, offset, length, "dump"), blob);
    const sha256 = await sha256Blob(blob);
    return { summary: `Read ${length} bytes from ${chip} SPI flash.`, fileId, sha256, details: { chip, offset, length } };
  });
}

async function flash(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  const firmware = requireInput(context);
  const offset = requireOffset(request.offset, "ESP flash offset");
  return withSession(request, context, importEspTool, async ({ loader, chip, bootOffset }) => {
    const length = firmware.size;
    if (!Number.isSafeInteger(length)) throw new EspProtocolError("Firmware is too large for an ESP flash operation.");
    const flashCapacity = flashCapacityBytes(await loader.detectFlashSize());
    const safety = intrinsicEspSafety(request, chip, bootOffset, flashCapacity, length);

    // `writeFlash({ compress: true })` erases its complete SPI sector footprint.
    // Escrow and preserve the whole profile-derived footprint, not payload bytes alone.
    context.progress({ phase: "backup", completed: 0, total: safety.eraseLength, message: "Escrowing the complete ESP erase footprint." });
    const before = await loader.readFlash(safety.eraseOffset, safety.eraseLength, progressReader(context, "backup"));
    throwIfAborted(context.signal);
    if (before.length !== safety.eraseLength) {
      throw new EspProtocolError(`ESP pre-write read_flash returned ${before.length} bytes; expected ${safety.eraseLength}.`);
    }
    const backup = await context.save(artifactName(chip, safety.eraseOffset, safety.eraseLength, "backup"), blobFromBytes(before));
    context.progress({ phase: "backup", completed: safety.eraseLength, total: safety.eraseLength, message: `Escrowed complete erase footprint as ${backup}.` });

    const payload = new Uint8Array(await firmware.arrayBuffer());
    const program = new Uint8Array(before);
    program.set(payload, offset - safety.eraseOffset);
    const programImage = blobFromBytes(program);
    const verified = await runVerifiedFlash({
      request,
      context,
      safety,
      backup,
      programImage,
      write: async (approvedFirmware, approval) => {
        throwIfAborted(context.signal);
        const bytes = new Uint8Array(await approvedFirmware.arrayBuffer());
        throwIfAborted(context.signal);
        // esptool-js 0.6.1 normally retries blocks three times. One attempt
        // keeps an interrupted or unacknowledged destructive write explicit.
        loader.WRITE_BLOCK_ATTEMPTS = 1;
        context.progress({ phase: "write", completed: 0, total: bytes.length, message: "Writing compressed ESP flash blocks once; no retry is permitted." });
        await loader.writeFlash({
          fileArray: [{ data: bytes, address: approval.offset }],
          flashMode: "keep",
          flashFreq: "keep",
          flashSize: "keep",
          eraseAll: false,
          compress: true,
          reportProgress: (fileIndex, completed, total) => {
            context.progress({ phase: "write", completed, total, message: `Writing compressed ESP file ${fileIndex + 1}: ${completed}/${total} bytes.` });
          },
          // In esptool-js this engages the stub's ESP_SPI_FLASH_MD5 request and
          // fails writeFlash on a device/file mismatch before readback begins.
          calculateMD5Hash: md5Hex,
        });
        throwIfAborted(context.signal);
      },
      readback: async (approval) => {
        context.progress({ phase: "readback", completed: 0, total: approval.length, message: "Reading back the complete ESP erase footprint for SHA-256 verification." });
        const data = await loader.readFlash(approval.offset, approval.length, progressReader(context, "readback"));
        throwIfAborted(context.signal);
        if (data.length !== approval.length) {
          throw new EspProtocolError(`ESP readback returned ${data.length} bytes; expected ${approval.length}.`);
        }
        return blobFromBytes(data);
      },
    });

    return {
      summary: `Flashed and readback-verified ${length} payload bytes across ${safety.eraseLength} ESP erase-footprint bytes on ${chip}.`,
      verified: verified.verified,
      sha256: verified.sha256,
      details: {
        chip,
        offset,
        length,
        eraseOffset: safety.eraseOffset,
        eraseLength: safety.eraseLength,
        backup,
        deviceMd5: "verified by esptool-js writeFlash",
        programSha256: verified.programSha256,
        readbackSha256: verified.readbackSha256,
      },
    };
  });
}

async function runEsp(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  if (request.protocol !== "esp") throw new EspProtocolError(`ESP flasher cannot run ${request.protocol}.`);
  if (request.action === "detect") return detect(request, context, importEspTool);
  if (request.action === "dump") return dump(request, context, importEspTool);
  if (request.action === "flash") return flash(request, context, importEspTool);
  if (request.action === "exec") return execute(request, context, importEspTool);
  throw new EspProtocolError(`ESP does not support ${request.action}.`);
}

export function createEspFlasher(importEspTool: EspToolImporter = loadBrowserEspTool): Flasher {
  return {
    protocol: "esp",
    actions: ["detect", "flash", "dump", "exec"],
    run: (request, context) => runEsp(request, context, importEspTool),
  };
}

export const espFlasher = createEspFlasher();
