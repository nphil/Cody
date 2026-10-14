"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  btwCopyText, btwTurns, canFollowUpBtw, isBtwRunning, latestBtwTurn,
  type BtwRecord, type BtwStatus, type BtwTurn,
} from "@/lib/btw";
import { MarkdownBody } from "./MarkdownBody";

/**
 * The Side Bar's "This chat" view: side questions (omp's `/btw`) about the chat
 * open in the main window. They run beside its reply, see the whole
 * conversation, and their answers stay here instead of joining it.
 *
 * Presentational only. Every piece of state that matters (topics, busy flags,
 * the error) lives in `useSideQuestions`, next to the main chat's event stream,
 * and reaches the Side Bar through the bridge (hooks/useSideQuestionsBridge.ts);
 * this keeps the text drafts, the "show all" fold and focus.
 */
export interface SidebarSideQuestionsProps {
  /** Every topic, newest first. */
  records: readonly BtwRecord[];
  /** Some topic's latest turn is being answered (omp runs one at a time). */
  answering: boolean;
  /** A question was sent and the engine has not acknowledged it yet. */
  asking: boolean;
  /** Last failure, already in plain words. */
  error: string | null;
  onDismissError: () => void;
  /** true = accepted (the box is cleared); false = refused (the text is kept). */
  onAsk: (question: string, recordId?: string) => Promise<boolean>;
  onCancel: (recordId: string) => void;
  /** Base directory for file links in answers. */
  cwd?: string;
  /** This view is on screen: a pending focus request is only carried out then. */
  visible: boolean;
  /** Something outside asked for the question box to take focus. */
  focusPending: boolean;
  /** The focus request was carried out. */
  onFocused: () => void;
  /** Sizes for a finger (true) or a mouse (false). Left out, it follows the device; a static render passes it. */
  touch?: boolean;
}

/** Topics shown before the footer link folds the rest: every one is a markdown
 *  render, and omp keeps up to 200 of them. */
const MAX_VISIBLE_TOPICS = 10;
/** Same ceiling as SafeMarkdownBody: beyond it the markdown pipeline is skipped. */
const MAX_MARKDOWN_CHARS = 100_000;

const STATUS_KEYS: Record<BtwStatus, string> = {
  running: "btw.statusRunning",
  complete: "btw.statusComplete",
  cancelled: "btw.statusCancelled",
  error: "btw.statusError",
  interrupted: "btw.statusInterrupted",
};

/**
 * Control sizes. A finger needs 38px and 16px text (the phone tap-target floor;
 * 16px keeps iOS from zooming on focus); a mouse gets the compact 30px the New
 * chat composer's Send button already uses, so the two composers match.
 */
const TOUCH_CONTROL_HEIGHT = 38;
const MOUSE_CONTROL_HEIGHT = 30;

function buttonStyle(touch: boolean): CSSProperties {
  return {
    minHeight: touch ? TOUCH_CONTROL_HEIGHT : MOUSE_CONTROL_HEIGHT,
    padding: "0 12px",
    fontSize: 12,
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    flexShrink: 0,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg)",
    color: "var(--text-muted)",
    cursor: "pointer",
    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
  };
}

function inputStyle(touch: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    minHeight: touch ? TOUCH_CONTROL_HEIGHT : MOUSE_CONTROL_HEIGHT,
    padding: "0 10px",
    fontSize: touch ? 16 : 13,
    fontFamily: "inherit",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg)",
    color: "var(--text)",
  };
}

function useTouchSizing(override?: boolean): boolean {
  const isMobile = useIsMobile();
  const isCoarsePointer = useIsCoarsePointer();
  return override ?? (isMobile || isCoarsePointer);
}

/** The pulsing dot for "a side question is being answered". The Side Bar's mode switch wears it too. */
export function AnsweringDot() {
  return <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />;
}

/** A follow-up box inside a topic: one line + a button. Clears itself when the ask is accepted, keeps the text when refused. */
function FollowUpForm({ value, onChange, onSubmit, placeholder, label, buttonLabel, touch }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
  placeholder: string;
  label: string;
  buttonLabel: string;
  touch: boolean;
}) {
  const submitting = useRef(false);
  const blank = value.trim() === "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || submitting.current) return;
    submitting.current = true;
    try {
      if (await onSubmit(text)) onChange("");
    } finally {
      submitting.current = false;
    }
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        enterKeyHint="send"
        className="ui-focus-ring"
        style={inputStyle(touch)}
      />
      <button
        type="submit"
        disabled={blank}
        className="ui-focus-ring"
        style={{
          ...buttonStyle(touch),
          color: "var(--accent)",
          opacity: blank ? 0.5 : 1,
          cursor: blank ? "not-allowed" : "pointer",
        }}
      >
        {buttonLabel}
      </button>
    </form>
  );
}

function BtwTurnView({ turn, cwd }: { turn: BtwTurn; cwd?: string }) {
  const { t } = useI18n();
  const running = turn.status === "running";
  return (
    <div className="flex flex-col gap-1.5" style={{ minWidth: 0 }}>
      <blockquote
        className="text-text-muted"
        style={{
          margin: 0,
          padding: "2px 0 2px 9px",
          borderLeft: "2px solid var(--border)",
          fontSize: 12.5,
          fontStyle: "italic",
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
        }}
      >
        <span className="sr-only">{t("btw.questionLabel")}: </span>
        {turn.question}
      </blockquote>
      {turn.answer.length > MAX_MARKDOWN_CHARS ? (
        <pre
          style={{
            margin: 0, padding: "6px 8px", maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap",
            overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)",
          }}
        >
          {turn.answer}
        </pre>
      ) : turn.answer ? (
        <div style={{ fontSize: 13, lineHeight: 1.55, minWidth: 0, overflowWrap: "anywhere" }}>
          <MarkdownBody isStreaming={running} cwd={cwd}>{turn.answer}</MarkdownBody>
        </div>
      ) : running ? (
        <p className="text-text-dim" style={{ margin: 0, fontSize: 12.5 }}>{t("btw.noAnswerYet")}</p>
      ) : null}
      {/* The card's footer already says Cancelled or Failed; a note only adds what it does not. */}
      {turn.status === "interrupted" && (
        <p className="text-text-dim" style={{ margin: 0, fontSize: 12 }}>{t("btw.interruptedNote")}</p>
      )}
      {turn.status === "error" && turn.error && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--status-error)", overflowWrap: "anywhere" }}>{turn.error}</p>
      )}
    </div>
  );
}

const BtwTopicCard = memo(function BtwTopicCard({ record, cwd, busy, touch, draft, onDraftChange, onFollowUp, onCancel }: {
  record: BtwRecord;
  cwd?: string;
  /** Another question is being asked or answered: no follow-up form. */
  busy: boolean;
  touch: boolean;
  draft: string;
  onDraftChange: (recordId: string, value: string) => void;
  onFollowUp: (recordId: string, text: string) => Promise<boolean>;
  onCancel: (recordId: string) => void;
}) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  const latest = latestBtwTurn(record);
  const running = isBtwRunning(record);
  const copyValue = useMemo(() => btwCopyText(record), [record]);
  const showFollowUp = !busy && canFollowUpBtw(record);
  const changeDraft = useCallback((value: string) => onDraftChange(record.id, value), [onDraftChange, record.id]);
  const submitFollowUp = useCallback((text: string) => onFollowUp(record.id, text), [onFollowUp, record.id]);

  return (
    <article
      className="flex flex-col gap-2"
      style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", padding: "8px 10px", minWidth: 0 }}
    >
      {btwTurns(record).map((turn, index) => (
        <BtwTurnView key={index} turn={turn} cwd={cwd} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 text-text-dim"
          style={{ fontSize: 11.5, marginRight: "auto", color: latest.status === "error" ? "var(--status-error)" : undefined }}
        >
          {running && <AnsweringDot />}
          {t(STATUS_KEYS[latest.status])}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => onCancel(record.id)}
            title={t("btw.cancelTitle")}
            className="ui-focus-ring"
            style={buttonStyle(touch)}
          >
            {t("btw.cancel")}
          </button>
        )}
        {copyValue !== undefined && (
          <button
            type="button"
            onClick={() => copy(copyValue)}
            title={t("btw.copyTitle")}
            className="ui-focus-ring"
            style={buttonStyle(touch)}
          >
            {copied ? t("btw.copied") : t("btw.copy")}
          </button>
        )}
      </div>
      {showFollowUp && (
        <FollowUpForm
          value={draft}
          onChange={changeDraft}
          onSubmit={submitFollowUp}
          placeholder={t("btw.followUpPlaceholder")}
          label={t("btw.followUpLabel")}
          buttonLabel={t("btw.followUp")}
          touch={touch}
        />
      )}
    </article>
  );
});

/**
 * The new-question box, built like the New chat composer beside it: a bordered
 * card with a growing text area and a round send button. Enter sends, Shift+Enter
 * adds a line. Side questions are text only, so there is no attach button.
 */
function SideQuestionComposer({ asking, busy, onAsk, visible, focusPending, onFocused, touch }: {
  asking: boolean;
  busy: boolean;
  onAsk: (question: string) => Promise<boolean>;
  visible: boolean;
  focusPending: boolean;
  onFocused: () => void;
  touch: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const canSend = draft.trim() !== "" && !busy;
  const sendSize = touch ? TOUCH_CONTROL_HEIGHT : MOUSE_CONTROL_HEIGHT;

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy || submitting.current) return;
    submitting.current = true;
    try {
      if (await onAsk(text)) setDraft("");
    } finally {
      submitting.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  // A bare `/btw` in the main composer asks for the cursor to land here. It
  // waits until this view is on screen: a hidden box cannot take focus.
  useEffect(() => {
    if (!focusPending || !visible) return;
    textareaRef.current?.focus();
    onFocused();
  }, [focusPending, visible, onFocused]);

  const sendLabel = asking ? t("btw.asking") : t("btw.ask");
  const sendStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: sendSize,
    height: sendSize,
    flexShrink: 0,
    padding: 0,
    border: 0,
    borderRadius: "var(--radius-control)",
    background: canSend ? "var(--accent)" : "var(--bg-hover)",
    color: canSend ? "var(--on-accent)" : "var(--text-dim)",
    cursor: canSend ? "pointer" : "not-allowed",
  };

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "8px 8px calc(8px + var(--safe-bottom))", background: "var(--bg)" }}>
      <div
        className="chat-input-shell"
        style={{
          display: "flex", alignItems: "flex-end", gap: 6,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: 6,
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          readOnly={asking}
          placeholder={t("btw.askPlaceholder")}
          aria-label={t("btw.askLabel")}
          enterKeyHint="send"
          autoComplete="off"
          className="composer-textarea"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          style={{ flex: 1, minWidth: 0, minHeight: 34, maxHeight: 160, padding: "7px 8px", resize: "none", border: 0, outline: "none", background: "transparent", color: "var(--text)", fontSize: "var(--chat-font-size)", lineHeight: 1.5, fieldSizing: "content" } as CSSProperties}
        />
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => void submit()}
          disabled={!canSend}
          title={busy && !asking ? t("btw.errorBusy") : sendLabel}
          aria-label={sendLabel}
          style={sendStyle}
        >
          <Send size={13} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export const SidebarSideQuestions = memo(function SidebarSideQuestions({
  records, answering, asking, error, onDismissError, onAsk, onCancel, cwd, visible, focusPending, onFocused, touch: touchOverride,
}: SidebarSideQuestionsProps) {
  const { t } = useI18n();
  const touch = useTouchSizing(touchOverride);
  const [showAll, setShowAll] = useState(false);
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = asking || answering;

  // Callbacks come from the hook and may change identity; the memoised topic
  // cards must not, or each streamed frame re-renders them all.
  const onAskRef = useRef(onAsk);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onAskRef.current = onAsk;
    onCancelRef.current = onCancel;
  });
  const askNewTopic = useCallback((text: string) => onAskRef.current(text), []);
  const askFollowUp = useCallback((recordId: string, text: string) => onAskRef.current(text, recordId), []);
  const cancelTopic = useCallback((recordId: string) => onCancelRef.current(recordId), []);
  const changeDraft = useCallback((recordId: string, value: string) => {
    setFollowUpDrafts((drafts) => {
      if (value === "") {
        if (!(recordId in drafts)) return drafts;
        const { [recordId]: _removed, ...rest } = drafts;
        return rest;
      }
      return drafts[recordId] === value ? drafts : { ...drafts, [recordId]: value };
    });
  }, []);

  // Newest first means the list is read from the top: a topic that appears
  // while an older one is scrolled into view must not stay out of sight.
  const newestId = records[0]?.id;
  const lastNewestId = useRef(newestId);
  useEffect(() => {
    if (lastNewestId.current === newestId) return;
    lastNewestId.current = newestId;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [newestId]);

  // An emptied list is another chat: fold the list again.
  const empty = records.length === 0;
  useEffect(() => {
    if (empty) setShowAll(false);
  }, [empty]);

  const shown = showAll ? records : records.slice(0, MAX_VISIBLE_TOPICS);
  const truncatable = records.length > MAX_VISIBLE_TOPICS;

  return (
    <section aria-label={t("btw.panelTitle")} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, background: "var(--bg)" }}>
      <div
        ref={scrollRef}
        className="chat-scroll-region"
        style={{
          flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "10px 10px 4px",
          display: "grid", gridTemplateColumns: "minmax(0, 1fr)", alignContent: "start", gap: 8,
        }}
      >
        {empty && (
          <p className="text-text-dim" style={{ margin: 0, padding: "40px 12px", textAlign: "center", fontSize: 12, lineHeight: 1.6 }}>
            {t("btw.panelHint")}
          </p>
        )}
        {shown.map((record) => (
          <BtwTopicCard
            key={record.id}
            record={record}
            cwd={cwd}
            busy={busy}
            touch={touch}
            draft={followUpDrafts[record.id] ?? ""}
            onDraftChange={changeDraft}
            onFollowUp={askFollowUp}
            onCancel={cancelTopic}
          />
        ))}
        {truncatable && (
          <button
            type="button"
            className="ui-focus-ring w-full cursor-pointer bg-transparent px-3 py-2 text-center text-xs text-accent hover:text-accent-hover"
            style={{ minHeight: touch ? TOUCH_CONTROL_HEIGHT : MOUSE_CONTROL_HEIGHT, border: 0 }}
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? t("btw.showFewer") : t("btw.showAll", { count: records.length })}
          </button>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2"
          style={{ padding: "6px 10px", borderTop: "1px solid var(--border)", fontSize: 12.5, color: "var(--status-error)" }}
        >
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{error}</span>
          <button type="button" onClick={onDismissError} className="ui-focus-ring" style={buttonStyle(touch)}>
            {t("btw.dismiss")}
          </button>
        </div>
      )}
      <SideQuestionComposer
        asking={asking}
        busy={busy}
        touch={touch}
        onAsk={askNewTopic}
        visible={visible}
        focusPending={focusPending}
        onFocused={onFocused}
      />
    </section>
  );
});
