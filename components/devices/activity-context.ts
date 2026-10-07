import type { Job, PlannedItem } from "@/lib/devices/jobs";
import type { DeviceOperationManager } from "@/lib/devices/operations";

/** What the detail sheet is showing: a job (and optionally one operation of it), one operation on its own, or one file. */
export type DetailSubject =
  | { readonly kind: "job"; readonly jobId: string; readonly operationId?: string }
  | { readonly kind: "operation"; readonly operationId: string }
  | { readonly kind: "file"; readonly artifactId: string };

/** The files a job saved, found through the operations that saved them. */
export interface JobFiles {
  readonly setId: string;
  readonly count: number;
  readonly bytes: number;
}

/** What the activity components need from the panel around them, passed once instead of drilled through every row. */
export interface ActivityContext {
  readonly manager: DeviceOperationManager | null;
  readonly now: number;
  readonly locale: string;
  /** Several devices are in play, so a job says which one it ran on. */
  readonly showDevice: boolean;
  deviceLabel(deviceId: string): string;
  /** The device is still plugged in and granted; a device that left is named in history as such. */
  connected(deviceId: string): boolean;
  /** The partition table the device reported before this job began, when it did. */
  planFor(job: Job): readonly PlannedItem[] | undefined;
  filesOf(job: Job): JobFiles | undefined;
  openDetails(subject: DetailSubject): void;
  showFiles(setId: string): void;
  acknowledge(keys: readonly string[]): void;
}
