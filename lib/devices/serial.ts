import type { HardwareContext, HardwareTransport } from "./flasher";

export class SerialProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerialProtocolError";
  }
}

export interface ProtocolDeadline {
  readonly endsAt: number;
  readonly label: string;
}

export function deadline(label: string, timeoutMs: number): ProtocolDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SerialProtocolError(`${label} timeout must be a positive integer.`);
  }
  return { endsAt: Date.now() + timeoutMs, label };
}

function remaining(deadlineAt: ProtocolDeadline): number {
  const timeoutMs = deadlineAt.endsAt - Date.now();
  if (timeoutMs <= 0) throw new SerialProtocolError(`${deadlineAt.label} timed out.`);
  return timeoutMs;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted.", "AbortError");
}

export function requireSerial(transport: HardwareTransport): void {
  if (transport.kind !== "serial") throw new SerialProtocolError("This protocol requires a serial transport.");
}

export async function setBaudRate(context: HardwareContext, baudRate: number | undefined): Promise<void> {
  if (baudRate === undefined) return;
  if (!Number.isSafeInteger(baudRate) || baudRate <= 0) throw new SerialProtocolError("baudRate must be a positive integer.");
  if (!context.transport.setBaudRate) throw new SerialProtocolError("The selected serial transport cannot change baud rate.");
  throwIfAborted(context.signal);
  await context.transport.setBaudRate(baudRate, context.signal);
}

/**
 * The bridge owns receive buffering and never returns more than requested.
 * Looping here still handles short reads from Web Serial without leaving bytes
 * attached to an abandoned command after a timeout or abort.
 */
export async function readExact(
  transport: HardwareTransport,
  length: number,
  until: ProtocolDeadline,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(length) || length < 0) throw new SerialProtocolError("Read length must be a non-negative integer.");
  const output = new Uint8Array(length);
  let received = 0;
  while (received < length) {
    throwIfAborted(signal);
    const chunk = await transport.read(length - received, remaining(until), signal);
    if (!chunk) throw new SerialProtocolError(`${until.label} timed out waiting for ${length - received} byte(s).`);
    if (chunk.byteLength === 0) continue;
    if (chunk.byteLength > length - received) {
      throw new SerialProtocolError(`${until.label} transport returned more bytes than requested.`);
    }
    output.set(chunk, received);
    received += chunk.byteLength;
  }
  return output;
}

export async function readByte(
  transport: HardwareTransport,
  until: ProtocolDeadline,
  signal: AbortSignal,
): Promise<number> {
  return (await readExact(transport, 1, until, signal))[0]!;
}

export async function writeBytes(transport: HardwareTransport, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await transport.write(bytes, signal);
}

export function xorChecksum(bytes: Uint8Array): number {
  let checksum = 0;
  for (const byte of bytes) checksum ^= byte;
  return checksum;
}

export function bytes(...values: number[]): Uint8Array {
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
      throw new SerialProtocolError(`Byte value ${value} is outside 0x00..0xff.`);
    }
  }
  return Uint8Array.from(values);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function hex(value: number, width = 2): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

export async function inputBytes(context: HardwareContext): Promise<Uint8Array> {
  if (!context.input) throw new SerialProtocolError("This action requires an input firmware file.");
  throwIfAborted(context.signal);
  return new Uint8Array(await context.input.arrayBuffer());
}

export async function sha256(data: Uint8Array): Promise<string> {
  if (!(data.buffer instanceof ArrayBuffer)) throw new SerialProtocolError("SHA-256 does not accept shared byte storage.");
  const source = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data.buffer
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}


/** Create a Blob without copying an ordinary full-buffer byte view. */
export function blobFromBytes(data: Uint8Array): Blob {
  if (data.buffer instanceof ArrayBuffer) {
    const source = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Blob([source]);
  }
  return new Blob([Uint8Array.from(data).buffer]);
}
export function requireOffset(value: number | undefined, label = "offset"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SerialProtocolError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export function requireLength(value: number | undefined, label = "length"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SerialProtocolError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function optionsRecord(options: Record<string, unknown> | undefined): Record<string, unknown> {
  return options ?? {};
}

export function numberOption(options: Record<string, unknown>, name: string): number | undefined {
  const value = options[name];
  return typeof value === "number" ? value : undefined;
}

export function stringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}
