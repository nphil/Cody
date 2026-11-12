"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleAlert, CircleDotDashed, ListChecks, Wand2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { buildPlanView, type PlanViewFold, type PlanViewTask } from "@/lib/plan-keeper/fold";
import type { PlanOverlay, TodoItem, TodoPhase } from "@/lib/pi-types";

/** Every expandable line here is a native disclosure, so open/closed state,
 * keyboard and screen-reader behaviour come from the browser. Its own
 * triangle is replaced by the chevron each line draws. */
const SUMMARY_CLASS = "cursor-pointer list-none [&::-webkit-details-marker]:hidden";
/** Tailwind's rotate-* sets the `rotate` property; the panel's own chevron
 * turns with an inline `transform`. One style animates both. */
const CHEVRON_STYLE = {
  color: "var(--text-dim)",
  transition: "transform var(--dur-fast) var(--ease-out-warm), rotate var(--dur-fast) var(--ease-out-warm)",
} as const;

function TodoStatusIcon({ status, size = 14 }: { status: TodoItem["status"]; size?: number }) {
  const props = { size, strokeWidth: 1.8, "aria-hidden": true as const };
  if (status === "completed") return <CheckCircle2 {...props} color="var(--accent)" />;
  if (status === "in_progress") return <CircleDotDashed {...props} color="var(--accent)" />;
  if (status === "blocked") return <CircleAlert {...props} color="var(--text-muted)" />;
  if (status === "abandoned") return <Ban {...props} color="var(--text-dim)" />;
  return <Circle {...props} color="var(--text-dim)" />;
}

/** One task. `nested` is a finished task shown inside the fold that stands
 * for it. */
function TaskRow({ row, nested = false }: { row: PlanViewTask; nested?: boolean }) {
  const { t } = useI18n();
  const { task, label, subtasks } = row;
  const active = task.status === "in_progress";
  const line = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={task.status === "completed" || task.status === "abandoned" ? "text-text-dim line-through" : undefined}>
        {label ?? task.content}
      </span>
      {subtasks.length > 0 && (
        <span className="text-[10px] font-normal text-text-dim">
          {t("planKeeper.subtaskCount", { done: subtasks.filter((subtask) => subtask.status === "completed").length, total: subtasks.length })}
        </span>
      )}
      {/* Quiet on purpose: the keeper checking a task off is not an event. */}
      {row.autoCompleted && (
        <span title={t("planKeeper.autoMarked")} data-testid="todo-auto-mark" className="inline-flex shrink-0">
          <Wand2 size={11} strokeWidth={1.8} aria-hidden color="var(--text-dim)" />
        </span>
      )}
      {label && <ChevronDown size={11} strokeWidth={1.8} aria-hidden className="shrink-0 group-open/label:rotate-180" style={CHEVRON_STYLE} />}
    </span>
  );
  return (
    <div className="grid gap-1">
      <div
        // The task being worked on is the one line the eye should land on.
        className={`flex min-w-0 items-start gap-2 text-text ${nested ? "text-[12px]" : "text-[13px]"}${active ? " -ml-2.5 border-l-2 border-accent pl-2 font-medium" : ""}`}
        aria-label={`${t(`chatWindow.todoStatus.${task.status}`)}: ${task.content}`}
        aria-current={active ? "step" : undefined}
      >
        <span className="mt-0.5 shrink-0"><TodoStatusIcon status={task.status} size={nested ? 12 : 14} /></span>
        <div className="min-w-0">
          {label ? (
            // A short label stands in for a long task; the task's own words
            // are the tooltip and one tap away.
            <details className="group/label">
              <summary title={task.content} className={SUMMARY_CLASS}>{line}</summary>
              <span data-testid="todo-original" className="mt-0.5 block text-[11px] font-normal text-text-muted">{task.content}</span>
            </details>
          ) : line}
          {task.blocker && (
            <span className="mt-0.5 block text-[11px] font-normal text-text-muted">
              {t("chatWindow.todoBlocker", { blocker: task.blocker })}
            </span>
          )}
        </div>
      </div>
      {subtasks.length > 0 && (
        <div className="ml-1.5 grid min-w-0 gap-1 border-l border-border pl-3">
          {subtasks.map((subtask, subtaskIndex) => (
            <div
              key={`${task.content}-sub-${subtaskIndex}`}
              data-testid="todo-subtask"
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-dim"
              aria-label={`${t(`chatWindow.todoStatus.${subtask.status}`)}: ${subtask.content}`}
            >
              <span className="shrink-0"><TodoStatusIcon status={subtask.status} size={11} /></span>
              <span className={`min-w-0 truncate${subtask.status === "completed" ? " line-through" : ""}`}>
                {subtask.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A run of finished tasks as one finished line. The tasks themselves are
 * inside it, untouched. */
function FoldRow({ fold }: { fold: PlanViewFold }) {
  const { t } = useI18n();
  const count = fold.tasks.length;
  return (
    <details data-testid="todo-fold" className="group/fold">
      <summary className={`${SUMMARY_CLASS} flex min-w-0 items-start gap-2 text-[13px] text-text-dim`}>
        <span className="mt-0.5 shrink-0"><CheckCheck size={14} strokeWidth={1.8} aria-hidden color="var(--accent)" /></span>
        <span className="min-w-0">
          {fold.summary ?? t("planKeeper.foldGeneric", { count })}
          {fold.summary && <span className="ml-1.5 whitespace-nowrap text-[10px]">{t("planKeeper.foldCount", { count })}</span>}
        </span>
        <ChevronRight size={12} strokeWidth={1.8} aria-hidden className="ml-auto mt-1 shrink-0 group-open/fold:rotate-90" style={CHEVRON_STYLE} />
      </summary>
      <div className="ml-1.5 mt-1 grid min-w-0 gap-1 border-l border-border pl-3">
        {fold.tasks.map((row, index) => <TaskRow key={row.task.id ?? `${row.task.content}-${index}`} row={row} nested />)}
      </div>
    </details>
  );
}

interface TodoListProps {
  /** The list as it should be shown: the server has already applied the plan
   * keeper's check-offs (lib/plan-keeper/fold.ts applyPlanOverlay). */
  phases?: TodoPhase[];
  /** Plan-keeper overlay: subtasks, which tasks the keeper (rather than the
   * model) checked off, short labels and summaries of finished work.
   * Absent/null renders the bare plan — purely additive, never required. */
  overlay?: PlanOverlay | null;
  /** Render as a composer-attached panel: the header row becomes a
   * collapse/expand toggle and the section margin is dropped. */
  collapsible?: boolean;
  /** Initial expansion when `collapsible` (default: collapsed). */
  defaultExpanded?: boolean;
}

export function TodoList({ phases = [], overlay = null, collapsible = false, defaultExpanded = false }: TodoListProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(collapsible ? !defaultExpanded : false);
  const listRef = useRef<HTMLDivElement>(null);
  const inProgress = phases.flatMap((phase) => phase.tasks).find((task) => task.status === "in_progress")?.content ?? null;

  // Bring the task being worked on into the list's own scroll box when the
  // panel opens or the work moves on. Only that box moves, never the page.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !row) return;
    const box = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < box.top || rowBox.bottom > box.bottom) list.scrollTop += rowBox.top - box.top - box.height / 3;
  }, [collapsed, inProgress]);

  if (phases.length === 0) return null;

  const view = buildPlanView(phases, overlay);
  const headerRowClass = "flex items-center gap-2 px-3 py-2 text-xs text-text-muted";
  const headerBorderClass = collapsed ? "" : "border-b border-border";
  const progress = t("chatWindow.todoProgress", { done: view.done, total: view.total });

  return (
    <section
      aria-label={t("chatWindow.todoList")}
      className={`overflow-hidden border border-border bg-bg-subtle ${collapsible ? "" : "my-2"}`}
      // Composer variant fills its row so the stacked panels stay aligned in
      // every expansion state; the standalone variant keeps hugging content.
      style={{ borderRadius: "var(--radius-card)", width: collapsible ? "100%" : "fit-content", maxWidth: "100%" }}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
          className={`${headerRowClass} ${headerBorderClass} w-full cursor-pointer text-left`}
          style={{ background: "none" }}
        >
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          <span className="ml-auto">{progress}</span>
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            aria-hidden
            style={{ ...CHEVRON_STYLE, transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
          />
        </button>
      ) : (
        <div className={`${headerRowClass} ${headerBorderClass}`}>
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          <span className="ml-auto">{progress}</span>
        </div>
      )}
      {!collapsed && (
        <div ref={listRef} className="grid gap-1.5 px-3 py-2.5" style={{ maxHeight: "min(40vh, 320px)", overflowY: "auto" }}>
          {view.phases.map((phase, phaseIndex) => (
            // `open` follows the plan: a phase closes to one line when it
            // finishes and the current one opens. In between, a phase the
            // reader opened or closed by hand stays as they left it.
            <details key={phase.id ?? `${phase.name}-${phaseIndex}`} open={phase.open} data-testid="todo-phase" className="group/phase">
              <summary className={`${SUMMARY_CLASS} flex items-center gap-1.5 text-[11px] font-medium ${phase.current ? "text-text" : "text-text-muted"}`}>
                <ChevronRight size={12} strokeWidth={1.8} aria-hidden className="shrink-0 group-open/phase:rotate-90" style={CHEVRON_STYLE} />
                <span className="min-w-0 truncate">{phase.name}</span>
                {phase.finished && <CheckCircle2 size={12} strokeWidth={1.8} aria-hidden color="var(--accent)" className="shrink-0" />}
                <span className="ml-auto shrink-0 font-normal tabular-nums text-text-dim">{phase.done}/{phase.total}</span>
              </summary>
              <div className="grid gap-1.5 pb-1 pl-[18px] pt-1.5">
                {phase.rows.map((row, rowIndex) => (row.kind === "fold"
                  ? <FoldRow key={`fold-${row.key}`} fold={row} />
                  : <TaskRow key={row.task.id ?? `${row.task.content}-${rowIndex}`} row={row} />))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
