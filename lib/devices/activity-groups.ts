/**
 * How the Devices panel tells what happened on a device.
 *
 * One card per command buried everything the person had to act on, and one card per partition did the same to a backup.
 * Operations are grouped by what the person would call them:
 *
 *  - a JOB (jobs.ts) is one task: a flash or a backup, or a run of the same operation that belongs together (fifty-eight
 *    dumps of one device are one backup);
 *  - a BURST is a run of routine agent commands, folded into one line: a finished command the agent ran that declared no
 *    risk to the device, is not a flash/dump/transfer and saved no file.
 *
 * `activityView` then orders them the way a person reads: what needs an answer first (a question waiting in the chat, a
 * countdown that can still be cancelled, a failure not yet acknowledged), then what is running, then history by device
 * and day. A failure never scrolls away on its own: it stays at the top until the person acknowledges it.
 *
 * Pure and browser-safe: the panel renders it, the tests pin it.
 */

import type { TransferJob } from "./artifact-model";
import { commandWord, makeJob, plannedItems, problemMembers, seriesKey, SERIES_GAP_MS, type Job, type PlannedItem } from "./jobs";
import type { DeviceOperationSnapshot, OperationState } from "./operations";

/** Two routine commands further apart than this are two bursts, however alike they are. */
export const BURST_GAP_MS = 2 * 60_000;

/**
 * A command that merely LOOKS routine (an agent's read that has declared no risk) is not shown while it runs, unless it
 * runs longer than this: a dozen `getvar`s of a fifth of a second each would otherwise flash a card in and out of the top
 * of the panel and push everything under it up and down.
 */
export const ROUTINE_QUIET_MS = 2_000;

/** Actions whose result is an answer on the screen; the rest move files or hold the device. */
const ROUTINE_ACTIONS: Record<string, true> = { detect: true, exec: true, verify: true };

export interface ActivityBurst {
  kind: "burst";
  /** The oldest member's id: it stays the same while the burst grows at its newer end. */
  id: string;
  /** Oldest first, as the manager reports them. */
  operations: readonly DeviceOperationSnapshot[];
  /** The protocols used, in the order they first appear. */
  protocols: readonly string[];
  startedAt: number;
  endedAt: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export type ActivityEntry = Job | ActivityBurst;

export function isFinishedState(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** Waiting on the person: it must never be folded away or scrolled out of sight. */
export function needsPerson(operation: DeviceOperationSnapshot): boolean {
  return operation.state === "awaiting-trust" || operation.state === "countdown";
}

/** A finished command the agent ran that declared no risk to the device and saved no file. */
export function isRoutine(operation: DeviceOperationSnapshot): boolean {
  return operation.origin === "agent"
    && isFinishedState(operation.state)
    && !operation.riskDeclared
    && ROUTINE_ACTIONS[operation.request.action] === true
    && !operation.result?.fileId;
}

/** A routine-looking command of the agent's that has not finished: it is quiet for its first ROUTINE_QUIET_MS (see isQuiet). */
function routineInFlight(operation: DeviceOperationSnapshot): boolean {
  return operation.origin === "agent"
    && !isFinishedState(operation.state)
    && !needsPerson(operation)
    && !operation.riskDeclared
    && ROUTINE_ACTIONS[operation.request.action] === true;
}

/** A routine-looking command of the agent's that has only just started: nothing to show yet (see ROUTINE_QUIET_MS). */
export function isQuiet(operation: DeviceOperationSnapshot, now: number): boolean {
  return routineInFlight(operation) && now - operation.createdAt < ROUTINE_QUIET_MS;
}

/**
 * The moment at which a command that is quiet stops being quiet, for any command that can be quiet at all: the panel
 * wakes itself then. Independent of the clock, so a render can compute it without reading the time; a moment already
 * past is simply not waited for.
 */
export function quietUntil(operation: DeviceOperationSnapshot): number | undefined {
  return routineInFlight(operation) ? operation.createdAt + ROUTINE_QUIET_MS : undefined;
}

function burstOf(members: DeviceOperationSnapshot[]): ActivityBurst {
  const protocols: string[] = [];
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let startedAt = Infinity;
  let endedAt = 0;
  for (const member of members) {
    if (!protocols.includes(member.request.protocol)) protocols.push(member.request.protocol);
    if (member.state === "succeeded") succeeded += 1;
    else if (member.state === "failed") failed += 1;
    else cancelled += 1;
    startedAt = Math.min(startedAt, member.createdAt);
    endedAt = Math.max(endedAt, member.updatedAt);
  }
  return { kind: "burst", id: members[0]!.id, operations: members, protocols, startedAt, endedAt, succeeded, failed, cancelled };
}

/**
 * One device's history as entries, OLDEST first. `operations` is that device's operations, oldest first.
 *
 * A routine command joins the burst before it only when no task happened on the device in between and the gap is under
 * BURST_GAP_MS. A task joins the job before it when both are the same kind of bulk operation on one device and the gap is
 * under SERIES_GAP_MS; a different task in between ends that job, and routine commands do not. An operation that waits for
 * the person is always a job of its own, so a question never hides the work that came before it.
 */
export function groupActivity(operations: readonly DeviceOperationSnapshot[], options: { now: number }): ActivityEntry[] {
  const { now } = options;
  const entries: ActivityEntry[] = [];
  let burst: DeviceOperationSnapshot[] = [];
  let series: { key: string; members: DeviceOperationSnapshot[] } | null = null;
  const closeBurst = (): void => {
    if (burst.length > 0) entries.push(burstOf(burst));
    burst = [];
  };
  const closeSeries = (): void => {
    if (series) entries.push(makeJob(series.members, now));
    series = null;
  };
  for (const operation of operations) {
    if (isQuiet(operation, now)) continue;
    if (isRoutine(operation)) {
      const last = burst[burst.length - 1];
      if (last && operation.createdAt - last.updatedAt > BURST_GAP_MS) closeBurst();
      burst.push(operation);
      continue;
    }
    closeBurst();
    const key = needsPerson(operation) ? undefined : seriesKey(operation);
    const tail = series?.members[series.members.length - 1];
    if (series && key !== undefined && series.key === key && tail && operation.createdAt - tail.updatedAt <= SERIES_GAP_MS) {
      series.members.push(operation);
      continue;
    }
    closeSeries();
    if (key === undefined) entries.push(makeJob([operation], now));
    else series = { key, members: [operation] };
  }
  closeBurst();
  closeSeries();
  return entries.sort((left, right) => left.startedAt - right.startedAt);
}

function firstLine(text: string, limit: number): string {
  const line = text.split("\n").find((candidate) => candidate.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** One routine command as a row: what it was, and what came of it. */
export function describeRoutine(operation: DeviceOperationSnapshot): { title: string; outcome: string } {
  const { action, command, target, options } = operation.request;
  const kind = typeof options?.kind === "string" ? options.kind : undefined;
  const title = action === "exec" ? (command ?? kind ?? "command") : `${action}${target ? ` ${target}` : ""}`;
  let outcome: string;
  if (operation.state === "failed") outcome = operation.error ?? "";
  else if (operation.state === "cancelled") outcome = operation.error ?? "";
  else outcome = operation.result?.summary ?? "";
  return { title: firstLine(title, 120), outcome: firstLine(outcome, 160) };
}

// ---- the view --------------------------------------------------------------------------------------------------------

export interface DeviceEntries {
  readonly deviceId: string;
  /** Oldest first, from `groupActivity`. */
  readonly entries: readonly ActivityEntry[];
}

/** An agent command is held until the person answers the one question about this device, asked in the chat. */
export interface AttentionQuestion {
  readonly kind: "question";
  readonly deviceId: string;
  /** How many commands wait behind it. */
  readonly waiting: number;
  /** The operations that wait, so the person can cancel them without answering. */
  readonly operationIds: readonly string[];
  readonly since: number;
}

/** A command that is counting down to being sent and can still be cancelled. */
export interface AttentionCountdown {
  readonly kind: "countdown";
  readonly deviceId: string;
  readonly job: Job;
  readonly operation: DeviceOperationSnapshot;
  readonly releaseAt: number;
}

/** A job that failed or was stopped, until the person has seen it. `keys` are what acknowledging it acknowledges. */
export interface AttentionProblem {
  readonly kind: "problem";
  readonly deviceId: string;
  readonly job: Job;
  readonly keys: readonly string[];
}

/** A zip or a save to the server that failed, until the person has seen it. The transfer's id is what acknowledging it records. */
export interface AttentionTransfer {
  readonly kind: "transfer";
  readonly job: TransferJob;
}

export type AttentionItem = AttentionQuestion | AttentionCountdown | AttentionProblem | AttentionTransfer;

export interface HistoryDay {
  /** `YYYY-MM-DD` in the zone the view was built for. */
  readonly key: string;
  readonly when: "today" | "yesterday" | "earlier";
  /** A moment inside that day, for writing its date. */
  readonly at: number;
  /** Newest first. */
  readonly entries: readonly ActivityEntry[];
}

export interface HistoryGroup {
  readonly deviceId: string;
  /** Newest day first. */
  readonly days: readonly HistoryDay[];
  readonly count: number;
}

export interface ActivityView {
  /** Countdowns (soonest first), then questions, then problems and failed transfers (newest first). */
  readonly needsYou: readonly AttentionItem[];
  /** Jobs that are running, newest first. */
  readonly live: readonly Job[];
  /** Everything else, per device that has any, the device that did something last first. */
  readonly history: readonly HistoryGroup[];
}

/** The calendar day of a moment in a time zone (the device's own when none is given), as `YYYY-MM-DD`. */
export function dayKey(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousDay(key: string): string {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** What the problem keys of a job are: the operations that failed or were stopped. */
export function problemKeys(job: Job): string[] {
  return problemMembers(job).map((member) => member.id);
}

/**
 * The panel's order. `acknowledged` holds the operation ids of failures the person has seen: a job whose every problem
 * is acknowledged moves to history; a new failure in it raises it again.
 */
export function activityView(devices: readonly DeviceEntries[], options: { now: number; acknowledged: ReadonlySet<string>; timeZone?: string; transfers?: readonly TransferJob[] }): ActivityView {
  const { now, acknowledged, timeZone } = options;
  const countdowns: AttentionCountdown[] = [];
  const questions: AttentionQuestion[] = [];
  const problems: AttentionProblem[] = [];
  const live: Job[] = [];
  const past: Array<{ deviceId: string; entry: ActivityEntry }> = [];

  for (const { deviceId, entries } of devices) {
    const waitingIds: string[] = [];
    let since = Infinity;
    for (const entry of entries) {
      if (entry.kind === "burst") {
        past.push({ deviceId, entry });
        continue;
      }
      if (entry.phase === "waiting") {
        for (const member of entry.members) if (member.state === "awaiting-trust") waitingIds.push(member.id);
        since = Math.min(since, entry.startedAt);
      } else if (entry.phase === "countdown") {
        const operation = entry.members.find((member) => member.state === "countdown");
        const releaseAt = operation?.countdown?.releaseAt;
        if (operation && releaseAt !== undefined) countdowns.push({ kind: "countdown", deviceId, job: entry, operation, releaseAt });
      } else if (entry.phase === "running") {
        live.push(entry);
      } else if ((entry.phase === "failed" || entry.phase === "stopped") && problemKeys(entry).some((key) => !acknowledged.has(key))) {
        problems.push({ kind: "problem", deviceId, job: entry, keys: problemKeys(entry) });
      } else {
        past.push({ deviceId, entry });
      }
    }
    if (waitingIds.length > 0) questions.push({ kind: "question", deviceId, waiting: waitingIds.length, operationIds: waitingIds, since });
  }

  countdowns.sort((left, right) => left.releaseAt - right.releaseAt);
  questions.sort((left, right) => left.since - right.since);
  problems.sort((left, right) => right.job.endedAt - left.job.endedAt);
  const transferProblems: AttentionTransfer[] = (options.transfers ?? [])
    .filter((job) => job.state === "failed" && !acknowledged.has(job.id))
    .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))
    .map((job) => ({ kind: "transfer", job }));
  live.sort((left, right) => right.startedAt - left.startedAt);

  const today = dayKey(now, timeZone);
  const yesterday = previousDay(today);
  const byDevice = new Map<string, ActivityEntry[]>();
  for (const { deviceId, entry } of past) byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), entry]);
  const history: HistoryGroup[] = [...byDevice].map(([deviceId, entries]) => {
    const newestFirst = [...entries].sort((left, right) => right.endedAt - left.endedAt);
    const days: Array<{ key: string; when: HistoryDay["when"]; at: number; entries: ActivityEntry[] }> = [];
    for (const entry of newestFirst) {
      const key = dayKey(entry.endedAt, timeZone);
      const current = days[days.length - 1];
      if (current && current.key === key) current.entries.push(entry);
      else days.push({ key, when: key === today ? "today" : key === yesterday ? "yesterday" : "earlier", at: entry.endedAt, entries: [entry] });
    }
    return { deviceId, days, count: newestFirst.length };
  });
  history.sort((left, right) => right.days[0]!.at - left.days[0]!.at);

  return { needsYou: [...countdowns, ...questions, ...problems, ...transferProblems], live, history };
}

/** How many operations an entry stands for. */
export function entrySize(entry: ActivityEntry): number {
  return entry.kind === "burst" ? entry.operations.length : entry.members.length;
}

/**
 * The partition table the device reported before this job began (the newest successful `printgpt` of that device that
 * started no later than the job), as the items a backup is measured against. A table read after the job began is not
 * what the job was working from.
 */
export function planBefore(operations: readonly DeviceOperationSnapshot[], job: Job): readonly PlannedItem[] | undefined {
  const read = operations.findLast((operation) => operation.request.deviceId === job.deviceId && operation.state === "succeeded" && commandWord(operation) === "printgpt" && operation.createdAt <= job.startedAt);
  const plan = plannedItems(read?.result?.details);
  return plan.length > 0 ? plan : undefined;
}
