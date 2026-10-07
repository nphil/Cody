/**
 * Jobs: what the person asked for, told the way the Devices panel tells it.
 *
 * A backup of 58 partitions is one thing the person asked for, however many commands the agent sent to do it. A JOB is
 * one such task: a single flash or dump, or a run of the same kind of operation (fifty-eight `dump`s of one device) that
 * belongs together. It owns its operations, has ONE state, and says how far along it is without making anything up:
 * a total it cannot know is not shown, and an estimate needs a measured rate.
 *
 * Pure and browser-safe (type imports only): the panel renders it, the tests pin it. Which operations form a job, and
 * how the panel orders jobs, is lib/devices/activity-groups.ts; which files a job saved is lib/devices/artifact-sets.ts.
 */

import { DECLINED_MESSAGE_PREFIX } from "./trust";
import type { DeviceOperationSnapshot, OperationEvent } from "./operations";

/** Operations further apart than this are two jobs, however alike. The same two minutes the file sets use (artifact-sets.ts). */
export const SERIES_GAP_MS = 2 * 60_000;

/**
 * A series that has just finished a step is still going: the agent is a moment from the next partition. Until this long
 * after its last step it is shown as running instead of flickering to "done" and back between operations.
 */
export const SERIES_LINGER_MS = 5_000;

/** The window over which a transfer rate is measured: long enough to smooth a stall, short enough to follow a slow-down. */
export const RATE_WINDOW_MS = 10_000;

/** Actions whose repeats are one job. They move whole files or images (the same list that earns a pop-up when they finish). */
const SERIES_ACTIONS: Record<string, true> = { dump: true, flash: true, pull: true, push: true, sideload: true, install: true };

/** Commands of the `exec` action that move data and report their progress in bytes, region by region. */
const BYTE_COMMANDS: Record<string, true> = { backup: true, restore: true };

export type JobPhase =
  /** An agent command is held until the person answers the question in the chat. */
  | "waiting"
  /** The send is counting down and can still be cancelled. */
  | "countdown"
  | "running"
  | "done"
  /** At least one step failed. */
  | "failed"
  /** The system cancelled it (the device left the bus, trust was withdrawn). Something may have been left half done. */
  | "stopped"
  /** The person cancelled it. */
  | "cancelled"
  /** The person said no to the agent controlling the device. */
  | "declined";

export type MemberOutcome = "succeeded" | "failed" | "stopped" | "cancelled" | "declined" | "active" | "waiting" | "countdown";

export interface JobCounts {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly stopped: number;
  readonly cancelled: number;
  readonly declined: number;
  /** Starting, running or cancelling. */
  readonly active: number;
}

export interface Job {
  readonly kind: "job";
  /** The oldest member's id: it stays the same while the job grows at its newer end, so what the person opened stays open. */
  readonly id: string;
  readonly deviceId: string;
  readonly protocol: string;
  readonly action: string;
  /** For `exec`: the first word of the command ("backup", "printgpt"). */
  readonly command?: string;
  readonly origin: "user" | "agent" | "mixed";
  /** Oldest first, as the manager reports them. */
  readonly members: readonly DeviceOperationSnapshot[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly counts: JobCounts;
  readonly phase: JobPhase;
}

/** What one operation came to, in the words the panel counts by. */
export function memberOutcome(operation: DeviceOperationSnapshot): MemberOutcome {
  switch (operation.state) {
    case "succeeded": return "succeeded";
    case "failed": return operation.error?.startsWith(DECLINED_MESSAGE_PREFIX) ? "declined" : "failed";
    // Stopping something yourself carries no reason; the system stopping it always says why.
    case "cancelled": return operation.error ? "stopped" : "cancelled";
    case "awaiting-trust": return "waiting";
    case "countdown": return "countdown";
    case "starting":
    case "running":
    case "cancelling": return "active";
  }
}

/** The first word of an `exec` command, which is what says what a command did. */
export function commandWord(operation: DeviceOperationSnapshot): string | undefined {
  if (operation.request.action !== "exec") return undefined;
  const word = operation.request.command?.trim().split(/\s+/)[0];
  return word ? word.toLowerCase() : undefined;
}

/** Whether repeats of this operation are one job. A command on its own never is: `getvar a` and `getvar b` are two questions. */
export function seriesKey(operation: DeviceOperationSnapshot): string | undefined {
  if (SERIES_ACTIONS[operation.request.action] !== true) return undefined;
  return `${operation.request.deviceId}|${operation.request.protocol}|${operation.request.action}`;
}

function countOf(members: readonly DeviceOperationSnapshot[]): JobCounts {
  let succeeded = 0;
  let failed = 0;
  let stopped = 0;
  let cancelled = 0;
  let declined = 0;
  let active = 0;
  for (const member of members) {
    switch (memberOutcome(member)) {
      case "succeeded": succeeded += 1; break;
      case "failed": failed += 1; break;
      case "stopped": stopped += 1; break;
      case "cancelled": cancelled += 1; break;
      case "declined": declined += 1; break;
      case "active": active += 1; break;
      default: break;
    }
  }
  return { total: members.length, succeeded, failed, stopped, cancelled, declined, active };
}

/** The single state of a job, from what its members came to. `now` only decides whether a series is still between steps. */
export function jobPhase(members: readonly DeviceOperationSnapshot[], counts: JobCounts, now: number): JobPhase {
  if (members.some((member) => member.state === "awaiting-trust")) return "waiting";
  if (members.some((member) => member.state === "countdown")) return "countdown";
  if (counts.active > 0) return "running";
  const last = members[members.length - 1]!;
  const between = members.length > 1 && counts.failed + counts.stopped + counts.declined === 0 && now - last.updatedAt < SERIES_LINGER_MS;
  if (between && last.state === "succeeded") return "running";
  if (counts.failed > 0) return "failed";
  if (counts.stopped > 0) return "stopped";
  if (counts.declined === counts.total) return "declined";
  if (counts.cancelled > 0) return "cancelled";
  return "done";
}

/** One job from the operations that belong to it (oldest first, all on one device). */
export function makeJob(members: readonly DeviceOperationSnapshot[], now: number): Job {
  const first = members[0]!;
  const counts = countOf(members);
  const origins = new Set(members.map((member) => member.origin));
  const command = commandWord(first);
  return {
    kind: "job",
    id: first.id,
    deviceId: first.request.deviceId,
    protocol: first.request.protocol,
    action: first.request.action,
    ...(command === undefined ? {} : { command }),
    origin: origins.size > 1 ? "mixed" : first.origin,
    members,
    startedAt: Math.min(...members.map((member) => member.createdAt)),
    endedAt: Math.max(...members.map((member) => member.updatedAt)),
    counts,
    phase: jobPhase(members, counts, now),
  };
}

/** The operations of a job that went wrong in a way the person should hear about: a failure, or the system stopping it. */
export function problemMembers(job: Job): DeviceOperationSnapshot[] {
  return job.members.filter((member) => {
    const outcome = memberOutcome(member);
    return outcome === "failed" || outcome === "stopped";
  });
}

// ---- progress --------------------------------------------------------------------------------------------------------

/** One item a job is expected to cover: a partition of the table the device reported. */
export interface PlannedItem {
  readonly name: string;
  readonly bytes: number;
}

export interface JobProgress {
  /** 0..1 over the whole job, or null when that cannot be said honestly. */
  readonly fraction: number | null;
  /** What the fraction is measured in: bytes against the whole, steps against a known count, or the one item in flight. */
  readonly basis: "bytes" | "steps" | "item" | null;
  /** Items that finished, and how many there will be when that is known. */
  readonly doneItems: number;
  readonly totalItems?: number;
  /** Bytes moved by finished items plus what the running one has moved, and in all when known. */
  readonly doneBytes: number;
  readonly totalBytes?: number;
  /** What it is working on now. */
  readonly current?: { readonly name: string; readonly fraction: number | null; readonly etaSeconds: number | null };
  /** Seconds left for the whole job, when the rest is known and a rate has been measured. */
  readonly etaSeconds: number | null;
}

/** "(3 of 58)" at the end of a progress message: how a flasher says which step of a multi-step job it is on. */
export function stepOf(message: string | undefined): { index: number; count: number } | null {
  const match = /\((\d+) of (\d+)\)\s*$/.exec(message ?? "");
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return index >= 1 && count >= index ? { index, count } : null;
}

function bytesOf(operation: DeviceOperationSnapshot): number {
  const progress = operation.progress;
  if (!progress) return 0;
  if (operation.state === "succeeded") return progress.total ?? progress.completed ?? 0;
  return progress.completed ?? 0;
}

function movesBytes(job: Job): boolean {
  return SERIES_ACTIONS[job.action] === true || (job.action === "exec" && job.command !== undefined && BYTE_COMMANDS[job.command] === true);
}

/** What one member of a job is called: the partition or path it names, else its command. */
export function memberName(operation: DeviceOperationSnapshot): string {
  const { target, command, action } = operation.request;
  return target ?? command ?? action;
}

/**
 * Bytes per second over the newest progress events of one operation. Null when there is not enough to tell: fewer than
 * two events, a span under a second, or no movement. Events before the last time the count went backwards (a new phase
 * starting from zero) are not part of the same transfer.
 */
export function recentRate(events: readonly OperationEvent[], now: number): number | null {
  const points: Array<{ at: number; completed: number }> = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const progress = event.type === "progress" ? event.progress : undefined;
    if (progress?.completed === undefined) continue;
    const newest = points[0];
    if (newest && progress.completed > newest.completed) break;
    if (now - progress.at > RATE_WINDOW_MS) break;
    points.push({ at: progress.at, completed: progress.completed });
  }
  if (points.length < 2) return null;
  const newest = points[0]!;
  const oldest = points[points.length - 1]!;
  const seconds = (newest.at - oldest.at) / 1000;
  const moved = newest.completed - oldest.completed;
  return seconds >= 1 && moved > 0 ? moved / seconds : null;
}

/** The average rate of the items that finished: bytes over the time they spent running. Null without at least one. */
function averageRate(finished: readonly DeviceOperationSnapshot[]): number | null {
  let bytes = 0;
  let millis = 0;
  for (const operation of finished) {
    const running = operation.events.findLast((event) => event.type === "state" && event.state === "running");
    bytes += bytesOf(operation);
    millis += Math.max(0, operation.updatedAt - (running?.at ?? operation.createdAt));
  }
  return bytes > 0 && millis >= 1000 ? bytes / (millis / 1000) : null;
}

/** The partition table a device last reported (an EDL `printgpt` result), as items a job can be measured against. */
export function plannedItems(details: Record<string, unknown> | undefined): PlannedItem[] {
  const raw = details?.partitions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || !("bytes" in entry)) return [];
    return typeof entry.name === "string" && typeof entry.bytes === "number" && entry.bytes > 0 ? [{ name: entry.name, bytes: entry.bytes }] : [];
  });
}

/** The step a multi-step operation says it is on, from its newest progress message that says so. */
function latestStep(operation: DeviceOperationSnapshot): { index: number; count: number } | null {
  for (let index = operation.events.length - 1; index >= 0; index -= 1) {
    const event = operation.events[index]!;
    if (event.type !== "progress") continue;
    const step = stepOf(event.progress?.message);
    if (step) return step;
  }
  return stepOf(operation.progress?.message);
}

/** The item a running operation is on: the partition or path it names, else what its progress message says. */
function currentName(operation: DeviceOperationSnapshot): string {
  if (operation.request.target) return operation.request.target;
  const message = operation.progress?.message?.replace(/\s*\(\d+ of \d+\)\s*$/, "").trim();
  return message || memberName(operation);
}

/**
 * The table a backup is measured against, when it fits: only dumps (a flash of three partitions is not "three of fifty-eight"),
 * and only when every partition the job touched is in it, because a plan the job does not follow promises work that is not coming.
 */
function usablePlan(job: Job, plan: readonly PlannedItem[] | undefined): readonly PlannedItem[] | undefined {
  if (job.action !== "dump" || !plan || plan.length === 0) return undefined;
  const named = new Set(plan.map((item) => item.name));
  return job.members.every((member) => member.request.target !== undefined && named.has(member.request.target)) ? plan : undefined;
}

/**
 * How far a job has got. Counts come from what finished; a total only from a plan the job follows, a step the flasher
 * names ("3 of 58") or the operation's own byte total; an estimate only from a measured rate.
 */
export function jobProgress(job: Job, options: { now: number; plan?: readonly PlannedItem[] }): JobProgress {
  const succeeded = job.members.filter((member) => member.state === "succeeded");
  const running = job.members.findLast((member) => memberOutcome(member) === "active");
  const live = running?.progress;
  const step = running ? latestStep(running) : null;
  // A multi-step operation (a backup set) restarts its byte count in every region, so its bytes say nothing about the whole.
  const counting = movesBytes(job) && step === null;
  const plan = usablePlan(job, options.plan);
  const liveFraction = live?.completed !== undefined && live.total ? Math.min(1, live.completed / live.total) : null;

  const doneBytes = counting ? succeeded.reduce((sum, member) => sum + bytesOf(member), 0) + (running ? live?.completed ?? 0 : 0) : 0;
  const totalItems = plan?.length ?? step?.count;
  const totalBytes = plan ? plan.reduce((sum, item) => sum + item.bytes, 0) : counting && job.members.length === 1 ? live?.total : undefined;

  const rate = running ? recentRate(running.events, options.now) ?? averageRate(succeeded) : null;
  const currentEta = rate && live?.total !== undefined && live.completed !== undefined ? Math.max(0, Math.round((live.total - live.completed) / rate)) : null;

  let fraction: number | null = null;
  let basis: JobProgress["basis"] = null;
  if (counting && totalBytes) {
    fraction = Math.min(1, doneBytes / totalBytes);
    basis = "bytes";
  } else if (step) {
    fraction = Math.min(1, (step.index - 1 + (liveFraction ?? 0)) / step.count);
    basis = "steps";
  } else if (totalItems) {
    fraction = Math.min(1, (succeeded.length + (liveFraction ?? 0)) / totalItems);
    basis = "steps";
  } else if (job.members.length === 1) {
    fraction = job.phase === "done" ? 1 : liveFraction;
    basis = "item";
  }

  const whole = counting && totalBytes && rate ? Math.max(0, Math.round((totalBytes - doneBytes) / rate)) : null;
  return {
    fraction,
    basis,
    doneItems: step ? step.index - 1 : succeeded.length,
    ...(totalItems === undefined ? {} : { totalItems }),
    doneBytes,
    ...(totalBytes === undefined ? {} : { totalBytes }),
    ...(running ? { current: { name: currentName(running), fraction: liveFraction, etaSeconds: currentEta } } : {}),
    etaSeconds: whole ?? (running && job.members.length === 1 && !step ? currentEta : null),
  };
}

/** The coarse words an estimate is told in: precision the rate cannot back would be a promise. */
export type EtaLabel =
  | { key: "devices.eta.soon" }
  | { key: "devices.eta.underMinute" }
  | { key: "devices.eta.minutes"; count: number }
  | { key: "devices.eta.hours"; hours: number; minutes: number }
  | { key: "devices.eta.hoursOnly"; hours: number };

export function etaLabel(seconds: number): EtaLabel {
  if (seconds < 15) return { key: "devices.eta.soon" };
  if (seconds < 60) return { key: "devices.eta.underMinute" };
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return { key: "devices.eta.minutes", count: minutes <= 10 ? minutes : Math.round(minutes / 5) * 5 };
  const total = Math.round(minutes / 5) * 5;
  return total % 60 === 0 ? { key: "devices.eta.hoursOnly", hours: total / 60 } : { key: "devices.eta.hours", hours: Math.floor(total / 60), minutes: total % 60 };
}

// ---- titles ----------------------------------------------------------------------------------------------------------

/** The protocols whose items are partitions, for the title of a series. */
const PARTITION_PROTOCOLS: Record<string, true> = { edl: true, fastboot: true, dfu: true };

export interface JobTitle {
  /** The translation key; `count` selects its `.one` or `.other` form when present. */
  readonly key: string;
  readonly count?: number;
  readonly vars: Readonly<Record<string, string | number>>;
}

/**
 * An EDL backup whose requests all named their partitions (`options.partitions`) took only those, so it is titled by how
 * many, like a run of single-partition dumps, and not "everything". A backup that named none is a backup of everything,
 * and so is a job that holds one.
 */
function backupTitle(members: Job["members"]): JobTitle {
  const lists = members.map((member) => member.request.options?.partitions);
  if (!lists.every((list): list is unknown[] => Array.isArray(list))) return { key: "devices.job.backupSet", vars: {} };
  return { key: "devices.job.dumpSeries", count: new Set(lists.flat()).size, vars: {} };
}

/** What a job is called, as a translation key and its values. `protocolName` is the protocol as the person reads it. */
export function jobTitle(job: Job, protocolName: string): JobTitle {
  const { action, command, protocol, members } = job;
  const count = members.length;
  const first = members[0]!.request;
  const target = first.target ?? "";
  const series = count > 1;
  // A run still going has no count to give: it would say 48 while the device reports 47 of 58.
  const live = job.phase === "waiting" || job.phase === "countdown" || job.phase === "running";
  const counted = (key: string): JobTitle => (live ? { key: `${key}Live`, vars: {} } : { key, count, vars: {} });
  if (action === "exec") {
    if (command === "backup") return backupTitle(members);
    if (command === "restore") return { key: "devices.job.restoreSet", vars: {} };
    if (command === "printgpt") return { key: "devices.job.readTables", vars: {} };
    if (command === "connect") return { key: "devices.job.connect", vars: {} };
    if (command === "check") return { key: "devices.job.checkDisk", vars: {} };
    if (command === "erase") return { key: "devices.job.erase", vars: { target } };
    if (command === "reset") return { key: "devices.job.reset", vars: {} };
    return { key: "devices.job.command", vars: { command: first.command?.trim() || "command" } };
  }
  switch (action) {
    case "dump":
      if (series) return counted(PARTITION_PROTOCOLS[protocol] ? "devices.job.dumpSeries" : "devices.job.dumpItems");
      return target === "user-area" ? { key: "devices.job.dumpAll", vars: {} } : target ? { key: "devices.job.dump", vars: { target } } : { key: "devices.job.dumpPlain", vars: { protocol: protocolName } };
    case "flash":
      return series ? counted("devices.job.flashSeries") : { key: target ? "devices.job.flash" : "devices.job.flashPlain", vars: { target, protocol: protocolName } };
    case "pull":
      return series ? counted("devices.job.pullSeries") : { key: "devices.job.pull", vars: { target: target || "files" } };
    case "push":
      return series ? counted("devices.job.pushSeries") : { key: "devices.job.push", vars: { target: target || "file" } };
    case "sideload": return { key: "devices.job.sideload", vars: { target: target || "package" } };
    case "install": return series ? counted("devices.job.installSeries") : { key: "devices.job.install", vars: { target: target || "app" } };
    case "verify": return { key: "devices.job.verify", vars: { target: target || protocolName } };
    case "detect": return { key: "devices.job.detect", vars: {} };
    case "monitor": return { key: protocol === "serial" ? "devices.job.serialMonitor" : "devices.job.monitor", vars: {} };
    case "forward": return { key: "devices.job.forward", vars: { target: target || "port" } };
    case "reverse": return { key: "devices.job.reverse", vars: { target: target || "port" } };
    default: return { key: "devices.job.generic", vars: { protocol: protocolName, action } };
  }
}

/** The files a job saved, found by the operation that saved each (see ArtifactProvenance). */
export function jobArtifactIds(job: Job, artifacts: ReadonlyArray<{ readonly id: string; readonly provenance?: { readonly operationId: string } }>): string[] {
  const operationIds = new Set(job.members.map((member) => member.id));
  return artifacts.filter((artifact) => artifact.provenance !== undefined && operationIds.has(artifact.provenance.operationId)).map((artifact) => artifact.id);
}
