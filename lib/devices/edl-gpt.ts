import { cleanDeviceText } from "./edl-xml";
import { EdlError } from "./edl-link";

/**
 * GUID Partition Table: parsing and the checks the read-only backup relies on.
 * Everything here is pure and works on bytes a device handed us, so every number
 * is range-checked: a 64-bit field that does not fit a safe integer, an entry
 * count that would need more memory than a real table, or a table whose
 * checksum does not match is an error or a recorded fact, never a guess.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), as GPT uses it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const GPT_SIGNATURE = "EFI PART";
const MIN_HEADER_BYTES = 92;
/** A real table is a few dozen to a few hundred entries; this bounds what a lying device can make us read. */
export const GPT_MAX_ENTRIES_BYTES = 128 * 1024;
const MAX_ENTRY_COUNT = 1024;
const ALLOWED_SECTOR_SIZES: Readonly<Record<number, true>> = { 512: true, 4096: true };

export interface GptHeader {
  readonly revision: number;
  readonly headerSize: number;
  readonly headerCrc: number;
  readonly headerCrcValid: boolean;
  readonly myLba: number;
  readonly alternateLba: number;
  readonly firstUsableLba: number;
  readonly lastUsableLba: number;
  readonly diskGuid: string;
  readonly entriesLba: number;
  readonly entryCount: number;
  readonly entrySize: number;
  readonly entriesCrc: number;
}

export interface GptPartition {
  /** Position in the entry array (0-based). */
  readonly index: number;
  readonly name: string;
  readonly typeGuid: string;
  readonly uniqueGuid: string;
  readonly firstLba: number;
  readonly lastLba: number;
  readonly sectors: number;
  readonly bytes: number;
  readonly attributes: string;
}

export interface GptTable {
  readonly header: GptHeader;
  readonly partitions: readonly GptPartition[];
  readonly entriesCrcValid: boolean;
  /** Problems that do not stop the table being read but that a person should see. */
  readonly warnings: readonly string[];
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function lba(data: DataView, offset: number, what: string): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new EdlError(`The partition table's ${what} is ${value}, far beyond any real disk.`);
  return Number(value);
}

export function formatGuid(bytes: Uint8Array): string {
  const hex = (slice: Uint8Array, reverse: boolean): string => Array.from(reverse ? [...slice].reverse() : slice, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex(bytes.subarray(0, 4), true)}-${hex(bytes.subarray(4, 6), true)}-${hex(bytes.subarray(6, 8), true)}-${hex(bytes.subarray(8, 10), false)}-${hex(bytes.subarray(10, 16), false)}`.toUpperCase();
}

export function requireSectorSize(sectorSize: number): void {
  if (!ALLOWED_SECTOR_SIZES[sectorSize]) throw new EdlError(`A sector size of ${sectorSize} bytes is not one Cody reads (512 or 4096).`, "refused");
}

/** Parses the GPT header found in `sector` (the whole sector, as read from the disk). */
export function parseGptHeader(sector: Uint8Array, sectorSize: number): GptHeader {
  requireSectorSize(sectorSize);
  if (sector.byteLength < MIN_HEADER_BYTES) throw new EdlError(`The partition table header sector is only ${sector.byteLength} bytes long.`);
  const signature = new TextDecoder("latin1").decode(sector.subarray(0, 8));
  if (signature !== GPT_SIGNATURE) {
    const shifted = Array.from({ length: 17 }, (_, shift) => shift).find((shift) => shift > 0 && new TextDecoder("latin1").decode(sector.subarray(shift, shift + 8)) === GPT_SIGNATURE);
    throw new EdlError(shifted === undefined
      ? "There is no GPT signature (\"EFI PART\") where the partition table header should be."
      : `The GPT signature is ${shifted} byte(s) into the sector instead of at its start: the programmer's data stream is offset, so nothing read from it can be trusted.`);
  }
  const data = view(sector);
  const headerSize = data.getUint32(12, true);
  if (headerSize < MIN_HEADER_BYTES || headerSize > sectorSize || headerSize > sector.byteLength) throw new EdlError(`The partition table header claims a size of ${headerSize} bytes.`);
  // A real copy: on a Node Buffer `slice` is a view, and the CRC field must be zeroed in the copy only.
  const checked = Uint8Array.from(sector.subarray(0, headerSize));
  view(checked).setUint32(16, 0, true);
  const stored = data.getUint32(16, true);
  const entryCount = data.getUint32(80, true);
  const entrySize = data.getUint32(84, true);
  return {
    revision: data.getUint32(8, true),
    headerSize,
    headerCrc: stored,
    headerCrcValid: crc32(checked) === stored,
    myLba: lba(data, 24, "own address"),
    alternateLba: lba(data, 32, "alternate (backup) header address"),
    firstUsableLba: lba(data, 40, "first usable address"),
    lastUsableLba: lba(data, 48, "last usable address"),
    diskGuid: formatGuid(sector.subarray(56, 72)),
    entriesLba: lba(data, 72, "entry array address"),
    entryCount,
    entrySize,
    entriesCrc: data.getUint32(88, true),
  };
}

/** How many sectors the entry array occupies, after the plausibility checks a lying header must pass. */
export function gptEntrySectors(header: GptHeader, sectorSize: number): number {
  requireSectorSize(sectorSize);
  const { entryCount, entrySize } = header;
  if (entrySize < 128 || entrySize % 128 !== 0 || (entrySize & (entrySize - 1)) !== 0) throw new EdlError(`The partition table declares entries of ${entrySize} bytes; a GPT entry is 128 bytes times a power of two.`);
  if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT) throw new EdlError(`The partition table declares ${entryCount} entries.`);
  const total = entryCount * entrySize;
  if (total > GPT_MAX_ENTRIES_BYTES) throw new EdlError(`The partition table declares ${total} bytes of entries; Cody reads at most ${GPT_MAX_ENTRIES_BYTES}.`);
  return Math.ceil(total / sectorSize);
}

/** Parses an entry array (the sectors it occupies, as read) against its header. */
export function parseGptEntries(header: GptHeader, entries: Uint8Array, sectorSize: number): GptTable {
  const sectors = gptEntrySectors(header, sectorSize);
  const total = header.entryCount * header.entrySize;
  if (entries.byteLength < total) throw new EdlError(`The partition entry array is ${entries.byteLength} bytes, ${total} were expected.`);
  const array = entries.subarray(0, total);
  const warnings: string[] = [];
  if (!header.headerCrcValid) warnings.push("The partition table header's CRC does not match its contents.");
  const entriesCrcValid = crc32(array) === header.entriesCrc;
  if (!entriesCrcValid) warnings.push("The partition entry array's CRC does not match the header's.");
  if (header.revision !== 0x00010000) warnings.push(`The partition table revision is 0x${header.revision.toString(16)}, not 1.0.`);
  if (header.entriesLba + sectors > header.firstUsableLba && header.entriesLba < header.firstUsableLba) warnings.push("The entry array runs into the usable area.");

  const partitions: GptPartition[] = [];
  for (let index = 0; index < header.entryCount; index += 1) {
    const entry = array.subarray(index * header.entrySize, (index + 1) * header.entrySize);
    if (entry.subarray(0, 16).every((byte) => byte === 0)) continue;
    const data = view(entry);
    const firstLba = lba(data, 32, "partition start");
    const lastLba = lba(data, 40, "partition end");
    let nameEnd = 56;
    while (nameEnd + 1 < 128 && (entry[nameEnd] !== 0 || entry[nameEnd + 1] !== 0)) nameEnd += 2;
    const name = cleanDeviceText(new TextDecoder("utf-16le").decode(entry.subarray(56, nameEnd)), 64);
    if (lastLba < firstLba) {
      warnings.push(`Entry ${index} (${name || "unnamed"}) ends before it starts and is ignored.`);
      continue;
    }
    if (firstLba < header.firstUsableLba || lastLba > header.lastUsableLba) warnings.push(`Entry ${index} (${name || "unnamed"}) lies outside the usable area.`);
    const count = lastLba - firstLba + 1;
    partitions.push({
      index,
      name,
      typeGuid: formatGuid(entry.subarray(0, 16)),
      uniqueGuid: formatGuid(entry.subarray(16, 32)),
      firstLba,
      lastLba,
      sectors: count,
      bytes: count * sectorSize,
      attributes: `0x${data.getBigUint64(48, true).toString(16).padStart(16, "0")}`,
    });
  }
  const names = new Set<string>();
  for (const partition of partitions) {
    if (names.has(partition.name)) warnings.push(`Two entries are both named "${partition.name}"; that name cannot be used to pick one.`);
    names.add(partition.name);
  }
  const ordered = [...partitions].sort((left, right) => left.firstLba - right.firstLba);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.firstLba <= ordered[index - 1]!.lastLba) warnings.push(`"${ordered[index - 1]!.name}" and "${ordered[index]!.name}" overlap.`);
  }
  return { header, partitions, entriesCrcValid, warnings };
}

/** The partitions called exactly `name` (more than one means the name is ambiguous). */
export function findPartitions(table: GptTable, name: string): readonly GptPartition[] {
  return table.partitions.filter((partition) => partition.name === name);
}

export interface BackupGpt {
  /** The backup header, when the sector at the alternate address held one. */
  readonly header: GptHeader | null;
  readonly table: GptTable | null;
  /** Why the backup could not be read as a GPT, when it could not. */
  readonly problem: string | null;
}

export interface TailFacts {
  /** The last sector of the measured user area was read successfully. */
  readonly lastSectorReadable: boolean;
  readonly backup: BackupGpt;
}

export interface SpanReport {
  readonly ok: boolean;
  readonly sectorSize: number;
  /** User-area size the programmer reports, in sectors. */
  readonly measuredSectors: number;
  /** User-area size the partition table describes, in sectors (alternate header address + 1). */
  readonly gptSpanSectors: number;
  readonly backupHeaderLba: number;
  readonly lastSectorLba: number;
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  /** One sentence per failed check. */
  readonly reasons: readonly string[];
}

/**
 * Whether the partition table, the capacity the programmer reports and the
 * sectors actually present at the end of the disk tell one story. Matching
 * checksums prove a table is intact, not that it fits THIS disk, so the ranges it
 * declares (usable range, both entry arrays, every partition) are checked against
 * the measured capacity too. A whole-disk read is only offered when everything
 * agrees.
 */
export function evaluateSpan(measuredSectors: number, sectorSize: number, primary: GptTable, tail: TailFacts): SpanReport {
  const header = primary.header;
  const gptSpanSectors = header.alternateLba + 1;
  const lastSectorLba = measuredSectors - 1;
  const backup = tail.backup;
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const add = (name: string, passed: boolean, detail: string): void => { checks.push({ name, passed, detail }); };

  add("primary header", header.headerCrcValid && primary.entriesCrcValid && header.myLba === 1, header.headerCrcValid && primary.entriesCrcValid && header.myLba === 1
    ? "The primary partition table's checksums are valid."
    : `The primary partition table is not intact (header CRC ${header.headerCrcValid ? "ok" : "bad"}, entry CRC ${primary.entriesCrcValid ? "ok" : "bad"}, own address ${header.myLba}).`);
  add("span", gptSpanSectors === measuredSectors, gptSpanSectors === measuredSectors
    ? `The partition table spans ${gptSpanSectors} sectors, exactly the ${measuredSectors} the programmer reports.`
    : `The partition table spans ${gptSpanSectors} sectors (its backup header is at sector ${header.alternateLba}) but the programmer reports ${measuredSectors}: they disagree by ${Math.abs(gptSpanSectors - measuredSectors)} sector(s).`);

  const entrySectors = gptEntrySectors(header, sectorSize);
  const { firstUsableLba, lastUsableLba } = header;
  const usableFits = firstUsableLba <= lastUsableLba && lastUsableLba < measuredSectors;
  add("usable range", usableFits, usableFits
    ? `The usable range (sectors ${firstUsableLba}-${lastUsableLba}) lies inside the ${measuredSectors}-sector disk.`
    : `The partition table's usable range (sectors ${firstUsableLba}-${lastUsableLba}) does not fit the ${measuredSectors}-sector disk.`);

  const arrayProblems: string[] = [];
  const primaryArrayLast = header.entriesLba + entrySectors - 1;
  if (header.entriesLba < 2) arrayProblems.push(`The primary entry array starts at sector ${header.entriesLba}, inside the protective MBR or the header.`);
  if (primaryArrayLast >= measuredSectors) arrayProblems.push(`The primary entry array (sectors ${header.entriesLba}-${primaryArrayLast}) runs past the end of the ${measuredSectors}-sector disk.`);
  if (primaryArrayLast >= firstUsableLba) arrayProblems.push(`The primary entry array (sectors ${header.entriesLba}-${primaryArrayLast}) runs into the usable range, which starts at sector ${firstUsableLba}.`);
  if (backup.header) {
    const backupFirst = backup.header.entriesLba;
    const backupLast = backupFirst + entrySectors - 1;
    if (backupLast >= measuredSectors) arrayProblems.push(`The backup entry array (sectors ${backupFirst}-${backupLast}) runs past the end of the ${measuredSectors}-sector disk.`);
    if (backupFirst <= lastUsableLba) arrayProblems.push(`The backup entry array (sectors ${backupFirst}-${backupLast}) runs into the usable range, which ends at sector ${lastUsableLba}.`);
    if (backupLast >= backup.header.myLba) arrayProblems.push(`The backup entry array (sectors ${backupFirst}-${backupLast}) runs into its own header at sector ${backup.header.myLba}.`);
  }
  add("entry arrays", arrayProblems.length === 0, arrayProblems.length === 0
    ? `The entry array${backup.header ? "s" : ""} (primary at sector ${header.entriesLba}${backup.header ? `, backup at sector ${backup.header.entriesLba}` : ""}) lie${backup.header ? "" : "s"} inside the disk and outside the usable range.`
    : arrayProblems.join(" "));

  const outside = primary.partitions.filter((part) => part.firstLba < firstUsableLba || part.lastLba > lastUsableLba || part.lastLba >= measuredSectors);
  const nameOf = (part: GptPartition): string => `"${part.name || "unnamed"}" (sectors ${part.firstLba}-${part.lastLba})`;
  add("partitions", outside.length === 0, outside.length === 0
    ? `All ${primary.partitions.length} partition(s) lie inside the usable range and the disk.`
    : `${outside.length === 1 ? "Partition" : "Partitions"} ${outside.slice(0, 3).map(nameOf).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""} ${outside.length === 1 ? "lies" : "lie"} outside the usable range (sectors ${firstUsableLba}-${lastUsableLba}) of the ${measuredSectors}-sector disk.`);
  add("last sector", tail.lastSectorReadable, tail.lastSectorReadable
    ? `Sector ${lastSectorLba}, the last one the programmer reports, can be read.`
    : `Sector ${lastSectorLba}, the last one the programmer reports, could not be read.`);

  const backupHeader = backup.header;
  const backupOk = backupHeader !== null && backup.table !== null && backupHeader.headerCrcValid && backup.table.entriesCrcValid && backupHeader.myLba === header.alternateLba && backupHeader.alternateLba === header.myLba;
  add("backup header", backupOk, backupOk
    ? `A valid backup partition table header sits at sector ${header.alternateLba}.`
    : backup.problem ?? (backupHeader === null || backup.table === null
      ? `No usable backup partition table header was found at sector ${header.alternateLba}.`
      : `The backup partition table at sector ${header.alternateLba} is not intact or does not point back at the primary (CRC ${backupHeader.headerCrcValid && backup.table.entriesCrcValid ? "ok" : "bad"}, own address ${backupHeader.myLba}, alternate ${backupHeader.alternateLba}).`));
  const consistent = backupHeader !== null && backup.table !== null
    && backupHeader.diskGuid === header.diskGuid
    && backupHeader.entryCount === header.entryCount
    && backupHeader.entrySize === header.entrySize
    && backupHeader.firstUsableLba === header.firstUsableLba
    && backupHeader.lastUsableLba === header.lastUsableLba
    && backupHeader.entriesCrc === header.entriesCrc;
  add("backup matches primary", consistent, consistent
    ? "The backup partition table is identical to the primary one."
    : "The backup partition table differs from the primary one (disk id, entry layout, usable range or entry checksum).");
  add("backup at the end", header.alternateLba === lastSectorLba, header.alternateLba === lastSectorLba
    ? `The backup header is in the last sector (${lastSectorLba}).`
    : `The backup header is at sector ${header.alternateLba}, not in the last sector (${lastSectorLba}).`);

  return {
    ok: checks.every((check) => check.passed),
    sectorSize,
    measuredSectors,
    gptSpanSectors,
    backupHeaderLba: header.alternateLba,
    lastSectorLba,
    checks,
    reasons: checks.filter((check) => !check.passed).map((check) => check.detail),
  };
}
