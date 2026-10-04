import { hashBlob } from "./blob-stream";
import {
  backupTableFloor,
  describeRange,
  describeStorage,
  fileNamePart,
  formatBytes,
  hashPadded,
  locatePartition,
  paddedSource,
  partitionWriteProblem,
  streamToArtifact,
  summarizeRegion,
  unitTag,
  progressReporter,
  type RegionSummary,
  type StreamedRead,
} from "./edl-disk";
import { FirehoseRejection, grantWrites, type BlockHooks } from "./edl-firehose";
import type { GptPartition } from "./edl-gpt";
import { EdlError, edlTimeouts } from "./edl-link";
import { classifyEdlPartition } from "./edl-protect";
import { openFirehose, type EdlRun, type OpenedEdl } from "./edl-session";
import type { HardwareResult } from "./flasher";
import { throwIfAborted } from "./serial";

/**
 * Writing a named partition: flash an image into it. Every write here
 *
 *   - names its target by GPT partition NAME and writes the partition whole
 *     (an image the same size, or an explicit options.pad to fill the rest);
 *   - saves the partition's current contents first, checks that the saved file
 *     holds exactly those bytes, and refuses to write if it cannot;
 *   - asks once, with the exact sectors, the backup and (for the protected list)
 *     a typed override, and only then gets a `WriteGrant`;
 *   - writes in blocks and stops BETWEEN blocks when cancelled;
 *   - reads the partition back and compares SHA-256, and says plainly when it
 *     cannot, or when the bytes differ, always with where the old contents are.
 */

export function requirePartitionName(target: string | undefined, what: string): string {
  if (!target || target !== target.trim() || target.length > 64 || /[\u0000-\u001f]/.test(target)) {
    throw new EdlError(`${what} needs the exact name of a GPT partition as its target (no spaces around it, at most 64 characters).`, "refused");
  }
  return target;
}

function isCancel(error: unknown, run: EdlRun): boolean {
  return run.context.signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a write phase so that a cancel lands BETWEEN blocks. The link rides on a
 * signal that follows the operation's only after `edlTimeouts.cancelGrace`, so the
 * block in flight is finished first (a programmer left waiting for the rest of a
 * block would take the next command it is sent for sector data). `stop` throws the
 * cancel; the block hooks call it before every block.
 */
export async function duringWrites<T>(run: EdlRun, opened: OpenedEdl, body: (stop: () => void) => Promise<T>): Promise<T> {
  const { signal } = run.context;
  const cut = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    timer = setTimeout(() => cut.abort(new DOMException("Operation cancelled.", "AbortError")), edlTimeouts.cancelGrace);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await opened.link.using(cut.signal, () => body(() => throwIfAborted(signal)));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** What a write has done so far, kept by its block hooks so a failure can say how far it got. */
export interface WriteTally {
  /** Sectors the programmer acknowledged. */
  acknowledged: number;
  /** Sectors of the block now in flight; zero between blocks. */
  inFlight: number;
  /** The block in flight got as far as its data (or an erase command) being sent, even if only part of it was. */
  attempted: boolean;
}

export function newTally(): WriteTally {
  return { acknowledged: 0, inFlight: 0, attempted: false };
}

/** Block hooks that keep `tally`, stop between blocks on a cancel, and report progress in bytes. */
export function tallyHooks(tally: WriteTally, stop: () => void, report: (bytes: number) => void, sectorSize: number, base = 0): BlockHooks {
  const attempt = (): void => {
    tally.attempted = true;
  };
  return {
    beforeBlock(done, sectors) {
      stop();
      tally.inFlight = sectors;
      tally.attempted = false;
      report((base + done) * sectorSize);
    },
    payloadAttempted: attempt,
    commandAttempted: attempt,
    afterBlock(done, sectors) {
      tally.acknowledged = base + done + sectors;
      tally.inFlight = 0;
      tally.attempted = false;
      report(tally.acknowledged * sectorSize);
    },
  };
}

/** What an interruption needs to say, besides the error itself. */
export interface InterruptionFacts {
  readonly verb: "write" | "erase";
  /** What was being changed: a partition name, or "the restore of ..." for a whole set. */
  readonly subject: string;
  readonly totalSectors: number;
  readonly tally: WriteTally;
  /** Where the previous contents are and how to put them back. */
  readonly where: string;
}

/**
 * What an interrupted write or erase tells the user, and the error that ends the
 * operation. A cancel stays a cancel (the operation is "cancelled", with this in its
 * output); anything else becomes an error whose message is the same text.
 */
export function interruption(run: EdlRun, error: unknown, facts: InterruptionFacts): unknown {
  const { verb, subject, totalSectors, tally, where } = facts;
  const cancelled = isCancel(error, run);
  const left = run.context.transport.connected?.() === false;
  const cause = (left ? "the device left the USB bus" : cancelled ? "the operation was cancelled" : messageOf(error)).replace(/[.\s]+$/, "");
  // A write may have changed something once a block's data was sent, even part of it, whatever the programmer then said; an
  // erase once its command went out and the programmer did not refuse it. Only a refusal before any data went out is "nothing".
  const touched = tally.acknowledged > 0 || (tally.attempted && (verb === "write" || !(error instanceof FirehoseRejection)));
  const inFlight = tally.inFlight > 0 ? (verb === "write" ? `; a block of ${tally.inFlight} sector(s) was in flight, so it may be partly written` : `; the erase of the next ${tally.inFlight} sector(s) was in flight, so its outcome is unknown`) : "";
  const note = touched
    ? `POSSIBLY MODIFIED: the ${verb === "write" ? "write to" : "erase of"} ${subject} stopped (${cause}) after ${tally.acknowledged} of ${totalSectors} sectors were ${verb === "write" ? "acknowledged" : "erased"}${inFlight}. ${subject} now holds a mix of ${verb === "write" ? "the new data and its previous contents" : "erased and original contents"}. ${where}`
    : `Nothing was ${verb === "write" ? "written to" : "erased in"} ${subject}: ${cause}. Its contents are as they were.`;
  run.say(note);
  if (touched && tally.inFlight > 0 && cancelled && !left) {
    const waited = `The cancel arrived while ${verb === "write" ? "a block" : "an erase"} was in flight and it did not finish within ${edlTimeouts.cancelGrace / 1000} s, so it was cut off.`;
    run.say(verb === "write"
      ? `${waited} The programmer may still be waiting for the rest of that block and would take the next command for data: unplug the device and put it into EDL mode again before doing anything else.`
      : `${waited} Whether that erase completed is unknown: read the partition back before relying on it, and put the device into EDL mode again if the programmer stops answering.`);
  }
  return cancelled ? error : new EdlError(note, error instanceof EdlError ? error.kind : "protocol");
}

interface FlashOptions {
  readonly pad: number | undefined;
}

function parseFlashOptions(options: Record<string, unknown> | undefined): FlashOptions {
  if (!options) return { pad: undefined };
  const unknown = Object.keys(options).filter((key) => key !== "pad");
  if (unknown.length > 0) {
    throw new EdlError(`EDL flash takes only options.pad ("zero" or "ff"); ${unknown.slice(0, 3).join(", ")} ${unknown.length === 1 ? "is" : "are"} not accepted. Approvals are given in the panel, never in options.`, "refused");
  }
  if (options.pad === undefined) return { pad: undefined };
  if (options.pad === "zero") return { pad: 0x00 };
  if (options.pad === "ff") return { pad: 0xff };
  throw new EdlError('options.pad must be "zero" or "ff".', "refused");
}

/**
 * Saves what is in sectors `first` .. `first + sectors - 1` now. A copy that cannot be saved or does not match what was read
 * refuses the change. `what` names the range in the refusal ("boot_a", "the primary partition table").
 */
export async function escrowRange(run: EdlRun, opened: OpenedEdl, what: string, first: number, sectors: number, fileName: string, outcome: "written" | "erased" = "written", message?: string): Promise<StreamedRead> {
  try {
    return await streamToArtifact(run, opened, first, sectors, fileName, "escrow", message);
  } catch (error) {
    // A cancel, or the device going away, is the caller's to report; anything else means there is no saved copy.
    const deviceOrCancel = error instanceof DOMException && /^(AbortError|NotFoundError|NetworkError)$/.test(error.name);
    if (deviceOrCancel || isCancel(error, run)) throw error;
    throw new EdlError(`The current contents of ${what} could not be saved (${messageOf(error)}). Nothing was ${outcome}: Cody never ${outcome === "written" ? "writes" : "erases"} without a saved copy of what it ${outcome === "written" ? "overwrites" : "erases"}.`, error instanceof EdlError ? error.kind : "refused");
  }
}

/** Saves what is in `part` now. */
export function escrowPartition(run: EdlRun, opened: OpenedEdl, part: GptPartition, suffix: string, outcome: "written" | "erased" = "written"): Promise<StreamedRead> {
  return escrowRange(run, opened, part.name, part.firstLba, part.sectors, `edl-${unitTag(opened)}-${fileNamePart(part.name)}.${suffix}.bin`, outcome);
}

export async function flashPartition(run: EdlRun): Promise<HardwareResult> {
  const { context, request, say } = run;
  const name = requirePartitionName(request.target, "Flashing");
  if (request.offset !== undefined || request.length !== undefined) {
    throw new EdlError("EDL flash writes a whole named partition; offset and length are not accepted. Nothing was written.", "refused");
  }
  const image = context.input;
  if (!image || image.size === 0) throw new EdlError("Flashing needs an image: choose the file to write in Files & backups. Nothing was written.", "refused");
  const { pad } = parseFlashOptions(request.options);
  const kind = classifyEdlPartition(name);
  if (kind.level === "refused") throw new EdlError(`${kind.reason} Nothing was written.`, "refused");
  const imageSha256 = await hashBlob(image);
  if (request.sha256 && request.sha256.toLowerCase() !== imageSha256) {
    throw new EdlError("The image's SHA-256 is not the one the request names. Nothing was written.", "refused");
  }

  const opened = await openFirehose(run, { identity: "try", loader: "never" }, undefined);
  const { sectorSize } = opened.storage;
  const { primary, part } = await locatePartition(opened, name, "written");
  const floor = await backupTableFloor(opened, primary);
  if ("problem" in floor) throw new EdlError(`${floor.problem} Nothing was written.`, "refused");
  const unsafe = partitionWriteProblem(primary, part, opened.storage.totalSectors, sectorSize, floor.floor);
  if (unsafe) throw new EdlError(`${unsafe} Cody never writes across a partition table or another partition. Nothing was written.`, "refused");
  if (image.size > part.bytes) {
    throw new EdlError(`The image is ${image.size} bytes but ${name} is only ${part.bytes} bytes (${part.sectors} sectors). Cody never writes past the end of a partition. Nothing was written.`, "refused");
  }
  const padBytes = part.bytes - image.size;
  if (padBytes > 0 && pad === undefined) {
    throw new EdlError(`The image is ${image.size} bytes but ${name} is ${part.bytes} bytes. Cody writes a partition whole: use an image of exactly ${part.bytes} bytes, or set options.pad to "zero" or "ff" to fill the remaining ${padBytes} bytes with 0x00 or 0xFF. Nothing was written.`, "refused");
  }
  const programSha256 = padBytes > 0 ? await hashPadded(image, part.bytes, pad!) : imageSha256;
  const tag = unitTag(opened);

  say(`Saving the current contents of ${name} before anything is changed.`);
  const escrow = await escrowPartition(run, opened, part, "preflash");
  const undo = `To undo this, flash that file back to ${name}.`;
  const backup = `Saved the whole ${name} partition (${describeRange(part.firstLba, part.sectors, sectorSize)}) as ${escrow.saved.fileId}, SHA-256 ${escrow.saved.sha256}, before any change, and checked that the file holds exactly those bytes. ${undo}`;
  say(backup);

  const grant = await grantWrites(context, {
    action: "edl flash",
    target: name,
    sha256: imageSha256,
    offset: 0,
    length: image.size,
    programSha256,
    programOffset: 0,
    programLength: part.bytes,
    ...(kind.level === "protected" ? { protectedOverride: `write:${name}` } : {}),
    backup,
    details: [
      `Write ${image.size} bytes (SHA-256 ${imageSha256}) to the partition ${name}: ${describeRange(part.firstLba, part.sectors, sectorSize)} of the eMMC user area (physical partition 0).`,
      padBytes > 0 ? `The image is ${padBytes} bytes shorter than the partition; the rest is filled with ${pad === 0 ? "0x00" : "0xFF"}, so the partition is rewritten whole (final SHA-256 ${programSha256}).` : "The image is exactly the size of the partition, so the partition is rewritten whole.",
      `${describeStorage(opened)}. Disk GUID ${primary.table.header.diskGuid}.`,
      kind.level === "protected" ? `PROTECTED: ${kind.reason} Type write:${name} to approve.` : "",
      "After the write Cody reads the partition back and compares its SHA-256. A mismatch, or a read-back that cannot run, is reported together with where the previous contents are saved.",
    ].filter(Boolean).join("\n"),
  }, { label: `flash ${name}`, sectorSize, kinds: ["program"], ranges: [{ startSector: part.firstLba, sectors: part.sectors }] });

  const tally = newTally();
  const report = progressReporter(context, "write", part.bytes, `Writing ${name}`);
  say(`Writing ${name}: ${describeRange(part.firstLba, part.sectors, sectorSize)}.`);
  try {
    await duringWrites(run, opened, (stop) => opened.firehose.writeSectors(
      grant,
      part.firstLba,
      part.sectors,
      sectorSize,
      padBytes > 0 ? paddedSource(image, pad!) : paddedSource(image, 0),
      tallyHooks(tally, stop, report, sectorSize),
    ));
  } catch (error) {
    throw interruption(run, error, { verb: "write", subject: name, totalSectors: part.sectors, tally, where: `Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}). ${undo}` });
  } finally {
    grant.revoke();
  }

  say(`The programmer acknowledged every block. Reading ${name} back to check it.`);
  let back: RegionSummary;
  try {
    back = await summarizeRegion(run, opened, part.firstLba, part.sectors, "verify", `Reading ${name} back`);
  } catch (error) {
    if (isCancel(error, run)) {
      say(`Cancelled before the read-back finished: the write to ${name} was acknowledged but is UNVERIFIED. Its previous contents are saved as ${escrow.saved.fileId}.`);
      throw error;
    }
    if (!(error instanceof FirehoseRejection)) {
      throw new EdlError(`The write to ${name} was acknowledged, but reading it back failed (${messageOf(error)}). UNVERIFIED, and ${name} is POSSIBLY MODIFIED. Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}). ${undo}`, error instanceof EdlError ? error.kind : "protocol");
    }
    const unverified = `UNVERIFIED: the programmer acknowledged the write to ${name} but would not read it back (${error.message}), so the write was not checked. Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}).`;
    say(unverified);
    return { summary: unverified, verified: false, details: { partition: name, firstSector: part.firstLba, sectors: part.sectors, imageSha256, programSha256, backup: escrow.saved, readback: "refused" } };
  }
  if (back.sha256 !== programSha256) {
    throw new EdlError(`READ-BACK MISMATCH on ${name}: the programmer acknowledged every block, but the partition reads back as SHA-256 ${back.sha256}, not ${programSha256}. ${name} is POSSIBLY MODIFIED and holds contents that were not verified. Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}). ${undo} Nothing was retried.`, "protocol");
  }
  const summary = `Flashed ${name}: ${formatBytes(image.size)}${padBytes > 0 ? ` padded with ${pad === 0 ? "zeros" : "0xFF"} to ${formatBytes(part.bytes)}` : ""}, read back identical (SHA-256 ${back.sha256}). The previous contents are saved as ${escrow.saved.fileId}.`;
  say(summary);
  return {
    summary,
    verified: true,
    sha256: back.sha256,
    details: {
      partition: name,
      firstSector: part.firstLba,
      sectors: part.sectors,
      sectorSize,
      imageBytes: image.size,
      paddedBytes: padBytes,
      pad: padBytes > 0 ? (pad === 0 ? "zero" : "ff") : null,
      imageSha256,
      programSha256,
      readbackSha256: back.sha256,
      protectedPartition: kind.level === "protected",
      backup: escrow.saved,
      unit: tag,
    },
  };
}

/**
 * Erases one named partition with the programmer's own `erase`. Like a flash it saves the
 * partition first, asks once (typed `write:<name>` for the protected list), erases in
 * segments that a cancel can stop between, and reads the partition back. What the
 * region holds afterwards is REPORTED (all zero, all 0xFF, unchanged, mixed), never
 * assumed: an eMMC erase may leave either value, or only mark the blocks unused.
 */
export async function erasePartition(run: EdlRun): Promise<HardwareResult> {
  const { context, request, say } = run;
  const name = requirePartitionName(request.target, "Erasing");
  if (request.offset !== undefined || request.length !== undefined) {
    throw new EdlError("EDL erase erases a whole named partition; offset and length are not accepted. Nothing was erased.", "refused");
  }
  if (context.input || request.fileId || request.sha256) throw new EdlError("An erase takes no file. Nothing was erased.", "refused");
  if (request.options && Object.keys(request.options).length > 0) {
    throw new EdlError("An erase takes no options. Approvals are given in the panel, never in options. Nothing was erased.", "refused");
  }
  const kind = classifyEdlPartition(name);
  if (kind.level === "refused") throw new EdlError(`${kind.reason} Nothing was erased.`, "refused");

  const opened = await openFirehose(run, { identity: "try", loader: "never" }, undefined);
  const { sectorSize } = opened.storage;
  const { primary, part } = await locatePartition(opened, name, "erased");
  const floor = await backupTableFloor(opened, primary);
  if ("problem" in floor) throw new EdlError(`${floor.problem} Nothing was erased.`, "refused");
  const unsafe = partitionWriteProblem(primary, part, opened.storage.totalSectors, sectorSize, floor.floor);
  if (unsafe) throw new EdlError(`${unsafe} Cody never erases across a partition table or another partition. Nothing was erased.`, "refused");

  say(`Saving the current contents of ${name} before anything is changed.`);
  const escrow = await escrowPartition(run, opened, part, "preerase", "erased");
  const undo = `To undo this, flash that file back to ${name}.`;
  const backup = `Saved the whole ${name} partition (${describeRange(part.firstLba, part.sectors, sectorSize)}) as ${escrow.saved.fileId}, SHA-256 ${escrow.saved.sha256}, before any change, and checked that the file holds exactly those bytes. ${undo}`;
  say(backup);

  const grant = await grantWrites(context, {
    action: "edl erase",
    target: name,
    offset: 0,
    length: part.bytes,
    ...(kind.level === "protected" ? { protectedOverride: `write:${name}` } : {}),
    backup,
    details: [
      `Erase the partition ${name} with the programmer's erase command: ${describeRange(part.firstLba, part.sectors, sectorSize)} of the eMMC user area (physical partition 0).`,
      `${describeStorage(opened)}. Disk GUID ${primary.table.header.diskGuid}.`,
      kind.level === "protected" ? `PROTECTED: ${kind.reason} Type write:${name} to approve.` : "",
      "What the partition holds afterwards depends on the chip: an eMMC erase may leave zeros, 0xFF, or only mark the blocks unused. After the erase Cody reads the partition back and reports what it actually reads as; it claims no particular value.",
    ].filter(Boolean).join("\n"),
  }, { label: `erase ${name}`, sectorSize, kinds: ["erase"], ranges: [{ startSector: part.firstLba, sectors: part.sectors }] });

  const tally = newTally();
  const report = progressReporter(context, "erase", part.bytes, `Erasing ${name}`);
  say(`Erasing ${name}: ${describeRange(part.firstLba, part.sectors, sectorSize)}.`);
  try {
    await duringWrites(run, opened, (stop) => opened.firehose.eraseSectors(grant, part.firstLba, part.sectors, sectorSize, tallyHooks(tally, stop, report, sectorSize)));
  } catch (error) {
    throw interruption(run, error, { verb: "erase", subject: name, totalSectors: part.sectors, tally, where: `Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}). ${undo}` });
  } finally {
    grant.revoke();
  }

  say(`The programmer acknowledged the erase. Reading ${name} back to see what it holds now.`);
  let back: RegionSummary;
  try {
    back = await summarizeRegion(run, opened, part.firstLba, part.sectors, "verify", `Reading ${name} back`);
  } catch (error) {
    if (isCancel(error, run)) {
      say(`Cancelled before the read-back finished: the erase of ${name} was acknowledged but its result is UNVERIFIED. Its previous contents are saved as ${escrow.saved.fileId}.`);
      throw error;
    }
    if (!(error instanceof FirehoseRejection)) {
      throw new EdlError(`The erase of ${name} was acknowledged, but reading it back failed (${messageOf(error)}). UNVERIFIED, and ${name} is POSSIBLY MODIFIED. Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}). ${undo}`, error instanceof EdlError ? error.kind : "protocol");
    }
    const unverified = `UNVERIFIED: the programmer acknowledged the erase of ${name} but would not read it back (${error.message}), so its result was not checked. Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}).`;
    say(unverified);
    return { summary: unverified, verified: false, details: { partition: name, firstSector: part.firstLba, sectors: part.sectors, backup: escrow.saved, readback: "refused" } };
  }
  const state = back.allZero ? "zero" : back.allOnes ? "ff" : back.sha256 === escrow.saved.sha256 ? "unchanged" : "mixed";
  const saved = `The previous contents are saved as ${escrow.saved.fileId}.`;
  const summary = state === "zero" ? `Erased ${name}: it now reads as all zero bytes (0x00) (SHA-256 ${back.sha256}). ${saved}`
    : state === "ff" ? `Erased ${name}: it now reads as all 0xFF bytes (SHA-256 ${back.sha256}). ${saved}`
      : state === "unchanged" ? `UNCHANGED: the programmer acknowledged the erase of ${name}, but the partition still reads exactly as before. Some eMMC erase commands only mark blocks unused. ${saved}`
        : `${name} was changed but not left uniform: it now reads as mixed contents, neither all zero nor all 0xFF (SHA-256 ${back.sha256}). Cody claims no particular erased value. ${saved}`;
  say(summary);
  return {
    summary,
    verified: state === "zero" || state === "ff",
    sha256: back.sha256,
    details: { partition: name, firstSector: part.firstLba, sectors: part.sectors, sectorSize, state, readbackSha256: back.sha256, protectedPartition: kind.level === "protected", backup: escrow.saved },
  };
}

/**
 * `setbootablestoragedrive N`: asks the programmer to make drive N the one the boot ROM starts from. It changes no
 * partition, but it can change what the unit boots, and nothing in the protocol lets Cody read the setting before or
 * after: there is no saved copy to offer and the result is UNVERIFIED however the programmer answers. The typed override
 * `set-bootable:<N>` is the user's explicit acceptance of that.
 */
export async function setBootableDrive(run: EdlRun): Promise<HardwareResult> {
  const { context, request, say } = run;
  const target = request.target;
  if (target === undefined || !/^[0-7]$/.test(target)) {
    throw new EdlError("setbootablestoragedrive needs the drive number, a single digit from 0 to 7, as its target. Nothing was sent.", "refused");
  }
  if (request.offset !== undefined || request.length !== undefined || context.input || request.fileId || request.sha256) {
    throw new EdlError("setbootablestoragedrive takes a drive number only: no file, offset or length. Nothing was sent.", "refused");
  }
  if (request.options && Object.keys(request.options).length > 0) {
    throw new EdlError("setbootablestoragedrive takes no options. Approvals are given in the panel, never in options. Nothing was sent.", "refused");
  }
  const drive = Number(target);

  const opened = await openFirehose(run, { identity: "try", loader: "never" }, undefined);
  const override = `set-bootable:${drive}`;
  const grant = await grantWrites(context, {
    action: "edl setbootablestoragedrive",
    target,
    protectedOverride: override,
    backup: "Backup unavailable: the programmer cannot report which drive the boot ROM starts from, so there is no saved copy of the current setting and no automatic way to put it back.",
    details: [
      `Tell the programmer to set the bootable storage drive to ${drive} (Firehose setbootablestoragedrive).`,
      "It is the programmer's way of choosing the storage drive the boot ROM starts from; what a given number means is up to the programmer, and Cody does not know what it means on this unit. No partition is read or changed.",
      "Cody cannot read the setting before or after, so the change is UNVERIFIED and the previous value is unknown. A wrong value can leave the unit unable to start; putting it into EDL mode again is the way back.",
      `${describeStorage(opened)}.`,
      `Type ${override} to approve.`,
    ].join("\n"),
  }, { label: `set the bootable storage drive to ${drive}`, sectorSize: opened.storage.sectorSize, kinds: ["set-bootable"], drive });

  const sentBefore = opened.link.bytesSent;
  try {
    await opened.firehose.setBootableDrive(grant, drive);
  } catch (error) {
    const sent = opened.link.bytesSent > sentBefore;
    if (error instanceof FirehoseRejection) {
      throw new EdlError(`${error.message} The programmer did not apply it, so the boot drive setting is as it was.`, "rejected");
    }
    if (!sent) throw error;
    const cause = (run.context.transport.connected?.() === false ? "the device left the USB bus" : isCancel(error, run) ? "the operation was cancelled" : messageOf(error)).replace(/[.\s]+$/, "");
    const note = `POSSIBLY CHANGED: setbootablestoragedrive ${drive} was sent, but the programmer's answer did not arrive (${cause}). Whether the boot drive changed is unknown, and Cody cannot read it back. If the unit does not start as expected, put it into EDL mode again.`;
    say(note);
    if (isCancel(error, run)) throw error;
    throw new EdlError(note, error instanceof EdlError ? error.kind : "protocol");
  } finally {
    grant.revoke();
  }

  const summary = `UNVERIFIED: the programmer acknowledged setbootablestoragedrive ${drive}. Cody cannot read this setting back, so whether the unit will now start from drive ${drive} is not known, and the previous value was not known either. Use Reset to leave EDL and watch what the unit does; putting it into EDL mode again is the way back.`;
  say(summary);
  return { summary, verified: false, details: { drive, readback: "not possible: the protocol has no way to read the setting", previous: "unknown" } };
}
