import { hashBlob } from "./blob-stream";
import {
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

/** A block that was cut in two leaves the programmer waiting for data; this is how large a command can be, to tell whether data went out. */
const COMMAND_BYTES_CEILING = 1024;

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
  /** Bytes the link had sent when the current block began. */
  sentAtBlockStart: number;
}

export function newTally(): WriteTally {
  return { acknowledged: 0, inFlight: 0, sentAtBlockStart: 0 };
}

/** Block hooks that keep `tally`, stop between blocks on a cancel, and report progress in bytes. */
export function tallyHooks(opened: OpenedEdl, tally: WriteTally, stop: () => void, report: (bytes: number) => void, sectorSize: number, base = 0): BlockHooks {
  return {
    beforeBlock(done, sectors) {
      stop();
      tally.inFlight = sectors;
      tally.sentAtBlockStart = opened.link.bytesSent;
      report((base + done) * sectorSize);
    },
    afterBlock(done, sectors) {
      tally.acknowledged = base + done + sectors;
      tally.inFlight = 0;
      report(tally.acknowledged * sectorSize);
    },
  };
}

/**
 * What an interrupted write tells the user, and the error that ends the operation.
 * A cancel stays a cancel (the operation is "cancelled", with this in its output);
 * anything else becomes an error whose message is the same text.
 */
export function interruption(run: EdlRun, opened: OpenedEdl, error: unknown, subject: string, totalSectors: number, tally: WriteTally, where: string): unknown {
  const cancelled = isCancel(error, run);
  const left = run.context.transport.connected?.() === false;
  const cause = (left ? "the device left the USB bus" : cancelled ? "the operation was cancelled" : messageOf(error)).replace(/[.\s]+$/, "");
  const dataSent = tally.acknowledged > 0 || (tally.inFlight > 0 && opened.link.bytesSent - tally.sentAtBlockStart > COMMAND_BYTES_CEILING);
  const note = dataSent
    ? `POSSIBLY MODIFIED: the write to ${subject} stopped (${cause}) after ${tally.acknowledged} of ${totalSectors} sectors were acknowledged${tally.inFlight > 0 ? `; a block of ${tally.inFlight} sector(s) was in flight, so it may be partly written` : ""}. ${subject} now holds a mix of the new data and its previous contents. ${where}`
    : `Nothing was written to ${subject}: ${cause}. Its contents are as they were.`;
  run.say(note);
  if (dataSent && tally.inFlight > 0 && cancelled && !left) {
    run.say(`The cancel arrived while a block was in flight and the block did not finish within ${edlTimeouts.cancelGrace / 1000} s, so it was cut off. The programmer may still be waiting for the rest of that block and would take the next command for data: unplug the device and put it into EDL mode again before doing anything else.`);
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

/** Saves what is in `part` now. A copy that cannot be saved or does not match what was read refuses the write. */
export async function escrowPartition(run: EdlRun, opened: OpenedEdl, part: GptPartition, suffix: string): Promise<StreamedRead> {
  const fileName = `edl-${unitTag(opened)}-${fileNamePart(part.name)}.${suffix}.bin`;
  try {
    return await streamToArtifact(run, opened, part.firstLba, part.sectors, fileName, "escrow");
  } catch (error) {
    // A cancel, or the device going away, is the caller's to report; anything else means there is no saved copy.
    const deviceOrCancel = error instanceof DOMException && /^(AbortError|NotFoundError|NetworkError)$/.test(error.name);
    if (deviceOrCancel || isCancel(error, run)) throw error;
    throw new EdlError(`The current contents of ${part.name} could not be saved (${messageOf(error)}). Nothing was written: Cody never writes without a saved copy of what it overwrites.`, error instanceof EdlError ? error.kind : "refused");
  }
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
  const unsafe = partitionWriteProblem(primary, part, opened.storage.totalSectors, sectorSize);
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
      tallyHooks(opened, tally, stop, report, sectorSize),
    ));
  } catch (error) {
    throw interruption(run, opened, error, name, part.sectors, tally, `Its previous contents are saved as ${escrow.saved.fileId} (SHA-256 ${escrow.saved.sha256}). ${undo}`);
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
