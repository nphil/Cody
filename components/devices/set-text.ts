/**
 * The words the Files & backups list tells a set of files and the transfers of it in. Pure given a translator, so every
 * sentence can be pinned in every language without rendering.
 */

import { formatBytes } from "@/lib/format-bytes";
import type { ArtifactSet, DeviceArtifact, TransferJob } from "@/lib/devices/artifacts";
import { shortArtifactName } from "@/lib/devices/artifact-sets";
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

/** "Lenovo QUSB__BULK · Backup set". `deviceName` is what the device was called when the files were saved, else its current name. */
export function setTitle(set: ArtifactSet, deviceName: string, t: Translate): string {
  return `${deviceName} · ${t(`devices.files.kind.${setKind(set)}`)}`;
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

/** The name of the zip a finished download wrote, when the job was a download and said so. */
export function downloadedName(job: TransferJob): string | undefined {
  const result = job.result;
  return job.kind === "download" && result && "fileName" in result ? result.fileName : undefined;
}
