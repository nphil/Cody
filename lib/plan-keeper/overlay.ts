import { readFileSync } from "fs";
import path from "path";
import { isRecord } from "../type-guards";
import type { PlanOverlay, PlanOverlayFold, PlanOverlaySubtask, TodoPhase } from "../pi-types";
import { getPlanKeeperOverlayDir, writeJsonAtomic } from "./config";
import { planTaskKey } from "./fold";

/**
 * Per-session persistence for the plan keeper's overlay: the tasks it checked
 * off, its subtasks, its short labels and its summaries of finished work.
 * Cody's own derived state, like Distill's summary cache
 * (lib/distill/cache.ts): never written into the engine's session file, one
 * JSON file per session, session id validated the same way before it ever
 * reaches a path.
 */

export type { PlanOverlay, PlanOverlaySubtask };

/** Session ids come from the engine and end up in a file name. Anything that
 * is not a plain id is simply not persisted — there is no safe way to spell a
 * path separator in one, and refusing beats sanitizing into a collision. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function overlayPath(sessionId: string): string | null {
  if (!SAFE_ID_RE.test(sessionId) || sessionId === "." || sessionId === "..") return null;
  return path.join(getPlanKeeperOverlayDir(), `${sessionId}.json`);
}

function readSubtaskList(value: unknown): PlanOverlaySubtask[] {
  if (!Array.isArray(value)) return [];
  const out: PlanOverlaySubtask[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.content !== "string" || !entry.content.trim()) continue;
    out.push({ content: entry.content, status: entry.status === "completed" ? "completed" : "pending" });
  }
  return out;
}

/** The session's overlay, or null when there is none yet — the keeper never
 * ran, or the file is missing/corrupt. Both read as "nothing to show", same
 * as a brand new session. A file written before labels and summaries existed
 * reads with none. */
export function readPlanOverlay(sessionId: string): PlanOverlay | null {
  const file = overlayPath(sessionId);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const subtasks: Record<string, PlanOverlaySubtask[]> = {};
  if (isRecord(parsed.subtasks)) {
    for (const [key, value] of Object.entries(parsed.subtasks)) {
      const list = readSubtaskList(value);
      if (list.length > 0) subtasks[key] = list;
    }
  }
  const autoCompleted = Array.isArray(parsed.autoCompleted)
    ? parsed.autoCompleted.filter((value): value is string => typeof value === "string")
    : [];
  const labels: Record<string, string> = {};
  if (isRecord(parsed.labels)) {
    for (const [content, label] of Object.entries(parsed.labels)) {
      if (typeof label === "string" && label.trim()) labels[content] = label;
    }
  }
  const folds: Record<string, PlanOverlayFold> = {};
  if (isRecord(parsed.folds)) {
    for (const [key, value] of Object.entries(parsed.folds)) {
      if (isRecord(value) && typeof value.summary === "string" && value.summary.trim() && typeof value.count === "number") {
        folds[key] = { summary: value.summary, count: value.count };
      }
    }
  }
  const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
  return { subtasks, autoCompleted, labels, folds, updatedAt };
}

/** Replace the session's overlay. A write that fails just means the next
 * reload shows the previous overlay — never a crash, never a half-written
 * file (writeJsonAtomic). */
export function writePlanOverlay(sessionId: string, overlay: PlanOverlay): void {
  const file = overlayPath(sessionId);
  if (!file) return;
  try {
    writeJsonAtomic(file, { version: 2, ...overlay });
  } catch (error) {
    // A slower feature next time, not a broken one now.
    console.debug("[plan-keeper] could not persist the overlay:", error);
  }
}

/**
 * Drop everything the overlay holds about tasks that are no longer in the
 * CURRENT phases. A list the agent replaced wholesale (a new plan for a new
 * stretch of work) must not drag a stale check-off, checklist or label under
 * a task name that happens to repeat, and an overlay must not grow forever
 * across a very long session.
 */
export function prunePlanOverlay(overlay: PlanOverlay, phases: readonly TodoPhase[]): PlanOverlay {
  const contents = new Set<string>();
  const keys = new Set<string>();
  for (const phase of phases) {
    for (const task of phase.tasks) {
      contents.add(task.content);
      keys.add(planTaskKey(phase.name, task.content));
    }
  }
  const keep = <T>(record: Record<string, T>, live: ReadonlySet<string>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => live.has(key)));
  return {
    subtasks: keep(overlay.subtasks, contents),
    autoCompleted: overlay.autoCompleted.filter((entry) => keys.has(entry) || contents.has(entry)),
    labels: keep(overlay.labels, contents),
    folds: keep(overlay.folds, keys),
    updatedAt: overlay.updatedAt,
  };
}

/** An overlay with nothing in it yet — what a session without one behaves as. */
export function emptyPlanOverlay(): PlanOverlay {
  return { subtasks: {}, autoCompleted: [], labels: {}, folds: {}, updatedAt: 0 };
}
