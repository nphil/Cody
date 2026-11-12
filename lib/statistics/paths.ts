/**
 * Where the Statistics feature reads and writes. This is the only file of the
 * feature that reaches into `lib/omp/paths`; everything else is handed a
 * directory, so tests can point the indexer at a copy and never touch the live
 * data dir.
 */

import path from "node:path";
import { getAgentDir, getSessionsDir, getSidebarChatsDir } from "../omp/paths";

/** Cody's own derived state: the index and the background-job usage logs. */
export function statisticsDir(): string {
  return path.join(getAgentDir(), "cody-statistics");
}

/** omp's chat transcripts, read-only. */
export function transcriptRoots(): { sessions: string[]; sidebar: string[] } {
  return { sessions: [getSessionsDir()], sidebar: [getSidebarChatsDir()] };
}
