import type { DiskArea } from "./status";
import type { DiskSettings } from "./settings";
import type { JanitorRemoval, JanitorTrigger } from "./janitor";

/**
 * What `/api/disk` answers, shared with the Settings card. Types only: a client
 * component may import this file, but never lib/disk/janitor.ts or lib/disk-space.ts
 * themselves (they read the file system, and `fs` must stay out of the browser
 * bundle).
 */

export type { DiskArea, DiskSettings, JanitorRemoval };

/** The janitor's last pass, trimmed for the card. */
export interface DiskLastRun {
  trigger: JanitorTrigger;
  startedAt: number;
  finishedAt: number;
  freedBytes: number;
  /** How many things were removed in total (`removed` may hold fewer). */
  removedCount: number;
  /** At most 50 entries, and only for someone who may change the settings. */
  removed: JanitorRemoval[];
  errorCount: number;
}

export interface DiskScratchFolder {
  /** The chat's title, or "Unknown chat" / "Deleted chat" when the requester
   *  cannot see one. */
  title: string;
  bytes: number;
  lastUsedAt: number;
  /** A running session's folder: the janitor never removes it. */
  live: boolean;
}

export interface DiskPayload {
  areas: DiskArea[];
  settings: DiskSettings;
  lastRun: DiskLastRun | null;
  /** Up to five, biggest first. */
  largestScratch: DiskScratchFolder[];
  /** Total size of the workspace undo snapshots at the last janitor pass. */
  checkpointBytes: number;
  running: boolean;
  canEdit: boolean;
  /** Present only on the answer to a manual clean. */
  freedBytes?: number;
}
