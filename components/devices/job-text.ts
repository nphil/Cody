/**
 * The words the Devices panel tells a job in. Pure given a translator, so the tests can pin every sentence in every
 * language without rendering: the model (lib/devices/jobs.ts) decides WHAT is true, this decides how it is said.
 */

import { formatBytes } from "@/lib/format-bytes";
import { etaLabel, jobTitle, type Job, type JobProgress } from "@/lib/devices/jobs";
import type { HistoryDay } from "@/lib/devices/activity-groups";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export type TranslatePlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** The protocol as the person reads it ("EDL"); one the panel has no name for is shown as it is. */
export function protocolName(protocol: string, t: Translate): string {
  const key = `devices.protocol.${protocol}`;
  const text = t(key);
  return text === key ? protocol : text;
}

/** What a job is called: "Back up 58 partitions", "Flash boot_a". */
export function titleText(job: Job, t: Translate, tn: TranslatePlural): string {
  const title = jobTitle(job, protocolName(job.protocol, t));
  return title.count === undefined ? t(title.key, title.vars) : tn(title.key, title.count, title.vars);
}

/** "about 3 min left": coarse on purpose (see etaLabel). */
export function etaText(seconds: number, t: Translate, tn: TranslatePlural): string {
  const label = etaLabel(seconds);
  switch (label.key) {
    case "devices.eta.minutes": return tn(label.key, label.count);
    case "devices.eta.hours": return t(label.key, { hours: label.hours, minutes: label.minutes });
    case "devices.eta.hoursOnly": return t(label.key, { hours: label.hours });
    default: return t(label.key);
  }
}

/** How long something took, to the precision a person reads it at. */
export function durationText(millis: number, t: Translate): string {
  if (millis < 1000) return t("devices.duration.under");
  const seconds = Math.round(millis / 1000);
  if (seconds < 60) return t("devices.duration.seconds", { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("devices.duration.minutes", { count: minutes });
  return t("devices.duration.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** The single state of a job in words. A job whose running step is being cancelled says so. */
export function phaseText(job: Job, t: Translate): string {
  if (job.phase === "running" && job.members.some((member) => member.state === "cancelling")) return t("devices.operationStateCancelling");
  return t(`devices.jobState.${job.phase}`);
}

type Unit = "partitions" | "files" | "items";

/** What a job's items are called: partitions of a device that has them, files that are copied, otherwise just items. */
function unitOf(job: Job): Unit {
  if (job.protocol === "edl" || job.protocol === "fastboot" || job.protocol === "dfu") return job.action === "dump" || job.action === "flash" || job.action === "exec" ? "partitions" : "items";
  return job.action === "pull" || job.action === "push" ? "files" : "items";
}

/** "Partitions", "Files" or "Items": the word on the control that opens a running job's list, which carries no count of its own
 * because the line above it already counts ("47 of 58 partitions"), and a second, different number would read as a mistake. */
export function unitWord(job: Job, t: Translate): string {
  return t(`devices.jobItemsUnit.${unitOf(job)}`);
}

/** "14 of 58 partitions" when the end is known, "14 partitions so far" when it is not, nothing for a single operation. */
export function itemsText(job: Job, progress: JobProgress, tn: TranslatePlural): string | null {
  const unit = unitOf(job);
  if (progress.totalItems !== undefined) return tn(`devices.jobMeta.${unit}Of`, progress.totalItems, { done: progress.doneItems });
  return job.members.length > 1 ? tn(`devices.jobMeta.${unit}SoFar`, progress.doneItems) : null;
}

/** "1.2 GB of 3.5 GB", or "1.2 GB" when the whole is not known; nothing when nothing has moved. */
export function bytesText(progress: JobProgress, t: Translate): string | null {
  if (progress.doneBytes <= 0) return null;
  if (progress.totalBytes !== undefined) return t("devices.jobMeta.bytesOf", { done: formatBytes(progress.doneBytes), total: formatBytes(progress.totalBytes) });
  return formatBytes(progress.doneBytes);
}

/** The clock time of a moment, in the language and time zone given (the browser's own when none is). */
export function timeText(at: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(at);
}

/** "6 Oct, 18:31": when a set of files was made. */
export function whenText(at: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(at);
}

/** "Today", "Yesterday", or "Mon, 5 Oct". */
export function dayText(day: HistoryDay, t: Translate, locale: string, timeZone?: string): string {
  if (day.when === "today") return t("devices.day.today");
  if (day.when === "yesterday") return t("devices.day.yesterday");
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(day.at);
}

/** A problem in one sentence: which step it was, and why; for a run, how many failed and how many were saved. */
export function problemText(job: Job, t: Translate, problems: ReadonlyArray<{ name: string; reason: string }>): string {
  const first = problems[0];
  const stopped = job.phase === "stopped";
  if (job.members.length === 1) return first?.reason || t(stopped ? "devices.problem.stoppedNoReason" : "devices.problem.failedNoReason");
  return t(stopped ? "devices.problem.stoppedMany" : "devices.problem.failedMany", { failed: problems.length, saved: job.counts.succeeded, name: first?.name ?? "", reason: first?.reason ?? "" });
}
