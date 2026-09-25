"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ban, Loader2 } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { sendAgentCommand } from "@/lib/agent-client";
import { useI18n } from "@/lib/i18n";
import { formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { thinkingLevelLabel } from "@/lib/thinking-level-labels";
import { MarkdownBody } from "./MarkdownBody";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { toast } from "./ui/toast";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import { parseSubagentProgress } from "@/lib/subagent-types";
import type { SubagentActivityEvent, SubagentProgress, SubagentSnapshotLike } from "@/lib/subagent-types";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";

interface SubagentMessagesPage {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset?: boolean;
  messages: AgentMessage[];
  totalBytes?: number;
  previousByte?: number;
  hasEarlier?: boolean;
}

/** Compact, defensive row for one raw transcript message (content may be a
 * string, a block array, or absent — legacy pi / omp RPC shapes). Memoized:
 * transcript arrays only ever append immutably, so settled rows never
 * re-render while a stream is appending. */
const SubagentTranscriptRow = memo(function SubagentTranscriptRow({ message }: { message: AgentMessage }) {
  const label = message.role === "user" ? "U" : message.role === "assistant" ? "A" : "R";
  const labelColor = message.role === "user" ? "var(--accent)" : message.role === "assistant" ? "var(--text-muted)" : "var(--text-dim)";
  const rawContent = (message as ToolResultMessage).content;
  const blocks: Array<{ type: string; text?: unknown }> = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
    : Array.isArray(rawContent)
      ? rawContent as Array<{ type: string; text?: unknown }>
      : [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .slice(0, 400);
  const isError = (message as ToolResultMessage).isError === true;
  return (
    <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
      <span style={{ flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)", color: labelColor, paddingTop: 2 }}>{label}</span>
      <div
        style={{
          fontSize: message.role === "toolResult" || message.role === "assistant" ? 11.5 : 12.5,
          lineHeight: 1.55,
          minWidth: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: message.role === "toolResult" ? "var(--text-muted)" : "var(--text)",
          fontFamily: message.role === "toolResult" ? "var(--font-mono)" : "inherit",
        }}
      >
        {message.role === "assistant" && typeof rawContent !== "string" && Array.isArray(rawContent)
          ? rawContent.map((block, i) => (
              <div key={i}>
                {block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
                  ? `→ ${(block as { toolName?: unknown }).toolName ?? "tool"} ${JSON.stringify((block as { input?: unknown }).input ?? {})}`
                  : block && typeof block === "object" && (block as { type?: unknown }).type === "text"
                    ? ((block as { text?: unknown }).text as string) ?? ""
                    : ""}
              </div>
            ))
          : text || (message.role === "user" || message.role === "assistant" ? "" : isError ? "(error)" : "(no output)")}
      </div>
    </div>
  );
});

const BLOCK_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

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

/** The subagent's assignment, rendered as markdown. Exported for SSR tests.
 * Memoized: markdown parsing is the most expensive subtree here and the task
 * string never changes while live frames stream in. */
export const TaskBlock = memo(function TaskBlock({ task }: { task: string }) {
  const { t } = useI18n();
  if (!task) return null;
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", padding: "10px 12px" }}>
      <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.taskLabel")}</span>
      <div style={{ marginTop: 6 }}>
        <MarkdownBody className="markdown-subagent-text">{task}</MarkdownBody>
      </div>
    </section>
  );
});

/** The subagent's final output (`<id>.md`). Exported for SSR tests. Memoized
 * for the same reason as TaskBlock: the completion only changes when the
 * settled output actually lands. */
export const CompletionBlock = memo(function CompletionBlock({ completion, truncated }: { completion: string | null; truncated: boolean }) {
  const { t } = useI18n();
  let parsed: Record<string, unknown> | null = null;
  if (completion) {
    try {
      const candidate = JSON.parse(completion) as unknown;
      if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }
  const keys = parsed ? Object.keys(parsed) : [];
  const singleText = parsed && keys.length === 1 && typeof parsed[keys[0]] === "string" ? parsed[keys[0]] as string : null;
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.resultLabel")}</span>
        {truncated && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("subagentTranscript.completionTruncated")}</span>}
      </div>
      {singleText ? (
        <div style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
          {singleText}
        </div>
      ) : parsed ? (
        <div style={{ marginTop: 6 }}>
          <JsonValue value={parsed} />
        </div>
      ) : completion ? (
        <div style={{ marginTop: 6 }}>
          <MarkdownBody className="markdown-subagent-text">{completion}</MarkdownBody>
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
          {t("subagentTranscript.noCompletion")}
        </div>
      )}
    </section>
  );
});

/** Distance from the bottom edge (px) within which auto-follow re-engages. */
const FOLLOW_REENGAGE_PX = 40;

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

/** The resolved model settings are status only: a running subagent cannot be steered. */
export const ModelAndReasoningBlock = memo(function ModelAndReasoningBlock({ progress }: { progress?: SubagentProgress }) {
  const { t } = useI18n();
  const none = t("subagentTranscript.none");
  const model = progress?.resolvedModel ?? none;
  const role = progress?.modelRole ?? none;
  const thinkingLevel = progress?.thinkingLevel ? thinkingLevelLabel(progress.thinkingLevel, t) : none;

  return (
    <section
      aria-label={t("subagentTranscript.modelReasoning")}
      style={{
        display: "grid",
        gap: 7,
        marginTop: 10,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-subtle)",
      }}
    >
      <strong style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("subagentTranscript.modelReasoning")}</strong>
      <dl style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 8, rowGap: 4, margin: 0, fontSize: 11 }}>
        <dt style={{ color: "var(--text-dim)" }}>{t("subagentTranscript.model")}</dt>
        <dd style={{ minWidth: 0, margin: 0, overflowWrap: "anywhere", fontFamily: "var(--font-mono)", color: "var(--text)" }}>
          {model}
          {progress?.resolvedModelIsFallback && (
            <span style={{ marginLeft: 6, color: "var(--status-warning)", fontFamily: "inherit" }}>({t("subagentTranscript.fallback")})</span>
          )}
        </dd>
        <dt style={{ color: "var(--text-dim)" }}>{t("subagentTranscript.role")}</dt>
        <dd style={{ minWidth: 0, margin: 0, overflowWrap: "anywhere", fontFamily: "var(--font-mono)", color: "var(--text)" }}>{role}</dd>
        <dt style={{ color: "var(--text-dim)" }}>{t("subagentTranscript.reasoning")}</dt>
        <dd style={{ minWidth: 0, margin: 0, overflowWrap: "anywhere", color: "var(--text)" }}>{thinkingLevel}</dd>
      </dl>
      <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, color: "var(--text-dim)" }}>
        {t("subagentTranscript.modelReasoningExplanation")}
      </p>
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

/** The steer that asks the parent model to cancel a subtask. omp exposes no
 * per-subagent abort over RPC, so the parent is told exactly which hub job to
 * cancel and to carry on without it. Exported for tests. */
export function cancelSubtaskSteerText(subagent: Pick<SubagentInfo, "id" | "agent" | "task" | "description" | "assignment">): string {
  const raw = (subagent.task ?? subagent.assignment ?? subagent.description ?? "").replace(/\s+/g, " ").trim();
  const summary = raw.length > CANCEL_SUMMARY_MAX ? raw.slice(0, CANCEL_SUMMARY_MAX - 1).trimEnd() + "…" : raw;
  const idJson = JSON.stringify(subagent.id);
  return `The user cancelled subtask ${idJson} (${subagent.agent}: ${summary}). Cancel it now with hub cancel (ids: [${idJson}]) and continue without its result; do not wait for or use anything it produces.`;
}

/** Header icon button that steers the parent model to cancel a running
 * subtask. Renders nothing unless the child is still live AND the parent can
 * be steered; a first click arms it, a second within four seconds sends the
 * steer. It never claims the child was killed: the parent decides. Mirrors
 * the DialogContent close button's geometry so the pair reads as one row.
 * Exported for SSR tests. */
export function CancelSubtaskButton({ subagent, status, canSteer, requested, onRequested, onSteer }: {
  subagent: Pick<SubagentInfo, "id" | "agent" | "task" | "description" | "assignment">;
  status: string | undefined;
  canSteer: boolean;
  requested: boolean;
  onRequested: (subagentId: string) => void;
  onSteer?: (message: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const disarmTimerRef = useRef<number | undefined>(undefined);

  // A new subagent in the same mounted button must not inherit an armed
  // state; the cleanup also covers unmount.
  useEffect(() => {
    setArmed(false);
    return () => clearTimeout(disarmTimerRef.current);
  }, [subagent.id]);

  const live = status === "started" || status === "pending" || status === "running";
  if (!live || !canSteer || !onSteer) return null;

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
      await onSteer(cancelSubtaskSteerText(subagent));
      onRequested(subagent.id);
      toast.info(t("subagentTranscript.cancelRequestedToast"));
    } catch (error) {
      // A rejected steer (engine without the command, dropped session) is the
      // whole story: the button stays available so the user can retry.
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

/** Scrollable transcript list with stick-to-bottom follow. Memoized so live
 * status frames re-rendering the dialog shell never touch the (potentially
 * large) message list; rows render additively because the messages array only
 * ever appends (a server `reset` page legitimately replaces it).
 *
 * Follow contract: opening lands on the newest message; a manual scroll up
 * disengages following; returning within FOLLOW_REENGAGE_PX of the bottom
 * re-engages it. Programmatic scrolls coalesce into one rAF and jump
 * instantly (plain scrollTop assignment), so rapid streaming cannot hitch and
 * there is no smooth scroll to gate on prefers-reduced-motion. */
const TranscriptPanel = memo(function TranscriptPanel({ messages, loading, error, exhausted, hasEarlier, followContent, reducedMotion, prependVersion, onLoadMore }: {
  messages: AgentMessage[];
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  hasEarlier: boolean;
  followContent: boolean;
  reducedMotion: boolean;
  prependVersion: number;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followFrameRef = useRef<number | null>(null);
  const previousHeightRef = useRef(0);
  const previousPrependVersionRef = useRef(prependVersion);

  const disengage = useCallback(() => {
    pinnedRef.current = false;
    programmaticScrollRef.current = false;
  }, []);
  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_REENGAGE_PX;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependVersion !== previousPrependVersionRef.current) {
      const delta = el.scrollHeight - previousHeightRef.current;
      if (delta > 0) {
        el.scrollTop += delta;
        pinnedRef.current = false;
      }
      previousPrependVersionRef.current = prependVersion;
    }
    previousHeightRef.current = el.scrollHeight;
  }, [messages, prependVersion]);

  useEffect(() => {
    if (!pinnedRef.current || followFrameRef.current !== null) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      const el = scrollRef.current;
      if (!el || !pinnedRef.current) return;
      programmaticScrollRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
        programmaticTimerRef.current = null;
      }, reducedMotion ? 40 : 500);
    });
  }, [messages, reducedMotion]);

  useEffect(() => () => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
  }, []);

  return (
    <div
      id="subagent-transcript-panel"
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={disengage}
      onTouchMove={disengage}
      style={{
        display: "grid", gap: 8, alignContent: "start", padding: "10px 12px",
        border: "1px solid var(--border)", borderRadius: "var(--radius-card)",
        background: "var(--bg-panel)", ...(followContent ? { height: "50dvh" } : { maxHeight: "50dvh" }),
        overflowY: "auto",
      }}
    >
      {error && <div style={{ fontSize: 12, color: "var(--status-error)" }}>{error}</div>}
      {messages.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>{loading ? t("subagentTranscript.loading") : t("subagentTranscript.noMessages")}</div>
      ) : messages.map((message, i) => <SubagentTranscriptRow key={i} message={message} />)}
      {hasEarlier && (
        <button type="button" disabled={loading} onClick={onLoadMore} style={{ justifySelf: "start", background: "none", border: "none", color: "var(--accent)", cursor: loading ? "default" : "pointer", fontSize: 12, fontFamily: "inherit", padding: 0, opacity: loading ? 0.5 : 1 }}>
          {t("subagentTranscript.loadMore")}
        </button>
      )}
      {!exhausted && !hasEarlier && messages.length > 0 && (
        <button type="button" disabled={loading} onClick={onLoadMore} style={{ justifySelf: "start", background: "none", border: "none", color: "var(--accent)", cursor: loading ? "default" : "pointer", fontSize: 12, fontFamily: "inherit", padding: 0, opacity: loading ? 0.5 : 1 }}>
          {t("subagentTranscript.loadMore")}
        </button>
      )}
    </div>
  );
});

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
  const [detail, setDetail] = useState<SubagentSnapshotLike | null>(null);
  // Subagent ids whose cancel steer was sent, for the life of this mounted
  // dialog: reopening the same child must not offer a second cancel.
  const [cancelRequestedIds, setCancelRequestedIds] = useState<ReadonlySet<string>>(() => new Set());
  const markCancelRequested = useCallback((id: string) => {
    setCancelRequestedIds((prev) => prev.has(id) ? prev : new Set(prev).add(id));
  }, []);
  const [completion, setCompletion] = useState<string | null>(null);
  const [completionTruncated, setCompletionTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptMessages, setTranscriptMessages] = useState<AgentMessage[]>([]);
  const [transcriptNextByte, setTranscriptNextByte] = useState(0);
  const [transcriptBeforeByte, setTranscriptBeforeByte] = useState(0);
  const [transcriptHasEarlier, setTranscriptHasEarlier] = useState(false);
  const [transcriptPrependVersion, setTranscriptPrependVersion] = useState(0);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptExhausted, setTranscriptExhausted] = useState(false);
  // True once the first load settles: revalidation cycles triggered by live
  // frames must never regress already-rendered content to a placeholder.
  const [loadedForSubagent, setLoadedForSubagent] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const transcriptRequestSeqRef = useRef(0);
  const refetchedVersionRef = useRef(0);
  const refetchedTranscriptVersionRef = useRef(0);
  const latestVersionRef = useRef(0);
  const versionDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionLastFiredRef = useRef(0);

  const open = subagent !== null;
  const fromDisk = subagent?.source === "history";
  const live = !fromDisk;
  const subagentId = subagent?.id;
  const subagentSessionFile = subagent?.sessionFile;

  const fetchCompletion = useCallback(async (): Promise<{ completion: string | null; truncated: boolean }> => {
    if (!sessionId || !subagentId) throw new Error("No session");
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}?mode=completion`);
    if (res.status === 404) return { completion: null, truncated: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as { completion: string | null; truncated: boolean };
  }, [sessionId, subagentId]);

  // Full transcript page (RPC registry first, disk fallback) — mirrors the
  // get_subagent_messages response shape so both sources are interchangeable.
  const fetchTranscriptPage = useCallback(async (startByte: number, preferDisk: boolean, direction: "forward" | "before", tail = false): Promise<SubagentMessagesPage> => {
    if (!sessionId || !subagentId) throw new Error("No session");
    if (preferDisk) {
      const params = new URLSearchParams(direction === "before" ? { beforeByte: String(startByte) } : { fromByte: String(startByte) });
      if (tail) params.set("tail", "1");
      const url = "/api/sessions/" + encodeURIComponent(sessionId) + "/subagents/" + encodeURIComponent(subagentId) + "?" + params.toString();
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json() as SubagentMessagesPage;
    }
    if (direction === "before") throw new Error("Earlier transcript pages require the disk reader");
    return await sendAgentCommand<SubagentMessagesPage>(sessionId, {
      type: "get_subagent_messages",
      subagentId,
      sessionFile: subagentSessionFile,
      fromByte: startByte,
    });
  }, [sessionId, subagentId, subagentSessionFile]);

  const loadTranscriptPage = useCallback(async (startByte: number, direction: "forward" | "before" = "forward", tail = false) => {
    if (!sessionId || !subagent?.id) return;
    const seq = ++transcriptRequestSeqRef.current;
    setTranscriptLoading(true);
    setTranscriptError(null);
    try {
      let page: SubagentMessagesPage;
      try {
        page = await fetchTranscriptPage(startByte, fromDisk || tail, direction, tail);
      } catch (rpcError) {
        if (fromDisk || direction === "before" || !subagent.id) throw rpcError;
        page = await fetchTranscriptPage(startByte, false, direction, false);
      }
      if (seq !== transcriptRequestSeqRef.current) return;
      if (page.reset) {
        setTranscriptMessages(page.messages);
      } else if (direction === "before") {
        setTranscriptMessages((prev) => [...page.messages, ...prev]);
      } else {
        setTranscriptMessages((prev) => [...prev, ...page.messages]);
      }
      if (direction === "before") {
        setTranscriptBeforeByte(page.fromByte);
        setTranscriptHasEarlier(page.hasEarlier ?? page.fromByte > 0);
        setTranscriptPrependVersion((version) => version + 1);
      } else {
        setTranscriptNextByte(page.nextByte);
        if (tail || page.reset) setTranscriptHasEarlier(page.hasEarlier ?? page.fromByte > 0);
        const complete = typeof page.totalBytes === "number" ? page.nextByte >= page.totalBytes : page.messages.length === 0;
        setTranscriptExhausted(complete || page.nextByte <= page.fromByte);
        if (tail || page.reset) setTranscriptBeforeByte(page.fromByte);
      }
    } catch (e) {
      if (seq !== transcriptRequestSeqRef.current) return;
      setTranscriptError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === transcriptRequestSeqRef.current) setTranscriptLoading(false);
    }
  }, [sessionId, subagent?.id, fromDisk, fetchTranscriptPage]);

  const handleLoadMore = useCallback(() => {
    if (transcriptHasEarlier) {
      void loadTranscriptPage(transcriptBeforeByte, "before");
    } else {
      void loadTranscriptPage(transcriptNextByte);
    }
  }, [loadTranscriptPage, transcriptBeforeByte, transcriptHasEarlier, transcriptNextByte]);

  const load = useCallback(async () => {
    if (!sessionId || !subagent?.id) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
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
      if (seq === requestSeqRef.current) {
        setLoading(false);
        setLoadedForSubagent(subagent.id);
      }
    }
  }, [sessionId, subagent?.id, live, fetchCompletion]);

  // Load the completion whenever the dialog opens for a subagent.
  useEffect(() => {
    if (!open || !sessionId) return;
    requestSeqRef.current += 1;
    transcriptRequestSeqRef.current += 1;
    setCompletion(null);
    setCompletionTruncated(false);
    setError(null);
    setDetail(null);
    setLoadedForSubagent(null);
    setTranscriptOpen(false);
    setTranscriptMessages([]);
    setTranscriptNextByte(0);
    setTranscriptBeforeByte(0);
    setTranscriptHasEarlier(false);
    setTranscriptPrependVersion(0);
    setTranscriptExhausted(false);
    setTranscriptError(null);
    // The bumped seq invalidates an in-flight request whose finally will skip
    // clearing this — reset it here or the next open shows Loading forever.
    setTranscriptLoading(false);
    refetchedVersionRef.current = 0;
    refetchedTranscriptVersionRef.current = 0;
    latestVersionRef.current = 0;
    versionLastFiredRef.current = 0;
    if (versionDebounceTimerRef.current) {
      clearTimeout(versionDebounceTimerRef.current);
      versionDebounceTimerRef.current = null;
    }
    void load();
  }, [open, sessionId, load]);

  // Live child events mean the final output may have just landed — refetch the
  // completion and (when the transcript is open) append its next page. Bumps
  // are THROTTLED (trailing edge): fetches coalesce to one per window, but a
  // continuous stream still flushes every window instead of re-arming forever
  // the way a restart-debounce would, so an open transcript keeps following.
  // The latest version is never dropped — a bump mid-window re-arms the timer
  // for the window remainder — and the already-processed guard prevents
  // same-version loops.
  useEffect(() => {
    if (!open || !sessionId || transcriptVersion === 0) return;
    const completionDone = transcriptVersion === refetchedVersionRef.current && transcriptVersion === latestVersionRef.current;
    const transcriptDone = transcriptVersion === refetchedTranscriptVersionRef.current;
    if (completionDone && transcriptDone) return;
    latestVersionRef.current = transcriptVersion;
    if (versionDebounceTimerRef.current) clearTimeout(versionDebounceTimerRef.current);
    const sinceLastFire = Date.now() - versionLastFiredRef.current;
    const delay = sinceLastFire >= 600 ? 0 : 600 - sinceLastFire;
    versionDebounceTimerRef.current = setTimeout(() => {
      versionDebounceTimerRef.current = null;
      versionLastFiredRef.current = Date.now();
      // Completion fetch: consume the version only when actually fired.
      if (refetchedVersionRef.current !== latestVersionRef.current) {
        refetchedVersionRef.current = latestVersionRef.current;
        void load();
      }
      // Paging has its own sequence guard, so a busy request may safely be
      // superseded by the newest coalesced version instead of re-running this
      // timer whenever loading state changes.
      if (transcriptOpen && refetchedTranscriptVersionRef.current !== latestVersionRef.current) {
        refetchedTranscriptVersionRef.current = latestVersionRef.current;
        void loadTranscriptPage(transcriptNextByte);
      }
    }, delay);
    return () => {
      if (versionDebounceTimerRef.current) clearTimeout(versionDebounceTimerRef.current);
    };
  }, [open, sessionId, transcriptVersion, transcriptOpen, load, loadTranscriptPage, transcriptNextByte]);

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
  const cancelVisible = subagentActive && onSteer !== undefined;

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
          style={{
            width: "min(94vw, 920px)",
            maxWidth: "min(94vw, 920px)",
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
                canSteer={cancelVisible}
                requested={cancelRequestedIds.has(subagent.id)}
                onRequested={markCancelRequested}
                onSteer={onSteer}
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
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 18px 18px" }}>
            {recentEvents && (
              <div
                aria-live="polite"
                style={{
                  display: "grid",
                  gap: 2,
                  marginBottom: 8,
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
                      {event.kind === "tool" ? "·" : event.kind === "retry_fallback_applied" || event.kind === "notice" ? "!" : "»"}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subagentActivityLabel(event, t)}</span>
                    {subagentActive && i === recentEvents.length - 1 && (
                      <ActivityIndicator reducedMotion={reducedMotion} />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Errors render alongside whatever already loaded: a failed
                revalidation must not blank out rendered content. */}
            {contentReady && error && (
              <div style={{ fontSize: 12, color: "var(--status-error)", padding: "8px 2px" }}>{error}</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <TaskBlock task={task} />
              <CompletionBlock completion={contentReady ? completion : null} truncated={contentReady && completionTruncated} />
              {loading && !contentReady && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("subagentTranscript.loading")}</div>}
              <button
                type="button"
                aria-expanded={transcriptOpen}
                aria-controls="subagent-transcript-panel"
                onClick={() => {
                  const next = !transcriptOpen;
                  setTranscriptOpen(next);
                  if (next && transcriptMessages.length === 0 && !transcriptLoading) {
                    void loadTranscriptPage(0, "forward", true);
                  }
                }}
                style={{
                  alignSelf: "flex-start",
                  background: "none",
                  border: "none",
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: "inherit",
                  padding: 0,
                }}
              >
                {transcriptOpen ? t("subagentTranscript.hideTranscript") : t("subagentTranscript.showTranscript")}
              </button>
              {transcriptOpen && (
                <TranscriptPanel
                  messages={transcriptMessages}
                  loading={transcriptLoading}
                  error={transcriptError}
                  exhausted={transcriptExhausted}
                  hasEarlier={transcriptHasEarlier}
                  followContent={subagentActive}
                  reducedMotion={reducedMotion}
                  prependVersion={transcriptPrependVersion}
                  onLoadMore={handleLoadMore}
                />
              )}
            </div>
            </div>
          </>
        </DialogContent>
      )}
    </Dialog>
  );
}
