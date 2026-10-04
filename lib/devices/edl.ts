import {
  describeRange,
  describeStorage,
  examineDisk,
  fileNamePart,
  formatBytes,
  locatePartition,
  saveSmall,
  storageNote,
  streamToArtifact,
  unitTag,
} from "./edl-disk";
import { backupSet, restoreSet } from "./edl-backup";
import type { GptPartition, GptTable } from "./edl-gpt";
import { EdlError } from "./edl-link";
import { saharaLeave } from "./edl-sahara";
import { describeIdentity, discoverDevice, inspectDevice, openFirehose, type EdlRun } from "./edl-session";
import { erasePartition, flashPartition, setBootableDrive } from "./edl-write";
import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
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
 *   exec backup   every partition and both partition tables, saved as session files with a manifest that names them and
 *                 the unit they came from (edl-backup.ts)
 *   exec restore  put such a set back on the same unit: matched by chip serial, public-key hash, eMMC serial and disk GUID,
 *                 what it overwrites saved first, one typed approval, partition tables last, every region read back
 *   exec setbootablestoragedrive  choose the storage drive the boot ROM starts from (target = the drive number), only
 *                 with a typed approval, and always UNVERIFIED: nothing can read the setting back
 *   dump NAME     one GPT partition into a session file with its SHA-256
 *   dump user-area  the whole user area, only with an explicit sector count and
 *                 only when `check` passes in the same operation
 *   flash NAME    write an image into one GPT partition (edl-write.ts): saved
 *                 copy first, one confirmation, typed override for the protected
 *                 boot chain and identity partitions, read-back afterwards
 *
 * Everything that changes storage lives in edl-write.ts and goes through a
 * `WriteGrant` (edl-firehose.ts); the read-only commands here never write.
 */

const USER_AREA = "user-area";
const MAX_LISTED_PARTITIONS = 256;

function requireUsb(transport: HardwareTransport): void {
  if (transport.kind !== "usb") throw new EdlError("Qualcomm EDL needs a USB bulk transport.", "refused");
}

function partitionLines(table: GptTable): string[] {
  return table.partitions.slice(0, MAX_LISTED_PARTITIONS).map((part) => `${String(part.index).padStart(3)}  ${part.name.padEnd(24)} sectors ${part.firstLba}-${part.lastLba}  ${formatBytes(part.bytes)}`);
}

function describePartitions(parts: readonly GptPartition[]): Record<string, unknown>[] {
  return parts.slice(0, MAX_LISTED_PARTITIONS).map((part) => ({ index: part.index, name: part.name, firstLba: part.firstLba, lastLba: part.lastLba, sectors: part.sectors, bytes: part.bytes, typeGuid: part.typeGuid, uniqueGuid: part.uniqueGuid }));
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

type EdlCommand = "connect" | "printgpt" | "check" | "reset" | "erase" | "backup" | "restore" | "setbootablestoragedrive";

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
  erase: "erase",
  backup: "backup",
  restore: "restore",
  setbootablestoragedrive: "setbootablestoragedrive",
};

export function parseEdlCommand(command: string | undefined): EdlCommand {
  const word = (command ?? "").trim().replace(/^edl\s+/i, "").toLowerCase();
  const found = Object.hasOwn(COMMAND_NAMES, word) ? COMMAND_NAMES[word] : undefined;
  if (!found) throw new EdlError(`"${(command ?? "").trim().slice(0, 40)}" is not an EDL command Cody offers. Use connect, printgpt, check, erase (the partition name goes in target), backup, restore (options.manifestSha256 names the set), setbootablestoragedrive (the drive number goes in target) or reset.`, "refused");
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
    case "erase": return erasePartition(run);
    case "backup": return backupSet(run);
    case "restore": return restoreSet(run);
    case "setbootablestoragedrive": return setBootableDrive(run);
  }
}

// ---- dump ------------------------------------------------------------------

async function dumpPartition(run: EdlRun, name: string): Promise<HardwareResult> {
  const { context, request } = run;
  const opened = await openFirehose(run, { identity: "try" }, context.input);
  const { storage } = opened;
  const sectorSize = storage.sectorSize;
  const { part } = await locatePartition(opened, name, "read");
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
      case "flash": return await flashPartition(run);
      default: throw new EdlError(`EDL does not support ${request.action}.`, "refused");
    }
  } catch (error) {
    throw describeFailure(error, context, run.say);
  }
}

export const edlFlasher: Flasher = {
  protocol: "edl",
  actions: ["detect", "dump", "exec", "flash"],
  run: runEdl,
};
