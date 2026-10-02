"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { TodoItemRow } from "./TodoItemRow";
import { TodoQuickAdd } from "./TodoQuickAdd";
import { useTodoDocument, type TodoItemChanges } from "./useTodoDocument";
import type { TodoItem } from "@/lib/project-todo-types";
import { toast } from "@/components/ui/toast";

export interface TodoPanelProps {
  cwd: string | null;
  onOpenTerminalTask?: (title: string) => void;
  active?: boolean;
  openCommandsRequest?: number;
}

export default function TodoPanel({
  cwd,
  onOpenTerminalTask,
  active = true,
  openCommandsRequest = 0,
}: TodoPanelProps) {
  const { t } = useI18n();
  const {
    doc,
    loading,
    error,
    busy,
    add,
    update,
    complete,
    reopen,
    remove,
    reorder,
    refresh,
  } = useTodoDocument(cwd ?? null, active);
  const [doneOpen, setDoneOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const dragStartYRef = useRef(0);
  const dragRowsRef = useRef<Map<string, HTMLElement>>(new Map());

  const coarsePointer = !window.matchMedia("(hover: hover)").matches;

  const activeItems = doc.items.filter((item) => item.status === "active");
  const doneItems = doc.items.filter((item) => item.status === "done");

  const handleDragStart = useCallback((id: string) => {
    setDraggedId(id);
    dragRowsRef.current.clear();
    const rows = document.querySelectorAll("[data-todo-row-id]");
    rows.forEach((row) => {
      const rowId = row.getAttribute("data-todo-row-id");
      if (rowId && row instanceof HTMLElement) {
        dragRowsRef.current.set(rowId, row);
      }
    });
  }, []);

  const handleDragMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!draggedId) return;
      const element = document.elementFromPoint(clientX, clientY);
      if (!element || !(element instanceof HTMLElement)) return;
      const row = element.closest("[data-todo-row-id]") as HTMLElement | null;
      if (!row) {
        setDropIndicator(null);
        return;
      }
      const targetId = row.getAttribute("data-todo-row-id");
      if (!targetId || targetId === draggedId) {
        setDropIndicator(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      const position = clientY < rect.top + rect.height / 2 ? "before" : "after";
      setDropIndicator({ id: targetId, position });
    },
    [draggedId],
  );

  const handleDragEnd = useCallback(() => {
    if (!draggedId || !dropIndicator) {
      setDraggedId(null);
      setDropIndicator(null);
      return;
    }
    const { id: targetId, position } = dropIndicator;
    const sourceIndex = activeItems.findIndex((item) => item.id === draggedId);
    const targetIndex = activeItems.findIndex((item) => item.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) {
      setDraggedId(null);
      setDropIndicator(null);
      return;
    }

    const newOrder = [...activeItems];
    const [dragged] = newOrder.splice(sourceIndex, 1);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    newOrder.splice(sourceIndex < insertIndex ? insertIndex - 1 : insertIndex, 0, dragged);
    void reorder(newOrder.map((item) => item.id));
    setDraggedId(null);
    setDropIndicator(null);
  }, [draggedId, dropIndicator, activeItems, reorder]);

  const handleReorderKeyboard = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = activeItems.findIndex((item) => item.id === id);
      if (index === -1) return;
      if (direction === -1 && index === 0) return;
      if (direction === 1 && index === activeItems.length - 1) return;
      const newOrder = [...activeItems];
      const [item] = newOrder.splice(index, 1);
      newOrder.splice(index + direction, 0, item);
      void reorder(newOrder.map((i) => i.id));
    },
    [activeItems, reorder],
  );

  const handleDelete = useCallback(
    (item: TodoItem) => {
      void remove(item.id);
      toast.success(t("todo.deleted", { title: item.title }), undefined, {
        action: {
          label: t("todo.undo"),
          onClick: () => {
            void add(item.title, item.notes ?? undefined, item.color ?? undefined);
          },
        },
      });
    },
    [remove, add, t],
  );

  const handleClearCompleted = useCallback(() => {
    const deleted = doneItems.slice();
    void Promise.all(doneItems.map((item) => remove(item.id)));
    toast.success(t("todo.clearedCompleted", { count: deleted.length }), undefined, {
      action: {
        label: t("todo.undo"),
        onClick: () => {
          void Promise.all(
            deleted.map((item) =>
              add(item.title, item.notes ?? undefined, item.color ?? undefined),
            ),
          );
        },
      },
    });
  }, [doneItems, remove, add, t]);

  if (!cwd) {
    return (
      <div
        style={{
          padding: "16px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: 12,
        }}
      >
        {t("todo.noWorkspace")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
          {t("todo.title")}
        </span>
        <button
          type="button"
          className="ui-focus-ring"
          style={{
            width: 28,
            height: 28,
            minWidth: 28,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: "var(--radius-control)",
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
            padding: 0,
            animation: loading ? "spin 1s linear infinite" : undefined,
          }}
          title={t("todo.refresh")}
          aria-label={t("todo.refresh")}
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div
          style={{
            padding: "8px 10px",
            marginBottom: "8px",
            background: "color-mix(in srgb, var(--status-error) 14%, var(--bg))",
            color: "var(--status-error)",
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}

      {/* Quick add input */}
      <div style={{ padding: "8px 10px 0" }}>
        <TodoQuickAdd onAdd={add} busy={busy} />
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 10px",
        }}
      >
        {loading && !doc.items.length ? (
          <div
            style={{
              padding: "16px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            {t("todo.loading")}
          </div>
        ) : activeItems.length === 0 && doneItems.length === 0 ? (
          <div
            style={{
              padding: "16px",
              textAlign: "center",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            <div style={{ marginBottom: 4, fontWeight: 600 }}>
              {t("todo.emptyTitle")}
            </div>
            <div>{t("todo.emptyDescription")}</div>
          </div>
        ) : (
          <>
            {/* Active items */}
            {activeItems.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-card)",
                  background: "var(--bg-panel)",
                  overflow: "hidden",
                  marginBottom: "12px",
                }}
              >
                {activeItems.map((item) => (
                  <TodoItemRow
                    key={item.id}
                    item={item}
                    done={false}
                    dragActive={draggedId === item.id}
                    dropIndicator={
                      dropIndicator?.id === item.id ? dropIndicator.position : null
                    }
                    coarsePointer={coarsePointer}
                    onComplete={complete}
                    onReopen={reopen}
                    onUpdate={update}
                    onDelete={handleDelete}
                    onReorderKeyboard={handleReorderKeyboard}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDragEnd={handleDragEnd}
                  />
                ))}
              </div>
            )}

            {/* Done section */}
            {doneItems.length > 0 && (
              <div style={{ marginTop: "12px" }}>
                <button
                  type="button"
                  className="ui-focus-ring"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "6px 8px",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    background: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 500,
                    textAlign: "left",
                  }}
                  onClick={() => setDoneOpen(!doneOpen)}
                >
                  {doneOpen ? (
                    <ChevronDown size={14} aria-hidden="true" />
                  ) : (
                    <ChevronUp size={14} aria-hidden="true" />
                  )}
                  {t("todo.doneCount", { count: doneItems.length })}
                </button>

                {doneOpen && (
                  <div
                    style={{
                      marginTop: "8px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-card)",
                      background: "var(--bg-panel)",
                      overflow: "hidden",
                    }}
                  >
                    {doneItems.map((item) => (
                      <TodoItemRow
                        key={item.id}
                        item={item}
                        done={true}
                        dragActive={false}
                        dropIndicator={null}
                        coarsePointer={coarsePointer}
                        onComplete={complete}
                        onReopen={reopen}
                        onUpdate={update}
                        onDelete={handleDelete}
                        onReorderKeyboard={handleReorderKeyboard}
                        onDragStart={handleDragStart}
                        onDragMove={handleDragMove}
                        onDragEnd={handleDragEnd}
                      />
                    ))}
                    <div style={{ padding: "8px" }}>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "6px 8px",
                          border: "none",
                          borderRadius: "var(--radius-control)",
                          background: "transparent",
                          color: "var(--status-error)",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 500,
                          textAlign: "center",
                        }}
                        onClick={handleClearCompleted}
                      >
                        {t("todo.clearCompleted")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
