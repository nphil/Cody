"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Play, RotateCw, Terminal, TriangleAlert } from "lucide-react";
import { translate, translatePlural, useI18n } from "@/lib/i18n";
import { TASKS_CONFIG_RELATIVE_PATH, groupTasks, type WorkspaceTask } from "@/lib/workspace-tasks";

export interface TasksPanelProps {
  cwd: string | null;
  active: boolean;
  /** Switch the shell to the Terminal tab, focusing `terminalId` when given. */
  onOpenTerminal: (terminalId?: string) => void;
  /** Lets the tab strip render a "!" badge while the config is broken. */
  onConfigStateChange?: (state: "missing" | "invalid" | "loaded" | null) => void;
}

interface TasksResponse {
  state?: "missing" | "invalid" | "loaded";
  tasks?: WorkspaceTask[];
  error?: string;
}

interface RunResponse {
  terminalId?: string;
  error?: string;
  code?: string;
}

type PanelStatus = "none" | "loading" | "missing" | "invalid" | "loaded";
type Note = { kind: "info" | "success" | "error"; text: string };

const CONFIG_EXAMPLE = `{
  "version": 1,
  "tasks": [
    {
      "id": "dev",
      "title": "Dev server",
      "command": "npm run dev",
      "group": "Develop"
    }
  ]
}`;

function toolbarButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    height: 22,
    padding: "0 7px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    opacity: disabled ? 0.6 : 1,
    transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
  };
}

function hoverIn(event: React.MouseEvent<HTMLButtonElement>) {
  if (event.currentTarget.disabled) return;
  event.currentTarget.style.background = "var(--bg-selected)";
}

function hoverOut(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = "var(--bg-panel)";
}

export function TasksPanel({ cwd, active, onOpenTerminal, onConfigStateChange }: TasksPanelProps): React.ReactElement | null {
  const { t, tn } = useI18n();
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);

  // A monotonic request id plus an AbortController keeps a slow response for an
  // old cwd from overwriting the state of the workspace now on screen.
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Held in a ref so a parent that re-creates the callback on every render
  // cannot restart the fetch effect.
  const reportRef = useRef(onConfigStateChange);
  reportRef.current = onConfigStateChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const load = useCallback(async (announce = false) => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();

    if (!cwd) {
      abortRef.current = null;
      setStatus("none");
      setTasks([]);
      setConfigError(null);
      setNote(null);
      reportRef.current?.(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    if (announce) setNote(null);

    try {
      const response = await fetch(`/api/tasks?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
      const data = await response.json().catch(() => ({})) as TasksResponse;
      if (requestId !== requestRef.current || !mountedRef.current) return;

      if (!response.ok || data.state === "invalid") {
        setTasks([]);
        setConfigError(data.error ?? translate("tasks.loadError"));
        setStatus("invalid");
        reportRef.current?.("invalid");
        return;
      }
      if (data.state === "missing") {
        setTasks([]);
        setConfigError(null);
        setStatus("missing");
        reportRef.current?.("missing");
        return;
      }

      const loaded = data.tasks ?? [];
      setTasks(loaded);
      setConfigError(null);
      setStatus("loaded");
      reportRef.current?.("loaded");
      if (announce) {
        setNote({ kind: "success", text: translatePlural("tasks.loadedCount", loaded.length) });
      }
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestRef.current || !mountedRef.current) return;
      setTasks([]);
      setConfigError(error instanceof Error ? error.message : translate("tasks.loadError"));
      setStatus("invalid");
      reportRef.current?.("invalid");
    }
  }, [cwd]);

  // Runs on first mount and whenever the workspace changes.
  useEffect(() => {
    void load();
  }, [load]);

  const runTask = useCallback(async (task: WorkspaceTask) => {
    if (!cwd || dispatchingId !== null) return;
    if (task.confirm && !window.confirm(translate("tasks.runConfirm", { title: task.title, command: task.command }))) {
      setNote({ kind: "info", text: translate("tasks.cancelled", { title: task.title }) });
      return;
    }

    setDispatchingId(task.id);
    setNote({ kind: "info", text: translate("tasks.starting", { title: task.title }) });

    try {
      const response = await fetch("/api/tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, taskId: task.id }),
      });
      const data = await response.json().catch(() => ({})) as RunResponse;
      if (!mountedRef.current) return;

      if (!response.ok) {
        if (data.code === "task_not_found") {
          setNote({ kind: "error", text: translate("tasks.taskGone") });
          void load();
          return;
        }
        setNote({ kind: "error", text: data.error ?? translate("tasks.runError") });
        return;
      }

      setNote({ kind: "success", text: translate("tasks.started", { title: task.title }) });
      onOpenTerminal(data.terminalId);
    } catch (error) {
      if (!mountedRef.current) return;
      setNote({ kind: "error", text: error instanceof Error ? error.message : translate("tasks.runError") });
    } finally {
      if (mountedRef.current) setDispatchingId(null);
    }
  }, [cwd, dispatchingId, load, onOpenTerminal]);

  if (!active) return null;

  const busy = dispatchingId !== null;
  const groups = groupTasks(tasks);

  return (
    <section
      aria-label={t("tasks.title")}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
    >
      <div
        className="workspace-subtitle-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("tasks.title")}
        </span>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => void load(true)}
          disabled={status === "loading"}
          title={t("tasks.refresh")}
          aria-label={t("tasks.refresh")}
          style={toolbarButtonStyle(status === "loading")}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          <RotateCw size={11} strokeWidth={2.2} aria-hidden="true" />
          {t("tasks.refresh")}
        </button>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => onOpenTerminal()}
          title={t("tasks.openTerminal")}
          aria-label={t("tasks.openTerminal")}
          style={toolbarButtonStyle(false)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          <Terminal size={11} strokeWidth={2.2} aria-hidden="true" />
          {t("tasks.openTerminal")}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
        {note && (
          <div
            role={note.kind === "error" ? "alert" : "status"}
            aria-live={note.kind === "error" ? undefined : "polite"}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              marginBottom: 10,
              padding: "6px 8px",
              border: "1px solid var(--border)",
              borderColor: note.kind === "error" ? "color-mix(in srgb, var(--status-error) 55%, var(--border))" : "var(--border)",
              borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              fontSize: 11,
              lineHeight: 1.4,
              color: note.kind === "error" ? "var(--status-error)" : note.kind === "success" ? "var(--status-success)" : "var(--text-muted)",
              overflowWrap: "anywhere",
            }}
          >
            {note.kind === "error"
              ? <TriangleAlert size={12} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
              : note.kind === "success"
                ? <Check size={12} strokeWidth={2.4} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                : <Loader2 size={12} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1, animation: "spin 0.8s linear infinite" }} aria-hidden="true" />}
            <span style={{ minWidth: 0 }}>{note.text}</span>
          </div>
        )}

        {status === "none" && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("tasks.noWorkspace")}</div>
        )}

        {status === "loading" && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("tasks.loading", { path: TASKS_CONFIG_RELATIVE_PATH })}</div>
        )}

        {status === "missing" && (
          <div
            style={{
              padding: 12,
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-card)",
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("tasks.missingTitle")}</div>
            <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)" }}>
              {t("tasks.missingHint", { path: TASKS_CONFIG_RELATIVE_PATH })}
            </div>
            <code
              style={{
                display: "block",
                marginTop: 8,
                padding: "6px 8px",
                borderRadius: "var(--radius-control)",
                background: "var(--bg-subtle)",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: "pre",
                overflowX: "auto",
              }}
            >
              {CONFIG_EXAMPLE}
            </code>
          </div>
        )}

        {status === "invalid" && (
          <div
            role="alert"
            style={{
              padding: 10,
              border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))",
              borderRadius: "var(--radius-card)",
              background: "color-mix(in srgb, var(--status-error) 9%, var(--bg-panel))",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--status-error)" }}>
              <TriangleAlert size={13} strokeWidth={2.2} aria-hidden="true" />
              {t("tasks.invalidTitle")}
            </div>
            {configError && (
              <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: "var(--text)", overflowWrap: "anywhere" }}>{configError}</div>
            )}
            <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>
              {t("tasks.invalidHint", { path: TASKS_CONFIG_RELATIVE_PATH })}
            </div>
          </div>
        )}

        {status === "loaded" && tasks.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("tasks.empty", { path: TASKS_CONFIG_RELATIVE_PATH })}</div>
        )}

        {status === "loaded" && tasks.length > 0 && (
          <>
            <div style={{ marginBottom: 10, fontSize: 11, lineHeight: 1.45, color: "var(--text-dim)" }}>{t("tasks.hint")}</div>
            {groups.map((group, index) => (
              <div key={group.group ?? "\u0000ungrouped"} style={{ marginTop: index === 0 ? 0 : 12 }}>
                {group.group !== undefined && (
                  <div
                    style={{
                      marginBottom: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--text-dim)",
                    }}
                  >
                    {group.group}
                  </div>
                )}
                {group.tasks.map((task) => {
                  const running = dispatchingId === task.id;
                  return (
                    <div
                      key={task.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        marginBottom: 8,
                        padding: 10,
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-card)",
                        background: "var(--bg-panel)",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{task.title}</div>
                        {task.description && (
                          <div style={{ marginTop: 2, fontSize: 12, lineHeight: 1.4, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                            {task.description}
                          </div>
                        )}
                        <code
                          title={task.command}
                          style={{
                            display: "block",
                            marginTop: 6,
                            padding: "3px 6px",
                            borderRadius: "var(--radius-control)",
                            background: "var(--bg-subtle)",
                            color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 11,
                            whiteSpace: "nowrap",
                            overflowX: "auto",
                          }}
                        >
                          {task.command}
                        </code>
                      </div>
                      <button
                        type="button"
                        className="ui-focus-ring"
                        onClick={() => void runTask(task)}
                        disabled={busy}
                        title={t("tasks.runLabel", { title: task.title })}
                        aria-label={t("tasks.runLabel", { title: task.title })}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexShrink: 0,
                          height: 24,
                          padding: "0 9px",
                          border: "1px solid var(--accent)",
                          borderRadius: "var(--radius-control)",
                          background: "transparent",
                          color: "var(--accent)",
                          cursor: busy ? "default" : "pointer",
                          fontSize: 11,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          opacity: busy ? 0.6 : 1,
                          transition: "background var(--dur-fast) var(--ease-out-warm)",
                        }}
                        onMouseEnter={(event) => {
                          if (!event.currentTarget.disabled) event.currentTarget.style.background = "color-mix(in srgb, var(--accent) 12%, transparent)";
                        }}
                        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                      >
                        {running ? (
                          <>
                            <Loader2 size={11} strokeWidth={2.2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                            {t("tasks.dispatching")}
                          </>
                        ) : (
                          <>
                            <Play size={11} strokeWidth={2.2} aria-hidden="true" />
                            {t("tasks.run")}
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {tn("tasks.taskCount", tasks.length, { count: tasks.length })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
