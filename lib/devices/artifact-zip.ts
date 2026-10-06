/**
 * A ZIP of stored (uncompressed) files, planned before a byte is written.
 *
 * Device backups are partitions of a flash chip: already dense, often a
 * gigabyte each, and wanted bit for bit. Deflating them would cost minutes on a
 * tablet to save nothing, so every entry is STORED and the archive's size is
 * known exactly up front. That is what lets it be written without holding a file
 * in memory (each entry's bytes are a Blob read in slices, or composed into a
 * lazy Blob the browser downloads itself) and without a data descriptor (each
 * entry's CRC-32 and size go in its header, so every reader, streaming or not,
 * can read it).
 *
 * ZIP64 records are written where a field cannot hold the value: an entry of
 * 4 GiB or more, a header offset or central directory past 4 GiB, or 65,535
 * entries or more. A normal backup stays a classic archive that any unzip tool,
 * including the ones on a NAS, opens; a 5 GiB one is ZIP64. `forceZip64` writes
 * them always, which is how the tests prove the ZIP64 records on small data.
 *
 * Pure and browser-safe: it needs Blob, Uint8Array, TextEncoder and
 * ReadableStream, all of which Node has too.
 */

import { Crc32 } from "./crc32";

const SATURATED_16 = 0xffff;
const SATURATED_32 = 0xffffffff;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END64_SIGNATURE = 0x06064b50;
const END64_LOCATOR_SIGNATURE = 0x07064b50;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_MODIFIED = 0x5455;
const FLAG_UTF8 = 0x0800;
const VERSION_CLASSIC = 20;
const VERSION_ZIP64 = 45;
const HOST_UNIX = 3 << 8;
const UNIX_REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;
/** How much of a file one read takes: big enough for few writes, small enough that memory stays flat. */
const SLICE_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

export interface ZipSource {
  /** Where it goes in the archive: `/`-separated, never absolute, never `..`. */
  readonly name: string;
  /** The bytes: a Blob (read lazily, any size) or a small buffer held in memory. */
  readonly data: Blob | Uint8Array<ArrayBuffer>;
  /** CRC-32 of exactly those bytes. */
  readonly crc32: number;
  /** Modification time, milliseconds since the epoch. */
  readonly modified: number;
}

export interface ZipLayoutEntry {
  readonly name: string;
  readonly size: number;
  readonly crc32: number;
  readonly headerOffset: number;
  readonly dataOffset: number;
  /** Which of the plan's `parts` holds this entry's bytes. */
  readonly dataPart: number;
  readonly zip64: boolean;
}

export interface ZipPlan {
  /** The exact size of the finished archive. */
  readonly size: number;
  readonly entries: number;
  /** Any ZIP64 record was written. */
  readonly zip64: boolean;
  /** Headers and entry data in file order. Small buffers and Blobs only: nothing here is a whole file in memory. */
  readonly parts: readonly (Uint8Array<ArrayBuffer> | Blob)[];
  readonly layout: readonly ZipLayoutEntry[];
}

export interface PlanZipOptions {
  readonly forceZip64?: boolean;
}

export class ZipPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipPlanError";
  }
}

/** A name that is safe to extract anywhere: no leading slash, no `.` or `..` segment, no backslash or control character. */
function encodeName(name: string): { bytes: Uint8Array<ArrayBuffer>; ascii: boolean } {
  const segments = name.split("/");
  const unsafe = !name || name.startsWith("/") || name.endsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe || /[\\\u0000-\u001f\u007f]/.test(name)) throw new ZipPlanError(`"${name}" is not a safe name for a file inside an archive.`);
  const bytes = textEncoder.encode(name);
  if (bytes.length > SATURATED_16) throw new ZipPlanError("A file name inside an archive is limited to 65,535 bytes.");
  return { bytes, ascii: bytes.length === name.length };
}

/** MS-DOS date and time in the reader's local time, the only clock a classic ZIP header has. */
function dosDateTime(milliseconds: number): { time: number; date: number } {
  const moment = new Date(milliseconds);
  const year = moment.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (moment.getHours() << 11) | (moment.getMinutes() << 5) | (moment.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate(),
  };
}

class Bytes {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;
  private cursor = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.cursor, value, true);
    this.cursor += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.cursor, value, true);
    this.cursor += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setUint32(this.cursor, value % 0x1_0000_0000, true);
    this.view.setUint32(this.cursor + 4, Math.floor(value / 0x1_0000_0000), true);
    this.cursor += 8;
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.bytes.set(bytes, this.cursor);
    this.cursor += bytes.length;
    return this;
  }
}

/** Info-ZIP's "extended timestamp" field: the modification time in UTC, so it is right in any time zone. */
function modifiedField(milliseconds: number): Uint8Array<ArrayBuffer> {
  const seconds = Math.min(Math.max(Math.floor(milliseconds / 1000), 0), 0x7fffffff);
  return new Bytes(9).u16(EXTRA_MODIFIED).u16(5).raw(new Uint8Array([1])).u32(seconds).bytes;
}

interface Planned {
  readonly name: { bytes: Uint8Array<ArrayBuffer>; ascii: boolean };
  readonly size: number;
  readonly crc32: number;
  readonly modified: number;
  readonly headerOffset: number;
  readonly wideSizes: boolean;
  readonly wideOffset: boolean;
}

function localHeader(entry: Planned): Uint8Array<ArrayBuffer> {
  const { time, date } = dosDateTime(entry.modified);
  const wide = entry.wideSizes ? new Bytes(20).u16(EXTRA_ZIP64).u16(16).u64(entry.size).u64(entry.size).bytes : new Uint8Array(0);
  const extra = [wide, modifiedField(entry.modified)];
  const extraLength = extra.reduce((total, field) => total + field.length, 0);
  const header = new Bytes(30 + entry.name.bytes.length + extraLength)
    .u32(LOCAL_SIGNATURE)
    .u16(entry.wideSizes ? VERSION_ZIP64 : VERSION_CLASSIC)
    .u16(entry.name.ascii ? 0 : FLAG_UTF8)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(entry.crc32)
    .u32(entry.wideSizes ? SATURATED_32 : entry.size)
    .u32(entry.wideSizes ? SATURATED_32 : entry.size)
    .u16(entry.name.bytes.length)
    .u16(extraLength)
    .raw(entry.name.bytes);
  for (const field of extra) header.raw(field);
  return header.bytes;
}

function centralHeader(entry: Planned): Uint8Array<ArrayBuffer> {
  const { time, date } = dosDateTime(entry.modified);
  const wideLength = (entry.wideSizes ? 16 : 0) + (entry.wideOffset ? 8 : 0);
  const wide = new Bytes(wideLength === 0 ? 0 : 4 + wideLength);
  if (wideLength > 0) {
    wide.u16(EXTRA_ZIP64).u16(wideLength);
    if (entry.wideSizes) wide.u64(entry.size).u64(entry.size);
    if (entry.wideOffset) wide.u64(entry.headerOffset);
  }
  const modified = modifiedField(entry.modified);
  const extraLength = wide.bytes.length + modified.length;
  const zip64 = entry.wideSizes || entry.wideOffset;
  return new Bytes(46 + entry.name.bytes.length + extraLength)
    .u32(CENTRAL_SIGNATURE)
    .u16(HOST_UNIX | (zip64 ? VERSION_ZIP64 : VERSION_CLASSIC))
    .u16(zip64 ? VERSION_ZIP64 : VERSION_CLASSIC)
    .u16(entry.name.ascii ? 0 : FLAG_UTF8)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(entry.crc32)
    .u32(entry.wideSizes ? SATURATED_32 : entry.size)
    .u32(entry.wideSizes ? SATURATED_32 : entry.size)
    .u16(entry.name.bytes.length)
    .u16(extraLength)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(UNIX_REGULAR_FILE_0644)
    .u32(entry.wideOffset ? SATURATED_32 : entry.headerOffset)
    .raw(entry.name.bytes)
    .raw(wide.bytes)
    .raw(modified).bytes;
}

/**
 * The archive for these files, in order. Nothing is read: every size comes from the Blob or buffer, every CRC from the
 * caller, so planning a 4 GiB archive is instant. A name used twice, an unsafe name or a CRC that is not 32 bits is
 * refused rather than written.
 */
export function planZip(sources: readonly ZipSource[], options: PlanZipOptions = {}): ZipPlan {
  const force = options.forceZip64 === true;
  const parts: (Uint8Array<ArrayBuffer> | Blob)[] = [];
  const layout: ZipLayoutEntry[] = [];
  const planned: Planned[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const source of sources) {
    const name = encodeName(source.name);
    if (seen.has(source.name)) throw new ZipPlanError(`"${source.name}" appears twice in the archive.`);
    seen.add(source.name);
    if (!Number.isInteger(source.crc32) || source.crc32 < 0 || source.crc32 > SATURATED_32) throw new ZipPlanError(`"${source.name}" has no valid CRC-32.`);
    const size = source.data instanceof Blob ? source.data.size : source.data.byteLength;
    const entry: Planned = {
      name,
      size,
      crc32: source.crc32,
      modified: source.modified,
      headerOffset: offset,
      wideSizes: force || size >= SATURATED_32,
      wideOffset: force || offset >= SATURATED_32,
    };
    const header = localHeader(entry);
    parts.push(header, source.data);
    layout.push({ name: source.name, size, crc32: source.crc32, headerOffset: offset, dataOffset: offset + header.length, dataPart: parts.length - 1, zip64: entry.wideSizes || entry.wideOffset });
    planned.push(entry);
    offset += header.length + size;
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const entry of planned) {
    const header = centralHeader(entry);
    parts.push(header);
    directorySize += header.length;
  }
  offset += directorySize;

  const wideEnd = force || planned.length >= SATURATED_16 || directoryOffset >= SATURATED_32 || directorySize >= SATURATED_32;
  if (wideEnd) {
    const recordOffset = offset;
    parts.push(
      new Bytes(56).u32(END64_SIGNATURE).u64(44).u16(HOST_UNIX | VERSION_ZIP64).u16(VERSION_ZIP64).u32(0).u32(0).u64(planned.length).u64(planned.length).u64(directorySize).u64(directoryOffset).bytes,
      new Bytes(20).u32(END64_LOCATOR_SIGNATURE).u32(0).u64(recordOffset).u32(1).bytes,
    );
    offset += 56 + 20;
  }
  parts.push(new Bytes(22)
    .u32(END_SIGNATURE)
    .u16(0)
    .u16(0)
    .u16(Math.min(planned.length, SATURATED_16))
    .u16(Math.min(planned.length, SATURATED_16))
    .u32(Math.min(directorySize, SATURATED_32))
    .u32(Math.min(directoryOffset, SATURATED_32))
    .u16(0).bytes);
  offset += 22;

  return { size: offset, entries: planned.length, zip64: wideEnd || layout.some((entry) => entry.zip64), parts, layout };
}

/**
 * The whole archive as one lazy Blob. Its entries are the original Blobs by reference, so nothing is copied or read
 * into JavaScript memory: the browser's own download reads it from disk as it saves it.
 */
export function zipBlob(plan: ZipPlan): Blob {
  return new Blob([...plan.parts], { type: "application/zip" });
}

export interface ZipStreamOptions {
  readonly signal?: AbortSignal;
  /** Every byte handed on, for progress. */
  readonly onBytes?: (bytes: number) => void;
  /** Recompute each entry's CRC-32 while writing and fail when its bytes are not the ones the plan was made for. */
  readonly verify?: boolean;
}

/**
 * The archive as a byte stream with backpressure: one slice of one entry is in memory at a time, and a consumer that
 * stops pulling stops the reading. `verify` makes the writer prove each entry's CRC-32 as it goes, so a file whose
 * stored bytes changed since the CRC was recorded stops the write with a message instead of producing a bad archive.
 */
export function zipStream(plan: ZipPlan, options: ZipStreamOptions = {}): ReadableStream<Uint8Array> {
  const owners = new Map(plan.layout.map((entry) => [entry.dataPart, entry]));
  let index = 0;
  let blob: Blob | undefined;
  let owner: ZipLayoutEntry | undefined;
  let blobOffset = 0;
  let crc: Crc32 | undefined;
  let failure: unknown;

  const abort = (): void => {
    failure ??= options.signal?.reason ?? new DOMException("The archive was cancelled.", "AbortError");
  };
  const check = (entry: ZipLayoutEntry, seen: number): void => {
    if (seen !== entry.size) throw new ZipPlanError(`"${entry.name}" changed size while the archive was being written (expected ${entry.size} bytes, read ${seen}).`);
    if (crc && crc.digest() !== entry.crc32) throw new ZipPlanError(`"${entry.name}" no longer matches the checksum recorded for it, so the archive was not finished. Its stored copy may be damaged.`);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      if (options.signal?.aborted) abort();
      options.signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      try {
        if (failure !== undefined) throw failure;
        for (;;) {
          if (!blob) {
            if (index >= plan.parts.length) {
              controller.close();
              options.signal?.removeEventListener("abort", abort);
              return;
            }
            const part = plan.parts[index]!;
            owner = owners.get(index);
            index += 1;
            if (part instanceof Blob) {
              blob = part;
              blobOffset = 0;
              crc = options.verify && owner ? new Crc32() : undefined;
              continue;
            }
            if (options.verify && owner) {
              crc = new Crc32().update(part);
              check(owner, part.byteLength);
              crc = undefined;
            }
            options.onBytes?.(part.byteLength);
            controller.enqueue(part.slice());
            return;
          }
          if (blobOffset >= blob.size) {
            if (owner) check(owner, blobOffset);
            blob = undefined;
            crc = undefined;
            continue;
          }
          const slice = new Uint8Array(await blob.slice(blobOffset, blobOffset + SLICE_BYTES).arrayBuffer());
          if (failure !== undefined) throw failure;
          if (slice.byteLength === 0) throw new ZipPlanError(`"${owner?.name ?? "a file"}" ended early while the archive was being written.`);
          blobOffset += slice.byteLength;
          crc?.update(slice);
          options.onBytes?.(slice.byteLength);
          controller.enqueue(slice);
          return;
        }
      } catch (error) {
        options.signal?.removeEventListener("abort", abort);
        controller.error(error);
      }
    },
    cancel() {
      options.signal?.removeEventListener("abort", abort);
    },
  });
}
