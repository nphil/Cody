import { hashBlob } from "./blob-stream";
import {
  describeRange,
  describeStorage,
  examineDisk,
  fileNamePart,
  formatBytes,
  paddedSource,
  partitionWriteProblem,
  progressReporter,
  readLiveDiskGuid,
  saveSmall,
  storageNote,
  streamToArtifact,
  summarizeRegion,
  unitTag,
} from "./edl-disk";
import { FirehoseRejection, grantWrites } from "./edl-firehose";
import { EdlError } from "./edl-link";
import {
  bootRomMismatches,
  buildManifest,
  encodeManifest,
  identityGaps,
  manifestShort,
  normalizeChipSerial,
  parseManifest,
  planRestore,
  restoreOverride,
  sha256Hex,
  storageMismatches,
  type RestorePlan,
  type RestoreRegion,
  type SetPartition,
  type SetUnit,
} from "./edl-manifest";
import { classifyEdlPartition } from "./edl-protect";
import { openFirehose, type EdlRun } from "./edl-session";
import { duringWrites, escrowRange, interruption, newTally, tallyHooks } from "./edl-write";
import type { HardwareResult, StreamArtifact } from "./flasher";
import { throwIfAborted } from "./serial";

/**
 * Backup sets and their restore.
 *
 *   exec backup    the partition tables and every partition, each saved as a session file, plus a manifest that names
 *                  them by SHA-256 and says which unit they came from. Read-only.
 *   exec restore   puts a set back on the SAME unit: it is matched to the unit by chip serial, public-key hash (both from a
 *                  boot ROM that is read in this very operation), eMMC serial and disk GUID before the loader is even
 *                  confirmed; what it will overwrite is saved first; ONE typed approval (`restore:<manifest sha8>`)
 *                  covers the exact ranges; partitions are written first, then the backup table, then the primary table
 *                  last, and every region written is read back and compared before the next is started.
 */

/** A cap on how many names a sentence lists. */
const LISTED_NAMES = 12;
/** A confirmation's details are refused above 8 KiB, and the write grant adds its own lines. */
const MAX_DETAIL_CHARS = 6000;

function refused(message: string): EdlError {
  return new EdlError(message, "refused");
}

function listed(labels: readonly string[]): string {
  if (labels.length === 0) return "none";
  return `${labels.slice(0, LISTED_NAMES).join(", ")}${labels.length > LISTED_NAMES ? ` and ${labels.length - LISTED_NAMES} more` : ""}`;
}

/** Joins lines but stops adding when the text would no longer fit a confirmation. */
function fitted(lines: readonly string[]): string {
  let text = "";
  for (const line of lines) {
    if (line === "") continue;
    if (text.length + line.length + 1 > MAX_DETAIL_CHARS) return `${text}\n…the rest is in the operation output.`;
    text += `${text ? "\n" : ""}${line}`;
  }
  return text;
}

// ---- backup ------------------------------------------------------------------------------------------------------------

export async function backupSet(run: EdlRun): Promise<HardwareResult> {
  const { context, request, say } = run;
  if (request.target !== undefined || request.offset !== undefined || request.length !== undefined) {
    throw refused("A backup set covers the whole disk and takes no target, offset or length. Nothing was read.");
  }
  if (request.options && Object.keys(request.options).length > 0) throw refused("A backup set takes no options. Nothing was read.");

  const opened = await openFirehose(run, { identity: "try" }, context.input);
  const { sectorSize, totalSectors } = opened.storage;
  const { primary, backup, span } = await examineDisk(opened, run);
  say(describeStorage(opened));
  for (const check of span.checks) say(`${check.passed ? "PASS" : "FAIL"}  ${check.detail}`);
  if (!span.ok) {
    throw refused(`Refusing the backup set: the span check failed. ${span.reasons.join(" ")} A set taken from tables that are damaged, or that disagree with the disk, could not be restored safely. Nothing was saved. Back up the partitions one by one instead.`);
  }
  const { region: backupRegion, firstLba: backupFirst, sectors: backupSectors } = backup;
  if (!backupRegion || backupFirst === null || backupSectors === null) throw refused("The backup partition table at the end of the disk could not be read. Nothing was saved.");
  const guid = primary.table.header.diskGuid;
  const parts = [...primary.table.partitions].sort((left, right) => left.firstLba - right.firstLba);
  if (parts.length === 0) throw refused("The partition table lists no partitions, so there is nothing to save as a set. Nothing was saved.");

  // What a restore would refuse to write is still worth saving, but the set is then not restorable and says so.
  const problems: string[] = [];
  for (const part of parts) {
    const kind = classifyEdlPartition(part.name);
    if (kind.level === "refused") problems.push(`${kind.reason} A restore would have to write ${part.name}.`);
    const unsafe = partitionWriteProblem(primary, part, totalSectors, sectorSize);
    if (unsafe) problems.push(`${unsafe} A restore would refuse to write it.`);
    if (/[\u0000-\u001f\u007f]/.test(part.name)) problems.push(`The name of partition ${part.index} contains a control character, which a manifest cannot carry.`);
  }
  const identity = opened.identity;
  const programmerSerial = normalizeChipSerial(opened.firehose.chipSerial);
  const unit: SetUnit = {
    chipSerial: identity?.serial ?? programmerSerial,
    chipSerialSource: identity ? "boot-rom" : programmerSerial ? "programmer" : null,
    hardwareId: identity?.hardwareId ?? null,
    pkHash: identity?.pkHash?.toLowerCase() ?? null,
    emmcSerial: opened.storage.serialNumber,
    emmcProduct: opened.storage.productName,
    diskGuid: guid,
  };

  const totalBytes = (primary.regionSectors + backupSectors + parts.reduce((sum, part) => sum + part.sectors, 0)) * sectorSize;
  await context.confirm({
    action: "edl backup",
    target: `backup set of disk ${guid}`,
    backup: "Not applicable: read-only. Nothing is written to the device; the bytes become session files with a SHA-256 each, and a manifest that names them.",
    details: fitted([
      `Read both partition tables and ${parts.length} partition(s) of disk ${guid}, ${formatBytes(totalBytes)} in all, from the eMMC user area (physical partition 0), and save each as a session file.`,
      `${describeStorage(opened)}. The span check passed: the tables, the capacity and the end of the disk agree.`,
      identity
        ? `Unit: chip serial 0x${identity.serial}, public-key hash ${identity.pkHash ?? "not available"}, eMMC serial ${unit.emmcSerial ?? "not reported"}.`
        : "WARNING: a programmer was already running, so the boot ROM's identity (chip serial, public-key hash) was not read. The set is saved, but Cody will NOT restore a set it cannot match to a unit. To get one it can restore, put the device into EDL mode again and take the set from there, with the loader chosen.",
      problems.length > 0 ? `NOT RESTORABLE: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ""}` : "",
      "A set holds the partitions and both partition tables. Bytes outside them, the eMMC boot areas and RPMB are not part of it.",
      await storageNote(totalBytes),
    ]),
  });

  const tag = unitTag(opened);
  let savedCount = 0;
  const partitions: SetPartition[] = [];
  const primaryName = `edl-${tag}-set-gpt-primary.bin`;
  const backupName = `edl-${tag}-set-gpt-backup.bin`;
  try {
    const primaryFile = await saveSmall(context, primaryName, primary.region);
    savedCount += 1;
    say(`Saved the primary partition table (sectors 0-${primary.regionSectors - 1}) as ${primaryFile.fileId}.`);
    for (const [position, part] of parts.entries()) {
      const fileName = `edl-${tag}-set-p${part.index}-${fileNamePart(part.name)}.bin`;
      const label = part.name || `partition ${part.index}`;
      const { saved } = await streamToArtifact(run, opened, part.firstLba, part.sectors, fileName, "read", `Reading ${label} (${position + 1} of ${parts.length})`);
      savedCount += 1;
      say(`Saved ${label} (${describeRange(part.firstLba, part.sectors, sectorSize)}) as ${saved.fileId}, SHA-256 ${saved.sha256}.`);
      partitions.push({ index: part.index, name: part.name.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD"), firstLba: part.firstLba, sectors: part.sectors, sha256: saved.sha256, fileName });
    }
    const backupFile = await saveSmall(context, backupName, backupRegion);
    savedCount += 1;
    say(`Saved the backup partition table at the end of the disk (sectors ${backupFirst}-${totalSectors - 1}) as ${backupFile.fileId}.`);
    const manifest = buildManifest({
      createdAt: new Date().toISOString(),
      unit,
      sectorSize,
      measuredSectors: totalSectors,
      programmerTarget: opened.configuration.targetName,
      loaderSha256: opened.loader?.sha256 ?? null,
      primary: { firstLba: 0, sectors: primary.regionSectors, sha256: primaryFile.sha256, fileName: primaryName },
      backup: { firstLba: backupFirst, sectors: backupSectors, sha256: backupFile.sha256, fileName: backupName },
      partitions,
      problems,
    });
    const bytes = encodeManifest(manifest);
    const digest = sha256Hex(bytes);
    const manifestName = `edl-${tag}-set-${manifestShort(digest)}.manifest.json`;
    const manifestFile = await saveSmall(context, manifestName, bytes);
    savedCount += 1;
    const restorable = manifest.restorable;
    const summary = `Backup set ${manifestShort(digest)} saved: ${parts.length} partition(s) and both partition tables of disk ${guid}, ${formatBytes(totalBytes)}. Manifest ${manifestFile.fileId}, SHA-256 ${digest}. ${restorable
      ? "To put it back on this unit, put the device into EDL mode again and run exec restore with the loader as the file and options.manifestSha256 set to that SHA-256."
      : `NOT RESTORABLE by Cody: ${manifest.notRestorableBecause.join(" ")}`}`;
    say(summary);
    return {
      summary,
      verified: true,
      sha256: digest,
      fileId: manifestFile.fileId,
      details: {
        manifest: { fileId: manifestFile.fileId, sha256: digest, name: manifestName },
        restorable,
        notRestorableBecause: manifest.notRestorableBecause,
        unit,
        geometry: manifest.geometry,
        diskGuid: guid,
        files: {
          primary: { fileId: primaryFile.fileId, sha256: primaryFile.sha256, sectors: primary.regionSectors },
          backup: { fileId: backupFile.fileId, sha256: backupFile.sha256, sectors: backupSectors },
        },
        partitions: partitions.map((part) => ({ index: part.index, name: part.name, firstLba: part.firstLba, sectors: part.sectors, sha256: part.sha256, fileName: part.fileName })),
      },
    };
  } catch (error) {
    if (savedCount > 0) say(`Stopped after saving ${savedCount} file(s). There is no manifest, so there is no usable set; the files stay in Files & backups.`);
    throw error;
  }
}

// ---- restore -----------------------------------------------------------------------------------------------------------

function parseRestoreRequest(run: EdlRun): string {
  const { context, request } = run;
  if (request.target !== undefined || request.offset !== undefined || request.length !== undefined) {
    throw refused("A restore takes no target, offset or length: the backup set names everything. Nothing was written.");
  }
  const options = request.options ?? {};
  const extra = Object.keys(options).filter((key) => key !== "manifestSha256");
  if (extra.length > 0) {
    throw refused(`A restore takes only options.manifestSha256; ${extra.slice(0, 3).join(", ")} ${extra.length === 1 ? "is" : "are"} not accepted. Approvals are given in the panel, never in options. Nothing was written.`);
  }
  const digest = options.manifestSha256;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
    throw refused("options.manifestSha256 must be the SHA-256 (64 hex digits) of the backup set's manifest file. Nothing was written.");
  }
  if (!context.input || !request.fileId) {
    throw refused("A restore starts from a device freshly put into EDL mode, so it needs the programmer (loader) file as its file: choose it in Files & backups. Nothing was written.");
  }
  if (!context.findArtifact) throw refused("This client cannot look up the saved files of a backup set by their SHA-256. Nothing was written.");
  return digest.toLowerCase();
}

interface LoadedSet {
  readonly plan: RestorePlan;
  /** The bytes each region is written from, by region. */
  readonly blobs: ReadonlyMap<RestoreRegion, Blob>;
}

/** Finds the manifest and every file it names in the session, hashes each, and checks the set against itself. Touches no device. */
async function loadSet(run: EdlRun, manifestSha256: string): Promise<LoadedSet> {
  const { context, say } = run;
  const find = context.findArtifact!;
  const manifestBlob = await find(manifestSha256);
  if (!manifestBlob) {
    throw refused(`This session has no file with SHA-256 ${manifestSha256}. Choose the backup set's manifest in Files & backups (it was saved by exec backup) and use its SHA-256. Nothing was written.`);
  }
  if (manifestBlob.size > 1024 * 1024) throw refused("The manifest file is far larger than a backup set's manifest. Nothing was written.");
  if ((await hashBlob(manifestBlob)) !== manifestSha256) throw refused("The manifest file no longer has the SHA-256 it was chosen by. Nothing was written.");
  const manifest = parseManifest(await manifestBlob.text());
  const { sectorSize } = manifest.geometry;

  const wanted: Array<{ name: string; sha256: string; sectors: number }> = [
    { name: "the primary partition table", sha256: manifest.gpt.primary.sha256, sectors: manifest.gpt.primary.sectors },
    { name: "the backup partition table", sha256: manifest.gpt.backup.sha256, sectors: manifest.gpt.backup.sectors },
    ...manifest.partitions.map((part) => ({ name: part.name || `partition ${part.index}`, sha256: part.sha256, sectors: part.sectors })),
  ];
  const totalBytes = wanted.reduce((sum, entry) => sum + entry.sectors * sectorSize, 0);
  const found = new Map<string, Blob>();
  const missing: string[] = [];
  for (const entry of wanted) {
    if (found.has(entry.sha256)) continue;
    const blob = await find(entry.sha256);
    if (blob) found.set(entry.sha256, blob);
    else missing.push(`${entry.name} (${entry.sha256.slice(0, 12)}…)`);
  }
  if (missing.length > 0) {
    throw refused(`The session is missing ${missing.length} file(s) of this backup set: ${listed(missing)}. Add them in Files & backups (they were saved by exec backup). Nothing was written.`);
  }
  let hashed = 0;
  const checked = new Set<string>();
  for (const entry of wanted) {
    throwIfAborted(context.signal);
    const blob = found.get(entry.sha256)!;
    if (blob.size !== entry.sectors * sectorSize) {
      throw refused(`The saved file for ${entry.name} is ${blob.size} bytes, but the set describes ${entry.sectors * sectorSize}. Nothing was written.`);
    }
    if (!checked.has(entry.sha256)) {
      context.progress({ phase: "prepare", completed: hashed, total: totalBytes, message: `Checking ${entry.name} against the manifest` });
      if ((await hashBlob(blob)) !== entry.sha256) throw refused(`The saved file for ${entry.name} no longer has the SHA-256 the manifest names. Nothing was written.`);
      checked.add(entry.sha256);
    }
    hashed += blob.size;
  }
  context.progress({ phase: "prepare", completed: totalBytes, total: totalBytes, message: "The saved files match the manifest" });

  const plan = planRestore(
    manifest,
    new Uint8Array(await found.get(manifest.gpt.primary.sha256)!.arrayBuffer()),
    new Uint8Array(await found.get(manifest.gpt.backup.sha256)!.arrayBuffer()),
  );
  say(`Backup set ${manifestShort(manifestSha256)}: ${manifest.partitions.length} partition(s) and both partition tables of disk ${manifest.unit.diskGuid}, taken ${manifest.createdAt}; every file is present and matches its digest.`);
  return { plan, blobs: new Map<RestoreRegion, Blob>(plan.regions.map((region): [RestoreRegion, Blob] => [region, found.get(region.sha256)!])) };
}

/** What an interrupted restore knows about each region, for the account it gives. */
interface RestoreProgress {
  done: RestoreRegion[];
  current: RestoreRegion | undefined;
  stage: "being written" | "written, being read back" | "written, but read back different";
}

/** One region of the set and whether the device already holds its bytes. */
interface Check {
  readonly region: RestoreRegion;
  /** The SHA-256 of what the device holds there now. */
  readonly current: string;
  readonly identical: boolean;
}

/** A region that differs, with the session file that holds what it contains now. */
interface Saved extends Check {
  readonly escrow: StreamArtifact;
}

class RestoreStopped extends EdlError {}

export async function restoreSet(run: EdlRun): Promise<HardwareResult> {
  const { context, say } = run;
  const manifestSha256 = parseRestoreRequest(run);
  const { plan, blobs } = await loadSet(run, manifestSha256);
  const { manifest } = plan;
  const short = manifestShort(manifestSha256);
  const gaps = identityGaps(manifest);
  if (gaps.length > 0) {
    throw refused(`This set does not record ${gaps.join(" or ")}, so Cody cannot tell which unit it came from and will not restore it. ${manifest.notRestorableBecause.join(" ")} Nothing was written.`);
  }

  // The boot ROM's account of the chip is compared BEFORE the loader is confirmed, let alone sent.
  const opened = await openFirehose(run, {
    identity: "require",
    checkIdentity: (identity) => {
      const mismatches = bootRomMismatches(manifest, identity);
      if (mismatches.length > 0) {
        throw refused(`This backup set was taken from another unit - ${mismatches.join("; ")}. No loader was sent and nothing was written.`);
      }
    },
  }, context.input);
  const { sectorSize } = opened.storage;

  const live = await readLiveDiskGuid(opened);
  const mismatches = storageMismatches(manifest, opened.storage);
  const guids = [live.primary, live.backup].filter((guid): guid is string => guid !== null);
  if (guids.length === 0) {
    mismatches.push(`disk GUID: neither partition table on the device is intact, so whose disk this is cannot be confirmed (${live.notes.join(" ")})`);
  } else if (new Set(guids).size > 1) {
    mismatches.push(`disk GUID: the two partition tables on the device disagree (${live.primary} and ${live.backup})`);
  } else if (guids[0] !== manifest.unit.diskGuid) {
    mismatches.push(`disk GUID: the set is from ${manifest.unit.diskGuid}, the device's partition tables say ${guids[0]}`);
  }
  if (mismatches.length > 0) {
    throw refused(`This backup set does not match the unit Cody is talking to - ${mismatches.join("; ")}. The programmer is running (the loader was sent) but nothing was written. Use Reset to leave EDL, or put the right device into EDL mode.`);
  }
  for (const note of live.notes) say(`Note: ${note} The other table identifies the disk.`);
  say(`Unit check passed: chip serial 0x${manifest.unit.chipSerial}, public-key hash, eMMC serial ${manifest.unit.emmcSerial}, disk GUID ${manifest.unit.diskGuid} all match the set.`);

  // Which regions already hold the set's bytes; of the others, what they hold now is saved before anything is changed.
  // A region that matches needs no copy: the set is its copy.
  const tag = unitTag(opened);
  const regionBytes = plan.regions.reduce((sum, region) => sum + region.sectors * sectorSize, 0);
  say(`Reading what the device holds now in the ${plan.regions.length} region(s) the set covers (${formatBytes(regionBytes)}) to see which differ.`);
  const checks: Check[] = [];
  for (const [position, region] of plan.regions.entries()) {
    throwIfAborted(context.signal);
    const now = await summarizeRegion(run, opened, region.firstLba, region.sectors, "check", `Checking ${region.label} (${position + 1} of ${plan.regions.length})`);
    checks.push({ region, current: now.sha256, identical: now.sha256 === region.sha256 });
  }
  const identical = checks.filter((check) => check.identical);
  const differing = checks.filter((check) => !check.identical);
  if (differing.length === 0) {
    const summary = `Nothing to restore: all ${checks.length} region(s) the set covers already hold exactly the set's bytes, checked by reading them. The device was not changed.`;
    say(summary);
    return { summary, verified: true, details: { set: manifestSha256, diskGuid: manifest.unit.diskGuid, written: [], alreadyIdentical: identical.map((check) => check.region.label) } };
  }
  say(`${differing.length} region(s) differ from the set: ${listed(differing.map((check) => check.region.label))}. Saving what they hold now, before anything is changed.`);
  const toWrite: Saved[] = [];
  for (const [position, check] of differing.entries()) {
    throwIfAborted(context.signal);
    const { region } = check;
    const fileName = `edl-${tag}-restore-${short}-${region.slug}.pre.bin`;
    const { saved } = await escrowRange(run, opened, region.label, region.firstLba, region.sectors, fileName, "written", `Saving ${region.label} (${position + 1} of ${differing.length})`);
    if (saved.sha256 !== check.current) {
      throw new EdlError(`${region.label} read back as different bytes the second time (SHA-256 ${check.current}, then ${saved.sha256}), so the saved copy cannot be trusted. Nothing was written.`);
    }
    toWrite.push({ ...check, escrow: saved });
  }
  if (identical.length > 0) say(`Already identical, left alone: ${listed(identical.map((check) => check.region.label))}.`);

  const escrowList = (list: readonly Saved[]): string => listed(list.map((check) => `${check.region.label} → ${check.escrow.fileId}`));
  const protectedNames = toWrite.filter((check) => check.region.protectedBecause).map((check) => check.region.label);
  const writeSectors = toWrite.reduce((sum, check) => sum + check.region.sectors, 0);
  const override = restoreOverride(manifestSha256);
  const undo = "To undo a partition, flash its saved copy back to it; the saved partition tables have no command that writes them back.";
  const grant = await grantWrites(context, {
    action: "edl restore",
    target: `disk ${manifest.unit.diskGuid}`,
    protectedOverride: override,
    backup: `Saved the current contents of the ${toWrite.length} region(s) it will overwrite (${formatBytes(writeSectors * sectorSize)}), each checked to hold exactly the bytes read, before any change: ${escrowList(toWrite)}. Files are named edl-${tag}-restore-${short}-*.pre.bin. ${undo}`,
    details: fitted([
      `Restore backup set ${short} (manifest SHA-256 ${manifestSha256}, taken ${manifest.createdAt}) onto disk ${manifest.unit.diskGuid}.`,
      `Unit check passed before anything was sent: chip serial 0x${manifest.unit.chipSerial}, public-key hash ${manifest.unit.pkHash}, eMMC serial ${manifest.unit.emmcSerial} (${manifest.unit.emmcProduct ?? "product not reported"}), disk GUID ${manifest.unit.diskGuid}, ${manifest.geometry.measuredSectors} sectors of ${sectorSize} bytes. ${describeStorage(opened)}.`,
      `Cody will OVERWRITE ${toWrite.length} of ${checks.length} region(s), ${formatBytes(writeSectors * sectorSize)}: ${listed(toWrite.map((check) => check.region.label))}.`,
      identical.length > 0 ? `Already identical and left alone: ${listed(identical.map((check) => check.region.label))}.` : "",
      protectedNames.length > 0 ? `PROTECTED partitions among them (boot chain, radio or identity data): ${listed(protectedNames)}.` : "No protected partition is among them.",
      `Order: partitions first, then the backup partition table, then the primary partition table last. Each region is read back and compared by SHA-256 before the next is started; the first mismatch stops the restore and the tables are written only if every partition read back identical.`,
      `Type ${override} to approve.`,
    ]),
  }, { label: `restore set ${short}`, sectorSize, kinds: ["program"], ranges: toWrite.map((check) => ({ startSector: check.region.firstLba, sectors: check.region.sectors })) });

  const tally = newTally();
  const report = progressReporter(context, "write", writeSectors * sectorSize, `Restoring set ${short}`);
  const progress: RestoreProgress = { done: [], current: undefined, stage: "being written" };
  const where = (): string => {
    const finished = new Set<RestoreRegion>(progress.done);
    const notStarted = toWrite.map((check) => check.region).filter((region) => !finished.has(region) && region !== progress.current);
    const tablesStarted = [...progress.done, progress.current].some((region) => region !== undefined && region.kind !== "partition");
    return [
      `Written and read back identical: ${listed(progress.done.map((region) => region.label))}.`,
      progress.current ? `POSSIBLY MODIFIED (${progress.stage}): ${progress.current.label}.` : "",
      `Not started: ${listed(notStarted.map((region) => region.label))}.`,
      tablesStarted ? "" : "Neither partition table was written.",
      `The previous contents of every region this restore overwrites are saved: ${escrowList(toWrite)}.`,
      `Nothing was retried. ${undo}`,
    ].filter(Boolean).join(" ");
  };

  let base = 0;
  try {
    for (const check of toWrite) {
      const { region } = check;
      throwIfAborted(context.signal);
      progress.current = region;
      progress.stage = "being written";
      await duringWrites(run, opened, (stop) => opened.firehose.writeSectors(
        grant,
        region.firstLba,
        region.sectors,
        sectorSize,
        paddedSource(blobs.get(region)!, 0),
        tallyHooks(opened, tally, stop, report, sectorSize, base),
      ));
      base += region.sectors;
      progress.stage = "written, being read back";
      const back = await summarizeRegion(run, opened, region.firstLba, region.sectors, "verify", `Reading ${region.label} back`).catch((error: unknown) => {
        if (error instanceof FirehoseRejection) {
          throw new RestoreStopped(`UNVERIFIED: the programmer would not read ${region.label} back (${error.message}), so the restore stopped there. ${where()}`, "rejected");
        }
        throw error;
      });
      if (back.sha256 !== region.sha256) {
        progress.stage = "written, but read back different";
        throw new RestoreStopped(`READ-BACK MISMATCH on ${region.label}: the programmer acknowledged every block, but the region reads back as SHA-256 ${back.sha256}, not ${region.sha256}. The restore stopped there and wrote nothing further. ${where()}`);
      }
      progress.done.push(region);
      progress.current = undefined;
      say(`Wrote ${region.label} (${describeRange(region.firstLba, region.sectors, sectorSize)}) and read it back identical.`);
    }
  } catch (error) {
    if (error instanceof RestoreStopped) {
      say(error.message);
      throw error;
    }
    throw interruption(run, opened, error, { verb: "write", subject: `disk ${manifest.unit.diskGuid}`, totalSectors: writeSectors, tally, where: where() });
  } finally {
    grant.revoke();
  }

  const summary = `Restored backup set ${short} to disk ${manifest.unit.diskGuid}: ${toWrite.length} region(s) written and read back identical (${listed(toWrite.map((check) => check.region.label))})${identical.length > 0 ? `, ${identical.length} already identical and left alone` : ""}. The partition tables were written last. The previous contents of what was written are saved (${escrowList(toWrite)}). Cody cannot see whether the unit now boots: use Reset to leave EDL.`;
  say(summary);
  return {
    summary,
    verified: true,
    details: {
      set: manifestSha256,
      diskGuid: manifest.unit.diskGuid,
      written: toWrite.map((check) => ({ label: check.region.label, firstLba: check.region.firstLba, sectors: check.region.sectors, sha256: check.region.sha256, saved: { fileId: check.escrow.fileId, sha256: check.escrow.sha256 } })),
      alreadyIdentical: identical.map((check) => check.region.label),
    },
  };
}
