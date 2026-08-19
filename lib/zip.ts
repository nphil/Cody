import { createReadStream } from "fs";
import { createDeflateRaw, crc32 } from "zlib";

/**
 * Minimal streaming ZIP writer (no dependencies).
 *
 * Entries are deflated one at a time with node:zlib and emitted as
 * local file header + compressed data + data descriptor (general purpose
 * flag bit 3, so nothing has to be buffered to learn sizes/CRC up front),
 * followed by the central directory and end-of-central-directory record.
 *
 * Plain ZIP only — no zip64. Archives whose output or any entry's
 * uncompressed contents exceed 2 GiB raise ZipSizeLimitError.
 */

/** Hard cap for archive output and per-entry uncompressed size (2 GiB). */
export const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const MAX_ENTRY_COUNT = 0xffff; // plain (non-zip64) central directory limit

export class ZipSizeLimitError extends Error {
  constructor(message = "Archive exceeds the 2 GiB zip limit") {
    super(message);
    this.name = "ZipSizeLimitError";
  }
}

export interface ZipEntry {
  /** Archive-relative path using forward slashes. Directory entries end with "/". */
  name: string;
  /** File on disk whose bytes are streamed into the entry. Files only. */
  filePath?: string;
  /** In-memory contents. Files only; ignored when filePath is set. */
  data?: Uint8Array;
  /** Entry modification time; defaults to now. */
  mtime?: Date;
}

interface CentralRecord {
  nameBytes: Buffer;
  isDir: boolean;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED; // UNIX host

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(date.getFullYear(), 1980);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosTime, dosDate };
}

function localHeader(record: CentralRecord): Buffer {
  const buf = Buffer.allocUnsafe(30 + record.nameBytes.length);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(VERSION_NEEDED, 4);
  buf.writeUInt16LE(record.flags, 6);
  buf.writeUInt16LE(record.method, 8);
  buf.writeUInt16LE(record.dosTime, 10);
  buf.writeUInt16LE(record.dosDate, 12);
  // With the descriptor flag set the CRC/size fields are written as zero here
  // and delivered after the data; directories are final (all zero) already.
  buf.writeUInt32LE(0, 14);
  buf.writeUInt32LE(0, 18);
  buf.writeUInt32LE(0, 22);
  buf.writeUInt16LE(record.nameBytes.length, 26);
  buf.writeUInt16LE(0, 28);
  record.nameBytes.copy(buf, 30);
  return buf;
}

function dataDescriptor(record: CentralRecord): Buffer {
  const buf = Buffer.allocUnsafe(16);
  buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
  buf.writeUInt32LE(record.crc, 4);
  buf.writeUInt32LE(record.compressedSize, 8);
  buf.writeUInt32LE(record.uncompressedSize, 12);
  return buf;
}

function centralHeader(record: CentralRecord): Buffer {
  const buf = Buffer.allocUnsafe(46 + record.nameBytes.length);
  buf.writeUInt32LE(SIG_CENTRAL, 0);
  buf.writeUInt16LE(VERSION_MADE_BY, 4);
  buf.writeUInt16LE(VERSION_NEEDED, 6);
  buf.writeUInt16LE(record.flags, 8);
  buf.writeUInt16LE(record.method, 10);
  buf.writeUInt16LE(record.dosTime, 12);
  buf.writeUInt16LE(record.dosDate, 14);
  buf.writeUInt32LE(record.crc, 16);
  buf.writeUInt32LE(record.compressedSize, 20);
  buf.writeUInt32LE(record.uncompressedSize, 24);
  buf.writeUInt16LE(record.nameBytes.length, 28);
  buf.writeUInt16LE(0, 30); // extra
  buf.writeUInt16LE(0, 32); // comment
  buf.writeUInt16LE(0, 34); // disk number start
  buf.writeUInt16LE(0, 36); // internal attributes
  // External attributes: unix mode in the high word, DOS directory bit low.
  const mode = record.isDir ? 0o40755 : 0o100644;
  buf.writeUInt32LE(((mode << 16) | (record.isDir ? 0x10 : 0)) >>> 0, 38);
  buf.writeUInt32LE(record.localOffset, 42);
  record.nameBytes.copy(buf, 46);
  return buf;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.allocUnsafe(22);
  buf.writeUInt32LE(SIG_EOCD, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

/** Deflate an entry's bytes, updating CRC/size totals on the record. */
async function* deflateEntry(
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
  record: CentralRecord,
): AsyncGenerator<Buffer> {
  const deflate = createDeflateRaw();
  const feed = (async () => {
    for await (const chunk of source) {
      record.uncompressedSize += chunk.length;
      if (record.uncompressedSize > ZIP_MAX_BYTES) {
        throw new ZipSizeLimitError();
      }
      record.crc = crc32(chunk, record.crc) >>> 0;
      if (!deflate.write(chunk)) {
        await new Promise<void>((resolve) => deflate.once("drain", resolve));
      }
    }
    deflate.end();
  })();
  feed.catch((error) => deflate.destroy(error instanceof Error ? error : new Error(String(error))));

  for await (const chunk of deflate as AsyncIterable<Buffer>) {
    record.compressedSize += chunk.length;
    yield chunk;
  }
  await feed;
}

/**
 * Produce the archive as a chunk sequence. Entry file bytes are read lazily,
 * so memory use stays bounded by stream buffers, not archive size.
 */
export async function* generateZip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  let offset = 0;
  const budget = (chunk: Buffer): Buffer => {
    offset += chunk.length;
    if (offset > ZIP_MAX_BYTES) throw new ZipSizeLimitError();
    return chunk;
  };

  for await (const entry of entries) {
    if (central.length >= MAX_ENTRY_COUNT) {
      throw new ZipSizeLimitError("Archive exceeds the zip entry limit");
    }
    const isDir = entry.name.endsWith("/");
    const { dosTime, dosDate } = toDosDateTime(entry.mtime ?? new Date());
    const record: CentralRecord = {
      nameBytes: Buffer.from(entry.name, "utf8"),
      isDir,
      flags: isDir ? FLAG_UTF8 : FLAG_UTF8 | FLAG_DESCRIPTOR,
      method: isDir ? METHOD_STORED : METHOD_DEFLATE,
      dosTime,
      dosDate,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      localOffset: offset,
    };
    central.push(record);
    yield budget(localHeader(record));
    if (isDir) continue;

    const source = entry.filePath
      ? (createReadStream(entry.filePath) as AsyncIterable<Buffer>)
      : [Buffer.from(entry.data ?? new Uint8Array(0))];
    for await (const chunk of deflateEntry(source, record)) {
      yield budget(chunk);
    }
    yield budget(dataDescriptor(record));
  }

  const cdOffset = offset;
  for (const record of central) {
    yield budget(centralHeader(record));
  }
  yield budget(endRecord(central.length, offset - cdOffset, cdOffset));
}

/** Web ReadableStream over generateZip, suitable as a Response body.
 *  Hand-rolled pull wrapper: TypeScript's DOM lib does not yet declare
 *  ReadableStream.from, and this also propagates cancellation into the
 *  generator so an aborted download stops reading the tree. */
export function createZipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
): ReadableStream<Uint8Array> {
  const iterator = generateZip(entries)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}
