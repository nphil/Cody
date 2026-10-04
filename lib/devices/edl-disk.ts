import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hashBlob } from "./blob-stream";
import { FirehoseRejection, type WriteSource } from "./edl-firehose";
import {
  evaluateSpan,
  findPartitions,
  gptEntrySectors,
  parseGptEntries,
  parseGptHeader,
  type BackupGpt,
  type GptHeader,
  type GptPartition,
  type GptTable,
  type SpanReport,
} from "./edl-gpt";
import { EdlError } from "./edl-link";
import type { EdlRun, OpenedEdl } from "./edl-session";
import type { HardwareContext, StreamArtifact } from "./flasher";

/**
 * What is on the disk and how to read and keep it: the pieces the read-only
 * commands (printgpt, check, dump) and the writing ones (flash, erase, backup,
 * restore) share. Nothing in this file writes to the device.
 */

/** The primary entry array is expected directly after the header; a table that starts it elsewhere is not read. */
const MAX_PRIMARY_ENTRIES_LBA = 64;
const PROGRESS_EVERY_MS = 400;
/** Browsers cap what a Blob fallback may hold; real devices stream. */
const MAX_BUFFERED_ARTIFACT_BYTES = 8 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function fileNamePart(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "unnamed";
}

export function progressReporter(context: HardwareContext, phase: string, total: number, message: string): (completed: number) => void {
  let last = 0;
  return (completed) => {
    const now = Date.now();
    if (completed >= total || now - last >= PROGRESS_EVERY_MS) {
      last = now;
      context.progress({ phase, completed: Math.min(completed, total), total, message });
    }
  };
}

/** Escrows a stream of device bytes: streamed when the browser offers it, otherwise a small Blob. */
export async function saveChunks(context: HardwareContext, chunks: AsyncIterable<Uint8Array>, length: number, name: string): Promise<StreamArtifact> {
  if (context.saveStream) return context.saveStream(name, chunks);
  if (length > MAX_BUFFERED_ARTIFACT_BYTES) throw new EdlError("This client must provide streaming artifact storage for a file this large.", "refused");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of chunks) parts.push(Uint8Array.from(chunk));
  const blob = new Blob(parts);
  return { fileId: await context.save(name, blob), sha256: await hashBlob(blob), length };
}

export async function saveSmall(context: HardwareContext, name: string, bytes: Uint8Array): Promise<{ fileId: string; sha256: string }> {
  const blob = new Blob([Uint8Array.from(bytes)]);
  return { fileId: await context.save(name, blob), sha256: await hashBlob(blob) };
}

export async function readRegion(opened: OpenedEdl, start: number, sectors: number): Promise<Uint8Array> {
  const out = new Uint8Array(sectors * opened.storage.sectorSize);
  let filled = 0;
  for await (const chunk of opened.firehose.readSectors(start, sectors, opened.storage.sectorSize)) {
    out.set(chunk, filled);
    filled += chunk.byteLength;
  }
  if (filled !== out.byteLength) throw new EdlError(`Read ${filled} of ${out.byteLength} bytes at sector ${start}.`);
  return out;
}

export interface PrimaryGpt {
  readonly table: GptTable;
  /** Sectors 0 .. end of the entry array, byte for byte. */
  readonly region: Uint8Array;
  readonly regionSectors: number;
}

/** What the primary header says about where the backup table is, against where the measured disk ends. */
export interface BackupPointer {
  /** The sector the primary header's AlternateLBA names. */
  readonly lba: number;
  /** It is the last sector the programmer reports. */
  readonly agrees: boolean;
  /** When it does not agree: what is at that sector, in a sentence. Empty when it agrees. */
  readonly there: string;
}

export interface BackupRead extends BackupGpt {
  readonly region: Uint8Array | null;
  readonly firstLba: number | null;
  readonly sectors: number | null;
  /** The sector the backup table was looked for in: the last one the programmer reports. */
  readonly atLba: number;
  /** The programmer would not read that sector at all. */
  readonly lastSectorUnreadable: boolean;
  readonly pointer: BackupPointer;
}

type TailCopy = Omit<BackupRead, "pointer">;

/** Sectors the primary table occupies (protective MBR, header, entry array), once its header has passed the placement checks. */
function primaryExtent(header: GptHeader, sectorSize: number): number {
  if (header.myLba !== 1) throw new EdlError(`The primary partition table header says it is at sector ${header.myLba}, not sector 1.`);
  if (header.entriesLba < 2 || header.entriesLba > MAX_PRIMARY_ENTRIES_LBA) throw new EdlError(`The primary partition entry array starts at sector ${header.entriesLba}; Cody expects it right after the header.`);
  return header.entriesLba + gptEntrySectors(header, sectorSize);
}

export async function readPrimaryGpt(opened: OpenedEdl): Promise<PrimaryGpt> {
  const sectorSize = opened.storage.sectorSize;
  const head = await readRegion(opened, 0, 2);
  const header = parseGptHeader(head.subarray(sectorSize, 2 * sectorSize), sectorSize);
  const end = primaryExtent(header, sectorSize);
  const region = await readRegion(opened, 0, end);
  const table = parseGptEntries(header, region.subarray(header.entriesLba * sectorSize, end * sectorSize), sectorSize);
  return { table, region, regionSectors: end };
}

/** The primary table of a SAVED region (sectors 0 .. end of the entry array), checked the way a live read is. */
export function parsePrimaryRegion(region: Uint8Array, sectorSize: number): PrimaryGpt {
  if (region.byteLength < 2 * sectorSize) throw new EdlError(`The saved primary table is only ${region.byteLength} bytes long.`, "refused");
  const header = parseGptHeader(region.subarray(sectorSize, 2 * sectorSize), sectorSize);
  const end = primaryExtent(header, sectorSize);
  if (region.byteLength !== end * sectorSize) throw new EdlError(`The saved primary table is ${region.byteLength / sectorSize} sectors long but its header describes ${end}.`, "refused");
  const table = parseGptEntries(header, region.subarray(header.entriesLba * sectorSize, end * sectorSize), sectorSize);
  return { table, region, regionSectors: end };
}

function problem(message: string, atLba: number, lastSectorUnreadable = false): TailCopy {
  return { header: null, table: null, problem: message, region: null, firstLba: null, sectors: null, atLba, lastSectorUnreadable };
}

/** The partition table header in sector `at` and the entry array just before it: where a backup table has to sit. */
async function readTailCopy(opened: OpenedEdl, at: number): Promise<TailCopy> {
  const sectorSize = opened.storage.sectorSize;
  let headerSector: Uint8Array;
  try {
    headerSector = await readRegion(opened, at, 1);
  } catch (error) {
    if (error instanceof FirehoseRejection) return problem(`The programmer would not read sector ${at}, the last one it reports, where the backup partition table should be: ${error.message}`, at, true);
    throw error;
  }
  let header;
  let count;
  try {
    header = parseGptHeader(headerSector, sectorSize);
    count = gptEntrySectors(header, sectorSize);
  } catch (error) {
    if (error instanceof EdlError) return problem(`Sector ${at} does not hold a usable backup partition table header: ${error.message}`, at);
    throw error;
  }
  if (header.entriesLba >= at || at - header.entriesLba > count + 64) return problem(`The backup header at sector ${at} puts its entry array at sector ${header.entriesLba}, which is not just before it.`, at);
  const first = header.entriesLba;
  const sectors = at - first + 1;
  let region: Uint8Array;
  try {
    region = await readRegion(opened, first, sectors);
  } catch (error) {
    if (error instanceof FirehoseRejection) return problem(`The programmer would not read the backup entry array at sector ${first}: ${error.message}`, at);
    throw error;
  }
  const table = parseGptEntries(header, region.subarray(0, count * sectorSize), sectorSize);
  return { header, table, problem: null, region, firstLba: first, sectors, atLba: at, lastSectorUnreadable: false };
}

/** What a sector the primary header names as the backup's home holds, when that is not the end of the disk. */
async function describeStrayPointer(opened: OpenedEdl, lba: number): Promise<string> {
  if (lba >= opened.storage.totalSectors) return "That sector does not exist on this disk.";
  let sector: Uint8Array;
  try {
    sector = await readRegion(opened, lba, 1);
  } catch (error) {
    if (error instanceof FirehoseRejection) return `The programmer would not read that sector (${error.message}).`;
    throw error;
  }
  try {
    const found = parseGptHeader(sector, opened.storage.sectorSize);
    return `That sector holds a GPT header too (its own address is ${found.myLba}, checksum ${found.headerCrcValid ? "valid" : "bad"}): probably an older copy. It is not the one saved.`;
  } catch (error) {
    if (error instanceof EdlError) return "That sector holds no GPT header.";
    throw error;
  }
}

/**
 * The partition table at the END of the disk. It is looked for in the last sector the
 * programmer reports, independently of what the primary header says: a pointer that was
 * left stale by a resize, or damaged, must neither hide the real recovery copy nor stand
 * in for it with an interior one. A pointer that disagrees is reported, not followed.
 */
export async function readBackupGpt(opened: OpenedEdl, primary: PrimaryGpt): Promise<BackupRead> {
  const last = opened.storage.totalSectors - 1;
  const copy = await readTailCopy(opened, last);
  const lba = primary.table.header.alternateLba;
  const agrees = lba === last;
  return { ...copy, pointer: { lba, agrees, there: agrees ? "" : await describeStrayPointer(opened, lba) } };
}

/** The backup table of a SAVED region (the entry array and, in the last sector, the header), parsed the way a live read parses it. */
export function parseBackupRegion(region: Uint8Array, sectorSize: number): { readonly header: GptHeader; readonly table: GptTable; readonly sectors: number } {
  if (region.byteLength < 2 * sectorSize || region.byteLength % sectorSize !== 0) throw new EdlError(`The saved backup table is ${region.byteLength} bytes, not a whole number of sectors holding an entry array and a header.`, "refused");
  const sectors = region.byteLength / sectorSize;
  const header = parseGptHeader(region.subarray((sectors - 1) * sectorSize), sectorSize);
  const count = gptEntrySectors(header, sectorSize);
  if (header.entriesLba >= header.myLba || header.myLba - header.entriesLba + 1 !== sectors || count > sectors - 1) {
    throw new EdlError(`The saved backup table does not fit its own header: the entry array is at sector ${header.entriesLba}, the header at ${header.myLba}, and ${sectors} sectors were saved.`, "refused");
  }
  return { header, table: parseGptEntries(header, region.subarray(0, count * sectorSize), sectorSize), sectors };
}

export interface LiveDiskGuid {
  /** The disk GUID of the primary table, when that table is intact. */
  readonly primary: string | null;
  /** The disk GUID of the backup table in the last sector, when that table is intact. */
  readonly backup: string | null;
  /** Why a table could not be used. */
  readonly notes: readonly string[];
}

/**
 * Whose disk this is, as the tables on the device say it: the GUID of each table whose checksums are valid. A damaged
 * or unreadable table says nothing. A device that goes away or a cancel is not a finding and propagates.
 */
export async function readLiveDiskGuid(opened: OpenedEdl): Promise<LiveDiskGuid> {
  const notes: string[] = [];
  let primary: string | null = null;
  let backup: string | null = null;
  try {
    const found = await readPrimaryGpt(opened);
    if (found.table.header.headerCrcValid && found.table.entriesCrcValid) primary = found.table.header.diskGuid;
    else notes.push("The primary partition table on the device is damaged (its checksums do not match).");
  } catch (error) {
    if (!(error instanceof EdlError)) throw error;
    notes.push(`The primary partition table on the device cannot be read: ${error.message}`);
  }
  const tail = await readTailCopy(opened, opened.storage.totalSectors - 1);
  if (tail.header && tail.table && tail.header.headerCrcValid && tail.table.entriesCrcValid) backup = tail.header.diskGuid;
  else notes.push(tail.problem ?? "The backup partition table at the end of the device is damaged (its checksums do not match).");
  return { primary, backup, notes };
}

export interface DiskReport {
  readonly primary: PrimaryGpt;
  readonly backup: BackupRead;
  readonly lastSectorReadable: boolean;
  readonly span: SpanReport;
}

/** Everything the span check needs, read in this operation. */
export async function examineDisk(opened: OpenedEdl, run: EdlRun): Promise<DiskReport> {
  run.context.progress({ phase: "gpt", message: "Reading the partition tables" });
  const primary = await readPrimaryGpt(opened);
  const backup = await readBackupGpt(opened, primary);
  const lastSectorReadable = !backup.lastSectorUnreadable;
  if (!lastSectorReadable && backup.problem) run.say(backup.problem);
  const span = evaluateSpan(opened.storage.totalSectors, opened.storage.sectorSize, primary.table, { lastSectorReadable, backup });
  return { primary, backup, lastSectorReadable, span };
}

/** The serial number a file name carries, so files of one unit sort together. */
export function unitTag(opened: OpenedEdl): string {
  const serial = opened.identity?.serial ?? opened.firehose.chipSerial?.replace(/^0x/, "");
  return fileNamePart(serial ?? opened.storage.serialNumber ?? "unit");
}

export function describeStorage(opened: OpenedEdl): string {
  const { storage } = opened;
  return `${storage.productName ?? "eMMC"}: ${storage.totalSectors} sectors of ${storage.sectorSize} bytes (${formatBytes(storage.totalSectors * storage.sectorSize)})`;
}

export function describeRange(first: number, sectors: number, sectorSize: number): string {
  return `sectors ${first}-${first + sectors - 1} (${sectors} sectors, ${sectors * sectorSize} bytes)`;
}

export interface StreamedRead {
  readonly saved: StreamArtifact;
  readonly wireSha256: string;
}

/**
 * Reads sectors into a session file and checks, before calling it good, that the file
 * holds exactly the bytes that came off the wire. `phase` is what progress calls it.
 */
export async function streamToArtifact(run: EdlRun, opened: OpenedEdl, startSector: number, sectors: number, name: string, phase = "read", message = `Reading ${name}`): Promise<StreamedRead> {
  const { context } = run;
  const total = sectors * opened.storage.sectorSize;
  const hash = incrementalSha256.create();
  let received = 0;
  const report = progressReporter(context, phase, total, message);
  context.progress({ phase, completed: 0, total, message });
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of opened.firehose.readSectors(startSector, sectors, opened.storage.sectorSize)) {
      hash.update(chunk);
      received += chunk.byteLength;
      report(received);
      yield chunk;
    }
  }
  try {
    const saved = await saveChunks(context, chunks(), total, name);
    const wireSha256 = bytesToHex(hash.digest());
    if (received !== total || saved.length !== total) throw new EdlError(`Received ${received} bytes and saved ${saved.length}, expected ${total}. The file is not usable.`);
    if (saved.sha256 !== wireSha256) throw new EdlError(`The saved file's SHA-256 (${saved.sha256}) differs from that of the bytes received (${wireSha256}). Browser storage altered the data; do not trust the file.`);
    return { saved, wireSha256 };
  } finally {
    hash.destroy();
  }
}

export interface RegionSummary {
  readonly sha256: string;
  readonly bytes: number;
  /** Every byte is 0x00. */
  readonly allZero: boolean;
  /** Every byte is 0xFF. */
  readonly allOnes: boolean;
}

/**
 * Reads a region back and describes it - SHA-256, all zero, all 0xFF - without keeping
 * the bytes. This is the read-back of every write: what the programmer hands back, not
 * what it said.
 */
export async function summarizeRegion(run: EdlRun, opened: OpenedEdl, startSector: number, sectors: number, phase: string, message: string): Promise<RegionSummary> {
  const total = sectors * opened.storage.sectorSize;
  const hash = incrementalSha256.create();
  const report = progressReporter(run.context, phase, total, message);
  let bytes = 0;
  let allZero = true;
  let allOnes = true;
  try {
    run.context.progress({ phase, completed: 0, total, message });
    for await (const chunk of opened.firehose.readSectors(startSector, sectors, opened.storage.sectorSize)) {
      hash.update(chunk);
      if (allZero || allOnes) {
        for (let index = 0; index < chunk.byteLength; index += 1) {
          const byte = chunk[index]!;
          if (byte !== 0x00) allZero = false;
          if (byte !== 0xff) allOnes = false;
          if (!allZero && !allOnes) break;
        }
      }
      bytes += chunk.byteLength;
      report(bytes);
    }
    if (bytes !== total) throw new EdlError(`Read ${bytes} of ${total} bytes while checking sectors ${startSector}-${startSector + sectors - 1}.`);
    return { sha256: bytesToHex(hash.digest()), bytes, allZero, allOnes };
  } finally {
    hash.destroy();
  }
}

export interface LocatedPartition {
  readonly primary: PrimaryGpt;
  readonly part: GptPartition;
}

/**
 * Reads the primary table and finds the ONE partition called `name` in it, or says why
 * it cannot be used. `outcome` is what the refusal says was left undone ("read",
 * "written", "erased"). Nothing is read from or written to the partition itself.
 */
export async function locatePartition(opened: OpenedEdl, name: string, outcome: "read" | "written" | "erased"): Promise<LocatedPartition> {
  const primary = await readPrimaryGpt(opened);
  const { header } = primary.table;
  if (!header.headerCrcValid || !primary.table.entriesCrcValid) {
    throw new EdlError(`The primary partition table is damaged (its checksums do not match), so a partition cannot be found by name. Nothing was ${outcome}. Use printgpt to see the damage.`, "refused");
  }
  const matches = findPartitions(primary.table, name);
  if (matches.length === 0) {
    throw new EdlError(`The device has no partition named "${name.slice(0, 48)}". Partitions: ${primary.table.partitions.slice(0, 64).map((part) => part.name).join(", ")}.`, "refused");
  }
  if (matches.length > 1) throw new EdlError(`Two partitions are named "${name.slice(0, 48)}", so the name does not pick one. Nothing was ${outcome}.`, "refused");
  const part = matches[0]!;
  if (part.lastLba >= opened.storage.totalSectors) {
    throw new EdlError(`Partition ${part.name} ends at sector ${part.lastLba}, beyond the ${opened.storage.totalSectors} sectors the programmer reports. Nothing was ${outcome}.`, "refused");
  }
  return { primary, part };
}

/**
 * Why the sectors of `part` must not be written as "the partition called X", or
 * undefined when they may. A table that is intact can still describe sectors that are
 * not safe to hand to a partition write: outside the usable range, across either
 * partition table, or across another partition. There is no override for these.
 */
export function partitionWriteProblem(primary: PrimaryGpt, part: GptPartition, totalSectors: number, sectorSize: number): string | undefined {
  const { header } = primary.table;
  const where = `${part.name} (sectors ${part.firstLba}-${part.lastLba})`;
  if (part.firstLba < header.firstUsableLba || part.lastLba > header.lastUsableLba) {
    return `${where} lies outside the table's usable range (sectors ${header.firstUsableLba}-${header.lastUsableLba}).`;
  }
  const entrySectors = gptEntrySectors(header, sectorSize);
  if (part.firstLba < primary.regionSectors) return `${where} overlaps the primary partition table (sectors 0-${primary.regionSectors - 1}).`;
  const backupFirst = Math.min(header.alternateLba, totalSectors - 1) - entrySectors;
  if (part.lastLba >= backupFirst) return `${where} overlaps the backup partition table (from sector ${backupFirst}).`;
  const other = primary.table.partitions.find((candidate) => candidate.index !== part.index && candidate.firstLba <= part.lastLba && part.firstLba <= candidate.lastLba);
  if (other) return `${where} overlaps the partition ${other.name} (sectors ${other.firstLba}-${other.lastLba}), so writing it would change that one too.`;
  return undefined;
}

/** The bytes of `blob` followed by `pad` without end: the source of a write whose image is smaller than its partition. */
export function paddedSource(blob: Blob, pad: number): WriteSource {
  return {
    async read(offset, length) {
      const out = new Uint8Array(length);
      if (offset >= blob.size) return out.fill(pad);
      const end = Math.min(offset + length, blob.size);
      out.set(new Uint8Array(await blob.slice(offset, end).arrayBuffer()), 0);
      return out.fill(pad, end - offset);
    },
  };
}

/** SHA-256 of `blob` followed by `pad` up to `total` bytes: what a padded write leaves on the device. */
export async function hashPadded(blob: Blob, total: number, pad: number): Promise<string> {
  const hash = incrementalSha256.create();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
    }
    const filler = new Uint8Array(64 * 1024).fill(pad);
    for (let left = total - blob.size; left > 0; left -= filler.byteLength) hash.update(left >= filler.byteLength ? filler : filler.subarray(0, left));
    return bytesToHex(hash.digest());
  } finally {
    reader.releaseLock();
    hash.destroy();
  }
}

/** A courtesy: how much browser storage is left, when this browser will say. */
export async function storageNote(bytes: number): Promise<string> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (estimate?.quota !== undefined && estimate.usage !== undefined) {
      const free = estimate.quota - estimate.usage;
      return free < bytes * 2
        ? `WARNING: this browser reports about ${formatBytes(free)} of storage left; a read this size needs about twice its size (${formatBytes(bytes * 2)}) while it is saved.`
        : `This browser reports about ${formatBytes(free)} of storage left.`;
    }
  } catch {
    // An estimate is a courtesy.
  }
  return "";
}
