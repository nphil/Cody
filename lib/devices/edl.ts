import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hashBlob } from "./blob-stream";
import { FirehoseRejection } from "./edl-firehose";
import {
  evaluateSpan,
  findPartitions,
  gptEntrySectors,
  parseGptEntries,
  parseGptHeader,
  type BackupGpt,
  type GptPartition,
  type GptTable,
  type SpanReport,
} from "./edl-gpt";
import { EdlError } from "./edl-link";
import { saharaLeave } from "./edl-sahara";
import { describeIdentity, discoverDevice, inspectDevice, openFirehose, type EdlRun, type OpenedEdl } from "./edl-session";
import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport, StreamArtifact } from "./flasher";
import { throwIfAborted } from "./serial";

/**
 * Qualcomm emergency download (EDL, USB 05c6:9008), as Cody speaks it.
 *
 *   detect        the boot ROM's identity (Sahara command mode)
 *   exec connect  send the user's loader if the device needs one, configure the
 *                 programmer for eMMC, report the storage
 *   exec printgpt read the primary AND the real tail (backup) partition table
 *   exec check    does the table's span agree with the capacity the programmer
 *                 reports, and is the backup table where it should be
 *   exec reset    leave EDL (asks first)
 *   dump NAME     one GPT partition into a session file with its SHA-256
 *   dump user-area  the whole user area, only with an explicit sector count and
 *                 only when `check` passes in the same operation
 *
 * Nothing here changes storage.
 */

const USER_AREA = "user-area";
const MAX_LISTED_PARTITIONS = 256;
/** The primary entry array is expected directly after the header; a table that starts it elsewhere is not read. */
const MAX_PRIMARY_ENTRIES_LBA = 64;
const PROGRESS_EVERY_MS = 400;
/** Browsers cap what a Blob fallback may hold; real devices stream. */
const MAX_BUFFERED_ARTIFACT_BYTES = 8 * 1024 * 1024;

function requireUsb(transport: HardwareTransport): void {
  if (transport.kind !== "usb") throw new EdlError("Qualcomm EDL needs a USB bulk transport.", "refused");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function fileNamePart(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "unnamed";
}

function progressReporter(context: HardwareContext, phase: string, total: number, message: string): (completed: number) => void {
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
async function saveChunks(context: HardwareContext, chunks: AsyncIterable<Uint8Array>, length: number, name: string): Promise<StreamArtifact> {
  if (context.saveStream) return context.saveStream(name, chunks);
  if (length > MAX_BUFFERED_ARTIFACT_BYTES) throw new EdlError("This client must provide streaming artifact storage for a file this large.", "refused");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of chunks) parts.push(Uint8Array.from(chunk));
  const blob = new Blob(parts);
  return { fileId: await context.save(name, blob), sha256: await hashBlob(blob), length };
}

async function saveSmall(context: HardwareContext, name: string, bytes: Uint8Array): Promise<{ fileId: string; sha256: string }> {
  const blob = new Blob([Uint8Array.from(bytes)]);
  return { fileId: await context.save(name, blob), sha256: await hashBlob(blob) };
}

async function readRegion(opened: OpenedEdl, start: number, sectors: number): Promise<Uint8Array> {
  const out = new Uint8Array(sectors * opened.storage.sectorSize);
  let filled = 0;
  for await (const chunk of opened.firehose.readSectors(start, sectors, opened.storage.sectorSize)) {
    out.set(chunk, filled);
    filled += chunk.byteLength;
  }
  if (filled !== out.byteLength) throw new EdlError(`Read ${filled} of ${out.byteLength} bytes at sector ${start}.`);
  return out;
}

interface PrimaryGpt {
  readonly table: GptTable;
  /** Sectors 0 .. end of the entry array, byte for byte. */
  readonly region: Uint8Array;
  readonly regionSectors: number;
}

/** What the primary header says about where the backup table is, against where the measured disk ends. */
interface BackupPointer {
  /** The sector the primary header's AlternateLBA names. */
  readonly lba: number;
  /** It is the last sector the programmer reports. */
  readonly agrees: boolean;
  /** When it does not agree: what is at that sector, in a sentence. Empty when it agrees. */
  readonly there: string;
}

interface BackupRead extends BackupGpt {
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

export async function readPrimaryGpt(opened: OpenedEdl): Promise<PrimaryGpt> {
  const sectorSize = opened.storage.sectorSize;
  const head = await readRegion(opened, 0, 2);
  const header = parseGptHeader(head.subarray(sectorSize, 2 * sectorSize), sectorSize);
  if (header.myLba !== 1) throw new EdlError(`The primary partition table header says it is at sector ${header.myLba}, not sector 1.`);
  if (header.entriesLba < 2 || header.entriesLba > MAX_PRIMARY_ENTRIES_LBA) throw new EdlError(`The primary partition entry array starts at sector ${header.entriesLba}; Cody expects it right after the header.`);
  const end = header.entriesLba + gptEntrySectors(header, sectorSize);
  const region = await readRegion(opened, 0, end);
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

interface DiskReport {
  readonly primary: PrimaryGpt;
  readonly backup: BackupRead;
  readonly lastSectorReadable: boolean;
  readonly span: SpanReport;
}

/** Everything the span check needs, read in this operation. */
async function examineDisk(opened: OpenedEdl, run: EdlRun): Promise<DiskReport> {
  run.context.progress({ phase: "gpt", message: "Reading the partition tables" });
  const primary = await readPrimaryGpt(opened);
  const backup = await readBackupGpt(opened, primary);
  const lastSectorReadable = !backup.lastSectorUnreadable;
  if (!lastSectorReadable && backup.problem) run.say(backup.problem);
  const span = evaluateSpan(opened.storage.totalSectors, opened.storage.sectorSize, primary.table, { lastSectorReadable, backup });
  return { primary, backup, lastSectorReadable, span };
}

function partitionLines(table: GptTable): string[] {
  return table.partitions.slice(0, MAX_LISTED_PARTITIONS).map((part) => `${String(part.index).padStart(3)}  ${part.name.padEnd(24)} sectors ${part.firstLba}-${part.lastLba}  ${formatBytes(part.bytes)}`);
}

function describePartitions(parts: readonly GptPartition[]): Record<string, unknown>[] {
  return parts.slice(0, MAX_LISTED_PARTITIONS).map((part) => ({ index: part.index, name: part.name, firstLba: part.firstLba, lastLba: part.lastLba, sectors: part.sectors, bytes: part.bytes, typeGuid: part.typeGuid, uniqueGuid: part.uniqueGuid }));
}

function unitTag(opened: OpenedEdl): string {
  const serial = opened.identity?.serial ?? opened.firehose.chipSerial?.replace(/^0x/, "");
  return fileNamePart(serial ?? opened.storage.serialNumber ?? "unit");
}

function describeStorage(opened: OpenedEdl): string {
  const { storage } = opened;
  return `${storage.productName ?? "eMMC"}: ${storage.totalSectors} sectors of ${storage.sectorSize} bytes (${formatBytes(storage.totalSectors * storage.sectorSize)})`;
}

// ---- detect ----------------------------------------------------------------

async function detect(run: EdlRun): Promise<HardwareResult> {
  const { identity, firehose } = await inspectDevice(run);
  if (identity) {
    for (const line of describeIdentity(identity)) run.say(line);
    for (const warning of identity.warnings) run.say(`Note: ${warning}`);
    const waiting = identity.backInLoaderState === true
      ? "It is waiting for a loader."
      : identity.backInLoaderState === null
        ? "It was asked to go back to waiting for a loader; the next step finds out whether it did."
        : "It may need to be put into EDL again before a loader is sent.";
    return {
      summary: `Qualcomm EDL boot ROM (Sahara ${identity.saharaVersion}), chip serial 0x${identity.serial}${identity.msmId ? `, MSM id 0x${identity.msmId}` : ""}. ${waiting}`,
      details: { mode: "sahara", sahara: { ...identity, nextHello: undefined } },
    };
  }
  const supported = firehose?.supportedFunctions ?? [];
  run.say("A programmer is already running, so the boot ROM's identity (hardware id, public-key hash) cannot be read; put the device into EDL again for that.");
  return {
    summary: `A Firehose programmer is running${firehose?.chipSerial ? ` (chip serial ${firehose.chipSerial})` : ""}. Connect to read its storage.`,
    details: { mode: "firehose", programmer: { chipSerial: firehose?.chipSerial ?? null, supportedFunctions: supported } },
  };
}

// ---- exec ------------------------------------------------------------------

type EdlCommand = "connect" | "printgpt" | "check" | "reset";

const COMMAND_NAMES: Readonly<Record<string, EdlCommand>> = {
  connect: "connect",
  load: "connect",
  getstorageinfo: "connect",
  printgpt: "printgpt",
  gpt: "printgpt",
  check: "check",
  span: "check",
  reset: "reset",
  reboot: "reset",
};

export function parseEdlCommand(command: string | undefined): EdlCommand {
  const word = (command ?? "").trim().replace(/^edl\s+/i, "").toLowerCase();
  const found = Object.hasOwn(COMMAND_NAMES, word) ? COMMAND_NAMES[word] : undefined;
  if (!found) throw new EdlError(`"${(command ?? "").trim().slice(0, 40)}" is not an EDL command Cody offers. Use connect, printgpt, check or reset.`, "refused");
  return found;
}

async function connect(run: EdlRun): Promise<HardwareResult> {
  const opened = await openFirehose(run, { identity: "try" }, run.context.input);
  const { storage, configuration } = opened;
  run.say(describeStorage(opened));
  return {
    summary: `Programmer ready. ${describeStorage(opened)}.`,
    details: {
      target: configuration.targetName,
      memory: configuration.memoryName,
      programmerVersion: configuration.version,
      loaderSent: opened.loader?.sha256 ?? null,
      identity: opened.identity ? { ...opened.identity, nextHello: undefined } : null,
      chipSerial: opened.firehose.chipSerial,
      supportedFunctions: opened.firehose.supportedFunctions,
      storage,
    },
  };
}

async function printGpt(run: EdlRun): Promise<HardwareResult> {
  const opened = await openFirehose(run, { identity: "try" }, run.context.input);
  const { primary, backup } = await examineDisk(opened, run);
  const { header } = primary.table;
  run.say(describeStorage(opened));
  run.say(`Disk GUID ${header.diskGuid}; the table describes ${header.alternateLba + 1} sectors; ${primary.table.partitions.length} partition(s):`);
  for (const line of partitionLines(primary.table)) run.say(line);
  for (const warning of primary.table.warnings) run.say(`Warning: ${warning}`);
  const tag = unitTag(opened);
  const saved: Record<string, { fileId: string; sha256: string }> = {};
  saved.primary = await saveSmall(run.context, `edl-${tag}-gpt-primary.bin`, primary.region);
  run.say(`Saved the primary table (sectors 0-${primary.regionSectors - 1}) as ${saved.primary.fileId}, SHA-256 ${saved.primary.sha256}.`);
  const backupIntact = Boolean(backup.header?.headerCrcValid && backup.table?.entriesCrcValid);
  if (backup.region && backup.firstLba !== null) {
    saved.backup = await saveSmall(run.context, `edl-${tag}-gpt-backup.bin`, backup.region);
    run.say(`Saved the backup table at the end of the disk (sectors ${backup.firstLba}-${backup.atLba}) as ${saved.backup.fileId}, SHA-256 ${saved.backup.sha256}.`);
    if (!backupIntact) run.say("Warning: the backup table at the end of the disk is damaged (its checksums do not match); it is saved as it was read.");
  } else {
    run.say(`The backup table at the end of the disk could not be read: ${backup.problem}`);
  }
  if (!backup.pointer.agrees) run.say(`Note: the primary header puts its backup table at sector ${backup.pointer.lba}, not at the last sector (${backup.atLba}). ${backup.pointer.there}`);
  const intact = header.headerCrcValid && primary.table.entriesCrcValid;
  return {
    summary: `${primary.table.partitions.length} partition(s); primary table ${intact ? "intact" : "DAMAGED"}; backup table ${backup.region ? (backupIntact ? "read" : "DAMAGED") : "not readable"}${backup.pointer.agrees ? "" : `; the primary header points its backup at sector ${backup.pointer.lba}, not at the last sector`}.`,
    verified: intact,
    details: {
      diskGuid: header.diskGuid,
      sectorSize: opened.storage.sectorSize,
      measuredSectors: opened.storage.totalSectors,
      gptSpanSectors: header.alternateLba + 1,
      primaryIntact: intact,
      warnings: primary.table.warnings,
      partitions: describePartitions(primary.table.partitions),
      backup: { read: Boolean(backup.region), intact: backupIntact, problem: backup.problem, firstLba: backup.firstLba, sectors: backup.sectors, atLba: backup.atLba, pointer: backup.pointer },
      files: saved,
    },
  };
}

async function checkDisk(run: EdlRun): Promise<HardwareResult> {
  const opened = await openFirehose(run, { identity: "try" }, run.context.input);
  const { span } = await examineDisk(opened, run);
  run.say(describeStorage(opened));
  for (const check of span.checks) run.say(`${check.passed ? "PASS" : "FAIL"}  ${check.detail}`);
  return {
    summary: span.ok
      ? `Span check passed: the partition table, the programmer's capacity (${span.measuredSectors} sectors) and the end of the disk agree. A whole-user-area read of ${span.measuredSectors} sectors is allowed.`
      : `Span check FAILED: ${span.reasons.join(" ")} A whole-user-area read is not offered; back up the partitions one by one instead.`,
    verified: span.ok,
    details: { check: span },
  };
}

function deviceLeftBus(context: HardwareContext): boolean {
  return context.transport.connected?.() === false;
}

async function reset(run: EdlRun): Promise<HardwareResult> {
  const { context, say } = run;
  await context.confirm({
    action: "edl reset",
    target: run.request.target ?? "device",
    backup: "Not applicable: nothing is read or written. The device restarts and leaves EDL; it will boot whatever its storage holds.",
    details: "Ask the device to reset. If its storage holds a working system it boots into it; if not it may fall back into EDL or stay dark. The USB connection will drop.",
  });
  throwIfAborted(context.signal);
  // The device is about to leave the bus on purpose; that disconnect is not a reason to cancel this operation.
  context.expectDeviceRestart?.(30_000);
  const state = await discoverDevice(run);
  try {
    if (state.kind === "sahara") await saharaLeave(state.link, state.hello);
    else await state.firehose.reset();
  } catch (error) {
    if (!deviceLeftBus(context) && !(error instanceof DOMException && /disconnect|NotFound|Network/i.test(`${error.name} ${error.message}`))) throw error;
    say("The device dropped off the USB bus while resetting, as expected.");
  }
  return {
    summary: "Reset requested: the device should leave EDL and start normally. Cody cannot see what it boots into.",
    verified: false,
    details: { via: state.kind },
  };
}

async function exec(run: EdlRun): Promise<HardwareResult> {
  switch (parseEdlCommand(run.request.command)) {
    case "connect": return connect(run);
    case "printgpt": return printGpt(run);
    case "check": return checkDisk(run);
    case "reset": return reset(run);
  }
}

// ---- dump ------------------------------------------------------------------

interface StreamedRead {
  readonly saved: StreamArtifact;
  readonly wireSha256: string;
}

async function streamToArtifact(run: EdlRun, opened: OpenedEdl, startSector: number, sectors: number, name: string): Promise<StreamedRead> {
  const { context } = run;
  const total = sectors * opened.storage.sectorSize;
  const hash = incrementalSha256.create();
  let received = 0;
  const report = progressReporter(context, "read", total, `Reading ${name}`);
  context.progress({ phase: "read", completed: 0, total, message: `Reading ${name}` });
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

function describeRange(first: number, sectors: number, sectorSize: number): string {
  return `sectors ${first}-${first + sectors - 1} (${sectors} sectors, ${sectors * sectorSize} bytes)`;
}

async function dumpPartition(run: EdlRun, name: string): Promise<HardwareResult> {
  const { context, request } = run;
  const opened = await openFirehose(run, { identity: "try" }, context.input);
  const { storage } = opened;
  const sectorSize = storage.sectorSize;
  const primary = await readPrimaryGpt(opened);
  const { header } = primary.table;
  if (!header.headerCrcValid || !primary.table.entriesCrcValid) {
    throw new EdlError("The primary partition table is damaged (its checksums do not match), so a partition cannot be found by name. Nothing was read. Use printgpt to see the damage.", "refused");
  }
  const matches = findPartitions(primary.table, name);
  if (matches.length === 0) {
    throw new EdlError(`The device has no partition named "${name.slice(0, 48)}". Partitions: ${primary.table.partitions.slice(0, 64).map((part) => part.name).join(", ")}.`, "refused");
  }
  if (matches.length > 1) throw new EdlError(`Two partitions are named "${name.slice(0, 48)}", so the name does not pick one. Nothing was read.`, "refused");
  const part = matches[0]!;
  if (part.lastLba >= storage.totalSectors) {
    throw new EdlError(`Partition ${part.name} ends at sector ${part.lastLba}, beyond the ${storage.totalSectors} sectors the programmer reports. Nothing was read.`, "refused");
  }
  const byteOffset = request.offset ?? 0;
  const byteLength = request.length ?? part.bytes - byteOffset;
  if (byteOffset % sectorSize !== 0 || byteLength % sectorSize !== 0) throw new EdlError(`offset and length must be multiples of the ${sectorSize}-byte sector.`, "refused");
  if (byteLength <= 0 || byteOffset + byteLength > part.bytes) throw new EdlError(`The range ${byteOffset}+${byteLength} does not lie within ${part.name} (${part.bytes} bytes).`, "refused");
  const first = part.firstLba + byteOffset / sectorSize;
  const sectors = byteLength / sectorSize;
  await context.confirm({
    action: "edl dump",
    target: name,
    offset: byteOffset,
    length: byteLength,
    backup: "Not applicable: read-only. Nothing is written to the device; the bytes become a session file with a SHA-256.",
    details: `Read ${describeRange(first, sectors, sectorSize)} of the partition ${part.name} from the eMMC user area (physical partition 0) into a session file. ${describeStorage(opened)}.`,
  });
  const fileName = `edl-${unitTag(opened)}-${fileNamePart(part.name)}${byteOffset || byteLength !== part.bytes ? `-${byteOffset}+${byteLength}` : ""}.bin`;
  const { saved } = await streamToArtifact(run, opened, first, sectors, fileName);
  run.say(`Saved ${byteLength} bytes as ${saved.fileId}, SHA-256 ${saved.sha256}.`);
  return {
    summary: `Read ${byteLength} bytes of ${part.name} (${describeRange(first, sectors, sectorSize)}).`,
    verified: true,
    sha256: saved.sha256,
    fileId: saved.fileId,
    details: { partition: part.name, firstSector: first, sectors, sectorSize, offset: byteOffset, length: byteLength, deviceHash: "not available: Cody does not ask the programmer for a digest", wireSha256: saved.sha256 },
  };
}

async function storageNote(bytes: number): Promise<string> {
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

async function dumpUserArea(run: EdlRun): Promise<HardwareResult> {
  const { context, request } = run;
  if (request.offset !== undefined || request.length !== undefined) {
    throw new EdlError("A whole-user-area read takes its size only from options.sectors, the sector count the span check verified; offset and length are not accepted here.", "refused");
  }
  const wanted = request.options?.sectors;
  const opened = await openFirehose(run, { identity: "try" }, context.input);
  const { storage } = opened;
  const { span } = await examineDisk(opened, run);
  for (const check of span.checks) run.say(`${check.passed ? "PASS" : "FAIL"}  ${check.detail}`);
  if (!span.ok) {
    throw new EdlError(`Refusing the whole-user-area read: the span check failed. ${span.reasons.join(" ")} Nothing was read. Back up the partitions one by one, or have the per-unit numbers reviewed first.`, "refused");
  }
  if (typeof wanted !== "number" || !Number.isSafeInteger(wanted) || wanted <= 0) {
    throw new EdlError(`A whole-user-area read needs an explicit sector count: pass options.sectors = ${span.measuredSectors} (the count the check just verified). Nothing was read.`, "refused");
  }
  if (wanted !== span.measuredSectors) {
    throw new EdlError(`options.sectors is ${wanted}, but the verified user area is ${span.measuredSectors} sectors. Pass exactly ${span.measuredSectors}. Nothing was read.`, "refused");
  }
  const total = span.measuredSectors * storage.sectorSize;
  const note = await storageNote(total);
  await context.confirm({
    action: "edl dump",
    target: USER_AREA,
    offset: 0,
    length: total,
    backup: "Not applicable: read-only. Nothing is written to the device; the bytes become one large session file with a SHA-256.",
    details: [
      `Read ALL ${span.measuredSectors} sectors (${formatBytes(total)}) of the eMMC user area (physical partition 0), from sector 0 to sector ${span.lastSectorLba}.`,
      `The span check passed: the partition table, the capacity ${describeStorage(opened)} and the backup table in the last sector agree.`,
      "This does not include the eMMC boot areas or RPMB. It can take a long time and needs a lot of browser storage.",
      note,
    ].filter(Boolean).join("\n"),
  });
  const fileName = `edl-${unitTag(opened)}-user-area.bin`;
  const { saved } = await streamToArtifact(run, opened, 0, span.measuredSectors, fileName);
  run.say(`Saved ${total} bytes as ${saved.fileId}, SHA-256 ${saved.sha256}.`);
  return {
    summary: `Read the whole user area: ${span.measuredSectors} sectors (${formatBytes(total)}). It does not include the eMMC boot areas or RPMB.`,
    verified: true,
    sha256: saved.sha256,
    fileId: saved.fileId,
    details: { sectors: span.measuredSectors, sectorSize: storage.sectorSize, length: total, check: span },
  };
}

async function dump(run: EdlRun): Promise<HardwareResult> {
  const target = run.request.target?.trim();
  if (!target || target.length > 64 || /[\u0000-\u001f]/.test(target)) {
    throw new EdlError(`A dump needs the exact name of a GPT partition, or "${USER_AREA}" with options.sectors.`, "refused");
  }
  return target === USER_AREA ? dumpUserArea(run) : dumpPartition(run, target);
}

// ---- entry -----------------------------------------------------------------

/** What the user is told when the operation ended because the device went away, rather than because they cancelled. */
function describeFailure(error: unknown, context: HardwareContext, say: (line: string) => void): unknown {
  if (error instanceof EdlError) return error;
  const aborted = context.signal.aborted || (error instanceof Error && error.name === "AbortError");
  if (deviceLeftBus(context)) {
    say("The device left the USB bus. It was unplugged, reset, or re-enumerated (some programmers do that right after they start); grant it again and run Connect.");
    if (aborted) return error;
    return new EdlError("The device left the USB bus during the operation. Nothing it had not finished was kept.", "protocol");
  }
  if (aborted) return error;
  if (error instanceof DOMException && /NotFound|Network|disconnect/i.test(`${error.name} ${error.message}`)) {
    return new EdlError(`The USB transfer failed (${error.name}: ${error.message}). The device was probably unplugged.`, "protocol");
  }
  return error;
}

async function runEdl(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  requireUsb(context.transport);
  const run: EdlRun = { context, request, say: (line) => context.output?.(line) };
  try {
    switch (request.action) {
      case "detect": return await detect(run);
      case "dump": return await dump(run);
      case "exec": return await exec(run);
      default: throw new EdlError(`EDL does not support ${request.action}.`, "refused");
    }
  } catch (error) {
    throw describeFailure(error, context, run.say);
  }
}

export const edlFlasher: Flasher = {
  protocol: "edl",
  actions: ["detect", "dump", "exec"],
  run: runEdl,
};
