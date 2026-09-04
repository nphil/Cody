"use client";

/**
 * Per-panel save feedback for instant writes: a toggle or select flips, the
 * corner shows a spinner, then a check for 1.5 s, then nothing. A failure
 * stays as a red "Could not save" with a Retry until the next attempt. One
 * `aria-live="polite"` region per panel announces the same thing to a
 * screen reader. The header-wide "Auto-saved" chip this replaces said
 * nothing about WHICH change had landed.
 */
import { AlertCircle, Check, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface SaveStatus {
  state: SaveState;
  message?: string;
  retry?: () => void;
}

export const SAVED_LINGER_MS = 1500;

const IDLE: SaveStatus = { state: "idle" };

const statuses = new Map<string, SaveStatus>();
const pending = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function set(panelId: string, status: SaveStatus): void {
  statuses.set(panelId, status);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSaveStatus(panelId: string): SaveStatus {
  return statuses.get(panelId) ?? IDLE;
}

/** Tests only. */
export function resetSaveStatus(): void {
  statuses.clear();
  pending.clear();
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
  notify();
}

/**
 * Report a write's progress. "saving" increments an in-flight count and
 * "saved" decrements it, so overlapping writes stay a spinner until the last
 * one lands; "error" wins over everything until the next "saving".
 */
export function reportSaveStatus(panelId: string, state: SaveState, message?: string, opts?: { retry?: () => void }): void {
  const timer = timers.get(panelId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(panelId);
  }
  if (state === "saving") {
    pending.set(panelId, (pending.get(panelId) ?? 0) + 1);
    set(panelId, { state: "saving", message });
    return;
  }
  if (state === "error") {
    pending.set(panelId, 0);
    set(panelId, { state: "error", message: message ?? "Could not save", retry: opts?.retry });
    return;
  }
  if (state === "saved") {
    const remaining = Math.max(0, (pending.get(panelId) ?? 1) - 1);
    pending.set(panelId, remaining);
    if (remaining > 0) return;
    set(panelId, { state: "saved", message });
    timers.set(panelId, setTimeout(() => {
      timers.delete(panelId);
      if (readSaveStatus(panelId).state === "saved") set(panelId, IDLE);
    }, SAVED_LINGER_MS));
    return;
  }
  pending.set(panelId, 0);
  set(panelId, IDLE);
}

/**
 * Wrap a write so the corner follows it: spinner while the promise is
 * pending, check when it resolves, red with Retry (re-running `run`) when it
 * rejects. Returns the promise's outcome; the rejection is swallowed after
 * reporting because the corner IS the error surface.
 */
export function trackSave(panelId: string, run: () => Promise<unknown>): Promise<boolean> {
  reportSaveStatus(panelId, "saving");
  return run().then(
    () => {
      reportSaveStatus(panelId, "saved");
      return true;
    },
    (error: unknown) => {
      reportSaveStatus(panelId, "error", error instanceof Error ? error.message : String(error), { retry: () => { void trackSave(panelId, run); } });
      return false;
    },
  );
}

export function useSaveStatus(panelId: string): { status: SaveStatus; report: (state: SaveState, message?: string, opts?: { retry?: () => void }) => void; track: (run: () => Promise<unknown>) => Promise<boolean> } {
  // The module store is empty on the server and on the first client paint,
  // so reading it for both snapshots cannot mismatch on hydration.
  const status = useSyncExternalStore(subscribe, () => readSaveStatus(panelId), () => readSaveStatus(panelId));
  const report = useCallback((state: SaveState, message?: string, opts?: { retry?: () => void }) => reportSaveStatus(panelId, state, message, opts), [panelId]);
  const track = useCallback((run: () => Promise<unknown>) => trackSave(panelId, run), [panelId]);
  return useMemo(() => ({ status, report, track }), [status, report, track]);
}

/** The corner itself. Sticky at the top-right of a scrolling panel; render
 * it once per panel, before the panel's cards. */
export function SaveStatusCorner({ panelId }: { panelId: string }) {
  const { status } = useSaveStatus(panelId);
  const visible = status.state !== "idle";
  const tone = status.state === "error" ? "var(--status-error)" : status.state === "saved" ? "var(--status-success)" : "var(--text-muted)";
  return (
    <div
      aria-live="polite"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        height: 0,
        display: "flex",
        justifyContent: "flex-end",
        pointerEvents: "none",
        overflow: "visible",
        marginBottom: visible ? 0 : -16,
      }}
    >
      {visible && (
        <span
          role={status.state === "error" ? "alert" : "status"}
          style={{
            pointerEvents: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: tone,
            background: "var(--bg-panel)",
            border: `1px solid ${status.state === "error" ? "var(--status-error)" : "var(--border)"}`,
            borderRadius: 10,
            padding: "3px 9px",
            marginTop: 6,
            boxShadow: "var(--shadow-card)",
            animation: "ui-fade-in var(--dur-fast) var(--ease-out-warm) both",
          }}
        >
          {status.state === "saving" && <><RefreshCw size={11} className="icon-spin" aria-hidden="true" /> Saving…</>}
          {status.state === "saved" && <><Check size={11} aria-hidden="true" /> Saved</>}
          {status.state === "error" && (
            <>
              <AlertCircle size={11} aria-hidden="true" /> Could not save{status.message ? ` — ${status.message}` : ""}
              {status.retry && (
                <button
                  type="button"
                  onClick={status.retry}
                  className="ui-focus-ring"
                  style={{ border: "none", background: "transparent", color: "var(--status-error)", fontWeight: 600, fontSize: 11, cursor: "pointer", padding: "0 2px", textDecoration: "underline" }}
                >
                  Retry
                </button>
              )}
            </>
          )}
        </span>
      )}
    </div>
  );
}
