import type { PlanOverlay, PlanOverlaySubtask, TodoItem, TodoPhase } from "../pi-types";

/**
 * The plan as a person reads it: which tasks Cody checked off, which finished
 * tasks sit behind a one-line summary, which phase is the current one, and
 * what short label a long task shows.
 *
 * Pure and free of server imports on purpose. The browser lays the list out
 * with it (components/TodoList.tsx), the server applies the keeper's
 * check-offs with it before a list leaves (lib/rpc-manager.ts buildWebState,
 * app/api/sessions/[id]/route.ts), and the keeper asks the model to summarise
 * exactly the groups it produces (keeper.ts) — one function, so what is
 * folded and what was summarised can never disagree.
 */

/** A phase folds its finished tasks once it holds more than this many. */
const FOLD_PHASE_DONE = 8;
/** Every phase folds once the list would show more than this many rows. */
const FOLD_LIST_ROWS = 15;
/** Fewer finished tasks in a row than this stay as they are: a fold of two
 * hides text without saving a line worth having. */
const FOLD_MIN_RUN = 3;
/** One summary line stands for at most this many tasks, so it can still say
 * something. Doubled only when a phase would otherwise need more than
 * FOLD_MAX_PER_PHASE summaries. */
const FOLD_CHUNK = 8;
const FOLD_MAX_PER_PHASE = 3;

/** A task text longer than this is worth a short label. */
export const LABEL_MIN_CHARS = 60;

/** Still to do. `blocked` counts: real plans park whole backlogs as blocked
 * and finish them anyway. */
export function isOpenTask(task: Pick<TodoItem, "status">): boolean {
  return task.status === "pending" || task.status === "in_progress" || task.status === "blocked";
}

/** One task inside one phase — the engine's own identity rule (a task is its
 * exact text within its phase), so two phases can each hold a "Run the
 * tests". Also the key of the fold that STARTS at that task. */
export function planTaskKey(phaseName: string, content: string): string {
  return `${phaseName}\u0000${content}`;
}

/**
 * `phases` with every still-open task named in `keys` completed and, as the
 * engine's own `todo done` does, the next pending task started when that
 * leaves nothing in progress. A task that is already closed is never
 * touched, nothing is reordered, and the SAME array comes back when nothing
 * changed.
 */
export function completeTasks(phases: TodoPhase[], keys: ReadonlySet<string>): { phases: TodoPhase[]; completed: string[] } {
  const completed: string[] = [];
  if (keys.size === 0) return { phases, completed };
  const next = phases.map((phase) => {
    let touched = false;
    const tasks = phase.tasks.map((task): TodoItem => {
      const key = planTaskKey(phase.name, task.content);
      if (!isOpenTask(task) || !keys.has(key)) return task;
      touched = true;
      completed.push(key);
      return { ...task, status: "completed" };
    });
    return touched ? { ...phase, tasks } : phase;
  });
  if (completed.length === 0) return { phases, completed };
  if (!next.some((phase) => phase.tasks.some((task) => task.status === "in_progress"))) {
    const phaseIndex = next.findIndex((phase) => phase.tasks.some((task) => task.status === "pending"));
    if (phaseIndex !== -1) {
      const phase = next[phaseIndex];
      const taskIndex = phase.tasks.findIndex((task) => task.status === "pending");
      next[phaseIndex] = { ...phase, tasks: phase.tasks.map((task, index): TodoItem => (index === taskIndex ? { ...task, status: "in_progress" } : task)) };
    }
  }
  return { phases: next, completed };
}

/** The keeper's check-offs that name their phase. An entry written before
 * phases were recorded is a bare task text: it still earns the auto-mark, but
 * it cannot say which task it meant, so it never completes one. */
export function checkedTaskKeys(overlay: Pick<PlanOverlay, "autoCompleted"> | null | undefined): Set<string> {
  const list = Array.isArray(overlay?.autoCompleted) ? overlay.autoCompleted : [];
  return new Set(list.filter((entry) => typeof entry === "string" && entry.includes("\u0000")));
}

/**
 * The list as Cody knows it: the engine's phases with the keeper's check-offs
 * applied. The engine forgets a check-off it was given whenever it rebuilds
 * its list from the session file (a compaction, a restart, the agent's own
 * rewind), and a chat with no engine running only has that file — the
 * overlay is the record that survives both.
 */
export function applyPlanOverlay(phases: TodoPhase[], overlay: PlanOverlay | null | undefined): TodoPhase[] {
  return completeTasks(phases, checkedTaskKeys(overlay)).phases;
}

// ------------------------------------------------------------------ view ---

export interface PlanViewTask {
  kind: "task";
  task: TodoItem;
  /** Shown instead of the task's own text; the text stays one tap away. */
  label: string | null;
  /** The keeper, not the agent, checked this one off. */
  autoCompleted: boolean;
  subtasks: PlanOverlaySubtask[];
}

export interface PlanViewFold {
  kind: "fold";
  key: string;
  /** The keeper's line for this group, or null until it has written one. */
  summary: string | null;
  /** The finished tasks behind the line, in their original order. */
  tasks: PlanViewTask[];
  /** Nothing more can join this group: its phase is finished, or the run of
   * finished tasks already continues into the next group. */
  settled: boolean;
}

export type PlanViewRow = PlanViewTask | PlanViewFold;

export interface PlanViewPhase {
  id?: string;
  name: string;
  done: number;
  total: number;
  /** Nothing left to do in it: every task is completed or abandoned. */
  finished: boolean;
  /** Holds the task being worked on (or, with none, the next one to do). */
  current: boolean;
  /** Shown expanded: the current phase always, every unfinished phase while
   * the list is short. A finished phase is one line, unless it is the only
   * phase (that line would say nothing the list's own count does not). */
  open: boolean;
  rows: PlanViewRow[];
}

export interface PlanView {
  phases: PlanViewPhase[];
  done: number;
  total: number;
}

interface FoldSpan {
  start: number;
  length: number;
}

function chunkRun(run: FoldSpan, size: number): FoldSpan[] {
  const spans: FoldSpan[] = [];
  for (let offset = 0; offset < run.length; offset += size) {
    const length = Math.min(size, run.length - offset);
    // A tail too short to fold stays as ordinary rows until it grows.
    if (length >= FOLD_MIN_RUN) spans.push({ start: run.start + offset, length });
  }
  return spans;
}

/**
 * Where one phase folds. Only unbroken runs of completed tasks, cut into
 * chunks that START at fixed offsets, so a chunk that is full never changes
 * again and its summary stays true while the run keeps growing behind it.
 */
function foldSpans(tasks: readonly TodoItem[]): FoldSpan[] {
  const runs: FoldSpan[] = [];
  for (let index = 0; index < tasks.length;) {
    if (tasks[index].status !== "completed") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < tasks.length && tasks[end].status === "completed") end += 1;
    if (end - index >= FOLD_MIN_RUN) runs.push({ start: index, length: end - index });
    index = end;
  }
  if (runs.length === 0) return [];

  const longest = Math.max(...runs.map((run) => run.length));
  let size = FOLD_CHUNK;
  let spans = runs.flatMap((run) => chunkRun(run, size));
  while (spans.length > FOLD_MAX_PER_PHASE && size < longest) {
    size *= 2;
    spans = runs.flatMap((run) => chunkRun(run, size));
  }
  if (spans.length <= FOLD_MAX_PER_PHASE) return spans;
  // More separate runs than summaries allowed: fold the longest, in place.
  return [...spans]
    .sort((a, b) => b.length - a.length || a.start - b.start)
    .slice(0, FOLD_MAX_PER_PHASE)
    .sort((a, b) => a.start - b.start);
}

function recordOf<T>(value: unknown): Record<string, T> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, T> : {};
}

function tasksOf(phase: TodoPhase): TodoItem[] {
  return Array.isArray(phase?.tasks) ? phase.tasks : [];
}

/**
 * Lay the plan out for reading. `phases` is the list as it should be shown
 * (the server has already applied the keeper's check-offs); the overlay only
 * decorates it here. Folding never hides a task that is still to do, and
 * never drops one: every task appears exactly once, in its original order,
 * either as its own row or inside the fold that stands for it.
 */
export function buildPlanView(phases: readonly TodoPhase[], overlay?: PlanOverlay | null): PlanView {
  const subtasks = recordOf<PlanOverlaySubtask[]>(overlay?.subtasks);
  const labels = recordOf<string>(overlay?.labels);
  const folds = recordOf<{ summary?: unknown; count?: unknown }>(overlay?.folds);
  const autoCompleted = new Set(Array.isArray(overlay?.autoCompleted) ? overlay.autoCompleted : []);

  const finishedFlags = phases.map((phase) => {
    const tasks = tasksOf(phase);
    return tasks.length > 0 && !tasks.some(isOpenTask);
  });
  const collapseFinished = phases.length > 1;
  const visibleRows = phases.reduce((sum, phase, index) => sum + (finishedFlags[index] && collapseFinished ? 1 : tasksOf(phase).length), 0);
  const longList = visibleRows > FOLD_LIST_ROWS;
  const hasStatus = (status: TodoItem["status"]) => phases.findIndex((phase) => tasksOf(phase).some((task) => task.status === status));
  const currentIndex = [hasStatus("in_progress"), hasStatus("pending"), hasStatus("blocked")].find((index) => index !== -1) ?? -1;

  let done = 0;
  let total = 0;
  const viewPhases = phases.map((phase, phaseIndex): PlanViewPhase => {
    const tasks = tasksOf(phase);
    const completed = tasks.filter((task) => task.status === "completed").length;
    done += completed;
    total += tasks.length;

    const toRow = (task: TodoItem): PlanViewTask => {
      const label = labels[task.content];
      const list = subtasks[task.content];
      return {
        kind: "task",
        task,
        label: typeof label === "string" && label.trim() && label !== task.content ? label : null,
        autoCompleted: autoCompleted.has(planTaskKey(phase.name, task.content)) || autoCompleted.has(task.content),
        subtasks: Array.isArray(list) ? list : [],
      };
    };

    const spans = longList || completed > FOLD_PHASE_DONE ? foldSpans(tasks) : [];
    const rows: PlanViewRow[] = [];
    let index = 0;
    for (const span of spans) {
      while (index < span.start) rows.push(toRow(tasks[index++]));
      const key = planTaskKey(phase.name, tasks[span.start].content);
      const stored = folds[key];
      // A summary written for MORE tasks than the fold now holds may describe
      // work that is no longer in it; one written for fewer is still true.
      const summary = stored && typeof stored.summary === "string" && typeof stored.count === "number" && stored.count <= span.length
        ? stored.summary
        : null;
      const end = span.start + span.length;
      rows.push({
        kind: "fold",
        key,
        summary,
        tasks: tasks.slice(span.start, end).map(toRow),
        settled: finishedFlags[phaseIndex] || tasks[end]?.status === "completed",
      });
      index = end;
    }
    while (index < tasks.length) rows.push(toRow(tasks[index++]));

    const finished = finishedFlags[phaseIndex];
    const current = phaseIndex === currentIndex;
    return {
      ...(phase.id ? { id: phase.id } : {}),
      name: phase.name,
      done: completed,
      total: tasks.length,
      finished,
      current,
      open: finished ? !collapseFinished : current || !longList,
      rows,
    };
  });
  return { phases: viewPhases, done, total };
}

export interface PlanFoldGroup {
  key: string;
  phase: string;
  /** Exact text of the finished tasks the fold stands for. */
  tasks: string[];
}

/**
 * The folds of the current layout whose line is missing or out of date: none
 * written yet, one written for tasks that have since left the group, a
 * settled group that has grown since, or a growing one that has outgrown its
 * line by FOLD_MIN_RUN tasks. A group that grows one task at a time keeps its
 * line in between — asking again for every task would cost a model call each.
 */
export function planFoldsToSummarise(phases: readonly TodoPhase[], overlay: PlanOverlay | null | undefined): PlanFoldGroup[] {
  const folds = recordOf<{ count?: unknown }>(overlay?.folds);
  const groups: PlanFoldGroup[] = [];
  for (const phase of buildPlanView(phases, overlay).phases) {
    for (const row of phase.rows) {
      if (row.kind !== "fold") continue;
      const size = row.tasks.length;
      const written = folds[row.key]?.count;
      if (typeof written === "number" && written <= size && (row.settled ? written === size : size - written < FOLD_MIN_RUN)) continue;
      groups.push({ key: row.key, phase: phase.name, tasks: row.tasks.map((item) => item.task.content) });
    }
  }
  return groups;
}
