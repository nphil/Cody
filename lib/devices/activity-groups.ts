/**
 * How the Devices panel lists what happened on a device.
 *
 * An agent that looks over a device sends a burst of small commands, and one
 * card per command buried everything the person had to act on. A command the
 * agent ran that never needed an approval, changed nothing it reports, and
 * saved no file is routine: those are folded, per device, into one compact
 * entry per burst ("Agent ran 7 fastboot commands") whose rows expand to the
 * full card of each command. Anything else - an approval waiting, a command
 * still running, a flash or backup, a command the person ran themselves - keeps
 * its own full card, and whatever needs the person is listed first.
 *
 * Pure and browser-safe: the panel renders it, the tests pin it.
 */

import type { DeviceOperationSnapshot, OperationState } from "./operations";

/** Two routine commands further apart than this are two bursts, however alike they are. */
export const BURST_GAP_MS = 2 * 60_000;

/** Actions whose result is an answer on the screen; the rest move files or hold the device. */
const ROUTINE_ACTIONS: Record<string, true> = { detect: true, exec: true, verify: true };

export interface ActivitySingle {
  kind: "single";
  operation: DeviceOperationSnapshot;
}

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

export type ActivityEntry = ActivitySingle | ActivityBurst;

export function isFinishedState(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** Waiting on the person: it must never be folded away or scrolled out of sight. */
export function needsPerson(operation: DeviceOperationSnapshot): boolean {
  return operation.state === "awaiting-confirmation" || operation.state === "armed";
}

/** A finished command the agent ran that asked for no approval and saved no file. */
export function isRoutine(operation: DeviceOperationSnapshot): boolean {
  return operation.origin === "agent"
    && isFinishedState(operation.state)
    && !operation.approvalAsked
    && ROUTINE_ACTIONS[operation.request.action] === true
    && !operation.result?.fileId;
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
  return { kind: "burst", id: members[0].id, operations: members, protocols, startedAt, endedAt, succeeded, failed, cancelled };
}

/**
 * `operations` is one device's history, oldest first. The result is in display order: what needs the person, then
 * everything else newest first. A routine command joins the burst before it only when nothing else happened on the
 * device in between and the gap is under BURST_GAP_MS.
 */
export function groupActivity(operations: readonly DeviceOperationSnapshot[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let run: DeviceOperationSnapshot[] = [];
  const closeRun = (): void => {
    if (run.length > 0) entries.push(burstOf(run));
    run = [];
  };
  for (const operation of operations) {
    if (!isRoutine(operation)) {
      closeRun();
      entries.push({ kind: "single", operation });
      continue;
    }
    const last = run[run.length - 1];
    if (last && operation.createdAt - last.updatedAt > BURST_GAP_MS) closeRun();
    run.push(operation);
  }
  closeRun();
  const waiting = entries.filter((entry) => entry.kind === "single" && needsPerson(entry.operation));
  const rest = entries.filter((entry) => !waiting.includes(entry));
  return [...waiting.reverse(), ...rest.reverse()];
}

/** How many operations an entry stands for. */
export function entrySize(entry: ActivityEntry): number {
  return entry.kind === "burst" ? entry.operations.length : 1;
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
