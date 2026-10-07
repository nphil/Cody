/**
 * The words the Files & backups list tells a set of files and the transfers of it in. Pure given a translator, so every
 * sentence can be pinned in every language without rendering.
 */

import { formatBytes } from "@/lib/format-bytes";
import type { ArtifactSet, DeviceArtifact, SetSaveState, TransferJob } from "@/lib/devices/artifacts";
import { setFileLabel, shortArtifactName } from "@/lib/devices/artifact-sets";
import type { Translate, TranslatePlural } from "./job-text";

export type SetKind = "backupSet" | "restoreCopies" | "dumps" | "pulled" | "files";

/** What a set is, from what made it: a whole-disk backup set, the copies a restore saves first, partition dumps, files pulled off a device. */
export function setKind(set: ArtifactSet): SetKind {
  if (set.action === "exec" && set.command === "backup") return "backupSet";
  if (set.action === "exec" && set.command === "restore") return "restoreCopies";
  if (set.action === "dump") return "dumps";
  if (set.action === "pull") return "pulled";
  return "files";
}

/** What a backup took, in words that a partial one cannot pass for a whole one: "Full backup · 56 partitions", "Backup · 5 of 56 partitions". */
export function scopeText(scope: NonNullable<ArtifactSet["scope"]>, tn: TranslatePlural): string {
  return scope.chosen === scope.total ? tn("devices.files.scopeFull", scope.total) : tn("devices.files.scopePartial", scope.total, { chosen: scope.chosen });
}

/**
 * What a set is called, in the card, its menus, the list inside it and a file's details: "Lenovo QUSB__BULK · Full backup · 56
 * partitions", "Lenovo QUSB__BULK · tablet-2026-10-07" for a set an agent named, or "Lenovo QUSB__BULK · Backups" for one
 * known only by what made it. The device is whatever the files recorded when they were saved, else `deviceName` (what it is
 * called now).
 */
export function setTitle(set: ArtifactSet, deviceName: string, t: Translate, tn: TranslatePlural): string {
  const what = set.name ?? (set.scope ? scopeText(set.scope, tn) : t(`devices.files.kind.${setKind(set)}`));
  return `${set.label ?? deviceName} · ${what}`;
}

/** The second line of a named set that also says which partitions it took; a set without a name has that in its title. */
export function setScopeLine(set: ArtifactSet, tn: TranslatePlural): string | undefined {
  return set.name !== undefined && set.scope ? scopeText(set.scope, tn) : undefined;
}

/** What the device that made a set is called now, for a set whose files did not record a name. */
export function setDeviceName(set: ArtifactSet, deviceLabel: (deviceId: string) => string, t: Translate): string {
  return set.deviceId ? deviceLabel(set.deviceId) : t("devices.files.unknownDevice");
}

/** The name of a file as a person reads it: the partition, not `edl-3989044886-set-p12-vendor_b.bin`. */
export function fileLabel(artifact: DeviceArtifact): string {
  return artifact.provenance?.target ?? shortArtifactName(artifact.name);
}

/** "All 58 verified", "40 of 58 verified", or nothing when no file's content was checked against the device. */
export function verifiedText(count: number, verified: number, t: Translate, tn: TranslatePlural): string | null {
  if (verified <= 0) return null;
  return verified === count ? tn("devices.files.verifiedAll", count) : t("devices.files.verifiedSome", { verified, count });
}

/** The line a running transfer shows: what it is doing, how many files and how far. */
export function transferText(job: TransferJob, t: Translate): string {
  const { progress } = job;
  const percent = progress.totalBytes > 0 ? Math.round(Math.min(1, progress.bytes / progress.totalBytes) * 100) : progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const phase = t(`devices.files.phase.${progress.phase}`);
  return t("devices.files.transferLine", { phase, done: progress.done, total: progress.total, percent, size: formatBytes(progress.totalBytes) });
}

/** Whether a transfer is over these files: the set's own, or a group made only of its files. */
function touches(job: TransferJob, set: ArtifactSet): boolean {
  return job.setId === set.id || (job.artifactIds.length > 0 && job.artifactIds.every((id) => set.artifactIds.includes(id)));
}

/** The newest transfer that touched these files, if any. */
export function latestTransfer(transfers: readonly TransferJob[], set: ArtifactSet): TransferJob | undefined {
  return transfers.findLast((job) => touches(job, set));
}

/** The newest transfer over these files that is still running: it holds the files even when a newer one has already finished. */
export function runningTransfer(transfers: readonly TransferJob[], set: ArtifactSet): TransferJob | undefined {
  return transfers.findLast((job) => job.state === "running" && touches(job, set));
}

/** "Downloaded as lenovo-edl-backup-20261007-1830.zip · 3.8 GB → 610 MB": the zip a finished download wrote and what packing did to it; nothing for a transfer that is not a finished download. */
export function downloadedText(job: TransferJob, t: Translate): string | undefined {
  const result = job.result;
  if (job.kind !== "download" || job.state !== "succeeded" || !result || !("fileName" in result)) return undefined;
  return t("devices.files.downloaded", { name: result.fileName, original: formatBytes(result.bytes), archive: formatBytes(result.archiveBytes) });
}

/** "Saved · 1 file · 3.8 GB → 610 MB": the whole save is one archive, so it is one file on the server whatever it holds. */
export function savedText(saved: Extract<SetSaveState, { state: "saved" }>, t: Translate, tn: TranslatePlural): string {
  return t("devices.files.savedLine", { files: tn("devices.files.count", saved.archives), original: formatBytes(saved.bytes), archive: formatBytes(saved.archiveBytes) });
}

/** The longest a selection's label gets: it becomes the name of the zip, and the name of the save on the server. */
const SELECTION_LABEL_MAX = 60;

/** What a download or save of only some of a set's files is called: "Lenovo QUSB__BULK EDL backup (3 files)". Plain English, because it ends up in a file name. */
export function selectionLabel(set: ArtifactSet, count: number): string {
  const suffix = ` (${count} ${count === 1 ? "file" : "files"})`;
  const base = setFileLabel(set);
  return base.length + suffix.length <= SELECTION_LABEL_MAX ? `${base}${suffix}` : `${base.slice(0, SELECTION_LABEL_MAX - suffix.length).trimEnd()}${suffix}`;
}

/** "3 of 58 selected · 6.0 MB": how many of the whole list are ticked (not only the part on screen) and how big that is. `size` is already formatted. */
export function selectionText(selected: number, total: number, size: string, t: Translate): string {
  return t("devices.files.selectedCount", { selected, total, size });
}
