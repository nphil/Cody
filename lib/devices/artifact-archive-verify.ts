/**
 * An independent re-read of a finished backup archive.
 *
 * The vault only calls an archive a finished save after this has read every byte of it back from the disk and
 * everything agreed. It shares nothing with the module that wrote the archive (./artifact-archive.ts): it has its own
 * parser for the zip records, uses `node:zlib` to inflate and Node's own CRC-32 and SHA-256, so a fault in the writer
 * cannot also hide here.
 *
 * What it demands of an archive: the end records and the central directory are intact (ZIP64 aware, the directory is
 * bounded in size); every local header agrees with its directory record; entries follow one another with no stray
 * bytes between them; every data descriptor agrees with the directory; every entry unpacks to exactly the CRC-32 and
 * size recorded; every device file hashes to the SHA-256 the browser announced; the stored `SHA256SUMS` lists exactly
 * what was computed; and the archive holds the expected entries and no others. The first discrepancy is thrown as a
 * plain-English error that names the file.
 *
 * Node only (it reads the file with ranged reads, so a multi-gigabyte archive costs no memory).
 */

import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { MANIFEST_NAME, SUMS_NAME } from "./artifact-names";

const MiB = 1024 * 1024;

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;
const SIGNATURE_ZIP64_END = 0x06064b50;
const SIGNATURE_ZIP64_LOCATOR = 0x07064b50;
const SIGNATURE_DESCRIPTOR = 0x08074b50;
const ZIP64_EXTRA = 0x0001;
const SATURATED_16 = 0xffff;
const SATURATED_32 = 0xffffffff;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_RECORD_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_BYTES = 56;
const MAX_COMMENT_BYTES = 0xffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;

/** The directory of an archive this vault wrote is a few hundred KB; this is far above that and far below a memory problem. */
const MAX_DIRECTORY_BYTES = 16 * MiB;
/** `manifest.json` and `SHA256SUMS` are read whole. */
const MAX_TEXT_ENTRY_BYTES = 16 * MiB;
const READ_BYTES = MiB;
/** A data descriptor is 12 to 24 bytes: crc + two sizes of 4 or 8 bytes, with or without the signature. */
const DESCRIPTOR_LENGTHS: ReadonlySet<number> = new Set([12, 16, 20, 24]);

export interface ExpectedArchiveFile {
  /** The file's name inside the archive's folder. */
  readonly path: string;
  readonly size: number;
  /** The SHA-256 the browser announced for it, lowercase hex. */
  readonly sha256: string;
}

export interface ExpectedArchive {
  /** The one folder every entry lives in: the archive's file name without `.zip`. */
  readonly folder: string;
  /** The device files, in the order `SHA256SUMS` lists them (the order they were saved in). The archive must hold exactly these, plus `SHA256SUMS` and `manifest.json`, in any order on the disk. */
  readonly files: readonly ExpectedArchiveFile[];
  /** When given, the stored `manifest.json` must hash to this (the bytes the server meant to write). */
  readonly manifestSha256?: string;
}

export interface ArchiveCheckOptions {
  readonly signal?: AbortSignal;
}

export interface ArchiveCheckResult {
  /** The archive as it is on the disk. */
  readonly archiveBytes: number;
  /** Device files inside it (not counting `SHA256SUMS` and `manifest.json`). */
  readonly files: number;
  /** Those files before packing. */
  readonly originalBytes: number;
  /** SHA-256 of the stored `manifest.json`, which `SHA256SUMS` lists. */
  readonly manifestSha256: string;
}

/** `damaged`: the archive is not what it should be. `aborted`: the caller stopped the check. A failure of the disk itself is the plain error Node threw. */
export class ArchiveCheckError extends Error {
  readonly code: "damaged" | "aborted";

  constructor(code: "damaged" | "aborted", message: string) {
    super(message);
    this.name = "ArchiveCheckError";
    this.code = code;
  }
}

function damaged(message: string): ArchiveCheckError {
  return new ArchiveCheckError("damaged", message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ArchiveCheckError("aborted", "Checking the archive was stopped.");
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the records
// ---------------------------------------------------------------------------------------------------------------------

interface Entry {
  /** The path inside the archive, as stored. */
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

interface Layout {
  readonly entries: readonly Entry[];
  /** Where the central directory starts: the local entries must end exactly here. */
  readonly directoryOffset: number;
}

/** A 64-bit field as a number; one beyond 2^53 cannot be a real size or offset. */
function wide(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged("The archive holds a size or an offset that no real file could have.");
  return Number(value);
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw damaged("The archive ends early: it may have been cut short.");
    filled += bytesRead;
  }
  return buffer;
}

/** The ZIP64 extra field's values, in the order the format puts them, for the 32-bit fields that were saturated. */
function zip64Values(extra: Buffer, wanted: readonly ("size" | "compressed" | "offset")[]): Partial<Record<"size" | "compressed" | "offset", number>> {
  const found: Partial<Record<"size" | "compressed" | "offset", number>> = {};
  for (let position = 0; position + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    const start = position + 4;
    if (start + length > extra.length) throw damaged("An entry's extra field runs past its own record.");
    if (id === ZIP64_EXTRA) {
      if (length < wanted.length * 8) throw damaged("An entry's ZIP64 field is too short for the sizes it must carry.");
      wanted.forEach((key, index) => {
        found[key] = wide(extra, start + index * 8);
      });
      return found;
    }
    position = start + length;
  }
  if (wanted.length > 0) throw damaged("An entry says its size is too large for a plain zip but has no ZIP64 field.");
  return found;
}

function entryName(bytes: Buffer, flags: number): string {
  return bytes.toString((flags & FLAG_UTF8) !== 0 ? "utf8" : "latin1");
}

/** The end records and the central directory, checked as a whole before anything inside is read. */
async function readLayout(handle: FileHandle, fileSize: number): Promise<Layout> {
  if (fileSize < END_RECORD_BYTES) throw damaged("The file is too small to be a zip archive.");
  const tailLength = Math.min(fileSize, END_RECORD_BYTES + MAX_COMMENT_BYTES + ZIP64_LOCATOR_BYTES);
  const tailStart = fileSize - tailLength;
  const tail = await readExactly(handle, tailStart, tailLength);

  // The end record is the last thing in the file. A comment may follow it (the vault writes none), so the right
  // signature is the one whose comment length reaches exactly to the end of the file.
  let end = -1;
  for (let at = tail.length - END_RECORD_BYTES; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== SIGNATURE_END) continue;
    if (at + END_RECORD_BYTES + tail.readUInt16LE(at + 20) === tail.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw damaged("The archive has no end record where one should be, so its directory cannot be found: it was cut short, or something was added after its end.");
  const endOffset = tailStart + end;
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) throw damaged("The archive is split over several disks, which this check does not read.");
  let entryCount = tail.readUInt16LE(end + 10);
  let directoryBytes = tail.readUInt32LE(end + 12);
  let directoryOffset = tail.readUInt32LE(end + 16);
  const saturated = entryCount === SATURATED_16 || directoryBytes === SATURATED_32 || directoryOffset === SATURATED_32;

  let directoryEnd = endOffset;
  if (end >= ZIP64_LOCATOR_BYTES && tail.readUInt32LE(end - ZIP64_LOCATOR_BYTES) === SIGNATURE_ZIP64_LOCATOR) {
    const locator = end - ZIP64_LOCATOR_BYTES;
    const locatorOffset = tailStart + locator;
    const recordOffset = wide(tail, locator + 8);
    if (tail.readUInt32LE(locator + 4) !== 0 || tail.readUInt32LE(locator + 16) !== 1) throw damaged("The archive is split over several disks, which this check does not read.");
    if (recordOffset + ZIP64_END_BYTES > locatorOffset) throw damaged("The archive's ZIP64 end record is not where its locator says.");
    const record = await readExactly(handle, recordOffset, ZIP64_END_BYTES);
    if (record.readUInt32LE(0) !== SIGNATURE_ZIP64_END) throw damaged("The archive's ZIP64 end record is missing or damaged.");
    if (recordOffset + 12 + wide(record, 4) !== locatorOffset) throw damaged("The archive's ZIP64 end record does not reach its locator.");
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw damaged("The archive is split over several disks, which this check does not read.");
    const wideCount = wide(record, 32);
    const wideBytes = wide(record, 40);
    const wideOffset = wide(record, 48);
    // The classic end record may hold the same numbers or saturated ones, never different ones.
    if ((entryCount !== SATURATED_16 && entryCount !== wideCount) || (directoryBytes !== SATURATED_32 && directoryBytes !== wideBytes) || (directoryOffset !== SATURATED_32 && directoryOffset !== wideOffset)) {
      throw damaged("The archive's two end records disagree about its directory.");
    }
    if (wide(record, 24) !== wideCount) throw damaged("The archive's ZIP64 end record counts the entries of this disk and of the archive differently.");
    entryCount = wideCount;
    directoryBytes = wideBytes;
    directoryOffset = wideOffset;
    directoryEnd = recordOffset;
  } else if (saturated) {
    throw damaged("The archive says its directory is too large for a plain zip but has no ZIP64 end record.");
  }

  if (directoryBytes > MAX_DIRECTORY_BYTES) throw damaged(`The archive's directory is ${directoryBytes} bytes, far larger than any save's.`);
  if (entryCount * CENTRAL_RECORD_BYTES > directoryBytes) throw damaged("The archive says it holds more entries than its directory has room for.");
  if (directoryOffset + directoryBytes !== directoryEnd) throw damaged("The archive's directory is not where its end record says, or has stray bytes after it.");

  const directory = await readExactly(handle, directoryOffset, directoryBytes);
  const entries: Entry[] = [];
  let position = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + CENTRAL_RECORD_BYTES > directory.length || directory.readUInt32LE(position) !== SIGNATURE_CENTRAL) throw damaged(`The archive's directory is damaged at entry ${index + 1}.`);
    const flags = directory.readUInt16LE(position + 8);
    const method = directory.readUInt16LE(position + 10);
    const crc = directory.readUInt32LE(position + 16);
    let compressedSize = directory.readUInt32LE(position + 20);
    let size = directory.readUInt32LE(position + 24);
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    let localOffset = directory.readUInt32LE(position + 42);
    const recordEnd = position + CENTRAL_RECORD_BYTES + nameLength + extraLength + commentLength;
    if (recordEnd > directory.length) throw damaged(`The archive's directory is damaged at entry ${index + 1}.`);
    const nameStart = position + CENTRAL_RECORD_BYTES;
    const name = entryName(directory.subarray(nameStart, nameStart + nameLength), flags);
    const wanted: ("size" | "compressed" | "offset")[] = [];
    if (size === SATURATED_32) wanted.push("size");
    if (compressedSize === SATURATED_32) wanted.push("compressed");
    if (localOffset === SATURATED_32) wanted.push("offset");
    if (wanted.length > 0) {
      const values = zip64Values(directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength), wanted);
      size = values.size ?? size;
      compressedSize = values.compressed ?? compressedSize;
      localOffset = values.offset ?? localOffset;
    }
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset });
    position = recordEnd;
  }
  if (position !== directory.length) throw damaged("The archive's directory has stray bytes after its last entry.");
  return { entries, directoryOffset };
}

interface LocalHeader {
  /** Where the entry's compressed bytes start. */
  readonly dataStart: number;
}

/** The entry's local header, checked against its directory record. `strict` is for a full check; reading one text entry needs only the position. */
async function readLocalHeader(handle: FileHandle, entry: Entry, label: string, strict: boolean): Promise<LocalHeader> {
  const fixed = await readExactly(handle, entry.localOffset, LOCAL_HEADER_BYTES);
  if (fixed.readUInt32LE(0) !== SIGNATURE_LOCAL) throw damaged(`"${label}" does not start where the archive's directory says it does.`);
  const flags = fixed.readUInt16LE(6);
  const method = fixed.readUInt16LE(8);
  const crc = fixed.readUInt32LE(14);
  let compressedSize = fixed.readUInt32LE(18);
  let size = fixed.readUInt32LE(22);
  const nameLength = fixed.readUInt16LE(26);
  const extraLength = fixed.readUInt16LE(28);
  const variable = await readExactly(handle, entry.localOffset + LOCAL_HEADER_BYTES, nameLength + extraLength);
  const dataStart = entry.localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  if (!strict) return { dataStart };

  if (entryName(variable.subarray(0, nameLength), flags) !== entry.name) throw damaged(`"${label}" is stored under a different name than the archive's directory gives it.`);
  if (flags !== entry.flags || method !== entry.method) throw damaged(`"${label}" is stored with different settings than the archive's directory records.`);
  const wanted: ("size" | "compressed")[] = [];
  if (size === SATURATED_32) wanted.push("size");
  if (compressedSize === SATURATED_32) wanted.push("compressed");
  if (wanted.length > 0) {
    const values = zip64Values(variable.subarray(nameLength), wanted);
    size = values.size ?? size;
    compressedSize = values.compressed ?? compressedSize;
  }
  // With a data descriptor the header may carry zeros (the vault's writer does, pointing a saturated classic field at a
  // ZIP64 field of zeros for a wide entry) or the real values; with none, the real ones.
  const descriptor = (flags & FLAG_DESCRIPTOR) !== 0;
  const agrees = (local: number, central: number): boolean => local === central || (descriptor && local === 0);
  if (!agrees(crc, entry.crc) || !agrees(compressedSize, entry.compressedSize) || !agrees(size, entry.size)) {
    throw damaged(`"${label}" has a header that disagrees with the archive's directory about its checksum or size.`);
  }
  return { dataStart };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading an entry's bytes
// ---------------------------------------------------------------------------------------------------------------------

interface Digest {
  readonly crc: number;
  readonly sha256: string;
  readonly bytes: number;
  /** Only for the two small text entries. */
  readonly text?: Buffer;
}

/** CRC-32, SHA-256 and length of what an entry unpacks to, without holding more than a slice of it. */
async function digestEntry(handle: FileHandle, entry: Entry, dataStart: number, label: string, keepText: boolean, signal: AbortSignal | undefined): Promise<Digest> {
  if (entry.method !== 0 && entry.method !== 8) throw damaged(`"${label}" is packed with a method this check does not know (${entry.method}).`);
  if ((entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) throw damaged(`"${label}" is password protected, which a backup never is.`);
  if (keepText && entry.size > MAX_TEXT_ENTRY_BYTES) throw damaged(`"${label}" is ${entry.size} bytes, far larger than it should be.`);
  const hash = createHash("sha256");
  let crc = 0;
  let bytes = 0;
  const parts: Buffer[] = [];
  const take = (chunk: Buffer): void => {
    bytes += chunk.length;
    // An entry that unpacks to more than it says is stopped at once rather than inflated to the end.
    if (bytes > entry.size) throw damaged(`"${label}" is damaged inside the archive: it unpacks to more than the ${entry.size} bytes the archive records.`);
    hash.update(chunk);
    crc = crc32(chunk, crc);
    if (keepText) parts.push(Buffer.from(chunk));
  };

  const packed = async function* (): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < entry.compressedSize; offset += READ_BYTES) {
      throwIfAborted(signal);
      yield await readExactly(handle, dataStart + offset, Math.min(READ_BYTES, entry.compressedSize - offset));
    }
  };

  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw damaged(`"${label}" is stored without packing but its two sizes differ.`);
    for await (const chunk of packed()) take(chunk);
  } else {
    const inflate = createInflateRaw({ chunkSize: READ_BYTES });
    try {
      await pipeline(
        packed,
        inflate,
        async (source: AsyncIterable<Buffer>) => {
          for await (const chunk of source) take(chunk);
        },
        ...(signal ? [{ signal }] : []),
      );
    } catch (error) {
      if (error instanceof ArchiveCheckError) throw error;
      if (signal?.aborted) throw new ArchiveCheckError("aborted", "Checking the archive was stopped.");
      const code = (error as NodeJS.ErrnoException).code;
      // The deflate stream ended with packed bytes still to come: trailing bytes in the entry.
      if (code === "ERR_STREAM_PREMATURE_CLOSE" && inflate.bytesWritten < entry.compressedSize) throw damaged(`"${label}" holds extra bytes after its packed data.`);
      if (typeof code === "string" && code.startsWith("Z_")) throw damaged(`"${label}" is damaged inside the archive: it cannot be unpacked (${(error as Error).message}).`);
      throw error;
    }
    if (inflate.bytesWritten !== entry.compressedSize) throw damaged(`"${label}" holds extra bytes after its packed data.`);
  }
  return { crc, sha256: hash.digest("hex"), bytes, ...(keepText ? { text: Buffer.concat(parts) } : {}) };
}

function hex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** An entry name for a message: without the folder, free of control characters, never absurdly long. */
function shown(name: string, folder?: string): string {
  const inside = folder !== undefined && name.startsWith(`${folder}/`) ? name.slice(folder.length + 1) : name;
  const clean = inside.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

// ---------------------------------------------------------------------------------------------------------------------
// The two public checks
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Re-reads the whole archive and throws a plain-English error naming the first discrepancy. Resolves only when the
 * archive is exactly what `expected` says: every entry present and none extra, every checksum and size equal in the
 * directory, the local header, the data descriptor and the bytes themselves, and `SHA256SUMS` correct.
 */
export async function verifyArchiveFile(file: string, expected: ExpectedArchive, options: ArchiveCheckOptions = {}): Promise<ArchiveCheckResult> {
  const { signal } = options;
  throwIfAborted(signal);
  const handle = await open(file, "r");
  try {
    const { size: archiveBytes } = await handle.stat();
    const layout = await readLayout(handle, archiveBytes);

    // Which entries, before any bytes are read: a missing or extra one is the cheapest thing to find.
    const prefix = `${expected.folder}/`;
    const wanted = [...expected.files.map((candidate) => `${prefix}${candidate.path}`), `${prefix}${SUMS_NAME}`, `${prefix}${MANIFEST_NAME}`];
    const byName = new Map<string, Entry>();
    for (const entry of layout.entries) {
      if (byName.has(entry.name)) throw damaged(`The archive lists "${shown(entry.name, expected.folder)}" twice.`);
      byName.set(entry.name, entry);
    }
    for (const name of wanted) if (!byName.has(name)) throw damaged(`The archive is missing "${shown(name, expected.folder)}".`);
    const known = new Set(wanted);
    for (const entry of layout.entries) if (!known.has(entry.name)) throw damaged(`The archive holds "${shown(entry.name, expected.folder)}", which is not one of this save's files.`);

    // Layout: entries follow one another from the first byte to the directory, each local header agreeing with its
    // directory record and each data descriptor with the sizes.
    const ordered = [...layout.entries].sort((left, right) => left.localOffset - right.localOffset);
    const starts = new Map<Entry, number>();
    let cursor = 0;
    for (const [position, entry] of ordered.entries()) {
      throwIfAborted(signal);
      const label = shown(entry.name, expected.folder);
      if (entry.localOffset !== cursor) throw damaged(`The archive has stray bytes or overlapping entries around "${label}".`);
      const header = await readLocalHeader(handle, entry, label, true);
      starts.set(entry, header.dataStart);
      const dataEnd = header.dataStart + entry.compressedSize;
      const next = ordered[position + 1]?.localOffset ?? layout.directoryOffset;
      const gap = next - dataEnd;
      if ((entry.flags & FLAG_DESCRIPTOR) === 0) {
        if (gap !== 0) throw damaged(`The archive has stray bytes or overlapping entries around "${label}".`);
      } else {
        if (!DESCRIPTOR_LENGTHS.has(gap)) throw damaged(`"${label}" has no proper data descriptor after its bytes.`);
        const descriptor = await readExactly(handle, dataEnd, gap);
        const signed = gap === 16 || gap === 24;
        if (signed && descriptor.readUInt32LE(0) !== SIGNATURE_DESCRIPTOR) throw damaged(`"${label}" has no proper data descriptor after its bytes.`);
        const base = signed ? 4 : 0;
        const widths = gap === 24 || gap === 20;
        const descriptorCrc = descriptor.readUInt32LE(base);
        const descriptorPacked = widths ? wide(descriptor, base + 4) : descriptor.readUInt32LE(base + 4);
        const descriptorSize = widths ? wide(descriptor, base + 12) : descriptor.readUInt32LE(base + 8);
        if (descriptorCrc !== entry.crc || descriptorPacked !== entry.compressedSize || descriptorSize !== entry.size) {
          throw damaged(`"${label}" has a data descriptor that disagrees with the archive's directory: its CRC-32 is ${hex(descriptorCrc)} and size ${descriptorSize}, the directory says ${hex(entry.crc)} and ${entry.size}.`);
        }
      }
      cursor = next;
    }
    if (cursor !== layout.directoryOffset) throw damaged("The archive has stray bytes before its directory.");

    // Content: every entry unpacked and measured, in the order it lies on the disk.
    const expectedByName = new Map(expected.files.map((candidate) => [`${prefix}${candidate.path}`, candidate]));
    const digests = new Map<string, Digest>();
    let originalBytes = 0;
    for (const entry of ordered) {
      throwIfAborted(signal);
      const label = shown(entry.name, expected.folder);
      const isText = entry.name === `${prefix}${SUMS_NAME}` || entry.name === `${prefix}${MANIFEST_NAME}`;
      const digest = await digestEntry(handle, entry, starts.get(entry)!, label, isText, signal);
      if (digest.bytes !== entry.size) throw damaged(`"${label}" unpacks to ${digest.bytes} bytes, but the archive's directory says ${entry.size}.`);
      if (digest.crc !== entry.crc) throw damaged(`"${label}" does not match its CRC-32: it unpacks to ${hex(digest.crc)}, the archive's directory says ${hex(entry.crc)}.`);
      const device = expectedByName.get(entry.name);
      if (device) {
        if (digest.bytes !== device.size) throw damaged(`"${label}" is ${digest.bytes} bytes in the archive but ${device.size} bytes were saved.`);
        if (digest.sha256 !== device.sha256) throw damaged(`"${label}" in the archive has SHA-256 ${digest.sha256}, but the file that was saved has ${device.sha256}.`);
        originalBytes += digest.bytes;
      }
      digests.set(entry.name, digest);
    }

    const manifestDigest = digests.get(`${prefix}${MANIFEST_NAME}`)!;
    if (expected.manifestSha256 !== undefined && manifestDigest.sha256 !== expected.manifestSha256) {
      throw damaged(`"${MANIFEST_NAME}" in the archive is not the one the server wrote: it hashes to ${manifestDigest.sha256}, expected ${expected.manifestSha256}.`);
    }
    const stored = digests.get(`${prefix}${SUMS_NAME}`)!.text!.toString("utf8");
    const lines = [...expected.files.map((candidate) => `${digests.get(`${prefix}${candidate.path}`)!.sha256}  ${candidate.path}`), `${manifestDigest.sha256}  ${MANIFEST_NAME}`];
    if (stored !== `${lines.join("\n")}\n`) {
      const storedLines = stored.endsWith("\n") ? stored.slice(0, -1).split("\n") : stored.split("\n");
      const differing = lines.findIndex((line, index) => storedLines[index] !== line);
      const where = differing >= 0 && differing < lines.length - 1 ? `its line for "${shown(expected.files[differing]!.path)}" is wrong` : differing === lines.length - 1 ? `its line for "${MANIFEST_NAME}" is wrong` : `it has ${storedLines.length} lines, expected ${lines.length}`;
      throw damaged(`"${SUMS_NAME}" in the archive does not list what the files hash to: ${where}.`);
    }

    return { archiveBytes, files: expected.files.length, originalBytes, manifestSha256: manifestDigest.sha256 };
  } finally {
    await handle.close();
  }
}

/**
 * The `manifest.json` stored inside an archive, and the folder it lives in, without unpacking anything: it is stored,
 * not deflated, so this is one small read. Never throws: anything that is not a readable archive holding such a stored,
 * intact manifest (a person's own zip, a half-copied file) is simply `undefined`.
 */
export async function readArchiveManifest(file: string): Promise<{ readonly folder: string; readonly manifest: unknown } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const layout = await readLayout(handle, size);
    const entry = layout.entries.find((candidate) => /^[^/]+\/manifest\.json$/.test(candidate.name));
    if (!entry || entry.method !== 0 || entry.compressedSize !== entry.size || entry.size > MAX_TEXT_ENTRY_BYTES) return undefined;
    const { dataStart } = await readLocalHeader(handle, entry, MANIFEST_NAME, false);
    const bytes = await readExactly(handle, dataStart, entry.size);
    if (crc32(bytes) !== entry.crc) return undefined;
    return { folder: entry.name.slice(0, entry.name.indexOf("/")), manifest: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
