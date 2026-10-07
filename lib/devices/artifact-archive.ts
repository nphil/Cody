/**
 * The ONE zip writer behind every device backup, in the browser (Download all) and on the server (the vault's saved
 * archive), so both produce the same file.
 *
 * Every device file is DEFLATED as it streams through, so a backup is one small file whatever the device was: the
 * writer reads each entry once, takes its CRC-32 and length on the way, and writes them after the data in a data
 * descriptor, so nothing has to be known or measured beforehand. A file of 0 bytes, and the small `SHA256SUMS` and
 * `manifest.json` that sit beside the files, are STORED with their CRC and size in the local header, so any tool can
 * read those two without inflating anything.
 *
 * It is pull-based: one entry's slice is in memory at a time, and a consumer that stops pulling stops the reading. The
 * compressor is fed by hand, one chunk at a time and only while the consumer is waiting for more, because Node's
 * `CompressionStream` queues up to ~16,000 input CHUNKS before it pushes back: a plain `pipeThrough` would slurp a
 * multi-gigabyte partition into memory ahead of a slow disk.
 *
 * The writer never produces a plausible-looking bad archive. An entry whose stream delivers another length than it
 * announced, or whose bytes do not match a CRC recorded for them, FAILS the whole write: the stream errors before the
 * entry's descriptor and the directory are written, so what was produced so far is not a zip any reader opens.
 *
 * ZIP64 records are written where a field cannot hold the value: an entry of `wideEntryBytes` or more (16 MiB short of
 * 4 GiB, far more room than deflate's worst-case growth of about 0.04 %, so a smaller entry always packs to a size a
 * classic field holds), a header offset or central directory past 4 GiB, or 65,535 entries or more. A normal backup
 * stays a classic archive that any unzip tool, including the ones on a NAS, opens. `forceZip64` writes them always,
 * which is how the tests prove the ZIP64 records on small data.
 *
 * Browser- and server-safe: only web streams, `CompressionStream`, `TextEncoder`, `Blob` and typed arrays.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ArtifactProvenance, BackupScope } from "./artifact-model";
import { MANIFEST_NAME, SUMS_NAME } from "./artifact-names";
import { Crc32, crc32 as crc32Of } from "./crc32";

const SATURATED_16 = 0xffff;
const SATURATED_32 = 0xffffffff;
const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END64_SIGNATURE = 0x06064b50;
const END64_LOCATOR_SIGNATURE = 0x07064b50;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_MODIFIED = 0x5455;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const VERSION_CLASSIC = 20;
const VERSION_ZIP64 = 45;
const HOST_UNIX = 3 << 8;
const UNIX_REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;
/** Output is handed on in pieces of at least this size, so a file sink does few big writes instead of one per 16 KiB the compressor emits. */
const CHUNK_BYTES = 256 * 1024;
/** A long entry reports progress about this often. */
const PROGRESS_STEP_BYTES = 1024 * 1024;
/**
 * An entry this big or bigger is written with 64-bit sizes. Deflate cannot grow data by more than about 0.04 %, so an
 * entry under this size always compresses to under 4 GiB (0xFFFFFFFF), which is all a classic size field holds.
 */
const DEFAULT_WIDE_ENTRY_BYTES = 0xff000000;
/** What `manifest.json` calls itself; the vault and the page both read archives by it. */
export const MANIFEST_FORMAT = "cody-device-artifacts/2";

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export interface ArchiveSource {
  /** Where it goes in the archive: `/`-separated, never absolute, never `..`. */
  readonly name: string;
  /** Exact byte length. The write FAILS if the stream delivers another length. */
  readonly size: number;
  /** Modification time, milliseconds since the epoch. */
  readonly modified: number;
  /** A fresh stream of exactly `size` bytes. Called once, and only when this entry's turn comes. */
  open(): ReadableStream<Uint8Array>;
  /** A CRC-32 recorded earlier. The write FAILS when the bytes read do not match it. */
  readonly crc32?: number;
  /** Write uncompressed (method 0). The CRC-32 goes in the local header, so `crc32` is required. */
  readonly stored?: boolean;
}

export interface ArchiveEntryReport {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly method: 0 | 8;
  readonly headerOffset: number;
  /** 64-bit sizes or a 64-bit header offset were needed for this entry. */
  readonly zip64: boolean;
}

export interface ArchiveSummary {
  readonly entries: readonly ArchiveEntryReport[];
  /** The archive's length. */
  readonly bytes: number;
  /** The entries' sizes added up, before packing. */
  readonly originalBytes: number;
  /** Any ZIP64 record was written. */
  readonly zip64: boolean;
}

export interface ArchiveProgress {
  /** The entry being written (the last one, once they are all done). */
  readonly entry: number;
  readonly name: string;
  readonly entriesDone: number;
  /** Uncompressed bytes taken from the sources so far, all entries. */
  readonly readBytes: number;
  /** Archive bytes produced so far. */
  readonly writtenBytes: number;
}

export interface WriteArchiveOptions {
  /** Ends the write with an `aborted` ArchiveError (named AbortError, as the transfer code expects) and closes every source. */
  readonly signal?: AbortSignal;
  /** Called at each entry's start and end and about every MiB read in between. A callback that throws stops the write. */
  readonly onProgress?: (progress: ArchiveProgress) => void;
  /** ZIP64 records everywhere, even on small data. */
  readonly forceZip64?: boolean;
  /** Test hook: the entry size from which 64-bit sizes are used. */
  readonly wideEntryBytes?: number;
}

export type ArchiveErrorCode = "changed" | "damaged" | "unsafe-name" | "duplicate-name" | "too-large" | "aborted";

/** Always a plain-English message; the code is for a caller that wants to react. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  constructor(message: string, code: ArchiveErrorCode) {
    super(message);
    // A cancel is called AbortError because the page's transfer code and the browser's own streams recognise that name.
    this.name = code === "aborted" ? "AbortError" : "ArchiveError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------

/** A name that is safe to extract anywhere: no leading slash, no `.` or `..` segment, no backslash or control character. */
function encodeName(name: string): { bytes: Uint8Array<ArrayBuffer>; ascii: boolean } {
  const segments = name.split("/");
  const unsafe = !name || name.startsWith("/") || name.endsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe || /[\\\u0000-\u001f\u007f]/.test(name)) throw new ArchiveError(`"${name}" is not a safe name for a file inside an archive.`, "unsafe-name");
  const bytes = textEncoder.encode(name);
  if (bytes.length > SATURATED_16) throw new ArchiveError("A file name inside an archive is limited to 65,535 bytes.", "unsafe-name");
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

/** Everything the zip records say about one entry. The encoders below turn it into bytes and nothing else. */
export interface ArchiveEntryRecord {
  /** Path inside the archive. */
  readonly name: string;
  /** Milliseconds since the epoch. */
  readonly modified: number;
  readonly method: 0 | 8;
  /**
   * Flag bit 3: the CRC-32 and the sizes follow the data, in a data descriptor, and the local header holds zeros for
   * them. The local header of such an entry is written before they are known: pass 0, they are not read.
   */
  readonly descriptor: boolean;
  /** 64-bit sizes: the ZIP64 extra field in the headers and 8-byte sizes in the descriptor. */
  readonly wideSizes: boolean;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  /** Where this entry's local header starts. */
  readonly headerOffset: number;
  /** The offset needs 64 bits, so the central record carries it in its ZIP64 extra field. */
  readonly wideOffset: boolean;
}

function flagsOf(entry: ArchiveEntryRecord, ascii: boolean): number {
  return (entry.descriptor ? FLAG_DESCRIPTOR : 0) | (ascii ? 0 : FLAG_UTF8);
}

export function encodeLocalHeader(entry: ArchiveEntryRecord): Uint8Array<ArrayBuffer> {
  const name = encodeName(entry.name);
  const { time, date } = dosDateTime(entry.modified);
  // A descriptor entry's sizes are not known yet: zeros, both in the 32-bit fields and in the ZIP64 field that tells a
  // streaming reader a 64-bit descriptor will follow. A stored entry's sizes are known: classic fields, or all ones
  // with the real values in the ZIP64 field.
  const known = !entry.descriptor;
  const compressedField = known ? (entry.wideSizes ? SATURATED_32 : entry.compressedSize) : 0;
  const sizeField = known ? (entry.wideSizes ? SATURATED_32 : entry.size) : 0;
  const wide = entry.wideSizes ? new Bytes(20).u16(EXTRA_ZIP64).u16(16).u64(known ? entry.size : 0).u64(known ? entry.compressedSize : 0).bytes : new Uint8Array(0);
  const modified = modifiedField(entry.modified);
  const extraLength = wide.length + modified.length;
  return new Bytes(30 + name.bytes.length + extraLength)
    .u32(LOCAL_SIGNATURE)
    .u16(entry.wideSizes ? VERSION_ZIP64 : VERSION_CLASSIC)
    .u16(flagsOf(entry, name.ascii))
    .u16(entry.method)
    .u16(time)
    .u16(date)
    .u32(known ? entry.crc32 : 0)
    .u32(compressedField)
    .u32(sizeField)
    .u16(name.bytes.length)
    .u16(extraLength)
    .raw(name.bytes)
    .raw(wide)
    .raw(modified).bytes;
}

/** What follows a deflated entry's data: the CRC-32 and sizes the local header could not know yet. */
export function encodeDataDescriptor(entry: ArchiveEntryRecord): Uint8Array<ArrayBuffer> {
  const record = new Bytes(entry.wideSizes ? 24 : 16).u32(DESCRIPTOR_SIGNATURE).u32(entry.crc32);
  return (entry.wideSizes ? record.u64(entry.compressedSize).u64(entry.size) : record.u32(entry.compressedSize).u32(entry.size)).bytes;
}

export function encodeCentralRecord(entry: ArchiveEntryRecord): Uint8Array<ArrayBuffer> {
  const name = encodeName(entry.name);
  const { time, date } = dosDateTime(entry.modified);
  const wideLength = (entry.wideSizes ? 16 : 0) + (entry.wideOffset ? 8 : 0);
  const wide = new Bytes(wideLength === 0 ? 0 : 4 + wideLength);
  if (wideLength > 0) {
    wide.u16(EXTRA_ZIP64).u16(wideLength);
    if (entry.wideSizes) wide.u64(entry.size).u64(entry.compressedSize);
    if (entry.wideOffset) wide.u64(entry.headerOffset);
  }
  const modified = modifiedField(entry.modified);
  const extraLength = wide.bytes.length + modified.length;
  const zip64 = entry.wideSizes || entry.wideOffset;
  return new Bytes(46 + name.bytes.length + extraLength)
    .u32(CENTRAL_SIGNATURE)
    .u16(HOST_UNIX | (zip64 ? VERSION_ZIP64 : VERSION_CLASSIC))
    .u16(zip64 ? VERSION_ZIP64 : VERSION_CLASSIC)
    .u16(flagsOf(entry, name.ascii))
    .u16(entry.method)
    .u16(time)
    .u16(date)
    .u32(entry.crc32)
    .u32(entry.wideSizes ? SATURATED_32 : entry.compressedSize)
    .u32(entry.wideSizes ? SATURATED_32 : entry.size)
    .u16(name.bytes.length)
    .u16(extraLength)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(UNIX_REGULAR_FILE_0644)
    .u32(entry.wideOffset ? SATURATED_32 : entry.headerOffset)
    .raw(name.bytes)
    .raw(wide.bytes)
    .raw(modified).bytes;
}

/** Where the central directory lies and how big it is. */
export interface ArchiveDirectory {
  readonly entries: number;
  readonly offset: number;
  readonly size: number;
  readonly forceZip64?: boolean;
}

function needsZip64End(directory: ArchiveDirectory): boolean {
  return directory.forceZip64 === true || directory.entries >= SATURATED_16 || directory.offset >= SATURATED_32 || directory.size >= SATURATED_32;
}

/**
 * The records that close the archive: the ZIP64 end record and its locator when a classic field could not hold the
 * entry count, the directory's offset or its size (or when ZIP64 is forced), then the classic end record. Its fields
 * say "look in the ZIP64 record" (all ones) where they overflow, and when ZIP64 is forced in all three, which is what
 * an archive that really needs them looks like: some readers only follow the locator when a field says to.
 */
export function encodeEndRecords(directory: ArchiveDirectory): Uint8Array<ArrayBuffer> {
  const forced = directory.forceZip64 === true;
  const records: Uint8Array[] = [];
  if (needsZip64End(directory)) {
    records.push(
      new Bytes(56).u32(END64_SIGNATURE).u64(44).u16(HOST_UNIX | VERSION_ZIP64).u16(VERSION_ZIP64).u32(0).u32(0).u64(directory.entries).u64(directory.entries).u64(directory.size).u64(directory.offset).bytes,
      new Bytes(20).u32(END64_LOCATOR_SIGNATURE).u32(0).u64(directory.offset + directory.size).u32(1).bytes,
    );
  }
  const entries = forced ? SATURATED_16 : Math.min(directory.entries, SATURATED_16);
  records.push(
    new Bytes(22)
      .u32(END_SIGNATURE)
      .u16(0)
      .u16(0)
      .u16(entries)
      .u16(entries)
      .u32(forced ? SATURATED_32 : Math.min(directory.size, SATURATED_32))
      .u32(forced ? SATURATED_32 : Math.min(directory.offset, SATURATED_32))
      .u16(0).bytes,
  );
  return join(records, records.reduce((total, record) => total + record.length, 0));
}

function join(pieces: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------------------------

/** A Blob as an entry: deflated unless it is empty. A `crc32` recorded earlier is checked against the bytes as they go by. */
export function blobSource(name: string, blob: Blob, modified: number, crc32?: number): ArchiveSource {
  return { name, size: blob.size, modified, open: () => blob.stream(), ...(crc32 === undefined ? {} : { crc32 }) };
}

/** A small buffer held in memory as an entry: stored, its CRC-32 taken here. */
export function bytesSource(name: string, bytes: Uint8Array, modified: number): ArchiveSource {
  return {
    name,
    size: bytes.length,
    modified,
    crc32: crc32Of(bytes),
    stored: true,
    open: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.length > 0) controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------------------------------------------------

interface PreparedEntry {
  readonly source: ArchiveSource;
  /** Method 0: the CRC and sizes are in the local header and no descriptor follows. */
  readonly stored: boolean;
  readonly wide: boolean;
}

/** Everything that can be wrong with the list is wrong before the first byte is produced. */
function prepare(sources: readonly ArchiveSource[], options: WriteArchiveOptions): PreparedEntry[] {
  const force = options.forceZip64 === true;
  // Whatever the hook says, a size a 32-bit field cannot hold is always written wide.
  const wideFrom = Math.min(options.wideEntryBytes ?? DEFAULT_WIDE_ENTRY_BYTES, SATURATED_32);
  const seen = new Set<string>();
  return sources.map((source) => {
    encodeName(source.name);
    if (seen.has(source.name)) throw new ArchiveError(`"${source.name}" appears twice in the archive.`, "duplicate-name");
    seen.add(source.name);
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new RangeError(`"${source.name}" has no valid size.`);
    if (!Number.isFinite(source.modified)) throw new RangeError(`"${source.name}" has no valid modification time.`);
    if (source.crc32 !== undefined && (!Number.isInteger(source.crc32) || source.crc32 < 0 || source.crc32 > SATURATED_32)) throw new RangeError(`"${source.name}" has no valid CRC-32.`);
    if (source.stored && source.crc32 === undefined) throw new TypeError(`"${source.name}" is stored, so its CRC-32 is needed up front.`);
    return { source, stored: source.stored === true || source.size === 0, wide: force || source.size >= wideFrom };
  });
}

/** Holds the small records and the compressor's 16 KiB pieces until there is a chunk worth handing on. */
class Coalescer {
  private pieces: Uint8Array[] = [];
  private length = 0;

  /**
   * Takes a piece; returns the chunks that are ready to hand on, usually none. Held pieces go on as ONE chunk once
   * there are enough of them. A piece that is a chunk's worth by itself goes on as it is: copying a big piece to put a
   * few header bytes in front of it would only cost time and memory.
   */
  add(piece: Uint8Array): Uint8Array[] {
    if (piece.length >= CHUNK_BYTES) return [...this.flush(), piece];
    this.pieces.push(piece);
    this.length += piece.length;
    return this.length >= CHUNK_BYTES ? this.flush() : [];
  }

  /** Whatever is held, as one chunk (none when nothing is). */
  flush(): Uint8Array[] {
    if (this.length === 0) return [];
    const joined = this.pieces.length === 1 ? this.pieces[0]! : join(this.pieces, this.length);
    this.pieces = [];
    this.length = 0;
    return [joined];
  }
}

/** Counts and checksums one entry's bytes as they pass, and holds the source to what it announced. */
class EntryCheck {
  private readonly source: ArchiveSource;
  private readonly onBytes: (bytes: number) => void;
  private readonly crc = new Crc32();
  private length = 0;

  constructor(source: ArchiveSource, onBytes: (bytes: number) => void) {
    this.source = source;
    this.onBytes = onBytes;
  }

  /** The next bytes of the source, in order. */
  push(chunk: Uint8Array): void {
    this.length += chunk.length;
    if (this.length > this.source.size) {
      throw new ArchiveError(`"${this.source.name}" changed while the archive was being written: it had ${this.source.size} bytes and more than that was read, so the archive was not finished.`, "changed");
    }
    this.crc.update(chunk);
    this.onBytes(chunk.length);
  }

  /** The source ended: it must have delivered exactly what it announced and match the CRC-32 recorded for it. Returns the CRC-32. */
  finish(): number {
    if (this.length !== this.source.size) {
      throw new ArchiveError(`"${this.source.name}" changed while the archive was being written: it had ${this.source.size} bytes and only ${this.length} could be read, so the archive was not finished.`, "changed");
    }
    const crc = this.crc.digest();
    if (this.source.crc32 !== undefined && crc !== this.source.crc32) {
      throw new ArchiveError(`"${this.source.name}" no longer matches the checksum recorded for it, so the archive was not finished. Its stored copy may be damaged.`, "damaged");
    }
    return crc;
  }
}

/** What one entry's bytes arrive through: checked as they are read, and deflated when the entry is. */
interface Body {
  /** The next piece of the entry as it goes into the archive; `done` when the entry is complete. */
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** Stops everything behind this entry and closes its source. Safe to call twice, and while a read is waiting (that read then ends). */
  close(reason?: unknown): Promise<void>;
}

function openStored(source: ArchiveSource, check: EntryCheck): Body {
  const reader = source.open().getReader();
  return {
    async read() {
      const next = await reader.read();
      if (!next.done) check.push(next.value);
      return next;
    },
    close: (reason) => reader.cancel(reason).catch(() => undefined),
  };
}

/**
 * The source's bytes through a raw-deflate compressor. A pump takes one chunk at a time from the source into the
 * compressor, and only while `read()` is waiting for output: a consumer that stops pulling stops the pump, so the
 * source is never read further ahead than the compressor needs, however much Node's own queue would accept.
 */
function openDeflated(source: ArchiveSource, check: EntryCheck): Body {
  const compression = new CompressionStream("deflate-raw");
  const writer = compression.writable.getWriter();
  const output = compression.readable.getReader();
  const raw = source.open().getReader();
  let wanted = false;
  let stopped = false;
  let wake: (() => void) | undefined;
  let failure: unknown;
  let closing: Promise<void> | undefined;

  const poke = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const pumping = (async () => {
    try {
      for (;;) {
        if (!wanted && !stopped) await new Promise<void>((resolve) => { wake = resolve; });
        if (stopped) return;
        const next = await raw.read();
        if (stopped) return;
        if (next.done) break;
        // The compressor works on its own thread in Node: take the CRC-32 while it deflates this chunk, not before.
        // (A chunk is ordinary memory; a source that hands out a view of shared memory is refused by the compressor itself.)
        const written = writer.write(next.value as Uint8Array<ArrayBuffer>);
        written.catch(() => undefined);
        check.push(next.value);
        await written;
      }
      await writer.close();
    } catch (error) {
      // The source failed, or it was not what it announced. The consumer's read ends with the compressor, and then reports this.
      failure ??= error;
      await writer.abort(error).catch(() => undefined);
    }
  })();

  return {
    async read() {
      wanted = true;
      poke();
      try {
        return await output.read();
      } catch (error) {
        throw failure ?? error;
      } finally {
        wanted = false;
      }
    },
    close(reason) {
      closing ??= (async () => {
        stopped = true;
        poke();
        await Promise.allSettled([writer.abort(reason), output.cancel(reason), raw.cancel(reason)]);
        await pumping;
      })();
      return closing;
    },
  };
}

/** What the generator and the stream wrapper share: why the write is being stopped, and what to wake to make it stop. */
interface Run {
  /** Set before anything that could wake the generator, so it finds the reason when it wakes. */
  halted: unknown;
  /** The entry being read right now. */
  active: Body | undefined;
}

async function* produce(entries: readonly PreparedEntry[], options: WriteArchiveOptions, run: Run): AsyncGenerator<Uint8Array, ArchiveSummary> {
  const force = options.forceZip64 === true;
  const out = new Coalescer();
  const records: ArchiveEntryRecord[] = [];
  const reports: ArchiveEntryReport[] = [];
  let produced = 0;
  let readBytes = 0;
  let reportedBytes = 0;
  let current = 0;

  const alive = (): void => {
    if (run.halted !== undefined) throw run.halted;
  };
  const emit = (bytes: Uint8Array): Uint8Array[] => {
    produced += bytes.length;
    return out.add(bytes);
  };
  const report = (): void => {
    reportedBytes = readBytes;
    options.onProgress?.({ entry: current, name: entries[current]?.source.name ?? "", entriesDone: records.length, readBytes, writtenBytes: produced });
  };

  for (const [position, prepared] of entries.entries()) {
    current = position;
    alive();
    const { source } = prepared;
    const headerOffset = produced;
    const base = {
      name: source.name,
      modified: source.modified,
      method: prepared.stored ? 0 : 8,
      descriptor: !prepared.stored,
      wideSizes: prepared.wide,
      size: source.size,
      headerOffset,
      wideOffset: force || headerOffset >= SATURATED_32,
    } as const;
    // A stored entry's CRC and sizes are in its header, so they are what the header says: the data must prove them.
    const header = encodeLocalHeader({ ...base, crc32: prepared.stored ? (source.crc32 ?? 0) : 0, compressedSize: prepared.stored ? source.size : 0 });
    for (const chunk of emit(header)) yield chunk;
    report();

    const check = new EntryCheck(source, (bytes) => {
      readBytes += bytes;
      if (readBytes - reportedBytes >= PROGRESS_STEP_BYTES) report();
    });
    const body = prepared.stored ? openStored(source, check) : openDeflated(source, check);
    run.active = body;
    let compressedSize = 0;
    try {
      for (;;) {
        const next = await body.read();
        alive();
        if (next.done) break;
        if (next.value.length === 0) continue;
        compressedSize += next.value.length;
        if (!prepared.wide && compressedSize >= SATURATED_32) {
          throw new ArchiveError(`"${source.name}" packed to more than a classic archive entry can hold, so the archive was not finished.`, "too-large");
        }
        for (const chunk of emit(next.value)) yield chunk;
      }
      const crc = check.finish();
      const record: ArchiveEntryRecord = { ...base, crc32: crc, compressedSize };
      records.push(record);
      reports.push({ name: source.name, size: source.size, compressedSize, crc32: crc, method: record.method, headerOffset, zip64: record.wideSizes || record.wideOffset });
      if (record.descriptor) {
        for (const chunk of emit(encodeDataDescriptor(record))) yield chunk;
      }
    } finally {
      run.active = undefined;
      await body.close(run.halted);
    }
    report();
  }

  const directoryOffset = produced;
  for (const record of records) {
    for (const chunk of emit(encodeCentralRecord(record))) yield chunk;
  }
  const directory: ArchiveDirectory = { entries: records.length, offset: directoryOffset, size: produced - directoryOffset, forceZip64: force };
  for (const chunk of emit(encodeEndRecords(directory))) yield chunk;
  current = Math.max(entries.length - 1, 0);
  report();
  for (const chunk of out.flush()) yield chunk;
  return {
    entries: reports,
    bytes: produced,
    originalBytes: reports.reduce((total, entry) => total + entry.size, 0),
    zip64: needsZip64End(directory) || reports.some((entry) => entry.zip64),
  };
}

/**
 * The archive for these sources, in order, as a byte stream, plus its summary. Pull-based: one entry's slice is in
 * memory at a time and a consumer that stops pulling stops the reading. `summary` settles when the last byte has been
 * produced, and rejects with the same error the stream fails with; it never raises an unhandled rejection on its own.
 *
 * A name that is unsafe or used twice, or a size or CRC that is not a number it can write, is refused here, before
 * anything is read. Everything that goes wrong while reading (a source that changed, a CRC that no longer matches, a
 * cancel) fails the stream and the summary instead.
 */
export function writeArchive(sources: readonly ArchiveSource[], options: WriteArchiveOptions = {}): { readonly stream: ReadableStream<Uint8Array>; readonly summary: Promise<ArchiveSummary> } {
  const entries = prepare(sources, options);
  const run: Run = { halted: undefined, active: undefined };
  const iterator = produce(entries, options, run);
  const summary = Promise.withResolvers<ArchiveSummary>();
  summary.promise.catch(() => undefined);
  const { signal } = options;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let teardown: Promise<void> = Promise.resolve();

  /** Nothing more will be produced: tell everyone, and close whatever is open behind the writer. */
  const stop = (error: unknown): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    run.halted ??= error;
    summary.reject(error);
    streamController?.error(error);
    // The generator may be waiting on a source (wake it through the entry's body) or sitting at a `yield` (throw into it).
    teardown = Promise.all([run.active?.close(error), iterator.throw(error).catch(() => undefined)]).then(() => undefined);
  };
  const onAbort = (): void => stop(new ArchiveError("The archive was cancelled.", "aborted"));

  // One chunk is made ahead of the reader (the default queue size): the next one is being packed while the last is written.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      if (settled) return;
      try {
        const next = await iterator.next();
        if (settled) return;
        if (next.done) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          summary.resolve(next.value);
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        stop(error);
      }
    },
    cancel() {
      stop(new ArchiveError("The archive was cancelled.", "aborted"));
      return teardown;
    },
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { stream, summary: summary.promise };
}

// ---------------------------------------------------------------------------------------------------------------------
// The manifest and the checksums
// ---------------------------------------------------------------------------------------------------------------------

export interface ManifestOperation {
  readonly id: string;
  readonly deviceId: string;
  readonly deviceLabel?: string;
  readonly protocol: string;
  readonly action: string;
  readonly target?: string;
  readonly command?: string;
  /** Milliseconds since the epoch; the manifest writes it as an ISO time. */
  readonly startedAt?: number;
  readonly set?: string;
  readonly partitions?: BackupScope;
}

export interface ManifestFile {
  /** What the browser called it. */
  readonly name: string;
  /** Its name inside the archive's folder. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: string;
  readonly source: string;
  /** Milliseconds since the epoch; the manifest writes it as an ISO time. */
  readonly createdAt: number;
  readonly artifactId?: string;
  readonly operation?: ManifestOperation;
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/** Which operation made a file, as the manifest records it (and as the page announces it to the server). */
export function operationInfo(provenance: ArtifactProvenance): ManifestOperation {
  return {
    id: provenance.operationId,
    deviceId: provenance.deviceId,
    ...(provenance.label ? { deviceLabel: provenance.label } : {}),
    protocol: provenance.protocol,
    action: provenance.action,
    ...(provenance.target ? { target: provenance.target } : {}),
    ...(provenance.command ? { command: provenance.command } : {}),
    ...(provenance.startedAt === undefined ? {} : { startedAt: provenance.startedAt }),
    ...(provenance.set ? { set: provenance.set } : {}),
    ...(provenance.scope ? { partitions: { chosen: [...provenance.scope.chosen], all: [...provenance.scope.all] } } : {}),
  };
}

function manifestOperation(operation: ManifestOperation): Record<string, unknown> {
  return {
    id: operation.id,
    deviceId: operation.deviceId,
    ...(operation.deviceLabel ? { deviceLabel: operation.deviceLabel } : {}),
    protocol: operation.protocol,
    action: operation.action,
    ...(operation.target ? { target: operation.target } : {}),
    ...(operation.command ? { command: operation.command } : {}),
    ...(operation.startedAt === undefined ? {} : { startedAt: isoTime(operation.startedAt) }),
    ...(operation.set ? { set: operation.set } : {}),
    ...(operation.partitions ? { partitions: { chosen: [...operation.partitions.chosen], all: [...operation.partitions.all] } } : {}),
  };
}

function manifestFile(file: ManifestFile): Record<string, unknown> {
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    kind: file.kind,
    source: file.source,
    createdAt: isoTime(file.createdAt),
    ...(file.artifactId ? { artifactId: file.artifactId } : {}),
    ...(file.operation ? { operation: manifestOperation(file.operation) } : {}),
  };
}

/**
 * Which partitions each backup chose, and every partition the device listed at the time: one entry per operation that
 * said, in the order they first appear. A backup that took fewer than the device listed is `partial`.
 */
function backupRecords(files: readonly ManifestFile[]): Record<string, unknown>[] {
  const records = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    const scope = file.operation?.partitions;
    if (!file.operation || !scope || records.has(file.operation.id)) continue;
    records.set(file.operation.id, { operationId: file.operation.id, kind: scope.chosen.length < scope.all.length ? "partial" : "full", chosen: [...scope.chosen], all: [...scope.all] });
  }
  return [...records.values()];
}

/**
 * `manifest.json`: what is in the archive, where each file came from and what it should hash to. `extra` adds the
 * vault's own facts (who saved it, when) after the rest; it can add keys but never replace one the manifest has.
 */
export function buildArchiveManifest(input: {
  label: string;
  sessionId: string;
  createdAt: number;
  files: readonly ManifestFile[];
  extra?: Readonly<Record<string, unknown>>;
}): { json: Record<string, unknown>; bytes: Uint8Array } {
  const backups = backupRecords(input.files);
  const json: Record<string, unknown> = {
    format: MANIFEST_FORMAT,
    createdAt: isoTime(input.createdAt),
    label: input.label,
    sessionId: input.sessionId,
    totalBytes: input.files.reduce((total, file) => total + file.size, 0),
    compression: "deflate",
    ...(backups.length > 0 ? { backups } : {}),
    files: input.files.map(manifestFile),
  };
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (key in json) throw new TypeError(`The manifest already has a "${key}" entry.`);
    json[key] = value;
  }
  return { json, bytes: textEncoder.encode(`${JSON.stringify(json, null, 2)}\n`) };
}

/**
 * `SHA256SUMS` then `manifest.json`, both stored: `sha256sum -c SHA256SUMS` works after extracting, and the last line
 * vouches for the manifest itself.
 */
export function metadataSources(options: {
  folder: string;
  files: readonly { path: string; sha256: string }[];
  manifest: Uint8Array;
  modified: number;
}): ArchiveSource[] {
  const sums = [...options.files.map((file) => `${file.sha256}  ${file.path}\n`), `${bytesToHex(sha256(options.manifest))}  ${MANIFEST_NAME}\n`].join("");
  return [
    bytesSource(`${options.folder}/${SUMS_NAME}`, textEncoder.encode(sums), options.modified),
    bytesSource(`${options.folder}/${MANIFEST_NAME}`, options.manifest, options.modified),
  ];
}
