/**
 * The one call `lib/model-plan/one-shot.ts` makes to account for a background
 * job's model call. See ./joblog for why these calls need a log of their own.
 */

import { appendJobLog, toJobLogEntry, type OneShotUsageTag } from "./joblog";
import { statisticsDir } from "./paths";

export type { OneShotPurpose, OneShotUsageTag } from "./joblog";

/**
 * Appends one finished assistant message to the job log. Never throws: a full
 * disk or a read-only data dir must not fail a chat title.
 */
export function recordOneShotUsage(tag: OneShotUsageTag, message: unknown, options: { dir?: string; now?: number } = {}): void {
  try {
    const entry = toJobLogEntry(tag, message, options.now ?? Date.now());
    if (entry) appendJobLog(options.dir ?? statisticsDir(), entry);
  } catch {
    // Accounting is a convenience; the job it describes already succeeded.
  }
}
