/**
 * The human names the Statistics page puts on its numbers: chat titles, and
 * which project a working directory belongs to. They come from the live session
 * list and the side chats' own headers, never from the index, because titles
 * change after the usage they label was recorded.
 *
 * Never throws: a missing label only means the page shows a plainer name until
 * the next request.
 */

import path from "node:path";
import { getSidebarChatsDir } from "../omp/paths";
import { readSessionHeaderSync } from "../omp/session-files";
import { listAllSessions } from "../session-reader";
import type { SessionInfo } from "../types";
import { NO_LABELS, type StatsLabels } from "./query";
import type { StatsStore } from "./store";

/** Side-chat headers read per request, so a first call over a huge sidebar stays quick. */
const MAX_HEADER_READS = 300;
const TITLE_CHARS = 80;

/** A side chat's title by transcript path, valid while the file is unchanged. */
const sidebarTitles = new Map<string, { mtimeMs: number; title: string }>();

function chatTitle(session: SessionInfo): string {
  const named = session.name?.trim();
  if (named) return named;
  const first = session.firstMessage.replace(/\s+/g, " ").trim();
  return first && first !== "(no messages)" ? Array.from(first).slice(0, TITLE_CHARS).join("") : "";
}

function addSidebarTitles(store: StatsStore, titles: Map<string, string>): void {
  let reads = 0;
  for (const file of store.files.values()) {
    if (file.kind !== "sidebar" || file.gone) continue;
    let known = sidebarTitles.get(file.path);
    if (!known || known.mtimeMs !== file.mtimeMs) {
      if (reads >= MAX_HEADER_READS) continue;
      reads += 1;
      known = { mtimeMs: file.mtimeMs, title: readSessionHeaderSync(file.path)?.title?.trim() ?? "" };
      sidebarTitles.set(file.path, known);
    }
    if (known.title) titles.set(file.chat, known.title);
  }
}

export async function loadLabels(store: StatsStore): Promise<StatsLabels> {
  const titles = new Map<string, string>();
  const projectOf = new Map<string, string>();
  try {
    for (const session of await listAllSessions()) {
      const title = chatTitle(session);
      if (title) titles.set(session.id, title);
      if (session.cwd) projectOf.set(session.cwd, session.projectRoot || session.cwd);
    }
  } catch {
    // The session list is a nicety here; the index carries the numbers.
  }
  try {
    addSidebarTitles(store, titles);
  } catch {
    // A header that cannot be read leaves its chat untitled.
  }
  // Side chats opened with no project run in a scratch directory that is not a project.
  projectOf.set(path.join(getSidebarChatsDir(), "cwd"), "");
  return { titles, projectOf };
}

/** How long one load of the labels answers every request, so a page that polls does not re-list every chat each time. */
const LABELS_TTL_MS = 15_000;

interface LabelsLoad {
  at: number;
  /** The labels once the load has finished, else null. */
  done: StatsLabels | null;
  promise: Promise<StatsLabels>;
}

let current: LabelsLoad | null = null;

export interface LabelsAnswer {
  labels: StatsLabels;
  /** False when the load had not finished in time and `labels` is the plain fallback. */
  ready: boolean;
}

/**
 * The labels, waiting at most `waitMs` for a load that is still running. A late
 * load keeps going and answers the next request, so a slow session list costs
 * one page view some plain names, never a stalled request.
 */
export async function labelsWithin(store: StatsStore, waitMs: number, now: number = Date.now()): Promise<LabelsAnswer> {
  if (!current || now - current.at > LABELS_TTL_MS) {
    const load: LabelsLoad = { at: now, done: null, promise: loadLabels(store).catch(() => NO_LABELS) };
    void load.promise.then((labels) => {
      load.done = labels;
    });
    current = load;
  }
  const load = current;
  if (load.done) return { labels: load.done, ready: true };
  const timer = Promise.withResolvers<null>();
  const handle = setTimeout(() => timer.resolve(null), waitMs);
  try {
    const labels = await Promise.race([load.promise, timer.promise]);
    return labels ? { labels, ready: true } : { labels: NO_LABELS, ready: false };
  } finally {
    clearTimeout(handle);
  }
}
