/**
 * A small ZIP reader over a browser Blob, enough to read an Android update
 * package (`fastboot update`): the central directory, ZIP64 sizes, and stored
 * or deflated entries.
 *
 * A stored entry is returned as a slice of the archive, so an image of any size
 * is read in place without being copied. A deflated entry is inflated into a
 * Blob (checked against its CRC-32 and size), which the browser pages to disk;
 * it is bounded because a multi-gigabyte inflate does not belong in one tab.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const MAX_ENTRIES = 100_000;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
/** The largest entry Cody will inflate into browser memory; stored entries have no limit. */
export const MAX_INFLATED_BYTES = 2 * 1024 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly encrypted: boolean;
  /** Offset of the entry's local header. */
  readonly headerOffset: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  find(name: string): ZipEntry | undefined;
  /** The entry's bytes. Stored entries are slices of the archive. */
  open(entry: ZipEntry): Promise<Blob>;
  text(entry: ZipEntry): Promise<string>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of `bytes`, continuing from `crc`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let value = ~crc >>> 0;
  for (let index = 0; index < bytes.length; index += 1) value = CRC_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  return ~value >>> 0;
}

function safe(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ZipError(`The archive's ${label} is too large to address.`);
  return number;
}

async function readRange(archive: Blob, start: number, length: number, what: string): Promise<DataView> {
  if (start < 0 || start + length > archive.size) throw new ZipError(`The archive is truncated: ${what} lies outside the file.`);
  return new DataView(await archive.slice(start, start + length).arrayBuffer());
}

interface Directory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

async function locateDirectory(archive: Blob): Promise<Directory> {
  const tailLength = Math.min(archive.size, EOCD_BYTES + MAX_COMMENT_BYTES);
  const tailStart = archive.size - tailLength;
  const tail = await readRange(archive, tailStart, tailLength, "the end-of-archive record");
  for (let at = tailLength - EOCD_BYTES; at >= 0; at -= 1) {
    if (tail.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.getUint16(at + 20, true);
    if (at + EOCD_BYTES + commentLength > tailLength) continue;
    const disk = tail.getUint16(at + 4, true);
    const directoryDisk = tail.getUint16(at + 6, true);
    let entries = tail.getUint16(at + 10, true);
    let size = tail.getUint32(at + 12, true);
    let offset = tail.getUint32(at + 16, true);
    const eocdOffset = tailStart + at;
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locator = await readRange(archive, eocdOffset - 20, 20, "the ZIP64 locator").catch(() => undefined);
      if (!locator || locator.getUint32(0, true) !== EOCD64_LOCATOR_SIGNATURE) throw new ZipError("The archive needs ZIP64 but has no ZIP64 end-of-archive locator.");
      const record = await readRange(archive, safe(locator.getBigUint64(8, true), "ZIP64 record offset"), 56, "the ZIP64 end-of-archive record");
      if (record.getUint32(0, true) !== EOCD64_SIGNATURE) throw new ZipError("The ZIP64 end-of-archive record is missing.");
      if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) throw new ZipError("Multi-disk archives are not supported.");
      entries = safe(record.getBigUint64(32, true), "entry count");
      size = safe(record.getBigUint64(40, true), "directory size");
      offset = safe(record.getBigUint64(48, true), "directory offset");
    } else if (disk !== 0 || directoryDisk !== 0) throw new ZipError("Multi-disk archives are not supported.");
    if (offset + size > eocdOffset) continue;
    return { offset, size, entries };
  }
  throw new ZipError("This is not a ZIP archive: no end-of-archive record was found.");
}

/** Reads ZIP64's extended-information extra field, which carries only the fields the header set to all ones. */
function zip64Fields(extra: DataView, wants: { size: boolean; compressedSize: boolean; headerOffset: boolean }): { size?: number; compressedSize?: number; headerOffset?: number } {
  const result: { size?: number; compressedSize?: number; headerOffset?: number } = {};
  for (let at = 0; at + 4 <= extra.byteLength; ) {
    const id = extra.getUint16(at, true);
    const length = extra.getUint16(at + 2, true);
    if (id === 0x0001) {
      let cursor = at + 4;
      const take = (label: string): number => {
        if (cursor + 8 > at + 4 + length) throw new ZipError(`The ZIP64 extra field is missing the entry's ${label}.`);
        const value = safe(extra.getBigUint64(cursor, true), label);
        cursor += 8;
        return value;
      };
      if (wants.size) result.size = take("size");
      if (wants.compressedSize) result.compressedSize = take("compressed size");
      if (wants.headerOffset) result.headerOffset = take("header offset");
    }
    at += 4 + length;
  }
  return result;
}

async function readEntries(archive: Blob, directory: Directory): Promise<ZipEntry[]> {
  if (directory.entries > MAX_ENTRIES || directory.size > MAX_DIRECTORY_BYTES) throw new ZipError("The archive's directory is larger than Cody will read.");
  const bytes = await archive.slice(directory.offset, directory.offset + directory.size).arrayBuffer();
  const view = new DataView(bytes);
  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < directory.entries; index += 1) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new ZipError("The archive's directory is corrupt.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    let compressedSize = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let headerOffset = view.getUint32(at + 42, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > view.byteLength) throw new ZipError("The archive's directory is corrupt.");
    const name = decoder.decode(new Uint8Array(bytes, at + 46, nameLength));
    const wide = zip64Fields(new DataView(bytes, at + 46 + nameLength, extraLength), { size: size === 0xffffffff, compressedSize: compressedSize === 0xffffffff, headerOffset: headerOffset === 0xffffffff });
    size = wide.size ?? size;
    compressedSize = wide.compressedSize ?? compressedSize;
    headerOffset = wide.headerOffset ?? headerOffset;
    entries.push({ name, method, compressedSize, size, crc32: crc, encrypted: (flags & 1) !== 0, headerOffset });
    at = end;
  }
  return entries;
}

async function dataStart(archive: Blob, entry: ZipEntry): Promise<number> {
  const header = await readRange(archive, entry.headerOffset, 30, `the header of ${entry.name}`);
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError(`The local header of ${entry.name} is missing.`);
  return entry.headerOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
}

async function inflate(compressed: Blob, entry: ZipEntry): Promise<Blob> {
  let crc = 0;
  let produced = 0;
  const check = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      crc = crc32(chunk, crc);
      produced += chunk.length;
      if (produced > entry.size) throw new ZipError(`${entry.name} inflates to more than its recorded ${entry.size} bytes.`);
      controller.enqueue(chunk);
    },
  });
  const inflated = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw")).pipeThrough(check);
  const blob = await new Response(inflated).blob();
  if (produced !== entry.size) throw new ZipError(`${entry.name} inflated to ${produced} bytes; the archive records ${entry.size}.`);
  if (crc !== entry.crc32) throw new ZipError(`${entry.name} failed its CRC-32 check after inflating: the archive is damaged.`);
  return blob;
}

export async function openZip(archive: Blob): Promise<ZipArchive> {
  if (archive.size < EOCD_BYTES) throw new ZipError("This is not a ZIP archive: it is too short.");
  const directory = await locateDirectory(archive);
  const entries = await readEntries(archive, directory);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const open = async (entry: ZipEntry): Promise<Blob> => {
    if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted, which Cody cannot read.`);
    const start = await dataStart(archive, entry);
    if (start + entry.compressedSize > archive.size) throw new ZipError(`${entry.name} runs past the end of the archive.`);
    const compressed = archive.slice(start, start + entry.compressedSize);
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new ZipError(`${entry.name} is stored but its sizes disagree.`);
      return compressed;
    }
    if (entry.method !== 8) throw new ZipError(`${entry.name} uses ZIP compression method ${entry.method}; only stored and deflate are supported.`);
    if (entry.size > MAX_INFLATED_BYTES) {
      throw new ZipError(`${entry.name} inflates to ${entry.size} bytes, over the ${MAX_INFLATED_BYTES}-byte browser limit. Re-pack the archive with that file stored (uncompressed) and Cody reads it in place.`);
    }
    return inflate(compressed, entry);
  };
  return {
    entries,
    find: (name) => byName.get(name),
    open,
    text: async (entry) => (await open(entry)).text(),
  };
}
