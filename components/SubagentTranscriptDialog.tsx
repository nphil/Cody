"use client";

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Ban, ChevronRight, Info, Loader2, Send } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { sendAgentCommand } from "@/lib/agent-client";
import { useI18n } from "@/lib/i18n";
import { formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { thinkingLevelLabel } from "@/lib/thinking-level-labels";
import { MarkdownBody } from "./MarkdownBody";
import { BLOCK_LABEL_STYLE, SubagentTranscript, TEXT_BUTTON_STYLE } from "./SubagentTranscript";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { toast } from "./ui/toast";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import { isUnsupportedCommandError, parseSubagentProgress } from "@/lib/subagent-types";
import type { SubagentActivityEvent, SubagentProgress, SubagentSnapshotLike } from "@/lib/subagent-types";

/** Recursive renderer for structured completions: string values keep their
 * line breaks (JSON.parse already unescapes them), arrays become bullet
 * lists, nested objects become aligned key/value rows. */
function JsonValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
        {value}
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {value.map((item, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>•</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <JsonValue value={item} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {Object.keys(record).map((key) => (
          <div key={key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", minWidth: 110, textAlign: "right", paddingTop: 2 }}>{key}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <JsonValue value={record[key]} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{String(value)}</span>;
}

/** The first line of the assignment with its markdown heading marks removed:
 *  what the collapsed Task header shows. */
function taskPreview(task: string): string {
  const line = task.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.replace(/^\s*#{1,6}\s*/, "").trim();
}

/** The subagent's assignment, rendered as markdown. Collapsed by default: the
 *  reader came for the result and the transcript, and the assignment is also
 *  the first row of the transcript. The markdown is only parsed once opened.
 *  Exported for SSR tests. Memoized: the task string never changes while live
 *  frames stream in. */
export const TaskBlock = memo(function TaskBlock({ task, defaultOpen = false }: { task: string; defaultOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  if (!task) return null;
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)" }}>
      <button
        type="button"
        aria-expanded={open}
        className="ui-focus-ring"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minWidth: 0,
          padding: "8px 12px",
          background: "none",
          border: "none",
          borderRadius: "var(--radius-control)",
          color: "inherit",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
        />
        <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.taskLabel")}</span>
        {!open && (
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text-muted)" }}>
            {taskPreview(task)}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: "0 12px 10px" }}>
          <MarkdownBody className="markdown-subagent-text">{task}</MarkdownBody>
        </div>
      )}
    </section>
  );
});

/** A result longer than this many characters or lines is folded to a few lines. */
const RESULT_FOLD_CHARS = 700;
const RESULT_FOLD_LINES = 9;
const RESULT_FOLDED_STYLE: CSSProperties = {
  maxHeight: 156,
  overflow: "hidden",
  WebkitMaskImage: "linear-gradient(to bottom, #000 72%, transparent)",
  maskImage: "linear-gradient(to bottom, #000 72%, transparent)",
};

/** The subagent's final output (`<id>.md`), shown above the transcript once it
 *  exists. A long one is folded to a few lines with a Show more toggle.
 *  Exported for SSR tests. Memoized: the completion only changes when the
 *  settled output actually lands. */
export const CompletionBlock = memo(function CompletionBlock({ completion, truncated }: { completion: string | null; truncated: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!completion) return null;
  let parsed: Record<string, unknown> | null = null;
  // A completion that is one JSON string ("…") is plain prose the engine
  // wrapped in quotes; show the prose, not the quotes.
  let jsonText: string | null = null;
  try {
    const candidate = JSON.parse(completion) as unknown;
    if (typeof candidate === "string") {
      jsonText = candidate;
    } else if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  const keys = parsed ? Object.keys(parsed) : [];
  const singleText = jsonText ?? (parsed && keys.length === 1 && typeof parsed[keys[0]] === "string" ? parsed[keys[0]] as string : null);
  const shown = singleText ?? completion;
  const foldable = shown.length > RESULT_FOLD_CHARS || shown.split("\n").length > RESULT_FOLD_LINES;
  const folded = foldable && !expanded;
  return (
    <section data-testid="subagent-result" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.resultLabel")}</span>
        {truncated && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("subagentTranscript.completionTruncated")}</span>}
        {foldable && (
          <button type="button" aria-expanded={expanded} className="ui-focus-ring" onClick={() => setExpanded((value) => !value)} style={{ ...TEXT_BUTTON_STYLE, marginLeft: "auto" }}>
            {expanded ? t("subagentTranscript.showLess") : t("subagentTranscript.showMore")}
          </button>
        )}
      </div>
      <div style={{ marginTop: 6, ...(folded ? RESULT_FOLDED_STYLE : null) }}>
        {singleText ? (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
            {singleText}
          </div>
        ) : parsed ? (
          <JsonValue value={parsed} />
        ) : (
          <MarkdownBody className="markdown-subagent-text">{completion}</MarkdownBody>
        )}
      </div>
    </section>
  );
});

/** Newest-wins throttle: the returned value follows `value` at most once per
 *  `ms`, with a trailing edge, so a continuous stream still flushes every
 *  window instead of being re-armed forever the way a restart-debounce would. */
function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  latestRef.current = value;
  const lastFiredRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (value === throttled || timerRef.current !== null) return;
    const wait = Math.max(0, ms - (Date.now() - lastFiredRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastFiredRef.current = Date.now();
      setThrottled(latestRef.current);
    }, wait);
  }, [value, throttled, ms]);
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);
  return throttled;
}

/** Token-colored live-activity mark for the current action line: the house
 * Loader2 spin normally, a static dot under prefers-reduced-motion (a pulse
 * is still motion). Inherits currentColor so it matches its row; the action
 * line text itself carries the information, so this stays decorative. */
function ActivityIndicator({ reducedMotion }: { reducedMotion: boolean }) {
  if (reducedMotion) {
    return (
      <span
        aria-hidden="true"
        style={{ flexShrink: 0, alignSelf: "center", width: 5, height: 5, borderRadius: "50%", background: "currentColor" }}
      />
    );
  }
  return (
    <Loader2
      size={12}
      strokeWidth={2.2}
      aria-hidden="true"
      style={{ flexShrink: 0, alignSelf: "center", animation: "spin 0.8s linear infinite" }}
    />
  );
}

/** The child's model, role and reasoning as ONE line under the title, with
 *  the "why can't I change this" note behind a toggle. It sits in the fixed
 *  header, so every pixel it takes is taken from the transcript — a boxed
 *  three-row table cost a third of a phone screen. */
export const ModelAndReasoningBlock = memo(function ModelAndReasoningBlock({ progress }: { progress?: SubagentProgress }) {
  const { t } = useI18n();
  const [noteOpen, setNoteOpen] = useState(false);
  const none = t("subagentTranscript.none");
  const model = progress?.resolvedModel ?? none;
  const role = progress?.modelRole ?? none;
  const thinkingLevel = progress?.thinkingLevel ? thinkingLevelLabel(progress.thinkingLevel, t) : none;
  const summary = `${t("subagentTranscript.model")}: ${model} · ${t("subagentTranscript.role")}: ${role} · ${t("subagentTranscript.reasoning")}: ${thinkingLevel}`;

  return (
    <section aria-label={t("subagentTranscript.modelReasoning")} style={{ marginTop: 4, minWidth: 0 }}>
      <button
        type="button"
        aria-expanded={noteOpen}
        title={summary}
        onClick={() => setNoteOpen((open) => !open)}
        className="ui-focus-ring"
        style={{
          display: "flex", alignItems: "center", gap: 6, maxWidth: "100%", minWidth: 0,
          padding: 0, background: "none", border: "none", cursor: "pointer",
          fontSize: 11, color: "var(--text-dim)", textAlign: "left",
        }}
      >
        <span style={{ display: "flex", gap: 6, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{model}</span>
          {progress?.resolvedModelIsFallback && <span style={{ color: "var(--status-warning)", flexShrink: 0 }}>({t("subagentTranscript.fallback")})</span>}
          <span aria-hidden="true" style={{ flexShrink: 0 }}>·</span>
          <span style={{ fontFamily: "var(--font-mono)", flexShrink: 0 }}>{role}</span>
          <span aria-hidden="true" style={{ flexShrink: 0 }}>·</span>
          <span style={{ flexShrink: 0 }}>{thinkingLevel}</span>
        </span>
        <Info size={11} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
      </button>
      {noteOpen && (
        <p style={{ margin: "4px 0 0", fontSize: 10.5, lineHeight: 1.4, color: "var(--text-dim)" }}>
          {t("subagentTranscript.modelReasoningExplanation")}
        </p>
      )}
    </section>
  );
});

/** Localized status text for structured child lifecycle events. */
export function subagentActivityLabel(event: SubagentActivityEvent, t: (key: string, vars?: Record<string, string>) => string): string {
  if (event.kind === "model_changed" && event.to) {
    return t("subagentTranscript.activityModelChanged", { model: event.to });
  }
  if (event.kind === "thinking_level_changed" && event.thinkingLevel) {
    return t("subagentTranscript.activityThinkingChanged", { level: thinkingLevelLabel(event.thinkingLevel, t) });
  }
  if (event.kind === "retry_fallback_applied" && event.from && event.to) {
    return t("subagentTranscript.activityFallback", { from: event.from, to: event.to });
  }
  return event.label;
}

/** Second click within this window confirms the cancel; otherwise it disarms. */
const CANCEL_CONFIRM_WINDOW_MS = 4000;
const CANCEL_SUMMARY_MAX = 160;

/** The steer that asks the parent model to stop a subtask. OMP 18.3 uses the
 * process resource; the older command is mentioned only as a compatibility
 * fallback. Exported for tests. */
export function cancelSubtaskSteerText(subagent: Pick<SubagentInfo, "id" | "agent" | "task" | "description" | "assignment">): string {
  const raw = (subagent.task ?? subagent.assignment ?? subagent.description ?? "").replace(/\s+/g, " ").trim();
  const summary = raw.length > CANCEL_SUMMARY_MAX ? raw.slice(0, CANCEL_SUMMARY_MAX - 1).trimEnd() + "…" : raw;
  const idJson = JSON.stringify(subagent.id);
  const idPath = encodeURIComponent(subagent.id);
  return "The user cancelled subtask " + idJson + " (" + subagent.agent + ": " + summary + "). "
    + "Cancel it with write proc://" + idPath + "/kill (OMP 18.3+; if this older engine does not support proc://, use hub cancel (ids: [" + idJson + "])). "
    + "Continue without its result; do not wait for or use anything it produces.";
}

/** Per-subagent controls that older omp (18.3) does not answer. Once the
 * engine says "Unknown command" the answer cannot change until it is
 * updated, so the verdict lives for the page session: every dialog and
 * button reads the same store instead of re-asking on each click. */
type SubagentControl = "cancel" | "steer";
const unsupportedControls: Record<SubagentControl, boolean> = { cancel: false, steer: false };
const unsupportedListeners = new Set<() => void>();

function markControlUnsupported(control: SubagentControl): boolean {
  if (unsupportedControls[control]) return false;
  unsupportedControls[control] = true;
  for (const listener of unsupportedListeners) listener();
  return true;
}

function useControlUnsupported(control: SubagentControl): boolean {
  return useSyncExternalStore(
    (listener) => { unsupportedListeners.add(listener); return () => { unsupportedListeners.delete(listener); }; },
    () => unsupportedControls[control],
    () => false,
  );
}

/** Test-only: forget what the engine said it could not do. */
export function resetSubagentControlSupport(): void {
  unsupportedControls.cancel = false;
  unsupportedControls.steer = false;
}

export type SubtaskCancelOutcome = "cancelled" | "already_finished" | "parent_steered";

/** One cancel attempt. omp 18.4+ kills the child itself (`cancel_subagent`);
 * an engine that answers "Unknown command" (18.3) is remembered via
 * `onCancelUnsupported` and the request falls back to steering the parent,
 * which is the only lever that engine has. Any other failure propagates.
 * Exported for tests. */
export async function runSubtaskCancel({ subagent, cancelSubagent, steer, onCancelUnsupported }: {
  subagent: Pick<SubagentInfo, "id" | "agent" | "task" | "description" | "assignment">;
  cancelSubagent?: (subagentId: string) => Promise<{ cancelled?: boolean } | undefined>;
  steer?: (message: string) => Promise<void>;
  onCancelUnsupported: () => void;
}): Promise<SubtaskCancelOutcome> {
  let unsupported: unknown;
  if (cancelSubagent) {
    try {
      const result = await cancelSubagent(subagent.id);
      return result?.cancelled === true ? "cancelled" : "already_finished";
    } catch (error) {
      if (!isUnsupportedCommandError(error)) throw error;
      unsupported = error;
      onCancelUnsupported();
    }
  }
  if (!steer) throw unsupported ?? new Error("Cannot cancel this subtask");
  await steer(cancelSubtaskSteerText(subagent));
  return "parent_steered";
}

/** Header icon button that cancels a running subtask. Renders nothing unless
 * the child is still live AND either the engine can cancel one subagent or
 * the parent can be steered to do it; a first click arms it, a second within
 * four seconds sends. On omp 18.4+ the child really stops; on an older engine
 * the button only asks the parent, and says so. Mirrors the DialogContent
 * close button's geometry so the pair reads as one row.
 * Exported for SSR tests. */
export function CancelSubtaskButton({ subagent, status, canSteer, requested, onRequested, onSteer, onCancelSubagent }: {
  subagent: Pick<SubagentInfo, "id" | "agent" | "task" | "description" | "assignment">;
  status: string | undefined;
  canSteer: boolean;
  requested: boolean;
  onRequested: (subagentId: string) => void;
  onSteer?: (message: string) => Promise<void>;
  /** Per-subagent kill (omp 18.4+). Absent when there is no session to ask. */
  onCancelSubagent?: (subagentId: string) => Promise<{ cancelled?: boolean } | undefined>;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const disarmTimerRef = useRef<number | undefined>(undefined);
  const cancelUnsupported = useControlUnsupported("cancel");

  // A new subagent in the same mounted button must not inherit an armed
  // state; the cleanup also covers unmount.
  useEffect(() => {
    setArmed(false);
    return () => clearTimeout(disarmTimerRef.current);
  }, [subagent.id]);

  const live = status === "started" || status === "pending" || status === "running";
  const nativeCancel = onCancelSubagent !== undefined && !cancelUnsupported;
  const parentSteer = canSteer && onSteer !== undefined;
  if (!live || (!nativeCancel && !parentSteer)) return null;

  const handleClick = async () => {
    if (requested || sending) return;
    if (!armed) {
      setArmed(true);
      disarmTimerRef.current = window.setTimeout(() => setArmed(false), CANCEL_CONFIRM_WINDOW_MS);
      return;
    }
    clearTimeout(disarmTimerRef.current);
    setArmed(false);
    setSending(true);
    try {
      const outcome = await runSubtaskCancel({
        subagent,
        cancelSubagent: nativeCancel ? onCancelSubagent : undefined,
        steer: parentSteer ? onSteer : undefined,
        onCancelUnsupported: () => { markControlUnsupported("cancel"); },
      });
      onRequested(subagent.id);
      if (outcome === "cancelled") toast.success(t("subagentTranscript.cancelledToast"));
      else if (outcome === "already_finished") toast.info(t("subagentTranscript.cancelAlreadyFinished"));
      else toast.info(t("subagentTranscript.cancelRequestedToast"));
    } catch (error) {
      // A rejected cancel (dropped session, engine refusal) is the whole
      // story: the button stays available so the user can retry.
      toast.error(t("subagentTranscript.cancelFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const label = requested
    ? t("subagentTranscript.cancelRequested")
    : armed ? t("subagentTranscript.cancelConfirm") : t("subagentTranscript.cancel");
  const color = requested ? "var(--text-dim)" : "var(--status-error)";
  const idleBackground = armed ? "color-mix(in srgb, var(--status-error) 14%, transparent)" : "transparent";
  return (
    <button
      type="button"
      onClick={() => { void handleClick(); }}
      disabled={requested || sending}
      aria-label={label}
      title={label}
      aria-pressed={armed || undefined}
      data-cancel-subtask={requested ? "requested" : armed ? "armed" : "idle"}
      className="ui-focus-ring"
      style={{
        position: "absolute", top: 8, right: 44, zIndex: 1,
        width: 32, height: 32, minWidth: 32, minHeight: 32,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: idleBackground,
        border: "none",
        borderRadius: "var(--radius-control)",
        color,
        cursor: requested ? "default" : sending ? "wait" : "pointer",
        touchAction: "manipulation",
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => { if (!requested) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = idleBackground; }}
    >
      {sending ? <Loader2 size={16} aria-hidden="true" className="icon-spin" /> : <Ban size={16} aria-hidden="true" />}
    </button>
  );
}

/** Footer input that messages ONE running subagent (`steer_subagent`, omp
 * 18.4+), unlike the composer which steers the parent. Hidden for the rest of
 * the page session once the engine answers "Unknown command", after telling
 * the user once why. Disabled while a send is in flight (omp holds the reply
 * until the child accepts the message); cleared only on success so a refused
 * message is not lost. Exported for SSR tests. */
export function SteerSubagentBox({ subagentId, onSend }: {
  subagentId: string;
  onSend: (subagentId: string, message: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const unsupported = useControlUnsupported("steer");

  // A different child must not inherit a half-typed message for another.
  useEffect(() => { setText(""); }, [subagentId]);

  if (unsupported) return null;

  const message = text.trim();
  const send = async () => {
    if (!message || sending) return;
    setSending(true);
    try {
      await onSend(subagentId, message);
      setText("");
    } catch (error) {
      if (isUnsupportedCommandError(error)) {
        if (markControlUnsupported("steer")) toast.info(t("subagentTranscript.steerUnsupported"));
      } else {
        toast.error(t("subagentTranscript.steerFailed"), error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      data-steer-subagent
      onSubmit={(e) => { e.preventDefault(); void send(); }}
      style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={sending}
        placeholder={t("subagentTranscript.steerPlaceholder")}
        aria-label={t("subagentTranscript.steerLabel")}
        maxLength={4000}
        className="ui-focus-ring"
        style={{
          flex: 1, minWidth: 0, height: 34, padding: "0 10px", fontSize: 13, fontFamily: "inherit",
          color: "var(--text)", background: "var(--bg-panel)",
          border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
        }}
      />
      <button
        type="submit"
        disabled={sending || !message}
        aria-label={t("subagentTranscript.steerSend")}
        title={t("subagentTranscript.steerSend")}
        className="ui-focus-ring"
        style={{
          width: 34, height: 34, minWidth: 34, display: "flex", alignItems: "center", justifyContent: "center",
          background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
          color: message && !sending ? "var(--accent)" : "var(--text-dim)",
          cursor: sending ? "wait" : message ? "pointer" : "default",
          touchAction: "manipulation",
        }}
      >
        {sending ? <Loader2 size={16} aria-hidden="true" className="icon-spin" /> : <Send size={16} aria-hidden="true" />}
      </button>
    </form>
  );
}

/** How often a running child's frames may trigger a refetch (trailing edge). */
const TRANSCRIPT_REFRESH_MS = 600;

export function SubagentTranscriptDialog({ subagent, sessionId, transcriptVersion, events, onSteer, onClose }: {
  subagent: SubagentInfo | null;
  sessionId: string | null;
  transcriptVersion: number;
  events?: SubagentActivityEvent[];
  /** Steers the parent turn (the composer's steer path). Absent when the
   * engine cannot be steered or the parent is idle; the cancel affordance
   * then hides rather than rendering broken. */
  onSteer?: (message: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const cancelUnsupported = useControlUnsupported("cancel");
  const steerUnsupported = useControlUnsupported("steer");
  const [detail, setDetail] = useState<SubagentSnapshotLike | null>(null);
  // Subagent ids whose cancel steer was sent, for the life of this mounted
  // dialog: reopening the same child must not offer a second cancel.
  const [cancelRequestedIds, setCancelRequestedIds] = useState<ReadonlySet<string>>(() => new Set());
  const markCancelRequested = useCallback((id: string) => {
    setCancelRequestedIds((prev) => prev.has(id) ? prev : new Set(prev).add(id));
  }, []);
  const [completion, setCompletion] = useState<string | null>(null);
  const [completionTruncated, setCompletionTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the first load settles: revalidation cycles triggered by live
  // frames must never regress already-rendered content to a placeholder.
  const [loadedForSubagent, setLoadedForSubagent] = useState<string | null>(null);
  // The dialog body that scrolls (the ONE scroll container) and the single
  // element inside it that wraps its content. State, so the transcript's scroll
  // layer binds the moment both exist.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const requestSeqRef = useRef(0);
  const refreshKey = useThrottledValue(transcriptVersion, TRANSCRIPT_REFRESH_MS);
  const handledRefreshRef = useRef(refreshKey);

  const open = subagent !== null;
  const fromDisk = subagent?.source === "history";
  const live = !fromDisk;

  const fetchCompletion = useCallback(async (): Promise<{ completion: string | null; truncated: boolean }> => {
    if (!sessionId || !subagent?.id) throw new Error("No session");
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagent.id)}?mode=completion`);
    if (res.status === 404) return { completion: null, truncated: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as { completion: string | null; truncated: boolean };
  }, [sessionId, subagent?.id]);

  const load = useCallback(async () => {
    if (!sessionId || !subagent?.id) return;
    const seq = ++requestSeqRef.current;
    setError(null);
    try {
      const found = await fetchCompletion();
      // Live snapshots enrich the header (resolved model etc.) but carry no
      // settled output — the on-disk `<id>.md` is the completion source.
      if (found.completion === null && live) {
        const result = await sendAgentCommand<{ subagents?: SubagentSnapshotLike[] }>(sessionId, { type: "get_subagents" });
        const snap = (result.subagents ?? []).find((s) => s.id === subagent?.id);
        if (seq !== requestSeqRef.current) return;
        if (snap) setDetail(snap);
      }
      if (seq !== requestSeqRef.current) return;
      setCompletion(found.completion);
      setCompletionTruncated(found.truncated);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeqRef.current) setLoadedForSubagent(subagent.id);
    }
  }, [sessionId, subagent?.id, live, fetchCompletion]);

  // Load the completion whenever the dialog opens for a subagent. (The
  // transcript fetches for itself: it only mounts while the dialog is open.)
  useEffect(() => {
    if (!open || !sessionId) return;
    requestSeqRef.current += 1;
    setCompletion(null);
    setCompletionTruncated(false);
    setError(null);
    setDetail(null);
    setLoadedForSubagent(null);
    void load();
  }, [open, sessionId, load]);

  // Live child frames mean the final output may have just landed (and refresh
  // the header's live snapshot). Throttled: one refetch per window.
  useEffect(() => {
    if (!open || !sessionId) {
      handledRefreshRef.current = refreshKey;
      return;
    }
    if (refreshKey === handledRefreshRef.current) return;
    handledRefreshRef.current = refreshKey;
    void load();
  }, [open, sessionId, refreshKey, load]);

  const currentDetail = detail?.id === subagent?.id ? detail : null;
  const contentReady = loadedForSubagent === subagent?.id;
  const agent = currentDetail?.agent ?? subagent?.agent ?? "";
  const description = currentDetail?.description ?? subagent?.description ?? "";
  const task = currentDetail?.task ?? subagent?.task ?? subagent?.assignment ?? "";
  const progress = parseSubagentProgress(currentDetail?.progress) ?? subagent?.progress;
  let latestModelEvent: SubagentActivityEvent | undefined;
  let latestThinkingEvent: SubagentActivityEvent | undefined;
  if (live && events) {
    for (let index = events.length - 1; index >= 0 && (!latestModelEvent || !latestThinkingEvent); index -= 1) {
      const event = events[index];
      if (!latestModelEvent && (event.kind === "model_changed" || event.kind === "retry_fallback_applied") && event.to) {
        latestModelEvent = event;
      }
      if (!latestThinkingEvent && event.kind === "thinking_level_changed" && event.thinkingLevel) {
        latestThinkingEvent = event;
      }
    }
  }
  const displayProgress = latestModelEvent || latestThinkingEvent
    ? {
        ...progress,
        ...(latestModelEvent ? {
          resolvedModel: latestModelEvent.to ?? progress?.resolvedModel,
          resolvedModelIsFallback: latestModelEvent.kind === "retry_fallback_applied",
        } : {}),
        ...(latestThinkingEvent ? { thinkingLevel: latestThinkingEvent.thinkingLevel ?? progress?.thinkingLevel } : {}),
      }
    : progress;
  const historyTokens = formatTokens(progress?.tokens);
  const historyMeta = subagent?.source === "history"
    ? [
        historyTokens ? t("chatWindow.tokensUnit", { count: historyTokens }) : null,
        formatCost(progress?.cost),
        formatDuration(progress?.durationMs),
        shortModel(progress?.resolvedModel),
      ].filter(Boolean).join(" · ")
    : null;
  const outcomeError = subagent?.source === "history"
    ? subagent?.result?.abortReason ?? subagent?.result?.error
    : undefined;
  // Current lifecycle state: the click-time roster snapshot opens the dialog
  // with a frozen status, so get_subagents refreshes (detail) carry the live
  // one. Terminal states hide the live-activity indicator; a landed
  // completion is terminal regardless of how stale the status still is.
  const currentStatus = currentDetail?.status ?? subagent?.status;
  const subagentActive = live && !completion
    && (currentStatus === "started" || currentStatus === "pending" || currentStatus === "running");
  const recentEvents = events && events.length > 0 ? events.slice(-4) : null;
  const cancelVisible = subagentActive && (onSteer !== undefined || (sessionId !== null && !cancelUnsupported));
  const steerVisible = subagentActive && sessionId !== null && !steerUnsupported;
  const cancelSubagent = useCallback(
    (subagentId: string) => sendAgentCommand<{ cancelled?: boolean }>(sessionId as string, { type: "cancel_subagent", subagentId }),
    [sessionId],
  );
  const steerSubagent = useCallback(async (subagentId: string, message: string) => {
    await sendAgentCommand(sessionId as string, { type: "steer_subagent", subagentId, message });
  }, [sessionId]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {subagent && (
        <DialogContent
          key={subagent.id}
          ariaLabel={t("subagentTranscript.title")}
          onClose={onClose}
          closeLabel={t("subagentTranscript.close")}
          // The popup must not be the scroller, or the pinned close button
          // rides away with the transcript (see DialogContent's contract):
          // the header below is fixed and the body owns the scroll region.
          // A fixed height, so the dialog never resizes as pages arrive, the
          // Result block lands or the child finishes.
          style={{
            width: "min(94vw, 920px)",
            maxWidth: "min(94vw, 920px)",
            height: "min(85dvh, 880px)",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <>
            {subagentActive && (
              <CancelSubtaskButton
                subagent={subagent}
                status={currentStatus}
                canSteer={onSteer !== undefined}
                requested={cancelRequestedIds.has(subagent.id)}
                onRequested={markCancelRequested}
                onSteer={onSteer}
                onCancelSubagent={sessionId ? cancelSubagent : undefined}
              />
            )}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0, padding: "16px 18px 12px", paddingRight: cancelVisible ? 80 : 44 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <DialogTitle style={{ marginBottom: 2, fontSize: 16, lineHeight: 1.3 }}>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)", fontSize: 14 }}>{agent}</span>
                </DialogTitle>
                {description && (
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
                    {description}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentDetail?.sessionFile ?? subagent.sessionFile ?? subagent.id}</div>
                <ModelAndReasoningBlock progress={displayProgress} />
                {subagent?.modelHandoff && (
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 2 }}>
                    {t("chatWindow.subagentModelHandoff", {
                      from: shortModel(subagent.modelHandoff.from) ?? subagent.modelHandoff.from,
                      to: shortModel(subagent.modelHandoff.to) ?? subagent.modelHandoff.to,
                      time: new Date(subagent.modelHandoff.at).toLocaleTimeString(),
                    })}
                  </div>
                )}
                {historyMeta && (
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                    {historyMeta}
                  </div>
                )}
                {outcomeError && (
                  <div style={{ fontSize: 11, color: "var(--status-error)", marginTop: 2, wordBreak: "break-word" }}>
                    {outcomeError}
                  </div>
                )}
              </div>
            </div>
            {/* The ONE scroll container. Native scroll anchoring is off: the
                transcript holds the reader's row itself (lib/transcript-scroll),
                the same way in every browser. `scroll-behavior: auto` keeps
                every programmatic scroll instant. */}
            <div
              ref={setScroller}
              data-testid="subagent-transcript-scroll"
              style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowAnchor: "none", overscrollBehavior: "contain", scrollBehavior: "auto", padding: "0 18px 18px" }}
            >
              <div ref={setContent} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {/* Errors render alongside whatever already loaded: a failed
                    revalidation must not blank out rendered content. */}
                {contentReady && error && (
                  <div style={{ fontSize: 12, color: "var(--status-error)", padding: "8px 2px" }}>{error}</div>
                )}
                {contentReady && completion && <CompletionBlock completion={completion} truncated={completionTruncated} />}
                <TaskBlock task={task} />
                {sessionId && (
                  <SubagentTranscript
                    sessionId={sessionId}
                    subagentId={subagent.id}
                    sessionFile={currentDetail?.sessionFile ?? subagent.sessionFile}
                    rpcFallback={live}
                    active={subagentActive}
                    refreshKey={refreshKey}
                    scroller={scroller}
                    content={content}
                  />
                )}
                {recentEvents && (
                  <div
                    aria-live="polite"
                    style={{
                      display: "grid",
                      gap: 2,
                      padding: "6px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)",
                      background: "var(--bg-panel)",
                    }}
                  >
                    {recentEvents.map((event, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          gap: 6,
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          color: event.kind === "tool"
                            ? "var(--accent)"
                            : event.kind === "retry_fallback_applied" ? "var(--status-warning)" : "var(--text-muted)",
                          minWidth: 0,
                        }}
                      >
                        <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                          {event.kind === "tool" ? "·" : event.kind === "retry_fallback_applied" ? "!" : "»"}
                        </span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subagentActivityLabel(event, t)}</span>
                        {subagentActive && i === recentEvents.length - 1 && (
                          <ActivityIndicator reducedMotion={reducedMotion} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {steerVisible && <SteerSubagentBox subagentId={subagent.id} onSend={steerSubagent} />}
          </>
        </DialogContent>
      )}
    </Dialog>
  );
}
