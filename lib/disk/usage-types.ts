/**
 * What `/api/disk/usage` answers, shared with the Settings card. Types only: a
 * client component may import this file, never lib/disk/usage.ts (it reads the
 * file system).
 */

export type UsageVolume = "data" | "tmp";

/** What a folder is, in terms of what a person may do with it (see usage-rules.ts). */
export type UsageKind = "rebuild" | "cache" | "engine" | "engine-keep" | "mine";

/** What the card offers for Cody's and the engine's own data: it never deletes these by path. */
export type UsageAction = "chats" | "janitor" | "blobs";

export interface UsageNode {
  name: string;
  /** Absolute path (the scan stores names; the server joins them). */
  path: string;
  /** Allocated bytes, as `du` counts. */
  bytes: number;
  /** Newest modification time of anything inside, ms. 0 when unknown. */
  changedMs: number;
  dir: boolean;
  kind: UsageKind;
  /** Key under `diskUsage.rule.*`: what it is. */
  rule?: string;
  /** The label comes from a folder above it (shown quietly, no buttons). */
  inherited?: boolean;
  /** Offer a Clear button (the server re-checks everything when it is pressed). */
  deletable?: boolean;
  action?: UsageAction;
  /** The file viewer can open this folder (it is a project folder a chat knows). */
  inFiles?: boolean;
  children?: UsageNode[];
  /** Entries below this one that were folded together, not listed. */
  otherBytes?: number;
  otherCount?: number;
}

export interface UsageRoot {
  path: string;
  label: "agent" | "home" | "tmp";
  node: UsageNode;
}

export interface UsageCandidate {
  path: string;
  bytes: number;
  changedMs: number;
  rule: string;
  kind: UsageKind;
}

export interface UsageResult {
  volume: UsageVolume;
  startedAt: number;
  finishedAt: number | null;
  /** False: stopped early (time) or still running; the numbers are lower bounds. */
  complete: boolean;
  reason?: string;
  scannedBytes: number;
  entries: number;
  roots: UsageRoot[];
  /** Build output across the whole walk, biggest first (only recognised, deletable kinds). */
  rebuildable: UsageCandidate[];
}

export interface UsageScanState {
  running: boolean;
  /** The volume the running scan walks, null when none runs. */
  volume: UsageVolume | null;
  startedAt: number | null;
  /** Files and folders seen so far by the running scan. */
  entries: number;
  scannedBytes: number;
}

export interface UsagePayload {
  volume: UsageVolume;
  /** The newest finished scan, else the running scan's progress, else null. */
  result: UsageResult | null;
  /** `result` is a running scan's partial progress, not a finished one. */
  partial: boolean;
  scan: UsageScanState;
  canEdit: boolean;
  /** Shown and used by "clear all build output older than N days". */
  olderThanDays: number;
  /** The server cannot run a scan at all (no scanner file). */
  unavailable?: boolean;
}

export type ClearRefusalCode =
  | "not-recognised"
  | "outside"
  | "symlink"
  | "missing"
  | "recent"
  | "in-use"
  | "chat-cwd"
  | "unmeasurable"
  | "mount"
  | "process-table"
  | "busy";

export interface ClearRefusal {
  code: ClearRefusalCode;
  /** Minutes, for `recent`; a process or chat hint otherwise. */
  detail?: string | number;
}

export interface ClearPlan {
  path: string;
  kind: UsageKind;
  rule: string;
  bytes: number;
  entries: number;
  changedMs: number;
}

export interface ClearAnswer {
  /** Set when the item may be cleared (preview) or was (clear). */
  plan?: ClearPlan;
  refused?: ClearRefusal;
  freedBytes?: number;
  cleared?: boolean;
}

export interface ClearManyAnswer {
  cleared: number;
  freedBytes: number;
  refused: number;
  /** Stopped before the end (time budget): run it again for the rest. */
  stoppedEarly: boolean;
}

export interface UsageChat {
  id: string;
  title: string;
  bytes: number;
  modifiedMs: number;
  cwd: string;
}

export interface UsageChatsPayload {
  totalBytes: number;
  count: number;
  /** Capped; sorted as asked. */
  chats: UsageChat[];
}
